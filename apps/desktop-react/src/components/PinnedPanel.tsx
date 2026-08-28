import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Tabs } from '../ui/Tabs'
import type { TabSpec } from '../ui/Tabs'
import { ChevronsRight } from './icons'
import { FLASH_MS } from './motion'
import s from './PinnedPanel.module.css'

/** 本批只有右边这条架子有真 UI(W2 接管另外三条),所以这个常量就是本组件的边。 */
const SIDE = 'right' as const

/**
 * 钉栏 = 右边那条架子的界面。它自己不画 tab 条 —— 那是 ui/Tabs 的活;
 * 这里只做四件事:把 shelf.tabs 翻成 TabSpec、渲染活动 tab 的内容、拖宽、收/展。
 *
 * 收起态是「同一个 <aside> 变窄」,不是换一个组件:aside 在 React 树里位置不变,
 * DOM 节点复用,所以宽度那一次过渡真的会跑;里面的内容当场换掉,不叠第二段动画。
 */
export function PinnedPanel() {
  const t = useT()
  const shelf = useStageStore((st) => st.shelves[SIDE])
  const flashPinned = useStageStore((st) => st.flashPinned)
  const setShelfThickness = useStageStore((st) => st.setShelfThickness)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const activateShelfTab = useStageStore((st) => st.activateShelfTab)

  const [flashing, setFlashing] = useState(false)
  const firstFlash = useRef(true)

  useEffect(() => {
    if (firstFlash.current) {
      firstFlash.current = false
      return
    }
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), FLASH_MS)
    return () => clearTimeout(t)
  }, [flashPinned])

  const toggleCollapsed = useCallback(() => toggleShelfCollapsed(SIDE), [toggleShelfCollapsed])
  const activate = useCallback((id: string) => activateShelfTab(SIDE, id), [activateShelfTab])

  // 拖柄:pointer events + capture,松手前不丢事件(拖到 iframe/浮层上也不断)。
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        setShelfThickness(SIDE, window.innerWidth - ev.clientX)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setShelfThickness],
  )

  // 持久化过的 id 可能已经不在 items 表里(将来 items 换来源时),查不到就当它不存在。
  const tabs = useMemo<TabSpec[]>(
    () =>
      shelf.tabs.flatMap((id) => {
        const item = findItem(id)
        return item ? [{ id: item.id, label: t(item.titleKey), icon: item.icon }] : []
      }),
    [shelf.tabs, t],
  )

  if (tabs.length === 0) return null
  const active = tabs.some((tab) => tab.id === shelf.activeId) ? shelf.activeId : null

  return (
    <aside
      className={[s.panel, shelf.collapsed && s.collapsed, flashing && s.flashing]
        .filter(Boolean)
        .join(' ')}
      style={{ width: shelf.collapsed ? 'var(--pin-rail-w)' : `${shelf.thickness}px` }}
      aria-label={t('pinned.label')}
    >
      {shelf.collapsed ? (
        <button
          type="button"
          className={s.rail}
          onClick={toggleCollapsed}
          aria-label={t('pinned.expand')}
        />
      ) : (
        <>
          <div className={s.resize} onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" />
          <div className={s.head}>
            <div className={s.tabsWrap}>
              <Tabs
                items={tabs}
                activeId={active}
                onSelect={activate}
                onClose={closeToDock}
                label={t('pinned.label')}
              />
            </div>
            <button
              type="button"
              className={s.collapse}
              onClick={toggleCollapsed}
              aria-label={t('pinned.collapse')}
            >
              <ChevronsRight className={s.collapseIcon} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <div className={s.body}>{renderContent(active)}</div>
        </>
      )}
    </aside>
  )
}
