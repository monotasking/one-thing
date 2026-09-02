import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useKeymapDispatch } from '../keymap/dispatch'
import { FocusScope } from '../focus/FocusScope'
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
import { DOCK_HIDE_DELAY_MS } from './motion'
import { useT } from '../i18n'
import { NOTIFICATIONS_ITEM_ID } from '../stage/items'
import { SHELF_SIDES, settledDockRect, shouldShowDock } from '../stage/transitions'
import type { Rect } from '../stage/transitions'
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

  /*
   * 聊天滚动 → 目录当前键跟随。**这条监听如今只剩这一件事**。
   *
   * 09-01 用户裁定退役了「滚动降淡」(滚动时把 Dock 调到 --dock-dim,停下再复原):
   * 「滚动的时候 Dock 会变透明,等一会又恢复——不要这个变化」。连根拔:状态、
   * 收尾计时器、`--dock-dim` / `--dur-scroll-settle` 两个 token、Dock 的 dimmed
   * 入口与 .dimmed 规则、动效档里那两行与它的两道门,一起清干净,不留半关的开关。
   * 顺带白赚一笔:它原来**每一发 scroll 都要 clearTimeout + setTimeout 一对**
   * (滚动事件一秒几十上百发),现在这条路上一个计时器都不排。
   */
  const onScroll = useCallback(() => {
    syncFromScroll()
  }, [syncFromScroll])

  const [peeking, setPeeking] = useState(false)
  const autohide = dockDisplay === 'autohide'
  const hidden = autohide && !peeking
  const dockRef = useRef<HTMLElement>(null)
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
    /*
     * ── 回身窗口随预览泡一起退役(09-02 用户裁定「不需要这个功能了」)──────
     *
     * 那道窗口(刚自己收起的 1.2s 内,「出来」认留驻区而不是 8px 窄带)只在
     * **收起那一刻泡开着**时才武装 —— 泡没了,武装条件永远为假,整条判据连同
     * `hiddenAt` / `sawPreview` / `hiddenWithPreview` 三个账本一起是死码。
     *
     * 它当年治的那桩「缝里来回闪」也是泡带来的:缝指的是瓦与泡之间那 12px。
     * 留在账上的仍是同一笔:**纯条身上溢**(径直往上越过留驻区)之后回身认窄带,
     * 那一截死区(真机量到 211px)从来就没被这道窗口盖住 —— 它今天照旧在。
     */
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

    /*
     * ── 几何**缓存**:pointermove 里一次布局都不读(09-01 真机 longFrame 修)──
     *
     * 用户通知中心抓到 `DOMWindow.onpointermove 388ms (fn=onMove @ AppShell.tsx)`。
     * 单发 pointermove 388ms 是灾难级 —— 这条路每秒跑几十上百发。
     * 真因不在判据(判据是纯算术),而在**强制同步布局**:修前每发 move 都
     * `getBoundingClientRect()` 一次(真机计数器实测 perMove=1;预览泡在场那会儿是 2),
     * 而这一下的代价 ∝ 整篇文档的布局复杂度 —— 用户那台是上百轮、**正在流式生成**
     * 的抄本,布局天天是脏的,于是每一发 move 都把整篇重排一遍。
     * (空 store 上量不出来:同一段代码在空抄本上 longtask 恒 0 —— 这也正是
     *  「手感类报障必须在真形态下量」的又一条判例。)
     *
     * 所以几何改成**事件驱动的缓存**:只有视口变了、条显隐了、条上的瓦增减了才重算。
     * 顺带治好第二件事:磁性放大让瓦长大 15px,修前判据每帧对着一条**正在动的边界**
     * 问「出界没有」;缓存之后边界不动了,而那点漂移远在 --dock-hold-pad(24)的
     * 余量之内,一个像素都不会误判。
     */
    let geom: { rect?: Rect } | null = null
    let viewport = { w: window.innerWidth, h: window.innerHeight }
    const invalidate = () => {
      geom = null
    }
    const onResize = () => {
      viewport = { w: window.innerWidth, h: window.innerHeight }
      invalidate()
    }
    /** 把 DOMRect 抄成朴素数(它的四条边是原型取值器,展开会得到空对象)。 */
    const plain = (b: DOMRect): Rect => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom })
    const measure = () => {
      const box = dockRef.current?.getBoundingClientRect()
      geom = {
        rect: box
          ? settledDockRect(plain(box), viewport, dockEdge, Number.isFinite(inset) ? inset : 0)
          : undefined,
      }
      return geom
    }
    window.addEventListener('resize', onResize)
    /*
     * 两台观察器,各盯一件事,**都不盯瓦的 style** —— 磁性放大每帧改一次
     * 每块瓦的行内宽高,盯上了就等于每帧失效一次,缓存白做。
     *   ① 容器自己的 class:显隐那一下(不含 subtree)
     *   ② 子树的增删:条上的瓦增减(藏瓦 / 会话组变动)、悬停名字条的挂载卸载
     *     —— 前者真的改条身尺寸,后者只是让缓存多失效一次(名字条是绝对定位,
     *     不进条身盒子),白重算一遍好过留一条会说谎的缓存。
     *     09-02 之前这一台盯的是**预览泡**的挂载 / 卸载,泡退役后剩下这两件。
     */
    const hostEl = dockRef.current
    const classWatch = new MutationObserver(invalidate)
    const treeWatch = new MutationObserver(invalidate)
    if (hostEl) {
      classWatch.observe(hostEl, { attributes: true, attributeFilter: ['class'] })
      treeWatch.observe(hostEl, { childList: true, subtree: true })
    }

    /** 状态只在**翻转沿**上写 —— 每发 move 都 setState 是第二笔白开销。 */
    const setShown = (next: boolean) => {
      if (peekingRef.current === next) return
      peekingRef.current = next
      setPeeking(next)
      invalidate()
    }

    const onMove = (e: PointerEvent) => {
      const pointer = { x: e.clientX, y: e.clientY }
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
      /*
       * 藏着的时候 = 只认贴边窄带,连缓存都不必碰(纯算术,零 DOM)。
       * 这一支也是「唤醒要克制」的那条线:08-31「自动出现范围太大」由它守着。
       */
      const g = shown ? (geom ?? measure()) : null
      if (shouldShowDock({ shown, pointer, viewport, edge: dockEdge, rect: g?.rect })) {
        cancelHide()
        setShown(true)
        return
      }
      // 收回宽限:离开留驻区后缓一拍再收,路过抖动不塌;再进入即取消。
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null
          setShown(false)
        }, DOCK_HIDE_DELAY_MS)
      }
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      cancelHide()
      classWatch.disconnect()
      treeWatch.disconnect()
      window.removeEventListener('resize', onResize)
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
   * 「覆盖必须有布局预留」在 Dock 上的落地(08-31 P0),09-01 改成**表面内衬形**。
   *
   * 宿主只说两件事:**让哪条边**(data-dock-reserve,自动隐藏档不挂 = 一格不让)
   * 与**按哪一档**(只换 --dock-tile 一个数)。「哪些面要让、让多少」全在
   * AppShell.module.css 那一段里写一次 —— 让位不再打在外壳身上(那会把面整体顶掉、
   * 露出外壳自己的底色,正是用户报的那条异色带),而是打在吃到那条边的面自己身上。
   */
  const shellClass = [s.shell, autohide ? null : RESERVE_SIZE_CLASS[dockSize]]
    .filter(Boolean)
    .join(' ')

  /*
   * **响应链的根**(09-02 R0,设计 `docs/design/react-shell-focus-2026-09.md` §9)。
   *
   * `<FocusScope>` 是 render-prop 形的:它自己**一个 DOM 节点都不渲染**,
   * 属性铺在下面那个本来就有的壳根上 —— 三明治网格(顶栏 / 三轨主区 / Dock)
   * 全靠这一层的类名与 grid 模板,中间插一层 div 会把布局掀了。
   *
   * R0 只立树、零消费者:根的 `onEscape` 还没接(R1 才把 `escapeTopmost()`
   * 挂上来当最后一环),`useKeymapDispatch` / `useEscapeChain` 一个字没动。
   * 这一层此刻交出去的只有 `data-focus-scope="root"`(I4 的第一格)与一个
   * 根元素引用;`tabIndex` 由 `FocusTree.policy.moveFocus` 闸着,R1 才出现
   * (理由写在 FocusScope.tsx 文件头)。
   */
  return (
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps} className={shellClass} data-dock-reserve={autohide ? undefined : dockEdge}>
          {/* 顶栏**就是**这扇窗的顶带(09-01 用户看真机后的裁定:红绿灯与 header 同一行)。
            * 系统标题栏已摘,所以壳里的第一件必须从 y=0 起 —— 顶栏自己承载拖拽区与
            * 红绿灯让位,判例写在 TopBar.tsx 的文件头。上一版那条独立的 28px 空带
            * (components/TitleBar.*)因此退役:它白占了一条。 */}
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

          {/* 两种显示模式共用这一个浮层容器:always 从不加 .hidden,autohide 平时藏着。
            *
            * 它是 `<nav>` 而不是 `<div>`(09-02):Dock 挂在 `<main>` **外面**,所以它
            * 画出来的东西——瓦、悬停名字条——都是「不在任何地标里」的页面内容,axe 的
            * region 那条会红(gate-a11y-settle 的 PARK 注释里记着这条留账)。地标类型
            * 取导航:整条 Dock 就是一排通往各块面的入口。**只换标签不换样式**:定位与
            * 显隐全在 `.dock` 那个类上,`<nav>` 与 `<div>` 的缺省 display 同为 block,
            * 真机截图字节级不动。 */}
          <nav ref={dockRef} className={dockClass} aria-label={t('dock.label')}>
            <Dock />
          </nav>

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
      )}
    </FocusScope>
  )
}
