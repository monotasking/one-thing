import { defineStore } from "pinia";
import { ref, computed, triggerRef } from "vue";
import type {
	SessionDetails,
	ContextVariable,
	PermissionMode,
	SessionGoal,
} from "@/types";
import { platformApi } from "@/platform";
import { collabApi } from "@/platform/collab-client";
import { variablesApi } from "@/platform/variables-client";
import { appStateApi } from "@/platform/app-state-client";
import { getLogger } from "@/services/log";
import { DEFAULT_AGENT_ID, isColleague } from "@shared/ipc";
import { isAgentPairDmRoom, isUserDmRoom } from "@onething/runtime/collab";
// 叶子入口,不是 `@onething/runtime/agents` barrel:那颗 barrel 拖着吃 node:fs
// 的 store.ts,走它会把文件系统拽进浏览器包(alias 漏登记只在 build/run 期炸)。
import {
	computeAgentPresence,
	type AgentPresence,
} from "@onething/runtime/agents/presence";
import { useAgentsStore } from "./agents";
import { useChatStore } from "./chat";
import { useScratchpadStore } from "./scratchpad";
import { useWorkspaceStore } from "./workspace";
import { currentSpaceId } from "./spaces";
import {
	createReadMark,
	isMarkUnread,
	parsePersistedReadMarks,
	serializeReadMarks,
	type PersistedSessionReadMarks,
	type SessionReadMark,
} from "./session-read-marks";

// Base session type for list display - can be metadata-only initially, then
// hydrated with full activation details such as token/context fields.
// This allows mixed loading: metadata on startup, full session after switching
type SessionListItem = SessionDetails;
// draftKind (not `kind`): SessionDetails.kind is the durable collab session
// kind ('chat'|'room'|'work'); the draft discriminant is renderer-local.
type NewChatDraft = SessionDetails & { readonly draftKind: "new-chat-draft" };
type VisibleSessionListItem = SessionListItem | NewChatDraft;

const SWITCH_INITIAL_MESSAGE_LIMIT = 6;
const SWITCH_TARGET_MESSAGE_LIMIT = 16;
// 水位落盘节流。窗口是 UI 状态(app-state.json)那一层的写,与工作区分栏树同款。
const READ_MARKS_PERSIST_DEBOUNCE_MS = 400;

let switchGeneration = 0;
const sessionNameAnimationTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();
const sessionNameAnimationTokens = new Map<string, number>();

function caughtErrorMessage(error: object | undefined, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	if (error && "message" in error && typeof error.message === "string" && error.message) {
		return error.message;
	}
	return fallback;
}

const log = getLogger("renderer.sessions-store");
const perfLog = getLogger("renderer.perf");

