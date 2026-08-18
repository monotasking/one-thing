import { getCurrentInstance, onUnmounted, type Ref } from "vue";

export type MessageScrollMode =
	| { type: "idle" }
	| { type: "tail" }
	| {
			type: "anchor";
			sessionId: string;
			messageId: string;
			offsetWithinMessage: number;
			until: number;
	  };

interface UseMessageScrollCoordinatorOptions {
	scroller: Ref<HTMLElement | null>;
	getSessionId: () => string | undefined;
	getMessageRowById: (messageId: string) => HTMLElement | null;
	onStateChange?: () => void;
}

const DRIFT_EPSILON_PX = 2;
const DEFAULT_ANCHOR_DURATION_MS = 2400;
const DEFAULT_SMOOTH_SCROLL_MS = 260;
const WIDTH_CHANGE_EPSILON_PX = 0.5;

export interface ReadingAnchor {
	messageId: string;
	offsetWithinMessage: number;
}

export interface ScrollerBox {
	width: number;
	height: number;
}

/**
 * 阅读锚只对**宽度**变化负责。
 *
 * 高度变化(消息增长、工具卡展开、composer 变高)已经有 tail / anchor /
 * hold-top 三条路在管;阅读锚再插一脚只会打架。宽度变化则是没人管的那一格:
 * 视口上方的每一条消息重新换行,可见内容被整体推走。
 *
 * 首次观测(previous 为 null)只记基线,不还原 —— 那不是"变化"。
 */
export function shouldRestoreReadingAnchor(
	previous: ScrollerBox | null,
	next: ScrollerBox,
): boolean {
	if (!previous) return false;
	return Math.abs(next.width - previous.width) > WIDTH_CHANGE_EPSILON_PX;
}

interface ScrollWriteOptions {
	behavior?: ScrollBehavior;
	durationMs?: number;
}

