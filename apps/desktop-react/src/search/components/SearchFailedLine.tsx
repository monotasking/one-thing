import type { TFn } from '../../i18n'
import s from './SearchPanel.module.css'

/**
 * **整发塌了那一行**(列表上方,滚动容器外)。
 *
 * 第 ⑥ 步从 `SearchPanel.tsx:788-793` 原样搬出来。判据一个字没变:
 *
 *  · 检索失败**不许静默** —— 它与「没搜到」是两件事,合成一句「无结果」等于把
 *    一次失败说成一次空结果;
 *  · 这一行在**有命中时也画**(旧结果还在屏上,而这一发确实塌了,律②:错误不
 *    抹掉旧答案);
 *  · **后端原话原样跟在后面**(拍点 A′ 默认保旧 —— 只有预览栏那一处被裁定不露
 *    原话,列表这一行是既有行为)。
 */
export interface SearchFailedLineProps {
  /** 后端说的那句原话;缺席 = 这一发没塌,整行不画。 */
  error: string | undefined
  t: TFn
}

export function SearchFailedLine({ error, t }: SearchFailedLineProps) {
  if (error === undefined) return null
  return (
    <p className={s.failed}>
      {t('search.queryFailed')}
      <span className={s.failedDetail}>{error}</span>
    </p>
  )
}
