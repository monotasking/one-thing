import type { MessageKey } from '../i18n'
import type { SearchScopeChip } from './filters'

/**
 * **续搜的两个动作**(设计 `docs/design/search-index-2026-09.md` §4.6 的结论:
 * 「续搜的真实形态是两个动作,不是一个栈」)。
 *
 * 第一稿那套「帧栈 + 结果集句柄 + 每能力自报去向表」在设计阶段就被砍掉了,理由是
 * 没有一个真实场景非它不可。留下的两个:
 *
 *  1. **范围片(scope)** —— 把这一行变成一个过滤片贴在检索框旁(会话 → `sessionId`,
 *     文件 → `dir`)。它**就是 `filters` 的可视化**,与用户手打一条过滤条件是同一格
 *     数据,不是新状态。
 *  2. **枢轴(pivot)** —— 以它为词搜**另一类**(文件 → 提到它的消息;会话 → 它的
 *     消息 = 范围片 + 清词)。它就是**换一次查询**:capability + query + filters
 *     三格一起换。
 *
 * 两者在壳里都落成「**替换当前查询状态**」,退回去靠查询历史(`./history.ts`),
 * 不 push 一帧。
 *
 * ── 为什么这两个动作由**目标渲染器**给,不由面板给 ────────────────────────
 * §4.6 的原话是「能力自报接口只剩 `actions?(candidate)` 里 `kind:'continue'` 的项
 * 各自带一个 `SearchScope`」——「以谁为词、落到哪个 facet 键、跳到哪一类」只有
 * **产这条结果的那一类**知道。壳的骨架(面板 / tab 条 / 分组 / 分页 / 过滤片)
 * 因此一个能力 id 都不认识,而 `targets/<kind>.tsx` 认识 —— 它本来就是那一类的
 * 渲染模块,§4.0 允许动的两处之一。
 *
 * ── 留账:枢轴的落点为什么是**壳里**的能力 id ────────────────────────────
 * 真正到位的形是「后端在候选的 `actions` 里自报一条 `kind:'continue'` 的动作,
 * 带着它自己的 `SearchScope`」—— 那样连渲染器都不用认识 `messages` 这个名字。
 * 契约今天装不下它:`SearchActionDescriptor` 只有 `{ id, labelKey, icon?, danger? }`,
 * core 那份 `ActionDescriptor` 的 `kind` 与 `payload` 两格**过不来**(S4a 的
 * `previewDto` 已经把这笔账记在 `backend/rpc/domains/search.ts` 上)。补那两格是
 * 契约改动,自成一批;在那之前,枢轴的落点写在渲染器里 —— 它是**今天做得到的
 * 最靠近能力的一处**,而不是散在面板里。
 */

/** 范围片那一种:把这一行变成一个 facet 过滤片。 */
export interface ScopeContinuation {
  kind: 'scope'
  /** 按钮上那句话的键。 */
  labelKey: MessageKey
  /** 变成哪一片。`key` 摆不出时面板把这条动作画成失效 —— 见 `filters.ts` 的 `filtersOf`。 */
  chip: SearchScopeChip
}

/** 枢轴那一种:换一次查询(档 + 词 + 片三格一起换)。 */
export interface PivotContinuation {
  kind: 'pivot'
  labelKey: MessageKey
  /** 换到哪一档(能力 id)。 */
  capability: string
  /** 新的种子词。空串 = 清词(「它的消息」那一形)。 */
  query: string
  /** 顺带带上的范围片;缺席 = 不带。 */
  chip?: SearchScopeChip
}

export type SearchContinuation = ScopeContinuation | PivotContinuation

/** 这条动作此刻**按不按得动**(范围片要那个 facet 键在这一档摆得出)。 */
export function continuationEnabled(
  continuation: SearchContinuation,
  available: ReadonlySet<string>,
): boolean {
  /*
   * 枢轴永远按得动:它换的是**档**,而新档摆得出什么 facet 是换过去之后的事。
   * 范围片不同 —— 它是当场落到 `filters` 上的一格,这一档不认那个键的话按下去
   * 什么都不会发生,那种按钮比不画更让人怀疑。
   */
  return continuation.kind === 'pivot' || available.has(continuation.chip.key)
}
