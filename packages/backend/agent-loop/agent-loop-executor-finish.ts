// 收尾:建助手消息与下一只助手写者、算最终消息更新、修掉没结局的工具调用、发最终更新、收流,
// 以及收尾块里的用量累加与续跑判定(从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
// 收尾修复写在没结局的调用上的那两句话住在 `@shared/engine/tool-call-errors`:投影(客户端也跑)
// 必须说出与引擎逐字相同的那一句。
import { CORE_LINGERING_TOOL_ERROR } from '@shared/engine/tool-call-errors.js'
import {
	isAgentLoopToolCallsFinishReason,
	nextAgentLoopTurnIndexAfterFinish,
} from "./agent-loop-turn.js";
import type { CoreAgentLoopFinishState, CoreAgentLoopLastTurnUsage, CoreAgentLoopUsage, CoreMaybePromise } from './agent-loop-executor-turn-state.js'

export interface CoreAgentLoopFinishPlan {
	accumulatedUsage?: CoreAgentLoopUsage;
	lastTurnUsage?: CoreAgentLoopUsage;
	contextSizeInputTokens?: number;
	nextTurnIndex: number;
	createNewAssistantOnNextTurnStart: boolean;
	resetTurn: boolean;
	continuationTurnIndex?: number;
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
	type: typeof SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED;
	message: TMessage;
}

export interface CoreAgentLoopStreamStartEvent {
	type: typeof SESSION_EVENT_TYPES.STREAM_START;
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

/**
 * **settle 快照** —— 收尾链广播给渲染侧的那一份整体覆盖。
 *
 * ## 活 run 共存口径(F4-b2,§16.17。改这条链之前先读完)
 *
 * > **活 run 窗口内,该 run 的 assistant 消息由引擎写手对象持有并唯一可信;
 * > 物化缓存只回答已收尾世界;窗口的边界 = `run/start` 到 settle 完成。**
 *
 * 收尾链(`emitAgentLoopFinalMessageUpdateWithAdapters` /
 * `completeAgentLoopStreamWithAdapters`)整条都跑在**窗口之内**,所以它的
 * `getMessage` 取材口读的是**写手视图**,不是"事件账本的物化"。这不是历史包袱,
 * 是两条机械事实:
 *
 * 1. **`contentParts` 上的渲染锚点(`data-steps`)只存在于写手那一侧。** 锚点按
 *    裁定住渲染侧(canonical G4):不进事件、不进投影、账本里从来没有它。而这份
 *    快照是**整体覆盖** —— 取材换成投影那一份,渲染层的锚点当场归零,work group
 *    与整段工具渲染消失(§15.16「正文看不见」的同一根引信)。
 * 2. **被收场判死的工具,它的 `tool/result` 是这条链自己写出去的。** 宿主在
 *    `emitMessageUpdated` 之后按修复结果补记 `tool/result{cancelled:true}`;投影
 *    的 `cancelled` 由那条事件派生。产地读自己的产物 = 自引用,永远读空。
 *    (F2-c 的 `tool/annotate` 已经把自报标题 / 自报结局的产地补齐了 —— 所以
 *    这一条**不是**"投影欠一格",是产地纪律,§10.10。)
 *
 * **F4-c c4-b(§16.25 钥匙①)把这段口径整个换掉了,写在这里备查。** 两条理由
 * 各有出路,写手视图那一口已经删除:
 *
 *  - **渲染锚点**是 steps 的 `turnIndex` 的**纯函数**,由推送侧从折叠产物**现算**
 *    (`@shared/session/render-anchors`,renderer 加载路径用的是同一份);
 *    锚点因此不再需要一个保管人,G4"不进事件、不进投影"的裁定一字未动。
 *  - **自引用**那条不靠"改读投影"解决(`steps`/`toolCalls` 在 `message/patched`
 *    的 `DERIVED_KEYS` 里,收尾修复的补丁进不了账本):改成**不回读** ——
 *    修复的产物经 `onSettled` 直接递给采集点。
 *
 * 宿主侧今天的取材口:`packages/backend/engine/stream/engine-agent-loop-executor.ts`
 * 的 `readSettleMessage`(投影 + 现算锚点)。
 */
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
	/**
	 * 读门面(P0.2 C1):缺席时回落到 `getSession` 的旧读法。
	 *
	 * **这一口读的是活 run 的写手视图**,不是投影 —— 理由见
	 * `CoreAgentLoopFinalMessageUpdate` 的共存口径。
	 */
	getMessage?: (sessionId: string, messageId: string) => TMessage | undefined;
	/** 收尾修复的落盘口(P0.2 F3),见 `EmitAgentLoopFinalMessageUpdateWithAdaptersOptions` */
	patchMessage?: (
		sessionId: string,
		messageId: string,
		patch: CoreAgentLoopLingeringRepair,
	) => void;
	emitMessageUpdated: (event: {
		type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED;
		messageId: string;
		updates: CoreAgentLoopFinalMessageUpdate<TMessage>;
	}) => CoreMaybePromise<void>;
	sendStreamComplete: (data: {
		sessionName?: string;
		usage?: CoreAgentLoopUsage;
		lastTurnUsage?: CoreAgentLoopLastTurnUsage;
	}) => CoreMaybePromise<void>;
	/**
	 * 收尾修复写在**没结局的调用**上的那句话(F4-c c4-b,§16.25)。
	 *
	 * 正常收尾这一路从前不需要它:用户按停止之后,桌面那条清理路先一步把 step
	 * 判死并写下 `'User cancelled'`,而收尾修复只筛 `running|pending`,已经
	 * `cancelled` 的那些它一律放过 —— 于是"先到的那一份决定了账上留下什么"。
	 *
	 * 收尾链改读折叠产物之后这条race 的答案翻了面(**探针实测 48/330**):清理路
	 * 那次判死只写了内存 store,账本与投影都不知道,于是修复看见的仍然是 `running`,
	 * 照 `LINGERING_TOOL_ERROR` 盖章 —— 用户按了停止,卡片上却写"工具没有报告完成"。
	 *
	 * 所以停止这件事得由**登记簿**说出来(与 §16.25 钥匙②同一条道理:寻址与结论
	 * 都不该问那几格易变的运行时状态)。宿主在这里递 `CORE_ABORTED_TOOL_ERROR`,
	 * 当且仅当这次执行已经被记成 `aborted`。缺席 = 老行为逐字不变。
	 */
	errorMessage?: string;
}