export function useMessageScrollCoordinator(
	options: UseMessageScrollCoordinatorOptions,
) {
	let mode: MessageScrollMode = { type: "idle" };
	let readingAnchor: (ReadingAnchor & { sessionId: string }) | null = null;
	let restoreFrame: number | null = null;
	let smoothFrame: number | null = null;
	let smoothToken = 0;
	let smoothTarget: number | null = null;

	function getMaxScrollTop(el: HTMLElement): number {
		return Math.max(0, el.scrollHeight - el.clientHeight);
	}

	// Self-write tracking — lets handleScroll distinguish coordinator-initiated
	// scrolls from user-initiated gestures that bypass wheel/pointerdown
	// (custom scrollbar thumb drag, PageUp/Home, scrollbar track click, etc.)
	let _lastSelfWriteTarget: number | null = null;
	const SELF_WRITE_WINDOW_MS = 150;
	const SELF_WRITE_EPSILON = 2;

	function prefersReducedMotion(): boolean {
		return (
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		);
	}

	function cancelSmoothScroll() {
		smoothToken++;
		smoothTarget = null;
		if (smoothFrame !== null) {
			cancelAnimationFrame(smoothFrame);
			smoothFrame = null;
		}
	}

	function applyScrollTop(target: number) {
		const scroller = options.scroller.value;
		if (!scroller) return;
		if (Math.abs(scroller.scrollTop - target) <= DRIFT_EPSILON_PX) return;
		_lastSelfWriteTarget = target;
		scroller.scrollTop = target;
		options.onStateChange?.();
	}

	function easeOutCubic(t: number): number {
		return 1 - Math.pow(1 - t, 3);
	}

	function animateScrollTop(
		target: number,
		durationMs = DEFAULT_SMOOTH_SCROLL_MS,
	) {
		const scroller = options.scroller.value;
		if (!scroller || prefersReducedMotion()) {
			applyScrollTop(target);
			return;
		}

		// Re-target in flight: same destination → keep the running animation;
		// new destination → continue from the last value WE wrote (not a DOM
		// read that may already be clamped by a pending layout), so the curve
		// never steps backwards.
		const inFlight = smoothFrame !== null;
		if (inFlight && smoothTarget !== null && Math.abs(smoothTarget - target) <= DRIFT_EPSILON_PX) return;
		const startTop = inFlight && _lastSelfWriteTarget !== null ? _lastSelfWriteTarget : scroller.scrollTop;
		cancelSmoothScroll();
		const token = smoothToken;
		const distance = target - startTop;
		if (Math.abs(distance) <= DRIFT_EPSILON_PX) return;
		smoothTarget = target;

		const startedAt = performance.now();
		const tick = (now: number) => {
			if (token !== smoothToken) return;
			// rAF timestamps are the frame's start and can precede `startedAt`
			// (we were called mid-frame): clamp at 0 or ease-out goes negative
			// and the first tick lands BEHIND the start.
			const progress = Math.min(1, Math.max(0, (now - startedAt) / Math.max(1, durationMs)));
			applyScrollTop(startTop + distance * easeOutCubic(progress));
			if (progress < 1) {
				smoothFrame = requestAnimationFrame(tick);
			} else {
				smoothFrame = null;
				smoothTarget = null;
				applyScrollTop(target);
			}
		};

		smoothFrame = requestAnimationFrame(tick);
	}

	function writeScrollTop(
		target: number,
		writeOptions: ScrollWriteOptions = {},
	) {
		if (writeOptions.behavior === "smooth") {
			animateScrollTop(target, writeOptions.durationMs);
			return;
		}
		cancelSmoothScroll();
		applyScrollTop(target);
	}

	function clear() {
		mode = { type: "idle" };
		cancelSmoothScroll();
		if (restoreFrame !== null) {
			cancelAnimationFrame(restoreFrame);
			restoreFrame = null;
		}
	}

	function isTail(): boolean {
		return mode.type === "tail";
	}

	function isAnchored(): boolean {
		if (mode.type !== "anchor") return false;
		if (
			mode.sessionId !== options.getSessionId() ||
			performance.now() > mode.until
		) {
			clear();
			return false;
		}
		return true;
	}

	/**
	 * 空闲态 = 没人在驱动滚动位置。tail / 未过期的 anchor 都算"有人管"。
	 * 读 anchor 走 isAnchored(),顺带把过期的 anchor 归零。
	 */
	function isIdle(): boolean {
		if (mode.type === "tail") return false;
		if (mode.type === "anchor") return !isAnchored();
		return true;
	}

	/**
	 * 记下"最上方可见消息 + 它顶到视口顶的偏移"。只在空闲态记 —— 其余模式下
	 * 位置由 tail / anchor 说了算,记了也只会在宽度变化时和它们抢方向盘。
	 */
	function captureReadingAnchor(anchor: ReadingAnchor | null) {
		if (!isIdle()) return;
		const sessionId = options.getSessionId();
		if (!sessionId || !anchor) {
			readingAnchor = null;
			return;
		}
		readingAnchor = { ...anchor, sessionId };
	}

	function getReadingAnchor(): ReadingAnchor | null {
		if (!readingAnchor) return null;
		if (readingAnchor.sessionId !== options.getSessionId()) {
			readingAnchor = null;
			return null;
		}
		return {
			messageId: readingAnchor.messageId,
			offsetWithinMessage: readingAnchor.offsetWithinMessage,
		};
	}

	function clearReadingAnchor() {
		readingAnchor = null;
	}

	/**
	 * 同步还原(给 ResizeObserver 回调用:layout 之后、paint 之前,一帧都不漏)。
	 * 返回是否真的写了 scrollTop。
	 */
	function restoreReadingAnchor(): boolean {
		if (!isIdle()) return false;
		const anchor = getReadingAnchor();
		if (!anchor) return false;
		const scroller = options.scroller.value;
		const row = options.getMessageRowById(anchor.messageId);
		if (!scroller || !row) return false;

		const target = Math.max(
			0,
			Math.min(
				getMaxScrollTop(scroller),
				row.offsetTop + anchor.offsetWithinMessage,
			),
		);
		if (Math.abs(scroller.scrollTop - target) <= DRIFT_EPSILON_PX) return false;
		cancelSmoothScroll();
		applyScrollTop(target);
		return true;
	}

	function restoreAnchorNow(writeOptions: ScrollWriteOptions = {}) {
		if (!isAnchored() || mode.type !== "anchor") return;
		const scroller = options.scroller.value;
		const row = options.getMessageRowById(mode.messageId);
		if (!scroller || !row) return;

		const target = row.offsetTop + mode.offsetWithinMessage;
		const drift = target - scroller.scrollTop;
		if (Math.abs(drift) <= DRIFT_EPSILON_PX) {
			options.onStateChange?.();
			return;
		}

		// A layout change while a smooth restore is still animating (the
		// composer collapsing after send, the assistant placeholder landing)
		// re-targets the animation from wherever it is instead of cancelling
		// it with an instant write — that instant write was the "smooth then
		// snap" double scroll the old send path had to avoid by never being
		// smooth at all.
		if (smoothFrame !== null && writeOptions.behavior !== "smooth") {
			animateScrollTop(target, writeOptions.durationMs);
			return;
		}

		writeScrollTop(target, writeOptions);
	}

	function scheduleRestoreAnchor() {
		if (!isAnchored()) return;
		if (restoreFrame !== null) return;
		restoreFrame = requestAnimationFrame(() => {
			restoreFrame = null;
			restoreAnchorNow();
		});
	}

	function pinTail() {
		const scroller = options.scroller.value;
		if (!scroller) return;
		writeScrollTop(getMaxScrollTop(scroller));
	}

	function setTail(writeOptions: ScrollWriteOptions = {}) {
		mode = { type: "tail" };
		const scroller = options.scroller.value;
		if (!scroller) return;
		writeScrollTop(getMaxScrollTop(scroller), writeOptions);
		requestAnimationFrame(() => {
			if (mode.type === "tail") pinTail();
		});
	}

	function setAnchor(
		messageId: string,
		offsetWithinMessage: number,
		durationMs = DEFAULT_ANCHOR_DURATION_MS,
		writeOptions: ScrollWriteOptions = {},
	) {
		const sessionId = options.getSessionId();
		if (!sessionId) return;
		mode = {
			type: "anchor",
			sessionId,
			messageId,
			offsetWithinMessage,
			until: performance.now() + durationMs,
		};
		restoreAnchorNow(writeOptions);
		requestAnimationFrame(() => {
			restoreAnchorNow();
			requestAnimationFrame(() => restoreAnchorNow());
		});
	}

	function onLayoutChange() {
		if (mode.type === "tail") {
			pinTail();
			return;
		}
		if (mode.type === "anchor") {
			scheduleRestoreAnchor();
		}
	}

	// Detect user-initiated scrolls that did NOT originate from coordinator
	// writes (e.g. custom scrollbar thumb drag, PageUp/Home, keyboard scroll).
	// When the user scrolls away from the bottom via one of these paths,
	// clear tail/anchor so ResizeObserver-driven pinTail/restoreAnchor don't
	// fight the user.
	function detectExternalScroll(el: HTMLElement) {
		if (_lastSelfWriteTarget === null) return;
		const scrollTop = el.scrollTop;
		if (Math.abs(scrollTop - _lastSelfWriteTarget) <= SELF_WRITE_EPSILON)
			return;

		const distanceToBottom = getMaxScrollTop(el) - scrollTop;
		// Only clear if the user is clearly NOT at the bottom (they scrolled away)
		if (
			distanceToBottom > 36 &&
			(mode.type === "tail" || mode.type === "anchor")
		) {
			clear();
		}
	}

	if (getCurrentInstance()) {
		onUnmounted(clear);
	}

	return {
		captureReadingAnchor,
		clear,
		clearReadingAnchor,
		detectExternalScroll,
		getReadingAnchor,
		isAnchored,
		isIdle,
		isTail,
		onLayoutChange,
		restoreReadingAnchor,
		/** Synchronous anchor restore for post-layout callers (ResizeObserver). */
		restoreAnchorNow: () => restoreAnchorNow(),
		setAnchor,
		setTail,
		writeScrollTop,
	};
}
