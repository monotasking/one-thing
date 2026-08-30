import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useKeymapDispatch } from '../keymap/dispatch'
import { TopBar } from './TopBar'
import { ErrorBoundary } from './ErrorBoundary'
import { ChatStream } from '../content/ChatStream'
import { Composer } from '../composer/components/Composer'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { EdgeShelf } from './EdgeShelf'
import { SnapHint } from './SnapHint'
import { FloatLayer } from './FloatWindow'
import { ToastHost } from '../ui/Toast'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { DOCK_HIDE_DELAY_MS, SCROLL_SETTLE_MS } from './motion'
import { useT } from '../i18n'
import { NOTIFICATIONS_ITEM_ID } from '../stage/items'
import { SHELF_SIDES, withinDockEdgeBand, withinDockHoldZone } from '../stage/transitions'
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
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  const clickDockIcon = useStageStore((st) => st.clickDockIcon)

  /**
   * 全仓唯一的快捷键入口。以前这里手写着一条 ⌘P 监听,现在那条绑定是注册表里的
   * 一行数据(keymap/transitions.ts 的 DEFAULT_COMBOS),外壳只负责让派发器挂上。
   * 常驻监听住在这一层的理由没变:它得能在面板关着时把它叫起来,而面板此刻并不挂载。
   */
  useKeymapDispatch()

  // 聊天滚动容器只有一个 ref,两个消费者:Dock 降淡 与 TOC 当前键。
  const chatRef = useRef<HTMLDivElement>(null)
  const { currentIndex, flashMessageId, syncFromScroll, pickTurn } = useChatToc(chatRef)

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
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    const cancelHide = () => {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
    }
    const onMove = (e: PointerEvent) => {
      const pointer = { x: e.clientX, y: e.clientY }
      const viewport = { w: window.innerWidth, h: window.innerHeight }
      // 留驻 = 在边带里,或在「Dock 矩形补到视口边 + 余量」的留驻区里 ——
      // 边带与本体之间原有 4px 死缝,真鼠标连续移动必经,曾致"一闪而逝"。
      const rect = dockRef.current?.getBoundingClientRect()
      const hold =
        withinDockEdgeBand(pointer, viewport, dockEdge) ||
        (rect ? withinDockHoldZone(pointer, viewport, dockEdge, rect) : false)
      if (hold) {
        cancelHide()
        setPeeking(true)
        return
      }
      // 收回宽限:离开留驻区后缓一拍再收,路过抖动不塌;再进入即取消。
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null
          setPeeking(false)
        }, DOCK_HIDE_DELAY_MS)
      }
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      cancelHide()
      window.removeEventListener('pointermove', onMove)
    }
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
      <main className={s.main}>
        {SHELF_SIDES.map((side) => (
          <EdgeShelf key={side} side={side} />
        ))}
        <div className={s.center}>
          {/* 键列钉在聊天区(不含输入框)的右缘,所以定位参考系是这一层 */}
          <div className={s.chatArea}>
            {/* 聊天区与输入框**各一界**:消息流炸了还能打字,输入框炸了还能读历史。
              * 合成一界的话这两件事会互相拖死,那正是分区边界要避免的。 */}
            <ErrorBoundary where="chat">
              <ChatStream scrollRef={chatRef} onScroll={onScroll} flashMessageId={flashMessageId} />
            </ErrorBoundary>
            <TocPanel currentIndex={currentIndex} onPick={pickTurn} />
          </div>
          <ErrorBoundary where="composer">
            <Composer />
          </ErrorBoundary>
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

      {/*
        Toast 的落点。挂在壳的根上一次,notify 才有地方渲染(它自己 portal 到 body)。
        文案与「点小丸去哪」由这一层给 —— ui/ 组件不认识 i18n,也不认识通知中心是哪块瓦。
        小丸走的就是**点 Dock 图标**那条路(clickDockIcon = 按它自己的打开方式开),
        不是另开一个特权浮层:通知中心是一块普通的瓦,进出口只该有一条。
      */}
      <ToastHost
        closeLabel={t('common.close')}
        moreText={(count) => t('notify.more', { count })}
        onMore={() => clickDockIcon(NOTIFICATIONS_ITEM_ID)}
      />
    </div>
  )
}
