import { ChevronDown } from './icons'
import { findSession } from '../expose/data'
import { useExposeStore } from '../expose/store'
import { useT } from '../i18n'
import s from './TopBar.module.css'

/** L2 接线:会话名成了总览的入口(点一下 = expose.toggle),标题本身仍然只是投影。 */
export function TopBar() {
  const t = useT()
  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const toggle = useExposeStore((st) => st.toggle)
  // 会话标题是 mock 数据,不翻译;只有「一个都没有」时的兜底名是界面文案。
  const title = findSession(currentSessionId)?.title ?? t('topbar.newSession')

  return (
    <header className={s.bar}>
      <button type="button" className={s.titleBtn} onClick={toggle} aria-haspopup="dialog">
        <span className={s.title}>{title}</span>
        <ChevronDown className={s.titleIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className={s.chip}>
        claude-opus-5
        <ChevronDown className={s.chipIcon} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </header>
  )
}
