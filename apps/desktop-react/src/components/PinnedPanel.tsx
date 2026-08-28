import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import { renderContent } from '../content'
import { useT } from '../i18n'
import { Tabs } from '../ui/Tabs'
import type { TabSpec } from '../ui/Tabs'
import { FLASH_MS } from './motion'
import s from './PinnedPanel.module.css'

/**
 * 钉栏 = 一组 tab 的容器。它自己不画 tab 条 —— 那是 ui/Tabs 的活;
 * 这里只做三件事:把 pinned 翻成 TabSpec、渲染活动 tab 的内容、拖宽。
 */
export function PinnedPanel() {
  const t = useT()
  const pinned = useStageStore((st) => st.pinned)
  const activePinnedId = useStageStore((st) => st.activePinnedId)
  const pinnedWidth = useStageStore((st) => st.pinnedWidth)
  const flashPinned = useStageStore((st) => st.flashPinned)
  const setPinnedWidth = useStageStore((st) => st.setPinnedWidth)
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
      className={flashing ? `${s.panel} ${s.flashing}` : s.panel}
      style={{ width: `${pinnedWidth}px` }}
      aria-label={t('pinned.label')}
    >
      <div className={s.resize} onPointerDown={onPointerDown} role="separator" aria-orientation="vertical" />
      <Tabs items={tabs} activeId={active} onSelect={activate} onClose={unpin} label={t('pinned.label')} />
      <div className={s.body}>{renderContent(active)}</div>
    </aside>
  )
}
