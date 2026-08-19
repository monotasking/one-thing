import {
	coreToolCallSnapshot,
	patchCoreToolCall,
	replaceCoreToolCall,
} from "./tool-call-cow.js";
import {
	toJsonObject,
	toJsonValue,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type { CorePromptCapture } from "./triggers.js";
import type { AgentProviderStreamChunk } from "../agent-loop/provider-stream.js";
import type { AgentProviderData } from "../agent-loop/types.js";
import { isAgentLoopPauseForConfirmationError } from "../agent-loop/errors.js";
import {
	coreDiffHunksFromJson,
	type CoreDiffHunk,
} from "../tools/diff-hunks.js";
import {
	getTextFromContent,
	type CoreAIMessageContent,
} from "./message-content.js";

export interface CoreAgentLoopExecutorContentAccumulator {
	value: string;
}

export interface CoreAgentLoopExecutorTurnState<
	TToolCall = unknown,
	TContentPart = unknown,
> {
	toolCalls: TToolCall[];
	content: CoreAgentLoopExecutorContentAccumulator;
	reasoning: CoreAgentLoopExecutorContentAccumulator;
	orderedParts: TContentPart[];
	hasSentToolParts: boolean;
}

export interface CoreOrderedPartLike {
	type: string;
	content?: string;
	turnIndex?: number;
}

export interface CoreAgentLoopDataStepsPart {
	type: "data-steps";
	turnIndex: number;
}

export interface CoreAgentLoopProviderDataPart {
	type: "provider-data";
	providerData: AgentProviderData;
	turnIndex: number;
}

type CoreMaybePromise<T> = T | Promise<T>;

export type CoreAgentProviderDataLike = AgentProviderData;

export type CoreAgentLoopProviderDataPlan =
	| { kind: "ignore" }
	| { kind: "provider-data"; orderedPart: CoreAgentLoopProviderDataPart };

export interface ApplyAgentLoopProviderDataWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
> {
	providerData: CoreAgentProviderDataLike;
	turnIndex: number;
	latestUserPrompt?: string;
	model: string;
	sessionId: string;
	messageId: string;
	content: CoreAgentLoopExecutorContentAccumulator;
	orderedParts: TContentPart[];
	emitter: {
		sendContentPart(part: TContentPart): void;
	};
	handleTextChunk(
		textDelta: string,
		content: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
	): string | null | undefined;
	planProviderData?: (
		providerData: CoreAgentProviderDataLike,
		context: CoreAgentLoopProviderDataPlanContext,
	) => CoreAgentLoopProviderDataPlan;
	applyProviderData?: (
		options: ApplyAgentLoopProviderDataRuntimeOptions<TContentPart>,
	) => CoreMaybePromise<boolean | undefined>;
}

export interface CoreAgentLoopProviderDataPlanContext {
	turnIndex: number;
	latestUserPrompt?: string;
	model: string;
	sessionId: string;
	messageId: string;
}

export interface ApplyAgentLoopProviderDataRuntimeOptions<
	TContentPart extends CoreOrderedPartLike,
> extends CoreAgentLoopProviderDataPlanContext {
	providerData: CoreAgentProviderDataLike;
	content: CoreAgentLoopExecutorContentAccumulator;
	orderedParts: TContentPart[];
	emitter: {
		sendContentPart(part: TContentPart): void;
	};
	handleTextChunk(
		textDelta: string,
		content: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
	): string | null | undefined;
}

export interface ApplyAgentLoopStreamChunkWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
> {
	state: CoreAgentLoopFinishState<
		CoreAgentLoopExecutorTurnState<TToolCall, TContentPart>
	> & {
		toolIterations: number;
		skillManageCalled: boolean;
		stepIdsByToolCallId: Map<string, string>;
		latestUserPrompt?: string;
	};
	chunk: AgentProviderStreamChunk;
	sessionId: string;
	assistantMessageId: string;
	model: string;
	accumulatedContent: string;
	processor: CoreAgentLoopToolInputProcessor<TToolCall>;
	store: CoreAgentLoopToolExecutionStore<TToolCall>;
	emitter: CoreAgentLoopContentPartEmitter<TContentPart> &
		CoreAgentLoopToolExecutionEmitter<
			TToolCall,
			TStepUpdate,
			CoreToolPartialResultUpdate,
			TToolResult
		> & {
			sendContextSizeUpdate(inputTokens: number): void;
			sendContinuation(turnIndex: number): void;
		};
	createNextAssistantWriter: () => CoreMaybePromise<void>;
	handleTextChunk(
		text: string,
		content: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
	): string | null | undefined;
	handleReasoningChunk(
		reasoning: string,
		accumulator: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
		placement: CoreAgentLoopReasoningPlacement,
	): void;
	planProviderData?: ApplyAgentLoopProviderDataWithAdaptersOptions<TContentPart>["planProviderData"];
	applyProviderData?: ApplyAgentLoopProviderDataWithAdaptersOptions<TContentPart>["applyProviderData"];
	persistTurnContentParts: () => void;
	createTurnState: () => CoreAgentLoopExecutorTurnState<
		TToolCall,
		TContentPart
	>;
	syncAccumulatedUsage?: (usage: CoreAgentLoopUsage) => void;
	syncLastTurnUsage?: (usage: CoreAgentLoopUsage) => void;
	updateStepsUsageByTurn?: (
		turnIndex: number,
		usage: CoreAgentLoopUsage,
	) => void;
	now?: () => number;
}

export interface CoreAgentLoopStreamGenerationResult {
	pausedForConfirmation: boolean;
}

export interface ExecuteAgentLoopStreamLifecycleWithAdaptersOptions<
	TPrepared,
	TSupportedPrepared extends TPrepared,
> {
	prepareRuntime(): CoreMaybePromise<TPrepared>;
	isRuntimeSupported(prepared: TPrepared): prepared is TSupportedPrepared;
	unsupportedReason(prepared: TPrepared): string;
	emitStreamStart(): CoreMaybePromise<void>;
	streamChunks(
		prepared: TSupportedPrepared,
	): AsyncIterable<AgentProviderStreamChunk>;
	applyChunk(chunk: AgentProviderStreamChunk): CoreMaybePromise<void>;
	finalize(): CoreMaybePromise<void>;
	updateUsage?(durationMs: number): CoreMaybePromise<void>;
	completeStream(prepared: TSupportedPrepared): CoreMaybePromise<void>;
	runPostResponseHooks(prepared: TSupportedPrepared): CoreMaybePromise<void>;
	isAbortError(error: Error): boolean;
	sendStreamAborted(reason: string): CoreMaybePromise<void>;
	updateMessageError(error: string): CoreMaybePromise<void>;
	emitFinalAssistantMessageUpdate(
		errorMessage?: string,
	): CoreMaybePromise<void>;
	sendStreamError(data: {
		error: string;
		preserved: boolean;
	}): CoreMaybePromise<void>;
	sendStreamComplete(data: {
		sessionName?: string;
		error?: string;
	}): CoreMaybePromise<void>;
	getSessionName?(): string | undefined;
	now?: () => number;
}

export interface ApplyAgentLoopTurnStartWithAdaptersOptions {
	state: {
		turnIndex: number;
		createNewAssistantOnNextTurnStart?: boolean;
	};
	turn: number;
	createNextAssistantWriter: () => CoreMaybePromise<void>;
}

export interface ApplyAgentLoopTextChunkWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
> {
	text: string;
	turnIndex: number;
	content: CoreAgentLoopExecutorContentAccumulator;
	orderedParts: TContentPart[];
	handleTextChunk(
		text: string,
		content: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
	): string | null | undefined;
}

export interface ApplyAgentLoopReasoningChunkWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
> {
	reasoning: string;
	turnIndex: number;
	accumulatedContent: string;
	turn: Pick<
		CoreAgentLoopExecutorTurnState<unknown, TContentPart>,
		"orderedParts" | "content" | "reasoning" | "toolCalls" | "hasSentToolParts"
	>;
	handleReasoningChunk(
		reasoning: string,
		accumulator: CoreAgentLoopExecutorContentAccumulator,
		turnIndex: number,
		placement: CoreAgentLoopReasoningPlacement,
	): void;
}

export interface CoreAgentLoopToolContentPartDispatchPlan<
	TPart extends CoreOrderedPartLike,
> {
	shouldSend: boolean;
	parts: TPart[];
	dataStepsPart?: CoreAgentLoopDataStepsPart;
}

export interface CoreAgentLoopTurnContentPersistencePlan<
	TPart extends CoreOrderedPartLike,
> {
	persistParts: Array<TPart | CoreAgentLoopDataStepsPart>;
	immediateParts: TPart[];
}

export interface CoreAgentLoopContentPartStore<TPart> {
	addMessageContentPart(
		sessionId: string,
		assistantMessageId: string,
		part: TPart | CoreAgentLoopDataStepsPart,
	): void;
}

export interface CoreAgentLoopContentPartEmitter<TPart> {
	sendContentPart(part: TPart | CoreAgentLoopDataStepsPart): void;
}

export interface DispatchAgentLoopToolContentPartsOptions<
	TPart extends CoreOrderedPartLike,
> {
	turn: Pick<
		CoreAgentLoopExecutorTurnState<unknown, TPart>,
		"orderedParts" | "hasSentToolParts"
	>;
	turnIndex: number;
	emitter: CoreAgentLoopContentPartEmitter<TPart>;
}

export interface PersistAgentLoopTurnContentPartsOptions<
	TPart extends CoreOrderedPartLike,
> {
	sessionId: string;
	assistantMessageId: string;
	turn: Pick<
		CoreAgentLoopExecutorTurnState<unknown, TPart>,
		"orderedParts" | "toolCalls"
	>;
	turnIndex: number;
	store: CoreAgentLoopContentPartStore<TPart>;
	emitter: CoreAgentLoopContentPartEmitter<TPart>;
}

export interface CoreAgentToolResultLike {
	content?: string;
	error?: string;
	data?: unknown;
	requiresConfirmation?: boolean;
	commandType?: string;
}

export interface CoreToolResultContentPart {
	type: "text" | "image" | "file";
	text?: string;
	data?: string;
	mimeType?: string;
	path?: string;
}

export interface CoreToolResult {
	content: CoreToolResultContentPart[];
	details?: JsonObject;
	terminate?: boolean;
}

export interface CoreToolPartialResultUpdate {
	content: Array<{ type: string; text?: string }>;
}

export interface CoreToolCallChanges {
	diff: string;
	/** Structured hunks; render from these, never by re-parsing `diff` text. */
	hunks?: CoreDiffHunk[];
	filePath: string;
	additions: number;
	deletions: number;
	/** @deprecated Rollback uses auditPath; kept only for legacy persisted sessions. */
	originalContent?: string;
	originalContentHash?: string;
	afterContentHash?: string;
	auditId?: string;
	auditPath?: string;
}

export interface CoreAgentLoopToolCallWithMetadata {
	changes?: CoreToolCallChanges;
}

export interface CoreAgentLoopToolMetadataUpdate {
	title?: unknown;
	metadata?: JsonObject;
}

export interface CoreAgentLoopStepMetadataUpdate<TToolCall> {
	title?: string;
	result?: string;
	toolCall?: TToolCall;
}

export interface CoreAgentLoopToolPartialStepUpdate<TPartialResult> {
	status: "running";
	partialResult: TPartialResult;
	partialResultIsPartial: true;
	result: string;
}

export interface CoreAgentLoopToolStartStepUpdate<TToolCall> {
	status: "running";
	toolCall: TToolCall;
}

export type CoreAgentLoopToolResultStepStatus =
	| "awaiting-confirmation"
	| "completed"
	| "cancelled"
	| "failed";

export interface CoreAgentLoopToolResultStepUpdate<
	TToolCall,
	TToolResult = CoreToolResult,
> {
	status: CoreAgentLoopToolResultStepStatus;
	toolCall: TToolCall;
	partialResult?: TToolResult;
	partialResultIsPartial?: false;
	result?: string;
	error?: string;
	rejected?: boolean;
	rejectionReason?: string;
}

export interface CoreAgentLoopToolExecutionEndUpdate<
	TToolResult = CoreToolResult,
> {
	result?: TToolResult;
	isError: boolean;
	error?: string;
}

export interface CoreAgentLoopToolResultPresentation<
	TToolCall,
	TToolResult = CoreToolResult,
> {
	executionEnd?: CoreAgentLoopToolExecutionEndUpdate<TToolResult>;
	stepUpdate: CoreAgentLoopToolResultStepUpdate<TToolCall, TToolResult>;
}

export interface CoreAgentLoopToolExecutionStore<TToolCall> {
	updateMessageToolCalls(
		sessionId: string,
		assistantMessageId: string,
		toolCalls: TToolCall[],
	): void;
}

export interface CoreAgentLoopToolExecutionEmitter<
	TToolCall,
	TStepUpdate,
	TPartialResult = CoreToolPartialResultUpdate,
	TToolResult = CoreToolResult,
> {
	sendToolCall(toolCall: TToolCall): void;
	sendToolResult(toolCall: TToolCall): void;
	sendToolExecutionStart(
		toolCallId: string,
		stepId: string,
		toolName: string,
		args: JsonObject,
		startTime?: number,
	): void;
	sendToolExecutionUpdate(
		toolCallId: string,
		stepId: string,
		partialResult: TPartialResult,
	): void;
	sendToolExecutionEnd(
		toolCallId: string,
		stepId: string,
		result?: TToolResult,
		isError?: boolean,
		error?: string,
		durationMs?: number,
	): void;
	sendStepUpdated(stepId: string, updates: TStepUpdate): void;
}

export interface CoreAgentLoopToolInputProcessor<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
> {
	toolCalls: TToolCall[];
	getStepIdForToolCall(toolCallId: string): string | undefined;
	handleToolInputStart(
		toolCallId: string,
		toolName: string,
		turnIndex: number,
	): void;
	handleToolInputDelta(toolCallId: string, argsTextDelta: string): void;
	handleToolInputEnd(
		toolCallId: string,
		options?: { finalizedBy?: "parse" | "provider-done" },
	): TToolCall | null | undefined;
	handleToolCallChunk(chunk: {
		toolCallId: string;
		toolName: string;
		args: JsonObject;
	}): TToolCall;
	handleToolCallComplete?(
		chunk: {
			toolCallId: string;
			toolName: string;
			args: JsonObject;
		},
		options?: { finalizedBy?: "parse" | "provider-done" },
	): TToolCall;
}

export interface ApplyAgentLoopToolInputStartWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
> {
	turn: Pick<
		CoreAgentLoopExecutorTurnState<TToolCall, TContentPart>,
		"orderedParts" | "hasSentToolParts"
	>;
	turnIndex: number;
	toolCallId: string;
	toolName: string;
	processor: Pick<
		CoreAgentLoopToolInputProcessor<TToolCall>,
		"handleToolInputStart" | "getStepIdForToolCall"
	>;
	stepIdsByToolCallId: Map<string, string>;
	emitter: CoreAgentLoopContentPartEmitter<TContentPart> &
		Pick<CoreAgentLoopToolExecutionEmitter<TToolCall, TStepUpdate>, never>;
}

export interface ApplyAgentLoopToolInputEndWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
> extends Omit<
		StartAgentLoopToolExecutionOptions<TToolCall, TStepUpdate>,
		"toolCall" | "toolCalls" | "stepId"
	> {
	toolCallId: string;
	finalizedBy?: "parse" | "provider-done";
	turn: Pick<
		CoreAgentLoopExecutorTurnState<TToolCall, TContentPart>,
		"toolCalls"
	>;
	processor: Pick<
		CoreAgentLoopToolInputProcessor<TToolCall>,
		"handleToolInputEnd" | "getStepIdForToolCall" | "toolCalls"
	>;
	stepIdsByToolCallId: Map<string, string>;
}

export interface ApplyAgentLoopToolCallFallbackWithAdaptersOptions<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
> extends Omit<
		StartAgentLoopToolExecutionOptions<TToolCall, TStepUpdate>,
		"toolCall" | "toolCalls" | "stepId"
	> {
	turn: Pick<
		CoreAgentLoopExecutorTurnState<TToolCall, TContentPart>,
		"orderedParts" | "hasSentToolParts" | "toolCalls"
	>;
	turnIndex: number;
	toolCall: CoreAgentLoopFallbackToolCallLike;
	finalizedBy?: "parse" | "provider-done";
	processor: CoreAgentLoopToolInputProcessor<TToolCall>;
	stepIdsByToolCallId: Map<string, string>;
	emitter: CoreAgentLoopContentPartEmitter<TContentPart> &
		StartAgentLoopToolExecutionOptions<TToolCall, TStepUpdate>["emitter"];
}

export interface ApplyAgentLoopToolResultWithAdaptersOptions<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
> extends SettleAgentLoopToolResultOptions<
		TToolCall,
		TStepUpdate,
		TToolResult
	> {
	state: {
		toolIterations: number;
		skillManageCalled: boolean;
	};
}

export interface CoreAgentLoopToolChunkApplyResult<TToolCall> {
	found: boolean;
	toolCall?: TToolCall;
}

export interface StartAgentLoopToolExecutionOptions<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
> {
	sessionId: string;
	assistantMessageId: string;
	toolCall: TToolCall;
	toolCalls: TToolCall[];
	stepId?: string;
	store: CoreAgentLoopToolExecutionStore<TToolCall>;
	emitter: Pick<
		CoreAgentLoopToolExecutionEmitter<TToolCall, TStepUpdate>,
		"sendToolCall" | "sendToolExecutionStart" | "sendStepUpdated"
	>;
	now?: () => number;
}

export interface SettleAgentLoopToolResultOptions<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
> {
	sessionId: string;
	assistantMessageId: string;
	toolCallId: string;
	result: CoreAgentToolResultLike;
	toolCalls: TToolCall[];
	stepIdsByToolCallId: Map<string, string>;
	store: CoreAgentLoopToolExecutionStore<TToolCall>;
	emitter: Pick<
		CoreAgentLoopToolExecutionEmitter<
			TToolCall,
			TStepUpdate,
			CoreToolPartialResultUpdate,
			TToolResult
		>,
		"sendToolResult" | "sendToolExecutionEnd" | "sendStepUpdated"
	>;
	now?: () => number;
}

export interface CoreAgentLoopToolResultSettlementResult<TToolCall> {
	found: boolean;
	toolCall?: TToolCall;
	toolIterationsDelta: number;
	skillManageCalled: boolean;
	awaitingConfirmation: boolean;
}

export interface ApplyAgentLoopToolMetadataOptions<
	TToolCall extends CoreAgentLoopToolCallWithMetadata,
	TStepUpdate,
> {
	toolCallId: string;
	update: CoreAgentLoopToolMetadataUpdate;
	toolCalls: TToolCall[];
	stepIdsByToolCallId: Map<string, string>;
	emitter: Pick<
		CoreAgentLoopToolExecutionEmitter<TToolCall, TStepUpdate>,
		"sendStepUpdated"
	>;
}

export interface ApplyAgentLoopToolPartialResultOptions<
	TToolCall,
	TStepUpdate,
	TPartialResult extends
		CoreToolPartialResultUpdate = CoreToolPartialResultUpdate,
> {
	toolCallId: string;
	update: TPartialResult;
	stepIdsByToolCallId: Map<string, string>;
	emitter: Pick<
		CoreAgentLoopToolExecutionEmitter<TToolCall, TStepUpdate, TPartialResult>,
		"sendToolExecutionUpdate" | "sendStepUpdated"
	>;
}

export interface CorePreparedToolNames {
	toolNames: string[];
	mcpToolNames: string[];
}

export interface CoreAgentLoopPostResponseSession<TMessage = unknown> {
	messages: TMessage[];
	/**
	 * F4 身份面:会话绑定的 agent。只被 afterAssistantResponse 的 ctx 读一次
	 * (纯透传,零新状态)。触发器那条 ctx 不加这个字段 —— 它的既有消费者都用
	 * `session` 本体,再摊平一份只会多一条要保持同步的事实。
	 */
	agentId?: string;
}

export interface CoreAgentLoopPostResponseTriggerContext<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	sessionId: string;
	session: TSession;
	messages: TMessage[];
	lastUserMessage: string;
	lastAssistantMessage: string;
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	enabledToolNames: string[];
	/** Captured prompt at turn time (available on negative-signal turns). */
	promptCapture?: CorePromptCapture;
}

