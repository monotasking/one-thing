import * as store from "../../../store.js";
import { sessionCommands } from "../../../session/commands.js";
import { sessionReads } from "../../../session/reads.js";
import {
	endSessionRun,
	ensureSessionRun,
	markSessionRunOutcome,
	rotateSessionRun,
} from "../../../session/runs.js";
import {
	IPC_CHANNELS,
	type ContentPart,
	type Step,
	type ToolCall,
	type ToolResult,
} from "@shared/ipc.js";
import { getEventBus } from "../../../events/index.js";
import { createEventOnlyEmitter } from "../../../events/event-only-emitter.js";
import {
	isUiEventStreamEnabled,
	pushSessionUiStreamEvent,
} from "../../../events/ui-stream.js";
import type {
	UiAssistantDeltaChunk,
	UiAssistantPartEndChunk,
} from "@onething/core/events";
import {
	streamAgentLoopProviderChunks,
	type AgentProviderStreamChunk,
} from "@onething/core/agent-loop";
import type { HistoryMessage } from "./message-helpers.js";
import type { StreamContext, StreamProcessor } from "./stream-processor.js";
import { createStreamProcessor, resolveToolIdentity } from "./stream-processor.js";
import type { IPCEmitter } from "@onething/runtime/engine/ipc-emitter.wiring";
import {
	buildAgentLoopRuntimeFromStreamContext,
	type BuildAgentLoopStreamRuntimeResult,
} from "./agent-loop-runtime.js";
import { createSessionCredentialRotator } from "../../providers/credential-rotation.js";
import { checkSessionHistoryShadowForRequest } from "./history-shadow.js";
import { resolveAgentProfileForSession } from "../../agents/profile.js";
import { saveMediaImage } from "@onething/runtime/media/save-image";
import { applyOnethingAgentLoopProviderData } from "@onething/runtime/agent-loop/providers";
import type { ApplyOnethingAgentLoopProviderDataOptions } from "@onething/runtime/agent-loop/providers/provider-data";
import { updateSessionUsage } from "../../../session/usage.js";
import { recordUsage } from "../../usage/index.js";
import { triggerManager } from "../triggers/index.js";
import { runAfterAssistantResponseHooks } from "@onething/runtime/plugins/lifecycle.wiring";
import type { ChatMessage, ChatSession } from "@shared/ipc.js";
import {
	applyAgentLoopStreamChunkWithAdapters as coreApplyAgentLoopStreamChunkWithAdapters,
	completeAgentLoopStreamWithAdapters,
	createCoreId,
	createAgentLoopExecutorTurnState,
	createAgentLoopNextAssistantWriterPlan,
	emitAgentLoopFinalMessageUpdateWithAdapters,
	executeAgentLoopStreamLifecycleWithAdapters,
	type ExecuteAgentLoopStreamLifecycleWithAdaptersOptions,
	lastUserMessageText,
	persistAgentLoopTurnContentPartsWithAdapters,
	runAgentLoopPostResponseHooksWithAdapters, type CoreAgentLoopContentPartStore, type CoreAgentLoopToolExecutionStore, type CompleteAgentLoopStreamWithAdaptersOptions, type EmitAgentLoopFinalMessageUpdateWithAdaptersOptions,
} from "@onething/core/engine";
import type {
	CorePromptCapture,
	CoreEvalRawRequest,
	CoreEvalRawResponse,
	CoreRequestMessage,
} from "@onething/core/engine";
import type { AgentJsonObject } from "@onething/core/agent-loop";
import { hashSections } from "@onething/runtime";
import {
	attachSessionEventRecorder,
	type SessionCancelledToolResult,
	type SessionEventRecorder,
} from "./session-event-recorder.js";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import { consolePort, getLogger } from '../../logging/index.js'
import type { JsonObject } from '@onething/core'
import type { AppSettings } from '@shared/ipc.js'
import type { StreamProviderConfig } from './stream-processor.js'
import type { RunAgentLoopPostResponseHooksWithAdaptersOptions, ApplyAgentLoopStreamChunkWithAdaptersOptions } from '@onething/core/engine'

const log = getLogger('engine.stream')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


/** Strip non-serializable values via JSON round-trip. Survives circular refs. */
function safeClone<T>(value: T): T {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

/** Collab (room/work/agent) sessions skip builtin post-response lanes — see
 *  call site. 'agent' is where a room turn runs since W18: same turn, same
 *  exemption (a group-chat reply must not trigger memory/TOC side lanes). */
function isCollabSession(sessionId: string): boolean {
	const kind = store.getSession(sessionId)?.kind;
	return kind === "room" || kind === "work" || kind === "agent";
}


export interface AgentLoopExecutorTurnState {
	toolCalls: ToolCall[];
	content: { value: string };
	reasoning: { value: string };
	orderedParts: ContentPart[];
	hasSentToolParts: boolean;
}

export interface AgentLoopExecutorState {
	ctx: StreamContext;
	processor: StreamProcessor;
	emitter: IPCEmitter;
	turnIndex: number;
	turn: AgentLoopExecutorTurnState;
	stepIdsByToolCallId: Map<string, string>;
	accumulatedUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		durationMs?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	};
	lastTurnUsage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	};
	toolIterations: number;
	skillManageCalled: boolean;
	latestUserPrompt?: string;
	createNewAssistantOnNextTurnStart?: boolean;
	/**
	 * S1a:本次执行的事件记录器。挂在 state 上而不是闭包里,因为**错误与收尾**
	 * 两条路(`updateMessageError` / `sendStreamError` / abort)不经过
	 * `onEvent`,而"请求最终失败"与"最后一批 delta"正是要在那两条路上落账的。
	 */
	eventRecorder?: SessionEventRecorder;
	/**
	 * U0(§10.15):采集点当前盖的**助手消息号**。
	 *
	 * 与 `ctx.assistantMessageId` 分开是这条修复的全部内容:身份在 agent-loop 发
	 * boundary 的同步点就换掉(这一格),而处理器 / 发射器那一套要等上一条消息
	 * `finalize()` 之后才换(那一格)。缺省不设 = 两者同一个值。
	 */
	recordingAssistantMessageId?: string;
	/** U0:同步点已经定好、消费侧还没接手的那次换锚点。 */
	pendingAssistantRotation?: {
		assistantMessageId: string;
		plan: ReturnType<
			typeof createAgentLoopNextAssistantWriterPlan<ToolCall, ContentPart>
		>;
		releaseShadow: () => void;
		/**
		 * §15.15:上一条助手消息的收尾(`finalize()` + `isStreaming:false`)是不是
		 * **已经被压缩重建那条路提前跑掉了**。提前跑过就不再跑第二遍 —— 换身份
		 * 那一半仍然留在消费侧,时序与语义一字不动。
		 */
		finished?: boolean;
	};
}

