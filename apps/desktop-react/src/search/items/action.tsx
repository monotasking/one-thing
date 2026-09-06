import { Plus } from '../../components/icons'
import { ButtonBase } from '../../ui/ButtonBase'
import type { MessageKey } from '../../i18n'
import { actionOfItem, SEARCH_ITEM_KINDS } from '../sequence'
import s from '../components/SearchPanel.module.css'
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
 * 评审点名的「`ui/Button` 进不了 listbox 语义」那一格。分隔线**不在这里画**:
 * 一条线对应的是「动作那一段」而不是「每一条动作」,所以它归 `SearchActionRows`
 * (§1 组件树里那一行写的就是「`role="separator"` 一条 + 每条动作行 `role="option"`」)。
 *
 * ── 句子由壳按键查出(R12)────────────────────────────────────────────────
 * 后端只交 `labelKey + params`(`search.action.createPrompt` + `{ title }`),
 * 这里查一次字典。所以这只文件里没有一句成品文案,也没有一个能力 id。
 */
export const actionItemKind: SearchItemKind = {
  kind: SEARCH_ITEM_KINDS.action,

  Render({ item, listing, active, view }) {
    const action = actionOfItem(listing, item)
    if (action === undefined) return null
    return (
      <ButtonBase
        role="option"
        aria-selected={active}
        tabIndex={-1}
        data-row="action"
        data-item-id={item.id}
        className={active ? `${s.action} ${s.rowOn}` : s.action}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => view.onPointer(item, event)}
      >
        {/* 「＋」是**前缀**不是图标钮:它与徽在同一列,所以整段读起来仍是一行。 */}
        <span className={s.plus} aria-hidden="true">
          <Plus className={s.plusIcon} strokeWidth={1.75} />
        </span>
        <span className={s.actionText}>
          {view.t(action.labelKey as MessageKey, action.params)}
        </span>
      </ButtonBase>
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