export interface CoreAgentLoopAfterAssistantResponseContext<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> extends CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	> {
	assistantMessageId: string;
	/** F4:回合归属的 agent(源头 `session.agentId`;缺省 = 没绑 agent)。 */
	agentId?: string;
}

export interface CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	triggerContext: CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>;
	afterAssistantResponseContext: CoreAgentLoopAfterAssistantResponseContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>;
}

export interface RunAgentLoopPostResponseHooksWithAdaptersOptions<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
> {
	sessionId: string;
	assistantMessageId: string;
	lastAssistantMessage: string | undefined;
	historyMessages: CoreHistoryMessageWithContent[];
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	prepared: CorePreparedToolNames;
	promptCapture?: CorePromptCapture;
	getSession: (sessionId: string) => TSession | undefined;
	runTriggerContext: (
		context: CoreAgentLoopPostResponseTriggerContext<
			TSession,
			TMessage,
			TProviderConfig,
			TSettings
		>,
	) => void | Promise<void>;
	runAfterAssistantResponse: (
		context: CoreAgentLoopAfterAssistantResponseContext<
			TSession,
			TMessage,
			TProviderConfig,
			TSettings
		>,
	) => void | Promise<void>;
	onError?: (
		source: "trigger" | "afterAssistantResponse",
		error: unknown,
	) => void;
}

