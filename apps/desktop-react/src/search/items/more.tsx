import { ButtonBase } from '../../ui/ButtonBase'
import { blockOfItem, SEARCH_ITEM_KINDS } from '../sequence'
import s from '../components/SearchPanel.module.css'
import type { SearchItemKind } from './registry'

/**
 * **块尾那条「加载更多」**(检索面终稿 附录 B §5.3)。
 *
 * 它是一条 **item**,不是一颗悬浮按钮:所以「没有它」也是一种正经状态
 * (`moreStateOf` 的 `none` / `end`),而不是把它画成禁用态占着位置。
 * 加载中**不 `disabled`** —— `gate-a11y` 会把 disabled 项剔出可达集,而焦点
 * 不该在翻页途中蒸发(判例保留自 `SearchPanel.tsx` 的「加载中也留在轮转序列里」)。
 *
 * ── 反馈是**文字**,不是 Spinner ────────────────────────────────────────
 * Spinner 只许出现在按钮内或状态栏(壳的禁令);这是列表里的一条 item,所以
 * 「加载中…」是它自己的字换掉,外加 `aria-busy` —— 屏幕阅读器与眼睛读的是同一件事。
 *
 * ── 忙态从哪来 ──────────────────────────────────────────────────────────
 * `view.moreStateOf(cap)` 一处答:那只函数吃的是 `useAsyncPending` 口径的逐块
 * pending(`${key}#${cap}`,律③)与整格的 `inflight / stale`(闸②)。项这一侧
 * 不去问谁在飞。
 */
export const moreItemKind: SearchItemKind = {
  kind: SEARCH_ITEM_KINDS.more,

  Render({ item, active, view }) {
    const capability = item.block ?? ''
    const state = view.moreStateOf(capability)
    // 只有这四态是 item(`end` / `partial` 是读数、`none` 什么都不画,都不进序列)。
    if (
      state.kind !== 'more'
      && state.kind !== 'loading'
      && state.kind !== 'scanning'
      && state.kind !== 'error'
    ) return null
    const busy = state.kind === 'loading' || state.kind === 'scanning'
    const text = state.kind === 'loading'
      ? view.t('search.loading')
      // 「扫描中…」与「加载中…」是**两句话**:前者说的是这一类还没被问过
      // (屏上这一块此刻一行都没有),后者说的是已有的行后面还在长。
      : state.kind === 'scanning'
        ? view.t('search.scanning')
        : state.kind === 'error'
          ? view.t('search.loadFailed')
          : state.total === null
            ? view.t('search.loadMore')
            : view.t('search.loadMoreCount', { shown: state.shown, total: state.total })
    return (
      <ButtonBase
        role="option"
        aria-selected={active}
        tabIndex={-1}
        data-row="more"
        data-testid="search-more"
        data-item-id={item.id}
        data-block={capability}
        data-more-state={state.kind}
        {...(busy ? { 'aria-busy': true } : {})}
        className={active ? `${s.more} ${s.rowOn}` : s.more}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => view.onPointer(item, event)}
      >
        <span className={s.moreText}>{text}</span>
      </ButtonBase>
    )
  },

  /**
   * 再要一页。三处「当没按」,每一处都有理由:
   *  · 这一块已经取尽(没有 cursor)—— 没有下一页可要;
   *  · 面板说此刻不能翻(`canLoadMore` 假:这一块在飞 / 整格在重拉 / 屏上这份是
   *    上一把键的)—— 闸②,回放链与 `loadMore` 永不重叠;
   *  · 找不到这一块 —— 项过期了。
   *
   * 「当没按」而不是排队:排队等于延迟发作(与 ⌘N 单飞闸同一条判例)。
   */
  activate(item, ctx) {
    if (item.block === undefined) return
    const block = blockOfItem(ctx.listing, item)
    if (block === undefined) return
    const cursor = block.cursor
    if (cursor === undefined) return
    if (ctx.canLoadMore !== undefined && !ctx.canLoadMore(item.block)) return
    ctx.loadMore(item.block, cursor)
  },

  /**
   * 这条项还在吗 —— **取尽了就没了**(那时它变成 `end` 那条读数,不在序列里)。
   *
   * 这一格正是这张表存在的理由:活动位停在这条上、按下去、一页落地、这条项消失,
   * 落点该是**本次追加的第一行** —— 而那一行恰好就在旧这条项的位置上,所以
   * `reconcile` 的「按旧下标夹」在这里自动给出正确答案(§5.4 ③)。
   */
  survivesGrowth(item, next) {
    if (next === undefined || item.block === undefined) return false
    const block = next.blocks.find(b => b.capability === item.block)
    if (block === undefined) return false
    // 还没问的那一块:这条项就是屏上唯一的那一行,当然还在。
    if (block.scanning === true) return true
    return block.rows.length > 0 && !block.exhausted && block.partial !== true
  },
}