export interface EmitAgentLoopFinalMessageUpdateWithAdaptersOptions<
	TMessage extends CoreAgentLoopFinalMessageLike & { id: string },
	TSession extends CoreAgentLoopSessionWithMessages<TMessage>,
> {
	sessionId: string;
	assistantMessageId: string;
	getSession: (sessionId: string) => TSession | undefined;
	/**
	 * 读门面(P0.2 C1):缺席时回落到 `getSession` 的旧读法。
	 *
	 * **这一口读的是活 run 的写手视图**,不是投影 —— 理由见
	 * `CoreAgentLoopFinalMessageUpdate` 的共存口径。
	 */
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
		type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED;
		messageId: string;
		updates: CoreAgentLoopFinalMessageUpdate<TMessage>;
	}) => CoreMaybePromise<void>;
	errorMessage?: string;
	/**
	 * **收尾修复之后那条消息的正身**(F4-c c4-b,§16.25)。
	 *
	 * 收尾链上排在这一步后面的采集点(宿主的 `captureCancelledToolResults`)要的
	 * 正是"修复判死了哪几个 step"。它从前**回读**一次消息来拿 —— 而那次回读只在
	 * 内存 store 上成立:修复的落盘走命令面 `patchMessage{steps,toolCalls}`,
	 * 而 `steps` / `toolCalls` 在 `message/patched` 的 `DERIVED_KEYS` 里
	 * (投影自己从 `tool/*` 折,不认补丁),所以**回读投影一定读不到修复结果**。
	 *
	 * 与其让采集点去猜该读哪一侧,不如把刚刚决定好的那一份直接递给它:
	 * 同一次修复的产物,零回读、零时序窗口,也不再有"产地读自己产物"的自引用。
	 */
	onSettled?: (message: TMessage) => void;
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
				type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
				message: assistantMessage,
			},
			{
				type: SESSION_EVENT_TYPES.STREAM_START,
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
const LINGERING_TOOL_ERROR = CORE_LINGERING_TOOL_ERROR;

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

	const settled = { ...updatedMessage, ...repair } as TMessage;
	options.onSettled?.(settled);

	await options.emitMessageUpdated({
		type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
		messageId: options.assistantMessageId,
		updates: buildAgentLoopFinalMessageUpdate(settled),
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

	const nextTurnIndex = nextAgentLoopTurnIndexAfterFinish(
		input.turnIndex,
		input.finishReason,
	);
	if (nextTurnIndex !== input.turnIndex) {
		const continuationTurnIndex = nextTurnIndex;
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

export {
	/**
	 * §13.9:判定点搬进 `agent-loop-turn.ts`(采集点也要读它,而这个模块的模块图
	 * 太大)。导出路径一字未改 —— 这里只是把它再放出去。
	 */
	isAgentLoopToolCallsFinishReason,
	nextAgentLoopTurnIndexAfterFinish,
};

export function applyAgentLoopFinishChunkWithAdapters<TTurn>(
	options: {
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
	},
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