export interface CoreAgentLoopToolCallIdentity {
	id: string;
}

export interface CoreAgentLoopFallbackToolCallLike {
	toolCallId: string;
	toolName: string;
	args?: JsonObject;
}

export interface CoreAgentLoopToolCallFallbackPlan {
	shouldStartPlaceholder: boolean;
	toolCallId: string;
	toolName: string;
	args: JsonObject;
}

export interface CoreAgentLoopToolCallForSettlement {
	id: string;
	toolId?: string;
	toolName: string;
	arguments?: JsonObject;
	status?: string;
	result?: JsonValue;
	error?: string;
	rejected?: boolean;
	rejectionReason?: string;
	requiresConfirmation?: boolean;
	commandType?: string;
	startTime?: number;
	endTime?: number;
	durationMs?: number;
}

export interface CoreSettledAgentLoopToolCallResult<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
> {
	toolCall: TToolCall;
	awaitingConfirmation: boolean;
	skillManageCalled: boolean;
}

export interface CoreHistoryMessageWithContent {
	role: string;
	content: unknown;
}

export type CoreAgentLoopReasoningPlacement = "top" | "inline";

export interface CoreAgentLoopUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	durationMs?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
}

/**
 * lastTurnUsage historically omits totalTokens (some callers only track
 * input/output deltas per turn); keep it optional here rather than widening
 * every existing narrow lastTurnUsage call site to require it.
 */
export interface CoreAgentLoopLastTurnUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
}

export interface CoreAgentLoopFinishPlan {
	accumulatedUsage?: CoreAgentLoopUsage;
	lastTurnUsage?: CoreAgentLoopUsage;
	contextSizeInputTokens?: number;
	nextTurnIndex: number;
	createNewAssistantOnNextTurnStart: boolean;
	resetTurn: boolean;
	continuationTurnIndex?: number;
}

export interface CoreAgentLoopFinishState<TTurn> {
	turnIndex: number;
	accumulatedUsage?: CoreAgentLoopUsage;
	lastTurnUsage?: CoreAgentLoopLastTurnUsage;
	createNewAssistantOnNextTurnStart?: boolean;
	turn: TTurn;
}

export interface ApplyAgentLoopFinishChunkWithAdaptersOptions<TTurn> {
	state: CoreAgentLoopFinishState<TTurn>;
	usage?: CoreAgentLoopUsage;
	finishReason?: string;
	syncAccumulatedUsage?: (usage: CoreAgentLoopUsage) => void;
	syncLastTurnUsage?: (usage: CoreAgentLoopUsage) => void;
	updateStepsUsageByTurn?: (
		turnIndex: number,
		usage: CoreAgentLoopUsage,
	) => void;
	sendContextSizeUpdate: (inputTokens: number) => void;
	persistTurnContentParts: () => void;
	createTurnState: () => TTurn;
	sendContinuation: (turnIndex: number) => void;
}

export interface CoreAgentLoopAssistantMessageOptions {
	id: string;
	model: string;
	provider: string;
	timestamp: number;
	thinkingStartTime?: number;
}

export interface CoreAgentLoopAssistantMessage<
	TToolCall = unknown,
	TContentPart = unknown,
> {
	id: string;
	role: "assistant";
	model: string;
	provider: string;
	content: "";
	timestamp: number;
	isStreaming: true;
	thinkingStartTime: number;
	toolCalls: TToolCall[];
	contentParts: TContentPart[];
}

export interface CoreAgentLoopAssistantCreatedEvent<
	TMessage = CoreAgentLoopAssistantMessage,
> {
	type: "message:assistant-created";
	message: TMessage;
}

export interface CoreAgentLoopStreamStartEvent {
	type: "stream:start";
	messageId: string;
	assistantMessageId: string;
	model: string;
}

export interface CoreAgentLoopNextAssistantWriterPlan<
	TToolCall = unknown,
	TContentPart = unknown,
> {
	assistantMessage: CoreAgentLoopAssistantMessage<TToolCall, TContentPart>;
	events: [
		CoreAgentLoopAssistantCreatedEvent<
			CoreAgentLoopAssistantMessage<TToolCall, TContentPart>
		>,
		CoreAgentLoopStreamStartEvent,
	];
}

export interface CoreAgentLoopFinalMessageLike {
	content?: unknown;
	reasoning?: unknown;
	contentParts?: unknown;
	toolCalls?: unknown;
	steps?: unknown;
	usage?: unknown;
	errorDetails?: unknown;
}

export interface CoreAgentLoopSessionWithMessages<
	TMessage extends { id: string },
> {
	name?: string;
	messages: TMessage[];
}

export interface CoreAgentLoopFinalMessageUpdate<
	TMessage extends
		CoreAgentLoopFinalMessageLike = CoreAgentLoopFinalMessageLike,
> {
	content: TMessage["content"];
	reasoning: TMessage["reasoning"];
	contentParts: TMessage["contentParts"];
	toolCalls: TMessage["toolCalls"];
	steps: TMessage["steps"];
	usage: TMessage["usage"];
	errorDetails: TMessage["errorDetails"];
	isStreaming: false;
}

export interface CompleteAgentLoopStreamWithAdaptersOptions<
	TMessage extends CoreAgentLoopFinalMessageLike & { id: string },
	TSession extends CoreAgentLoopSessionWithMessages<TMessage>,
> {
	sessionId: string;
	assistantMessageId: string;
	sessionName?: string;
	accumulatedUsage?: CoreAgentLoopUsage;
	lastTurnUsage?: CoreAgentLoopLastTurnUsage;
	finalize: () => CoreMaybePromise<void>;
	getSession: (sessionId: string) => TSession | undefined;
	/** 读门面(P0.2 C1):缺席时回落到 `getSession` 的旧读法 */
	getMessage?: (sessionId: string, messageId: string) => TMessage | undefined;
	/** 收尾修复的落盘口(P0.2 F3),见 `EmitAgentLoopFinalMessageUpdateWithAdaptersOptions` */
	patchMessage?: (
		sessionId: string,
		messageId: string,
		patch: CoreAgentLoopLingeringRepair,
	) => void;
	emitMessageUpdated: (event: {
		type: "message:updated";
		messageId: string;
		updates: CoreAgentLoopFinalMessageUpdate<TMessage>;
	}) => CoreMaybePromise<void>;
	sendStreamComplete: (data: {
		sessionName?: string;
		usage?: CoreAgentLoopUsage;
		lastTurnUsage?: CoreAgentLoopLastTurnUsage;
	}) => CoreMaybePromise<void>;
}

export interface EmitAgentLoopFinalMessageUpdateWithAdaptersOptions<
	TMessage extends CoreAgentLoopFinalMessageLike & { id: string },
	TSession extends CoreAgentLoopSessionWithMessages<TMessage>,
> {
	sessionId: string;
	assistantMessageId: string;
	getSession: (sessionId: string) => TSession | undefined;
	/** 读门面(P0.2 C1):缺席时回落到 `getSession` 的旧读法 */
	getMessage?: (sessionId: string, messageId: string) => TMessage | undefined;
	/**
	 * 收尾修复的落盘口(P0.2 F3):`finalizeLingeringAgentLoopToolWork` 不再就地
	 * 改会话里那条消息,算出来的 patch 必须显式写回。缺席 = 只发事件不落盘。
	 */
	patchMessage?: (
		sessionId: string,
		messageId: string,
		patch: CoreAgentLoopLingeringRepair,
	) => void;
	emitMessageUpdated: (event: {
		type: "message:updated";
		messageId: string;
		updates: CoreAgentLoopFinalMessageUpdate<TMessage>;
	}) => CoreMaybePromise<void>;
	errorMessage?: string;
}

export function createAgentLoopExecutorTurnState<
	TToolCall = unknown,
	TContentPart = unknown,
