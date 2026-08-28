import { useRef } from 'react'
import { ChevronDown, ChevronRight, Plus, Search } from '../../components/icons'
import { Button } from '../../ui/Button'
import { Kbd } from '../../ui/Kbd'
import { plural, useT } from '../../i18n'
import { GROUPS } from '../data'
import { useExposeStore } from '../store'
import { isCollapsed, searchSessions } from '../transitions'
import { SessionCard } from './SessionCard'
import { SearchResults } from './SearchResults'
import s from './Overview.module.css'

export function Overview() {
  const t = useT()
  const state = useExposeStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const searching = state.query.trim().length > 0

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    const first = searchSessions(state.query)[0]
    if (first) {
      e.preventDefault()
      state.enterSession(first.session.id)
    }
  }

  return (
    <div className={s.overview}>
      <header className={s.top}>
        <div className={s.searchWrap}>
          <Search className={s.searchIcon} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className={s.search}
            value={state.query}
            onChange={(e) => state.setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t('expose.searchPlaceholder')}
            aria-label={t('expose.searchLabel')}
          />
          <Kbd>{t('shortcut.palette')}</Kbd>
        </div>
        <Button variant="ghost" pill className={s.newProject}>
          <Plus className={s.newIcon} strokeWidth={1.75} aria-hidden="true" />
          {t('expose.newProject')}
        </Button>
      </header>

      <div className={s.scroll}>
        <div className={s.inner}>
          {searching ? (
            <SearchResults query={state.query} onEnter={state.enterSession} />
          ) : (
            GROUPS.map((group) => {
              const collapsed = isCollapsed(state, group.id)
              // 组名 / 副名两种来源:合成组给 key(界面文案),项目组给数据。
              const name = group.nameKey ? t(group.nameKey) : group.name
              const path = group.pathKey ? t(group.pathKey) : group.path
              const Caret = collapsed ? ChevronRight : ChevronDown

              /*
               * 折叠 / 展开是**原地形变**:组头这一行(以及它里面的开关按钮)在两态里
               * 是同一个 DOM 节点、同一个位置、同一个高度,只有下面的卡片区在条件渲染。
               * 组的次序永远只由 GROUPS(数据)决定,不因为谁被折叠而重排 ——
               * 这两条合起来才保证「鼠标不动连点 N 次 = 精确切换 N 次」。
               */
              return (
                <section key={group.id} className={s.group}>
                  <header className={s.groupHead}>
                    <button
                      type="button"
                      className={s.groupToggle}
                      data-testid={`group-toggle-${group.id}`}
                      aria-expanded={!collapsed}
                      onClick={() => state.toggleGroupCollapsed(group.id)}
                    >
                      <Caret className={s.caret} strokeWidth={1.75} aria-hidden="true" />
                      <span className={s.groupName}>{name}</span>
                      <span className={s.groupPath}>{path}</span>
                    </button>
                    <button
                      type="button"
                      className={s.count}
                      onClick={() => state.enterList(group.id)}
                    >
                      {t(
                        plural(
                          group.sessions.length,
                          'expose.sessionCountOne',
                          'expose.sessionCount',
                        ),
                        { count: group.sessions.length },
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      pill
                      iconOnly
                      className={s.plus}
                      aria-label={t('expose.newSessionIn', { name: name ?? group.id })}
                    >
                      <Plus className={s.plusIcon} strokeWidth={1.75} aria-hidden="true" />
                    </Button>
                  </header>

                  {/*
                    折叠 = 高度过渡而非瞬跳(用户 08-28 实机反馈:卡区瞬间消失、下方组咣当上移,变化不连续)。
                    grid-template-rows 1fr→0fr 技法:卡区保持挂载,收合时下方内容连续滑上来;
                    inert 把折叠态的卡从焦点序/命中区里摘掉(视觉隐藏 ≠ 可交互)。
                  */}
                  <div className={collapsed ? `${s.body} ${s.bodyClosed}` : s.body} inert={collapsed || undefined}>
                    <div className={s.bodyInner}>
                      <div className={s.grid}>
                        {group.sessions.map((session) => (
                          <SessionCard
                            key={session.id}
                            session={session}
                            current={session.id === state.currentSessionId}
                            focused={state.focusVisible && session.id === state.focusId}
                            onEnter={() => state.enterSession(session.id)}
                            onQuickLook={() => state.openQuickLook(session.id)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
