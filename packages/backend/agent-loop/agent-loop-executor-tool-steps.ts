// 工具步骤:一次工具调用从输入开始、参数增量、调用兜底、执行、结果与元数据回写,到收结局的每一步
// (从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。函数都是纯的:状态与端口由调用方递进来。
// 工具执行的存储 / 发送端口(`CoreAgentLoopToolExecutionStore` / `-Emitter`)也住这里:它们是工具步骤这一半的骨架,
// 放进 `-turn-state` 会让这只文件在内聚门下断成输入与结果两块(D230)。
import { resultTextFromToolMetadata } from './agent-loop-tool-orchestration.js'
import {
	type CoreIdentifiedToolCall,
	coreToolCallSnapshot,
	patchCoreToolCall,
	replaceCoreToolCall,
} from "./agent-loop-tool-call-cow.js";
import { toJsonObject, toJsonValue, type JsonObject } from '@shared/json.js'
import { coreDiffHunksFromJson } from '@onething/backend/tool'
import { detectSkillUsage, getStepType, type CoreStepType } from "@shared/engine/tool-step.js";
import { type CoreAgentLoopContentPartEmitter, type CoreAgentLoopExecutorTurnState, type CoreAgentLoopToolCallForSettlement, type CoreAgentLoopToolCallIdentity, type CoreAgentLoopToolCallWithMetadata, type CoreAgentLoopToolInputProcessor, type CoreOrderedPartLike, type CoreToolCallChanges, type CoreToolPartialResultUpdate, type CoreToolResult, appendAgentLoopTurnToolCallOnce, rememberAgentLoopToolStepId } from './agent-loop-executor-turn-state.js'
import { dispatchAgentLoopToolContentPartsWithAdapters } from './agent-loop-executor-content-parts.js'

export interface CoreAgentToolResultLike {
	content?: string;
	error?: string;
	data?: unknown;
	requiresConfirmation?: boolean;
	commandType?: string;
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
	/**
	 * S3.1(§10.11):**参数定稿之后**重算的 step 类型。
	 *
	 * 占位那一条是在 `tool_input_start` 建的 —— 那时参数还是 `{}`,
	 * `coreStepTypeForToolName('bash')` 只能给出 `command`。执行开跑这一刻参数
	 * 已经是最终值,类型必须跟着改口:`cat x/SKILL.md` 是 `skill-read`,
	 * `mkdir tmp` 是 `file-write`。写死在占位值上就是"账上写的不是真发生的事"。
	 */
	type: CoreStepType;
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
	/**
	 * S3.1(§10.11):技能识别的**唯一宣告口**。引擎认出来一次,宿主那一侧同时
	 * 落两处(消息上的 `skillUsed` 与事件账本的 `skill/activated`)—— 两处永远
	 * 同源,影子门比的就是这个一致性。
	 */
	sendSkillActivated(skillName: string): void;
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
		| "sendToolCall"
		| "sendToolExecutionStart"
		| "sendStepUpdated"
		| "sendSkillActivated"
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
	TToolCall extends CoreAgentLoopToolCallWithMetadata & CoreIdentifiedToolCall,
	TStepUpdate,
> {
	// 发现 A(§13.18):metadata 折出的带 changes toolCall 必须回写工作表并整表快照落盘,
	// 为此需要 settle 同款的 sessionId/assistantMessageId/store。
	sessionId: string;
	assistantMessageId: string;
	toolCallId: string;
	update: CoreAgentLoopToolMetadataUpdate;
	toolCalls: TToolCall[];
	stepIdsByToolCallId: Map<string, string>;
	store: CoreAgentLoopToolExecutionStore<TToolCall>;
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

export interface CoreSettledAgentLoopToolCallResult<
	TToolCall extends CoreAgentLoopToolCallForSettlement,
> {
	toolCall: TToolCall;
	awaitingConfirmation: boolean;
	skillManageCalled: boolean;
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
		// F2-c(§16.9):这一条规则现在住在 `tool-orchestration.ts` 的
		// `resultTextFromToolMetadata` —— 会话事件记录器写 `tool/annotate` 用的是
		// 同一把判定点(而不是在采集点再写一遍同一条规则)。行为逐字未变。
		const reportedResult = resultTextFromToolMetadata(update.metadata);
		if (reportedResult !== undefined) {
			metadataUpdates.result = reportedResult;
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

export function buildAgentLoopToolStartStepUpdate<
	TToolCall extends { toolName: string; arguments?: JsonObject },
>(toolCall: TToolCall): CoreAgentLoopToolStartStepUpdate<TToolCall> {
	return {
		status: "running",
		type: getStepType(toolCall.toolName, toJsonObject(toolCall.arguments)),
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

	/*
	 * S3.1(§10.11):技能识别的**唯一落点**就在这里 —— 参数定稿、工具还没跑的
	 * 这一刻。以前 agent-loop 这条路上根本没有这一步,只有事件记录器自己认了一遍,
	 * 于是账本上有 `skill/activated` 而消息上没有 `skillUsed`(真机影子第二类
	 * mismatch)。现在引擎认一次、宣告一次,两处落点都挂在这一次宣告上。
	 */
	const skillName = detectSkillUsage(
		toolCall.toolName,
		toJsonObject(toolCall.arguments),
	);
	if (skillName) options.emitter.sendSkillActivated(skillName);

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
	TToolCall extends CoreAgentLoopToolCallWithMetadata & CoreIdentifiedToolCall,
	TStepUpdate,
>(options: ApplyAgentLoopToolMetadataOptions<TToolCall, TStepUpdate>): boolean {
	const stepId = options.stepIdsByToolCallId.get(options.toolCallId);
	if (!stepId) return false;

	const toolCall = options.toolCalls.find(
		(existing) => existing.id === options.toolCallId,
	);
	const metadataUpdates = applyAgentLoopToolMetadata(toolCall, options.update);
	if (Object.keys(metadataUpdates).length === 0) return false;

	// 发现 A(§13.18):metadata 折出的 `{ ...toolCall, changes }` 在此刻回写工作表并整表
	// 快照落盘 —— 否则 settle 从无 changes 的工作表重建 settled,顶层与 step 两头都不落
	// changes(重载后 edit/write 的 diff 卡空)。单一写回点在此;settle 只继承。
	if (metadataUpdates.toolCall) {
		replaceCoreToolCall(options.toolCalls, metadataUpdates.toolCall);
		options.store.updateMessageToolCalls(
			options.sessionId,
			options.assistantMessageId,
			coreToolCallSnapshot(options.toolCalls),
		);
	}

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
