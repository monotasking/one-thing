import type { TFn } from '../../i18n'
import type { SearchIndexReadout } from '../capabilities'
import s from './SearchPanel.module.css'

/**
 * **底部状态行**(§9 第三条)。四条读数,**各说各的一件事,一条都不合并**;
 * 每一条都只在事实成立时画。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx:957-982` 原样搬出来 —— 次序、`data-readout` 的值、
 * 每条的判据逐字不动(`gate-search-messages.mjs:348-350` 按它们认)。
 *
 * ── 本步它还在 listbox 里面 ────────────────────────────────────────────
 * 附录 B §1 说页脚该是 `role="listbox"` 的**兄弟**(listbox 里只装 option /
 * separator,APG),把它搬出去是第 ⑦ 步的事 —— 第 ⑥ 步是**等价拆件**,DOM 位置
 * 一个像素都不许动。所以这只件今天仍然由面板画在 `.body` 里面。
 */
export interface SearchFooterProps {
  /** 后端给了真数才画(答不出就不画 —— 不知道 ≠ 0)。 */
  total: number | undefined
  /** 放宽过几条;0 / 缺席 = 不画。 */
  relaxed: number | undefined
  /** 索引此刻的读数;缺席 = 状态还没回来。 */
  indexReadout: SearchIndexReadout | undefined
  t: TFn
}

export function SearchFooter({ total, relaxed, indexReadout, t }: SearchFooterProps) {
  return (
    <>
      {total !== undefined && (
        <p className={s.end} data-readout="total">
          <span className={s.moreText}>
            {t('search.totalCount', { total })}
          </span>
        </p>
      )}
      {(relaxed ?? 0) > 0 && (
        <p className={s.end} data-readout="relaxed">
          <span className={s.moreText}>{t('search.relaxed')}</span>
        </p>
      )}
      {indexReadout !== undefined && indexReadout.pending > 0 && (
        <p className={s.end} data-readout="index-pending">
          <span className={s.moreText}>
            {t('search.indexPending', { pending: indexReadout.pending })}
          </span>
        </p>
      )}
      {indexReadout?.readerHost !== undefined && (
        <p className={s.end} data-readout="index-reader">
          <span className={s.moreText}>
            {t('search.indexReader', { host: indexReadout.readerHost })}
          </span>
        </p>
      )}
    </>
  )
}
