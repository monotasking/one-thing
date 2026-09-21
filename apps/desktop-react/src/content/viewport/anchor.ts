import { SCROLL_ANCHOR_SETTLE_MS } from '../../components/motion'
import {
  readSessionScrollAnchor,
  saveSessionScrollAnchor,
  type ScrollAnchor,
} from '../../data/session-view-state'
import {
  AT_BOTTOM_EPS,
  FOLLOW_PINNED,
  followShouldStick,
  reduceFollow,
  type FollowEvent,
  type FollowState,
} from '../follow'
import { AnchorRecorder } from './anchor-recorder'
import { EntryRestore } from './entry-restore'
import { IntentWindow } from './intent-window'
import { Slide } from './slide'
import { TailPad } from './tail-pad'
import type { AnchoredElement, ResizeBatch, ScrollPort } from './scroll-port'

/**
 * **视口锚定器**(G 线 P2-a,正本 `docs/stream-geometry-2026-09.md` §13.2.3)——
 * 唯一的裁决者,也是**唯一**写滚动位的人(它经 `ScrollPort.setTop` 写)。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────
 * 从前这一整套住在 `ChatStream.tsx` 的 `useFollowBottom` 里:一只 1039 行、49 次
 * hook 调用、22 格 ref 的函数。它不是「写得乱」—— 每一格都有判词、每一格都有事故
 * 背书 —— 它是**一个类被写成了一只 hook**:22 格 ref 就是 22 个私有字段,14 个
 * `useCallback` 就是 14 个方法,6 只 `useLayoutEffect` + 4 只 `useEffect` 就是
 * 生命周期与外部事件的接线。P2-a 做的是把它**还原成那个类**,而不是重写它。
 *
 * ── P2-a 的纪律:一行裁决都不改 ──────────────────────────────────────────
 * 下面每一支 `if`、每一个时限常量、每一处早退的先后,都是从那只 hook 里**原样**
 * 搬过来的 —— 包括 `onResize` 里那句「什么都没变就早退」(它的注与代码对不上,
 * §13.5 记着这件事,**照代码搬,不照注释重写**),以及那几格早退各自跳过哪些判据
 * 的次序。唯一的行为收口在 `ScrollPort.setTop`(停靠守卫与 `lastTop` 同步),
 * 判词在那只文件的头上。
 *
 * ── 零 DOM、零 React ──────────────────────────────────────────────────────
 * 它只认 `ScrollPort` 与五个协作者,所以 vitest 里喂一只 `FakeScrollPort`(纯数字)
 * 就能把整张裁决表逐格测到,不必靠 jsdom 几何 —— 今天 `fold-anchor` /
 * `expand-hold` 那几组是靠篡改 `clientHeight` 的 property descriptor 撑起来的。
 *
 * ── 实例的寿命 ────────────────────────────────────────────────────────────
 * **一次挂载一只,换会话不换实例**。§13.2.3 的终态是「换会话换一个实例」,
 * P2-a **故意没有这么做**:今天 `lastGap` / `lastColumnHeight` / `lastTop` /
 * `follow` 这几格跨会话是**留着**的(换会话只派一发 `enter` 与清一格展开意图),
 * 换实例等于把它们一起清零 —— 那是一次行为改动,不属于「抽件不改行为」。
 * 记在正本 §14 留账,归 P2-c 之后再议。
 */
export class ViewportAnchor {
  readonly #port: ScrollPort
  readonly #pad: TailPad
  readonly #intents: IntentWindow
  readonly #slide: Slide
  readonly #restore: EntryRestore
  readonly #recorder: AnchorRecorder
  readonly #onFollowChange: (next: FollowState) => void
  readonly #now: () => number
  readonly #foldSlackMs: number
  readonly #expandHoldMs: number

  /**
   * 跟随状态的**镜像**。滚动回调与 ResizeObserver 都在 React 之外跑,它们要的是
   * 「此刻是哪一格」而不是「上一次渲染时是哪一格」—— 读 state 会慢一帧,而那一帧
   * 正好是流式期间每一帧都要判的那一次。写镜像与推 state 在同一句里(`dispatch`),
   * 两者不会分叉。
   */
  #follow: FollowState = FOLLOW_PINNED

  /**
   * 上一次量到的 gap。**它的唯一用途是回答「刚长出来的那一截在不在视口下面」**:
   * 长在视口**上面**的内容会被浏览器的滚动锚定顶回去,gap 不变;长在下面的才让
   * gap 变大。写点跟着「gap 会变的那几条路」走:进场落定、滚动停下、RO 回调。
   */
  #lastGap = 0

  /** 内容列上一次报来的高 —— 「长了没有 / 变了没有」的参照。 */
  #lastColumnHeight = 0

  /**
   * **取回那一拍要对的位**(在场 = 「刚被拿回来,还没对过」)。
   * 立它的是宿主那一拍(零几何读),消它的是 `onResize`。
   */
  #pendingRestore: number | undefined = undefined