export const useSessionsStore = defineStore("sessions", () => {
	// Sessions list stores metadata-only items initially
	// Full session data is loaded on-demand when switching sessions
	const sessions = ref<SessionListItem[]>([]);
	const newChatDrafts = ref<NewChatDraft[]>([]);
	const currentSessionId = ref<string>("");
	const isLoading = ref(false);
	// Track if current session is "active" (messages loaded in memory)
	const isActive = ref(false);

	/**
	 * Per-session full variable snapshot (system + custom). The map is the
	 * single source of truth for the inspector. Hydrated on session
	 * switch via `fetchVariables()`, then live-updated by ipc-hub when
	 * `session:variables-updated` arrives.
	 */
	const sessionVariables = ref<Map<string, ContextVariable[]>>(new Map());

	/**
	 * Per-session goal (null = fetched, none set). Hydrated by the goal
	 * status bar on session switch via `fetchGoal()`, then live-updated by
	 * ipc-hub when `session:goal-updated` arrives.
	 */
	const sessionGoals = ref<Map<string, SessionGoal | null>>(new Map());

	/**
	 * Full goal history per session, oldest first. Pushed down by the main
	 * process with every goal update — the "which one is current" rule stays
	 * on that side, so this is a plain mirror rather than a second opinion.
	 */
	const sessionGoalHistory = ref<Map<string, SessionGoal[]>>(new Map());

	const currentSession = computed<VisibleSessionListItem | undefined>(() => {
		return (
			newChatDrafts.value.find(
				(draft) => draft.id === currentSessionId.value,
			) || sessions.value.find((s) => s.id === currentSessionId.value)
		);
	});

	const sessionCount = computed(() => sessions.value.length);

	/**
	 * A service agent's sessions (agent-domain-model.md M2) belong to their host
	 * feature surface — radio-dj's live in the Music panel — never the public
	 * session list. Judged by `kind`, with the historical id hardcode kept as a
	 * fallback: agents.json written before A0 has no `kind` field, and this
	 * filter can run before the agents store has loaded at all — in both
	 * windows the kind lookup misses, and without the id floor radio-dj
	 * sessions would flash into (or silently join) the sidebar.
	 */
	const agentsStore = useAgentsStore();
	function isServiceAgentSession(agentId: string | undefined | null): boolean {
		if (!agentId) return false;
		if (agentId === "radio-dj") return true;
		// Deliberately NOT agentsStore.getAgent: that falls back to the default
		// agent for unknown ids, which would misclassify by the default's kind.
		const agent = agentsStore.agents.find((a) => a.id === agentId);
		return !!agent && !isColleague(agent);
	}

	// Filter sessions (excluding archived and service agents' working sessions —
	// those live in their feature panel (Music for radio-dj), not the public
	// list), sorted by pinned first
	const filteredSessions = computed((): SessionListItem[] => {
		const filtered = sessions.value.filter(
			(s) =>
				!s.isArchived &&
				!isServiceAgentSession(s.agentId) &&
				// Collab sessions live outside the main list: rooms in the 群聊
				// section, work sessions only via their task cards (P1), and an
				// agent's execution session (W18) not at all — it is the agent's
				// own workspace, surfaced later by an agent page.
				s.kind !== "room" &&
				s.kind !== "work" &&
				s.kind !== "agent",
		);

		// Only group by pinned, keep array order (new sessions are unshifted to top)
		const pinned = filtered.filter((s) => s.isPinned);
		const unpinned = filtered.filter((s) => !s.isPinned);
		return [...pinned, ...unpinned];
	});

	// Multi-agent group-chat rooms (docs/design/multi-agent-collab.md).
	// EVERY live room, private chats included — this is the "which rooms exist"
	// list (board picker, room lookups), not the 群聊 section.
	const roomSessions = computed(() =>
		sessions.value.filter((s) => s.kind === "room" && !s.isArchived),
	);

	/**
	 * 托管私聊房(agent-im-dm.md D1)= 带 dm 标记的单成员房。
	 *
	 * 它是一个**正常会话** —— 能打开、能搜索、能进页签,只是侧栏入口在「联系人」
	 * 区而不是群聊区。所以这里拆的是"哪一份列表",不是"这间房算不算数"。
	 *
	 * 判定单一收口:形态由 `isUserDmRoom`(产品层纯规则,人数即形态)回答,消费方
	 * 一律读下面两个 selector,谁都别自己写 `room.dm && members.length === 1` ——
	 * 下一次形态变化(双成员 dm、三人 dm)就会漏改一处。
	 */
	const userDmRoomSessions = computed(() =>
		roomSessions.value.filter((s) => isUserDmRoom(s.room)),
	);

	/**
	 * agent ↔ agent 私聊房(agent-im-dm.md D3)= 带 dm 标记的双成员房。
	 *
	 * 侧栏「群聊」区里的折叠子分组「私下」吃这一路(§4.1)。与上面那条同源同纪律:
	 * 形态由产品层的 `isAgentPairDmRoom` 回答,消费方一律读 selector。
	 */
	const agentPairDmRoomSessions = computed(() =>
		roomSessions.value.filter((s) => isAgentPairDmRoom(s.room)),
	);

	/**
	 * 侧栏「群聊」区吃的那一路:普通群。
	 *
	 * 两种 dm 房都摘出去 —— 单成员房的入口是联系人行,双成员房的入口是「私下」
	 * 分组。一间房只能有一个侧栏入口,否则它会在同一列里出现两次。
	 */
	const groupRoomSessions = computed(() =>
		roomSessions.value.filter(
			(s) => !isUserDmRoom(s.room) && !isAgentPairDmRoom(s.room),
		),
	);

	function isUserDmRoomSession(sessionId?: string | null): boolean {
		if (!sessionId) return false;
		return isUserDmRoom(
			sessions.value.find((s) => s.id === sessionId)?.room,
		);
	}

	/** 这个 agent 的私聊房(还没聊过就没有)—— 联系人行拿它点亮 active 态。 */
	function findUserDmRoom(
		agentId?: string | null,
	): SessionListItem | undefined {
		if (!agentId) return undefined;
		return userDmRoomSessions.value.find(
			(s) => s.room?.memberAgentIds?.[0] === agentId,
		);
	}

	// Agent execution sessions (W18). 侧栏「Agent 组」已退役(agent-im-dm.md
	// §4.1),它们唯一的入口现在是履历页「群聊」栏(经 `agentPresence`)。这条
	// selector 留着回答"哪些是执行会话"本身:`filteredSessions` 与
	// `archivedSessions` 都在把它们丢掉,所以它们永不落进 今天/昨天 时间组或
	// 归档区 —— 这两句互为反面,谁改了都得对着另一句改。
	const agentSessions = computed(() =>
		sessions.value.filter((s) => s.kind === "agent"),
	);

	/**
	 * 履历页(agent-im-dm.md §4.2 / D8)的归类口径 —— **单点**。
	 *
	 * 在场三路(dm 房 / 房间 / 执行会话 / 工作台)一律由产品层纯函数
	 * `computeAgentPresence` 回答(agent-domain-model.md §5):同一份实现 app 层的
	 * `listAgentPresence` 也在吃,两处口径靠"共用这一份"收敛,而不是各写一遍。
	 * 组件里禁止再写第二份 `kind==='agent' && agentId===…` 之类的过滤。
	 *
	 * 吃的是**全量** `sessions`(不是 filteredSessions):履历要看得见 archived
	 * 的执行会话 —— 执行会话本来就骑着 archived 标志躲开所有列表,再滤一次
	 * 就等于把 agent 的工作史整段抹掉。
	 */
	function agentPresence(agentId?: string | null): AgentPresence {
		return computeAgentPresence(agentId, sessions.value);
	}

	/**
	 * 直聊会话(`kind='chat'` 且 persona 绑到该 agent)—— 履历第一栏的另一半。
	 *
	 * presence 按定义不认它(它不是在场面的四路之一,注释见 presence.ts 的
	 * `isEmptyAgentPresence`),所以这一路在这里补齐,同样只此一处。
	 * 缺 `kind` 的老会话就是普通 chat,一并收下。
	 */
	function agentDirectChatSessions(agentId?: string | null): SessionListItem[] {
		if (!agentId) return [];
		return sessions.value
			.filter((s) => s.agentId === agentId && (!s.kind || s.kind === "chat"))
			.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	// The radio DJ's curation sessions, newest first — the Music panel's list.
	// Same service-kind judgment (plus the radio-dj id floor) as the sidebar
	// exclusion above: what one filter hides, this one shows — the two must
	// never disagree on membership. Today radio-dj is the only service agent,
	// so "service sessions" and "radio sessions" coincide.
	const radioSessions = computed(() => {
		return sessions.value
			.filter((s) => isServiceAgentSession(s.agentId))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	});

	const sidebarSessions = computed((): VisibleSessionListItem[] => {
		return [...newChatDrafts.value, ...filteredSessions.value];
	});

	// Get all archived sessions
	const archivedSessions = computed(() => {
		return sessions.value
			// Agent execution sessions ride the archived flag to stay out of every
			// list (scheduler precedent) — the archive is not where they belong
			// either: nobody archived them, and nobody restores them.
			.filter((s) => s.isArchived && s.kind !== "agent")
			.sort(
				(a, b) => (b.archivedAt || b.updatedAt) - (a.archivedAt || a.updatedAt),
			);
	});

	const filteredSessionCount = computed(() => filteredSessions.value.length);

	function findSessionItem(sessionId: string): VisibleSessionListItem | undefined {
		return (
			sessions.value.find((s) => s.id === sessionId) ||
			newChatDrafts.value.find((draft) => draft.id === sessionId)
		);
	}

	function getSessionItem(sessionId?: string | null): VisibleSessionListItem | undefined {
		return sessionId ? findSessionItem(sessionId) : undefined;
	}

	// ── 已读水位与未读判定(agent-im-dm.md P4 / D9)────────────────────────
	//
	// 全系统**唯一**一处未读判定。侧栏联系人行、群聊行、「私下」行与折叠组头一律
	// 读 `isUnreadSession`,谁都别自己拿时间戳去比 —— 下一次口径变化(比如把系统
	// 行也算进来)就会漏改一处,而未读徽标误报一次就再没人信它。
	//
	// 三条不误报的纪律,全部落在这一段里:
	// 1. 没有水位条目 = 已读。存量会话首次启用时一条都没有,所以不会全量爆红点,
	//    水位从此刻起算。
	// 2. 自己说话推进水位(`markSessionRead`)—— 刚说完的会话不该被自己标未读。
	// 3. 只认落库消息(message:* 事件),不追流式 chunk,所以生成过程中不闪烁。

	const readMarks = ref<Map<string, SessionReadMark>>(new Map());
	/**
	 * 窗口是否在前台。默认 true(测试与非 Electron 宿主里没人喂这个信号时,行为
	 * 退化成"看得见就算读过",而不是把所有可见会话都标成未读)。
	 */
	const windowFocused = ref(true);
	let readMarksHydrated = false;
	let readMarksPersistTimer: ReturnType<typeof setTimeout> | null = null;

	function isKnownSessionId(sessionId: string): boolean {
		return sessions.value.some((s) => s.id === sessionId);
	}

	function persistReadMarks(): void {
		// 水位在 hydrate 之前是空的;这时候写回去等于把上次的阅读状态抹平。
		if (!readMarksHydrated) return;
		if (readMarksPersistTimer) clearTimeout(readMarksPersistTimer);
		readMarksPersistTimer = setTimeout(() => {
			readMarksPersistTimer = null;
			appStateApi
				.saveUiState({
					sessionReadMarks: serializeReadMarks(
						readMarks.value,
						isKnownSessionId,
					),
				})
				.catch(() => {});
		}, READ_MARKS_PERSIST_DEBOUNCE_MS);
	}

	function readMarkOf(sessionId: string): SessionReadMark {
		let mark = readMarks.value.get(sessionId);
		if (!mark) {
			mark = createReadMark();
			readMarks.value.set(sessionId, mark);
		}
		return mark;
	}

	/** 会话此刻正被人看着:分栏的当前页签 + 窗口在前台。 */
	function isSessionOnScreen(sessionId: string): boolean {
		if (!windowFocused.value) return false;
		return useWorkspaceStore().visibleSessionIds.has(sessionId);
	}

	/**
	 * 启动时从 app-state 恢复水位。恢复完顺手把当前可见的会话标成已读 —— 恢复的
	 * 那个页签用户正看着,它不该带着上次的红点回来。
	 */
	function hydrateReadMarks(
		persisted: PersistedSessionReadMarks | null | undefined,
	): void {
		if (readMarksHydrated) return;
		readMarks.value = parsePersistedReadMarks(persisted, isKnownSessionId);
		readMarksHydrated = true;
		triggerRef(readMarks);
		markVisibleSessionsRead();
	}

	/**
	 * 有人跟你说话了(对方消息落库)。唯一的 inbound 写入口。
	 *
	 * 时间只进不退:重放、乱序、同一条消息被两条事件带过来,都不该把水位往回拖。
	 */
	function noteInboundActivity(sessionId: string, at: number): void {
		if (!sessionId || !Number.isFinite(at) || at <= 0) return;
		const mark = readMarkOf(sessionId);
		if (at <= mark.inboundAt) return;
		mark.inboundAt = at;
		// 正看着的会话:消息一到就算读过,用户切走之后也不会再冒出来。
		if (isSessionOnScreen(sessionId) && at > mark.readAt) mark.readAt = at;
		triggerRef(readMarks);
		persistReadMarks();
	}

	/** 看见了:打开/切到该页签/窗口回到前台/自己刚说完话。 */
	function markSessionRead(sessionId: string, at = Date.now()): void {
		if (!sessionId || !Number.isFinite(at) || at <= 0) return;
		const existing = readMarks.value.get(sessionId);
		// 从没有过任何动静的会话不必开条目 —— 没条目本来就等于已读。
		if (!existing && !isKnownSessionId(sessionId)) return;
		const mark = readMarkOf(sessionId);
		if (at <= mark.readAt) return;
		mark.readAt = at;
		triggerRef(readMarks);
		persistReadMarks();
	}

	/** 屏幕上的都算读到了。切页签、窗口回前台、启动恢复共用这一条。 */
	function markVisibleSessionsRead(at = Date.now()): void {
		if (!windowFocused.value) return;
		for (const sessionId of useWorkspaceStore().visibleSessionIds) {
			markSessionRead(sessionId, at);
		}
	}

	/** 窗口前后台切换。回到前台 = 又看见了屏幕上那些会话。 */
	function setWindowFocused(focused: boolean): void {
		if (windowFocused.value === focused) return;
		windowFocused.value = focused;
		if (focused) markVisibleSessionsRead();
	}

	/** 未读判定的唯一出口。 */
	function isUnreadSession(sessionId?: string | null): boolean {
		if (!sessionId) return false;
		return isMarkUnread(readMarks.value.get(sessionId));
	}

	/** 未读会话 id 集合 —— 需要"这一组里有没有未读"的聚合位点读它。 */
	const unreadSessionIds = computed(() => {
		const ids = new Set<string>();
		for (const [sessionId, mark] of readMarks.value) {
			if (isMarkUnread(mark)) ids.add(sessionId);
		}
		return ids;
	});

	function nextSessionNameAnimationToken(sessionId: string): number {
		const token = (sessionNameAnimationTokens.get(sessionId) ?? 0) + 1;
		sessionNameAnimationTokens.set(sessionId, token);
		const timer = sessionNameAnimationTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			sessionNameAnimationTimers.delete(sessionId);
		}
		return token;
	}

	function cancelSessionNameAnimation(sessionId: string): void {
		const timer = sessionNameAnimationTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			sessionNameAnimationTimers.delete(sessionId);
		}
		sessionNameAnimationTokens.delete(sessionId);
	}

	function setSessionName(sessionId: string, name: string): void {
		const session = findSessionItem(sessionId);
		if (!session) return;
		session.name = name;
	}

	function updateSessionNameAnimated(sessionId: string, nextName: string): void {
		const targetName = nextName.trim();
		if (!targetName) return;

		const session = findSessionItem(sessionId);
		if (!session) return;
		if (session.name === targetName) return;

		const token = nextSessionNameAnimationToken(sessionId);
		const chars = Array.from(targetName);
		let index = 0;

		const step = () => {
			if (sessionNameAnimationTokens.get(sessionId) !== token) return;
			const currentSession = findSessionItem(sessionId);
			if (!currentSession) return;

			index += 1;
			currentSession.name = chars.slice(0, index).join("");
			if (index < chars.length) {
				const delay = chars.length > 24 ? 24 : 32;
				sessionNameAnimationTimers.set(sessionId, setTimeout(step, delay));
				return;
			}

			currentSession.name = targetName;
			sessionNameAnimationTimers.delete(sessionId);
			sessionNameAnimationTokens.delete(sessionId);
		};

		step();
	}

	/**
	 * Load sessions list (metadata only, no messages)
	 * This is optimized for fast startup - messages are loaded on-demand
	 */
	async function loadSessions() {
		isLoading.value = true;
		try {
			// Use optimized API that returns only metadata (no messages)
			const response = await platformApi.getSessionsList();
			if (response.success) {
				sessions.value = response.sessions || [];
				// Don't auto-create new chat on app open - let user choose
				hydrateRoomCoordinators();
			}
		} finally {
			isLoading.value = false;
		}
	}

	/**
	 * 房间的「谁在说 / 谁在打字」冷启动补水(架构收敛 C4 §1)。
	 *
	 * 这件事必须在**知道哪些会话是房间**的地方做,而那只有这里 —— collabBoard
	 * store 拿到的永远是一个个孤立的 id。停止按钮从前读的是 `collab:turn-active`
	 * 的事件账,而事件不会为一个已经开着的窗口重放:窗口在一轮发言中途重载,
	 * 按钮就整轮消失。补一次 GET 就没有这回事了。
	 *
	 * 每间房一次(collabBoard 自己去重),不阻塞列表加载,失败静默 —— 拿不到
	 * 快照只是回到"等下一次广播",不是一个要打断用户的错误。
	 */
	function hydrateRoomCoordinators(): void {
		const roomIds = sessions.value
			.filter((session) => session.kind === "room")
			.map((session) => session.id);
		if (roomIds.length === 0) return;
		void import("./collabBoard")
			.then(({ useCollabBoardStore }) => {
				const boardStore = useCollabBoardStore();
				for (const id of roomIds) boardStore.ensureCoordinator(id);
			})
			.catch(() => {
				/* 没挂 pinia / web 端没有 rooms:补水不是关键路径 */
			});
	}

	function isNewChatDraftId(sessionId?: string | null): boolean {
		return Boolean(
			sessionId && newChatDrafts.value.some((draft) => draft.id === sessionId),
		);
	}

	/**
	 * A draft's id IS its future session id (a plain v4 UUID): when the first
	 * message materializes the draft, the main process persists the session
	 * under this exact id, so nothing downstream (tabs, composer drafts,
	 * snapshots) ever has to migrate to a renamed id. "Draft-ness" is pure
	 * state — membership in `newChatDrafts` — not an id format.
	 */
	function createNewChatDraftId(): string {
		const uuid = globalThis.crypto?.randomUUID?.();
		if (uuid) return uuid;
		// Manual v4 fallback: the main process only accepts this exact format.
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	}

	/**
	 * The only sanctioned way to blank the current session (empty workspace /
	 * everything closed). All other currentSessionId writes live in
	 * switchSession.
	 */
	function clearCurrentSession() {
		currentSessionId.value = "";
		isActive.value = false;
	}

	function discardNewChatDraft(sessionId = currentSessionId.value) {
		if (!isNewChatDraftId(sessionId)) return;
		const chatStore = useChatStore();
		chatStore.clearSessionMessages(sessionId);
		chatStore.deleteSnapshot(sessionId);
		chatStore.clearComposerDraft(sessionId);
		// 草稿纸是**文件**,草稿会话被丢弃时它不会自己消失。
		void useScratchpadStore().remove(sessionId);
		newChatDrafts.value = newChatDrafts.value.filter(
			(draft) => draft.id !== sessionId,
		);
		const workspace = useWorkspaceStore();
		workspace.closeSession(sessionId);
		// A surviving tab (workspace promoted a neighbor) drives the follow-up
		// switch via the workspace effect; only blank out when nothing is left.
		if (currentSessionId.value === sessionId && !workspace.activeSessionId) {
			clearCurrentSession();
		}
	}

	/**
	 * `options.workingDirectory` —— 左栏「在这个项目里新建会话」那条路:草稿从
	 * 出生就带着目录,于是它**直接落在那个项目组里**,而不是先掉进未归类再跳走。
	 * 目录随草稿一路走到落盘(materialize → applyDraftSettingsToSession)。
	 */
	function openNewChatDraft(
		name = "New Chat",
		options?: { workingDirectory?: string; workspaceId?: string },
	) {
		const chatStore = useChatStore();
		const workingDirectory = options?.workingDirectory?.trim() || undefined;
		// 草稿从出生就归属当前空间 —— 否则它会掉进 default,在别的空间里凭空
		// 出现一行。调用方没指定就取 window 级的当前空间。
		const workspaceId = options?.workspaceId || currentSpaceId();
		const currentDraft = newChatDrafts.value.find(
			(draft) => draft.id === currentSessionId.value,
		);
		if (currentDraft && chatStore.isComposerDraftEmpty(currentDraft.id)) {
			// 复用那条空草稿时也要改嫁目录:用户点的是「在项目 A 里新建」,
			// 留着旧目录会让这一行停在别的组里,看起来像什么都没发生。
			if (workingDirectory) currentDraft.workingDirectory = workingDirectory;
			currentDraft.workspaceId = workspaceId;
			currentDraft.updatedAt = Date.now();
			newChatDrafts.value = [
				currentDraft,
				...newChatDrafts.value.filter((draft) => draft.id !== currentDraft.id),
			];
			useWorkspaceStore().openSession(currentDraft.id);
			return currentDraft;
		}

		const now = Date.now();
		const draft: NewChatDraft = {
			draftKind: "new-chat-draft",
			id: createNewChatDraftId(),
			name: name || "New Chat",
			createdAt: now,
			updatedAt: now,
			agentId: DEFAULT_AGENT_ID,
			messageCount: 0,
			workspaceId,
			...(workingDirectory ? { workingDirectory } : {}),
		};
		newChatDrafts.value = [draft, ...newChatDrafts.value];
		chatStore.clearSessionMessages(draft.id);
		chatStore.deleteSnapshot(draft.id);
		chatStore.clearComposerDraft(draft.id);
		// Draft activation is synchronous inside switchSession (no data to
		// load), which also aligns the workspace tab.
		void switchSession(draft.id);
		return draft;
	}

	async function materializeNewChatDraft(
		sessionId = currentSessionId.value,
		name = "New Chat",
	) {
		const draft = newChatDrafts.value.find((item) => item.id === sessionId);
		if (!draft) return currentSession.value;
		const draftName = draft.name || name || "New Chat";
		newChatDrafts.value = newChatDrafts.value.filter(
			(item) => item.id !== sessionId,
		);
		const chatStore = useChatStore();
		chatStore.clearSessionMessages(sessionId);
		chatStore.deleteSnapshot(sessionId);
		// The session persists under the draft's own id, so the existing tab,
		// composer draft, and snapshots keep pointing at the right session
		// with no rename step.
		// 归属随草稿落盘 —— 空间是**创建时**定死的,不走后续 patch(后端没有
		// 「当前空间」的概念,补写等于再开一条链路)。
		const created = await createSessionWithoutSwitch(draftName, draft.id, {
			workspaceId: draft.workspaceId,
		});
		chatStore.clearComposerDraft(sessionId);
		if (!created) {
			newChatDrafts.value = [draft, ...newChatDrafts.value];
			void switchSession(draft.id);
			return created;
		}

		// 会话在**草稿自己的 id**下落盘,所以纸通常原地就对。只有后端换了 id
		// 才要搬家 —— 这一条守的是"万一",不是常态。
		if (created.id !== sessionId) {
			await useScratchpadStore().adopt(sessionId, created.id);
		}

		// currentSessionId already equals the draft/session id, so
		// switchSession would early-return — activate explicitly so the main
		// process's current-session pointer (todo window etc.) follows.
		await platformApi.activateSession(created.id).catch(() => {});
		await switchSession(created.id);
		await applyDraftSettingsToSession(created.id, draft);
		return created;
	}

	async function applyDraftSettingsToSession(
		sessionId: string,
		draft: NewChatDraft,
	): Promise<void> {
		if (draft.agentId && draft.agentId !== DEFAULT_AGENT_ID) {
			await updateSessionAgent(sessionId, draft.agentId);
		}
		if (draft.permissionMode) {
			await updateSessionPermissionMode(sessionId, draft.permissionMode);
		}
		if (draft.lastProvider && draft.lastModel) {
			await updateSessionModel(sessionId, draft.lastProvider, draft.lastModel);
		}
		if (draft.workingDirectory !== undefined) {
			await updateSessionWorkingDirectory(
				sessionId,
				draft.workingDirectory || null,
			);
		}
	}

	async function createSession(name: string) {
		try {
			const response = await platformApi.createSession(name || "New Chat", {
				workspaceId: currentSpaceId(),
			});
			if (response.success && response.session) {
				sessions.value.unshift(response.session);
				await switchSession(response.session.id);
				return response.session;
			}
		} catch (error) {
			log.error("session create failed", {}, error);
		}
	}

	/**
	 * Create a new session without switching to it. Used by split view and by
	 * draft materialization, which passes the draft's own id so the session
	 * persists under the identity the renderer has been using all along.
	 */
	async function createSessionWithoutSwitch(
		name: string,
		sessionId?: string,
		options?: { workspaceId?: string },
	) {
		try {
			const response = await platformApi.createSession(name, {
				...(sessionId ? { sessionId } : {}),
				workspaceId: options?.workspaceId || currentSpaceId(),
			});
			if (response.success && response.session) {
				sessions.value.unshift(response.session);
				return response.session;
			}
			if (response.error) {
				log.error("session create failed", { sessionId, error: response.error });
			}
		} catch (error) {
			log.error("session create failed", { sessionId }, error);
		}
	}

	/**
	 * Switch to a session using optimized two-step loading:
	 * 1. Activate session (get details, no messages) - fast
	 * 2. Load messages on-demand
	 */
	async function switchSession(sessionId: string) {
		if (currentSessionId.value === sessionId) return currentSession.value;
		// Align the workspace before anything else: whoever asked for this
		// session gets a tab for it in the focused panel. Idempotent — when the
		// switch was itself triggered by the workspace effect, the tab already
		// exists and is active. Skipped before hydration so the startup restore
		// isn't clobbered by an early switch.
		const workspace = useWorkspaceStore();
		if (workspace.hydrated) workspace.openSession(sessionId);
		// 打开就是看见(P4 水位):此刻分栏树已经指向新会话,所以"屏幕上有哪些"
		// 这一问已经是新答案。
		markVisibleSessionsRead();
		if (isNewChatDraftId(sessionId)) {
			currentSessionId.value = sessionId;
			isActive.value = true;
			return newChatDrafts.value.find((draft) => draft.id === sessionId);
		}
		const generation = ++switchGeneration;
		const previousSessionId = currentSessionId.value;
		const switchStart = performance.now();
		let activateMs = 0;
		let pageMs = 0;
		let commitMs = 0;
		let visibleSwitchMs = 0;
		let reusedCachedMessages = false;
		try {
			const chatStore = useChatStore();
			const existingMessages = chatStore.sessionMessages.get(sessionId);
			const targetSnapshot = chatStore.getSnapshot(sessionId);
			const anchorMessageId =
				targetSnapshot?.mode === "anchor"
					? targetSnapshot.anchorMessageId
					: undefined;
			const existingHasAnchor = Boolean(
				anchorMessageId &&
					existingMessages?.some((message) => message.id === anchorMessageId),
			);

			// Optimistic visible switch: make sidebar/header respond in the same
			// event turn as the click. Backend activation and message paging fill in
			// details afterward.
			const commitStart = performance.now();
			currentSessionId.value = sessionId;
			isActive.value = true;
			if (!existingMessages || existingMessages.length === 0) {
				chatStore.setSessionLoading(sessionId, true);
			}
			commitMs = performance.now() - commitStart;
			visibleSwitchMs = performance.now() - switchStart;

			// Step 1: Activate session (returns details without messages)
			const activateStart = performance.now();
			const activateResponse =
				await platformApi.activateSession(sessionId);
			activateMs = performance.now() - activateStart;
			if (generation !== switchGeneration) return;
			if (!activateResponse.success || !activateResponse.session) {
				log.error("session activate failed", {
					sessionId,
					error: activateResponse.error,
				});
				if (currentSessionId.value === sessionId) {
					currentSessionId.value = previousSessionId;
				}
				chatStore.setSessionLoading(sessionId, false);
				return;
			}

			const sessionDetails = activateResponse.session as SessionDetails;

			// Update local session data with latest from backend
			const localSession = sessions.value.find((s) => s.id === sessionId);
			if (localSession) {
				Object.assign(localSession, sessionDetails);
			}

			// Deliberately no "mirror session's model into global settings"
			// step here: ModelSelector/ThinkToggle already read the current
			// selection straight off this session (resolveProviderModelSelection
			// via getSessionItem, populated by the Object.assign above), so
			// mirroring into the *global* default was both unnecessary and, per
			// the 2026-07-14 incident, actively dangerous — it would silently
			// overwrite the user's global default provider on every session
			// switch.

			// Step 2: Load the page needed by the UI state. Sessions without a saved
			// detached anchor open at the tail, while revisits load around the saved
			// anchor so the renderer can restore the exact viewport.
			if (!existingMessages || existingMessages.length === 0) {
				const pageStart = performance.now();
				if (anchorMessageId) {
					await chatStore.loadMessagesAround(sessionId, anchorMessageId);
				} else {
					await chatStore.loadInitialMessagePage(
						sessionId,
						SWITCH_INITIAL_MESSAGE_LIMIT,
					);
				}
				if (generation !== switchGeneration) return;
				pageMs = performance.now() - pageStart;
				if (!anchorMessageId) {
					scheduleTailPageBackfill(sessionId);
				}
			} else {
				reusedCachedMessages = true;
				if (anchorMessageId && !existingHasAnchor) {
					const pageStart = performance.now();
					await chatStore.loadMessagesAround(sessionId, anchorMessageId);
					if (generation !== switchGeneration) return;
					pageMs = performance.now() - pageStart;
				} else if (
					!anchorMessageId &&
					existingMessages.length < SWITCH_TARGET_MESSAGE_LIMIT
				) {
					scheduleTailPageBackfill(sessionId);
				}
			}

			// Keep switch hot path free of full legacy session reads. Variables and
			// global user markers still live inside the JSON session file today, so
			// they are fetched lazily by the inspector / nav flows instead of during
			// every switch.

			perfLog.debug("session switched", {
				sessionId,
				totalMs: Math.round(performance.now() - switchStart),
				activateMs: Math.round(activateMs),
				pageMs: Math.round(pageMs),
				commitMs: Math.round(commitMs),
				visibleSwitchMs: Math.round(visibleSwitchMs),
				reusedCachedMessages,
				renderedMessages: chatStore.sessionMessages.get(sessionId)?.length ?? 0,
			});

			return sessionDetails;
		} catch (error) {
			log.error("session switch failed", { sessionId }, error);
			if (currentSessionId.value === sessionId) {
				currentSessionId.value = previousSessionId;
			}
			isActive.value = false;
			useChatStore().setSessionLoading(sessionId, false);
			perfLog.debug("session switch failed", {
				sessionId,
				totalMs: Math.round(performance.now() - switchStart),
				activateMs: Math.round(activateMs),
				pageMs: Math.round(pageMs),
				commitMs: Math.round(commitMs),
				visibleSwitchMs: Math.round(visibleSwitchMs),
				failed: true,
			});
		}
	}

	function scheduleTailPageBackfill(sessionId: string) {
		requestAnimationFrame(() => {
			window.setTimeout(async () => {
				if (currentSessionId.value !== sessionId) return;
				const chatStore = useChatStore();
				const loaded = chatStore.sessionMessages.get(sessionId)?.length ?? 0;
				const remaining = SWITCH_TARGET_MESSAGE_LIMIT - loaded;
				if (remaining <= 0) return;
				await chatStore.loadOlderMessages(sessionId, remaining);
			}, 0);
		});
	}

	async function deleteSession(sessionId: string) {
		if (isNewChatDraftId(sessionId)) {
			discardNewChatDraft(sessionId);
			return;
		}
		const session = sessions.value.find((s) => s.id === sessionId);

		// If session has no messages, permanently delete instead of archiving
		// Use messageCount (from metadata) instead of messages array
		const hasMessages =
			session && session.messageCount && session.messageCount > 0;
		if (!session || !hasMessages) {
			// Find the index of session to delete for switching logic
			const activeSessions = filteredSessions.value;
			const sessionIndex = activeSessions.findIndex((s) => s.id === sessionId);

			const wasCurrent = currentSessionId.value === sessionId;
			await permanentlyDeleteSession(sessionId);
			const workspace = useWorkspaceStore();
			workspace.closeSession(sessionId);
			if (currentSessionId.value === sessionId && !workspace.activeSessionId) {
				clearCurrentSession();
			}
			// A surviving tab already drove the switch via the workspace effect.
			// With nothing left open, keep the old UX of jumping to a sidebar
			// neighbor instead of dropping into the empty state.
			const remaining = filteredSessions.value;
			if (wasCurrent && !workspace.hasAnySession && remaining.length > 0) {
				// Switch to previous session if available, otherwise next
				// After deletion, the next session is at the same index
				const targetIndex = sessionIndex > 0 ? sessionIndex - 1 : 0;
				await switchSession(
					remaining[Math.min(targetIndex, remaining.length - 1)].id,
				);
			}
			return;
		}

		// Archive the session (soft delete) if it has messages
		await archiveSession(sessionId);
	}

	async function archiveSession(sessionId: string) {
		try {
			const session = sessions.value.find((s) => s.id === sessionId);
			if (!session) return;

			// Find the index of session to archive for switching logic (before archiving)
			const activeSessionsBefore = filteredSessions.value;
			const sessionIndex = activeSessionsBefore.findIndex(
				(s) => s.id === sessionId,
			);

			const archivedAt = Date.now();

			// Collect all child sessions (branches) recursively
			function collectChildSessionIds(parentId: string): string[] {
				const children = sessions.value.filter(
					(s) => s.parentSessionId === parentId,
				);
				let ids: string[] = [];
				for (const child of children) {
					ids.push(child.id);
					ids = ids.concat(collectChildSessionIds(child.id));
				}
				return ids;
			}

			const childIds = collectChildSessionIds(sessionId);
			const allIdsToArchive = [sessionId, ...childIds];

			// Mark all sessions as archived
			for (const id of allIdsToArchive) {
				const s = sessions.value.find((ses) => ses.id === id);
				if (s) {
					s.isArchived = true;
					s.archivedAt = archivedAt;
					await platformApi.updateSessionArchived(id, true, archivedAt);
				}
			}

			// Archived sessions (and their branches) lose their tabs; the
			// workspace effect switches to a surviving neighbor tab if any.
			const wasCurrent = allIdsToArchive.includes(currentSessionId.value);
			const workspace = useWorkspaceStore();
			for (const id of allIdsToArchive) {
				workspace.closeSession(id);
			}
			if (wasCurrent && !workspace.activeSessionId) {
				clearCurrentSession();
			}
			if (wasCurrent && !workspace.hasAnySession) {
				const activeSessions = filteredSessions.value;
				if (activeSessions.length > 0) {
					// Switch to previous session if available, otherwise next
					// After archiving, the next session is at the same index
					const targetIndex = sessionIndex > 0 ? sessionIndex - 1 : 0;
					await switchSession(
						activeSessions[Math.min(targetIndex, activeSessions.length - 1)].id,
					);
				}
			}
		} catch (error) {
			log.error("session archive failed", { sessionId }, error);
		}
	}

	async function restoreSession(sessionId: string) {
		try {
			const session = sessions.value.find((s) => s.id === sessionId);
			if (!session) return;

			// Collect all child sessions (branches) recursively
			function collectChildSessionIds(parentId: string): string[] {
				const children = sessions.value.filter(
					(s) => s.parentSessionId === parentId,
				);
				let ids: string[] = [];
				for (const child of children) {
					ids.push(child.id);
					ids = ids.concat(collectChildSessionIds(child.id));
				}
				return ids;
			}

			const childIds = collectChildSessionIds(sessionId);
			const allIdsToRestore = [sessionId, ...childIds];

			// Unarchive all sessions
			for (const id of allIdsToRestore) {
				const s = sessions.value.find((ses) => ses.id === id);
				if (s) {
					s.isArchived = false;
					s.archivedAt = undefined;
					await platformApi.updateSessionArchived(id, false, null);
				}
			}
		} catch (error) {
			log.error("session restore failed", { sessionId }, error);
		}
	}

	async function permanentlyDeleteSession(sessionId: string) {
		try {
			// Collect all child sessions before delete (backend cascade deletes them)
			function collectChildSessionIds(parentId: string): string[] {
				const children = sessions.value.filter(
					(s) => s.parentSessionId === parentId,
				);
				let ids: string[] = [];
				for (const child of children) {
					ids.push(child.id);
					ids = ids.concat(collectChildSessionIds(child.id));
				}
				return ids;
			}

			const childIds = collectChildSessionIds(sessionId);
			const allIdsToDelete = [sessionId, ...childIds];

			const response = await platformApi.deleteSession(sessionId);
			if (response.success) {
				// Remove all deleted sessions from local state
				sessions.value = sessions.value.filter(
					(s) => !allIdsToDelete.includes(s.id),
				);
				// 后端级联删的是会话,草稿纸是另一棵树上的文件 —— 连同子会话
				// 一起收(它们的纸也留在 scratchpads/ 下)。
				const scratchpadStore = useScratchpadStore();
				for (const id of allIdsToDelete) void scratchpadStore.remove(id);
			}
		} catch (error) {
			log.error("session delete failed", { sessionId }, error);
		}
	}

	async function renameSession(sessionId: string, newName: string) {
		try {
			const response = await platformApi.renameSession(
				sessionId,
				newName,
			);
			if (response.success) {
				cancelSessionNameAnimation(sessionId);
				setSessionName(sessionId, newName);
			}
		} catch (error) {
			log.error("session rename failed", { sessionId }, error);
		}
	}

	async function createBranch(
		parentSessionId: string,
		branchFromMessageId: string,
	) {
		try {
			const response = await platformApi.createBranch(
				parentSessionId,
				branchFromMessageId,
			);
			if (response.success && response.session) {
				// Add the new branch session to the list
				sessions.value.unshift(response.session);
				// Return the session - caller decides whether to switch or split
				return response.session;
			}
		} catch (error) {
			log.error("session branch create failed", { parentSessionId, branchFromMessageId }, error);
		}
		return null;
	}

	async function updateSessionPin(sessionId: string, isPinned: boolean) {
		try {
			const response = await platformApi.updateSessionPin(
				sessionId,
				isPinned,
			);
			if (response.success) {
				const session = sessions.value.find((s) => s.id === sessionId);
				if (session) {
					session.isPinned = isPinned;
				}
			}
		} catch (error) {
			log.error("session pin update failed", { sessionId }, error);
		}
	}

	async function updateSessionWorkingDirectory(
		sessionId: string,
		workingDirectory: string | null,
	): Promise<{ success: boolean; error?: string }> {
		const draft = newChatDrafts.value.find((item) => item.id === sessionId);
		if (draft) {
			if (workingDirectory === null || workingDirectory === "") {
				delete draft.workingDirectory;
			} else {
				draft.workingDirectory = workingDirectory;
			}
			draft.updatedAt = Date.now();
			newChatDrafts.value = [...newChatDrafts.value];
			return { success: true };
		}

		try {
			const response = await platformApi.updateSessionWorkingDirectory(
				sessionId,
				workingDirectory,
			);
			if (response.success) {
				const session = sessions.value.find((s) => s.id === sessionId);
				if (session) {
					if (workingDirectory === null || workingDirectory === "") {
						delete session.workingDirectory;
					} else {
						session.workingDirectory = workingDirectory;
					}
				}
				return { success: true };
			}
			return {
				success: false,
				error: response.error || "Failed to update working directory",
			};
		} catch (error) {
			log.error("session working directory update failed", { sessionId }, error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async function updateSessionAgent(
		sessionId: string,
		agentId: string,
	): Promise<{ success: boolean; error?: string }> {
		const draft = newChatDrafts.value.find((item) => item.id === sessionId);
		if (draft) {
			draft.agentId = agentId || DEFAULT_AGENT_ID;
			draft.updatedAt = Date.now();
			newChatDrafts.value = [...newChatDrafts.value];
			return { success: true };
		}

		try {
			const response = await platformApi.updateSessionAgent(
				sessionId,
				agentId,
			);
			if (response.success) {
				const session = sessions.value.find((s) => s.id === sessionId);
				if (session) {
					session.agentId = agentId;
					sessions.value = [...sessions.value];
				}
			}
			return response;
		} catch (error) {
			const errorObject = error && typeof error === "object" ? error : undefined;
			log.error("session agent update failed", { sessionId }, error);
			return {
				success: false,
				error: caughtErrorMessage(errorObject, "Failed to update session agent"),
			};
		}
	}

	async function updateSessionPermissionMode(
		sessionId: string,
		permissionMode: PermissionMode,
	): Promise<{ success: boolean; error?: string }> {
		const draft = newChatDrafts.value.find((item) => item.id === sessionId);
		if (draft) {
			draft.permissionMode = permissionMode;
			draft.updatedAt = Date.now();
			newChatDrafts.value = [...newChatDrafts.value];
			return { success: true };
		}

		try {
			const response = await platformApi.updateSessionPermissionMode(
				sessionId,
				permissionMode,
			);
			if (response.success) {
				const session = sessions.value.find((s) => s.id === sessionId);
				if (session) {
					session.permissionMode = permissionMode;
					sessions.value = [...sessions.value];
				}
			}
			return response;
		} catch (error) {
			const errorObject = error && typeof error === "object" ? error : undefined;
			log.error("session permission mode update failed", { sessionId }, error);
			return {
				success: false,
				error: caughtErrorMessage(errorObject, "Failed to update session permission mode"),
			};
		}
	}

	async function updateSessionModel(
		sessionId: string,
		provider: string,
		model: string,
	): Promise<{ success: boolean; error?: string }> {
		const draft = newChatDrafts.value.find((item) => item.id === sessionId);
		if (draft) {
			draft.lastProvider = provider;
			draft.lastModel = model;
			// This function IS the picker: mirror the pin the main process sets,
			// so the agent binding stops winning the moment the user chooses.
			draft.modelPinned = true;
			draft.updatedAt = Date.now();
			newChatDrafts.value = [...newChatDrafts.value];
			return { success: true };
		}

		try {
			const response = await platformApi.updateSessionModel(
				sessionId,
				provider,
				model,
			);
			if (response.success) {
				const session = sessions.value.find((s) => s.id === sessionId);
				if (session) {
					session.lastProvider = provider;
					session.lastModel = model;
					session.modelPinned = true;
					sessions.value = [...sessions.value];
				}
			}
			return response;
		} catch (error) {
			const errorObject = error && typeof error === "object" ? error : undefined;
			log.error("session model update failed", { sessionId }, error);
			return {
				success: false,
				error: caughtErrorMessage(errorObject, "Failed to update session model"),
			};
		}
	}

	/**
	 * Update token-usage fields on a session in place. Called by ipc-hub
	 * for `context:size-updated` (per-turn input tokens) and on
	 * `stream:complete` (accumulated session totals). Inspector's Context
	 * tab reactively re-renders from these fields.
	 */
	function updateSessionTokenStats(
		sessionId: string,
		stats: {
			contextSize?: number;
			lastInputTokens?: number;
			totalInputTokens?: number;
			totalOutputTokens?: number;
			totalTokens?: number;
		},
	): void {
		const session = sessions.value.find((s) => s.id === sessionId);
		if (!session) return;
		if (stats.contextSize !== undefined)
			session.contextSize = stats.contextSize;
		if (stats.lastInputTokens !== undefined)
			session.lastInputTokens = stats.lastInputTokens;
		if (stats.totalInputTokens !== undefined)
			session.totalInputTokens = stats.totalInputTokens;
		if (stats.totalOutputTokens !== undefined)
			session.totalOutputTokens = stats.totalOutputTokens;
		if (stats.totalTokens !== undefined)
			session.totalTokens = stats.totalTokens;
	}

	/**
	 * Apply an incoming `session:variables-updated` event:
	 * - Mirror workingDirectory onto the SessionMeta entry (so other UI
	 *   that reads it stays consistent).
	 * - Replace the full variable snapshot for this session.
	 *
	 * The payload now carries the full snapshot (system + custom) — the
	 * inspector reads from `sessionVariables` directly and no longer
	 * recomputes system entries client-side.
	 */
	function updateSessionVariables(
		sessionId: string,
		payload: {
			workingDirectory?: string;
			workingDirectoryRoots?: string[];
			variables?: ContextVariable[];
		},
	): void {
		const session = sessions.value.find((s) => s.id === sessionId);
		if (session && payload.workingDirectory !== undefined) {
			session.workingDirectory = payload.workingDirectory;
		}
		if (session && payload.workingDirectoryRoots !== undefined) {
			session.workingDirectoryRoots = payload.workingDirectoryRoots;
		}
		if (payload.variables !== undefined) {
			sessionVariables.value.set(sessionId, payload.variables);
			// Trigger reactivity for Map mutation.
			sessionVariables.value = new Map(sessionVariables.value);
		}
	}

	/**
	 * `session:collab-updated` 落到列表上(架构收敛 C4 §3)。
	 *
	 * **就地增量**:只动这一条会话的 `room` 与 `name`,列表里其它项一个都不碰。
	 * 从前每个写入方(成员条、设置面板、看板面板的两个开关)在写完之后各自
	 * `loadSessions()` 全量重拉 —— 七处散在五个文件里,新加一个写入口就漏一处,
	 * 而漏掉的症状是"改完不生效,切一下会话又生效了"。
	 *
	 * `room` 是全量小快照,所以这里是**替换**而不是合并:后端刚落盘的那一份就是
	 * 真值,字段级合并只会把一个刚被清掉的 pmAgentId 留在屏幕上。
	 *
	 * 不认识的会话 id 直接忽略:这条事件是"改一行",不是"加一行"。主进程新建的
	 * 房间要进列表,走的是 ipc-hub 那条既有的 `refreshSessionListIfUnknown`。
	 */
	function applyCollabRoomUpdate(
		sessionId: string,
		payload: { name?: string; room?: SessionListItem["room"] },
	): void {
		const session = sessions.value.find((s) => s.id === sessionId);
		if (!session || !payload.room) return;
		session.kind = "room";
		session.room = payload.room;
		// 房名跟着走,但空名字不算改名 —— 那是"这次写入没碰名字"的形状。
		if (payload.name && session.name !== payload.name) {
			session.name = payload.name;
		}
		// sessions 是 ref<Array>,行内字段的写不会自己通知订阅者。
		triggerRef(sessions);
	}

	// ── 房间配置的写路径(架构收敛 C4 §4)──────────────────────────────────
	//
	// 四个写入口(成员条、设置面板、看板面板的两个开关)从前各自直调 platformApi,
	// 「写完镜像怎么更新」这条约定就散在四个组件里。收进来之后约定只写一遍:
	//
	//   **回填 = `session:collab-updated` 事件**(C4-α 建的那条)。主进程落盘后播
	//   一条带 room 全量小快照的事件,ipc-hub 交给上面的 `applyCollabRoomUpdate`
	//   就地增量。所以这些 action **不碰本地状态**,一行都不改 —— 组件写完也
	//   不需要 `loadSessions()` 全量重拉(那正是 C4-α 拆掉的七处)。
	//
	// 一律不吞错:桥抛错就抛给调用方,提示语归 UI。失败的回复原样返回,组件按自己
	// 的措辞显示 —— store 不替谁决定怎么说话。

	// 这三个是**纯转交**,所以刻意不写成 async:多包一层 async 就多一个微任务,
	// 而"按下去到提示出现之间隔了几个 tick"是会被 UI 看见的。
	function updateCollabRoom(
		sessionId: string,
		update: import("@shared/ipc.js").CollabRoomUpdatePatch,
	) {
		return collabApi.roomUpdate({ roomSessionId: sessionId, ...update });
	}

	function setCollabRoomBudgets(
		sessionId: string,
		budgets: import("@shared/ipc.js").CollabRoomBudgetsPatch,
	) {
		return collabApi.roomSetBudgets({ roomSessionId: sessionId, ...budgets });
	}

	function setCollabRoomFrozen(sessionId: string, frozen: boolean) {
		return collabApi.roomSetFrozen({ roomSessionId: sessionId, frozen });
	}

	/**
	 * 建一间群(架构收敛 C4 §4)。
	 *
	 * 这里的回填约定与上面三个**不同**:`session:collab-updated` 是"改一行",而
	 * 建房要的是"加一行" —— 刚出生的房还不在列表里,调用方下一句就要 `openSession`
	 * 它。事件驱动的补拉是异步的,盖不住这个同一拍的顺序要求,所以这一次全量
	 * `loadSessions()` 留着,而且**留在 action 里**:契约从"组件记得刷"变成
	 * "action 保证可见"。
	 */
	async function createCollabRoom(
		name: string,
		room: {
			memberAgentIds: string[];
			pmAgentId?: string;
			budgets?: { dailyCostUSD?: number; maxChain?: number };
			dm?: true;
		},
	) {
		const response = await platformApi.createSession(name, {
			kind: "room",
			room,
		});
		if (response.success && response.session) {
			await loadSessions();
		}
		return response;
	}

	/**
	 * 清空一间房的转录(架构收敛 C4 §4)。
	 *
	 * 回填也不是 `session:collab-updated`:清空动的不是房间配置而是**转录** ——
	 * 列表行上的最后一句、消息数、时间戳全变了,而那条事件只带 room 快照,盖不住
	 * 这些。所以这一次全量重拉同样留在 action 里。
	 */
	async function clearCollabRoomHistory(
		sessionId: string,
		includeMemberDms?: boolean,
	) {
		const response = await collabApi.roomClearHistory({
			roomSessionId: sessionId,
			...(includeMemberDms ? { includeMemberDms: true } : {}),
		});
		if (response?.success) {
			await loadSessions();
		}
		return response;
	}

	/**
	 * Apply an incoming `session:goal-updated` event (null = goal cleared).
	 * The map is the single source of truth for the goal status bar.
	 */
	function updateSessionGoal(
		sessionId: string,
		goal: SessionGoal | null,
		goals?: SessionGoal[],
	): void {
		sessionGoals.value.set(sessionId, goal);
		triggerRef(sessionGoals);
		if (goals) {
			sessionGoalHistory.value.set(sessionId, goals);
			triggerRef(sessionGoalHistory);
		}
	}

	/** Initial fetch for the goal status bar (live updates ride the event). */
	async function fetchGoal(sessionId: string): Promise<SessionGoal | null> {
		try {
			const response = await platformApi.goalGet(sessionId);
			const goal = response.success ? (response.goal ?? null) : null;
			sessionGoals.value.set(sessionId, goal);
			triggerRef(sessionGoals);
			if (response.success && response.goals) {
				sessionGoalHistory.value.set(sessionId, response.goals);
				triggerRef(sessionGoalHistory);
			}
			return goal;
		} catch (error) {
			log.error("goal fetch failed", { sessionId }, error);
			return null;
		}
	}

	/**
	 * Pull the latest variable snapshot from the main process. Called on
	 * session switch (initial fetch) and on any UI action that needs
	 * fresh state without waiting for the next change event.
	 */
	async function fetchVariables(sessionId: string): Promise<ContextVariable[]> {
		try {
			const response = await variablesApi.list({ sessionId });
			const variables =
				response.success && response.variables ? response.variables : [];
			sessionVariables.value.set(sessionId, variables);
			sessionVariables.value = new Map(sessionVariables.value);
			return variables;
		} catch (error) {
			log.error("variables fetch failed", { sessionId }, error);
			return [];
		}
	}

	/**
	 * Write a variable through the registry. The main process will emit
	 * `session:variables-updated`, so the local snapshot picks up via
	 * `updateSessionVariables` — no need to mutate state here.
	 */
	async function setVariable(
		sessionId: string,
		name: string,
		value: string,
		description?: string,
		scope?: "global" | "session" | "agent" | "project",
	): Promise<{ success: boolean; error?: string; code?: string }> {
		const response = await variablesApi.set({
			sessionId,
			name,
			value,
			description,
			scope,
		});
		return {
			success: response.success,
			error: response.error,
			code: response.code,
		};
	}

	async function deleteVariable(
		sessionId: string,
		name: string,
	): Promise<{ success: boolean; error?: string; code?: string }> {
		const response = await variablesApi.delete({ sessionId, name });
		return {
			success: response.success,
			error: response.error,
			code: response.code,
		};
	}

	return {
		sessions,
		newChatDrafts,
		currentSessionId,
		isLoading,
		isActive,
		sessionVariables,
		sessionGoals,
		sessionGoalHistory,
		currentSession,
		sessionCount,
		filteredSessions,
		roomSessions,
		groupRoomSessions,
		userDmRoomSessions,
		agentPairDmRoomSessions,
		isUserDmRoomSession,
		findUserDmRoom,
		readMarks,
		windowFocused,
		// 「用户此刻看不看得见这间房」的唯一判定(agent-dm-user.md §4.3 的通知门
		// 也读它)——别处再写一遍 `visibleSessionIds.has(...) && windowFocused`
		// 就是让两处对"在场"各有一套口径。
		isSessionOnScreen,
		unreadSessionIds,
		isUnreadSession,
		hydrateReadMarks,
		noteInboundActivity,
		markSessionRead,
		markVisibleSessionsRead,
		setWindowFocused,
		agentSessions,
		agentPresence,
		agentDirectChatSessions,
		sidebarSessions,
		radioSessions,
		getSessionItem,
		filteredSessionCount,
		archivedSessions,
		loadSessions,
		openNewChatDraft,
		materializeNewChatDraft,
		discardNewChatDraft,
		isNewChatDraftId,
		createSession,
		createSessionWithoutSwitch,
		switchSession,
		clearCurrentSession,
		deleteSession,
		archiveSession,
		updateSessionTokenStats,
		updateSessionVariables,
		applyCollabRoomUpdate,
		updateCollabRoom,
		setCollabRoomBudgets,
		setCollabRoomFrozen,
		createCollabRoom,
		clearCollabRoomHistory,
		fetchVariables,
		updateSessionGoal,
		fetchGoal,
		setVariable,
		deleteVariable,
		setSessionName,
		updateSessionNameAnimated,
		restoreSession,
		permanentlyDeleteSession,
		renameSession,
		createBranch,
		updateSessionPin,
		updateSessionAgent,
		updateSessionPermissionMode,
		updateSessionModel,
		updateSessionWorkingDirectory,
	};
});
