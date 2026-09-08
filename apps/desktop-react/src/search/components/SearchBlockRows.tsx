import { Fragment } from 'react'
import type { TFn } from '../../i18n'
import type { SearchBlock, SearchListing } from '../../data/search-listing-source'
import { resolveItemKind } from '../items'
import type { SearchItemView } from '../items'
import type { SearchItem } from '../sequence'
import s from './SearchPanel.module.css'

/**
 * **一块** = 一个能力的命中(检索面终稿 §0 ①)。
 *
 * 三条裁定全在这只件里兑现,一条都不散出去:
 *
 *  · **没有组头**(R1)。块与块之间只有一格空 + 一条发线,而那条线画在**块首那一行**
 *    上(`item.first` → `.blockStart`),不是一个独立的分隔元素 —— 一条线不该占一个
 *    可聚焦、可数、可被读屏念出来的位置。`GroupHead` 因此退出消费。
 *  · **零命中的块一个像素都不占**(R2)。判据就是 `rows.length === 0`:
 *    塌了的块同样如此 —— 它那句话归页脚(`data-readout="block-errors"`),
 *    这里一个字都不说(从前是组头一句「没搜成」,那是组头唯一还在干的活)。
 *  · **块尾那条项是列表里的一条 item**(§5.3),取尽时换成一条读数
 *    (`role="presentation"`,不进 ↑↓ 序列)。
 *
 * ── 它自己不判「哪一项怎么画」────────────────────────────────────────────
 * 每一项交给 `items` 注册表(`resolveItemKind(item.kind).Render`)。加一种序列项
 * = 一个模块 + 一行注册,这只件一个字不改 —— 那正是那张表存在的理由。
 */

export interface SearchBlockRowsProps {
  block: SearchBlock
  /** 这一块在序列里的那几项(行 + 可能的块尾项)。 */
  items: readonly SearchItem[]
  listing: SearchListing | undefined
  /** 造这份清单用的词(高亮读它,不读输入框里那个)。 */
  query: string
  activeId: string | null
  view: SearchItemView
  t: TFn
}

export function SearchBlockRows({
  block,
  items,
  listing,
  query,
  activeId,
  view,
  t,
}: SearchBlockRowsProps) {
  const more = view.moreStateOf(block.capability)
  /*
   * R2:零命中(含头页塌了的那一块)整块不渲染 —— **除了「还没问」那一块**
   * (09-07 事故第二条修)。「问过了,没有」与「这一次没问它」在屏上必须分得开:
   * 后者留一条「扫描中…」,否则文件那一档会在半秒后凭空冒出来,而用户刚刚读到的
   * 是「它说没有」。判据在 `moreStateOf` 一处,这里只是照着画。
   */
  if (block.rows.length === 0 && more.kind !== 'scanning') return null
  return (
    <>
      {items.map(item => {
        const kind = resolveItemKind(item.kind)
        if (kind === undefined) return null
        return (
          <Fragment key={item.id}>
            <kind.Render
              item={item}
              listing={listing}
              query={query}
              active={item.id === activeId}
              view={view}
            />
          </Fragment>
        )
      })}
      {/*
        * 取尽那一刻块尾那条项**换成一句读数**:说完就完了,没有可按的东西
        * (一条按不动的按钮比一句话更让人犹豫)。它不是 item,所以不进 ↑↓ 序列
        * —— `sequenceOf` 那一头本来就不产它,这里只负责画。
        */}
      {more.kind === 'end' && (
        <p
          className={s.end}
          role="presentation"
          data-readout="end"
          data-block={block.capability}
        >
          <span className={s.moreText}>{t('search.totalCount', { total: more.total })}</span>
        </p>
      )}
      {/*
        * 只扫到一半:同一条读数位,换一句诚实的话。**不说「共 N 条」** ——
        * 那会把「我扫到的」冒充成「一共有的」,而这一路恰恰不知道后者。
        */}
      {more.kind === 'partial' && (
        <p
          className={s.end}
          role="presentation"
          data-readout="partial"
          data-block={block.capability}
        >
          <span className={s.moreText}>{t('search.partialScan', { shown: more.shown })}</span>
        </p>
      )}
    </>
  )
}

/**
 * **动作那一段**(R3):一条分隔线 + 若干条动作行。
 *
 * 线是 `role="separator"`(listbox 里合法的两种孩子之一),动作行是 `role="option"`
 * —— 它们必须住在 listbox 里才承接得住 `aria-selected` 与 ↓ 到末位。
 * 一条线对应的是**这一段**,不是每一条动作,所以它画在这里而不是 `items/action.tsx`。
 */
export interface SearchActionRowsProps {
  items: readonly SearchItem[]
  listing: SearchListing | undefined
  query: string
  activeId: string | null
  view: SearchItemView
}

export function SearchActionRows({
  items,
  listing,
  query,
  activeId,
  view,
}: SearchActionRowsProps) {
  if (items.length === 0) return null
  return (
    <>
      <div className={s.sep} role="separator" />
      {items.map(item => {
        const kind = resolveItemKind(item.kind)
        if (kind === undefined) return null
        return (
          <Fragment key={item.id}>
            <kind.Render
              item={item}
              listing={listing}
              query={query}
              active={item.id === activeId}
              view={view}
            />
          </Fragment>
        )
      })}
    </>
  )
}