export interface AgentLoopStreamGenerationResult {
	pausedForConfirmation: boolean;
}

export interface ExecuteAgentLoopStreamGenerationOptions {
	initialContent?: {
		content?: string;
		reasoning?: string;
	};
}

function createTurnState(): AgentLoopExecutorTurnState {
	return createAgentLoopExecutorTurnState<ToolCall, ContentPart>();
}

function persistTurnContentParts(state: AgentLoopExecutorState): void {
	const storePort: CoreAgentLoopContentPartStore<ContentPart> = {
		addMessageContentPart: store.addMessageContentPart,
	};
	persistAgentLoopTurnContentPartsWithAdapters({
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		turn: state.turn,
		turnIndex: state.turnIndex,
		store: storePort,
		emitter: state.emitter,
	});
}

async function finishCurrentAssistantWriter(
	state: AgentLoopExecutorState,
): Promise<void> {
	await state.processor.finalize();
	try {
		await getEventBus().emit(state.ctx.sessionId, {
			type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
			messageId: state.ctx.assistantMessageId,
			updates: { isStreaming: false },
		});
	} catch {
		// Event system may not be initialized in tests.
	}
}

/**
 * U0(§10.15 的根治):**换锚点的同步那一半**。
 *
 * 从前整件事都发生在 `createNextAssistantWriter` 里 —— 而那是 chunk 消费侧,
 * 隔着 agent-loop 的异步事件队列。采集点挂在 `onEvent` 上是同步的,于是
 * boundary 之后的 `turn-start` / 第一批 delta 常常在换锚点之前就落了账:
 * 新响应的开头被记在**上一条**助手消息、上一条 run 上(电池 1/5 复现)。
 *
 * 事实(boundary)生在 agent-loop,身份就该在那一刻定。这个函数只做"定身份"
 * 那一半,并且**全同步**:建消息、换 run、把 runId 盖回消息。
 * 换处理器 / 换发射器 / 换 turn state 那一半仍然留在消费侧 —— 它必须排在上一条
 * 消息 `finalize()` 之后,而那是个 await。
 */
function rotateAssistantWriterIdentity(state: AgentLoopExecutorState): void {
	if (state.pendingAssistantRotation) return;

	const assistantMessageId = createCoreId();
	const now = Date.now();
	const plan = createAgentLoopNextAssistantWriterPlan<ToolCall, ContentPart>({
		id: assistantMessageId,
		model: state.ctx.providerConfig.model,
		provider: state.ctx.providerId,
		timestamp: now,
		thinkingStartTime: now,
	});
	const assistantMessage: ChatMessage = plan.assistantMessage;

	// S1a:steering 的 response-boundary = **两次执行**。旧的按 completed 收尾,
	// 新的以 kind:'steer' 开张 —— 一条 assistant 消息一个 run 是投影的前提
	// (`run/start` 就是那条消息在 surface 上的那一格)。
	//
	// **F4-a(§16.12):入库那一条由 `addMessage` 直接交回来。** 这处是
	// `stream-executor.ts` 那处取材点在 steer 那条路上的**孪生**,两处一起摘掉了
	// 回读:这次要写的 `run/start` 就是这条占位消息的产地,而"入库的它长什么样"
	// 现在是写入那扇门自己的返回值 —— 盖章(`stampCollabAgentId`,COW)已经在
	// 那一刻发生过,所以 `plan` 里那条与这一条不是同一个对象,要用的是这一条。
	const storedAssistantMessage = store.addMessage(
		state.ctx.sessionId,
		assistantMessage,
	);
	// 影子的闸:旧 run 现在收得比引擎写完上一条消息**早**,所以比对要等一下
	// (见 `EndSessionRunInput.shadowGate`)。开闸的两处 = 消费侧接手完成、
	// 以及执行收尾的 finally(闸永远不开就等于这条 run 不比)。
	let releaseShadow: () => void = () => {};
	const shadowGate = new Promise<void>((resolve) => {
		releaseShadow = resolve;
	});
	const rotated = rotateSessionRun(
		state.ctx.sessionId,
		{
			kind: "steer",
			assistantMessageId,
			provider: state.ctx.providerId,
			model: state.ctx.providerConfig.model,
			timestamp: now,
			...(storedAssistantMessage?.agentId
				? { agentId: storedAssistantMessage.agentId }
				: {}),
			// §13.9:与 agentId 同一刻盖的那格 `source`(collab 回合思考记录标记)。
			...(storedAssistantMessage?.source
				? { messageSource: storedAssistantMessage.source }
				: {}),
		},
		{ shadowGate },
	);
	sessionCommands.patchMessage(state.ctx.sessionId, {
		messageId: assistantMessageId,
		patch: { runId: rotated.runId },
		hint: "settle",
	});
	// 采集点从这一刻起盖新号(`getMessageId()` 读的就是这一格)。
	state.recordingAssistantMessageId = assistantMessageId;
	state.pendingAssistantRotation = {
		assistantMessageId,
		plan,
		releaseShadow,
	};
}