  constructor(port: ScrollPort, options: ViewportAnchorOptions) {
    this.#port = port
    this.#onFollowChange = options.onFollowChange
    this.#now = options.now ?? (() => performance.now())
    this.#foldSlackMs = options.foldSlackMs
    this.#expandHoldMs = options.expandHoldMs
    this.#pad = new TailPad(port)
    this.#intents = new IntentWindow()
    this.#restore = new EntryRestore()
    this.#slide = new Slide(port, {
      durationOf: options.slideDurationOf,
      onSettle: () => void (this.#lastGap = port.gapNow()),
      frames: options.frames,
    })
    this.#recorder = new AnchorRecorder({
      hasLayout: () => port.hasLayout(),
      measure: () => port.measureAnchor(),
      save: options.saveAnchor ?? saveSessionScrollAnchor,
      settleMs: options.settleMs ?? SCROLL_ANCHOR_SETTLE_MS,
      timers: options.timers,
    })
    this.#readAnchor = options.readAnchor ?? readSessionScrollAnchor
  }

  readonly #readAnchor: (sessionId: string) => ScrollAnchor | undefined

  /* ── 读面(给 React 渲染用)──────────────────────────────────────────── */

  get follow(): FollowState {
    return this.#follow
  }

  /** 卷尾垫块 —— 座位那三格的写点在落位那一路上,所以它对外可达。 */
  get pad(): TailPad {
    return this.#pad
  }

  /** 这一刻正在滑吗(「座位同帧跟上」那只 layout effect 的第三道闸)。 */
  get sliding(): boolean {
    return this.#slide.running
  }

  /* ── 渲染期事实 ──────────────────────────────────────────────────────── */

  /** 这条会话此刻有没有座位(= 这次进场之后自己发过话)。 */
  set seatActive(next: boolean) {
    this.#pad.active = next
  }

  /* ── 跟随状态机 ──────────────────────────────────────────────────────── */

  dispatch(event: FollowEvent): void {
    const next = reduceFollow(this.#follow, event)
    // 纯函数在「什么都没改」时返回同一个对象 —— 流式每帧那一次 `grew` 于是白送。
    if (next === this.#follow) return
    this.#follow = next
    this.#onFollowChange(next)
  }

  /**
   * 贴底。三个调用点(进场 / 长高 / 点丸)都经它。
   * 停靠守卫与 `lastTop` 同步都在那个写口里做一次;走 `stickToBottom` 而不是
   * `measure()` + `setTop`,是因为**这一句每帧都跑**,不该为它多读一张读数
   * (正本 §13.1.5 己 那条留账说的就是这一族的账)。
   */
  #stick(): void {
    this.#port.stickToBottom('tail-growth')
  }

  /** 点丸 / 明确要求回底:先落、再翻状态(两句的次序无所谓,状态机不看几何)。 */
  jumpToBottom(): void {
    this.#stick()
    this.dispatch({ type: 'jumpToBottom' })
  }

  /* ── 生命周期 ────────────────────────────────────────────────────────── */

  /**
   * 换会话 = 一次新的进场。
   *
   * 缺省仍旧是**落底**(`enter` → pinned),只在两件事同时成立时改写它:记着一个
   * 消息锚点,**而且**那条消息此刻真的在树上。后半句正是停靠池命中的那条路;
   * 冷载入时树是空的,`applyAnchor` 如实回 false,于是老实落底 ——「先贴底再跳
   * 一次」与「首帧就在底,不许先画顶部再跳」相悖。
   *
   * 落成了之后**补一发 `scrolled`**:那是状态机认得的那句「滚动停下来了,此刻离底
   * 这么远」,它自己会把状态翻成 browsing。不新开一个 `restore` 事件 —— 事件多一个,
   * `follow.ts` 那张转移表就要多一行,而这一下与人自己滚上去在语义上逐字相同。
   */
  enter(sessionId: string, facts: { hasElement: boolean; hasMessages: boolean }): void {
    this.dispatch({ type: 'enter' })
    // 换会话不带上一条会话的意图:那格截止时刻说的是「**那边**有人点开了一样东西」。
    this.#intents.clearExpand()
    /** 落定一次:把「此刻离底多远」交给状态机、记进 gap 基准、把锚点记一笔。 */
    const settle = () => {
      const gap = this.#port.gapNow()
      this.dispatch({ type: 'scrolled', gap })
      this.#lastGap = gap
      // 落成了 —— 此刻量到的就是真的,当场记一笔,不等这条会话被人再滚一次。
      this.#recorder.saveNow(sessionId)
    }
    const anchor = this.#readAnchor(sessionId)
    if (facts.hasElement && anchor && anchor !== 'bottom' && this.#port.applyAnchor(anchor)) {
      settle()
      /*
       * ── 落完还要再对(2026-09-10,`content-visibility: auto` 的直接后果)──────
       * 判词全文在 `EntryRestore` 上:跳渲的行占的是估高的位,赋完 `scrollTop`
       * 那几行渲出真高、锚点跟着漂(真机 188px)。这里只立一格「还没落稳」,
       * 真正再对由 `onResize` 做。
       */
      this.#restore.arm(anchor)
    } else if (facts.hasElement && facts.hasMessages && followShouldStick(this.#follow)) {
      /*
       * ── 进场落底 ──────────────────────────────────────────────────────────
       * 缺省进场就是 pinned,这里当场落一次底。**这一次是不可避免的**:树刚挂上,
       * 谁都还不知道它有多高,读 `scrollHeight` 必然逼出一次排版。
       * **空树不落**:此刻 `scrollHeight` 就是视口高,落了等于什么都没做,而冷载入
       * 那条路上消息到齐会让内容列长高 —— 那一发由 `onResize` 接住。
       */
      this.#stick()
      this.#lastGap = this.#port.gapNow()
    }
  }

  /** 离场(换会话 / 卸载)。`hasElement` 由宿主给 —— 它说的是**进场那一刻**那个节点。 */
  leave(sessionId: string, hasElement: boolean): void {
    // 还没到点的那一发不能跨会话开火 —— 它闭包着**上一条**会话的 id。
    this.#recorder.cancel()
    // 还没落稳的那一格同理:它闭包着上一条会话的锚点。
    this.#restore.clear()
    if (hasElement) this.#recorder.saveNow(sessionId)
  }

  /** 观察者挂上那一拍的两格基准(今天 RO layout effect 开头那两句)。 */
  beginObserving(): void {
    this.#lastColumnHeight = this.#port.columnHeight()
    this.#lastGap = this.#port.gapNow()
  }

  /** 座位退役 / 换会话:那格「已写的数」也要归零。 */
  retireSeat(): void {
    this.#pad.retire()
  }

  /** 滑动那一帧属于已经不在的那棵树 —— 卸载 / 换会话时撤掉。 */
  cancelLanding(): void {
    this.#slide.cancel()
  }

  dispose(): void {
    this.#slide.cancel()
    this.#recorder.cancel()
    this.#pad.dispose()
  }

  /* ── 外面报进来的事实 ────────────────────────────────────────────────── */

  /** 「我这一下是用户点开的,别贴底」(`content/expand-intent.ts` 那条 context)。 */
  noteUserExpand(): void {
    this.#intents.noteExpand(this.#now(), this.#expandHoldMs)
  }

  /** 「我这一块开始往回折了,接下来 `ms` 毫秒请钉住视口」(`content/fold-intent.ts`)。 */
  noteFold(ms: number): void {
    this.#intents.noteFold(this.#now(), ms + this.#foldSlackMs)
  }

  /**
   * ── **人亲手开合了一块东西**(G 线 P2-b;`content/geometry-report.ts` 那条通道)──
   *
   * 这是 §13.2.2 裁决表里 `user-toggle` 那一行,今天只接这一格 cause:
   *  · `open === false`(收起,`deltaH < 0`)—— **先 `absorb` 再 `pin('reported')`**:
   *    同步把垫块加长到「缩完之后 `scrollTop` 仍然合法」的高度(页面总高不变,G1),
   *    再把**被点的那一块**钉成接下来这一段的锚(它的顶边不许动,§1 推论二)。
   *  · `open === true`(展开)—— **今天的行为一格不改**:`expand-intent` 的按兵不动。
   *    不走折叠那一支的理由写在正本 §15.2:那一支整段早退、不派 `scrolled`,
   *    而展开那一支要靠 `scrolled` 把跟随档按「此刻离底多远」重判;换过去的话
   *    窗口一过 `stick()` 就把人拽到底。
   *
   * **它是同步的,而且跑在 React 提交之前**(调用点是事件处理函数)——「收缩先申请、
   * 后执行」因此不靠注释:`ui/flip-height` 那一读(`el.offsetHeight`,逼一次排版)
   * 排在提交里的 layout effect 上,一定晚于这里。
   *
   * **零 DOM**:`block` 已经被薄 hook 收成纯数字 + 两个问句(`AnchoredElement`)。
   */
  reportUserToggle(change: UserToggleReport): void {
    const now = this.#now()
    const block = change.block
    // 后到的那一句说了算(判词在 `IntentWindow.clearFold`)。
    this.#intents.clearFold()
    if (!block) {
      /*
       * 没点名(样例页 / 单测 / 节点还没挂上):退回今天那条路 —— 收起由下一帧在
       * RO 回调里现选锚,展开只说一句「别贴底」。
       */
      if (change.open) this.#intents.noteExpand(now, this.#expandHoldMs)
      else this.#intents.noteFold(now, change.durationMs + this.#foldSlackMs)
      return
    }
    /*
     * ── **落点**(审查裁定 1,2026-09-22)──────────────────────────────────
     *   收起之后被点那一块的顶边 y = `max(收起前的顶边 y, 视口上缘 + 上内衬)`
     *
     * · 顶边本来就在视口里 → 它一像素不动(与 09-21 那一档逐字相同);
     * · 顶边在视口**上方**(思考段几乎总是这一档)→ 收起后的那一行落在视口上缘,
     *   后面的内容紧跟着往下排。这与 `ui/Fold` 底把手从前那一发
     *   `scrollIntoView`(收起后把头把手送回视野)是同一个意图,只是现在由这里
     *   **同一帧一次写到位**,不再是三只手各写一次(正本 §13.1.5 甲)。
     *
     * **展开那一侧不套这条落点**:它要的就是字面的「顶边不动」,而展开不会让
     * 顶边跑到屏外去。
     */
    const view = this.#port.viewportRect()
    const landing = change.open
      ? block.top
      : Math.max(block.top, view.top + this.#port.topInset())
    /*
     * 屏上那一块要往下挪 `drop` 像素 = `scrollTop` 往回收同样多。顶边在视口里时
     * `drop` 是 0,这一整段于是退化成 09-21 的行为。
     */
    const drop = landing - block.top
    const targetTop = drop > 0.5 ? this.#port.top - drop : undefined
    if (!change.open) {
      /*
       * ── 次序即正确性 ────────────────────────────────────────────────────
       * ① 先按**落点**把垫块垫到位(长高,从不钳);② 再写位置(`scrollTop` 只减
       * 不增,同样从不钳);③ 最后才轮到调用方让那一块真的缩 —— 那一下的排版在
       * 垫块与位置都到位之后,所以浏览器没有可钳的东西。
       * `block.height` 是上界,多垫的那一截由 `relax` 在下一批尺寸变化里收回去。
       */
      this.#pad.requestAbsorb(block.height, targetTop ?? this.#port.top)
    }
    if (targetTop !== undefined) this.#port.setTop(targetTop, 'user-toggle')
    /*
     * 接下来这一段每一帧把它按回 `landing`(过渡逐帧改高,一次性闩活不过第一帧)。
     * 展开那一侧用的是展开窗那个时长 —— 那一格的判词与 `EXPAND_HOLD_MS` 同源。
     */
    this.#intents.noteFold(
      now,
      change.open ? this.#expandHoldMs : change.durationMs + this.#foldSlackMs,
      /*
       * `rejudge` **只给这条路开的窗**(审查裁定 2)。重试那一路(`noteFold(ms)`,
       * `ChatStream` 的 `MessageRow`)不带它:那一路刚刚由 `landOnRetry` 滑到置顶线、
       * 座位正握着这一轮,窗口一过重判会把它翻成 browsing,新回答当场不跟底了。
       * 收起那一侧同样要 `rejudge`:顶边落到视口上缘之后人离底老远,不翻档的话
       * 下一批尺寸变化里 `stick()` 就把刚刚定好的落点抹掉了。
       */
      { anchor: block.anchor, top: landing, rejudge: true },
    )
  }

  /**
   * **宿主说这一份刚被拿回来**。它**一格几何都不读**,只立一格待办 —— 真正的对位
   * 由 `onResize` 顺手做掉(RO 的回调跑在排版之后,那里读几何不逼第二次排版;
   * 第一版在这一拍当场读,真机上是一次 400 行 / 115,207px 的强制排版)。
   */
  noteUnpark(): void {
    this.#pendingRestore = this.#port.lastTop
  }

  /**
   * 滚动事件。判据就一句:**停下来的位置在不在底**。
   *
   * ── 「在不在底」不够,还要问「是谁离的底」(2026-09-12,真机探针抓到)────────
   * 浏览器一帧里先跑滚动事件、后跑 ResizeObserver,于是 RO 贴的底要到下一帧的
   * 滚动事件才被读到,而那一帧内容又长了几像素 → 判成「人往上翻了」。真机读数:
   * `ro t=1175 gap=6 pinned → stick`、`scroll t=1183 st=10805.5 gap=4.5 → browsing`,
   * 此后每一条新消息都不再跟底(离底 38 → 263 → 431 → … 逐条累加)。
   *
   * 修法仍然**只用位置,不设标志位**:**人往上翻 = `scrollTop` 变小**。gap 张开
   * 而 `scrollTop` 一点没往回走,那是下面长出来的,不是人走开了 —— 同一帧稍后的
   * 那次 RO 会把它贴回去。
   */
  onScroll(sessionId: string, hasElement: boolean): void {
    if (hasElement) {
      const gap = this.#port.gapNow()
      // gap 会变的三条路之一(另两条是进场落定与 RO)—— 基准跟着走,
      // 否则「往上翻两屏」会被下一次 RO 读成一次「下面长出了东西」。
      this.#lastGap = gap
      /*
       * **人往上滚,垫块跟着缩**(G 线 P2-b,§15.1 那张表的第二行)。缩的永远是
       * 视口下方看不见的那一截:人往上滚多少,需要的就少多少,于是屏上零位移。
       * 只记账、排下一帧写 —— 这里是滚动回调,当场改布局会与惯性滚动打架。
       *
       * **折叠窗在场时一格不收**(审查裁定 1 落地那一趟真机抓出来的):落点那一句
       * `setTop` 自己会发一发滚动事件,而那一刻**那一块还没缩**(过渡要跑 180ms),
       * 于是 gap 正大着 —— 照这条式子算出来「一格都不用垫」,刚垫上的那一截当场
       * 被收掉,接着内容缩下去就钳。窗口里那几帧的 gap 说的不是「还需要多少」,
       * 是「这一段还没走完」。读数:think3k 落点 44px 被钳回 295px(差 251)。
       */
      if (!this.#intents.folding(this.#now())) this.#pad.relax(gap)
      const { previousTop, top } = this.#port.noteScrolled()
      /*
       * 第一次(这次挂载里还没量过)按老办法交给状态机 —— 没有「上一次」可比,
       * 保守的缺省是照旧判,而不是替它猜。
       */
      const wentUp = previousTop === undefined || top < previousTop
      if (wentUp || !followShouldStick(this.#follow)) this.dispatch({ type: 'scrolled', gap })
    }
    // 停稳之后记一笔「看到哪儿」——这里只重排计时器,量在停下来那一下。
    // **容器不在手时这一句照旧跑**(今天那句 `if (el) {…}` 之后就是它)。
    this.#recorder.schedule(sessionId)
  }

  /**
   * 浏览器报来的一批尺寸变化(RO 回调;停靠中那一批由 `ScrollPort.summarizeResize`
   * 挡在外面,到不了这里)。
   *
   * **下面这一整段的每一支与每一处早退的先后,与搬迁之前逐字相同。**
   */
  onResize(batch: ResizeBatch, sessionId: string): void {
    const port = this.#port
    /*
     * ── 刚被拿回来那一批 ──────────────────────────────────────────────────
     * 这一批尺寸变化说的是「这棵树重新有排版了」,不是「下面长出了东西」。
     * 真机上浏览器已经把位置留住了,所以这两句今天恒是一次恒等。
     */
    const wantTop = this.#pendingRestore
    if (wantTop !== undefined) {
      this.#pendingRestore = undefined
      const browsing = !followShouldStick(this.#follow)
      if (browsing && Math.abs(port.top - wantTop) > AT_BOTTOM_EPS) port.setTop(wantTop, 'restore')
      this.#lastGap = port.gapNow()
      // 跟底档照旧往下走(停靠期间长出来的那几段要跟);浏览档到此为止。
      if (browsing) return
    }
    /*
     * ── 座位:量在这儿,写在下一帧(正本 §3)────────────────────────────────
     * 排在最前面是因为**它与判不判跟底是同一帧的两句话**:回复长了一截 → 座位
     * 缩同样多 → `scrollHeight` 不变 → 视口本来就不必动。量在这里是白拿的
     * (RO 回调跑在排版之后);真正写 style 排在下一帧,那是观察器的纪律。
     *
     * 于是有**一帧的差**:内容先长了 Δ,座位下一帧才缩 Δ。那一帧里若照旧贴底,
     * 屏幕会先往下跳 Δ、下一帧又被缩回来的 `scrollHeight` 钳回去 —— 一次肉眼可见
     * 的抖。所以下面那句「座位还没长满就不贴底」不是保险,是这条链成立的前提。
     */
    const seat = this.#pad.measure()
    /*
     * ── 折叠分支:这一段**跟底让位给锚定**(单 B ④,正本 §2 规矩 ④)──────────
     *
     * 病历(§0 三处病之二):一轮跑完那一帧思考段自动折回一行,6 万像素缩成
     * 783px,上一条用户消息的 top 从 −60,879 跳到 −286 —— 整屏跳变。
     *
     * ── 补什么:**锚**,不是 Δ ────────────────────────────────────────────
     * 直觉写法是「内容缩了 Δ 就 `scrollTop -= Δ`」。那一句在**有座位**的时候是错的:
     * 座位会按几何把缩掉的那一截补回来,`scrollHeight` 一格不变,屏幕本来就没动 ——
     * 再补一次就是凭空滑一段。所以判据不是账面上的 Δ,是**那一行到底动没动**:
     * 这一段的第一帧选一个锚、记下它此刻在屏幕上的位置,之后每一帧读它现在在哪、
     * 把差值还回去。座位补没补过、浏览器钳没钳过,都得到同一个结果 —— 自校正。
     *
     * ── 为什么可以在观察器回调里写 `scrollTop` ────────────────────────────
     * 「观察器回调只读不写」那条法禁的是**改布局**(改了就会再触发一轮派发,那正是
     * `ResizeObserver loop` 的成因)。`scrollTop` 不改布局,而且 RO 的回调跑在
     * **排版之后、绘制之前** —— 补偿与画面因此同帧。
     *
     * ── 补不动了就让内容动 ────────────────────────────────────────────────
     * `scrollTop` 夹在 0:上面没有东西可让的时候,钉不住就是钉不住 —— 那时候老实让
     * 内容上来,比把视口锁在一个不存在的位置好。
     */
    const hold = this.#intents.folding(this.#now())
    if (hold) {
      if (!hold.anchor || !hold.anchor.alive()) {
        const picked = port.pickFoldAnchor()
        if (picked) {
          hold.anchor = picked
          hold.top = picked.top()
        }
      }
      if (hold.anchor && hold.top !== undefined) {
        const drift = hold.anchor.top() - hold.top
        if (Math.abs(drift) > 0.5) {
          /*
           * 锚往上跑了多少(`drift` 为负),`scrollTop` 就往回收多少 —— 把它按回
           * 记下来的那个位置。**夹在 0**:上面没有东西可让了就让内容动。
           * 写完同步 `lastTop` 那一句在 `setTop` 里做 —— 这一笔是我们自己写的,
           * 不同步的话紧接着那一发 scroll 事件会被当成「人往上翻」。
           */
          port.setTop(Math.max(0, port.top + drift), 'user-toggle')
        }
      }
      this.#lastColumnHeight = port.columnHeight()
      this.#lastGap = port.gapNow()
      return
    }
    /*
     * ── 窗口刚过期的那一次:**按此刻离底多远重判跟随档**(审查裁定 2)────────
     *
     * 窗口整段是早退的 —— 不判跟底、不判丸。过期那一次要是什么都不做,下面那句
     * `stick()` 就会按「这一轮还 pinned」把人拽到底:用户报的「第二次展开视口被
     * 拽走 166–435px」正是这条(动效档「无」下拽的是整块的高)。
     *
     * 这一句与「滚动停下来了」逐字相同,不另开一个事件(判词同 `enter` 里那一段)。
     */
    const expired = this.#intents.takeExpired()
    if (expired?.rejudge) this.dispatch({ type: 'scrolled', gap: port.gapNow() })
    let contentGrew = false
    let contentChanged = false
    const containerChanged = batch.containerChanged
    for (const height of batch.columnHeights) {
      if (height !== this.#lastColumnHeight) contentChanged = true
      if (height > this.#lastColumnHeight) contentGrew = true
      this.#lastColumnHeight = height
    }
    /*
     * ── 落位还没稳:这一批变化说的是「跳渲的行渲出真高了」──────────────────
     * 所以照 `applyAnchor` 再对一次,而不是问「要不要跟底」「要不要点亮丸」
     * —— 那两个问题此刻问的都是一张还没定下来的排版。有界,而且**位置不再动就
     * 当场收手**(判词在 `EntryRestore.consume`)。
     */
    const restoring = this.#restore.anchor
    if (restoring !== undefined) {
      const before = port.top
      const applied = port.applyAnchor(restoring)
      if (this.#restore.consume(applied, port.top - before, AT_BOTTOM_EPS)) {
        this.#recorder.saveNow(sessionId)
      }
      this.#lastGap = port.gapNow()
      return
    }
    // 贴底也要处理缩短:很小的高度回退就可能让浏览器钳回半个设备像素。
    // browsing 的「有新内容」仍只由下方 contentGrew 判定;折叠/恢复优先分支照旧。
    if (!contentChanged && !containerChanged) return
    /*
     * ── 长出来的那一截在视口下面吗(`content-visibility` 的第二个后果)────────
     * 消息行跳渲之后,**往上翻**这个动作本身就会让内容列的高度变来变去:一条没进过
     * 视口的消息第一次渲出来,高度从估高换成真高。照旧无条件派 `grew` 的话,人在
     * 一条**早就收了场**的会话里往上翻两屏,丸就会跳出来说「回到最新」—— 下面根本
     * 没有他没看过的东西。
     *
     * 判据因此收窄一格:**gap 变大了才算**。长在视口上面的内容会被浏览器的滚动锚定
     * 顶回去(`scrollTop` 跟着加,gap 不变),长在下面的才让 gap 变大。这一格只管
     * **丸**;贴底那一半一个字没动(pinned 时任何长高都跟)。
     */
    const gap = port.gapNow()
    /*
     * **内容又长出来,先吃垫块**(G 线 P2-b,§15.1 那张表的第三行)。长高让 gap
     * 变大 → 需要垫的变少 → 垫块缩掉同样多 → `scrollHeight` 一格不变,视口一像素
     * 不动。所以下面那条「座位没吃光就不贴底」的判据对吸收那一半照样成立
     * (`pad.written > 0`),而垫块吃光之后跟底自己接回去。
     */
    this.#pad.relax(gap)
    const grewBelow = gap - this.#lastGap > AT_BOTTOM_EPS
    /*
     * ── 人自己点开的东西还在长:位置一动不动(2026-09-12 报障二的「位」)──────
     * 展开一段折痕正文 / 一段思考 / 一张工具卡,在几何上与「模型又吐了一段」逐字
     * 相同(都让 gap 变大、`scrollTop` 不动),所以分不出来的那一半由动手的那一方
     * 自述。pinned 下不报的话,展开的那一瞬间屏幕当场滑到最底 —— 人点开是为了读它,
     * 结果它被推出了视野。
     *
     * **一动不动之后按此刻离底多远重新判档**:这一句与「滚动停下来了」逐字相同,
     * 不另开一个事件。
     *
     * **窗口内的长高也不算「下面长出了没看见的东西」**:第一拍把状态翻成 browsing
     * 之后,展开的过渡还要再长几帧 —— 那几帧要是走下面 browsing 那一支的 `grew`,
     * 丸会亮起来说「回到最新」,而下面长出来的正是他自己点开的那一段。
     */
    if (this.#intents.expanding(this.#now())) {
      if (followShouldStick(this.#follow)) this.dispatch({ type: 'scrolled', gap })
      this.#lastGap = gap
      return
    }
    if (followShouldStick(this.#follow)) {
      /*
       * ── 座位还没长满:视口一像素不动(正本 §2 规矩 ②)──────────────────
       * 内容长进的是**座位里**,不是页面下面 —— 座位缩掉同样多,`scrollHeight`
       * 一格不变,「贴底」这件事此刻恰好什么都不必做。
       *
       * ── 第二格判据:**已经写进 style 的那个高还没归零就不贴** ──────────────
       * 座位是「量在这一帧、写在下一帧」的(观察器只读不写)。所以**归零那一帧**
       * 有一个缝:量已经算出 0,而垫块上挂着的还是上一次写进去的残高,
       * `scrollHeight` 里仍含着那一截。此刻照旧贴底,视口会**多滚那一截**;下一帧
       * 垫块缩到 0、`scrollHeight` 变小,浏览器把 `scrollTop` 钳回来 —— 先下后上,
       * 一帧可见的抖,量级正是最后一次长高的 Δ。
       *
       * 所以两格都要归零才贴。**这不会把跟底卡死**:写到 0 那一帧垫块自己缩了高,
       * 那是一次尺寸变化,RO 会再来一次 —— 那一次两格都是 0,照旧贴底。座位不存在
       * 时 `pad.written` 是 `undefined`,`?? 0` 让它读作「没有残高」。
       */
      if (seat > 0 || (this.#pad.written ?? 0) > 0) {
        this.#lastGap = gap
        return
      }
      this.#stick()
      this.#lastGap = port.gapNow()
      return
    }
    this.#lastGap = gap
    if (contentGrew && grewBelow) this.dispatch({ type: 'grew' })
  }

  /* ── 发送 / 重试的落位 ───────────────────────────────────────────────── */

  /**
   * **滑到置顶线**(正本 §2 规矩 ①)——「刚发出去的那句话停在多高」:自己那条的
   * 上缘落在视口上缘下 `--send-line`,底下整个视口(= 座位)留给回复。
   */
  landOnSendLine(): void {
    // 这一轮先当作「没落过」——下面每一条早退都让座位留在 0 上(判词在 `TailPad.landed`)。
    this.#pad.landed = false
    /*
     * **下一次发送把吸收的那一半归零**(§2 拍点 3 的后半句:空白留到用户滚动或
     * 下一次发送再释放)。排在所有早退**之前** —— 人在上面翻着的时候发送同样算
     * 一次发送,那一格空白没有理由跨轮活着。
     */
    this.#pad.releaseAbsorbed()
    // 停靠中 / jsdom:没有排版,量出来的一切都是 0(与贴底同一把尺子)。
    if (!this.#port.hasLayout()) return
    /*
     * **人在上面翻着的时候发送:一像素不动**(规矩 ⑦「人往上翻就是浏览」)。
     * 座位也不留 —— 座位是「把视口让给这一轮」的意思,而此刻视口不归这一轮。
     */
    if (!followShouldStick(this.#follow)) return
    this.#pad.landed = true
    this.#slide.cancel()
    // 先把座位写到位(同步,绘制之前):没有它,下面那个目标就是一个滚不到的位置。
    this.#pad.measure()
    this.#pad.flushNow()
    const target = this.#port.sendLineTarget()
    if (target === undefined) return
    this.#slide.to(target)
  }

  /**
   * **重试:那一轮就是最后一轮,座位按同一条路重算**(正本 §2 规矩 ⑥)。
   *
   * 两档,判据是**气泡此刻在不在视口里**:
   *  · **在** —— 一像素不动。人正看着这条回答按下重试,屏幕不该自己跑;旧回答在他
   *    眼前上折,折叠锚定负责把他正读的那一行钉住。
   *  · **不在** —— 滑到置顶线。旧回答常有一两千像素高(长回那一档实测 1,400+),
   *    人是滚到底部按的钮,气泡远在视口上面;旧回答一折,`scrollHeight` 塌一大截、
   *    浏览器把 `scrollTop` 钳回来 —— 那是一次**没人管的**跳变(真机量到 1,419px)。
   *
   * 不问 pinned:重试钮长在那条消息上,按它的人就在看它。
   */
  landOnRetry(): void {
    if (!this.#port.hasLayout()) return
    const rect = this.#port.lastUserRect()
    if (!rect) return
    const view = this.#port.viewportRect()
    // 气泡整条都在视口里:什么都不做(规矩 ⑥ 的字面「不滑动」)。
    if (rect.top >= view.top && rect.bottom <= view.bottom) return
    this.#pad.landed = true
    this.#slide.cancel()
    this.#pad.measure()
    this.#pad.flushNow()
    const target = this.#port.sendLineTarget()
    if (target === undefined) return
    this.#slide.to(target)
  }

  /**
   * ── 收场那一拍:**座位同步补到位** ────────────────────────────────────────
   *
   * 座位平时是「量在这一帧、写在下一帧」的(观察器只读不写)。那条纪律对**尺寸自己
   * 在变**的那些帧是对的,可**收场**这一拍不是尺寸在变,是 React 提交了一次换脸:
   * 流式光标摘掉、外缘那一行从读数换成动作。那一拍内容会缩一截,页面正贴着底 →
   * 浏览器钳一下 `scrollTop` → 下一帧座位补回来 —— 一帧的抖(单 A 的门量到 12px)。
   *
   * **只同步「补回来」那一半**:座位变大 = 内容刚缩了一截,不当场补上就会被钳。
   * 变小那一半留给下一帧的观察器 —— 长出来的那一截已经把位置占住了,晚一帧让位没人
   * 看得见。
   *
   * **只管收场那一拍,不管开张那一拍**(2026-09-15 真机实测收窄的):开张那一拍内容
   * 是**长**的,而且在 50MB / 400 条那条会话上它恰好与空闲扩窗撞在同一次提交里,
   * 在那儿多读一次几何就是在那一帧里再逼一次全树排版(真机两趟对照:开张也写 →
   * 落位窗多出一段 −189px,①判红;只在收场写 → 落位窗恒 1 段)。
   */
  syncSeatOnSettle(): void {
    if (!this.#port.hasLayout()) return
    const before = this.#pad.written ?? 0
    const next = this.#pad.measure()
    if (next > before) this.#pad.flushNow()
  }

  /**
   * ── 座位**同帧**跟上内容(G 线 P1;正本 §1 的 G1 与 §5.3 的 ①⑤)────────────
   *
   * 病历:座位从前是「量在这一帧、写在下一帧」。于是每来一段 delta:
   *   第 n 帧   内容 +Δ、座位没动 → `scrollHeight` +Δ
   *   第 n+1 帧 座位 −Δ          → `scrollHeight` −Δ
   * G 线 P1 把读数与光标搬到**座位之后**的尾槽里,这一格差当场显形:首字那一帧
   * 尾槽被推下 29–92px,整轮 `scrollHeight` 回缩 3–12 次。
   *
   * 那一帧里只有两条路:要么不动视口(于是**座位下面**的东西跳一帧),要么贴底
   * (于是**座位上面**的东西跳一帧,自己那条气泡当场违反规矩 ②)。一帧之内两头
   * 不能兼得 —— 唯一的出路是**让那一格差根本不存在**。
   *
   * 三道闸(调用方先判前两道,这里判第三道与几何):①座位不在场 / 没落位;
   * ②座位已经吃光(写进 style 的是 0);③正在滑(发送 / 重试的插值)。
   */
  syncSeatSameFrame(): void {
    if (this.#slide.running) return
    if (!this.#port.hasLayout()) return
    this.#pad.measure()
    this.#pad.flushNow()
  }
}

/**
 * **被点的那一块,收成裁决层认得的样子**(零 DOM:纯数字 + 两个问句)。
 *
 * 三格各有各的读者:`height` 是收缩申请的上界,`top` 是这一段钉住的那个位置
 * (报的那一刻读的),`anchor` 是接下来每一帧再问一次「你现在在哪 / 你还在吗」。
 * 三格全从**同一次** `getBoundingClientRect()` 来 —— 一次点击只逼一次排版。
 */
export interface ReportedBlock {
  readonly height: number
  readonly top: number
  readonly anchor: AnchoredElement
}

/** 人亲手开合了一块东西(`ViewportAnchor.reportUserToggle` 的入参)。 */
export interface UserToggleReport {
  /** 这一下之后它是开着还是合着。 */
  readonly open: boolean
  /** 接下来那段过渡有多长(ms);0 = 当拍到位(折痕、动效档「无」)。 */
  readonly durationMs: number
  /** 被点的那一块。拿不到(样例页 / 单测 / 没有元素)就只当一句「人动了手」。 */
  readonly block?: ReportedBlock
}

export interface ViewportAnchorOptions {
  /** 跟随状态换人时推给 React(`setFollow`,身份恒定)。 */
  onFollowChange: (next: FollowState) => void
  /** 展开窗多长(`EXPAND_HOLD_MS`)。 */
  expandHoldMs: number
  /** 折叠窗在报出来的时长之外再多钉多久(`FOLD_HOLD_SLACK_MS`)。 */
  foldSlackMs: number
  /** 落位那一段滑多久(动效档「无」答 0)。 */
  slideDurationOf: (distancePx: number) => number
  /* ── 下面几格只为单测可替换,产品一格都不传 ────────────────────────── */
  now?: () => number
  frames?: ConstructorParameters<typeof Slide>[1]['frames']
  timers?: ConstructorParameters<typeof AnchorRecorder>[0]['timers']
  readAnchor?: (sessionId: string) => ScrollAnchor | undefined
  saveAnchor?: (sessionId: string, anchor: ScrollAnchor | undefined) => void
  settleMs?: number
}
