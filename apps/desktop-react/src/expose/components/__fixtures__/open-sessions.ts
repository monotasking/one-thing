import { openSessionIdsIn } from '../../../content/session-ref'
import { useWorkbenchStore } from '../../../workbench/store'

/**
 * **树上此刻摆着哪些会话**(W5-b 的用例夹具)。
 *
 * 从前这一族用例读的是 `expose.currentSessionId`;裁定 3 之后那一格是**投影**,
 * 唯一的写者是 `content/session-projection.ts` 那条订阅 —— 而这些用例只渲染
 * 会话列表,不接那条订阅(接上等于让每一条列表用例顺手起一台聊天数据机器)。
 *
 * 所以断言搬到它真正的事实源上:`enterSession` 做的事是**让焦点那片会话叶装上
 * 这一条**,而这只夹具就是「树上装着谁」的读法。判据复用产品那一只纯函数,
 * 用例这一头不自己拼一遍。
 */
export function openSessionIds(): string[] {
  const { regions, hidden } = useWorkbenchStore.getState()
  return openSessionIdsIn(regions, hidden)
}