/**
 * §15.15:**压缩重建必须看到收尾之后的 store。**
 *
 * 换锚点的同步那一半(`rotateAssistantWriterIdentity`)在 agent-loop 发 boundary
 * 的那一刻就跑完,而收尾那一半要等消费侧的下一个 `turn-start`
 * (`createNewAssistantOnNextTurnStart` → `createNextAssistantWriter`)。麻烦在于
 * afterTurn 发的 boundary 之后,**下一轮的 `beforeTurn` 排在那个 turn-start 之前**:
 * 若这一轮恰好判成 `finalPlan.kind === 'rebuild'`,`rebuildAgentMessagesFromSession`
 * 就会在上一条 assistant 还挂着 `isStreaming: true` 的时候去读 store,而
 * `buildHistoryMessages` 见 `isStreaming` 整条跳过(`core/engine/history.ts`
 * :753/:812)—— 重建出来的历史**真的少一整轮**,模型看不见上一条回复。
 * 这不是账记歪,是发出去的请求少了东西。
 *
 * 所以在读 store 之前把收尾这一半提前跑掉。**只提前收尾,不提前换身份**:
 * `pendingAssistantRotation` 原样留着,于是"两次 boundary 挤在一个 turn-start 前面
 * 会折叠成一条新消息"这条既有语义(`rotateAssistantWriterIdentity` 的早退)一字未动,
 * 消费侧仍然在原来的那一格接手。此刻队列里不会有还没消费的正文 chunk:boundary 是
 * 同步推进队列的,而 `beforeTurn` 的第一个 await 就已经把消费侧放过去了 ——
 * 提前的只是"什么时候写 `isStreaming:false`",不是"写进去的是什么"。
 */
async function settlePendingAssistantWriterBeforeStoreRead(
	state: AgentLoopExecutorState,
): Promise<void> {
	const pending = state.pendingAssistantRotation;
	if (!pending || pending.finished) return;
	pending.finished = true;
	await finishCurrentAssistantWriter(state);
	// 上一条消息写完了 —— 它的影子这才有得比(与消费侧那一处同一条理由)。
	pending.releaseShadow();
}

async function createNextAssistantWriter(
	state: AgentLoopExecutorState,
): Promise<void> {
	// 没人在同步点换过(采集点没挂上 / 单测直喂 chunk)= 这里补一次,行为与
	// U0 之前逐字相同。
	rotateAssistantWriterIdentity(state);
	const pending = state.pendingAssistantRotation;
	state.pendingAssistantRotation = undefined;
	if (!pending) return;

	// §15.15:压缩重建那条路可能已经把收尾跑掉了(只跑一次:`finalize()` 幂等,
	// 但那条 `isStreaming:false` 广播不该发两遍)。
	if (!pending.finished) {
		await finishCurrentAssistantWriter(state);
		// 上一条消息写完了 —— 它的影子这才有得比。
		pending.releaseShadow();
	}

	state.ctx.assistantMessageId = pending.assistantMessageId;
	state.processor = createStreamProcessor(state.ctx);
	state.emitter = createEventOnlyEmitter(state.ctx);
	state.turn = createTurnState();
	state.stepIdsByToolCallId.clear();

	try {
		const eventBus = getEventBus();
		for (const event of pending.plan.events) {
			await eventBus.emit(state.ctx.sessionId, event);
		}
	} catch {
		// Event system may not be initialized in tests.
	}
}