>(): CoreAgentLoopExecutorTurnState<TToolCall, TContentPart> {
	return {
		toolCalls: [],
		content: { value: "" },
		reasoning: { value: "" },
		orderedParts: [],
		hasSentToolParts: false,
	};
}

export function rememberAgentLoopToolStepId(
	stepIdsByToolCallId: Map<string, string>,
	toolCallId: string,
	stepId: string | undefined,
): string | undefined {
	if (stepId) stepIdsByToolCallId.set(toolCallId, stepId);
	return stepId;
}

export function appendAgentLoopTurnToolCallOnce<
	TToolCall extends CoreAgentLoopToolCallIdentity,
>(turnToolCalls: TToolCall[], toolCall: TToolCall): boolean {
	if (turnToolCalls.some((existing) => existing.id === toolCall.id))
		return false;
	turnToolCalls.push(toolCall);
	return true;
}

export function planAgentLoopToolCallFallback<
	TToolCall extends CoreAgentLoopToolCallIdentity,
>(
	existingToolCalls: readonly TToolCall[],
	toolCall: CoreAgentLoopFallbackToolCallLike,
): CoreAgentLoopToolCallFallbackPlan {
	return {
		shouldStartPlaceholder: !existingToolCalls.some(
			(existing) => existing.id === toolCall.toolCallId,
		),
		toolCallId: toolCall.toolCallId,
		toolName: toolCall.toolName,
		args: toJsonObject(toolCall.args),
	};
}

export function createAgentLoopAssistantMessage<
	TToolCall = unknown,
	TContentPart = unknown,
>(
	options: CoreAgentLoopAssistantMessageOptions,
): CoreAgentLoopAssistantMessage<TToolCall, TContentPart> {
	return {
		id: options.id,
		role: "assistant",
		model: options.model,
		provider: options.provider,
		content: "",
		timestamp: options.timestamp,
		isStreaming: true,
		thinkingStartTime: options.thinkingStartTime ?? options.timestamp,
		toolCalls: [],
		contentParts: [],
	};
}

export function createAgentLoopNextAssistantWriterPlan<
	TToolCall = unknown,
	TContentPart = unknown,
>(
	options: CoreAgentLoopAssistantMessageOptions,
): CoreAgentLoopNextAssistantWriterPlan<TToolCall, TContentPart> {
	const assistantMessage = createAgentLoopAssistantMessage<
		TToolCall,
		TContentPart
	>(options);
	return {
		assistantMessage,
		events: [
			{
				type: "message:assistant-created",
				message: assistantMessage,
			},
			{
				type: "stream:start",
				messageId: assistantMessage.id,
				assistantMessageId: assistantMessage.id,
				model: assistantMessage.model,
			},
		],
	};
}

export function buildAgentLoopFinalMessageUpdate<
	TMessage extends CoreAgentLoopFinalMessageLike,
>(message: TMessage): CoreAgentLoopFinalMessageUpdate<TMessage> {
	return {
		content: message.content,
		reasoning: message.reasoning,
		contentParts: message.contentParts,
		toolCalls: message.toolCalls,
		steps: message.steps,
		usage: message.usage,
		errorDetails: message.errorDetails,
		isStreaming: false,
	};
}

const LINGERING_TOOL_CALL_STATUSES = new Set([
	"executing",
	"input-streaming",
	"queued",
	"pending",
]);
const LINGERING_STEP_STATUSES = new Set(["running", "pending"]);
const LINGERING_TOOL_ERROR =
	"Tool did not report completion before the stream ended.";

interface LingeringToolCallLike {
	status?: string;
	error?: string;
	endTime?: number;
	requiresConfirmation?: boolean;
}

/**
 * Backstop for stream end: no tool call or step may stay in an active state
 * once the final message update is emitted. Tool calls awaiting user
 * confirmation are preserved — that state legitimately survives stream end
 * (resume-after-confirm opens a new stream).
 */
/**
 * COW(F3/P0.2 area ①):不再就地改会话里的那条消息 —— 算出 `toolCalls` / `steps`
 * 的新数组当作一份 patch 返回,`undefined` = 没有需要收尾的活。落盘由调用方
 * 走命令面(`patchMessage`),而不是靠「对象是同一个」偷偷生效。
 */
export interface CoreAgentLoopLingeringRepair {
	toolCalls?: unknown[];
	steps?: unknown[];
}

export function finalizeLingeringAgentLoopToolWork(
	message: CoreAgentLoopFinalMessageLike,
	now = Date.now(),
	errorMessage?: string,
): CoreAgentLoopLingeringRepair | undefined {
	const error = errorMessage ?? LINGERING_TOOL_ERROR;
	/** 返回修好的**新** toolCall;undefined = 这条不用动。 */
	const cancelToolCall = (
		toolCall: LingeringToolCallLike,
	): LingeringToolCallLike | undefined => {
		if (toolCall.requiresConfirmation) return undefined;
		if (!LINGERING_TOOL_CALL_STATUSES.has(toolCall.status ?? "")) return undefined;
		return {
			...toolCall,
			status: "cancelled",
			endTime: toolCall.endTime ?? now,
			error: toolCall.error || error,
		};
	};

	const repair: CoreAgentLoopLingeringRepair = {};

	if (Array.isArray(message.toolCalls)) {
		let changed = false;
		const nextToolCalls = message.toolCalls.map((toolCall) => {
			if (!toolCall || typeof toolCall !== "object") return toolCall;
			const cancelled = cancelToolCall(toolCall as LingeringToolCallLike);
			if (!cancelled) return toolCall;
			changed = true;
			return cancelled;
		});
		if (changed) repair.toolCalls = nextToolCalls;
	}

	if (Array.isArray(message.steps)) {
		let changed = false;
		const nextSteps = message.steps.map((raw) => {
			if (!raw || typeof raw !== "object") return raw;
			const step = raw as {
				status?: string;
				error?: string;
				toolCall?: LingeringToolCallLike;
			};
			if (!LINGERING_STEP_STATUSES.has(step.status ?? "")) return raw;
			if (step.toolCall?.requiresConfirmation) return raw;
			changed = true;
			const cancelledToolCall = step.toolCall
				? cancelToolCall(step.toolCall)
				: undefined;
			return {
				...step,
				status: "cancelled",
				error: step.error || error,
				...(cancelledToolCall ? { toolCall: cancelledToolCall } : {}),
			};
		});
		if (changed) repair.steps = nextSteps;
	}

	return repair.toolCalls || repair.steps ? repair : undefined;
}

export async function emitAgentLoopFinalMessageUpdateWithAdapters<
	TMessage extends CoreAgentLoopFinalMessageLike & { id: string },
	TSession extends CoreAgentLoopSessionWithMessages<TMessage>,
>(
	options: EmitAgentLoopFinalMessageUpdateWithAdaptersOptions<
		TMessage,
		TSession
	>,
): Promise<boolean> {
	const updatedMessage = options.getMessage
		? options.getMessage(options.sessionId, options.assistantMessageId)
		: options
				.getSession(options.sessionId)
				?.messages.find(
					(message) => message.id === options.assistantMessageId,
				);
	if (!updatedMessage) return false;

	const repair = finalizeLingeringAgentLoopToolWork(
		updatedMessage,
		undefined,
		options.errorMessage,
	);
	// COW:修好的是新数组 —— 先落盘,再拿修好的那一份发事件。
	if (repair) {
		options.patchMessage?.(
			options.sessionId,
			options.assistantMessageId,
			repair,
		);
	}

	await options.emitMessageUpdated({
		type: "message:updated",
		messageId: options.assistantMessageId,
		updates: buildAgentLoopFinalMessageUpdate({
			...updatedMessage,
			...repair,
		} as TMessage),
	});
	return true;
}

export async function completeAgentLoopStreamWithAdapters<
	TMessage extends CoreAgentLoopFinalMessageLike & { id: string },
	TSession extends CoreAgentLoopSessionWithMessages<TMessage>,
>(
	options: CompleteAgentLoopStreamWithAdaptersOptions<TMessage, TSession>,
): Promise<void> {
	await options.finalize();
	const updatedSession = options.getSession(options.sessionId);
	await emitAgentLoopFinalMessageUpdateWithAdapters(options);

	await options.sendStreamComplete({
		sessionName: updatedSession?.name || options.sessionName,
		usage: options.accumulatedUsage,
		lastTurnUsage: options.lastTurnUsage,
	});
}

export function appendOrderedPart<TPart extends CoreOrderedPartLike>(
	parts: TPart[],
	part: TPart,
): void {
	const last = parts[parts.length - 1];
	if (
		part.type === "text" &&
		last?.type === "text" &&
		last.turnIndex === part.turnIndex
	) {
		last.content = `${last.content ?? ""}${part.content ?? ""}`;
		return;
	}
	if (
		part.type === "reasoning" &&
		last?.type === "reasoning" &&
		last.turnIndex === part.turnIndex
	) {
		last.content = `${last.content ?? ""}${part.content ?? ""}`;
		return;
	}
	parts.push(part);
}

export function planAgentLoopToolContentPartsDispatch<
	TPart extends CoreOrderedPartLike,
>(
	turn: Pick<
		CoreAgentLoopExecutorTurnState<unknown, TPart>,
		"orderedParts" | "hasSentToolParts"
	>,
	turnIndex: number,
): CoreAgentLoopToolContentPartDispatchPlan<TPart> {
	if (turn.hasSentToolParts) {
		return { shouldSend: false, parts: [] };
	}
	return {
		shouldSend: true,
		parts: turn.orderedParts.filter((part) => part.type !== "provider-data"),
		dataStepsPart: { type: "data-steps", turnIndex },
	};
}

export function planAgentLoopTurnContentPersistence<
	TPart extends CoreOrderedPartLike,
