import { ChevronDown } from './icons'
import { findSession } from '../expose/data'
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
  const click = useStageStore((st) => st.clickDockIcon)
  // 会话标题是 mock 数据,不翻译;只有「一个都没有」时的兜底名是界面文案。
  const title = findSession(currentSessionId)?.title ?? t('topbar.newSession')

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
