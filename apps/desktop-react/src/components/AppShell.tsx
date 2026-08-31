import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useKeymapDispatch } from '../keymap/dispatch'
import { TitleBar } from './TitleBar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from './ErrorBoundary'
import { ChatStream } from '../content/ChatStream'
import { Composer } from '../composer/components/Composer'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { CoverLayer } from './CoverLayer'
import { useEscapeChain } from './useEscapeChain'
import { EdgeShelf } from './EdgeShelf'
import { SnapHint } from './SnapHint'
import { FloatLayer } from './FloatWindow'
import { ToastHost } from '../ui/Toast'
import { ConfirmHost } from '../ui/Dialog'
import { WorkspacePalette } from '../workspace/components/WorkspacePalette'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { DOCK_HIDE_DELAY_MS, SCROLL_SETTLE_MS } from './motion'
import { useT } from '../i18n'
import { NOTIFICATIONS_ITEM_ID } from '../stage/items'
import { SHELF_SIDES, settledDockRect, shouldShowDock } from '../stage/transitions'
import { DOCK_AXIS } from '../stage/types'
import type { DockAlign, DockEdge, DockSize } from '../stage/types'
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

/** 预留哪一条边。与 EDGE_CLASS 是两张表:那张说 Dock 贴哪儿,这张说外壳让哪儿。 */
const RESERVE_CLASS: Record<DockEdge, string> = {
  bottom: s.reserveBottom,
  top: s.reserveTop,
  left: s.reserveLeft,
  right: s.reserveRight,
}

/** 预留量随大小档走;md 是 token 的缺省值,所以只有两档要覆写。 */
const RESERVE_SIZE_CLASS: Partial<Record<DockSize, string>> = {
  sm: s.reserveSm,
  lg: s.reserveLg,
}