>(
	turn: Pick<
		CoreAgentLoopExecutorTurnState<unknown, TPart>,
		"orderedParts" | "toolCalls"
	>,
	turnIndex: number,
): CoreAgentLoopTurnContentPersistencePlan<TPart> {
	const hasToolCalls = turn.toolCalls.length > 0;
	// The live dispatch may have recorded the steps anchor inline (external
	// agents interleave text → tools → text within one turn); persisting a
	// second anchor at the end would yank the step cards below the trailing
	// text once the stream settles.
	const hasInlineStepsAnchor = turn.orderedParts.some(
		(part) => part.type === "data-steps",
	);
	return {
		persistParts:
			hasToolCalls && !hasInlineStepsAnchor
				? [...turn.orderedParts, { type: "data-steps", turnIndex }]
				: [...turn.orderedParts],
		immediateParts: hasToolCalls
			? []
			: turn.orderedParts.filter((part) => part.type !== "provider-data"),
	};
}

export function dispatchAgentLoopToolContentPartsWithAdapters<
	TPart extends CoreOrderedPartLike,
>(
	options: DispatchAgentLoopToolContentPartsOptions<TPart>,
): CoreAgentLoopToolContentPartDispatchPlan<TPart> {
	const plan = planAgentLoopToolContentPartsDispatch(
		options.turn,
		options.turnIndex,
	);
	if (!plan.shouldSend) return plan;

	options.turn.hasSentToolParts = true;
	for (const part of plan.parts) {
		options.emitter.sendContentPart(part);
	}
	if (plan.dataStepsPart) {
		options.emitter.sendContentPart(plan.dataStepsPart);
		// Record the anchor position so persistence keeps the step cards where
		// the viewer saw them during streaming (text after the tool call stays
		// after the cards).
		appendOrderedPart(
			options.turn.orderedParts,
			plan.dataStepsPart as unknown as TPart,
		);
	}
	return plan;
}

export function persistAgentLoopTurnContentPartsWithAdapters<
	TPart extends CoreOrderedPartLike,
>(
	options: PersistAgentLoopTurnContentPartsOptions<TPart>,
): CoreAgentLoopTurnContentPersistencePlan<TPart> {
	const plan = planAgentLoopTurnContentPersistence(
		options.turn,
		options.turnIndex,
	);

	for (const part of plan.persistParts) {
		options.store.addMessageContentPart(
			options.sessionId,
			options.assistantMessageId,
			part,
		);
	}

	for (const part of plan.immediateParts) {
		options.emitter.sendContentPart(part);
	}

	return plan;
}

export function hasAgentLoopVisibleTurnActivity<
	TToolCall,
	TPart extends CoreOrderedPartLike,
>(
	turn: Pick<
		CoreAgentLoopExecutorTurnState<TToolCall, TPart>,
		"content" | "toolCalls" | "hasSentToolParts" | "orderedParts"
	>,
): boolean {
	return (
		turn.content.value.length > 0 ||
		turn.toolCalls.length > 0 ||
		turn.hasSentToolParts ||
		turn.orderedParts.some((part) => part.type !== "provider-data")
	);
}

export function getAgentLoopReasoningPlacement<
	TToolCall,
	TPart extends CoreOrderedPartLike,
>(options: {
	turnIndex: number;
	accumulatedContent: string;
	turn: Pick<
		CoreAgentLoopExecutorTurnState<TToolCall, TPart>,
		"content" | "toolCalls" | "hasSentToolParts" | "orderedParts"
	>;
}): CoreAgentLoopReasoningPlacement {
	return options.turnIndex === 1 &&
		options.accumulatedContent.length === 0 &&
		!hasAgentLoopVisibleTurnActivity(options.turn)
		? "top"
		: "inline";
}

export function resultText(result: CoreAgentToolResultLike): string {
	if (result.error) return result.error;
	if (result.content) return result.content;
	if (result.data == null) return "";
	if (typeof result.data === "string") return result.data;
	try {
		return JSON.stringify(result.data);
	} catch {
		return String(result.data);
	}
}

export function structuredToolResult(
	result: CoreAgentToolResultLike,
): CoreToolResult {
	return {
		content: [{ type: "text", text: resultText(result) }],
		details:
			result.data && typeof result.data === "object"
				? toJsonObject(result.data)
				: undefined,
	};
}

export function textFromPartialResult(
	update: CoreToolPartialResultUpdate,
): string {
	const text = update.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
	return text || JSON.stringify(update);
}

export function changesFromMetadata(
	metadata: JsonObject | undefined,
): CoreToolCallChanges | undefined {
	if (!metadata?.diff || !metadata.path) return undefined;
	return {
		diff: String(metadata.diff),
		hunks: coreDiffHunksFromJson(metadata.diffHunks),
		filePath: String(metadata.path),
		additions: Number(metadata.additions) || 0,
		deletions: Number(metadata.deletions) || 0,
		originalContentHash:
			typeof metadata.originalContentHash === "string"
				? metadata.originalContentHash
				: undefined,
		afterContentHash:
			typeof metadata.afterContentHash === "string"
				? metadata.afterContentHash
				: undefined,
		auditId:
			typeof metadata.auditId === "string" ? metadata.auditId : undefined,
		auditPath:
			typeof metadata.auditPath === "string" ? metadata.auditPath : undefined,
	};
}

export function applyAgentLoopToolMetadata<
	TToolCall extends CoreAgentLoopToolCallWithMetadata,
>(
	toolCall: TToolCall | undefined,
	update: CoreAgentLoopToolMetadataUpdate,
): CoreAgentLoopStepMetadataUpdate<TToolCall> {
	const metadataUpdates: CoreAgentLoopStepMetadataUpdate<TToolCall> = {};
	if (update.title && typeof update.title === "string") {
		metadataUpdates.title = update.title;
	}
	if (update.metadata) {
		if (typeof update.metadata.output === "string") {
			metadataUpdates.result = update.metadata.output;
		} else if (Object.keys(update.metadata).length > 0) {
			metadataUpdates.result = JSON.stringify(update.metadata);
		}

		const changes = changesFromMetadata(update.metadata);
		if (changes && toolCall) {
			// COW(F3):新对象,不动入参。
			metadataUpdates.toolCall = { ...toolCall, changes };
		}
	}
	return metadataUpdates;
}

export function buildAgentLoopToolPartialStepUpdate<
	TPartialResult extends CoreToolPartialResultUpdate,
>(update: TPartialResult): CoreAgentLoopToolPartialStepUpdate<TPartialResult> {
	return {
		status: "running",
		partialResult: update,
		partialResultIsPartial: true,
		result: textFromPartialResult(update),
	};
}

export function buildAgentLoopToolStartStepUpdate<TToolCall>(
	toolCall: TToolCall,
): CoreAgentLoopToolStartStepUpdate<TToolCall> {
	return {
		status: "running",
		toolCall: { ...toolCall },
	};
}

export function agentLoopToolResultStepStatus(
	toolCall: Pick<CoreAgentLoopToolCallForSettlement, "status">,
): Exclude<CoreAgentLoopToolResultStepStatus, "awaiting-confirmation"> {
	if (toolCall.status === "completed") return "completed";
	if (toolCall.status === "cancelled") return "cancelled";
	return "failed";
}

