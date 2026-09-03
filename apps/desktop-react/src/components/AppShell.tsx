import { useCallback, useEffect, useRef, useState } from 'react'
import { useStageStore } from '../stage/store'
import { useStageFocusFollow } from '../stage/focus-follow'
import { useViewportReclamp } from '../stage/viewport-reclamp'
import { useKeymapCommandRunner } from '../keymap/dispatch'
import { FocusScope } from '../focus/FocusScope'
import { useFocusDispatch } from '../focus/dispatch'
import { focusTree } from '../focus/registry'
import { TopBar } from './TopBar'
import { ErrorBoundary } from './ErrorBoundary'
import { ChatStream } from '../content/ChatStream'
import { Composer } from '../composer/components/Composer'
import { Dock } from './Dock'
import { StageOverlay } from './StageOverlay'
import { CoverLayer } from './CoverLayer'
import { EdgeShelf } from './EdgeShelf'
import { SnapHint } from './SnapHint'
import { FloatLayer } from './FloatWindow'
import { ToastHost } from '../ui/Toast'
import { ConfirmHost } from '../ui/Dialog'
import { WorkspacePalette } from '../workspace/components/WorkspacePalette'
import { TocPanel } from '../toc/TocPanel'
import { useChatToc } from '../toc/useChatToc'
import { DOCK_HIDE_DELAY_MS, DOCK_WAKE_DWELL_MS } from './motion'
import { useT } from '../i18n'
import { NOTIFICATIONS_ITEM_ID } from '../stage/items'
import { SHELF_SIDES, settledDockRect, shouldShowDock, withinDockWakeBand } from '../stage/transitions'
import type { Rect } from '../stage/transitions'
import type { Point } from '../stage/types'
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
   * **全壳唯一的键盘派发器**(09-02 R1,设计 §4.3)。
   *
   * 从前这一层挂两条 window 监听:`useKeymapDispatch`(全局命令)与
   * `useEscapeChain`(Esc 退一层)。两者现在都是响应链上的一格:
   *  · 全局命令 = root 作用域的命令表 —— 动作表仍在 `keymap/`(`useKeymapCommandRunner`),
   *    **共用一份不复制**,监听收进 `useFocusDispatch`;
   *  · 退层链 = root 的 `onEscape`(下面那句 `escapeTopmost`),沿活动路径由深到浅
   *    问下来的**最后一环**。
   *
   * 常驻挂在这一层的理由没变:它得能在面板关着时把面叫起来,而面板此刻并不挂载。
   */
  useFocusDispatch({ runCommand: useKeymapCommandRunner() })

  /**
   * **规则 3:挪到哪,焦点跟到哪**(设计 §3.5 / §11 拍点 2)。判据与执行整件在
   * `stage/focus-follow.ts`(一只纯函数 + 一只 hook)—— 这里只挂一次。
   */
  useStageFocusFollow()

  /**
   * **窗子改了尺寸 → 浮窗回到视口里**(09-04 §4)。与上面那一条同一个形:判据在
   * `stage/` 的纯函数里,壳只负责挂一次监听。挂在这一层的理由也一样 —— 它管的是
   * **所有**浮窗(还包括此刻关着、只在记忆里的那些),不是某一扇窗自己的事。
   */
  useViewportReclamp()

  /**
   * **规则 1:壳一挂起来就得有第一响应者**(设计 §3.5 规则 1)。
   *
   * 「启动时没有焦点」是错觉 —— 焦点环只在键盘会话亮(08-28 判例),所以看不出来;
   * 但没有第一响应者的那一刻,键盘是无主的:⌘F 找不到查看器、Esc 不知道退哪一层,
   * 而 `document.activeElement` 停在 `<body>` 上(I1 说的那种孤儿焦点)。
   *
   * 三级回落,**顺序就是判据**:
   *  ① 输入面板 —— 「有会话则是它的输入面板」(规则 1 的原话),这台壳的主内容
   *     恒在中央那条聊天区,输入面板是里面唯一「该打字的地方」;
   *  ② 消息流 —— 输入面板还没挂上来(错误边界塌了、或者这一帧还没到)时,
   *     主内容区仍然有一格能接住;
   *  ③ 壳根 —— 前两格都答不出时的结构兜底(它总在),于是 I1 恒成立。
   *
   * 只在**挂载**时发一次:再往后「焦点该在哪」由用户的手与那几条规则说了算,
   * 这一句不该在任何重渲染里再抢一次。
   */
  useEffect(() => {
    const landed =
      focusTree.activateScope('composer', { reason: 'restore' })
      || focusTree.activateScope('chat', { reason: 'restore' })
      || focusTree.activateScope('root', { reason: 'restore' })
    // 三格都答不出 = 树还一格都没登记完(理论上到不了这儿,因为根就在这一层)。
    if (!landed) focusTree.recoverOrphanFocus()
  }, [])

  /**
   * 退层链本体仍是 `stage/transitions.escapeTargetOf` 那个纯函数(次序 = z 序:
   * 盖 → 舞台 → 最上面那扇浮窗;架子是常驻家具,不在链里),这里只把它交给树。
   * 「接住了才拦」照旧:`escapeTopmost()` 没收掉任何面时答 false,这一下 Esc
   * 继续往后传(输入法组字、Composer 的两段式停止都在后面等它)。
   */
  const escapeTopmost = useStageStore((st) => st.escapeTopmost)

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
    /** 收回宽限:离开留驻区(或出了窗)之后缓一拍再收,路过抖动不塌;再进入即取消。 */
    const scheduleHide = () => {
      if (hideTimer) return
      hideTimer = setTimeout(() => {
        hideTimer = null
        setShown(false)
      }, DOCK_HIDE_DELAY_MS)
    }

    /*
     * ── 唤醒生命周期(09-03,报障「dock 的出现太敏感」)───────────────────────
     *
     * 「藏着 → 出来」这一跳前多了一道**停留门槛**:进带不算数,在带内连续停满
     * DOCK_WAKE_DWELL_MS 才唤醒。判据本身在纯函数 shouldShowDock 里(宿主只喂时间),
     * 这里管的是那张表的**寿命**,六件事:
     *
     *   进带 → **起表**:那一发 move 排一个计时器,记下进带的时刻。
     *   在带 → **续表**:之后每一发 move 只更新「最后一次已知指针」,计时器不重排
     *                     —— 停留是「连续待够」,不是「最后一下之后再等 180ms」。
     *   出带 → **清表**:任一方向离开窄带即 clearTimeout,下次进带重新计时。
     *   出窗 → **清表**:pointerleave / mouseout 无 relatedTarget / 坐标越出视口 /
     *                     window blur / 页面转入后台。**这一件是本批的另一半**:
     *                     出窗之后 pointermove 就停发了,计时器不会知道手已经走了,
     *                     于是「去点系统 Dock,我们的也跟着弹出来」。
     *   到点 → **再判一次**:拿最后一次已知指针再问一遍 shouldShowDock(带上真实
     *                     停留时长)。计时器到点不等于此刻还在带内 —— 最后一发 move
     *                     可能正踩在带外,或者干脆已经没有指针了。
     *   之后 → **交给留驻语义**:出来之后这条路一个字不动(24 余量 / 停稳位 /
     *                     300ms 收回宽限 / 08-31 那 12 组手势)。
     *
     * 这些量为什么不是 state:它们每帧都可能变,进依赖数组就是每帧重挂一次监听。
     */
    let wakeTimer: ReturnType<typeof setTimeout> | null = null
    let bandEnteredAt = 0
    let lastPointer: Point | null = null
    const cancelWake = () => {
      if (wakeTimer) {
        clearTimeout(wakeTimer)
        wakeTimer = null
      }
      lastPointer = null
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
       * 下面因此是**三段**,顺序就是判据的顺序:出窗 → 藏着(唤醒)→ 出来(留驻)。
       */
      const shown = peekingRef.current
      /*
       * 坐标越出视口 = 手已经不在这扇窗里了(拖到系统 Dock 上、拖到别的屏)。
       * 这一发之后 pointermove 多半就停发了,所以当场按「出窗」办 —— 详见 onLeaveWindow。
       */
      if (pointer.x < 0 || pointer.y < 0 || pointer.x > viewport.w || pointer.y > viewport.h) {
        onLeaveWindow()
        return
      }
      if (!shown) {
        /*
         * 藏着的时候 = 只认贴边窄带,**而且要停够**,连缓存都不必碰(纯算术,零 DOM)。
         * 这一支是「唤醒要克制」那条线:08-31「自动出现范围太大」与 09-03「出现太敏感」
         * 都由它守着 —— 前者管范围(窄带),后者管意图(停留)。
         *
         * **每帧零布局读**:进带那一发排一个计时器,之后每一发只做一次算术判「还在带内吗」。
         */
        if (!withinDockWakeBand(pointer, viewport, dockEdge)) {
          cancelWake()
          return
        }
        lastPointer = pointer
        if (!wakeTimer) {
          bandEnteredAt = Date.now()
          wakeTimer = setTimeout(() => {
            wakeTimer = null
            const settledPointer = lastPointer
            if (!settledPointer) return
            // 到点再判一次:判据仍只有 shouldShowDock 一处,宿主只把「停了多久」递进去。
            if (
              shouldShowDock({
                shown: false,
                pointer: settledPointer,
                viewport,
                edge: dockEdge,
                dwelledMs: Date.now() - bandEnteredAt,
              })
            ) {
              cancelHide()
              setShown(true)
            }
          }, DOCK_WAKE_DWELL_MS)
        }
        return
      }
      /*
       * 已经出来 = 留驻语义,**一个字没动**(09-03 只在上面那一跳前加了门槛)。
       * 量到手时判的是**停稳位**不是量到的那个矩形(08-31 修「唤醒后轻微上移秒消失」):
       * 滑入动画走 transform,140ms 里矩形一直在动,而手往上够那块瓦只要几十
       * 毫秒 —— 拿飞行中的位置去问「离开没有」,答案必然是「离开了」。
       * 真机时间线与换算见 transitions.settledDockRect 的注释。
       */
      const g = geom ?? measure()
      if (shouldShowDock({ shown: true, pointer, viewport, edge: dockEdge, rect: g?.rect })) {
        cancelHide()
        setShown(true)
        return
      }
      scheduleHide()
    }
    /*
     * 出窗:唤醒那张表**当场作废**,而已经出来的 Dock 走既有的 300ms 收回宽限
     * (出窗之后没有第二发 pointermove 来替它排这一拍,所以在这里排)。
     * 三个来源判的是同一件事「指针不在这扇窗里了」,缺一个都会漏:
     *   · pointerleave / mouseout(relatedTarget 为 null)—— 指针移出文档;
     *   · window blur —— 焦点被别的窗口拿走(点系统 Dock 就是这一条);
     *   · visibilitychange 转 hidden —— 窗口被遮住 / 转入后台,move 一样停发。
     */
    const onLeaveWindow = () => {
      cancelWake()
      if (peekingRef.current) scheduleHide()
    }
    const onMouseOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) onLeaveWindow()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onLeaveWindow()
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeaveWindow)
    document.addEventListener('mouseout', onMouseOut)
    window.addEventListener('blur', onLeaveWindow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelHide()
      cancelWake()
      classWatch.disconnect()
      treeWatch.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeaveWindow)
      document.removeEventListener('mouseout', onMouseOut)
      window.removeEventListener('blur', onLeaveWindow)
      document.removeEventListener('visibilitychange', onVisibility)
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
   * R1 起它是**真的根**:`onEscape` = 退层链(最后一环),`tabIndex={-1}` 随
   * `policy.moveFocus` 一起到位 —— 焦点无处可去时(浮层关掉、宿主卸载)结构性地
   * 回落到这块根上,I1 于是成立。根不画焦点环,那条唯一的容器例外在
   * `focus/focus-scope.css` 里。
   */
  return (
    <FocusScope scope="root" onEscape={escapeTopmost}>
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
