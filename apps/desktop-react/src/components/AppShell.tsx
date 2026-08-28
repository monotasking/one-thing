import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useExposeStore } from '../expose/store'
import { useKeymapDispatch } from '../keymap/dispatch'
import { ExposeOverlay } from '../expose/components/ExposeOverlay'
import { TopBar } from './TopBar'
import { ChatMock } from './ChatMock'
import { ComposerMock } from './ComposerMock'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { EdgeShelf } from './EdgeShelf'
import { SnapHint } from './SnapHint'
import { FloatLayer } from './FloatWindow'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { SCROLL_SETTLE_MS } from './motion'
import { SHELF_SIDES, withinDockEdgeBand } from '../stage/transitions'
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

export function AppShell() {
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  // L2 接线:总览开着时主区缩暗,总览层自己盖在上面。
  const exposeOpen = useExposeStore((st) => st.view.mode !== 'closed')

  /**
   * 全仓唯一的快捷键入口。以前这里手写着一条 ⌘P 监听,现在那条绑定是注册表里的
   * 一行数据(keymap/transitions.ts 的 DEFAULT_COMBOS),外壳只负责让派发器挂上。
   * 常驻监听住在这一层的理由没变:它得能在面板关着时把它叫起来,而面板此刻并不挂载。
   */
  useKeymapDispatch()

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
  const dockRef = useRef<HTMLDivElement>(null)

  /**
   * 自动隐藏的感应带 = 一次距离判定,**不是一个元素**(W2 清 Dock v2 留账:
   * 那条 8px 的 top 热区曾整条盖在 TopBar 上,把标题栏按钮吃掉)。
   * 判据在 transitions.withinDockEdgeBand 里,四条边共用同一句话。
   * 退出条件是「既不在带里、也不在 Dock 本体上」—— 后者让指针能从带里走进 Dock。
   */
  useEffect(() => {
    if (!autohide) {
      setPeeking(false)
      return
    }
    const onMove = (e: PointerEvent) => {
      const pointer = { x: e.clientX, y: e.clientY }
      const viewport = { w: window.innerWidth, h: window.innerHeight }
      if (withinDockEdgeBand(pointer, viewport, dockEdge)) {
        setPeeking(true)
        return
      }
      if (dockRef.current?.contains(e.target as Node)) return
      setPeeking(false)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [autohide, dockEdge])

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

      {/* 三明治网格:上架子一行 / [左架子 | 主区 | 右架子] / 下架子一行。
        * 架子是布局列/行,所以它挤压主区而不是盖住它(既有拍板)。
        * 空架子自己 return null,那条 auto 轨道就塌成 0 —— 「不渲染、不占布局」是同一件事。 */}
      <main className={exposeOpen ? `${s.main} ${s.mainDimmed}` : s.main}>
        {SHELF_SIDES.map((side) => (
          <EdgeShelf key={side} side={side} />
        ))}
        <div className={s.center}>
          {/* 键列钉在聊天区(不含输入框)的右缘,所以定位参考系是这一层 */}
          <div className={s.chatArea}>
            <ChatMock scrollRef={chatRef} onScroll={onScroll} flashIndex={flashIndex} />
            <TocPanel currentIndex={currentIndex} onPick={pickTurn} />
          </div>
          <ComposerMock />
        </div>
      </main>

      {/* 两种显示模式共用这一个浮层容器:always 从不加 .hidden,autohide 平时藏着。 */}
      <div ref={dockRef} className={dockClass}>
        <Dock dimmed={dimmed} />
      </div>

      {/* 浮窗层:在内容之上、在舞台 scrim 之下(--z-float 200 < --z-overlay 500)。 */}
      <FloatLayer />

      {/* 吸附预示:拖窗进热带时那条边浮出的薄膜。两个拖拽起点共用这一个消费者。 */}
      <SnapHint />

      <StageOverlay />
      <ExposeOverlay />
    </div>
  )
}
