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

/**
 * 钉栏 = 一组 tab 的容器。它自己不画 tab 条 —— 那是 ui/Tabs 的活;
 * 这里只做四件事:把 pinned 翻成 TabSpec、渲染活动 tab 的内容、拖宽、收/展。
 *
 * 收起态是「同一个 <aside> 变窄」,不是换一个组件:aside 在 React 树里位置不变,
 * DOM 节点复用,所以宽度那一次过渡真的会跑;里面的内容当场换掉,不叠第二段动画。
 */
export function PinnedPanel() {
  const t = useT()
  const pinned = useStageStore((st) => st.pinned)
  const activePinnedId = useStageStore((st) => st.activePinnedId)
  const pinnedWidth = useStageStore((st) => st.pinnedWidth)
  const collapsed = useStageStore((st) => st.pinnedCollapsed)
  const flashPinned = useStageStore((st) => st.flashPinned)
  const setPinnedWidth = useStageStore((st) => st.setPinnedWidth)
  const toggleCollapsed = useStageStore((st) => st.togglePinnedCollapsed)
  const unpin = useStageStore((st) => st.unpin)
  const activate = useStageStore((st) => st.activatePinnedTab)

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

  // 拖柄:pointer events + capture,松手前不丢事件(拖到 iframe/浮层上也不断)。
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent) => {
        setPinnedWidth(window.innerWidth - ev.clientX, window.innerWidth)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setPinnedWidth],
  )

  // 持久化过的 id 可能已经不在 items 表里(将来 items 换来源时),查不到就当它不存在。
  const tabs = useMemo<TabSpec[]>(
    () =>
      pinned.flatMap((id) => {
        const item = findItem(id)
        return item ? [{ id: item.id, label: t(item.titleKey), icon: item.icon }] : []
      }),
    [pinned, t],
  )

  if (tabs.length === 0) return null
  const active = tabs.some((t) => t.id === activePinnedId) ? activePinnedId : null

  return (
    <aside
      className={[s.panel, collapsed && s.collapsed, flashing && s.flashing].filter(Boolean).join(' ')}
      style={{ width: collapsed ? 'var(--pin-rail-w)' : `${pinnedWidth}px` }}
      aria-label={t('pinned.label')}
    >
      {collapsed ? (
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
              <Tabs items={tabs} activeId={active} onSelect={activate} onClose={unpin} label={t('pinned.label')} />
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
