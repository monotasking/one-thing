import { platformApi } from "@/platform";
import { collabApi } from "@/platform/collab-client";
import { getLogger } from "@/services/log";
/**
 * Chat Store - Centralized state management for all chat sessions
 *
 * 架构说明:
 * - 所有状态按 sessionId 索引（Per-session 状态）
 * - 事件处理器由全局 IPC Hub 调用
 * - useChatSession composable 作为 per-session 视图
 */
import { defineStore } from "pinia";
import { ref, shallowRef, computed, triggerRef } from "vue";
import { perfMark, perfMeasure } from "@/utils/perf";
import type {
	ChatMessage,
	ChatMessageMention,
	ChatMessageReactionActor,
	ChatMessageReplyTo,
	GetSessionMessagesPageResponse,
	GetSessionUserMarkersResponse,
	MessageAttachment,
	PermissionInfo,
	Step,
	ToolCall,
	ToolPartialResult,
	ToolResult,
	ContentPart,
	UserMessageMarker,
} from "@/types";
import {
	appendOrMergeReasoning,
	appendOrMergeText,
	appendReasoningIfMissing,
	appendToolCallPlaceholder,
	applyPluginStatus,
	popTrailingTransient,
	pushImageLoading,
	pushDataStepsIfMissing,
	pushWaiting,
	rebuildLoadedContentParts,
	removeTransientIndicators,
	upsertToolCall,
} from "./helpers/content-parts";
import {
	linkStepsToToolCalls,
	mergeToolCall,
	upsertMessageToolCall,
} from "./helpers/tool-calls";
import { rawTextFromPromptParts } from "@shared/prompt-references";
import type { JsonObject } from "@shared/json";
import type { RequestSnapshotEvent } from "@shared/events/index.js";

import { SESSION_COMMAND_TYPES } from "@shared/events/index.js";
import {
	derivePhase,
	estimateTokens,
	type GenerationPhase,
	type GenerationStatus,
} from "./helpers/generation-status";

type RequestSnapshot = RequestSnapshotEvent["snapshot"];

const log = getLogger("renderer.chat-store");
const perfLog = getLogger("renderer.perf");

// Lazy to avoid a module-init cycle: sessions.ts (via settings.ts) touches
// document/localStorage at import time, which chat.ts must not force on
// DOM-less consumers. The dynamic import is cached after the first call.
async function draftAwareSessionsStore() {
	const { useSessionsStore } = await import("./sessions");
	return useSessionsStore();
}

// Same module-init-cycle concern as draftAwareSessionsStore above.
async function draftAwareSettingsStore() {
	const { useSettingsStore } = await import("./settings");
	return useSettingsStore();
}

/**
 * 当前空间自己表达过的默认 provider/model(批 B9),没表达过就是 `undefined`。
 * 走 store 而不是 `useSpaceProviderView` —— 这里不在组件里,视图那层的生命周期
 * 钩子对它没有意义,它要的只是那一格数据。
 */
async function currentSpaceDefaultSelection() {
	const { useSpaceProvidersStore } = await import("./spaceProviders");
	const store = useSpaceProvidersStore();
	// C1:default 也是普通空间;C2:它住在这个空间的 `providers.json`
	// (`provider` + `providers[provider].model`)。
	const space = store.providerSettings;
	const provider = space?.provider;
	if (!provider) return undefined;
	const model = space?.providers?.[provider]?.model;
	return model ? { provider, model } : { provider };
}

/**
 * The session agent's model binding, or null. Loaded on demand (the list is
 * cached after the first call): the picker and the engine both rank this
 * binding above an unpinned session model, so the display and the request
 * must read the same agent — a divergence here IS the "picked deepseek,
 * billed on codex" failure shape.
 */
async function resolveSessionAgentModel(agentId?: string | null) {
	try {
		const { useAgentsStore } = await import("./agents");
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents();
		// 功能兜底,不是署名(域模型 M4):引擎侧同一条 `findAgent ?? defaultAgent`
		// 规则决定这一发请求用谁的绑定,显示必须跟着同一条规则走。
		return agentsStore.getAgent(agentId)?.model ?? null;
	} catch {
		return null;
	}
}

/**
 * What you see is what you send: resolve the provider/model exactly as the
 * model picker displays it right now, so the send-triggering command can
 * carry it explicitly instead of the engine re-deriving it later from
 * session/global settings (which can have drifted — see
 * packages/onething-runtime/src/providers/provider-config.ts).
 */
async function resolveSendProviderOverride(sessionId: string) {
	const [sessionsStore, settingsStore] = await Promise.all([
		draftAwareSessionsStore(),
		draftAwareSettingsStore(),
	]);
	const { resolveProviderModelSelection } = await import(
		"./helpers/provider-model"
	);
	const session = sessionsStore.getSessionItem(sessionId);
	const { providerId, model } = resolveProviderModelSelection({
		settings: settingsStore.settings,
		session,
		agentModel: await resolveSessionAgentModel(session?.agentId),
		// 批 B9:会话/agent 都没表达过时,空间默认排在全局默认前面。引擎侧同一格
		// 在 `getEffectiveProviderConfig`——两边同形,所见即所发。
		spaceDefault: await currentSpaceDefaultSelection(),
	});
	return providerId ? { providerId, model } : {};
}

// Stream chunk type from IPC
interface StreamChunk {
	type:
		| "text"
		| "reasoning"
		| "tool_call"
		| "tool_result"
		| "continuation"
		| "replace"
		| "tool_input_start"
		| "tool_input_delta"
		| "tool_input_end"
		| "content_part";
	content: string;
	messageId: string;
	sessionId?: string;
	reasoning?: string;
	toolCall?: ToolCall;
	replace?: boolean;
	// For streaming tool input (AI SDK v6)
	toolCallId?: string;
	toolName?: string;
	argsTextDelta?: string;
	// For content_part chunks (interleaved text and steps)
	contentPart?: ContentPart;
	turnIndex?: number;
	placement?: "top" | "inline";
}