function objectData(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * 技能复盘计数器的「刚写过技能就重置」信号。skill_manage 工具已移除,技能改由
 * write/edit 直接落文件,这里没有可识别的专用调用了 —— 保留这个 hook 是为了让
 * 计数契约保持单一入口,想恢复重置语义时改这一处即可。
 */
export function isSkillManageToolCall(
	_toolCall: Pick<CoreAgentLoopToolCallForSettlement, "toolId" | "toolName">,
): boolean {
	return false;
}

/** COW(F3):返回**新的** toolCall,入参一个字段都不动。 */
export function settleAgentLoopToolCallResult<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
>(
	toolCall: TToolCall,
	result: CoreAgentToolResultLike,
	now = Date.now(),
): CoreSettledAgentLoopToolCallResult<TToolCall> {
	const data = objectData(result.data);
	const commandType =
		result.commandType ??
		(typeof data.commandType === "string" ? data.commandType : undefined);

	if (result.requiresConfirmation) {
		const settled = {
			...toolCall,
			endTime: now,
			status: "pending",
			requiresConfirmation: true,
			commandType,
			error: result.error,
		};
		return {
			toolCall: settled,
			awaitingConfirmation: true,
			skillManageCalled: isSkillManageToolCall(settled),
		};
	}

	const settled = {
		...toolCall,
		endTime: now,
		status: result.error ? (data.aborted ? "cancelled" : "failed") : "completed",
		...(toolCall.startTime != null
			? { durationMs: Math.max(0, now - toolCall.startTime) }
			: {}),
		result: toJsonValue(result.data ?? result.content),
		error: result.error,
		rejected: data.rejected === true || undefined,
		rejectionReason:
			typeof data.rejectionReason === "string" ? data.rejectionReason : undefined,
		requiresConfirmation: false,
	};

	return {
		toolCall: settled,
		awaitingConfirmation: false,
		skillManageCalled: isSkillManageToolCall(settled),
	};
}

export function buildAgentLoopToolResultPresentation<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
>(
	toolCall: TToolCall,
	result: CoreAgentToolResultLike,
	awaitingConfirmation = false,
): CoreAgentLoopToolResultPresentation<TToolCall> {
	if (awaitingConfirmation) {
		return {
			stepUpdate: {
				status: "awaiting-confirmation",
				toolCall: { ...toolCall },
				error: result.error,
			},
		};
	}

	const structured = structuredToolResult(result);
	return {
		executionEnd: {
			result: result.error ? undefined : structured,
			isError: Boolean(result.error),
			error: result.error,
		},
		stepUpdate: {
			status: agentLoopToolResultStepStatus(toolCall),
			toolCall: { ...toolCall },
			partialResult: result.error ? undefined : structured,
			partialResultIsPartial: false,
			result: resultText(result),
			error: result.error,
			rejected: toolCall.rejected,
			rejectionReason: toolCall.rejectionReason,
		},
	};
}

/** 返回**开跑后的那一版** toolCall(COW,F3):调用方别再用手里的旧引用。 */
export function startAgentLoopToolExecution<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
>(options: StartAgentLoopToolExecutionOptions<TToolCall, TStepUpdate>): TToolCall {
	const now = options.now ?? Date.now;
	// COW(F3):换出新对象换进工作表,交给 store 的是快照。
	const toolCall = patchCoreToolCall(options.toolCalls, options.toolCall, {
		status: "executing",
		startTime: options.toolCall.startTime ?? now(),
	} as Partial<TToolCall>);
	options.store.updateMessageToolCalls(
		options.sessionId,
		options.assistantMessageId,
		coreToolCallSnapshot(options.toolCalls),
	);
	options.emitter.sendToolCall(toolCall);

	if (!options.stepId) return toolCall;

	options.emitter.sendToolExecutionStart(
		toolCall.id,
		options.stepId,
		toolCall.toolId ?? toolCall.toolName,
		toJsonObject(toolCall.arguments),
		toolCall.startTime,
	);
	options.emitter.sendStepUpdated(
		options.stepId,
		buildAgentLoopToolStartStepUpdate(toolCall) as TStepUpdate,
	);
	return toolCall;
}

export function settleAgentLoopToolResultWithAdapters<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
>(
	options: SettleAgentLoopToolResultOptions<
		TToolCall,
		TStepUpdate,
		TToolResult
	>,
): CoreAgentLoopToolResultSettlementResult<TToolCall> {
	const toolCall = options.toolCalls.find(
		(existing) => existing.id === options.toolCallId,
	);
	if (!toolCall) {
		return {
			found: false,
			toolIterationsDelta: 0,
			skillManageCalled: false,
			awaitingConfirmation: false,
		};
	}

	const settlement = settleAgentLoopToolCallResult(
		toolCall,
		options.result,
		(options.now ?? Date.now)(),
	);
	// COW(F3):结算后的那一版换进工作表,再整表快照写回。
	const settled = replaceCoreToolCall(options.toolCalls, settlement.toolCall);
	options.store.updateMessageToolCalls(
		options.sessionId,
		options.assistantMessageId,
		coreToolCallSnapshot(options.toolCalls),
	);
	options.emitter.sendToolResult(settled);

	const stepId = options.stepIdsByToolCallId.get(options.toolCallId);
	if (stepId) {
		const presentation = buildAgentLoopToolResultPresentation(
			settled,
			options.result,
			settlement.awaitingConfirmation,
		);
		if (presentation.executionEnd) {
			options.emitter.sendToolExecutionEnd(
				settled.id,
				stepId,
				presentation.executionEnd.result as TToolResult | undefined,
				presentation.executionEnd.isError,
				presentation.executionEnd.error,
				settled.durationMs,
			);
		}
		options.emitter.sendStepUpdated(
			stepId,
			presentation.stepUpdate as TStepUpdate,
		);
	}

	return {
		found: true,
		toolCall: settled,
		toolIterationsDelta: 1,
		skillManageCalled: settlement.skillManageCalled,
		awaitingConfirmation: settlement.awaitingConfirmation,
	};
}

export function applyAgentLoopToolInputStartWithAdapters<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
>(
	options: ApplyAgentLoopToolInputStartWithAdaptersOptions<
		TContentPart,
		TToolCall,
		TStepUpdate
	>,
): string | undefined {
	dispatchAgentLoopToolContentPartsWithAdapters({
		turn: options.turn,
		turnIndex: options.turnIndex,
		emitter: options.emitter,
	});
	options.processor.handleToolInputStart(
		options.toolCallId,
		options.toolName,
		options.turnIndex,
	);
	return rememberAgentLoopToolStepId(
		options.stepIdsByToolCallId,
		options.toolCallId,
		options.processor.getStepIdForToolCall(options.toolCallId),
	);
}

export function applyAgentLoopToolInputDeltaWithAdapters<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
>(
	processor: Pick<
		CoreAgentLoopToolInputProcessor<TToolCall>,
		"handleToolInputDelta"
	>,
	toolCallId: string,
	argsTextDelta: string,
): void {
	processor.handleToolInputDelta(toolCallId, argsTextDelta);
}

export function applyAgentLoopToolInputEndWithAdapters<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
>(
	options: ApplyAgentLoopToolInputEndWithAdaptersOptions<
		TContentPart,
		TToolCall,
		TStepUpdate
	>,
): CoreAgentLoopToolChunkApplyResult<TToolCall> {
	const stepId = rememberAgentLoopToolStepId(
		options.stepIdsByToolCallId,
		options.toolCallId,
		options.processor.getStepIdForToolCall(options.toolCallId),
	);
	const toolCall = options.processor.handleToolInputEnd(options.toolCallId, {
		finalizedBy: options.finalizedBy ?? "parse",
	});
	if (!toolCall) return { found: false };

	appendAgentLoopTurnToolCallOnce(options.turn.toolCalls, toolCall);
	const started = startAgentLoopToolExecution<TToolCall, TStepUpdate>({
		sessionId: options.sessionId,
		assistantMessageId: options.assistantMessageId,
		toolCall,
		toolCalls: options.processor.toolCalls,
		stepId,
		store: options.store,
		emitter: options.emitter,
		now: options.now,
	});
	replaceCoreToolCall(options.turn.toolCalls, started);
	return { found: true, toolCall: started };
}

export function applyAgentLoopToolCallFallbackWithAdapters<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
>(
	options: ApplyAgentLoopToolCallFallbackWithAdaptersOptions<
		TContentPart,
		TToolCall,
		TStepUpdate
	>,
): TToolCall {
	dispatchAgentLoopToolContentPartsWithAdapters({
		turn: options.turn,
		turnIndex: options.turnIndex,
		emitter: options.emitter,
	});

	const plan = planAgentLoopToolCallFallback(
		options.processor.toolCalls,
		options.toolCall,
	);
	if (plan.shouldStartPlaceholder) {
		options.processor.handleToolInputStart(
			plan.toolCallId,
			plan.toolName,
			options.turnIndex,
		);
		rememberAgentLoopToolStepId(
			options.stepIdsByToolCallId,
			plan.toolCallId,
			options.processor.getStepIdForToolCall(plan.toolCallId),
		);
	}

	const created = options.processor.handleToolCallComplete
		? options.processor.handleToolCallComplete(
				{
					toolCallId: plan.toolCallId,
					toolName: plan.toolName,
					args: plan.args,
				},
				{ finalizedBy: options.finalizedBy ?? "provider-done" },
			)
		: options.processor.handleToolCallChunk({
				toolCallId: plan.toolCallId,
				toolName: plan.toolName,
				args: plan.args,
			});
	appendAgentLoopTurnToolCallOnce(options.turn.toolCalls, created);
	const started = startAgentLoopToolExecution<TToolCall, TStepUpdate>({
		sessionId: options.sessionId,
		assistantMessageId: options.assistantMessageId,
		toolCall: created,
		toolCalls: options.processor.toolCalls,
		stepId: options.stepIdsByToolCallId.get(created.id),
		store: options.store,
		emitter: options.emitter,
		now: options.now,
	});
	replaceCoreToolCall(options.turn.toolCalls, started);
	return started;
}

export function applyAgentLoopToolResultWithAdapters<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
>(
	options: ApplyAgentLoopToolResultWithAdaptersOptions<
		TToolCall,
		TStepUpdate,
		TToolResult
	>,
): CoreAgentLoopToolResultSettlementResult<TToolCall> {
	const settlement = settleAgentLoopToolResultWithAdapters(options);
	if (!settlement.found) return settlement;

	options.state.toolIterations += settlement.toolIterationsDelta;
	if (settlement.skillManageCalled) {
		options.state.skillManageCalled = true;
	}
	return settlement;
}

export function applyAgentLoopToolMetadataWithAdapters<
	TToolCall extends CoreAgentLoopToolCallWithMetadata,
	TStepUpdate,
>(options: ApplyAgentLoopToolMetadataOptions<TToolCall, TStepUpdate>): boolean {
	const stepId = options.stepIdsByToolCallId.get(options.toolCallId);
	if (!stepId) return false;

	const toolCall = options.toolCalls.find(
		(existing) => "id" in existing && existing.id === options.toolCallId,
	);
	const metadataUpdates = applyAgentLoopToolMetadata(toolCall, options.update);
	if (Object.keys(metadataUpdates).length === 0) return false;

	options.emitter.sendStepUpdated(stepId, metadataUpdates as TStepUpdate);
	return true;
}

export function applyAgentLoopToolPartialResultWithAdapters<
	TToolCall,
	TStepUpdate,
	TPartialResult extends
		CoreToolPartialResultUpdate = CoreToolPartialResultUpdate,
>(
	options: ApplyAgentLoopToolPartialResultOptions<
		TToolCall,
		TStepUpdate,
		TPartialResult
	>,
): boolean {
	const stepId = options.stepIdsByToolCallId.get(options.toolCallId);
	if (!stepId) return false;

	options.emitter.sendToolExecutionUpdate(
		options.toolCallId,
		stepId,
		options.update,
	);
	options.emitter.sendStepUpdated(
		stepId,
		buildAgentLoopToolPartialStepUpdate(options.update) as TStepUpdate,
	);
	return true;
}

export function planAgentLoopProviderData(
	providerData: CoreAgentProviderDataLike,
	options: CoreAgentLoopProviderDataPlanContext & {
		planProviderData?: (
			providerData: CoreAgentProviderDataLike,
			context: CoreAgentLoopProviderDataPlanContext,
		) => CoreAgentLoopProviderDataPlan;
	},
): CoreAgentLoopProviderDataPlan {
	const context: CoreAgentLoopProviderDataPlanContext = {
		turnIndex: options.turnIndex,
		latestUserPrompt: options.latestUserPrompt,
		model: options.model,
		sessionId: options.sessionId,
		messageId: options.messageId,
	};
	const planned = options.planProviderData?.(providerData, context);
	if (planned) return planned;

	return {
		kind: "provider-data",
		orderedPart: {
			type: "provider-data",
			providerData,
			turnIndex: options.turnIndex,
		},
	};
}

export async function applyAgentLoopProviderDataWithAdapters<
	TContentPart extends CoreOrderedPartLike,
>(
	options: ApplyAgentLoopProviderDataWithAdaptersOptions<TContentPart>,
): Promise<boolean> {
	const applied = await options.applyProviderData?.({
		providerData: options.providerData,
		turnIndex: options.turnIndex,
		latestUserPrompt: options.latestUserPrompt,
		model: options.model,
		sessionId: options.sessionId,
		messageId: options.messageId,
		content: options.content,
		orderedParts: options.orderedParts,
		emitter: options.emitter,
		handleTextChunk: options.handleTextChunk,
	});
	if (typeof applied === "boolean") return applied;

	const plan = planAgentLoopProviderData(options.providerData, {
		turnIndex: options.turnIndex,
		latestUserPrompt: options.latestUserPrompt,
		model: options.model,
		sessionId: options.sessionId,
		messageId: options.messageId,
		planProviderData: options.planProviderData,
	});

	if (plan.kind === "ignore") {
		return false;
	}

	if (plan.kind === "provider-data") {
		appendOrderedPart(
			options.orderedParts,
			plan.orderedPart as unknown as TContentPart,
		);
		return true;
	}

	return false;
}

export async function applyAgentLoopTurnStartWithAdapters(
	options: ApplyAgentLoopTurnStartWithAdaptersOptions,
): Promise<void> {
	options.state.turnIndex = options.turn;
	if (options.turn > 1 && options.state.createNewAssistantOnNextTurnStart) {
		options.state.createNewAssistantOnNextTurnStart = false;
		await options.createNextAssistantWriter();
		options.state.turnIndex = options.turn;
	}
}

export async function applyAgentLoopStreamChunkWithAdapters<
	TContentPart extends CoreOrderedPartLike,
	TToolCall extends CoreAgentLoopToolCallForSettlement,
	TStepUpdate,
	TToolResult = CoreToolResult,
>(
	options: ApplyAgentLoopStreamChunkWithAdaptersOptions<
		TContentPart,
		TToolCall,
		TStepUpdate,
		TToolResult
	>,
): Promise<unknown> {
	const { chunk, state } = options;

	if (chunk.type === "turn-start" && chunk.turnStart) {
		return applyAgentLoopTurnStartWithAdapters({
			state,
			turn: chunk.turnStart.turn,
			createNextAssistantWriter: options.createNextAssistantWriter,
		});
	}

	// Steering interrupt: an injected user message ended the current
	// response mid tool-call-loop. Arrives after the previous turn's finish
	// chunk (which resets the flag on the tool-calls path) and before the
	// next turn-start, which consumes it and opens a fresh assistant message.
	if (chunk.type === "response-boundary" && chunk.responseBoundary) {
		state.createNewAssistantOnNextTurnStart = true;
		return true;
	}

	if (chunk.type === "text" && chunk.text) {
		return applyAgentLoopTextChunkWithAdapters<TContentPart>({
			text: chunk.text,
			turnIndex: state.turnIndex,
			content: state.turn.content,
			orderedParts: state.turn.orderedParts,
			handleTextChunk: options.handleTextChunk,
		});
	}

	if (chunk.type === "reasoning" && chunk.reasoning) {
		return applyAgentLoopReasoningChunkWithAdapters<TContentPart>({
			reasoning: chunk.reasoning,
			turnIndex: state.turnIndex,
			accumulatedContent: options.accumulatedContent,
			turn: state.turn,
			handleReasoningChunk: options.handleReasoningChunk,
		});
	}

	if (chunk.type === "tool-input-start" && chunk.toolInputStart) {
		return applyAgentLoopToolInputStartWithAdapters<
			TContentPart,
			TToolCall,
			TStepUpdate
		>({
			turn: state.turn,
			turnIndex: state.turnIndex,
			toolCallId: chunk.toolInputStart.toolCallId,
			toolName: chunk.toolInputStart.toolName,
			processor: options.processor,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			emitter: options.emitter,
		});
	}

	if (chunk.type === "tool-input-delta" && chunk.toolInputDelta) {
		applyAgentLoopToolInputDeltaWithAdapters(
			options.processor,
			chunk.toolInputDelta.toolCallId,
			chunk.toolInputDelta.argsTextDelta,
		);
		return true;
	}

	if (chunk.type === "tool-input-end" && chunk.toolInputEnd) {
		return applyAgentLoopToolInputEndWithAdapters<
			TContentPart,
			TToolCall,
			TStepUpdate
		>({
			sessionId: options.sessionId,
			assistantMessageId: options.assistantMessageId,
			toolCallId: chunk.toolInputEnd.toolCallId,
			finalizedBy: chunk.toolInputEnd.finalizedBy,
			turn: state.turn,
			processor: options.processor,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			store: options.store,
			emitter: options.emitter,
			now: options.now,
		});
	}

	if (chunk.type === "tool-call" && chunk.toolCall) {
		return applyAgentLoopToolCallFallbackWithAdapters<
			TContentPart,
			TToolCall,
			TStepUpdate
		>({
			sessionId: options.sessionId,
			assistantMessageId: options.assistantMessageId,
			turn: state.turn,
			turnIndex: state.turnIndex,
			toolCall: chunk.toolCall,
			finalizedBy: chunk.toolCall.finalizedBy ?? "provider-done",
			processor: options.processor,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			store: options.store,
			emitter: options.emitter,
			now: options.now,
		});
	}

	if (chunk.type === "tool-result" && chunk.toolResult) {
		return applyAgentLoopToolResultWithAdapters<
			TToolCall,
			TStepUpdate,
			TToolResult
		>({
			state,
			sessionId: options.sessionId,
			assistantMessageId: options.assistantMessageId,
			toolCallId: chunk.toolResult.toolCallId,
			result: chunk.toolResult.result,
			toolCalls: options.processor.toolCalls,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			store: options.store,
			emitter: options.emitter,
			now: options.now,
		});
	}

	if (chunk.type === "tool-metadata" && chunk.toolMetadata) {
		return applyAgentLoopToolMetadataWithAdapters<
			TToolCall & CoreAgentLoopToolCallWithMetadata,
			TStepUpdate
		>({
			toolCallId: chunk.toolMetadata.toolCallId,
			update: chunk.toolMetadata.update,
			toolCalls: options.processor.toolCalls as Array<
				TToolCall & CoreAgentLoopToolCallWithMetadata
			>,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			emitter: options.emitter,
		});
	}

	if (chunk.type === "tool-partial-result" && chunk.toolPartialResult) {
		return applyAgentLoopToolPartialResultWithAdapters<TToolCall, TStepUpdate>({
			toolCallId: chunk.toolPartialResult.toolCallId,
			update: chunk.toolPartialResult.update,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			emitter: options.emitter,
		});
	}

	if (chunk.type === "provider-data" && chunk.providerData) {
		return applyAgentLoopProviderDataWithAdapters<TContentPart>({
			providerData: chunk.providerData,
			turnIndex: state.turnIndex,
			latestUserPrompt: state.latestUserPrompt,
			model: options.model,
			sessionId: options.sessionId,
			messageId: options.assistantMessageId,
			content: state.turn.content,
			orderedParts: state.turn.orderedParts,
			emitter: options.emitter,
			handleTextChunk: options.handleTextChunk,
			planProviderData: options.planProviderData,
			applyProviderData: options.applyProviderData,
		});
	}

	if (chunk.type === "finish") {
		return applyAgentLoopFinishChunkWithAdapters({
			state,
			usage: chunk.usage,
			finishReason: chunk.finishReason,
			syncAccumulatedUsage: options.syncAccumulatedUsage,
			syncLastTurnUsage: options.syncLastTurnUsage,
			updateStepsUsageByTurn: options.updateStepsUsageByTurn,
			sendContextSizeUpdate: (inputTokens) =>
				options.emitter.sendContextSizeUpdate(inputTokens),
			persistTurnContentParts: options.persistTurnContentParts,
			createTurnState: options.createTurnState,
			sendContinuation: (turnIndex) =>
				options.emitter.sendContinuation(turnIndex),
		});
	}

	return false;
}

export async function executeAgentLoopStreamLifecycleWithAdapters<
	TPrepared,
	TSupportedPrepared extends TPrepared,
>(
	options: ExecuteAgentLoopStreamLifecycleWithAdaptersOptions<
		TPrepared,
		TSupportedPrepared
	>,
): Promise<CoreAgentLoopStreamGenerationResult> {
	const startedAt = options.now?.() ?? Date.now();

	try {
		const prepared = await options.prepareRuntime();
		if (!options.isRuntimeSupported(prepared)) {
			throw new Error(options.unsupportedReason(prepared));
		}

		await options.emitStreamStart();

		for await (const chunk of options.streamChunks(prepared)) {
			await options.applyChunk(chunk);
		}

		await options.updateUsage?.((options.now?.() ?? Date.now()) - startedAt);
		await options.completeStream(prepared);
		await options.runPostResponseHooks(prepared);
		return { pausedForConfirmation: false };
	} catch (error) {
		const caught = error instanceof Error ? error : new Error(String(error));
		if (isAgentLoopPauseForConfirmationError(caught)) {
			return { pausedForConfirmation: true };
		}

		await options.finalize();

		if (options.isAbortError(caught)) {
			await options.emitFinalAssistantMessageUpdate("User cancelled");
			await options.sendStreamAborted("User cancelled");
			return { pausedForConfirmation: false };
		}

		const errorContent = caught.message || "Agent loop streaming error";
		await options.updateMessageError(errorContent);
		await options.emitFinalAssistantMessageUpdate();
		await options.sendStreamError({
			error: errorContent,
			preserved: true,
		});
		await options.sendStreamComplete({
			sessionName: options.getSessionName?.(),
			error: errorContent,
		});
		return { pausedForConfirmation: false };
	}
}

export function applyAgentLoopTextChunkWithAdapters<
	TContentPart extends CoreOrderedPartLike,
>(options: ApplyAgentLoopTextChunkWithAdaptersOptions<TContentPart>): boolean {
	const displayContent = options.handleTextChunk(
		options.text,
		options.content,
		options.turnIndex,
	);
	if (!displayContent) return false;

	appendOrderedPart(options.orderedParts, {
		type: "text",
		content: displayContent,
		turnIndex: options.turnIndex,
	} as TContentPart);
	return true;
}

export function applyAgentLoopReasoningChunkWithAdapters<
	TContentPart extends CoreOrderedPartLike,
>(
	options: ApplyAgentLoopReasoningChunkWithAdaptersOptions<TContentPart>,
): CoreAgentLoopReasoningPlacement {
	const placement = getAgentLoopReasoningPlacement({
		turnIndex: options.turnIndex,
		accumulatedContent: options.accumulatedContent,
		turn: options.turn,
	});
	options.handleReasoningChunk(
		options.reasoning,
		options.turn.reasoning,
		options.turnIndex,
		placement,
	);
	if (placement === "inline") {
		appendOrderedPart(options.turn.orderedParts, {
			type: "reasoning",
			content: options.reasoning,
			turnIndex: options.turnIndex,
		} as TContentPart);
	}
	return placement;
}

export function enabledToolNames(prepared: CorePreparedToolNames): string[] {
	return [...prepared.toolNames, ...prepared.mcpToolNames];
}

export function lastUserMessageText(
	historyMessages: CoreHistoryMessageWithContent[],
): string {
	for (let index = historyMessages.length - 1; index >= 0; index--) {
		const message = historyMessages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string" || Array.isArray(message.content)) {
			return getTextFromContent(message.content as CoreAIMessageContent);
		}
		return "";
	}
	return "";
}

