import { useT } from '../../i18n'
import type { ReactNode } from 'react'
import type { MessageKey } from '../../i18n'
import s from './Settings.module.css'

/**
 * 一个领域一节:小节标题 + 若干行。
 *
 * 标题走 `<h3>` 是为了让辅助技术读得出层级,视觉上它只是一行 11px 的小字 ——
 * 层级由标签给,分量由 CSS 给,两件事不混。
 *
 * 分页之后一页仍可有**多节**(外观页两节:主题 + 阅读),所以这件没有跟着页表
 * 合并掉:页说的是「用户想改的是哪**类**事」,节说的是「哪**件**事」。
 */
export function Section({ titleKey, children }: { titleKey: MessageKey; children: ReactNode }) {
  const t = useT()
  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>{t(titleKey)}</h3>
      {children}
    </section>
  )
}