// Stream complete data from IPC
interface StreamCompleteData {
	messageId?: string;
	text?: string;
	reasoning?: string;
	sessionId?: string;
	sessionName?: string;
	aborted?: boolean;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
	// Last turn's usage for correct context size calculation (not accumulated)
	lastTurnUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

// Stream error data from IPC
interface StreamErrorData {
	messageId?: string;
	sessionId?: string;
	error: string;
	errorDetails?: string;
	preserved?: boolean;
}

// Step data from IPC
interface StepData {
	sessionId: string;
	messageId: string;
	step: Step;
}

interface StepUpdateData {
	sessionId: string;
	messageId: string;
	stepId: string;
	updates: Partial<Step>;
}

interface ToolExecutionStartData {
	sessionId: string;
	messageId: string;
	toolCallId: string;
	stepId: string;
	toolName: string;
	args: JsonObject;
	/** Authoritative main-process start timestamp (Date.now). */
	startTime?: number;
}

interface ToolExecutionUpdateData {
	sessionId: string;
	messageId: string;
	toolCallId: string;
	stepId: string;
	partialResult: ToolPartialResult;
}

interface ToolExecutionEndData {
	sessionId: string;
	messageId: string;
	toolCallId: string;
	stepId: string;
	result?: ToolResult;
	isError?: boolean;
	error?: string;
	/** Authoritative execution duration measured in the main process. */
	durationMs?: number;
}

// Skill activation data from IPC
interface SkillActivatedData {
	sessionId: string;
	messageId: string;
	skillName: string;
}

interface PermissionRequestData {
	sessionId: string;
	requestId: string;
	messageId: string;
	callId?: string;
	permissionType: string;
	title: string;
	pattern?: string | string[];
	metadata: JsonObject;
	canRespond: boolean;
}

export const useChatStore = defineStore("chat", () => {
	// ============ Per-session 状态 ============

	// Drives the right workbench panel's visibility.
	const inspectorOpen = ref(false);

	// Messages per session
	const sessionMessages = shallowRef<Map<string, ChatMessage[]>>(new Map());

	interface SessionMessagePageState {
		nextCursor: string | null;
		backwardsCursor: string | null;
		hasMoreBefore: boolean;
		hasMoreAfter: boolean;
		totalCount: number;
		isLoadingOlder: boolean;
	}

	const sessionMessagePages = ref<Map<string, SessionMessagePageState>>(
		new Map(),
	);
	const sessionUserMarkers = ref<Map<string, UserMessageMarker[]>>(new Map());

	// Loading state per session
	const sessionLoading = ref<Map<string, boolean>>(new Map());

	// Generating state per session
	const sessionGenerating = ref<Map<string, boolean>>(new Map());

	// Error state per session
	const sessionError = ref<Map<string, string | null>>(new Map());

	// Error details per session
	const sessionErrorDetails = ref<Map<string, string | null>>(new Map());

	// Active streams (sessionId -> messageId)
	const activeStreams = ref<Map<string, string>>(new Map());

	/**
	 * P1(2026-08-14):压缩进行中的会话。由 ipc-hub 的
	 * context:compact-started / -completed 两个 case 维护(C6 又加了 -progress
	 * 一条,写的是下面那张 compactProgress)—— **只有 completed
	 * 清位**:压缩是会话级后台作业,stream:error 或切会话都不该把它抹掉。
	 */
	const compactingSessions = ref<Map<string, boolean>>(new Map());

	function setSessionCompacting(sessionId: string, compacting: boolean) {
		if (!sessionId) return;
		const next = new Map(compactingSessions.value);
		if (compacting) next.set(sessionId, true);
		else next.delete(sessionId);
		compactingSessions.value = next;
	}

	function isSessionCompacting(sessionId: string): boolean {
		return compactingSessions.value.get(sessionId) === true;
	}

	/**
	 * C6(2026-08-14):多块摘要的分块进度。与 compactingSessions 并列而不是
	 * 塞进同一张表:压缩「在跑」是布尔事实(单块压缩全程没有进度),进度是**可选**
	 * 的附加信息。started 清零、completed 清除,由 ipc-hub 的三个 case 维护。
	 */
	const compactProgress = ref<
		Map<string, { chunk: number; totalChunks: number }>
	>(new Map());

	function setSessionCompactProgress(
		sessionId: string,
		progress: { chunk: number; totalChunks: number } | null,
	) {
		if (!sessionId) return;
		if (!progress && !compactProgress.value.has(sessionId)) return;
		const next = new Map(compactProgress.value);
		if (progress) next.set(sessionId, progress);
		else next.delete(sessionId);
		compactProgress.value = next;
	}

	function getSessionCompactProgress(
		sessionId: string,
	): { chunk: number; totalChunks: number } | null {
		return compactProgress.value.get(sessionId) ?? null;
	}

	// Steering messages still waiting in the queue (messageId -> sessionId).
	// A message stays retractable until the next loop turn drains it. Keyed
	// by message id because loaded messages don't reliably carry sessionId.
	const pendingSteeringByMessageId = ref<Map<string, string>>(new Map());

	// ============ Live generation stats (composer readout) ============
	// Plain (non-reactive) bookkeeping polled by useGenerationStatus: chunk
	// arrival is far too frequent to trigger a reactive graph for a 100ms
	// readout. Phase is derived from the streaming message on each read.
	interface GenerationLiveStats {
		startedAt: number;
		receivedChars: number;
		/** Estimated tokens for characters received since the last exact usage. */
		estimatedSinceUsage: number;
		exactOutputTokens: number | null;
		inputTokens: number | null;
		phase: GenerationPhase | null;
		phaseSince: number;
	}
	const generationStats = new Map<string, GenerationLiveStats>();

	interface ComposerDraft {
		messageInput: string;
		quotedText: string;
		attachments: MessageAttachment[];
	}

	const composerDrafts = ref<Map<string, ComposerDraft>>(new Map());
	const pendingPermissionRequests = new Map<string, PermissionRequestData[]>();

	// Chunks can arrive before the assistant-created event during HMR/replay or
	// very tight event timing. Keep them until the target message exists.
	const pendingStreamChunks = new Map<string, Map<string, StreamChunk[]>>();
	const pendingContinuationWaits = new Map<
		string,
		Map<string, { turnIndex?: number }>
	>();

	function normalizeComposerDraft(
		draft: Partial<ComposerDraft>,
	): ComposerDraft {
		return {
			messageInput: draft.messageInput ?? "",
			quotedText: draft.quotedText ?? "",
			attachments: draft.attachments ? [...draft.attachments] : [],
		};
	}

	function isEmptyComposerDraft(draft: ComposerDraft): boolean {
		return (
			!draft.messageInput.trim() &&
			!draft.quotedText.trim() &&
			draft.attachments.length === 0
		);
	}

	function setComposerDraft(sessionId: string, draft: Partial<ComposerDraft>) {
		if (!sessionId) return;
		const normalized = normalizeComposerDraft(draft);
		if (isEmptyComposerDraft(normalized)) {
			composerDrafts.value.delete(sessionId);
		} else {
			composerDrafts.value.set(sessionId, normalized);
		}
		triggerRef(composerDrafts);
	}

	function getComposerDraft(sessionId: string): ComposerDraft | null {
		const draft = composerDrafts.value.get(sessionId);
		return draft ? normalizeComposerDraft(draft) : null;
	}

	function clearComposerDraft(sessionId: string) {
		if (!composerDrafts.value.delete(sessionId)) return;
		triggerRef(composerDrafts);
	}

	function isComposerDraftEmpty(sessionId: string): boolean {
		const draft = composerDrafts.value.get(sessionId);
		return !draft || isEmptyComposerDraft(draft);
	}

	/** Resolve messageId: use provided value or fallback to activeStreams lookup */
	function resolveMessageId(sessionId: string, messageId?: string): string {
		return messageId && messageId !== ""
			? messageId
			: activeStreams.value.get(sessionId) || "";
	}

	function queuePendingStreamChunk(
		sessionId: string,
		messageId: string,
		chunk: StreamChunk,
	) {
		let byMessage = pendingStreamChunks.get(sessionId);
		if (!byMessage) {
			byMessage = new Map();
			pendingStreamChunks.set(sessionId, byMessage);
		}
		const key = messageId || "__active__";
		const queued = byMessage.get(key) || [];
		queued.push(chunk);
		byMessage.set(key, queued);
	}

	function flushPendingStreamChunks(sessionId: string, messageId: string) {
		const byMessage = pendingStreamChunks.get(sessionId);
		if (!byMessage) return;

		const chunks = [
			...(byMessage.get(messageId) || []),
			...(byMessage.get("__active__") || []),
		];
		byMessage.delete(messageId);
		byMessage.delete("__active__");
		if (byMessage.size === 0) pendingStreamChunks.delete(sessionId);

		for (const chunk of chunks) {
			handleStreamChunk({ ...chunk, messageId: chunk.messageId || messageId });
		}
	}

	function clearPendingStreamChunks(sessionId: string, messageId?: string) {
		if (!messageId) {
			pendingStreamChunks.delete(sessionId);
			return;
		}

		const byMessage = pendingStreamChunks.get(sessionId);
		if (!byMessage) return;
		byMessage.delete(messageId);
		byMessage.delete("__active__");
		if (byMessage.size === 0) pendingStreamChunks.delete(sessionId);
	}

	function rememberPendingContinuationWait(
		sessionId: string,
		messageId: string,
		turnIndex?: number,
	): void {
		if (!messageId) return;
		let byMessage = pendingContinuationWaits.get(sessionId);
		if (!byMessage) {
			byMessage = new Map();
			pendingContinuationWaits.set(sessionId, byMessage);
		}
		byMessage.set(messageId, { turnIndex });
	}

	function clearPendingContinuationWait(
		sessionId: string,
		messageId?: string,
	): void {
		if (!messageId) {
			pendingContinuationWaits.delete(sessionId);
			return;
		}

		const byMessage = pendingContinuationWaits.get(sessionId);
		if (!byMessage) return;
		byMessage.delete(messageId);
		if (byMessage.size === 0) pendingContinuationWaits.delete(sessionId);
	}

	function resolveStreamingMessage(
		messages: ChatMessage[],
		messageId?: string,
	): ChatMessage | undefined {
		if (messageId) {
			const byId = messages.find((m) => m.id === messageId);
			if (byId) return byId;
		}
		return (
			[...messages]
				.reverse()
				.find((m) => m.role === "assistant" && m.isStreaming) ||
			[...messages]
				.reverse()
				.find(
					(m) =>
						m.role === "assistant" &&
						m.contentParts?.some((part) => part.type === "waiting"),
				)
		);
	}

	function stopMessageStreaming(
		message: ChatMessage,
		usage?: StreamCompleteData["usage"],
	) {
		if (
			message.contentParts &&
			removeTransientIndicators(message.contentParts)
		) {
			message.contentParts = [...message.contentParts];
		}
		message.isStreaming = false;
		if (usage) {
			message.usage = usage;
		}
	}

	function cancelToolCall(
		toolCall: ToolCall,
		now: number,
		error: string,
	): void {
		toolCall.status = "cancelled";
		toolCall.endTime = toolCall.endTime ?? now;
		if (
			typeof toolCall.durationMs !== "number" &&
			typeof toolCall.startTime === "number" &&
			typeof toolCall.endTime === "number"
		) {
			toolCall.durationMs = Math.max(0, toolCall.endTime - toolCall.startTime);
		}
		toolCall.requiresConfirmation = false;
		toolCall.canRespond = false;
		toolCall.error = toolCall.error || error;
	}

	/**
	 * Defensive reconciliation for stream end: nothing may stay in an active
	 * tool state once the stream is over. If a tool:execution-end event was
	 * lost (backend crash, IPC drop), the step would otherwise stay `running`
	 * forever — shimmer on, live duration ticking, timers never cleared.
	 *
	 * Tool calls awaiting user confirmation are left untouched: that state
	 * legitimately survives stream end (resume-after-confirm opens a new
	 * stream). Aborts have their own cancellation path.
	 */
	function finalizeLingeringToolWork(
		message: ChatMessage,
		error = "Tool did not report completion before the stream ended.",
	): boolean {
		const now = Date.now();
		let changed = false;

		for (const toolCall of message.toolCalls || []) {
			if (toolCall.requiresConfirmation) continue;
			if (!isActiveToolCallStatus(toolCall.status)) continue;
			cancelToolCall(toolCall, now, error);
			changed = true;
		}

		let stepsChanged = false;
		for (const step of message.steps || []) {
			if (step.status !== "running" && step.status !== "pending") continue;
			const linkedToolCall = step.toolCallId
				? message.toolCalls?.find((tc) => tc.id === step.toolCallId)
				: step.toolCall;
			if (
				linkedToolCall?.requiresConfirmation ||
				step.toolCall?.requiresConfirmation
			)
				continue;
			step.status = "cancelled";
			step.error = step.error || error;
			if (linkedToolCall && isActiveToolCallStatus(linkedToolCall.status)) {
				cancelToolCall(linkedToolCall, now, error);
			}
			if (step.toolCall && isActiveToolCallStatus(step.toolCall.status)) {
				cancelToolCall(step.toolCall, now, error);
			}
			stepsChanged = true;
			changed = true;
		}

		if (stepsChanged) {
			linkStepsToToolCalls(message);
			message.steps = [...(message.steps || [])];
		}
		return changed;
	}

	function finalizeStoppedStreamLocally(
		sessionId: string,
		messageId?: string,
	): boolean {
		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = resolveStreamingMessage(messages, resolvedMsgId);
		const abortedError = "Tool cancelled because the stream was stopped.";
		const cancelledPermissions = cancelPendingPermissionsForAbort(
			sessionId,
			messages,
			message?.id || resolvedMsgId || undefined,
		);

		if (!message) {
			if (cancelledPermissions) {
				setSessionMessages(sessionId, [...messages]);
			}
			return cancelledPermissions;
		}

		flushPendingStreamChunks(sessionId, message.id);
		flushToolInputDeltas(sessionId, message.id);
		stopMessageStreaming(message);
		finalizeLingeringToolWork(message, abortedError);
		setSessionMessages(sessionId, [...messages]);
		return true;
	}

	function markTopReasoningStarted(message: ChatMessage, reasoning: string) {
		if (!reasoning || message.reasoning) return;
		message.thinkingStartTime = Date.now();
		message.thinkingTime = undefined;
	}

	// Scroll trigger per session — incremented on every handleStreamChunk call so MessageList
	// can watch a cheap O(1) counter instead of deep-watching all messages.
	const sessionScrollVersion = ref<Map<string, number>>(new Map());

	function getScrollVersion(sessionId: string): number {
		return sessionScrollVersion.value.get(sessionId) ?? 0;
	}

	const pendingScrollBump = new Set<string>();
	type ScheduledFrameHandle = number | ReturnType<typeof globalThis.setTimeout>;
	const scheduleFrame: (
		callback: FrameRequestCallback,
	) => ScheduledFrameHandle =
		typeof requestAnimationFrame === "function"
			? requestAnimationFrame
			: (cb: FrameRequestCallback) => {
					const timeout =
						typeof window?.setTimeout === "function"
							? window.setTimeout.bind(window)
							: globalThis.setTimeout;
					return timeout(() => cb(performance.now()), 16);
				};

	function bumpScrollVersion(sessionId: string) {
		if (pendingScrollBump.has(sessionId)) return;
		pendingScrollBump.add(sessionId);
		scheduleFrame(() => {
			pendingScrollBump.delete(sessionId);
			sessionScrollVersion.value.set(
				sessionId,
				getScrollVersion(sessionId) + 1,
			);
		});
	}

	const TOOL_INPUT_DELTA_SEPARATOR = "\u0000";
	const pendingToolInputDeltas = new Map<string, string>();
	let pendingToolInputFlushFrame: ScheduledFrameHandle | null = null;

	function toolInputDeltaKey(
		sessionId: string,
		messageId: string,
		toolCallId: string,
	): string {
		return [sessionId, messageId, toolCallId].join(TOOL_INPUT_DELTA_SEPARATOR);
	}

	function parseToolInputDeltaKey(key: string): {
		sessionId: string;
		messageId: string;
		toolCallId: string;
	} {
		const [sessionId, messageId, toolCallId] = key.split(
			TOOL_INPUT_DELTA_SEPARATOR,
		);
		return { sessionId, messageId, toolCallId };
	}

	function queueToolInputDelta(
		sessionId: string,
		messageId: string,
		toolCallId: string,
		delta: string,
	) {
		const key = toolInputDeltaKey(sessionId, messageId, toolCallId);
		pendingToolInputDeltas.set(
			key,
			(pendingToolInputDeltas.get(key) || "") + delta,
		);
		if (pendingToolInputFlushFrame !== null) return;
		pendingToolInputFlushFrame = scheduleFrame(() => {
			pendingToolInputFlushFrame = null;
			flushToolInputDeltas();
		});
	}

	function flushToolInputDeltas(
		sessionId?: string,
		messageId?: string,
		toolCallId?: string,
	) {
		if (pendingToolInputDeltas.size === 0) return;

		const touchedSessions = new Set<string>();
		for (const [key, delta] of Array.from(pendingToolInputDeltas.entries())) {
			const parsed = parseToolInputDeltaKey(key);
			if (sessionId && parsed.sessionId !== sessionId) continue;
			if (messageId && parsed.messageId !== messageId) continue;
			if (toolCallId && parsed.toolCallId !== toolCallId) continue;

			if (!delta) continue;

			const messages = getSessionMessagesRef(parsed.sessionId);
			const message = messages.find((m) => m.id === parsed.messageId);
			const toolCall = message?.toolCalls?.find(
				(tc) => tc.id === parsed.toolCallId,
			);
			if (!message || !toolCall || toolCall.status !== "input-streaming")
				continue;

			pendingToolInputDeltas.delete(key);
			toolCall.streamingArgs = (toolCall.streamingArgs || "") + delta;
			if (message.steps) {
				for (const step of message.steps) {
					if (step.toolCallId === parsed.toolCallId) {
						step.toolCall = toolCall;
					}
				}
			}
			if (message.toolCalls) message.toolCalls = [...message.toolCalls];
			if (message.steps) message.steps = [...message.steps];
			if (message.contentParts)
				message.contentParts = [...message.contentParts];
			touchedSessions.add(parsed.sessionId);
		}

		for (const touchedSessionId of touchedSessions) {
			const messages = getSessionMessagesRef(touchedSessionId);
			setSessionMessages(touchedSessionId, [...messages]);
			bumpScrollVersion(touchedSessionId);
		}
	}

	function clearToolInputDeltas(sessionId: string, messageId?: string) {
		for (const key of Array.from(pendingToolInputDeltas.keys())) {
			const parsed = parseToolInputDeltaKey(key);
			if (parsed.sessionId !== sessionId) continue;
			if (messageId && parsed.messageId !== messageId) continue;
			pendingToolInputDeltas.delete(key);
		}
	}

	// ============ Request snapshots ring buffer ============
	// Per-session list of the most recent outbound LLM requests (cap = 5).
	// Populated from the `request:snapshot` event emitted by the stream runtime.
	// Has no UI consumer since the inspector panel was removed; kept as a
	// diagnostic buffer that `getRequestSnapshots` exposes.
	const REQUEST_SNAPSHOT_CAP = 5;
	const sessionRequestSnapshots = ref<Map<string, RequestSnapshot[]>>(
		new Map(),
	);

	function getRequestSnapshots(sessionId: string): RequestSnapshot[] {
		return sessionRequestSnapshots.value.get(sessionId) ?? [];
	}

	function handleRequestSnapshot(data: {
		sessionId: string;
		snapshot: RequestSnapshot;
	}) {
		const list = sessionRequestSnapshots.value.get(data.sessionId) ?? [];
		const next = [...list, data.snapshot];
		if (next.length > REQUEST_SNAPSHOT_CAP)
			next.splice(0, next.length - REQUEST_SNAPSHOT_CAP);
		sessionRequestSnapshots.value.set(data.sessionId, next);
	}

	function clearRequestSnapshots(sessionId: string) {
		sessionRequestSnapshots.value.delete(sessionId);
	}

	// ============ UI State (Per-session) ============

	// Session UI snapshots. Tail is a semantic state; only detached sessions keep
	// an anchor. DOM indexes are local to the loaded window and are not global
	// conversation positions.
	interface SessionUISnapshot {
		mode: "tail" | "anchor";
		anchorMessageId?: string;
		offsetWithinMessage?: number;
		navMessageId?: string;
		hasNavigated: boolean;
		messageInput: string;
		quotedText: string;
		attachments?: MessageAttachment[];
	}

	const sessionSnapshots = new Map<string, SessionUISnapshot>();

	function saveSnapshot(sessionId: string, snapshot: SessionUISnapshot) {
		sessionSnapshots.set(sessionId, snapshot);
	}

	function getSnapshot(sessionId: string): SessionUISnapshot | null {
		return sessionSnapshots.get(sessionId) ?? null;
	}

	function deleteSnapshot(sessionId: string) {
		sessionSnapshots.delete(sessionId);
	}

	// Expanded tool calls per session
	const sessionExpandedToolCalls = ref<Map<string, Set<string>>>(new Map());

	// Folded room utterance blocks per session (P1-2). Stores what the user
	// COLLAPSED, never what is open: a room is open by default, and an absent
	// entry has to mean "expanded" so a burst that grows while folded (or a group
	// that appears after the fact) needs no bookkeeping to render correctly.
	const sessionCollapsedRoomGroups = ref<Map<string, Set<string>>>(new Map());

	// ============ Getters ============

	/**
	 * Get session state for a specific session
	 * Returns reactive computed properties
	 */
	function getSessionState(sessionId: string) {
		return {
			messages: computed(() => sessionMessages.value.get(sessionId) || []),
			isLoading: computed(() => sessionLoading.value.get(sessionId) || false),
			isGenerating: computed(
				() => sessionGenerating.value.get(sessionId) || false,
			),
			error: computed(() => sessionError.value.get(sessionId) || null),
			errorDetails: computed(
				() => sessionErrorDetails.value.get(sessionId) || null,
			),
		};
	}

	/**
	 * Check if a specific session is generating
	 */
	function isSessionGenerating(sessionId: string): boolean {
		return (
			sessionGenerating.value.get(sessionId) ||
			activeStreams.value.has(sessionId)
		);
	}

	// ============ UI State Functions ============

	/**
	 * Check if a tool call is expanded (showing details)
	 */
	function isToolCallExpanded(sessionId: string, toolCallId: string): boolean {
		return (
			sessionExpandedToolCalls.value.get(sessionId)?.has(toolCallId) ?? false
		);
	}

	/**
	 * Toggle tool call expansion state
	 */
	function toggleToolCall(sessionId: string, toolCallId: string): void {
		let set = sessionExpandedToolCalls.value.get(sessionId);
		if (!set) {
			set = new Set();
			sessionExpandedToolCalls.value.set(sessionId, set);
		}
		if (set.has(toolCallId)) {
			set.delete(toolCallId);
		} else {
			set.add(toolCallId);
		}
		// Trigger reactivity
		sessionExpandedToolCalls.value = new Map(sessionExpandedToolCalls.value);
	}

	/**
	 * Collapse specified tool calls
	 */
	function collapseAllToolCalls(
		sessionId: string,
		toolCallIds: string[],
	): void {
		const set = sessionExpandedToolCalls.value.get(sessionId);
		if (!set) return;
		for (const id of toolCallIds) {
			set.delete(id);
		}
		sessionExpandedToolCalls.value = new Map(sessionExpandedToolCalls.value);
	}

	/**
	 * Is this room utterance block folded? Default false — see the ref's note.
	 */
	function isRoomGroupCollapsed(sessionId: string, groupKey: string): boolean {
		return (
			sessionCollapsedRoomGroups.value.get(sessionId)?.has(groupKey) ?? false
		);
	}

	/** Fold / unfold one room utterance block. */
	function toggleRoomGroupCollapsed(sessionId: string, groupKey: string): void {
		let set = sessionCollapsedRoomGroups.value.get(sessionId);
		if (!set) {
			set = new Set();
			sessionCollapsedRoomGroups.value.set(sessionId, set);
		}
		if (set.has(groupKey)) {
			set.delete(groupKey);
		} else {
			set.add(groupKey);
		}
		// Trigger reactivity (the inner Set is not itself reactive).
		sessionCollapsedRoomGroups.value = new Map(
			sessionCollapsedRoomGroups.value,
		);
	}

	/** Unfold one block explicitly — used when the list has to reveal a row. */
	function expandRoomGroup(sessionId: string, groupKey: string): void {
		const set = sessionCollapsedRoomGroups.value.get(sessionId);
		if (!set?.delete(groupKey)) return;
		sessionCollapsedRoomGroups.value = new Map(
			sessionCollapsedRoomGroups.value,
		);
	}

	// ============ Helper Functions ============

	/**
	 * Rebuild contentParts for a message from content and/or steps/toolCalls.
	 * This is needed when loading historical messages from storage; the
	 * judgement itself is `rebuildLoadedContentParts` (helpers/content-parts).
	 */
	function rebuildContentParts(message: ChatMessage): ChatMessage {
		if (message.role !== "assistant") return message;

		// Reloaded messages have step.toolCall and message.toolCalls[i] as
		// independent JSON objects. Relink so mutations from later chunks /
		// user actions propagate to both consumers.
		linkStepsToToolCalls(message);

		if (message.contentParts && message.contentParts.length > 0) return message;

		const parts = rebuildLoadedContentParts(message);

		if (parts.length > 0) {
			return { ...message, contentParts: parts };
		}

		return message;
	}

	/**
	 * Update messages for a session and trigger reactivity
	 */
	function setSessionMessages(sessionId: string, messages: ChatMessage[]) {
		// Ensure every message carries its sessionId so that downstream
		// components (e.g. MessageActions downvote) can reference it.
		for (const msg of messages) {
			msg.sessionId = sessionId;
		}
		sessionMessages.value.set(sessionId, messages);
		triggerRef(sessionMessages);
	}

	function logTime(): string {
		return new Date().toISOString();
	}

	function previewText(value: string | undefined, maxLength = 240): string {
		return (value ?? "").replace(/\s+/g, " ").trim().slice(-maxLength);
	}

	const debugLastAppliedAt = new Map<string, number>();

	function debugGapMs(key: string, now = Date.now()): number | undefined {
		const previous = debugLastAppliedAt.get(key);
		debugLastAppliedAt.set(key, now);
		return previous === undefined ? undefined : now - previous;
	}

	function cachePendingPermissionRequest(data: PermissionRequestData): void {
		const requests = pendingPermissionRequests.get(data.sessionId) || [];
		const existingIndex = requests.findIndex(
			(req) => req.requestId === data.requestId,
		);
		if (existingIndex >= 0) {
			requests[existingIndex] = data;
		} else {
			requests.push(data);
		}
		pendingPermissionRequests.set(data.sessionId, requests);
	}

	/**
	 * 兜底:审批来了,而这条消息上还没有那个工具调用。
	 *
	 * 正常情况下 `tool:call` 事件早就把调用挂上去了。挂不上只有一种可能 —— 那批
	 * 事件在路上丢了(历史病根是它们不带消息号,渲染侧只能靠「当前活跃流」去猜,
	 * 一旦窗口中途重载/换窗口/后进会话,绑定不在,事件就没了下落)。号已经补上
	 * (core/engine/event-only-emitter.ts),但**丢事件不该等于丢审批**:后端此刻
	 * 正挂着等人回答,前端一张卡都不给,就是死锁。
	 *
	 * 所以按 ask 自己带的事实原地补一张**可应答**的卡:应答走的是 permissionId +
	 * toolCallId,与工具调用本身的完整度无关。真的 `tool:call` 后到时会按同一个 id
	 * 合并进来(`upsertMessageToolCall` 就地并,不换对象),不会留下第二张。
	 */
	function adoptToolCallForPermission(
		message: ChatMessage,
		data: PermissionRequestData,
	): ToolCall | undefined {
		if (!data.callId) return undefined;

		const metadata = (data.metadata ?? {}) as Record<string, unknown>;
		const toolName = String(metadata.toolName || data.permissionType || "tool");
		const args: Record<string, unknown> = {};
		if (typeof metadata.command === "string") args.command = metadata.command;
		if (typeof metadata.path === "string") args.path = metadata.path;

		const adopted = upsertMessageToolCall(message, {
			id: data.callId,
			toolId: toolName,
			toolName,
			arguments: args,
			status: "pending",
			timestamp: Date.now(),
		} as ToolCall);
		// 已经有一条 step 认领了这个 id 的话,让它指向同一个对象,徽标才跟着走。
		linkStepsToToolCalls(message);
		log.warn("adopted unknown tool call for permission ask", {
			sessionId: data.sessionId,
			callId: data.callId,
			toolName,
		});
		return adopted;
	}

	function findToolCallForPermission(
		message: ChatMessage,
		data: PermissionRequestData,
	) {
		let toolCall = message.toolCalls?.find((tc) => tc.id === data.callId);
		if (!toolCall && data.metadata.command) {
			toolCall = message.toolCalls?.find(
				(tc) => tc.arguments?.command === data.metadata.command,
			);
		}
		return toolCall;
	}

	function applyPermissionRequest(
		data: PermissionRequestData,
		cacheIfMissing = true,
	): boolean {
		const messages = getSessionMessagesRef(data.sessionId);
		const message = messages.find((m) => m.id === data.messageId);
		if (!message) {
			if (cacheIfMissing) {
				cachePendingPermissionRequest(data);
				log.debug("permission request cached until message exists", {
					sessionId: data.sessionId,
					messageId: data.messageId,
					requestId: data.requestId,
				});
			}
			return false;
		}

		const toolCall =
			findToolCallForPermission(message, data) ??
			adoptToolCallForPermission(message, data);
		if (!toolCall) {
			if (cacheIfMissing) {
				cachePendingPermissionRequest(data);
				log.debug("permission request cached until tool call exists", {
					sessionId: data.sessionId,
					callId: data.callId,
					requestId: data.requestId,
				});
			}
			return false;
		}

		toolCall.permissionId = data.requestId;
		toolCall.canRespond = data.canRespond;
		toolCall.requiresConfirmation = true;
		toolCall.permissionQueued = false;
		toolCall.status = "pending";

		const step = message.steps?.find((s) => s.toolCallId === toolCall.id);
		if (step) {
			step.status = "awaiting-confirmation";
			if (data.metadata && (data.metadata.diff || data.metadata.path)) {
				step.result = JSON.stringify(data.metadata);
			}
			if (message.steps) {
				message.steps = [...message.steps];
			}
		}

		// 必须换掉数组身份,不能只 triggerRef。
		//
		// 卡片读的是 `panelMessages → messages → sessionMessages.get(sid)` 这条
		// computed 链。就地改字段 + `triggerRef` 只能叫醒**第一环**:它重算后拿到的
		// 还是同一个数组对象,而 Vue 的 computed 在自身值没变(===)时**不会向下游
		// 传播**,链子就在这里断了 —— 审批卡因此是唯一"数据写进去了、界面不动"的
		// 那一格(别的事件都走 `setSessionMessages`,换了新数组,自然一路通到底)。
		// 真机上它表现为:要等下一次消息重建(翻页/补水)才突然冒出来。
		setSessionMessages(data.sessionId, [...messages]);
		log.debug("tool call updated with permission request", {
			sessionId: data.sessionId,
			toolCallId: toolCall.id,
			canRespond: data.canRespond,
		});
		return true;
	}

	function applyPendingPermissionRequests(
		sessionId: string,
		messageId: string,
	): void {
		const requests = pendingPermissionRequests.get(sessionId);
		if (!requests?.length) return;

		const remaining: PermissionRequestData[] = [];
		for (const request of requests) {
			if (
				request.messageId !== messageId ||
				!applyPermissionRequest(request, false)
			) {
				remaining.push(request);
			}
		}

		if (remaining.length > 0) {
			pendingPermissionRequests.set(sessionId, remaining);
		} else {
			pendingPermissionRequests.delete(sessionId);
		}
	}

	function cancelPendingPermissionsForAbort(
		sessionId: string,
		messages: ChatMessage[],
		messageId?: string,
	): boolean {
		pendingPermissionRequests.delete(sessionId);

		let changed = false;
		const now = Date.now();
		for (const message of messages) {
			if (messageId && message.id !== messageId) continue;

			let toolCallChanged = false;
			for (const toolCall of message.toolCalls || []) {
				if (!toolCall.requiresConfirmation && !toolCall.permissionQueued)
					continue;
				toolCall.requiresConfirmation = false;
				toolCall.permissionQueued = false;
				toolCall.canRespond = false;
				toolCall.status = "cancelled";
				toolCall.endTime = toolCall.endTime ?? now;
				toolCall.error =
					toolCall.error ||
					"Permission request cancelled because the stream was stopped.";
				toolCallChanged = true;
				changed = true;
			}

			if (!message.steps) continue;
			if (toolCallChanged) {
				linkStepsToToolCalls(message);
				message.steps = [...message.steps];
			}
			let stepsChanged = false;
			for (const step of message.steps) {
				const linkedToolCall = step.toolCallId
					? message.toolCalls?.find((tc) => tc.id === step.toolCallId)
					: step.toolCall;
				const shouldCancelStep =
					step.status === "awaiting-confirmation" ||
					Boolean(step.toolCall?.requiresConfirmation) ||
					Boolean(linkedToolCall?.requiresConfirmation);
				if (!shouldCancelStep) continue;

				step.status = "cancelled";
				step.error =
					step.error ||
					"Permission request cancelled because the stream was stopped.";
				if (linkedToolCall) {
					linkedToolCall.requiresConfirmation = false;
					linkedToolCall.permissionQueued = false;
					linkedToolCall.canRespond = false;
					linkedToolCall.status = "cancelled";
					linkedToolCall.endTime = linkedToolCall.endTime ?? now;
					linkedToolCall.error = linkedToolCall.error || step.error;
					step.toolCall = linkedToolCall;
				} else if (step.toolCall) {
					step.toolCall.requiresConfirmation = false;
					step.toolCall.permissionQueued = false;
					step.toolCall.canRespond = false;
					step.toolCall.status = "cancelled";
					step.toolCall.endTime = step.toolCall.endTime ?? now;
					step.toolCall.error = step.toolCall.error || step.error;
				}
				stepsChanged = true;
				changed = true;
			}
			if (stepsChanged) {
				linkStepsToToolCalls(message);
				message.steps = [...message.steps];
			}
		}

		return changed;
	}

	function setSessionPageState(
		sessionId: string,
		page: GetSessionMessagesPageResponse,
		isLoadingOlder = false,
	) {
		sessionMessagePages.value.set(sessionId, {
			nextCursor: page.nextCursor ?? null,
			backwardsCursor: page.backwardsCursor ?? null,
			hasMoreBefore: !!page.hasMoreBefore,
			hasMoreAfter: !!page.hasMoreAfter,
			totalCount: page.totalCount ?? page.messages?.length ?? 0,
			isLoadingOlder,
		});
		triggerRef(sessionMessagePages);
	}

	function updateSessionPageState(
		sessionId: string,
		updates: Partial<SessionMessagePageState>,
	) {
		const current = sessionMessagePages.value.get(sessionId);
		if (!current) return;
		sessionMessagePages.value.set(sessionId, { ...current, ...updates });
		triggerRef(sessionMessagePages);
	}

	function getSessionPageState(
		sessionId: string,
	): SessionMessagePageState | undefined {
		return sessionMessagePages.value.get(sessionId);
	}

	function mergeActiveStreamingMessage(
		sessionId: string,
		messages: ChatMessage[],
	): ChatMessage[] {
		const activeStreamMessageId = activeStreams.value.get(sessionId);
		if (!activeStreamMessageId) return messages;

		const existingMessages = sessionMessages.value.get(sessionId) || [];
		const streamingMessage = existingMessages.find(
			(m) => m.id === activeStreamMessageId,
		);
		if (!streamingMessage) return messages;

		const index = messages.findIndex((m) => m.id === activeStreamMessageId);
		if (index !== -1) {
			messages[index] = streamingMessage;
		} else {
			messages.push(streamingMessage);
		}
		return messages;
	}

	/**
	 * Get messages for a session (mutable reference)
	 */
	function getSessionMessagesRef(sessionId: string): ChatMessage[] {
		let messages = sessionMessages.value.get(sessionId);
		if (!messages) {
			messages = [];
			sessionMessages.value.set(sessionId, messages);
		}
		return messages;
	}

	function isActiveStepStatus(status: Step["status"]): boolean {
		return (
			status === "running" ||
			status === "awaiting-confirmation" ||
			status === "pending"
		);
	}

	function isActiveToolCallStatus(status: ToolCall["status"]): boolean {
		return (
			status === "executing" ||
			status === "input-streaming" ||
			status === "received" ||
			status === "pending" ||
			status === "queued"
		);
	}

	function isStepInContinuationScope(
		step: Step,
		continuationTurnIndex?: number,
	): boolean {
		if (continuationTurnIndex === undefined) return true;
		if (step.turnIndex === undefined) return true;
		return step.turnIndex === continuationTurnIndex - 1;
	}

	function hasActiveToolWork(
		message: ChatMessage,
		continuationTurnIndex?: number,
	): boolean {
		if (
			message.steps?.some(
				(step) =>
					isActiveStepStatus(step.status) &&
					isStepInContinuationScope(step, continuationTurnIndex),
			)
		) {
			return true;
		}

		return Boolean(
			message.toolCalls?.some((toolCall) => {
				if (!isActiveToolCallStatus(toolCall.status)) return false;
				if (continuationTurnIndex === undefined) return true;

				const relatedSteps =
					message.steps?.filter((step) => step.toolCallId === toolCall.id) ??
					[];
				if (relatedSteps.length === 0) return true;

				return relatedSteps.some(
					(step) =>
						isActiveStepStatus(step.status) &&
						isStepInContinuationScope(step, continuationTurnIndex),
				);
			}),
		);
	}

	function flushPendingContinuationWait(
		sessionId: string,
		messageId?: string,
	): boolean {
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		if (!resolvedMsgId) return false;

		const pending = pendingContinuationWaits.get(sessionId)?.get(resolvedMsgId);
		if (!pending) return false;

		const messages = getSessionMessagesRef(sessionId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message || message.isStreaming === false) {
			clearPendingContinuationWait(sessionId, resolvedMsgId);
			return false;
		}
		if (hasActiveToolWork(message, pending.turnIndex)) return false;

		if (!message.contentParts) message.contentParts = [];
		pushWaiting(message.contentParts, pending.turnIndex);
		message.contentParts = [...message.contentParts];
		clearPendingContinuationWait(sessionId, resolvedMsgId);
		setSessionMessages(sessionId, [...messages]);
		bumpScrollVersion(sessionId);
		return true;
	}

	// ============ Event Handlers (Called by IPC Hub) ============

	/**
	 * Handle stream chunk event
	 */
	function handleStreamChunk(chunk: StreamChunk) {
		if (chunk.type === "tool_input_start" || chunk.type === "tool_input_delta") {
			log.trace("tool input chunk received", {
				type: chunk.type,
				sessionId: chunk.sessionId,
				messageId: chunk.messageId,
				toolCallId: chunk.toolCallId,
				hasArgsTextDelta: Boolean(chunk.argsTextDelta),
			});
		}

		const sessionId = chunk.sessionId;
		if (!sessionId) {
			log.warn("stream chunk missing sessionId");
			return;
		}

		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, chunk.messageId);
		if (!resolvedMsgId) {
			// 插件状态**只在流内有意义**,排队等于给它安排一次诈尸:待发队列会在
			// 下一次 stream:start 时 flush 到一条毫不相干的新消息上,而那时插件
			// 早就不在做那件事了。宿主账本已经在源头拒绝这种调用(R7),这里是
			// 渲染侧的第二道 —— 绕开账本直接发也不会留下幽灵。
			if (
				chunk.type === "content_part" &&
				chunk.contentPart?.type === "plugin-status"
			) {
				log.debug("dropped out-of-stream plugin status", {
					sessionId,
					part: chunk.contentPart,
				});
				return;
			}
			queuePendingStreamChunk(sessionId, "", chunk);
			return;
		}

		const messageIndex = messages.findIndex((m) => m.id === resolvedMsgId);
		if (messageIndex === -1) {
			queuePendingStreamChunk(sessionId, resolvedMsgId, chunk);
			return;
		}

		perfMark("chunk-start");
		const message = messages[messageIndex];
		if (chunk.type !== "tool_input_delta") {
			flushToolInputDeltas(sessionId, resolvedMsgId, chunk.toolCallId);
		}
		let shouldBumpScroll = true;

		// Initialize contentParts if not exists
		if (!message.contentParts) {
			message.contentParts = [];
		}

		const parts = message.contentParts;

		if (chunk.type === "text") noteGenerationChars(sessionId, chunk.content);
		else if (chunk.type === "reasoning") noteGenerationChars(sessionId, chunk.reasoning);
		else if (chunk.type === "tool_input_delta") noteGenerationChars(sessionId, chunk.argsTextDelta);

		if (chunk.type === "text") {
			if (chunk.replace) {
				message.content = chunk.content;
				message.contentParts = chunk.content
					? [{ type: "text", content: chunk.content }]
					: [];
			} else {
				message.content = (message.content || "") + chunk.content;
				appendOrMergeText(parts, chunk.content, chunk.turnIndex);
				message.contentParts = [...parts];
			}
		} else if (chunk.type === "reasoning") {
			const reasoning = chunk.reasoning || "";
			const placement = chunk.placement ?? (message.content ? "inline" : "top");
			if (placement === "top") {
				markTopReasoningStarted(message, reasoning);
				message.reasoning = (message.reasoning || "") + reasoning;
			} else if (reasoning) {
				appendOrMergeReasoning(parts, reasoning, chunk.turnIndex);
				message.contentParts = [...parts];
			}
		} else if (
			chunk.type === "tool_call" ||
			chunk.type === "tool_result" ||
			chunk.type === "tool_input_end"
		) {
			if (chunk.toolCall) {
				// Merge into the canonical entry in place so any step.toolCall
				// referencing the same id sees the update without manual mirror writes.
				const canonical = upsertMessageToolCall(message, chunk.toolCall);
				// 认领它的 step 要指向同一个对象。从前只在 step 侧的入口重连,于是
				// 「step 先到、且载荷没带内嵌 toolCall」这一路永远绑不上:调用上的
				// `requiresConfirmation` 步骤行看不见,徽标(Needs approval)就哑了。
				linkStepsToToolCalls(message);
				if (chunk.type === "tool_input_end") {
					// The argument stream is settled; a lingering partial-args buffer
					// would let the draft view outlive the real receive-complete moment.
					delete canonical.streamingArgs;
				}
				upsertToolCall(parts, canonical);
				message.contentParts = [...parts];
				applyPendingPermissionRequests(sessionId, message.id);
			}
		} else if (chunk.type === "continuation") {
			if (hasActiveToolWork(message, chunk.turnIndex)) {
				rememberPendingContinuationWait(
					sessionId,
					resolvedMsgId,
					chunk.turnIndex,
				);
				shouldBumpScroll = false;
			} else {
				clearPendingContinuationWait(sessionId, resolvedMsgId);
				pushWaiting(parts, chunk.turnIndex);
				message.contentParts = [...parts];
			}
		} else if (chunk.type === "replace") {
			message.content = chunk.content;
			message.contentParts = chunk.content
				? [{ type: "text", content: chunk.content }]
				: [];
		} else if (chunk.type === "tool_input_start") {
			if (chunk.toolCallId && chunk.toolName) {
				if (!message.toolCalls) message.toolCalls = [];
				let placeholder = message.toolCalls.find(
					(tc) => tc.id === chunk.toolCallId,
				);
				if (!placeholder) {
					placeholder = {
						id: chunk.toolCallId,
						toolId: chunk.toolName,
						toolName: chunk.toolName,
						arguments: {},
						status: "input-streaming",
						timestamp: Date.now(),
						streamingArgs: "",
					};
					message.toolCalls.push(placeholder);
				}
				appendToolCallPlaceholder(parts, placeholder);
				message.contentParts = [...parts];
				applyPendingPermissionRequests(sessionId, message.id);
			}
		} else if (chunk.type === "tool_input_delta") {
			// Streaming tool input can arrive in very small deltas. Batch the
			// expensive reactive writes to one frame, then flush before any final
			// tool event so the UI never misses the tail.
			if (chunk.toolCallId && chunk.argsTextDelta) {
				queueToolInputDelta(
					sessionId,
					resolvedMsgId,
					chunk.toolCallId,
					chunk.argsTextDelta,
				);
			}
			shouldBumpScroll = false;
		} else if (chunk.type === "content_part" && chunk.contentPart) {
			const newPart = chunk.contentPart;
			if (newPart.type === "data-steps") {
				pushDataStepsIfMissing(parts, newPart.turnIndex);
				message.contentParts = [...parts];
			} else if (newPart.type === "text") {
				// Finalized text block for the turn. Streaming text chunks have already
				// built up the text on the hot path. If a provider only delivers the
				// finalized content_part, use it as a display fallback so the message
				// does not remain on the waiting indicator.
				popTrailingTransient(parts);
				if (
					newPart.content &&
					!(message.content || "").includes(newPart.content)
				) {
					message.content = (message.content || "") + newPart.content;
					appendOrMergeText(parts, newPart.content, newPart.turnIndex);
				}
				message.contentParts = [...parts];
			} else if (newPart.type === "reasoning") {
				appendReasoningIfMissing(parts, newPart.content);
				message.contentParts = [...parts];
			} else if (newPart.type === "plugin-status") {
				// 格子语义:同 (pluginId, id) 更新 label,cleared 则移除。
				if (applyPluginStatus(parts, newPart)) {
					message.contentParts = [...parts];
				}
			} else if (newPart.type === "image-loading") {
				pushImageLoading(parts, newPart.turnIndex, newPart.label);
				message.contentParts = [...parts];
			} else if (newPart.type === "waiting") {
				if (hasActiveToolWork(message, newPart.turnIndex)) {
					rememberPendingContinuationWait(
						sessionId,
						resolvedMsgId,
						newPart.turnIndex,
					);
					shouldBumpScroll = false;
				} else {
					clearPendingContinuationWait(sessionId, resolvedMsgId);
					pushWaiting(parts, newPart.turnIndex);
					message.contentParts = [...parts];
				}
			}
		}

		messages[messageIndex] = { ...message };
		setSessionMessages(sessionId, [...messages]);
		// 逐 chunk 的形状转储:`isLevelEnabled` 是**性能护栏**而不是开关 ——
		// previewText / debugGapMs 不该在 trace 关着的时候还跑一遍。
		if (log.isLevelEnabled("trace")) {
			log.trace("stream chunk applied", {
				at: logTime(),
				gapMs: debugGapMs(`${sessionId}:${resolvedMsgId}:${chunk.type}`),
				sessionId,
				messageId: resolvedMsgId,
				type: chunk.type,
				contentChars: message.content?.length ?? 0,
				contentTail: previewText(message.content),
				reasoningChars: message.reasoning?.length ?? 0,
				reasoningTail: previewText(message.reasoning),
				partCount: message.contentParts?.length ?? 0,
				isStreaming: message.isStreaming,
			});
		}
		perfMark("chunk-end");
		perfMeasure("handleStreamChunk", "chunk-start", "chunk-end");
		if (shouldBumpScroll) bumpScrollVersion(sessionId);
	}

	/**
	 * Handle stream complete event
	 */
	async function handleStreamComplete(data: StreamCompleteData) {
		const sessionId = data.sessionId;
		if (!sessionId) {
			log.warn("stream complete missing sessionId");
			return;
		}

		log.debug("stream complete", { sessionId });

		// Update message
		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, data.messageId);
		const message = resolveStreamingMessage(messages, resolvedMsgId);
		const cancelledPermissions = data.aborted
			? cancelPendingPermissionsForAbort(
					sessionId,
					messages,
					resolvedMsgId || undefined,
				)
			: false;
		// Abort clears the engine's steering queue — those messages will never
		// be delivered, so the retract affordance must go with them.
		if (data.aborted) {
			let steeringCleared = false;
			for (const [messageId, pendingSessionId] of pendingSteeringByMessageId.value) {
				if (pendingSessionId !== sessionId) continue;
				pendingSteeringByMessageId.value.delete(messageId);
				steeringCleared = true;
			}
			if (steeringCleared) triggerRef(pendingSteeringByMessageId);
		}
		if (message) {
			flushPendingStreamChunks(sessionId, message.id);
			flushToolInputDeltas(sessionId, message.id);
			stopMessageStreaming(message, data.usage);
			finalizeLingeringToolWork(message);
			setSessionMessages(sessionId, [...messages]);
		} else {
			clearPendingStreamChunks(sessionId, resolvedMsgId);
			clearToolInputDeltas(sessionId, resolvedMsgId);
			if (cancelledPermissions) {
				setSessionMessages(sessionId, [...messages]);
			}
		}

		// Fold the turn's usage into the session-level token stats so the
		// Inspector's Context tab shows session totals without a refetch.
		if (data.usage) {
			try {
				const { useSessionsStore } = await import("./sessions");
				const sessionsStore = useSessionsStore();
				const session = sessionsStore.sessions.find((s) => s.id === sessionId);
				if (session) {
					sessionsStore.updateSessionTokenStats(sessionId, {
						totalInputTokens:
							(session.totalInputTokens ?? 0) + (data.usage.inputTokens ?? 0),
						totalOutputTokens:
							(session.totalOutputTokens ?? 0) + (data.usage.outputTokens ?? 0),
						totalTokens:
							(session.totalTokens ?? 0) + (data.usage.totalTokens ?? 0),
					});
				}
			} catch (e) {
				log.warn("usage fold into session stats failed", { sessionId }, e);
			}
		}

		// Clear generating state
		sessionGenerating.value.set(sessionId, false);
		sessionLoading.value.set(sessionId, false);
		activeStreams.value.delete(sessionId);
		generationStats.delete(sessionId);
		clearPendingStreamChunks(sessionId);
		clearPendingContinuationWait(sessionId);
		clearToolInputDeltas(sessionId);
		triggerRef(sessionGenerating);
		triggerRef(sessionLoading);
		triggerRef(activeStreams);

		// Update session name if provided
		if (data.sessionName) {
			try {
				const { useSessionsStore } = await import("./sessions");
				const sessionsStore = useSessionsStore();
				sessionsStore.updateSessionNameAnimated(sessionId, data.sessionName);
			} catch (e) {
				log.error("session name update failed", { sessionId }, e);
			}
		}
	}

