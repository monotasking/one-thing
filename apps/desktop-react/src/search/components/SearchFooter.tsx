import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { ButtonBase } from '../../ui/ButtonBase'
import type { MessageKey, TFn } from '../../i18n'
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

/**
 * 放宽级数 → 那一句的键。**下标就是级数**,0 那一格恒缺席(没放宽 = 不说话)。
 * 一张表而不是三条 `if`:加一级阶梯 = 表里加一行 + 字典加一对。
 */
const RELAXED_KEYS = [
  undefined,
  'search.relaxed1',
  'search.relaxed2',
  'search.relaxed3',
] as const satisfies ReadonlyArray<MessageKey | undefined>

export interface SearchFooterFailure {
  capability: string
  /** 屏幕上那个名字(壳按自述的 labelKey 查出来的)。 */
  label: string
}

/**
 * **这一发的一句提示**(P5)。后端只交 `labelKey + params`,句子在这里查字典
 * (R12)。
 *
 * 它与 `failed` 是两件事:那一格说「这一类没搜成」(可以重试),这一格说
 * 「这一次少用了一条路,原因如下」—— 结果是真的,只是不全。所以它没有重试钮:
 * 要它参与,用户该做的是去把那台 app 打开。
 */
export interface SearchFooterNotice {
  id: string
  labelKey: string
  params?: Record<string, string | number>
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
  /** 能力自报的那几句提示(`sequence.ts` 的 `noticesOf` 择出来的)。 */
  notices: readonly SearchFooterNotice[]
  onRetryBlock(capability: string): void
  t: TFn
}

export function SearchFooter({
  searching,
  relaxed,
  indexReadout,
  failed,
  notices,
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
  /*
   * **放宽三级三句**(步⑦ 留账 E-6 第二条)。阶梯在 `core/search/pipeline/plan.ts`:
   * ①严格(AND + 短语相邻)②去相邻 ③至少一半的词 ④任一词 —— `relaxed` 就是落在
   * 第几级(0 = 没放宽)。从前一句「已放宽:按任一词匹配」包打三级,那在只放宽到
   * ② 的时候是一句**谎话**:它说得比实际远。三句各说各的,键名带级数。
   *
   * 契约上 `relaxed` 是 `0|1|2|3`,但它来自网线 —— 越界的数走 `RELAXED_KEYS` 查不到
   * 就**不画**(不画比编一句强)。
   */
  const relaxedKey = RELAXED_KEYS[relaxed ?? 0]
  if (relaxedKey !== undefined) {
    parts.push(
      <span key="relaxed" className={s.readout} data-readout="relaxed">
        {t(relaxedKey)}
      </span>,
    )
  }
  /*
   * **语义召回还没就绪**(步⑦ 留账 E-6 第一条)。判据是 `indexReadoutOf` 算好的那两态;
   * `ready` / `off` / 缺席都不画 —— 见 `capabilities.ts` 上那段判词。
   */
  if (indexReadout?.vector === 'downloading') {
    parts.push(
      <span key="vector" className={s.readout} data-readout="vector">
        {t('search.vectorDownloading')}
      </span>,
    )
  } else if (indexReadout?.vector === 'embedding') {
    parts.push(
      <span key="vector" className={s.readout} data-readout="vector">
        {t('search.vectorEmbedding', { pending: indexReadout.vectorPending ?? 0 })}
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
  /*
   * 能力自报的提示排在块级失败**之前**:「这次少用了一条路」是关于这一页的处境,
   * 而「某一类没搜成」是一条带动作(重试)的行 —— 带动作的排最后,与页脚从左到右
   * 「越往后越要人动手」的次序一致。
   */
  for (const notice of notices) {
    parts.push(
      <span key={`notice:${notice.id}`} className={s.readout} data-readout="notice">
        {t(notice.labelKey as MessageKey, notice.params)}
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