export function runAgentLoopPostResponseHooks(options: {
	state: AgentLoopExecutorState;
	prepared: Extract<BuildAgentLoopStreamRuntimeResult, { supported: true }>;
	historyMessages: HistoryMessage[];
}): void {
	// Build promptCapture from prepared data for eval snapshot/attribution
	const sections = options.prepared.sections ?? [];

	// Serialize request messages (capability-transformed view) for .context.jsonl
	const requestMessages: CoreRequestMessage[] | undefined =
		options.prepared.runtime?.messages
			?.filter((m): m is NonNullable<typeof m> => m != null)
			.map((m) => ({
				role: m.role,
				content: m.content,
				reasoningContent: m.reasoningContent,
				toolCalls: m.toolCalls?.map((tc) => ({
					toolCallId: tc.id,
					toolName: tc.name,
					args: tc.arguments,
				})),
				toolCallId: m.toolCallId,
			}));

	const promptCapture: CorePromptCapture | undefined =
		sections.length > 0
			? {
					systemPrompt: options.prepared.systemPrompt,
					sections,
					sectionHashes: hashSections(sections).sectionHashes,
					...(requestMessages ? { requestMessages } : {}),
					// Capture API-level request body for .request.json
					// Safe-serialize via JSON round-trip to strip non-cloneable values
					...(options.prepared.runtime?.messages
						? {
								rawRequest: safeClone({
									model: options.state.ctx.providerConfig.model,
									systemPrompt: options.prepared.systemPrompt,
									messages: requestMessages ?? [],
									...(options.prepared.runtime.tools?.length
										? {
												tools: options.prepared.runtime.tools.map((t) => ({
													type: "function" as const,
													function: {
														name: t.name,
														description: t.description ?? "",
														parameters: t.parameters,
													},
												})),
											}
										: {}),
									...(options.prepared.runtime.toolChoice
										? {
												toolChoice: String(options.prepared.runtime.toolChoice),
											}
										: {}),
									...(options.prepared.runtime.temperature !== undefined
										? { temperature: options.prepared.runtime.temperature }
										: {}),
									...(options.prepared.runtime.maxTokens !== undefined
										? { maxTokens: options.prepared.runtime.maxTokens }
										: {}),
									...(options.prepared.runtime.thinking
										? { thinking: options.prepared.runtime.thinking }
										: {}),
									...(options.prepared.runtime.reasoningEffort
										? { reasoningEffort: options.prepared.runtime.reasoningEffort }
										: {}),
								} satisfies CoreEvalRawRequest) as CoreEvalRawRequest,
							}
						: {}),
					// Capture API-level response body for .response.json
					// Safe-serialize via JSON round-trip to strip non-cloneable values
					rawResponse: safeClone({
						content: options.state.processor.accumulatedContent,
						toolCalls: options.state.turn.toolCalls.map((tc) => ({
							id: tc.id,
							name: tc.toolName,
							args: tc.arguments,
						})),
						finishReason:
							options.state.turn.toolCalls.length > 0 ? "tool_calls" : "stop",
						usage: options.state.accumulatedUsage
							? {
									inputTokens: options.state.accumulatedUsage.inputTokens,
									outputTokens: options.state.accumulatedUsage.outputTokens,
									totalTokens: options.state.accumulatedUsage.totalTokens,
								}
							: undefined,
					}) as CoreEvalRawResponse,
				}
			: undefined;

	const runAgentLoopPostResponseHooksWithAdaptersOptions: RunAgentLoopPostResponseHooksWithAdaptersOptions<ChatSession, ChatMessage, StreamProviderConfig, AppSettings> = {
		sessionId: options.state.ctx.sessionId,
		assistantMessageId: options.state.ctx.assistantMessageId,
		lastAssistantMessage: options.state.processor.accumulatedContent,
		historyMessages: options.historyMessages,
		providerId: options.state.ctx.providerId,
		providerConfig: options.state.ctx.providerConfig,
		settings: options.state.ctx.settings,
		toolIterations: options.state.toolIterations,
		skillManageCalled: options.state.skillManageCalled,
		prepared: options.prepared,
		promptCapture,
		getSession: (sessionId) => store.getSession(sessionId),
		// Collab sessions (room/work) skip the builtin post-response lanes
		// (docs/design/multi-agent-collab.md P0 门控三件套): goal-continuation
		// would re-drive the room outside the coordinator. Any plugin lane that
		// resolves session.agentId at hook time has the same hazard — the
		// coordinator flips it per activation, so X's turn could be attributed
		// to Y. The coordinator owns collab post-turn behavior by observing
		// stream:complete on the bus.
		runTriggerContext: (context) => {
			if (isCollabSession(options.state.ctx.sessionId)) return Promise.resolve();
			return triggerManager.runPostResponse(
				context as Parameters<typeof triggerManager.runPostResponse>[0],
			);
		},
		runAfterAssistantResponse: (context) => {
			if (isCollabSession(options.state.ctx.sessionId)) return Promise.resolve();
			return runAfterAssistantResponseHooks(context);
		},
		onError(source, error) {
			if (source === "trigger") {
				log.error("trigger execution failed", { sessionId: options.state.ctx.sessionId }, error);
				return;
			}
			log.error(
				"plugin after-response hook failed",
				{ sessionId: options.state.ctx.sessionId, source },
				error,
			);
		},
	};
	runAgentLoopPostResponseHooksWithAdapters<
		ChatSession,
		ChatMessage,
		typeof options.state.ctx.providerConfig,
		typeof options.state.ctx.settings
	>(runAgentLoopPostResponseHooksWithAdaptersOptions);
}

/**
 * §13.8 第一类:收场之后,把引擎写在**未结调用**上的东西记进账本。
 *
 * 中止 / 请求最终出错这两条收场路上,已经派工出去的工具永远等不到那条
 * `tool-result` 流事件 —— 账本上只剩 `tool/call`。而消息上引擎是有话说的:
 * 收尾修复判死了调用与 step(`cancelled` + 收场那句话),step 上还留着执行
 * 途中已经写下的结局(工具的 `annotate{metadata}` / 最后一次 partial)与
 * 自报标题。这里读**收场之后**的那份消息(修复已经落盘),把它交给记录器 ——
 * 不在这里第二次派生任何一格(§10.10)。
 *
 * 判据是 `status === 'cancelled'`:那正是收尾修复的口径。等确认的那些 step
 * 停在 `awaiting-confirmation`(引擎明确放过它们,恢复流还要用),因此天然
 * 不在这张表里。
 */
