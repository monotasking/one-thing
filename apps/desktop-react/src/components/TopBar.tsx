import { ChevronDown } from './icons'
import { AgentChip } from './AgentChip'
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
 *
 * 右侧那一格是 **agent 切换器**。原来站在这里的模型章(一枚写死的
 * `claude-opus-5`)08-30 退役:模型选择已经在 composer 上,顶栏再放一枚
 * 是同一件事说两遍。它当时连 i18n 键都没有(组件里一个字面量),
 * 所以这次退役没有留下任何孤儿键。
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
      <AgentChip />
    </header>
  )
}
