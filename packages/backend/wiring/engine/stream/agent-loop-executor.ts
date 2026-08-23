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
	lastUserMessageText,
	persistAgentLoopTurnContentPartsWithAdapters,
	runAgentLoopPostResponseHooksWithAdapters,
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
	persistAgentLoopTurnContentPartsWithAdapters({
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		turn: state.turn,
		turnIndex: state.turnIndex,
		store: {
			addMessageContentPart: store.addMessageContentPart,
		},
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

async function createNextAssistantWriter(
	state: AgentLoopExecutorState,
): Promise<void> {
	await finishCurrentAssistantWriter(state);

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

	store.addMessage(state.ctx.sessionId, assistantMessage);
	// S1a:steering 的 response-boundary = **两次执行**。旧的按 completed 收尾,
	// 新的以 kind:'steer' 开张 —— 一条 assistant 消息一个 run 是投影的前提
	// (`run/start` 就是那条消息在 surface 上的那一格)。
	// A4(§13.1):盖章发生在 `addMessage` 里(`stampCollabAgentId`),所以读的是
	// **落库之后**的那一条,不是上面 plan 里那个还没盖章的对象。
	const storedAssistantMessage = sessionReads.getMessage(
		state.ctx.sessionId,
		assistantMessageId,
	);
	const rotated = rotateSessionRun(state.ctx.sessionId, {
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
	});
	sessionCommands.patchMessage(state.ctx.sessionId, {
		messageId: assistantMessageId,
		patch: { runId: rotated.runId },
		hint: "settle",
	});
	state.ctx.assistantMessageId = assistantMessageId;
	state.processor = createStreamProcessor(state.ctx);
	state.emitter = createEventOnlyEmitter(state.ctx);
	state.turn = createTurnState();
	state.stepIdsByToolCallId.clear();

	try {
		const eventBus = getEventBus();
		for (const event of plan.events) {
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

	runAgentLoopPostResponseHooksWithAdapters<
		ChatSession,
		ChatMessage,
		typeof options.state.ctx.providerConfig,
		typeof options.state.ctx.settings
	>({
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
	});
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
		// §13.18 发现 B(同类):这是**事件写侧**取材 —— 读到的消息直接决定
		// `recordCancelledToolResults` 往 events.jsonl 写哪几条 `tool/result`
		// (含工具自报标题)。必须走 `*FromTranscript` 读抄本真相,**永不**走随
		// 读模式分岔的 `getMessage`:events 模式下后者返回的活投影此刻还没看到
		// 收尾修复(那条 `tool/result` 正要由这次采集写出),读空 → 采集不触发 →
		// 账本缺 `tool/result` → 中止在途工具的 step 永远停在占位标题。
		const message = sessionReads.getMessageFromTranscript(
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
		await emitAgentLoopFinalMessageUpdateWithAdapters<ChatMessage, ChatSession>(
			{
				sessionId: state.ctx.sessionId,
				assistantMessageId: state.ctx.assistantMessageId,
				getSession: (sessionId) => store.getSession(sessionId),
				// F3:收尾修复是 COW 的,必须显式落盘。§13.18 发现 B(同类):这是对
				// **消息真相**的 read-modify-write —— 读到的消息经 `finalizeLingering…`
				// 折成 patch 后原样写回 messages.jsonl(自报标题等字段随 steps 数组回落)。
				// 必须走 `*FromTranscript` 读抄本:events 模式下 `getMessage` 的 `fromEvents`
				// 岔口此刻返回的活投影还没看到这次收尾要写的 `tool/result`,读到占位标题 →
				// 修复把占位标题焊回 messages.jsonl,反把引擎写好的自报标题抹掉。
				getMessage: (sessionId, messageId) =>
					sessionReads.getMessageFromTranscript(sessionId, messageId) as
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
			},
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
	await completeAgentLoopStreamWithAdapters<ChatMessage, ChatSession>({
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		sessionName,
		accumulatedUsage: state.accumulatedUsage,
		lastTurnUsage: state.lastTurnUsage,
		finalize: () => state.processor.finalize(),
		getSession: (sessionId) => store.getSession(sessionId),
		// C1(P0.2):读走门面;F3:收尾修复是 COW 的,必须显式落盘。
		getMessage: (sessionId, messageId) =>
			sessionReads.getMessage(sessionId, messageId) as ChatMessage | undefined,
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
	});
}

export async function applyAgentLoopStreamChunk(
	state: AgentLoopExecutorState,
	chunk: AgentProviderStreamChunk,
): Promise<void> {
	await coreApplyAgentLoopStreamChunkWithAdapters<
		ContentPart,
		ToolCall,
		Partial<Step>,
		ToolResult
	>({
		state,
		chunk,
		sessionId: state.ctx.sessionId,
		assistantMessageId: state.ctx.assistantMessageId,
		model: state.ctx.providerConfig.model,
		accumulatedContent: state.processor.accumulatedContent,
		processor: state.processor,
		store: {
			updateMessageToolCalls: store.updateMessageToolCalls,
		},
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
		applyProviderData: (options) =>
			applyOnethingAgentLoopProviderData({
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
			}),
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
	});
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
		return await executeAgentLoopStreamLifecycleWithAdapters<
		BuildAgentLoopStreamRuntimeResult,
		Extract<BuildAgentLoopStreamRuntimeResult, { supported: true }>
	>({
		prepareRuntime: () =>
			buildAgentLoopRuntimeFromStreamContext(ctx, historyMessages, { emitter }),
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
				getMessageId: () => state.ctx.assistantMessageId,
				// G10:recipe 记的是 history builder 的**输入**(带 id 的那一份),
				// 不是 provider 收到的 AgentMessage[](那一份没有消息 id)。
				getHistoryInput: () =>
					sessionReads.listMessages(ctx.sessionId).messages.map((message) => ({
						id: message.id,
						role: message.role,
						content: message.content,
					})),
				// S1b:发出去之前比一次历史(§10.4 第二条)。
				onRequestRecipe: (runId) =>
					checkSessionHistoryShadowForRequest(ctx.sessionId, runId),
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
		});
	} catch (error) {
		if (resumeRun.started) {
			endSessionRun(ctx.sessionId, resumeRun.run.runId, {
				outcome: ctx.abortSignal.aborted ? "aborted" : "error",
				error,
			});
		}
		throw error;
	} finally {
		state.eventRecorder?.flush();
		// 幂等(见 `endSessionRun`);`started:false` 时收尾归 `executeMessageStream`。
		if (resumeRun.started) {
			endSessionRun(ctx.sessionId, resumeRun.run.runId, { outcome: "completed" });
		}
	}
}