	/**
	 * Handle stream error event
	 */
	function handleStreamError(data: StreamErrorData) {
		const sessionId = data.sessionId;
		if (!sessionId) {
			log.warn("stream error missing sessionId");
			return;
		}

		log.error("stream failed", {
			sessionId,
			error: data.error,
			errorDetails: data.errorDetails,
		});

		// Set error state
		sessionError.value.set(sessionId, data.error || "Streaming error");
		sessionErrorDetails.value.set(sessionId, data.errorDetails || null);
		triggerRef(sessionError);
		triggerRef(sessionErrorDetails);

		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, data.messageId);
		const errorText = data.errorDetails || data.error || "Streaming error";
		if (resolvedMsgId) flushToolInputDeltas(sessionId, resolvedMsgId);

		if (data.preserved) {
			// Message content is preserved in backend — just attach error details and stop streaming
			const msg = resolveStreamingMessage(messages, resolvedMsgId);
			if (msg) {
				msg.errorDetails = errorText;
				stopMessageStreaming(msg);
				finalizeLingeringToolWork(msg);
			}
		} else {
			// No preserved content — replace streaming message with error message
			const errorMessage: ChatMessage = {
				id: `error-${Date.now()}`,
				role: "error",
				content: errorText,
				timestamp: Date.now(),
				errorDetails: errorText,
			};
			messages.push(errorMessage);

			if (resolvedMsgId) {
				const streamingIndex = messages.findIndex(
					(m) => m.id === resolvedMsgId,
				);
				if (streamingIndex !== -1) {
					messages.splice(streamingIndex, 1);
				}
			}
		}

