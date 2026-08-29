import { ChevronDown } from './icons'
import { useSessionsSource } from '../data/sessions-source'
import { findSession } from '../expose/projection'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'
import { SESSIONS_ITEM_ID } from '../stage/items'
import { useT } from '../i18n'
import s from './TopBar.module.css'

/**
 * 会话名是总览的入口:点一下 = 点 Dock 上那块「会话总览」瓦(08-29 去接管化拍板),
 * 所以它按用户给那块瓦设的打开方式开 —— 两个入口一条路,不是两套语义。
 * 标题本身仍然只是投影。
 */
export function TopBar() {
  const t = useT()
  const currentSessionId = useExposeStore((st) => st.currentSessionId)
  const sessions = useSessionsSource((st) => st.sessions)
  const click = useStageStore((st) => st.clickDockIcon)
  // 会话标题是**数据**(用户或后端给这条会话起的名),不翻译;
  // 只有「还没有当前会话」时的兜底名才是界面文案。
  const title = findSession(sessions, currentSessionId)?.title ?? t('topbar.newSession')

  return (
    <header className={s.bar}>
      <button type="button" className={s.titleBtn} onClick={() => click(SESSIONS_ITEM_ID)}>
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
