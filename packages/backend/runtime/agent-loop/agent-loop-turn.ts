/**
 * 引擎的**回合号**规则(§13.9)—— 一个判定点,两个读者。
 *
 * `turnIndex` 不是"第几次请求"。引擎那边它只在两处动:
 *
 *  1. `turn-start` —— `state.turnIndex = turn`(runner 的回合号);
 *  2. **每一条 finish chunk** —— finishReason 是 tool-calls 那一族时 +1
 *     (`planAgentLoopFinishChunk`)。
 *
 * 平时这两条规则给出同一个数:一次请求 = 一条 finish = 一个回合。而**外部执行器**
 * (Claude Code SDK 连接器)把一整段多轮会话装进一次 `streamTurn`,每当"工具结果
 * 到齐、新一轮正文开始"就发一条 `finish(tool_calls)` 当轮分界
 * (`external-agents/claude-code-connector.ts` 的 `withRoundBoundary`,由
 * `agent-loop/runner.ts` 当场转发)。于是**一次请求里有两个回合** —— 而账本上
 * 只有一个 `requestIndex`。
 *
 * 这个文件单独存在,是为了让**采集点**也能读这条规则而不必把
 * `agent-loop-executor.ts` 整棵模块图拖进记录器(§10.10:引擎派生的字段只许调
 * 引擎那一个函数,禁止在别处手抄一遍判据)。
 */

/** finish chunk 的 finishReason 说"这一轮以工具调用结束"。 */
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

/**
 * 一条 finish chunk 之后引擎的回合号。
 *
 * 用量的归属是**推进之前**那个值:`applyAgentLoopFinishChunkWithAdapters` 先
 * `updateStepsUsageByTurn(state.turnIndex, …)` 再 `state.turnIndex = nextTurnIndex`。
 */
export function nextAgentLoopTurnIndexAfterFinish(
	turnIndex: number,
	finishReason: string | undefined,
): number {
	return isAgentLoopToolCallsFinishReason(finishReason)
		? turnIndex + 1
		: turnIndex;
}