function lastAssistantMessageText(
	historyMessages: CoreHistoryMessageWithContent[],
): string {
	for (let index = historyMessages.length - 1; index >= 0; index--) {
		const message = historyMessages[index];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string" || Array.isArray(message.content)) {
			const text = getTextFromContent(message.content as CoreAIMessageContent);
			if (text) return text;
		}
	}
	return "";
}

export function buildAgentLoopPostResponseContexts<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
>(input: {
	session: TSession | undefined;
	sessionId: string;
	assistantMessageId: string;
	lastAssistantMessage: string | undefined;
	historyMessages: CoreHistoryMessageWithContent[];
	providerId: string;
	providerConfig: TProviderConfig;
	settings: TSettings;
	toolIterations: number;
	skillManageCalled: boolean;
	prepared: CorePreparedToolNames;
	promptCapture?: CorePromptCapture;
}): CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings
> | null {
	if (!input.session) return null;

	// A run cut off (max_turns, stream loss) can end with no trailing assistant
	// text. Post-response hooks (goal cross-run continuation, triggers) must
	// still fire, so fall back to the last assistant text in history, then to a
	// synthetic placeholder.
	const lastAssistantMessage = input.lastAssistantMessage?.trim()
		? input.lastAssistantMessage
		: lastAssistantMessageText(input.historyMessages) ||
			"(assistant turn ended without trailing text)";

	const triggerContext: CoreAgentLoopPostResponseTriggerContext<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	> = {
		sessionId: input.sessionId,
		session: input.session,
		messages: input.session.messages,
		lastUserMessage: lastUserMessageText(input.historyMessages),
		lastAssistantMessage,
		providerId: input.providerId,
		providerConfig: input.providerConfig,
		settings: input.settings,
		toolIterations: input.toolIterations,
		skillManageCalled: input.skillManageCalled,
		enabledToolNames: enabledToolNames(input.prepared),
		promptCapture: input.promptCapture,
	};

	return {
		triggerContext,
		afterAssistantResponseContext: {
			...triggerContext,
			assistantMessageId: input.assistantMessageId,
			// F4:身份透传。会话本体已经带着它,这里只是把它摊到 ctx 的一等字段上,
			// 免得每个插件各写一遍 `(ctx.session as any).agentId`。
			...(input.session.agentId ? { agentId: input.session.agentId } : {}),
		},
	};
}