		// Ensure no messages are stuck in streaming state
		for (const msg of messages) {
			if (msg.isStreaming) msg.isStreaming = false;
		}

		setSessionMessages(sessionId, [...messages]);

		// Clear generating state
		sessionGenerating.value.set(sessionId, false);
		sessionLoading.value.set(sessionId, false);
		activeStreams.value.delete(sessionId);
		generationStats.delete(sessionId);
		clearPendingStreamChunks(sessionId);
		clearPendingContinuationWait(sessionId);
		clearToolInputDeltas(sessionId);
		triggerRef(sessionGenerating);
		triggerRef(sessionLoading);
		triggerRef(activeStreams);
	}

	/**
	 * Handle step added event
	 */
	function handleStepAdded(data: StepData) {
		const { sessionId, messageId, step } = data;

		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message) return;
		flushToolInputDeltas(sessionId, message.id, step.toolCallId);

		// Initialize steps array if needed
		if (!message.steps) message.steps = [];

		// Check if step already exists (avoid duplicates from streaming)
		const existingIndex = message.steps.findIndex(
			(s) => s.id === step.id || s.toolCallId === step.toolCallId,
		);
		if (existingIndex >= 0) {
			// Update existing step
			message.steps[existingIndex] = {
				...message.steps[existingIndex],
				...step,
			};
		} else {
			// Add new step
			message.steps.push(step);
		}
		// Re-point step.toolCall at the canonical message.toolCalls entry so
		// mutations from the chunk reducer / MessageList handlers propagate to
		// both consumers without manual mirror writes.
		linkStepsToToolCalls(message);
		const linkedStep = message.steps.find(
			(s) => s.id === step.id || s.toolCallId === step.toolCallId,
		);
		if (linkedStep?.toolCall?.requiresConfirmation) {
			linkedStep.status = "awaiting-confirmation";
		}
		message.steps = [...message.steps];

		// Add steps placeholder to contentParts if needed
		if (message.contentParts && step.turnIndex !== undefined) {
			if (pushDataStepsIfMissing(message.contentParts, step.turnIndex)) {
				message.contentParts = [...message.contentParts];
			}
		}

		applyPendingPermissionRequests(sessionId, message.id);

		setSessionMessages(sessionId, [...messages]);
	}

	/**
	 * Handle step updated event
	 */
	function handleStepUpdated(data: StepUpdateData) {
		const { sessionId, messageId, stepId, updates } = data;

		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message?.steps) return;
		flushToolInputDeltas(sessionId, message.id, updates?.toolCallId);

		const updatedToolCallId = updates?.toolCallId ?? updates?.toolCall?.id;
		const stepIndex = message.steps.findIndex(
			(s) =>
				s.id === stepId ||
				(!!updatedToolCallId && s.toolCallId === updatedToolCallId),
		);
		if (stepIndex !== -1) {
			message.steps[stepIndex] = { ...message.steps[stepIndex], ...updates };
			// Re-link in case the update payload included a fresh `toolCall` clone.
			linkStepsToToolCalls(message);
			message.steps = [...message.steps];
			setSessionMessages(sessionId, [...messages]);
			bumpScrollVersion(sessionId);
			return;
		}
	}

	function findMessageStep(
		sessionId: string,
		messageId: string,
		stepId: string,
		toolCallId?: string,
	): {
		messages: ChatMessage[];
		message: ChatMessage;
		stepIndex: number;
	} | null {
		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message?.steps) return null;
		const stepIndex = message.steps.findIndex(
			(s) => s.id === stepId || (!!toolCallId && s.toolCallId === toolCallId),
		);
		if (stepIndex < 0) return null;
		return { messages, message, stepIndex };
	}

	function patchStep(
		sessionId: string,
		messageId: string,
		stepId: string,
		toolCallId: string | undefined,
		updates: Partial<Step>,
	): void {
		const found = findMessageStep(sessionId, messageId, stepId, toolCallId);
		if (!found) return;
		const { messages, message, stepIndex } = found;
		message.steps![stepIndex] = { ...message.steps![stepIndex], ...updates };
		linkStepsToToolCalls(message);
		message.steps = [...message.steps!];
		setSessionMessages(sessionId, [...messages]);
		bumpScrollVersion(sessionId);
	}

	function patchMessageToolCall(
		sessionId: string,
		messageId: string,
		toolCallId: string,
		updates: Partial<ToolCall>,
	): void {
		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message) return;

		let toolCall = message.toolCalls?.find((tc) => tc.id === toolCallId);
		if (!toolCall) {
			const stepToolCall = message.steps?.find(
				(step) => step.toolCallId === toolCallId,
			)?.toolCall;
			if (stepToolCall) {
				if (!message.toolCalls) message.toolCalls = [];
				message.toolCalls.push(stepToolCall);
				toolCall = stepToolCall;
			}
		}
		if (!toolCall) return;

		mergeToolCall(toolCall, updates);
		linkStepsToToolCalls(message);
		message.toolCalls = [...(message.toolCalls || [])];
		if (message.steps) message.steps = [...message.steps];
		setSessionMessages(sessionId, [...messages]);
		bumpScrollVersion(sessionId);
	}

	function clearMessageTransientIndicators(
		sessionId: string,
		messageId: string,
	): void {
		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (!message?.contentParts?.length) return;

		const nextParts = [...message.contentParts];
		if (!removeTransientIndicators(nextParts)) return;

		message.contentParts = nextParts;
		setSessionMessages(sessionId, [...messages]);
		bumpScrollVersion(sessionId);
	}

	// Timing is owned by the main process: execution-start carries the
	// authoritative startTime and execution-end carries the authoritative
	// durationMs. Renderer clocks are only a fallback for legacy events.
	function handleToolExecutionStart(data: ToolExecutionStartData) {
		patchStep(data.sessionId, data.messageId, data.stepId, data.toolCallId, {
			status: "running",
		});
		patchMessageToolCall(data.sessionId, data.messageId, data.toolCallId, {
			status: "executing",
			startTime: data.startTime ?? Date.now(),
		});
		clearMessageTransientIndicators(data.sessionId, data.messageId);
	}

	function handleToolExecutionUpdate(data: ToolExecutionUpdateData) {
		patchStep(data.sessionId, data.messageId, data.stepId, data.toolCallId, {
			status: "running",
			partialResult: data.partialResult,
			partialResultIsPartial: true,
		});
	}

	function handleToolExecutionEnd(data: ToolExecutionEndData) {
		patchMessageToolCall(data.sessionId, data.messageId, data.toolCallId, {
			status: data.isError ? "failed" : "completed",
			endTime: Date.now(),
			...(typeof data.durationMs === "number"
				? { durationMs: data.durationMs }
				: {}),
			result: data.result as ToolCall["result"],
			...(data.isError ? { error: data.error } : {}),
		});
		patchStep(data.sessionId, data.messageId, data.stepId, data.toolCallId, {
			status: data.isError ? "failed" : "completed",
			partialResult: data.result,
			partialResultIsPartial: false,
			...(data.isError ? { error: data.error } : {}),
		});
		flushPendingContinuationWait(data.sessionId, data.messageId);
	}

	/**
	 * Handle skill activated event
	 */
	function handleSkillActivated(data: SkillActivatedData) {
		const { sessionId, messageId, skillName } = data;

		const messages = getSessionMessagesRef(sessionId);
		const resolvedMsgId = resolveMessageId(sessionId, messageId);
		const message = messages.find((m) => m.id === resolvedMsgId);
		if (message) {
			message.skillUsed = skillName;
			setSessionMessages(sessionId, [...messages]);
		}
	}

	// ============ Actions ============

	/**
	 * Load messages for a session from backend
	 * Note: If this session has an active stream, we preserve the in-memory
	 * streaming message to maintain UI state continuity during session switches
	 */
	async function loadMessages(sessionId: string) {
		try {
			const response = await platformApi.getSession(sessionId);
			if (response.success && response.session) {
				const messages = (response.session.messages || []).map(
					rebuildContentParts,
				);

				// If this session has an active stream, preserve the in-memory streaming message
				// This prevents losing isStreaming, content, reasoning, steps etc. during session switch
				const activeStreamMessageId = activeStreams.value.get(sessionId);
				if (activeStreamMessageId) {
					const existingMessages = sessionMessages.value.get(sessionId) || [];
					const streamingMessage = existingMessages.find(
						(m) => m.id === activeStreamMessageId,
					);
					if (streamingMessage) {
						// Replace backend version with in-memory version to preserve full state
						const index = messages.findIndex(
							(m) => m.id === activeStreamMessageId,
						);
						if (index !== -1) {
							messages[index] = streamingMessage;
						} else {
							// Edge case: backend doesn't have this message yet, append it
							messages.push(streamingMessage);
						}
					}
				}

				setSessionMessages(sessionId, messages);
			}
		} catch (error) {
			log.error("load messages failed", { sessionId }, error);
		}
	}

	async function loadInitialMessagePage(
		sessionId: string,
		limit = 16,
	): Promise<boolean> {
		sessionLoading.value.set(sessionId, true);
		triggerRef(sessionLoading);
		const totalStart = performance.now();
		let ipcMs = 0;
		let rebuildMs = 0;
		let setStateMs = 0;
		try {
			const ipcStart = performance.now();
			const response = await platformApi.getSessionMessagesPage({
				sessionId,
				anchor: "tail",
				limit,
			});
			ipcMs = performance.now() - ipcStart;
			if (!response.success) {
				log.warn("message page load failed", {
					sessionId,
					error: response.error,
				});
				setSessionMessages(sessionId, []);
				setSessionPageState(sessionId, response);
				return false;
			}

			const rebuildStart = performance.now();
			const messages = mergeActiveStreamingMessage(
				sessionId,
				(response.messages || []).map(rebuildContentParts),
			);
			rebuildMs = performance.now() - rebuildStart;
			const setStateStart = performance.now();
			setSessionMessages(sessionId, messages);
			setSessionPageState(sessionId, response);
			setStateMs = performance.now() - setStateStart;
			perfLog.debug("session page loaded", {
				sessionId,
				totalMs: Math.round(performance.now() - totalStart),
				ipcMs: Math.round(ipcMs),
				rebuildMs: Math.round(rebuildMs),
				setStateMs: Math.round(setStateMs),
				messages: messages.length,
				hasMoreBefore: !!response.hasMoreBefore,
				totalCount: response.totalCount,
			});
			return true;
		} catch (error) {
			log.error("initial message page load failed", { sessionId }, error);
			setSessionMessages(sessionId, []);
			return false;
		} finally {
			sessionLoading.value.set(sessionId, false);
			triggerRef(sessionLoading);
		}
	}

	async function loadOlderMessages(
		sessionId: string,
		limit = 16,
	): Promise<boolean> {
		const state = sessionMessagePages.value.get(sessionId);
		if (!state?.hasMoreBefore || !state.nextCursor || state.isLoadingOlder)
			return false;

		updateSessionPageState(sessionId, { isLoadingOlder: true });
		try {
			const response = await platformApi.getSessionMessagesPage({
				sessionId,
				cursor: state.nextCursor,
				direction: "older",
				limit,
			});
			if (!response.success) {
				log.warn("older messages load failed", {
					sessionId,
					error: response.error,
				});
				return false;
			}

			const existing = sessionMessages.value.get(sessionId) || [];
			const existingIds = new Set(existing.map((message) => message.id));
			const older = (response.messages || [])
				.map(rebuildContentParts)
				.filter((message) => !existingIds.has(message.id));

			if (older.length > 0) {
				setSessionMessages(sessionId, [...older, ...existing]);
			}
			setSessionPageState(sessionId, response);
			return older.length > 0;
		} catch (error) {
			log.error("older messages load failed", { sessionId }, error);
			return false;
		} finally {
			updateSessionPageState(sessionId, { isLoadingOlder: false });
		}
	}

	async function loadNewerMessages(
		sessionId: string,
		limit = 16,
	): Promise<boolean> {
		const state = sessionMessagePages.value.get(sessionId);
		if (!state?.hasMoreAfter || !state.backwardsCursor || state.isLoadingOlder)
			return false;

		updateSessionPageState(sessionId, { isLoadingOlder: true });
		try {
			const response = await platformApi.getSessionMessagesPage({
				sessionId,
				cursor: state.backwardsCursor,
				direction: "newer",
				limit,
			});
			if (!response.success) {
				log.warn("newer messages load failed", {
					sessionId,
					error: response.error,
				});
				return false;
			}

			const existing = sessionMessages.value.get(sessionId) || [];
			const existingIds = new Set(existing.map((message) => message.id));
			const newer = (response.messages || [])
				.map(rebuildContentParts)
				.filter((message) => !existingIds.has(message.id));

			if (newer.length > 0) {
				setSessionMessages(sessionId, [...existing, ...newer]);
			}
			setSessionPageState(sessionId, response);
			return newer.length > 0;
		} catch (error) {
			log.error("newer messages load failed", { sessionId }, error);
			return false;
		} finally {
			updateSessionPageState(sessionId, { isLoadingOlder: false });
		}
	}

	async function loadMessagesAround(
		sessionId: string,
		messageId: string,
		before = 4,
		after = 16,
	): Promise<boolean> {
		sessionLoading.value.set(sessionId, true);
		triggerRef(sessionLoading);
		try {
			const response = await platformApi.getSessionMessagesPage({
				sessionId,
				anchor: { messageId, before, after },
			});
			if (!response.success) {
				log.warn("message anchor page load failed", {
					sessionId,
					messageId,
					error: response.error,
				});
				return false;
			}

			const messages = mergeActiveStreamingMessage(
				sessionId,
				(response.messages || []).map(rebuildContentParts),
			);
			setSessionMessages(sessionId, messages);
			setSessionPageState(sessionId, response);
			return true;
		} catch (error) {
			log.error("message anchor page load failed", { sessionId, messageId }, error);
			return false;
		} finally {
			sessionLoading.value.set(sessionId, false);
			triggerRef(sessionLoading);
		}
	}

	async function loadUserMessageMarkers(
		sessionId: string,
	): Promise<UserMessageMarker[]> {
		try {
			const response: GetSessionUserMarkersResponse =
				await platformApi.getSessionUserMarkers(sessionId);
			const markers = response.success ? response.markers || [] : [];
			sessionUserMarkers.value.set(sessionId, markers);
			triggerRef(sessionUserMarkers);
			return markers;
		} catch (error) {
			log.error("user message markers load failed", { sessionId }, error);
			return [];
		}
	}

	/**
	 * Set messages for a session directly (without IPC call)
	 * Used when messages are already available (e.g., from switchSession response)
	 * This avoids duplicate IPC calls
	 */
	function setMessagesFromSession(
		sessionId: string,
		rawMessages: ChatMessage[],
	) {
		const messages = (rawMessages || []).map(rebuildContentParts);
		setSessionMessages(
			sessionId,
			mergeActiveStreamingMessage(sessionId, messages),
		);
	}

	/**
	 * Send a message (streaming mode)
	 */
	/**
	 * Send a message — emits command, events drive all state updates
	 */
	async function sendMessage(
		sessionId: string,
		content: string,
		attachments?: MessageAttachment[],
		options?: {
			source?: string;
			replyTo?: ChatMessageReplyTo;
			mentions?: ChatMessageMention[];
		},
	) {
		// What the model picker shows right now, resolved before the draft
		// materializes so it reflects what the user actually saw when they
		// hit send.
		const providerOverride = await resolveSendProviderOverride(sessionId);

		// Boundary guard: a new-chat draft id exists only in the renderer.
		// Callers normally materialize first (ChatPanel), but this is the last
		// stop before IPC — resolve here so no draft id ever reaches the main
		// process regardless of the caller.
		const sessionsStore = await draftAwareSessionsStore();
		if (sessionsStore.isNewChatDraftId(sessionId)) {
			const materialized =
				await sessionsStore.materializeNewChatDraft(sessionId);
			if (!materialized) {
				// Never drop a message silently — the restored draft gets a
				// visible error card.
				addLocalMessage(sessionId, {
					role: "error",
					content:
						"Failed to create the session — your message was not sent. Please try again.",
				});
				return false;
			}
			sessionId = materialized.id;
		}

		sessionError.value.set(sessionId, null);
		sessionErrorDetails.value.set(sessionId, null);
		triggerRef(sessionError);
		triggerRef(sessionErrorDetails);
		sessionLoading.value.set(sessionId, true);
		triggerRef(sessionLoading);

		// platformApi : 根据web或electron环境生成对应的api
		await platformApi.emitCommand(sessionId, {
			type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
			content,
			attachments,
			...providerOverride,
			...(options?.source ? { source: options.source } : {}),
			// IM quote reply (§3.5 A): a snapshot the composer built; the engine
			// persists it onto the user message it creates. Re-built as a plain
			// literal: the snapshot arrives through a ref and a reactive Proxy
			// cannot cross the IPC structured-clone boundary (真机: InputBox 整树
			// 被 "An object could not be cloned" 打崩).
			...(options?.replyTo
				? {
					replyTo: {
						messageId: String(options.replyTo.messageId),
						authorLabel: String(options.replyTo.authorLabel),
						excerpt: String(options.replyTo.excerpt),
					},
				}
				: {}),
			// Picked @mentions (W14a). Rebuilt from primitives for the same
			// reason the quote above is: these come out of composer state and a
			// reactive Proxy cannot cross the IPC structured-clone boundary.
			...(options?.mentions?.length
				? {
					mentions: options.mentions.map((mention) => ({
						agentId: String(mention.agentId),
						label: String(mention.label),
					})),
				}
				: {}),
		});
		return true;
	}

	/**
	 * Inject guidance into the active agent response.
	 * The backend persists it as a user message and processes it before the next
	 * model call, without aborting the current stream.
	 */
	async function steerMessage(sessionId: string, content: string) {
		// A draft has no session in main, hence no stream to steer; emitting
		// would strand the message in a queue keyed by an id that will never
		// run. Materializing wouldn't help either — refuse instead.
		if ((await draftAwareSessionsStore()).isNewChatDraftId(sessionId)) return false;
		await platformApi.emitCommand(sessionId, {
			type: SESSION_COMMAND_TYPES.INJECT_STEERING,
			content,
			source: "user",
		});
		return true;
	}

	/**
	 * Queue a follow-up message for after the assistant would otherwise stop.
	 */
	async function queueFollowUpMessage(sessionId: string, content: string) {
		// Same as steerMessage: no main-process session, nothing to follow up.
		if ((await draftAwareSessionsStore()).isNewChatDraftId(sessionId)) return false;
		await platformApi.emitCommand(sessionId, {
			type: SESSION_COMMAND_TYPES.INJECT_FOLLOWUP,
			content,
			source: "user",
		});
		return true;
	}

	/**
	 * Edit and resend a message — emits command
	 */
	async function editAndResend(
		sessionId: string,
		messageId: string,
		newContent: string,
	) {
		sessionError.value.set(sessionId, null);
		sessionErrorDetails.value.set(sessionId, null);
		triggerRef(sessionError);
		triggerRef(sessionErrorDetails);
		sessionLoading.value.set(sessionId, true);
		triggerRef(sessionLoading);

		const providerOverride = await resolveSendProviderOverride(sessionId);
		await platformApi.emitCommand(sessionId, {
			type: SESSION_COMMAND_TYPES.EDIT_AND_RESEND,
			messageId,
			newContent,
			...providerOverride,
		});
		return true;
	}

	/**
	 * Regenerate from a message — emits retry command
	 */
	async function regenerate(sessionId: string, messageId: string) {
		const messages = getSessionMessagesRef(sessionId);
		const message = messages.find((m) => m.id === messageId);
		if (!message) return false;

		if (message.role === "assistant") {
			sessionLoading.value.set(sessionId, true);
			triggerRef(sessionLoading);

			const providerOverride = await resolveSendProviderOverride(sessionId);
			await platformApi.emitCommand(sessionId, {
				type: SESSION_COMMAND_TYPES.RETRY_MESSAGE,
				messageId,
				...providerOverride,
			});
			return true;
		}

		// For user messages, use edit-and-resend with same content
		return await editAndResend(
			sessionId,
			messageId,
			rawTextFromPromptParts(message.content, message.contentParts),
		);
	}

	/**
	 * Stop generation for a session
	 */
	async function stopGeneration(sessionId?: string) {
		try {
			const activeMessageIds = new Map(activeStreams.value);
			const response = await platformApi.abortStream(sessionId);
			if (response.success) {
				const targetSessionIds = sessionId
					? [sessionId]
					: Array.from(
							new Set([
								...activeMessageIds.keys(),
								...activeStreams.value.keys(),
							]),
						);

				for (const targetSessionId of targetSessionIds) {
					finalizeStoppedStreamLocally(
						targetSessionId,
						activeMessageIds.get(targetSessionId) ||
							activeStreams.value.get(targetSessionId),
					);
				}

				// Clear states
				for (const targetSessionId of targetSessionIds) {
					sessionGenerating.value.set(targetSessionId, false);
					sessionLoading.value.set(targetSessionId, false);
					activeStreams.value.delete(targetSessionId);
					clearPendingStreamChunks(targetSessionId);
					clearPendingContinuationWait(targetSessionId);
					clearToolInputDeltas(targetSessionId);
				}
				triggerRef(sessionGenerating);
				triggerRef(sessionLoading);
				triggerRef(activeStreams);
			}
			return response.success;
		} catch (error) {
			log.error("stop generation failed", { sessionId }, error);
			return false;
		}
	}

	/**
	 * Update a message in a session
	 */
	function updateSessionMessage(
		sessionId: string,
		messageId: string,
		updates: Partial<ChatMessage>,
	) {
		const messages = getSessionMessagesRef(sessionId);
		const messageIndex = messages.findIndex((m) => m.id === messageId);
		if (messageIndex !== -1) {
			const merged = { ...messages[messageIndex], ...updates };
			// A message that just finished streaming must not keep a transient
			// waiting/loading indicator. This covers the case where a continuation's
			// early waiting was emitted on a turn message that then gets finalized
			// (e.g. when context compaction starts a fresh assistant message).
			if (updates.isStreaming === false) {
				if (merged.contentParts) {
					const cleaned = [...merged.contentParts];
					if (removeTransientIndicators(cleaned)) merged.contentParts = cleaned;
				}
				clearPendingContinuationWait(sessionId, messageId);
			}
			messages[messageIndex] = merged;
			setSessionMessages(sessionId, [...messages]);
		}
	}

	/**
	 * Clear error for a session
	 */
	function clearSessionError(sessionId: string) {
		sessionError.value.set(sessionId, null);
		sessionErrorDetails.value.set(sessionId, null);
		triggerRef(sessionError);
		triggerRef(sessionErrorDetails);
	}

	/**
	 * Clear all messages for a session
	 */
	function clearSessionMessages(sessionId: string) {
		sessionMessages.value.set(sessionId, []);
		sessionSnapshots.delete(sessionId);
		clearPendingContinuationWait(sessionId);
		triggerRef(sessionMessages);
	}

	function setSessionLoading(sessionId: string, loading: boolean) {
		sessionLoading.value.set(sessionId, loading);
		triggerRef(sessionLoading);
	}

	/**
	 * Add a local-only message (not saved to backend)
	 * Used for system messages like /files command output
	 */
	function addLocalMessage(
		sessionId: string,
		message: { role: "system" | "error"; content: string },
	) {
		const messages = getSessionMessagesRef(sessionId);
		const localMessage: ChatMessage = {
			id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			sessionId, // Include sessionId for context isolation
			role: message.role,
			content: message.content,
			timestamp: Date.now(),
		};
		messages.push(localMessage);
		setSessionMessages(sessionId, [...messages]);
	}

	/**
	 * Add a message to Vue state (for immediate display after backend persistence)
	 */
	function addMessageToState(sessionId: string, message: ChatMessage) {
		const messages = getSessionMessagesRef(sessionId);
		messages.push(message);
		setSessionMessages(sessionId, [...messages]);
	}

	/**
	 * Remove a message from Vue state by ID
	 */
	function removeMessage(sessionId: string, messageId: string) {
		const messages = getSessionMessagesRef(sessionId);
		const index = messages.findIndex((m) => m.id === messageId);
		if (index !== -1) {
			messages.splice(index, 1);
			setSessionMessages(sessionId, [...messages]);
		}
	}

	// ── Event-driven message handlers (called by IPC Hub) ──

	/**
	 * Handle message:user-created event — add user message from main process
	 */
	function handleMessageCreated(data: {
		sessionId: string;
		message: ChatMessage;
	}) {
		const { sessionId, message } = data;
		const messages = getSessionMessagesRef(sessionId);
		messages.push(rebuildContentParts(message));
		setSessionMessages(sessionId, [...messages]);
		sessionLoading.value.set(sessionId, false);
		triggerRef(sessionLoading);
		bumpScrollVersion(sessionId);
	}

	/**
	 * Handle message:assistant-created event — add streaming assistant message
	 */
	function handleAssistantCreated(data: {
		sessionId: string;
		message: ChatMessage;
	}) {
		const { sessionId, message } = data;
		const messages = getSessionMessagesRef(sessionId);
		const assistantMessage: ChatMessage = {
			...message,
			isStreaming: true,
			contentParts: message.contentParts || [],
			thinkingStartTime: message.reasoning
				? message.thinkingStartTime
				: undefined,
		};
		messages.push(assistantMessage);
		setSessionMessages(sessionId, [...messages]);

		activeStreams.value.set(sessionId, message.id);
		sessionGenerating.value.set(sessionId, true);
		sessionLoading.value.set(sessionId, false);
		triggerRef(activeStreams);
		triggerRef(sessionGenerating);
		triggerRef(sessionLoading);
		bumpScrollVersion(sessionId);
		flushPendingStreamChunks(sessionId, message.id);
	}

	/**
	 * Handle stream:start event — establish active assistant id as early as possible.
	 */
	function handleStreamStarted(data: { sessionId: string; messageId: string }) {
		const { sessionId, messageId } = data;
		if (!sessionId || !messageId) return;

		activeStreams.value.set(sessionId, messageId);
		sessionGenerating.value.set(sessionId, true);
		triggerRef(activeStreams);
		triggerRef(sessionGenerating);
		generationStats.set(sessionId, {
			startedAt: Date.now(),
			receivedChars: 0,
			estimatedSinceUsage: 0,
			exactOutputTokens: null,
			inputTokens: null,
			phase: null,
			phaseSince: Date.now(),
		});
		flushPendingStreamChunks(sessionId, messageId);
	}

	/** stream:usage — a model turn finished; snap the readout to real numbers. */
	function handleStreamUsage(data: {
		sessionId: string;
		usage: { inputTokens: number; outputTokens: number };
		accumulated: { inputTokens: number; outputTokens: number };
	}) {
		const stats = generationStats.get(data.sessionId);
		if (!stats) return;
		stats.exactOutputTokens = data.accumulated.outputTokens;
		stats.estimatedSinceUsage = 0;
		stats.inputTokens = data.usage.inputTokens;
	}

	/** Track streamed characters for the estimate (called from handleStreamChunk). */
	function noteGenerationChars(sessionId: string, text: string | undefined) {
		if (!text) return;
		const stats = generationStats.get(sessionId);
		if (!stats) return;
		stats.receivedChars += text.length;
		stats.estimatedSinceUsage += estimateTokens(text);
	}

	/**
	 * Snapshot of what the session's stream is doing right now, for the
	 * composer's status readout. Null when nothing is generating.
	 */
	function getGenerationStatus(sessionId: string): GenerationStatus | null {
		const stats = generationStats.get(sessionId);
		if (!stats || !isSessionGenerating(sessionId)) return null;
		const messageId = activeStreams.value.get(sessionId);
		const message = messageId
			? getSessionMessagesRef(sessionId).find((m) => m.id === messageId)
			: undefined;
		const derived = message ? derivePhase(message) : { phase: "waiting" as const };
		if (derived.phase !== stats.phase) {
			stats.phase = derived.phase;
			stats.phaseSince = Date.now();
		}
		return {
			phase: derived.phase,
			phaseSince: stats.phaseSince,
			startedAt: stats.startedAt,
			...(derived.toolName ? { toolName: derived.toolName } : {}),
			outputTokens: Math.round((stats.exactOutputTokens ?? 0) + stats.estimatedSinceUsage),
			outputTokensExact: stats.exactOutputTokens !== null && stats.estimatedSinceUsage === 0,
			inputTokens: stats.inputTokens,
		};
	}

	/**
	 * Handle message:deleted event — remove message from UI
	 */
	function handleMessageDeleted(data: {
		sessionId: string;
		messageId: string;
	}) {
		removeMessage(data.sessionId, data.messageId);
	}

	/**
	 * Handle steering:queued — mark a persisted steer message as retractable.
	 */
	function handleSteeringQueued(data: { sessionId: string; messageId: string }) {
		pendingSteeringByMessageId.value.set(data.messageId, data.sessionId);
		triggerRef(pendingSteeringByMessageId);
	}

	/**
	 * Handle steering:consumed / steering:retracted — the messages are no
	 * longer pending (drained into a turn, or withdrawn).
	 */
	function handleSteeringConsumed(data: {
		sessionId: string;
		messageIds: string[];
	}) {
		let changed = false;
		for (const messageId of data.messageIds) {
			if (pendingSteeringByMessageId.value.delete(messageId)) changed = true;
		}
		if (changed) triggerRef(pendingSteeringByMessageId);
	}

	function isSteeringPending(messageId: string): boolean {
		return pendingSteeringByMessageId.value.has(messageId);
	}

	/**
	 * Retract a queued steering message before the next loop turn consumes
	 * it. The engine deletes the persisted user message and broadcasts
	 * message:deleted; if the turn already drained it, nothing happens.
	 */
	async function retractSteerMessage(messageId: string) {
		const sessionId = pendingSteeringByMessageId.value.get(messageId);
		if (!sessionId) return false;
		await platformApi.emitCommand(sessionId, {
			type: SESSION_COMMAND_TYPES.RETRACT_STEERING,
			messageId,
		});
		return true;
	}

	/**
	 * Handle messages:replaced event — replace entire message list (edit-and-resend truncation)
	 */
	function handleMessagesReplaced(data: {
		sessionId: string;
		messages: ChatMessage[];
	}) {
		const { sessionId, messages } = data;
		const rebuilt = messages.map(rebuildContentParts);
		setSessionMessages(sessionId, rebuilt);
		bumpScrollVersion(sessionId);
	}

	/**
	 * Handle session:renamed event — update session name in sessions store
	 */
	async function handleSessionRenamed(data: {
		sessionId: string;
		name: string;
	}) {
		try {
			const { useSessionsStore } = await import("./sessions");
			const sessionsStore = useSessionsStore();
			sessionsStore.updateSessionNameAnimated(data.sessionId, data.name);
		} catch (e) {
			log.error("session name update failed", { sessionId: data.sessionId }, e);
		}
	}

	/**
	 * Handle a permission:request event from EventBus (via IPC Hub).
	 *
	 * Updates the matching tool call and step in the session's messages
	 * to show the permission confirmation UI.
	 */
	function handlePermissionRequest(data: PermissionRequestData) {
		applyPermissionRequest(data);
	}

	/**
	 * A tool's ask is waiting behind another prompt in the session's serialized
	 * permission queue: show a waiting state (no respond card yet).
	 */
	function handlePermissionQueued(data: {
		sessionId: string;
		requestId: string;
		messageId: string;
		toolCallId: string;
	}) {
		const messages = getSessionMessagesRef(data.sessionId);
		const message =
			messages.find((m) => m.id === data.messageId) ??
			messages.find((m) =>
				m.toolCalls?.some((tc) => tc.id === data.toolCallId),
			);
		const toolCall = message?.toolCalls?.find(
			(tc) => tc.id === data.toolCallId,
		);
		if (!message || !toolCall) return;

		toolCall.permissionQueued = true;
		const step = message.steps?.find((s) => s.toolCallId === toolCall.id);
		if (step && step.status !== "awaiting-confirmation") {
			step.status = "awaiting-confirmation";
			if (message.steps) {
				message.steps = [...message.steps];
			}
		}
		// 同 applyPermissionRequest:换数组身份,否则等待态传不到卡片那一层。
		setSessionMessages(data.sessionId, [...messages]);
	}

	/**
	 * A pending ask settled (locally, remotely, or via grant auto-resolve):
	 * clear cards/waiting states for the head and all coalesced followers.
	 */
	function handlePermissionSettled(data: {
		sessionId: string;
		requestId: string;
		toolCallIds: string[];
		decision: "allowed" | "rejected";
	}) {
		const messages = getSessionMessagesRef(data.sessionId);
		let changed = false;
		for (const message of messages) {
			let stepsChanged = false;
			for (const toolCallId of data.toolCallIds) {
				const toolCall = message.toolCalls?.find(
					(tc) => tc.id === toolCallId,
				);
				if (!toolCall) continue;
				if (!toolCall.permissionQueued && !toolCall.requiresConfirmation)
					continue;

				toolCall.permissionQueued = false;
				toolCall.requiresConfirmation = false;
				toolCall.canRespond = false;
				if (toolCall.permissionId === data.requestId) {
					toolCall.permissionId = undefined;
				}
				if (data.decision === "allowed" && toolCall.status === "pending") {
					toolCall.status = "executing";
				}
				const step = message.steps?.find(
					(s) => s.toolCallId === toolCallId,
				);
				if (step && step.status === "awaiting-confirmation") {
					// Rejected asks are finalized by the failed tool result that
					// follows immediately; only flip the allowed path back to running.
					if (data.decision === "allowed") {
						step.status = "running";
					}
					stepsChanged = true;
				}
				changed = true;
			}
			if (stepsChanged && message.steps) {
				message.steps = [...message.steps];
			}
		}
		// 同 applyPermissionRequest:换数组身份,否则卡片撤不掉(会一直举着手)。
		if (changed) setSessionMessages(data.sessionId, [...messages]);
	}

	/**
	 * 把「这个会话此刻还欠哪些审批」的一份**全量账**投影到消息上(架构收敛 C4 §5)。
	 *
	 * 唯一的调用方是 collabBoard 里的待审批账本 —— 那本账的内容永远来自
	 * `getPendingPermissions` 反查,所以这里收到的 `pending` 是真值而不是增量。
	 * 从前这件事有两条路:ipc-hub 按事件一条条 ± 地改这些标志位,MessageList
	 * 切会话时又自己直查一遍、自己决定 queued 走哪个 handler。两条路对同一批
	 * 标志位各写各的,谁后到谁说了算。
	 *
	 * 投影是 (账本 × 当前消息) 的纯函数,**不留上一份快照**:哪些卡该消失,是拿
	 * 屏幕上还举着手的 toolCall 去对账本,而不是拿这次快照去减上次快照 —— 后者
	 * 就是又一本账,而这次收敛要的正是"只剩一本"。
	 *
	 * 消息还没加载的会话直接跳过:此刻它没有可投影的载体,而 `handlePermissionQueued`
	 * 在找不到 toolCall 时是**丢弃**而不是缓存的(与 request 不同)。等消息到了,
	 * 搬它上屏的那一方会再 ensure 一次。
	 */
	function applyPendingPermissionSnapshot(
		sessionId: string,
		pending: PermissionInfo[],
	): void {
		const messages = getSessionMessagesRef(sessionId);
		if (!messages.length) return;

		// 1) 账本里没有的,屏幕上就不该还举着手。settle 事件走的是同一个收尾
		//    函数,所以这一步对已经收干净的卡是空操作(它自己会跳过)。
		const live = new Set(
			pending
				.map((info) => info.callId)
				.filter((callId): callId is string => Boolean(callId)),
		);
		for (const message of messages) {
			for (const toolCall of message.toolCalls ?? []) {
				if (!toolCall.requiresConfirmation && !toolCall.permissionQueued)
					continue;
				if (live.has(toolCall.id)) continue;
				handlePermissionSettled({
					sessionId,
					requestId: toolCall.permissionId ?? "",
					toolCallIds: [toolCall.id],
					// 反查只答得出"还欠不欠",答不出"上次是批还是拒" —— 而 'allowed'
					// 会把 pending 推成 executing。推不出来的事就不要瞎猜:按拒绝口径
					// 收尾只撤掉卡片,状态留给随后的工具结果去写。
					decision: "rejected",
				});
			}
		}

		// 2) 账本里有的,照原样贴上去。queued(排在队头后面的、以及被合并的跟随
		//    调用)只给等待态,不给可按的卡 —— 与事件路同一条规矩。
		for (const info of pending) {
			if (info.promptState === "queued") {
				if (info.callId) {
					handlePermissionQueued({
						sessionId: info.sessionId || sessionId,
						requestId: info.id,
						messageId: info.messageId,
						toolCallId: info.callId,
					});
				}
				continue;
			}
			handlePermissionRequest({
				sessionId: info.sessionId || sessionId,
				requestId: info.id,
				messageId: info.messageId,
				callId: info.callId,
				permissionType: info.type,
				title: info.title,
				pattern: info.pattern,
				metadata: info.metadata,
				canRespond: (info.targetChannel || "ipc") === "ipc",
			});
		}
	}

	/**
	 * 房间消息的表情回应(架构收敛 C4 §4:写路径收进 store)。
	 *
	 * **回填约定 = `message:updated` 广播**:这里一个字都不乐观写,主进程落盘后
	 * 播一条 `message:updated`,ipc-hub 交给 `updateSessionMessage` 合并,chips
	 * 显示的永远是真正落了盘的东西。因此一次被拒的写在结构上是"看不见"的 ——
	 * 调用方拿到 `success: false` 之后得自己说一句,不然按了等于没按。
	 *
	 * 过桥的每个参数都取原始值:响应式代理过不了结构化克隆(W7 血教训)。
	 * 失败不吞:桥抛错就让它抛到调用方,由 UI 决定怎么显示。
	 */
	function reactToCollabMessage(
		sessionId: string,
		messageId: string,
		emoji: string,
		actor: ChatMessageReactionActor,
	) {
		// `actor` 一路带到 wire 上,但**主进程刻意无视它**并把归属钉死成用户
		// (表情是归属:一位沉默成员的 emoji 就是它的回答)。参数留着是因为调用点
		// 读起来该说清"这一下是谁按的",而不是因为它能决定什么。
		return collabApi.messageReact({
			roomSessionId: String(sessionId),
			messageId: String(messageId),
			emoji: String(emoji),
			// 从原始值重建:响应式代理过不了结构化克隆(W7 血教训)。
			actor: {
				type: String(actor?.type) as "user" | "agent",
				...(actor?.agentId ? { agentId: String(actor.agentId) } : {}),
			},
		});
	}

	return {
		// Per-session state maps
		sessionMessages,
		sessionMessagePages,
		sessionUserMarkers,
		sessionLoading,
		sessionGenerating,
		sessionError,
		sessionErrorDetails,
		activeStreams,
		compactingSessions,
		compactProgress,
		composerDrafts,

		// Getters
		getSessionState,
		isSessionGenerating,
		isSessionCompacting,
		setSessionCompacting,
		getSessionCompactProgress,
		setSessionCompactProgress,
		getSessionPageState,
		// 纯追加的出口:向上补页会把"向下那一边"的分页账写坏(存储层对更旧那一页
		// 一律答 hasMoreAfter:true),房面补完页要把那两栏原样还回去。store 内部
		// 逻辑一个字没改,旧壳也没有第二个调用方 —— classic 行为不变。
		updateSessionPageState,

		// UI State (per-session)
		isToolCallExpanded,
		toggleToolCall,
		collapseAllToolCalls,
		sessionCollapsedRoomGroups,
		isRoomGroupCollapsed,
		toggleRoomGroupCollapsed,
		expandRoomGroup,

		// Scroll trigger per session (incremented every handleStreamChunk for O(1) auto-scroll watcher)
		getScrollVersion,

		// Event handlers (called by IPC Hub)
		handleStreamChunk,
		handleStreamStarted,
		handleStreamComplete,
		handleStreamError,
		handleStepAdded,
		handleStepUpdated,
		handleToolExecutionStart,
		handleToolExecutionUpdate,
		handleToolExecutionEnd,
		handleSkillActivated,
		handlePermissionRequest,
		handlePermissionQueued,
		handlePermissionSettled,
		applyPendingPermissionSnapshot,
		reactToCollabMessage,
		handleMessageCreated,
		handleAssistantCreated,
		handleMessageDeleted,
		handleMessagesReplaced,
		handleSessionRenamed,
		handleRequestSnapshot,
		handleSteeringQueued,
		handleSteeringConsumed,

		// Inspector — request snapshots ring buffer
		getRequestSnapshots,
		clearRequestSnapshots,

		// Actions
		loadMessages,
		loadInitialMessagePage,
		loadOlderMessages,
		loadNewerMessages,
		loadMessagesAround,
		loadUserMessageMarkers,
		setMessagesFromSession,
		setSessionLoading,
		sendMessage,
		steerMessage,
		retractSteerMessage,
		handleStreamUsage,
		getGenerationStatus,
		isSteeringPending,
		pendingSteeringByMessageId,
		queueFollowUpMessage,
		editAndResend,
		regenerate,
		stopGeneration,
		updateSessionMessage,
		clearSessionError,
		clearSessionMessages,
		setComposerDraft,
		getComposerDraft,
		clearComposerDraft,
		isComposerDraftEmpty,
		addLocalMessage,
		addMessageToState,
		removeMessage,

		// Session UI snapshots
		saveSnapshot,
		getSnapshot,
		deleteSnapshot,

		inspectorOpen,
	};
});
