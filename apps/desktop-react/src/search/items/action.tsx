import { ButtonBase } from '../../ui/ButtonBase'
import { actionOfItem, SEARCH_ITEM_KINDS } from '../sequence'
import type { SearchItemKind } from './registry'

/**
 * **动作行**(检索面终稿 §0 ③「动作不是结果」;R3)。
 *
 * 「新建提示词 “jira”」从前是一条正规结果:占配额、计入 total、计入页脚、被当成
 * 一条搜到的东西。它现在由能力自报在页级 / 块级的 `actions` 上,壳把它画在清单
 * 末尾的分隔线下:**不计入任何条数、不进预览、不参与「零结果」判据**,但它是
 * ↑↓ 序列的**末项**(键盘也要能新建)。
 *
 * 它住在 listbox 里(`role="option"`)才承接得住 `aria-selected` 与 ↓ 到末位 ——
 * 评审点名的「`ui/Button` 进不了 listbox 语义」那一格。
 *
 * 本批只立行为那一半;`role="separator"` 那条线、`＋` 前缀、`labelKey + params`
 * 查字典归第 ⑥⑦ 步(句子由壳按键查出,后端只交数据 —— R12)。
 */
export const actionItemKind: SearchItemKind = {
  kind: SEARCH_ITEM_KINDS.action,

  Render({ item }) {
    return (
      <ButtonBase
        role="option"
        aria-selected={false}
        tabIndex={-1}
        data-row="action"
        data-item-id={item.id}
      />
    )
  },

  activate(item, ctx) {
    const action = actionOfItem(ctx.listing, item)
    if (action === undefined) return
    ctx.runAction(action, item.block)
  },

  /**
   * 这条动作还在吗。动作**跟着答案走**(词一改,「新建提示词 “jira”」就该变成
   * 别的一条),所以判据是「新的那份清单里还有同一个 id 吗」—— 块级的先找,
   * 再找页级的,与 `actionOfItem` 同一条查法。
   */
  survivesGrowth(item, next) {
    if (next === undefined || item.rowId === undefined) return false
    const inBlocks = next.blocks.some(block =>
      (item.block === undefined || block.capability === item.block)
      && (block.actions ?? []).some(action => action.id === item.rowId))
    if (inBlocks) return true
    return (next.actions ?? []).some(action => action.id === item.rowId)
  },
}
