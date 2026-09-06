import { ButtonBase } from '../../ui/ButtonBase'
import { rowOfItem, SEARCH_ITEM_KINDS } from '../sequence'
import type { SearchItemKind } from './registry'

/**
 * **结果行**那一种序列项(检索面终稿 附录 B §1)。
 *
 * 本批只立**行为**那一半:`activate`(⏎ / 素点 = 打开它)与 `survivesGrowth`
 * (追加一页之后这一行还在吗)。`Render` 是最小实现 —— 徽 / 正文 / 出处 / 右列
 * 那四段、高亮、右键菜单、`aria-selected` 都归第 ⑥⑦ 步(它们要 store、要 i18n、
 * 要目标渲染器,那三样这一批都还没接上)。
 *
 * 它**不认识任何一个能力的名字**:哪一行长什么样由 `targets/registry.ts` 那张表
 * 按 `target.kind` 答,这里只负责「一项」这件事。
 */
export const rowItemKind: SearchItemKind = {
  kind: SEARCH_ITEM_KINDS.row,

  Render({ item, listing }) {
    const row = rowOfItem(listing, item)
    if (row === undefined) return null
    return (
      <ButtonBase
        role="option"
        aria-selected={false}
        tabIndex={-1}
        data-row=""
        data-item-id={item.id}
        data-capability={item.block}
      >
        {row.title}
      </ButtonBase>
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
