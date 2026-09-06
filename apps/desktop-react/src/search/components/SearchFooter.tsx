import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import type { TFn } from '../../i18n'
import type { SearchIndexReadout } from '../capabilities'
import s from './SearchPanel.module.css'

/**
 * **底部读数**(§9 第三条 / 检索面终稿 §2 摘要表最后几行)。
 *
 * 第 ⑦⑧ 步改了三件,每一件都有判词:
 *
 *  · **它是 `role="listbox"` 的兄弟,不是孩子**(⑦)。listbox 里只该装选项与
 *    分隔;从前那几段 `<p>` 塞在里面是既有的 a11y 债。
 *  · **几条读数合成一行**,`' · '` 串起来(⑧)。从前是各占一行,五行各说各的时
 *    页脚比列表还高;合成一行之后每一条仍然是**自己那一个** `[data-readout]`
 *    元素 —— 门按属性认,不按行认。
 *  · **块级失败落在这里**(R2 / 拍点 A):组头退役之后,「某一类没搜成」唯一诚实
 *    的落点就是页脚一行「<能力名>没搜成 · 重试」。重试是**行内微型文字动作**
 *    (`ButtonBase`,裸 button 三类判的第③类),不是一颗 28px 描边的按钮。
 *
 * 「共 N 条」不在这里了:它随 `end` 那条读数进了**块尾**(落差 #12/#14)——
 * 一个数说的是「这一块全集有多大」,而页脚说的是整张清单的处境。
 */

export interface SearchFooterFailure {
  capability: string
  /** 屏幕上那个名字(壳按自述的 labelKey 查出来的)。 */
  label: string
}

export interface SearchFooterProps {
  /** 这一发还在路上(首发 / 换词 / 重拉)。 */
  searching: boolean
  /** 放宽过几级;0 / 缺席 = 不画。 */
  relaxed: number | undefined
  /** 索引此刻的读数;缺席 = 状态还没回来。 */
  indexReadout: SearchIndexReadout | undefined
  /** 头页塌了的那几块。 */
  failed: readonly SearchFooterFailure[]
  onRetryBlock(capability: string): void
  t: TFn
}

export function SearchFooter({
  searching,
  relaxed,
  indexReadout,
  failed,
  onRetryBlock,
  t,
}: SearchFooterProps) {
  const parts: ReactNode[] = []

  if (searching) {
    parts.push(
      <span key="searching" className={s.readout} data-readout="searching">
        {t('search.searching')}
      </span>,
    )
  }
  if ((relaxed ?? 0) > 0) {
    parts.push(
      <span key="relaxed" className={s.readout} data-readout="relaxed">
        {t('search.relaxed')}
      </span>,
    )
  }
  /*
   * 「索引不可用」**只认 `status.mode === 'error'` 这一格**(落差 #19)。
   * 从前 `indexReadoutOf` 把它吞了 —— 于是「这台上根本没起索引」在屏幕上表现为
   * 「搜不到东西」,一句解释都没有。
   */
  if (indexReadout?.unavailable === true) {
    parts.push(
      <span key="index-unavailable" className={s.warn} data-readout="index-unavailable">
        {t('search.indexUnavailable')}
      </span>,
    )
  }
  if (indexReadout !== undefined && indexReadout.pending > 0) {
    parts.push(
      <span key="index-pending" className={s.readout} data-readout="index-pending">
        {t('search.indexPending', { pending: indexReadout.pending })}
      </span>,
    )
  }
  if (indexReadout?.readerHost !== undefined) {
    parts.push(
      <span key="index-reader" className={s.readout} data-readout="index-reader">
        {t('search.indexReader', { host: indexReadout.readerHost })}
      </span>,
    )
  }
  for (const one of failed) {
    parts.push(
      <span key={`failed:${one.capability}`} className={s.warn} data-readout="block-errors">
        {t('search.blockFailed', { name: one.label })}
        {' · '}
        <ButtonBase className={s.link} onClick={() => onRetryBlock(one.capability)}>
          {t('search.retry')}
        </ButtonBase>
      </span>,
    )
  }

  if (parts.length === 0) return null
  return (
    <p className={s.foot}>
      {parts.map((part, at) => (
        <Fragment key={at}>
          {at > 0 && <span className={s.footSep} aria-hidden="true">{' · '}</span>}
          {part}
        </Fragment>
      ))}
    </p>
  )
}
