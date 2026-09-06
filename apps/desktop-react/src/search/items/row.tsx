import { useMemo } from 'react'
import { SearchRow } from '../components/SearchRow'
import { rowOfItem, SEARCH_ITEM_KINDS } from '../sequence'
import { resultRows } from '../transitions'
import type { SearchItemKind } from './registry'

/**
 * **结果行**那一种序列项(检索面终稿 附录 B §1)。
 *
 * 第 ⑤ 步只立了行为那一半(`activate` / `survivesGrowth`);第 ⑦ 步把 `Render`
 * 接到真的那件画法上 —— `components/SearchRow.tsx`(徽 / 正文 / 出处 / 右列四段、
 * 高亮、事实徽、`role="option"`)。
 *
 * ── 为什么中间夹一只 `resultRows` ──────────────────────────────────────────
 * 格里那一行是**契约的形**(`SearchResult`),而画法认的是**壳的形**(`SearchRow`:
 * 出处已经归成一格 `origin`、无标题已经兜过底、高亮已经挑过产地)。那一层收窄
 * 从 S4b 起就只有 `resultRows` 一处产地,这里照旧走它 —— 不在项模块里再写第二遍
 * 「出处取 subtitle 退到 detail」。
 *
 * 它**不认识任何一个能力的名字**:哪一行长什么样由 `targets/registry.ts` 那张表
 * 按 `target.kind` 答,这里只负责「一项」这件事。
 */
export const rowItemKind: SearchItemKind = {
  kind: SEARCH_ITEM_KINDS.row,

  Render({ item, listing, query, active, view }) {
    const result = rowOfItem(listing, item)
    const capability = item.block ?? ''
    /*
     * 一行现造一次收窄。**依赖只有那一条结果的身份** —— 格里没变的行会原样交回
     * 同一个对象(数据层的 `equals` 保的就是这个),于是这只 memo 也不会重算。
     */
    const row = useMemo(
      () => (result === undefined ? undefined : resultRows([result], capability)[0]),
      [result, capability],
    )
    // 没有落点的候选**丢**(§4.3 的那一半:缺渲染器不丢,缺落点才丢)。
    if (row === undefined) return null
    const index = view.rowIndexOf(item)
    return (
      <SearchRow
        row={row}
        index={index ?? 0}
        itemId={item.id}
        first={item.first === true}
        selected={active}
        picked={view.picked(item)}
        allSpaces={view.allSpaces}
        spaceId={view.spaceId}
        defaultSpaceId={view.defaultSpaceId}
        query={query}
        t={view.t}
        onClick={(event) => view.onPointer(item, event)}
        onContextMenu={(event) => view.onContextMenu(item, event)}
      />
    )
  },

  /**
   * 打开它。落点由面板注入(`openRow` 最终走目标渲染器的 `activate`)——
   * 行自己不认识会话、文件、命令这些东西。
   */
  activate(item, ctx) {
    const row = rowOfItem(ctx.listing, item)
    if (row === undefined || item.block === undefined) return
    ctx.openRow(row, item.block)
  },

  /**
   * 这一行还在吗 —— **按 id 在它自己那一块里找**。
   *
   * 翻页只在块末尾追加,所以存量行永远还在;它答假的场合是换了一份答案
   * (重拉之后这一条不在了),那时 `reconcile` 按旧下标夹到最近的幸存项。
   */
  survivesGrowth(item, next) {
    if (next === undefined || item.block === undefined || item.rowId === undefined) return false
    const block = next.blocks.find(b => b.capability === item.block)
    return block !== undefined && block.rows.some(row => row.id === item.rowId)
  },
}
