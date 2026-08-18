import * as store from "../../store.js";
import {
	IPC_CHANNELS,
	type ContentPart,
	type Step,
	type ToolCall,
	type ToolResult,
} from "@shared/ipc.js";
import { getEventBus } from "../../events/index.js";
import { createEventOnlyEmitter } from "../../events/event-only-emitter.js";
import {
	streamAgentLoopProviderChunks,
	type AgentProviderStreamChunk,
} from "@onething/core/agent-loop";
import type { HistoryMessage } from "./message-helpers.js";
import type { StreamContext, StreamProcessor } from "./stream-processor.js";
import { createStreamProcessor } from "./stream-processor.js";
import type { IPCEmitter } from "./ipc-emitter.js";
import {
	buildAgentLoopRuntimeFromStreamContext,
	type BuildAgentLoopStreamRuntimeResult,
} from "./agent-loop-runtime.js";
import { createSessionCredentialRotator } from "../../providers/credential-rotation.js";
import { resolveAgentProfileForSession } from "../../agents/profile.js";
import { saveMediaImage } from "../../media/save-image.js";
import { applyOnethingAgentLoopProviderData } from "@onething/runtime/agent-loop/providers";
import { updateSessionUsage } from "../../session/usage.js";
import { recordUsage } from "../../usage/index.js";
import { triggerManager } from "../triggers/index.js";
import { runAfterAssistantResponseHooks } from "../../plugins/lifecycle.js";
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
import { hashSections } from "@onething/runtime";
import { attachSessionEventRecorder } from "./session-event-recorder.js";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";

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

export { shouldUseAgentLoopStream } from "./agent-loop-selection.js";

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
				console.error("[AgentLoopExecutor] Trigger execution failed:", error);
				return;
			}
			console.error(
				"[AgentLoopExecutor] Plugin after-response hook failed:",
				error,
			);
		},
	});
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
				emitMessageUpdated: async (event) => {
					await getEventBus().emit(state.ctx.sessionId, event);
				},
				errorMessage,
			},
		);
	} catch {
		// Event system may not be initialized in tests.
	}
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
				console.error("[AgentLoopExecutor] recordUsage failed:", error);
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

	return executeAgentLoopStreamLifecycleWithAdapters<
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
		streamChunks: (prepared) =>
			streamAgentLoopProviderChunks({
				...attachSessionEventRecorder(prepared.runtime, {
					sessionId: ctx.sessionId,
					providerId: ctx.providerId,
					model: ctx.providerConfig.model,
					systemPrompt: prepared.systemPrompt,
					getMessageId: () => state.ctx.assistantMessageId,
				}),
				// per-space 凭证轮换(批 D)。挂在 core 的 turn 级重试边界上,
				// **不另起重试链**;没有池(默认空间 / 单条)时这里是 undefined,
				// core 的行为一行不变。
				rotateCredential: prepared.reprovision
					? createSessionCredentialRotator({
							sessionId: ctx.sessionId,
							providerId: ctx.providerId,
							currentEntryId: ctx.providerConfig.spaceCredential?.entryId,
							reprovision: prepared.reprovision,
							logger: console,
						})
					: undefined,
			}),
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
		isAbortError: (error) =>
			error.name === "AbortError" || ctx.abortSignal.aborted,
		sendStreamAborted: (reason) => state.emitter.sendStreamAborted(reason),
		updateMessageError: (errorContent) => {
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
}
