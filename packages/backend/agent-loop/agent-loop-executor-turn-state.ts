// 执行器的回合状态与各家共用的端口形状(从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。
//
// 这里放的是被执行器几只文件同时用到的东西:一个回合里攒下的状态(`CoreAgentLoopExecutorTurnState`)、
// 内容部件的存储 / 发送端口、工具输入处理器,以及建状态、记步骤编号、去重追加工具调用这三只小函数。
// 只被一只文件用到的形状跟着用它的函数走,不放在这里;工具执行的存储 / 发送端口住在 `-tool-steps`(D230)。
// 同一家的兄弟文件:`-content-parts`(有序内容部件)、`-tool-steps`(工具步骤)、`-stream-chunks`(流块分发)、
// `-finish`(收尾)、`-post-response`(回复后钩子)。
import type { JsonObject, JsonValue } from '@shared/json.js'
import type { CoreDiffHunk } from '@onething/backend/tool'

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

export type CoreMaybePromise<T> = T | Promise<T>;

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

export interface CoreAgentLoopToolCallIdentity {
	id: string;
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

export type CoreAgentLoopReasoningPlacement = "top" | "inline";

export interface CoreAgentLoopUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	durationMs?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	/** provider 自述的账本类目(见 `AgentUsage.usageSource`);只在单轮 usage 上有意义。 */
	usageSource?: string;
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

export interface CoreAgentLoopFinishState<TTurn> {
	turnIndex: number;
	accumulatedUsage?: CoreAgentLoopUsage;
	lastTurnUsage?: CoreAgentLoopLastTurnUsage;
	createNewAssistantOnNextTurnStart?: boolean;
	turn: TTurn;
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