function captureCancelledToolResults(state: AgentLoopExecutorState): void {
	const recorder = state.eventRecorder;
	if (!recorder) return;
	try {
		// COW:收尾修复刚刚经命令面落过盘,这里必须**重读**(P0 的那个坑)。
		//
		// **F3(§16.10)复核:留在 store。** 理由是**只在 store 的运行时形状**
		// (不是"投影滞后" —— 那条理由 F1 之后已不成立):收尾修复写的是 `steps[]`
		// 上的结局(`cancelled` + 工具自报标题),而 `steps` 在 `DERIVED_KEYS` 里、
		// 消息命令从不把它翻进事件 —— 投影侧那几格是从 `tool/*` 事件物化出来的,
		// 而**这次采集要写的正是那几条 `tool/result`**。读投影 → 读空 → 采集不触发
		// → 账本缺 `tool/result` → 中止在途工具的 step 永远停在占位标题。
		const message = sessionReads.getMessageFromStore(
			state.ctx.sessionId,
			state.ctx.assistantMessageId,
		) as ChatMessage | undefined;
		if (!message) return;
		const calls: SessionCancelledToolResult[] = [];
		for (const step of message.steps ?? []) {
			if (step.status !== "cancelled") continue;
			if (!step.toolCallId) continue;
			calls.push({
				callId: step.toolCallId,
				...(typeof step.result === "string" && step.result
					? { result: step.result }
					: {}),
			});
		}
		if (calls.length > 0) recorder.recordCancelledToolResults(calls);
	} catch (error) {
		log.warn(
			"cancelled tool result capture failed",
			{ sessionId: state.ctx.sessionId },
			error,
		);
	}
}

async function emitFinalAssistantMessageUpdate(
	state: AgentLoopExecutorState,
	errorMessage?: string,
): Promise<void> {
	try {
		const emitAgentLoopFinalMessageUpdateWithAdaptersOptions: EmitAgentLoopFinalMessageUpdateWithAdaptersOptions<ChatMessage, ChatSession> = {
			sessionId: state.ctx.sessionId,
			assistantMessageId: state.ctx.assistantMessageId,
			getSession: (sessionId) => store.getSession(sessionId),
			// 收尾修复是 COW 的,必须显式落盘;这是对**消息**的 read-modify-write ——
			// 读到的消息经 `finalizeLingering…` 折成 patch 再写回(自报标题等字段随
			// steps 数组回落)。
			//
			// **F 线 F3(§16.10)复核:留在 store。** 理由是**只在 store 的运行时形状**
			// (不是"投影滞后" —— F1 之后不成立):要回落的是 `steps[]`,而 `steps` 在
			// `DERIVED_KEYS` 里、从不进消息事件;投影侧的 steps 是 `tool/*` 物化出来的,
			// 此刻还没有这次收尾要写的 `tool/result`。读投影 → 拿到占位标题 → 修复把
			// 占位标题焊回消息,反把引擎写好的自报标题抹掉。
			getMessage: (sessionId, messageId) =>
				sessionReads.getMessageFromStore(sessionId, messageId) as
					| ChatMessage
					| undefined,
			patchMessage: (sessionId, messageId, patch) => {
				sessionCommands.patchMessage(sessionId, {
					messageId,
					patch: patch as Partial<ChatMessage>,
					hint: "settle",
				});
			},
			emitMessageUpdated: async (event) => {
				await getEventBus().emit(state.ctx.sessionId, event);
			},
			errorMessage,
		};
		await emitAgentLoopFinalMessageUpdateWithAdapters<ChatMessage, ChatSession>(
			emitAgentLoopFinalMessageUpdateWithAdaptersOptions,
		);
	} catch {
		// Event system may not be initialized in tests.
	}
	// 修复落盘之后才读得到它 —— 采集点排在这里,不在上面那个 try 里(事件系统
	// 没起来不该让账本少一笔)。
	captureCancelledToolResults(state);
}

export async function completeAgentLoopStream(
	state: AgentLoopExecutorState,
	sessionName?: string,
): Promise<void> {
	const completeAgentLoopStreamWithAdaptersOptions: CompleteAgentLoopStreamWithAdaptersOptions<ChatMessage, ChatSession> = {
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		sessionName,
		accumulatedUsage: state.accumulatedUsage,
		lastTurnUsage: state.lastTurnUsage,
		finalize: () => state.processor.finalize(),
		getSession: (sessionId) => store.getSession(sessionId),
		// C1(P0.2):读走门面。收尾修复是 COW 的,必须显式落盘 —— 正常收尾这次读
		// **又是**一次 read-emit:读到的消息经 `finalizeLingering…` 折成 patch 落盘,
		// 并原样作为 settled 快照(`updates.contentParts`)广播给 renderer。
		//
		// **F 线 F3(§16.10)复核:留在 store,而且这一处是最不能翻的。** 理由是
		// **只在 store 的运行时形状**(不是"投影滞后" —— F1 之后不成立):store 上那份
		// contentParts 带着 `data-steps` 渲染锚点,而事件投影**故意不产出**它(锚点是
		// 渲染侧的东西,canonical G4 丢弃比较,`materializeContentParts` 也不合成)。
		// 换成 routed 的 `getMessage`,拿到的投影 contentParts 只有 text/reasoning ——
		// renderer 的 `updateSessionMessage` 用它整体覆盖之后,`rebuildContentParts`
		// 见非空(有 text)不再合成锚点,work group 与整段工具渲染当场消失。
		// (那是 §15.16「正文看不见」那一课的同一根引信。)
		getMessage: (sessionId, messageId) =>
			sessionReads.getMessageFromStore(sessionId, messageId) as
				| ChatMessage
				| undefined,
		patchMessage: (sessionId, messageId, patch) => {
			sessionCommands.patchMessage(sessionId, {
				messageId,
				patch: patch as Partial<ChatMessage>,
				hint: "settle",
			});
		},
		emitMessageUpdated: async (event) => {
			try {
				await getEventBus().emit(state.ctx.sessionId, event);
			} catch {
				// Event system may not be initialized in tests.
			}
		},
		sendStreamComplete: (data) => state.emitter.sendStreamComplete(data),
	};
	await completeAgentLoopStreamWithAdapters<ChatMessage, ChatSession>(completeAgentLoopStreamWithAdaptersOptions);
}

