/**
 * 工具调用表的 COW 写法 —— docs/design/session-commands-p0-2026-08.md §5(P0.2 area ①,F3)。
 *
 * 病根:引擎手里的 `toolCalls` 数组**同时是**会话消息上的那一份(命令面的
 * `setToolCalls` 直接把入参数组挂到消息上),所以「先就地改 toolCall、再整表写回」
 * 等于绕过命令面改会话。
 *
 * 现在的纪律,三条:
 *   1. 工作数组是引擎自己的 scratch;要改一条就 `patchCoreToolCall` —— 换出一个
 *      新对象、原地换掉数组里的那一格,老对象一个字段都不动;
 *   2. 交给 store 的永远是 `coreToolCallSnapshot()` 的**新数组**(store 拿到之后
 *      那份就归它,可能被深冻结);
 *   3. 跨 `await` 持有的 toolCall 引用一律过期 —— 要用最新值就 `findCoreToolCall`
 *      按 id 从工作数组重新取。
 */

export interface CoreIdentifiedToolCall {
  id: string
}

/** 按 id 从工作数组取当前那一版(跨 await 之后必须走这里)。 */
export function findCoreToolCall<TToolCall extends CoreIdentifiedToolCall>(
  toolCalls: readonly TToolCall[],
  toolCallId: string,
): TToolCall | undefined {
  return toolCalls.find(toolCall => toolCall.id === toolCallId)
}

/** 把新版本换进工作数组(不在表里就只是返回它,与老的就地改语义一致)。 */
export function replaceCoreToolCall<TToolCall extends CoreIdentifiedToolCall>(
  toolCalls: TToolCall[],
  next: TToolCall,
): TToolCall {
  const index = toolCalls.findIndex(toolCall => toolCall.id === next.id)
  if (index >= 0) toolCalls[index] = next
  return next
}

/** COW 改一条:返回新对象,并把它换进工作数组。 */
export function patchCoreToolCall<TToolCall extends CoreIdentifiedToolCall>(
  toolCalls: TToolCall[],
  toolCall: TToolCall,
  patch: Partial<TToolCall>,
): TToolCall {
  return replaceCoreToolCall(toolCalls, { ...toolCall, ...patch })
}

/** 交给 store 的快照:新数组,元素是当前这一版的对象。 */
export function coreToolCallSnapshot<TToolCall>(toolCalls: readonly TToolCall[]): TToolCall[] {
  return toolCalls.slice()
}
