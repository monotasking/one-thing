// 有序内容部件:一个回合里文字、思考、工具步骤按流到的先后排成一列,怎么合并、怎么分发给界面、怎么落进消息
// (从 `agent-loop-executor.ts` 拆出,拆分批 1,D226)。思考块放在顶部还是随流放,也在这里判。
import type { CoreAgentLoopContentPartEmitter, CoreAgentLoopContentPartStore, CoreAgentLoopDataStepsPart, CoreAgentLoopExecutorTurnState, CoreAgentLoopReasoningPlacement, CoreOrderedPartLike } from './agent-loop-executor-turn-state.js'

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