export async function applyAgentLoopStreamChunk(
	state: AgentLoopExecutorState,
	chunk: AgentProviderStreamChunk,
): Promise<void> {
	const storePort2: CoreAgentLoopToolExecutionStore<ToolCall> = {
		updateMessageToolCalls: store.updateMessageToolCalls,
	};
	const applyAgentLoopStreamChunkWithAdaptersOptions: ApplyAgentLoopStreamChunkWithAdaptersOptions<ContentPart, ToolCall, Partial<Step>, ToolResult<JsonObject | undefined>> = {
		state,
		chunk,
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		model: state.ctx.providerConfig.model,
		accumulatedContent: state.processor.accumulatedContent,
		processor: state.processor,
		store: storePort2,
		emitter: state.emitter,
		createNextAssistantWriter: () => createNextAssistantWriter(state),
		handleTextChunk: (text, content, turnIndex) =>
			state.processor.handleTextChunk(text, content, turnIndex),
		handleReasoningChunk: (reasoning, accumulator, turnIndex, placement) =>
			state.processor.handleReasoningChunk(
				reasoning,
				accumulator,
				turnIndex,
				placement,
			),
		applyProviderData: (options) => {
			const providerDataOptions: ApplyOnethingAgentLoopProviderDataOptions<ContentPart> = {
				...options,
				saveMediaImage,
				// A14(§13.1):内联生图那段 markdown 是**引擎合成的**(codex 的
				// 原生 image_generation、OpenRouter 的 images[] 都走这里),
				// provider 流里没有对应的 text-delta —— 采集点只能由这里告知,
				// 否则那段正文在会话事件账本上不存在。
				onSynthesizedText: (text) =>
					state.eventRecorder?.recordSynthesizedText(text),
				notifyImageGenerated: (notification) => {
					if (!state.ctx.sender.isDestroyed()) {
						state.ctx.sender.send(IPC_CHANNELS.IMAGE_GENERATED, notification);
					}
				},
			}
			return applyOnethingAgentLoopProviderData(providerDataOptions)
		},
		persistTurnContentParts: () => persistTurnContentParts(state),
		createTurnState,
		syncAccumulatedUsage: (usage) => {
			state.accumulatedUsage = usage;
			state.ctx.accumulatedUsage = usage;
		},
		syncLastTurnUsage: (usage) => {
			state.lastTurnUsage = usage;
			state.ctx.lastTurnUsage = usage;
			// Live readout (composer status): exact per-turn numbers at every
			// turn boundary. Fire-and-forget; must never block the stream.
			void getEventBus()
				.emit(state.ctx.sessionId, {
					type: SESSION_EVENT_TYPES.STREAM_USAGE,
					messageId: state.ctx.assistantMessageId,
					turnIndex: state.turnIndex,
					usage: {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						totalTokens: usage.totalTokens,
						...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
					},
					accumulated: {
						inputTokens: state.accumulatedUsage?.inputTokens ?? usage.inputTokens,
						outputTokens: state.accumulatedUsage?.outputTokens ?? usage.outputTokens,
						totalTokens: state.accumulatedUsage?.totalTokens ?? usage.totalTokens,
					},
				})
				.catch(() => {});
			// Billing must never break the chat stream: isolate failures here.
			try {
				recordUsage({
					sessionId: state.ctx.sessionId,
					assistantMessageId: state.ctx.assistantMessageId,
					providerId: state.ctx.providerId,
					modelId: state.ctx.providerConfig.model,
					// W13.3: the drive that started this stream may have labelled
					// itself ('collab-room' / 'collab-work'); everything else is chat.
					source: state.ctx.usageSource || "chat",
					usage,
				});
			} catch (error) {
				log.error("record usage failed", { sessionId: state.ctx.sessionId }, error);
			}
		},
		updateStepsUsageByTurn: (turnIndex, usage) => {
			store.updateStepsUsageByTurn(
				state.ctx.sessionId,
				state.ctx.assistantMessageId,
				turnIndex,
				usage,
			);
		},
		now: Date.now,
	};
	await coreApplyAgentLoopStreamChunkWithAdapters<
		ContentPart,
		ToolCall,
		Partial<Step>,
		ToolResult
	>(applyAgentLoopStreamChunkWithAdaptersOptions);
}