export function runAgentLoopPostResponseHooksWithAdapters<
	TSession extends CoreAgentLoopPostResponseSession<TMessage>,
	TMessage,
	TProviderConfig,
	TSettings,
>(
	options: RunAgentLoopPostResponseHooksWithAdaptersOptions<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>,
): CoreAgentLoopPostResponseContexts<
	TSession,
	TMessage,
	TProviderConfig,
	TSettings
> | null {
	const contexts = buildAgentLoopPostResponseContexts<
		TSession,
		TMessage,
		TProviderConfig,
		TSettings
	>({
		session: options.getSession(options.sessionId),
		sessionId: options.sessionId,
		assistantMessageId: options.assistantMessageId,
		lastAssistantMessage: options.lastAssistantMessage,
		historyMessages: options.historyMessages,
		providerId: options.providerId,
		providerConfig: options.providerConfig,
		settings: options.settings,
		toolIterations: options.toolIterations,
		skillManageCalled: options.skillManageCalled,
		prepared: options.prepared,
		promptCapture: options.promptCapture,
	});
	if (!contexts) return null;

	const run = (
		source: "trigger" | "afterAssistantResponse",
		callback: () => void | Promise<void>,
	): void => {
		try {
			Promise.resolve(callback()).catch((error) =>
				options.onError?.(source, error),
			);
		} catch (error) {
			options.onError?.(source, error);
		}
	};

	run("trigger", () => options.runTriggerContext(contexts.triggerContext));
	run("afterAssistantResponse", () =>
		options.runAfterAssistantResponse(contexts.afterAssistantResponseContext),
	);

	return contexts;
}

export function planAgentLoopFinishChunk(input: {
	turnIndex: number;
	accumulatedUsage?: CoreAgentLoopUsage;
	usage?: CoreAgentLoopUsage;
	finishReason?: string;
}): CoreAgentLoopFinishPlan {
	let accumulatedUsage = input.accumulatedUsage;
	let lastTurnUsage: CoreAgentLoopUsage | undefined;
	let contextSizeInputTokens: number | undefined;

	if (input.usage) {
		const usage = input.usage;
		const sumOptional = (
			a: number | undefined,
			b: number | undefined,
		): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
		accumulatedUsage = accumulatedUsage
			? {
					inputTokens: accumulatedUsage.inputTokens + usage.inputTokens,
					outputTokens: accumulatedUsage.outputTokens + usage.outputTokens,
					totalTokens: accumulatedUsage.totalTokens + usage.totalTokens,
					durationMs: accumulatedUsage.durationMs,
					cacheReadTokens: sumOptional(accumulatedUsage.cacheReadTokens, usage.cacheReadTokens),
					cacheWriteTokens: sumOptional(accumulatedUsage.cacheWriteTokens, usage.cacheWriteTokens),
					reasoningTokens: sumOptional(accumulatedUsage.reasoningTokens, usage.reasoningTokens),
				}
			: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					totalTokens: usage.totalTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					reasoningTokens: usage.reasoningTokens,
				};
		lastTurnUsage = usage;
		contextSizeInputTokens = usage.inputTokens;
	}

	if (isAgentLoopToolCallsFinishReason(input.finishReason)) {
		const continuationTurnIndex = input.turnIndex + 1;
		return {
			accumulatedUsage,
			lastTurnUsage,
			contextSizeInputTokens,
			nextTurnIndex: continuationTurnIndex,
			createNewAssistantOnNextTurnStart: false,
			resetTurn: true,
			continuationTurnIndex,
		};
	}

	return {
		accumulatedUsage,
		lastTurnUsage,
		contextSizeInputTokens,
		nextTurnIndex: input.turnIndex,
		createNewAssistantOnNextTurnStart: true,
		resetTurn: false,
	};
}

export function isAgentLoopToolCallsFinishReason(
	finishReason: string | undefined,
): boolean {
	return (
		finishReason === "tool-calls" ||
		finishReason === "tool_calls" ||
		finishReason === "tool-use" ||
		finishReason === "tool_use"
	);
}

export function applyAgentLoopFinishChunkWithAdapters<TTurn>(
	options: ApplyAgentLoopFinishChunkWithAdaptersOptions<TTurn>,
): CoreAgentLoopFinishPlan {
	const plan = planAgentLoopFinishChunk({
		turnIndex: options.state.turnIndex,
		accumulatedUsage: options.state.accumulatedUsage,
		usage: options.usage,
		finishReason: options.finishReason,
	});

	if (plan.accumulatedUsage) {
		options.state.accumulatedUsage = plan.accumulatedUsage;
		options.syncAccumulatedUsage?.(plan.accumulatedUsage);
	}
	if (plan.lastTurnUsage) {
		options.state.lastTurnUsage = plan.lastTurnUsage;
		options.syncLastTurnUsage?.(plan.lastTurnUsage);
		options.updateStepsUsageByTurn?.(
			options.state.turnIndex,
			plan.lastTurnUsage,
		);
	}
	if (plan.contextSizeInputTokens !== undefined) {
		options.sendContextSizeUpdate(plan.contextSizeInputTokens);
	}

	options.persistTurnContentParts();
	options.state.createNewAssistantOnNextTurnStart =
		plan.createNewAssistantOnNextTurnStart;
	options.state.turnIndex = plan.nextTurnIndex;
	if (plan.resetTurn) {
		options.state.turn = options.createTurnState();
	}
	if (plan.continuationTurnIndex !== undefined) {
		options.sendContinuation(plan.continuationTurnIndex);
	}

	return plan;
}
