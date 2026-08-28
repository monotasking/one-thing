import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useExposeStore } from '../expose/store'
import { ExposeOverlay } from '../expose/components/ExposeOverlay'
import { TopBar } from './TopBar'
import { ChatMock } from './ChatMock'
import { ComposerMock } from './ComposerMock'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { PinnedPanel } from './PinnedPanel'
import { FloatLayer } from './FloatWindow'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { SCROLL_SETTLE_MS } from './motion'
import { DOCK_AXIS } from '../stage/types'
import type { DockAlign, DockEdge } from '../stage/types'
import s from './AppShell.module.css'

/** 贴边类:边 → 那条边的物理坐标。 */
const EDGE_CLASS: Record<DockEdge, string> = {
  bottom: s.edgeBottom,
  top: s.edgeTop,
  left: s.edgeLeft,
  right: s.edgeRight,
}

/** 沿边类:先按轴分两套,再按三档取一 —— 轴由 DOCK_AXIS 说了算,这里不再判一次边。 */
const ALIGN_CLASS: Record<'x' | 'y', Record<DockAlign, string>> = {
  x: { start: s.alignXStart, center: s.alignXCenter, end: s.alignXEnd },
  y: { start: s.alignYStart, center: s.alignYCenter, end: s.alignYEnd },
}

const HOTZONE_CLASS: Record<DockEdge, string> = {
  bottom: s.hotzoneBottom,
  top: s.hotzoneTop,
  left: s.hotzoneLeft,
  right: s.hotzoneRight,
}

export function AppShell() {
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const pinnedCount = useStageStore((st) => st.shelves.right.tabs.length)
  const toggleItem = useStageStore((st) => st.toggleItem)
  // L2 接线:总览开着时主区缩暗,总览层自己盖在上面。
  const exposeOpen = useExposeStore((st) => st.view.mode !== 'closed')

  /**
   * ⌘P = 开关检索面板(08-29 拍板:与 Dock 上那块瓦同一个东西,不再是"盖一层总览")。
   * 全局常驻监听住在外壳这一层:它得能在面板关着时把它叫起来,而面板此刻并不挂载。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'p') return
      e.preventDefault()
      toggleItem('search')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleItem])

  // 聊天滚动容器只有一个 ref,两个消费者:Dock 降淡 与 TOC 当前键。
  const chatRef = useRef<HTMLDivElement>(null)
  const { currentIndex, flashIndex, syncFromScroll, pickTurn } = useChatToc(chatRef)

  // 滚动降淡:只在这里存一次,Dock 拿到的是结论而不是滚动事件。
  const [dimmed, setDimmed] = useState(false)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onScroll = useCallback(() => {
    setDimmed(true)
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => setDimmed(false), SCROLL_SETTLE_MS)
    // 聊天滚动 → 当前键跟随。两件事共用同一个滚动事件,不各挂各的监听。
    syncFromScroll()
  }, [syncFromScroll])

  const [peeking, setPeeking] = useState(false)
  const autohide = dockDisplay === 'autohide'
  const hidden = autohide && !peeking

  const dockClass = [
    s.dock,
    EDGE_CLASS[dockEdge],
    ALIGN_CLASS[DOCK_AXIS[dockEdge]][dockAlign],
    hidden && s.hidden,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={s.shell}>
      <TopBar />

      <main className={exposeOpen ? `${s.main} ${s.mainDimmed}` : s.main}>
        <div className={s.center}>
          {/* 键列钉在聊天区(不含输入框)的右缘,所以定位参考系是这一层 */}
          <div className={s.chatArea}>
            <ChatMock scrollRef={chatRef} onScroll={onScroll} flashIndex={flashIndex} />
            <TocPanel currentIndex={currentIndex} onPick={pickTurn} />
          </div>
          <ComposerMock />
        </div>
        {pinnedCount > 0 && <PinnedPanel />}
      </main>

      {autohide && (
        <div
          className={`${s.hotzone} ${HOTZONE_CLASS[dockEdge]}`}
          onMouseEnter={() => setPeeking(true)}
        />
      )}

      {/* 两种显示模式共用这一个浮层容器:always 从不加 .hidden,autohide 平时藏着。 */}
      <div className={dockClass} onMouseLeave={autohide ? () => setPeeking(false) : undefined}>
        <Dock dimmed={dimmed} />
      </div>

      {/* 浮窗层:在内容之上、在舞台 scrim 之下(--z-float 200 < --z-overlay 500)。 */}
      <FloatLayer />

      <StageOverlay />
      <ExposeOverlay />
    </div>
  )
}