export async function executeAgentLoopStreamGeneration(
	ctx: StreamContext,
	historyMessages: HistoryMessage[],
	sessionName?: string,
	options: ExecuteAgentLoopStreamGenerationOptions = {},
): Promise<AgentLoopStreamGenerationResult> {
	// One resolution per turn, at the only door every run comes through (the
	// ordinary send path AND the resume-after-confirmation path). Everything
	// downstream reads this snapshot instead of re-deriving its own answer, so
	// an agent edited mid-turn cannot produce a half-new combination.
	ctx.agentProfile = resolveAgentProfileForSession(ctx.sessionId);
	// S1a:确认后恢复(`handleResumeAfterConfirm`)**绕过** `executeMessageStream`
	// 直接调这里,所以 run 在这里也要有一条兜底的入口。`ensureSessionRun` 按
	// assistantMessageId 判同一次执行:普通发送走到这里时 run 已经开好了,
	// 这一句是 no-op(`started:false`),也就不会收尾。
	const resumeAssistantPlaceholder = sessionReads.getMessage(
		ctx.sessionId,
		ctx.assistantMessageId,
	);
	const resumeAssistantTimestamp = resumeAssistantPlaceholder?.timestamp;
	const resumeRun = ensureSessionRun(ctx.sessionId, {
		kind: "resume",
		assistantMessageId: ctx.assistantMessageId,
		provider: ctx.providerId,
		model: ctx.providerConfig.model,
		...(resumeAssistantTimestamp !== undefined
			? { timestamp: resumeAssistantTimestamp }
			: {}),
		// A4(§13.1):与 timestamp / origin 同一条路数 —— 占位消息上盖过的那一格。
		...(resumeAssistantPlaceholder?.agentId
			? { agentId: resumeAssistantPlaceholder.agentId }
			: {}),
		// §13.9:与 agentId 同一刻盖的那格 `source`。
		...(resumeAssistantPlaceholder?.source
			? { messageSource: resumeAssistantPlaceholder.source }
			: {}),
		...(resumeAssistantPlaceholder?.origin
			? {
					origin: resumeAssistantPlaceholder.origin as unknown as Record<
						string,
						unknown
					>,
				}
			: {}),
	});
	// 只有真的在这里开张(恢复路径)才盖 runId —— 普通发送那条已经被
	// `executeMessageStream` 盖过了,再盖一次是同值重写。
	if (resumeRun.started) {
		sessionCommands.patchMessage(ctx.sessionId, {
			messageId: ctx.assistantMessageId,
			patch: { runId: resumeRun.run.runId },
			hint: "settle",
		});
	}
	const processor = createStreamProcessor(ctx, options.initialContent);
	const emitter = createEventOnlyEmitter(ctx);
	const state: AgentLoopExecutorState = {
		ctx,
		processor,
		emitter,
		turnIndex: 1,
		turn: createTurnState(),
		stepIdsByToolCallId: new Map(),
		toolIterations: 0,
		skillManageCalled: false,
		latestUserPrompt: lastUserMessageText(historyMessages),
	};

	try {
		const lifecycleOptions: ExecuteAgentLoopStreamLifecycleWithAdaptersOptions<
			BuildAgentLoopStreamRuntimeResult,
			Extract<BuildAgentLoopStreamRuntimeResult, { supported: true }>
		> = {
		prepareRuntime: () =>
			buildAgentLoopRuntimeFromStreamContext(ctx, historyMessages, {
				emitter,
				// §15.15:压缩重建读 store 之前,先把还挂着的那次换锚点收尾掉。
				beforeRebuildMessages: () =>
					settlePendingAssistantWriterBeforeStoreRead(state),
			}),
		isRuntimeSupported: (
			prepared,
		): prepared is Extract<
			BuildAgentLoopStreamRuntimeResult,
			{ supported: true }
		> => prepared.supported,
		unsupportedReason: (prepared) =>
			prepared.supported ? "Unsupported agent loop runtime" : prepared.reason,
		async emitStreamStart() {
			try {
				await getEventBus().emit(ctx.sessionId, {
					type: SESSION_EVENT_TYPES.STREAM_START,
					messageId: ctx.assistantMessageId,
					assistantMessageId: ctx.assistantMessageId,
					model: ctx.providerConfig.model,
				});
			} catch {
				// Event system not initialized.
			}
		},
		// E0 采集点:事件日志挂在 runtime 的 onEvent 上(理由见
		// session-event-recorder.ts 头注释 —— 挂这里才能保证 tool/call 在工具
		// 执行**之前**落账)。这里除了装配没有任何逻辑。
		streamChunks: (prepared) => {
			const recorded = attachSessionEventRecorder(prepared.runtime, {
				sessionId: ctx.sessionId,
				providerId: ctx.providerId,
				model: ctx.providerConfig.model,
				systemPrompt: prepared.systemPrompt,
				// U0:采集点读的是**同步点**那一格 —— 换锚点之后它立刻是新号,而
				// `ctx.assistantMessageId` 要等消费侧接手(见 state 上的注释)。
				getMessageId: () =>
					state.recordingAssistantMessageId ?? state.ctx.assistantMessageId,
				// U0(§10.15):身份在**事实这一侧**分配 —— boundary 一到就换锚点。
				onResponseBoundary: () => rotateAssistantWriterIdentity(state),
				// U0:UI 事件流的旁路。**档位在装配时读一次**而不是每条 delta 读一次
				// —— 口不接上时 `ctx.emitUiEvent?.(…)` 连那个事件对象都不构造
				// (可选调用短路掉实参求值),legacy 档因此是真的零开销。
				...(isUiEventStreamEnabled()
					? {
							emitUiEvent: (event: UiAssistantDeltaChunk | UiAssistantPartEndChunk) =>
								pushSessionUiStreamEvent(ctx.sessionId, event),
						}
					: {}),
				// G10:recipe 记的是 history builder 的**输入**(带 id 的那一份),
				// 不是 provider 收到的 AgentMessage[](那一份没有消息 id)。
				getHistoryInput: () =>
					sessionReads.listMessages(ctx.sessionId).messages.map((message) => ({
						id: message.id,
						role: message.role,
						content: message.content,
					})),
				// S1b:发出去之前比一次历史(§10.4 第二条;F0 之后是恒等门,§16.2)。
				// §15.15:换锚点的同步点与消费侧之间那一小段窗口里不比 —— store 侧
				// 现算的历史会被上一条 assistant 的 `isStreaming` 整条滤掉,比出来
				// 差一整轮而两侧都没错(与 run 断言的 `shadowGate` 同一条判例)。
				onRequestRecipe: (runId) =>
					checkSessionHistoryShadowForRequest(ctx.sessionId, runId, {
						pendingAssistantRotation: Boolean(state.pendingAssistantRotation),
					}),
				// A6+A7(§13.1):工具身份归一交给**引擎那一个函数**。记录器不再
				// 自己实现一遍别名表 / MCP 折叠 —— 一个判定点,两处落点。
				resolveToolIdentity: (toolName, args) =>
					resolveToolIdentity(toolName, args as AgentJsonObject),
				// A11(§13.1):可见性也只有引擎那一个判定点(处理器的
				// `rememberVisibility`)。记录器问它,不自己判第二遍。
				isToolCallHidden: (toolCallId) =>
					state.processor.isToolCallHidden(toolCallId),
				// S1b 缺口 4:请求参数快照。取的是**定稿后**的 runtime(档位、
				// 能力门控、per-model 覆盖都已经算完),不是设置里的原始值 ——
				// recipe 要能回答"这次真的按什么参数发出去的"。
				getRequestParams: () => {
					const runtime = prepared.runtime;
					const params = {
						...(runtime.temperature !== undefined
							? { temperature: runtime.temperature }
							: {}),
						...(runtime.maxTokens !== undefined
							? { maxTokens: runtime.maxTokens }
							: {}),
						...(runtime.thinking ? { thinking: runtime.thinking } : {}),
						...(runtime.reasoningEffort
							? { reasoningEffort: runtime.reasoningEffort }
							: {}),
						...(runtime.toolChoice
							? { toolChoice: String(runtime.toolChoice) }
							: {}),
					};
					return Object.keys(params).length > 0 ? params : undefined;
				},
			});
			// 错误与收尾两条路不经过 onEvent,所以执行器要拿到 recorder 本体。
			state.eventRecorder = recorded.recorder;
			return streamAgentLoopProviderChunks({
				...recorded.runtime,
				// per-space 凭证轮换(批 D)。挂在 core 的 turn 级重试边界上,
				// **不另起重试链**;没有池(默认空间 / 单条)时这里是 undefined,
				// core 的行为一行不变。
				rotateCredential: prepared.reprovision
					? createSessionCredentialRotator({
							sessionId: ctx.sessionId,
							providerId: ctx.providerId,
							currentEntryId: ctx.providerConfig.spaceCredential?.entryId,
							reprovision: prepared.reprovision,
							logger: consoleLog,
						})
					: undefined,
			});
		},
		applyChunk: (chunk) => applyAgentLoopStreamChunk(state, chunk),
		finalize: () => state.processor.finalize(),
		updateUsage(durationMs) {
			if (!state.accumulatedUsage) return;
			state.accumulatedUsage.durationMs = durationMs;
			store.updateMessageUsage(
				ctx.sessionId,
				ctx.assistantMessageId,
				state.accumulatedUsage,
			);
			updateSessionUsage(
				ctx.sessionId,
				state.accumulatedUsage,
				state.lastTurnUsage,
			);
		},
		completeStream: (prepared) => {
			void prepared;
			return completeAgentLoopStream(state, sessionName);
		},
		runPostResponseHooks: (prepared) =>
			runAgentLoopPostResponseHooks({
				state,
				prepared,
				historyMessages,
			}),
		isAbortError: (error) => {
			// 收尾闸:攒着的最后一批 delta 必须落账(abort 也是一种收场)。
			state.eventRecorder?.flush();
			return error.name === "AbortError" || ctx.abortSignal.aborted;
		},
		sendStreamAborted: (reason) => {
			// 中断在这里被接住,不再往上抛 —— 不留这一句,`run/end` 会把一次
			// 中断记成 completed(S1a)。
			markSessionRunOutcome(ctx.sessionId, "aborted");
			return state.emitter.sendStreamAborted(reason);
		},
		updateMessageError: (errorContent) => {
			state.eventRecorder?.recordRequestError(new Error(errorContent));
			markSessionRunOutcome(ctx.sessionId, "error", new Error(errorContent));
			store.updateMessageError(
				state.ctx.sessionId,
				state.ctx.assistantMessageId,
				errorContent,
			);
		},
		emitFinalAssistantMessageUpdate: (errorMessage) =>
			emitFinalAssistantMessageUpdate(state, errorMessage),
		sendStreamError: (data) => state.emitter.sendStreamError(data),
		sendStreamComplete: (data) => state.emitter.sendStreamComplete(data),
		getSessionName: () => store.getSession(state.ctx.sessionId)?.name,
		now: Date.now,
		};
		return await executeAgentLoopStreamLifecycleWithAdapters<
			BuildAgentLoopStreamRuntimeResult,
			Extract<BuildAgentLoopStreamRuntimeResult, { supported: true }>
		>(lifecycleOptions);
	} catch (error) {
		if (resumeRun.started) {
			// §15.12(c):等那一次 fsync —— 收账时「已落盘」必须是真的。
			await endSessionRun(ctx.sessionId, resumeRun.run.runId, {
				outcome: ctx.abortSignal.aborted ? "aborted" : "error",
				error,
			});
		}
		throw error;
	} finally {
		state.eventRecorder?.flush();
		// U0:同步点换过锚点但消费侧没来得及接手(中断 / 出错 / 循环到头)——
		// 那道影子闸必须开,否则被接手的那条 run 永远不比(门看的是 run 数)。
		state.pendingAssistantRotation?.releaseShadow();
		state.pendingAssistantRotation = undefined;
		// 幂等(见 `endSessionRun`);`started:false` 时收尾归 `executeMessageStream`。
		if (resumeRun.started) {
			await endSessionRun(ctx.sessionId, resumeRun.run.runId, { outcome: "completed" });
		}
	}
}
