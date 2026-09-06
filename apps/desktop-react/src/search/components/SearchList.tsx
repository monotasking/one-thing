import { useEffect, useMemo, useRef } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import { useScrollMemory } from '../../ui/scroll-memory'
import type { TFn } from '../../i18n'
import type { SearchIndexReadout } from '../capabilities'
import type { SearchItemView } from '../items'
import type { SearchListingView } from '../hooks/useSearchListing'
import { SEARCH_ITEM_KINDS } from '../sequence'
import type { SearchItem } from '../sequence'
import { searchScrollOf, useSearchStore } from '../store'
import { SearchActionRows, SearchBlockRows } from './SearchBlockRows'
import { SearchFooter } from './SearchFooter'
import s from './SearchPanel.module.css'

/**
 * **左边那张清单**(检索面终稿 附录 B §1)。
 *
 * 它是**滚动容器**,里面两个兄弟:`[role="listbox"]`(只装 option / separator /
 * presentation 读数)与 `SearchFooter`(读数)。第 ⑦ 步把页脚从 listbox **里面**
 * 搬到它的兄弟位 —— 一段 `<p>` 塞在 listbox 里是既有的 a11y 债(APG:listbox 的
 * 孩子只该是选项与分隔),顺手结清。
 *
 * ── 滚动只有一条产地 ────────────────────────────────────────────────────
 * 一条 effect,依赖 **`[selection]`**,而且 `by === 'reconcile'` 时**不滚**。
 * 「行集增长绝不触发滚动」四条不变量里的第三条就是这一句:从前那条 effect 依赖
 * `visibleRows`,列表一长就滚 —— 那正是「点了加载更多跳回顶部」的另一半。
 *
 * ── 滚动位靠 `ui/scroll-memory` 端过去 ───────────────────────────────────
 * 键是 **`held.shownKey`**(屏上那份数据的键),不是「此刻要去问的那把键」——
 * 后者会在换键那一帧把旧内容的高度记到新键名下。换宿主(舞台 → 浮窗 / 钉边)
 * 是真重挂,这一件是那一刻不弹回顶上的全部实现。
 */

export interface SearchListProps {
  listing: SearchListingView
  itemView: SearchItemView
  /** 造屏上这份清单用的词(高亮读它)。 */
  query: string
  t: TFn
  /** 能力 id → 屏幕上那个名字(页脚的块级失败一行读它)。 */
  labelOf(capability: string): string
  indexReadout: SearchIndexReadout | undefined
  /** 页脚那一行「<能力名>没搜成 · 重试」的落点。 */
  onRetryBlock(capability: string): void
  /** 零结果那一屏的下一步(能给才给;给不出就不画那一行)。 */
  onSearchAllSpaces?: () => void
  onClearFilters?: () => void
  /** 输入框里那个词 —— 空态那句话说的是**用户刚打的**,不是屏上那份的。 */
  typed: string
}

export function SearchList({
  listing,
  itemView,
  query,
  t,
  labelOf,
  indexReadout,
  onRetryBlock,
  onSearchAllSpaces,
  onClearFilters,
  typed,
}: SearchListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const selection = useSearchStore(st => st.selection)
  const setScroll = useSearchStore(st => st.setScroll)
  const { held, blocks, sequence } = listing

  const { onScroll } = useScrollMemory(listRef, held.shownKey, {
    read: searchScrollOf,
    write: setScroll,
  })

  /*
   * 选中项滚进视野。**唯一一条滚动 effect**,依赖只有 `[selection]` ——
   * `by === 'reconcile'` 是「答案换了、活动位跟着落了一下」,那一下不该动屏幕。
   * 按 `data-item-id` 认项而不是按下标:块尾项与动作行都不是下标。
   */
  useEffect(() => {
    if (selection.id === null || selection.by === 'reconcile') return
    const root = listRef.current
    if (root === null) return
    for (const el of root.querySelectorAll<HTMLElement>('[data-item-id]')) {
      if (el.getAttribute('data-item-id') === selection.id) {
        el.scrollIntoView?.({ block: 'nearest' })
        return
      }
    }
  }, [selection])

  /** 逐块那几项 + 末尾的动作项。**一次遍历分好**,画法不再自己数。 */
  const grouped = useMemo(() => {
    const byBlock = new Map<string, SearchItem[]>()
    const actions: SearchItem[] = []
    for (const item of sequence) {
      if (item.kind === SEARCH_ITEM_KINDS.action) {
        actions.push(item)
        continue
      }
      const at = item.block ?? ''
      const bucket = byBlock.get(at)
      if (bucket === undefined) byBlock.set(at, [item])
      else bucket.push(item)
    }
    return { byBlock, actions }
  }, [sequence])

  const failed = blocks.filter(block => block.error !== undefined)
  const rowCount = blocks.reduce((sum, block) => sum + block.rows.length, 0)
  /*
   * 三态,判据全是可读字段(§3):
   *  · 首发在飞(屏上一份答案都没有)→ **空**,不画「无结果」(从前在首发期间
   *    就画它,那是一句谎话);
   *  · 真答复为零 → 一句「没有和「…」匹配的结果」+ 与当前片对应的下一步;
   *  · 有行 → 画行。
   */
  const answered = held.data !== undefined
  /*
   * 「这一发还在路上」。首发那一段(还没有任何答案、也还没塌)同样算 ——
   * 那一刻画的是「搜索中…」而不是「无结果」(拍点 K:后者是一句谎话)。
   */
  const searching = held.inflight || held.stale || (!answered && held.error === undefined)
  const empty = answered && !held.stale && rowCount === 0 && failed.length === 0 && !held.inflight

  return (
    <div
      className={s.list}
      ref={listRef}
      data-testid="search-list"
      {...(held.stale ? { 'data-stale': 'true' } : {})}
      onScroll={onScroll}
    >
      <div className={s.body} role="listbox" aria-label={t('search.resultsLabel')}>
        {blocks.map(block => (
          <SearchBlockRows
            key={block.capability}
            block={block}
            items={grouped.byBlock.get(block.capability) ?? []}
            listing={held.data}
            query={query}
            activeId={selection.id}
            view={itemView}
            t={t}
          />
        ))}
        {empty && (
          <div className={s.empty} data-readout="empty">
            <p className={s.emptyHead}>
              {typed.trim().length === 0
                ? t('search.noResults')
                : t('search.noResultsFor', { query: typed.trim() })}
            </p>
            {(onSearchAllSpaces !== undefined || onClearFilters !== undefined) && (
              <p className={s.emptyNext}>
                {onSearchAllSpaces !== undefined && (
                  <ButtonBase className={s.link} onClick={onSearchAllSpaces}>
                    {t('search.emptySearchAllSpaces')}
                  </ButtonBase>
                )}
                {onClearFilters !== undefined && (
                  <ButtonBase className={s.link} onClick={onClearFilters}>
                    {t('search.emptyClearFilters')}
                  </ButtonBase>
                )}
              </p>
            )}
          </div>
        )}
        {/*
          * 动作行在**分隔线下**,而且在零结果那一屏上照样在 —— 它是动作不是结果,
          * 不参与「有没有搜到」这件事(R3)。
          */}
        <SearchActionRows
          items={grouped.actions}
          listing={held.data}
          query={query}
          activeId={selection.id}
          view={itemView}
        />
      </div>

      <SearchFooter
        searching={searching}
        relaxed={held.data?.relaxed}
        indexReadout={indexReadout}
        failed={failed.map(block => ({
          capability: block.capability,
          label: labelOf(block.capability),
        }))}
        onRetryBlock={onRetryBlock}
        t={t}
      />
    </div>
  )
}