export function AppShell() {
  const t = useT()
  const dockDisplay = useStageStore((st) => st.dockDisplay)
  const dockEdge = useStageStore((st) => st.dockEdge)
  const dockAlign = useStageStore((st) => st.dockAlign)
  // 预留那一截随大小档走,所以外壳也得订阅它(Dock 条自己另有一份)。
  const dockSize = useStageStore((st) => st.dockSize)
  const clickDockIcon = useStageStore((st) => st.clickDockIcon)

  /**
   * 全仓唯一的快捷键入口。以前这里手写着一条 ⌘P 监听,现在那条绑定是注册表里的
   * 一行数据(keymap/transitions.ts 的 DEFAULT_COMBOS),外壳只负责让派发器挂上。
   * 常驻监听住在这一层的理由没变:它得能在面板关着时把它叫起来,而面板此刻并不挂载。
   */
  useKeymapDispatch()

  /**
   * 全仓唯一的「Esc 退一层」宿主。与快捷键派发器分开挂,是因为它们是两件事:
   * 派发器认注册表(用户改得了键),退层链认形态(Esc 是形态语法的一部分,
   * 不参与改键 —— keymap/types.ts 顶部那段立的就是这条)。
   */
  useEscapeChain()

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
  /*
   * 「此刻出来了没有」的**逐帧读数**。pointermove 每帧都跑,而 peeking 是 state ——
   * 把它读进依赖数组就等于每次显隐都重挂一次监听(顺带把收回宽限的计时器一起丢掉)。
   * 所以状态照旧由 setPeeking 驱动渲染,判据这一侧读这个镜像。
   */
  const peekingRef = useRef(false)

  /**
   * 自动隐藏的感应带 = 一次距离判定,**不是一个元素**(W2 清 Dock v2 留账:
   * 那条 8px 的 top 热区曾整条盖在 TopBar 上,把标题栏按钮吃掉)。
   * 判据在 transitions.shouldShowDock 里,四条边、两个语义共用同一句话。
   */
  useEffect(() => {
    if (!autohide) {
      peekingRef.current = false
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
    /*
     * Dock 离那条边多远(--sp-3)。量一次而不是每帧问一次:它是个设计常数,
     * 不会在指针移动期间变 —— 而 pointermove 是每帧都跑的那条路。
     * 纯函数不读 CSS,所以由这里量了递进去。
     */
    const inset = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--sp-3'),
    )
    const onMove = (e: PointerEvent) => {
      const pointer = { x: e.clientX, y: e.clientY }
      const viewport = { w: window.innerWidth, h: window.innerHeight }
      /*
       * 唤醒与留驻是**两个语义**,分岔在 transitions.shouldShowDock 里
       * (09-01 修「dock 自动出现范围太大,输入都没法输入」——修前这里写的是
       *  `band || holdZone` 一行伺候两件事,于是留驻的宽容在还没唤醒时就生效,
       *  整条 composer 输入区落进唤醒区)。
       *
       * 藏着的时候连量都不量:留驻区讲的是「手已经在 Dock 上了」,那时候没有主语。
       * 顺带省下每帧一次 getBoundingClientRect —— pointermove 是每帧都跑的那条路。
       *
       * 量到手时判的是**停稳位**不是量到的那个矩形(08-31 修「唤醒后轻微上移秒消失」):
       * 滑入动画走 transform,140ms 里矩形一直在动,而手往上够那块瓦只要几十
       * 毫秒 —— 拿飞行中的位置去问「离开没有」,答案必然是「离开了」。
       * 真机时间线与换算见 transitions.settledDockRect 的注释。
       */
      const shown = peekingRef.current
      const box = shown ? dockRef.current?.getBoundingClientRect() : undefined
      /*
       * `DOMRect` → 一个**朴素对象**。它的 left/right/top/bottom 都是原型上的
       * 取值器,不是自有属性:任何一处 `{ ...domRect }` 都会得到一个空对象。
       * 转换收在这一处,纯函数那一侧从此只见得到朴素数(判例见 settledDockRect)。
       */
      const rect = box
        ? settledDockRect(
            { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
            viewport,
            dockEdge,
            Number.isFinite(inset) ? inset : 0,
          )
        : undefined
      /*
       * 泡开着的时候,泡也是 Dock 的地皮(09-01 修「移向 preview 途中整条 Dock 消失」)。
       * 泡不在条的盒子里(它 absolute 浮在条外),所以 settledDockRect 一辈子看不见它 ——
       * 真机读数:泡 220px 高,只有最下面 5.6px 落在留驻区里,指针一进泡就被判「人走了」,
       * 300ms 后整条 Dock 平移出屏,而泡是条的后代,于是跟着一起消失在手底下。
       *
       * 只在条已经出来时问一次 DOM:藏着的时候没有泡可言(pointermove 是每帧都跑的那条路)。
       */
      const bubble = shown ? dockRef.current?.querySelector('[data-preview]') : undefined
      const bubbleBox = bubble?.getBoundingClientRect()
      const previewRect = bubbleBox
        ? {
            left: bubbleBox.left,
            right: bubbleBox.right,
            top: bubbleBox.top,
            bottom: bubbleBox.bottom,
          }
        : undefined
      if (shouldShowDock({ shown, pointer, viewport, edge: dockEdge, rect, previewRect })) {
        cancelHide()
        peekingRef.current = true
        setPeeking(true)
        return
      }
      // 收回宽限:离开留驻区后缓一拍再收,路过抖动不塌;再进入即取消。
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null
          peekingRef.current = false
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

  /*
   * 「覆盖必须有布局预留」在 Dock 上的落地(08-31 P0)。**只有常显档才让** ——
   * 自动隐藏时 Dock 平时不在屏上,让了就是白让一整条边。
   * 让多少由 CSS 那两个式子说(tokens.css 的 --dock-reserve-*),这里只说「让哪条边、
   * 按哪一档」:哪一截该多宽是设计常数,不是组件该算的数。
   */
  const shellClass = [
    s.shell,
    autohide ? null : RESERVE_CLASS[dockEdge],
    autohide ? null : RESERVE_SIZE_CLASS[dockSize],
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={shellClass} data-dock-reserve={autohide ? undefined : dockEdge}>
      {/* 自绘顶带:系统标题栏没了之后,窗口唯一的拖拽把手(09-01 拍板)。
        * 它必须是壳里的第一件 —— 「内容从 y=0 起都是我们的」这句话的字面次序。 */}
      <TitleBar />
      <TopBar />

      {/* 三明治网格:上架子一行 / [左架子 | 主区 | 右架子] / 下架子一行。
        * 架子是布局列/行,所以它挤压主区而不是盖住它(既有拍板)。
        * 空架子自己 return null,那条 auto 轨道就塌成 0 —— 「不渲染、不占布局」是同一件事。 */}
      <main className={s.main}>
        {/*
          外壳的一级标题:只念不看(A11y 线 · A2)。
          这台上没有一句「大标题」可看 —— 顶栏是控件条,聊天区是内容。但读屏软件的
          「按标题浏览」是从 h1 起步的,一张没有 h1 的页,那一手从第一步就落空。
          所以补一个视觉隐藏的 h1,而不是把某个控件强行升格成标题。
          放在 <main> **里面**:axe 的 region 那条要的是「页面内容都落在地标里」,
          挂在 <main> 外面的话它自己就是那块无主内容。它是 position:absolute,
          不是网格项,三明治那三条轨道一格都不动。
        */}
        <h1 className="visually-hidden">{t('a11y.appTitle')}</h1>
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

      {/* 盖:第三种形态。09-01 用户推翻了「只接管内容栏」——盖要**盖满整扇窗**
        * (含顶带 / 顶栏 / 四条边上的架子),所以它从 .center 里搬到壳的根上,
        * 定位也从 absolute 换成 fixed(参考系换成视口)。
        *
        * 它与舞台的差别因此**不再是盖住多少**,而是那两件一直就在的事:
        * 盖是一块铺满的面(舞台是定尺画布 + scrim),而且它压不过浮窗
        * (--z-cover 100 < --z-float 200)。层级一格没动:Dock 仍在 650,
        * 所以盖开着时 Dock 照样唤得出、切得走 —— 那正是「盖=独占形态」该有的
        * 出口(独占的是内容,不是整台机器)。 */}
      <CoverLayer />

      {/* 两种显示模式共用这一个浮层容器:always 从不加 .hidden,autohide 平时藏着。 */}
      <div ref={dockRef} className={dockClass}>
        <Dock dimmed={dimmed} />
      </div>

      {/* 浮窗层:在内容之上、在舞台 scrim 之下(--z-float 200 < --z-overlay 500)。 */}
      <FloatLayer />

      {/* 吸附预示:拖窗进热带时那条边浮出的薄膜。两个拖拽起点共用这一个消费者。 */}
      <SnapHint />

      <StageOverlay />

      {/* 工作区命令面板(⌘⇧W)。挂在壳的根上一次 —— 它自己 portal 到 body,
        * 开关住在 workspace/components/palette-hub(与 agent 菜单同一手:
        * 两个产地共一个布尔)。 */}
      <WorkspacePalette />

      {/*
        useConfirm 的落点。挂一次,`ui/Dialog` 的那个单槽 hub 才有地方渲染 ——
        今天的用户是工作区删除的两段确认。它与 ToastHost 同层同理由:
        「问一句 yes/no」不该由每块业务面各摆一个自己的对话框。
      */}
      <ConfirmHost />

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
