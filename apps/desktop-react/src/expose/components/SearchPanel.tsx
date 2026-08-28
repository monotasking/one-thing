import { useState } from 'react'
import { useStageStore } from '../../stage/store'
import { useExposeStore } from '../store'
import { Input } from '../../ui/Input'
import { Search } from '../../components/icons'
import { useT } from '../../i18n'
import { SearchResults } from './SearchResults'
import s from './SearchPanel.module.css'

/**
 * 检索面板 = 一块普通的 Dock 内容(id 'search'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 *
 * 它自己不写一行检索逻辑:命中来自 expose/transitions 的 searchSessions,
 * 三层结果与高亮直接复用 SearchResults + Highlight。词是这块面板自己的本地状态,
 * **不与 Exposé 顶部那条过滤条共用** —— 那是总览的筛子,这是一个独立的面。
 */
export function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)

  const onEnter = (sessionId: string) => {
    enterSession(sessionId)
    // 选中就是这块面板的活干完了,收回 Dock —— 与 Quick Look 进会话同一个手感。
    closeToDock('search')
  }

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <Input
          value={query}
          onValueChange={setQuery}
          size="lg"
          autoFocus
          prefix={<Search className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
          placeholder={t('expose.searchPlaceholder')}
          aria-label={t('expose.searchLabel')}
        />
      </div>
      <div className={s.body}>
        {query.trim() ? (
          <SearchResults query={query} onEnter={onEnter} />
        ) : (
          <p className={s.empty}>{t('search.empty')}</p>
        )}
      </div>
    </div>
  )
}
