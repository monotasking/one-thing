// 流块:服务商流里来的每一块(回合开始、文字、思考、工具输入 / 结果、服务商数据、收尾)分发到对应的处理,
// 以及整条流的生命周期(从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。
import type { AgentProviderStreamChunk } from "./agent-loop-provider-stream.js";
import type { AgentProviderData } from "./agent-loop-types.js";
import { isAgentLoopPauseForConfirmationError, isAgentExecutionCheckpointError } from "./agent-loop-errors.js";
// 收尾修复写在没结局的调用上的那两句话住在 `@shared/engine/tool-call-errors`:投影(客户端也跑)
// 必须说出与引擎逐字相同的那一句。
import { CORE_ABORTED_TOOL_ERROR } from '@shared/engine/tool-call-errors.js'
import type { CoreAgentLoopContentPartEmitter, CoreAgentLoopExecutorContentAccumulator, CoreAgentLoopExecutorTurnState, CoreAgentLoopFinishState, CoreAgentLoopReasoningPlacement, CoreAgentLoopToolCallForSettlement, CoreAgentLoopToolCallWithMetadata, CoreAgentLoopToolInputProcessor, CoreAgentLoopUsage, CoreMaybePromise, CoreOrderedPartLike, CoreToolPartialResultUpdate, CoreToolResult } from './agent-loop-executor-turn-state.js'
import { type CoreAgentLoopToolExecutionEmitter, type CoreAgentLoopToolExecutionStore, applyAgentLoopToolCallFallbackWithAdapters, applyAgentLoopToolInputDeltaWithAdapters, applyAgentLoopToolInputEndWithAdapters, applyAgentLoopToolInputStartWithAdapters, applyAgentLoopToolMetadataWithAdapters, applyAgentLoopToolPartialResultWithAdapters, applyAgentLoopToolResultWithAdapters } from './agent-loop-executor-tool-steps.js'
import { appendOrderedPart, getAgentLoopReasoningPlacement } from './agent-loop-executor-content-parts.js'
import { applyAgentLoopFinishChunkWithAdapters } from './agent-loop-executor-finish.js'

export interface CoreAgentLoopProviderDataPart {
	type: "provider-data";
	providerData: AgentProviderData;
	turnIndex: number;
}

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
			sessionId: options.sessionId,
			assistantMessageId: options.assistantMessageId,
			toolCallId: chunk.toolMetadata.toolCallId,
			update: chunk.toolMetadata.update,
			toolCalls: options.processor.toolCalls as Array<
				TToolCall & CoreAgentLoopToolCallWithMetadata
			>,
			stepIdsByToolCallId: state.stepIdsByToolCallId,
			store: options.store as CoreAgentLoopToolExecutionStore<
				TToolCall & CoreAgentLoopToolCallWithMetadata
			>,
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
		const applyAgentLoopProviderDataWithAdaptersOptions: ApplyAgentLoopProviderDataWithAdaptersOptions<TContentPart> = {
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
		};
		return applyAgentLoopProviderDataWithAdapters<TContentPart>(applyAgentLoopProviderDataWithAdaptersOptions);
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
		if (isAgentExecutionCheckpointError(caught)) throw caught;
		if (isAgentLoopPauseForConfirmationError(caught)) {
			return { pausedForConfirmation: true };
		}

		await options.finalize();

		if (options.isAbortError(caught)) {
			await options.emitFinalAssistantMessageUpdate(CORE_ABORTED_TOOL_ERROR);
			await options.sendStreamAborted(CORE_ABORTED_TOOL_ERROR);
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
