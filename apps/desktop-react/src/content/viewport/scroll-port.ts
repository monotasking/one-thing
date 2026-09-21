import { applyScrollAnchor, measureScrollAnchor, type ScrollAnchor } from '../../data/session-view-state'
import type { SeatGeometry } from '../seat'
import type { GeometryCause, GeometryZone } from './types'

/**
 * **量与写的适配层**(G 线 P2-a,正本 `docs/stream-geometry-2026-09.md` §13.2.1/§13.2.3)。
 *
 * 这是整个锚定器设计里**唯一碰 DOM 的地方**。裁决那一层(`ViewportAnchor` 与它的
 * 协作者)只认下面这个接口,于是 vitest 里喂一只 `FakeScrollPort`(纯数字)就能
 * 把裁决逐格测到,不必靠 jsdom 几何 —— 今天 `fold-anchor` / `expand-hold` 那几组
 * 是靠篡改 `clientHeight` 的 property descriptor 撑起来的。
 *
 * ── 两条纪律,都是从今天的判词里原样搬的 ──────────────────────────────────
 * ① **停靠中(`clientHeight === 0`)一切读写都是恒等**。判据用几何而不是「宿主说
 *    我看不见」:它对任何一种藏法都成立(`content-visibility: hidden` 的子树里没有
 *    盒子,`scrollHeight` 与 `clientHeight` 一律报 0,赋一次 `scrollTop = 0` 就是把
 *    这条会话的位置抹掉,而人只是切去看了别的会话)。与 `tools/card-heights` 那句
 *    `height <= 0` / clamp-measurer 同一把尺子。
 * ② **写完位置当场记下 `lastTop`**,不等下一帧那个滚动事件(2026-09-12 判例):
 *    `onScroll` 拿它判「是谁离的底」(人往上翻 = `scrollTop` 变小),而滚动事件比
 *    RO 晚一帧 —— 不在写点当场记的话,下一帧人往上翻的那一下会拿**写之前**的位置
 *    当参照,内容一帧长得比他翻得多,这一下就被读成「没往回走」而吞掉。
 *    记的是**读回来的那个数**不是我们要写的那个数:浏览器会钳。
 *
 * ── P2-a 的一处行为收口(唯一的一处)──────────────────────────────────────
 * 今天 `clientHeight === 0` 这句守卫散在四处(`stick` / RO 回调第一行 / 锚点去抖 /
 * `landOnSendLine`),而另外三处写点没有它:扩窗补位那一手自己带了一句、插值那
 * 几帧没带、进场落锚点那一手没带。收进 `setTop` 之后**那三处一起有了**。前两处
 * 今天本来就到不了(RO 早退 / 调用方先判),第三处(进场时这一份正被停靠)今天会
 * 写进一个按 0 几何算出来的位置 —— 收口之后不写。这一格逐条记在正本 §14 留账里。
 */
export interface ScrollPort {
  /** 此刻的 `scrollTop`,不带守卫(今天插值那一支就是这么读的)。没有元素答 0。 */
  readonly top: number
  /** 「人上一次停在第几像素」——`setTop` 与滚动回调自己维护,外面只读。 */
  readonly lastTop: number | undefined
  /** 一次读完,不逼排版(RO 回调里调是白拿的)。停靠中答 `undefined`。 */
  measure(): ViewportMetrics | undefined
  /**
   * **贴到底** —— 与今天那只 `stick()` **逐字同量**:一次 `clientHeight`(守卫)、
   * 一次 `scrollHeight`(目标)、写完读回一次。
   *
   * 它不是第二个写口:内部与 `setTop` 走同一句 `el.scrollTop = …`。单开一格是为了
   * **不多读一次几何** —— 「贴底」本来就不需要先 `measure()` 出一整张读数,而
   * 流式期间它每一帧都跑(正本 §13.1.5 己 那条留账说的就是这一族的账)。
   */
  stickToBottom(cause: GeometryCause): void
  /** 「下面还有多少没露脸」。**不带守卫** —— 与 `follow.ts` 的 `scrolled` 同一个式子。 */
  gapNow(): number
  /** 内容列此刻多高(`getBoundingClientRect().height`)。 */
  columnHeight(): number
  /** 这一件此刻落在视口的哪一档。**P2-a 没有调用方**,它是 §13.2.2 裁决表的入参。 */
  zoneOf(rect: { top: number; bottom: number }): GeometryZone
  /** **唯一**写滚动位的口。`cause` 只用于埋点与将来的 dev 断言,不改行为。 */
  setTop(top: number, cause: GeometryCause): void
  /** 滚动事件那一头记一笔「人此刻在第几像素」,并交出**上一次**那个数。 */
  noteScrolled(): { previousTop: number | undefined; top: number }
  /** RO 那一批变化归一成纯数字。**停靠中答 `undefined` 且一个矩形都不读。** */
  summarizeResize(entries: readonly ResizeObserverEntry[]): ResizeBatch | undefined
  /** 量这一刻的座位几何(只读,一次读完)。拿不到答 `undefined`。 */
  measureSeat(): SeatGeometry | undefined
  /** 自己那条气泡该停在哪 —— 滑到置顶线那一下的目标 `scrollTop`。 */
  sendLineTarget(): number | undefined
  /** 这一轮自己那条气泡此刻的矩形与视口矩形(重试那一档要比它们)。 */
  lastUserRect(): { top: number; bottom: number } | undefined
  viewportRect(): { top: number; bottom: number }
  /** 折叠那一段钉住谁 ——「这条回复里视口内第一块在读的东西」。 */
  pickFoldAnchor(): AnchoredElement | undefined
  /** 卷尾垫块那一格的 style 写口。没有那个元素答 false(今天 `writeSeat` 的第一句)。 */
  writePadHeight(px: number): boolean
  /** 「此刻量得出来吗」——`clientHeight > 0`,锚点去抖那一发用它。 */
  hasLayout(): boolean
  /** 「看到哪儿」——`measureScrollAnchor`,**不带停靠守卫**(它自己只看 isConnected)。 */
  measureAnchor(): ScrollAnchor | undefined
  /** 把锚点用回去。写经 `setTop`;答 true / false 的语义与 `applyScrollAnchor` 逐字相同。 */
  applyAnchor(anchor: ScrollAnchor): boolean
}

export interface ViewportMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  /** `gap = scrollHeight − clientHeight − scrollTop`,与 `follow.ts` 同一个式子。 */
  readonly gap: number
}

/**
 * 被钉住的那一件 —— **不是一个 `HTMLElement`**。
 *
 * 裁决层要问它的只有两句:「你还在文档上吗」「你此刻的上缘在哪」。把它收成两个
 * 方法,`ViewportAnchor` 就一个 DOM 类型都不必认识,`FakeScrollPort` 也能造一只。
 */
export interface AnchoredElement {
  /** 还挂在文档上吗(今天 `hold.anchor.isConnected`)。 */
  alive(): boolean
  /** 此刻的上缘(视口坐标)。 */
  top(): number
}

/** RO 那一批变化归一之后的样子 —— 纯数字,裁决层照它判「长了没有 / 变了没有」。 */
export interface ResizeBatch {
  /** 这一批里有没有**滚动容器自己**变了(它不派 `grew`:什么都没长出来)。 */
  readonly containerChanged: boolean
  /** 这一批里**内容列**报来的高,按到达顺序;已经解好(`contentRect.height` 为 0 时现量)。 */
  readonly columnHeights: readonly number[]
}

/* ══ 取件口:这几个名字与常量从 `ChatStream.tsx` 原样搬过来 ══════════════════ */

/**
 * 座位那一格的**属性名**(正本 `docs/send-flow-2026-09.md` §3)。
 *
 * 它**不带 `data-message-id`** —— 那个属性是 TOC / `locate-message` 找消息的唯一
 * 接缝,给一块空白挂上去,钢琴键就会落到一块空白上(与上下文更新那一行同一条判例)。
 * 量几何的那几处按这个名字把它剔出去:座位不是「这一轮长了多高」的一部分。
 */
const SEAT_ATTR = 'data-seat'

/**
 * **列尾那格空位**的属性名(G 线 P1h,正本 `docs/stream-geometry-2026-09.md` §12)。
 *
 * 与 `SEAT_ATTR` 同一条判词:它**不带 `data-message-id`**(TOC / `locate-message`
 * 的取件口只认消息),量几何的那几处按这个名字把它剔出去 —— 它是整列末尾常驻的
 * 一格,不是「这一轮长了多高」的一部分,也不是「人正在读的那一块」。
 *
 * **P1h 改了名**:从前是 `data-tail-slot`,那时这一格既占高又画东西。今天画的那一份
 * 搬去了滚动口上那一层,`data-tail-slot` 跟着它走了 —— 门量「人看见的那一行」问的是
 * 那一层,量「列里让了多少地」问的是这一格,两个名字从此各指一件事。
 */
const TAIL_ATTR = 'data-tail-spacer'

/**
 * 量座位时**从列尾往回数几格**。
 *
 * 它是一个**格数**不是一段长度,所以既不进 tokens 也不进 `components/motion.ts`
 * (与 `ANCHOR_RESETTLE_ROUNDS` / `CHAT_NEAR_TOP_SCREENS` 同一族)。
 * 这一轮在列尾最多占五格:自己那条气泡、上下文更新那一行、偶尔一张压缩折痕、
 * 助手那一行,再加列尾那块座位垫块与它后面那一格尾槽(G 线 P1 多出来的那一格,
 * 这个数因此从 6 升到 7)—— 留一格富余。数不到就是「这一刻没有座位可算」,
 * 答 `undefined`,不退回去扫全表(扫全表就是每帧按整份账本计价)。
 */
const SEAT_SCAN = 7

/**
 * **折叠那一段钉住谁**(单 B ④)——「这条回复里视口内第一块在读的东西」。
 *
 * ── 为什么要**往里钻**(2026-09-15 真机改判)──────────────────────────────
 * 第一版只在**列的那一层**找:从列头往下第一件下缘还在视口里的东西。那一句在
 * 收尾这一刻恒等于**那条助手行自己** —— 一轮长回答从视口上面几千像素处起头,
 * 行的上缘远在屏外,而**一块内容缩了,它所在的那一行的上缘一动不动**(缩的是行
 * 里面的东西,下面的内容往上顶)。于是「锚漂了多少」恒为 0、补偿一次都没发生,
 * ④ 那条断言**恒绿**:把补偿整句拆掉重跑,门照样全绿(09-15 反证实测)。
 * 长回那一支补上思考段之后真相当场显形:锚点位移 **1517px**。
 *
 * 所以这里要的是**块**不是行:一层层往里钻,直到某一件**整个**落在视口上缘之下
 * —— 那才是「他正在读的那一行」所在的那一块。钻到头(段、正文块、工具卡)自然停,
 * 深度封顶是防御:再深的嵌套对补偿没有更多贡献,而每一层都要读矩形。
 *
 * 真正在折的那一块如果整个在视口**下面**,它上面必然先有一件满足条件的,而那一件
 * 在折叠中一动不动,于是补偿自然是零。重试那一路上它自然就是自己那条气泡上面 /
 * 下面还看得见的那一块,所以重试不必另开一条锚的规则。
 *
 * **只读,不写**;由 RO 的回调调用(排版之后,`getBoundingClientRect` 是白拿的)。
 */
const FOLD_ANCHOR_DEPTH = 4

/**
 * **一层里第一件下缘还在视口内的东西** —— 二分,不是逐个扫。
 *
 * 同一层的子项在文档序上自上而下排,`bottom` 因此**单调递增**,二分成立
 * (绝对定位 / 浮动会破坏这个前提,这棵树里没有:消息行与段都是块级流)。
 * 逐个扫在 400 条的账本上是每帧几百次 `getBoundingClientRect`,而这只函数跑在
 * **折叠的每一帧**里 —— 二分把它压成 ~9 次。
 *
 * 座位垫块与尾槽都答 `undefined`:它们是让出去的地 / 常驻的槽位,不是「在读的东西」;
 * 扫到它们就说明这一层里视口上缘之下已经没有内容了。
 */
function firstVisibleChild(node: Element, top: number): HTMLElement | undefined {
  const kids = node.children
  let lo = 0
  let hi = kids.length - 1
  let found: HTMLElement | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const el = kids[mid]
    if (!(el instanceof HTMLElement)) return undefined
    if (el.getBoundingClientRect().bottom > top + 1) {
      found = el
      hi = mid - 1
    } else lo = mid + 1
  }
  if (!found || found.hasAttribute(SEAT_ATTR) || found.hasAttribute(TAIL_ATTR)) return undefined
  return found
}

/** 从列尾往回数,找这一轮自己那条气泡(判词在 `SEAT_SCAN`)。 */
function lastUserRow(column: HTMLElement): HTMLElement | undefined {
  const kids = column.children
  for (let i = kids.length - 1; i >= 0 && i >= kids.length - SEAT_SCAN; i -= 1) {
    const node = kids[i]
    if (node.getAttribute('data-role') === 'user' && node instanceof HTMLElement) return node
  }
  return undefined
}

/* ══ 真的那一只 ═════════════════════════════════════════════════════════════ */

/**
 * `ScrollPort` 的 DOM 实现。两格 ref 由 React 那一侧给:滚动容器与卷尾垫块。
 *
 * 它**不持有元素**,每次现读 ref —— 换宿主(浮窗 / 分屏 / 架子)时滚动容器那个
 * DOM 节点不变(`content/session-park.ts` 的整个立论),但垫块会随 `seatActive`
 * 生生灭灭,持有就会拿着一个已经摘掉的节点。
 */
export class DomScrollPort implements ScrollPort {
  readonly #scroll: () => HTMLElement | null
  readonly #pad: () => HTMLElement | null
  #lastTop: number | undefined = undefined

  constructor(scroll: () => HTMLElement | null, pad: () => HTMLElement | null) {
    this.#scroll = scroll
    this.#pad = pad
  }

  /** 内容那一层 —— 容器自己的高是外壳给的,不随内容变。 */
  #column(): HTMLElement | undefined {
    const el = this.#scroll()
    const column = el?.firstElementChild
    return column instanceof HTMLElement ? column : undefined
  }

  get top(): number {
    return this.#scroll()?.scrollTop ?? 0
  }

  get lastTop(): number | undefined {
    return this.#lastTop
  }

  measure(): ViewportMetrics | undefined {
    const el = this.#scroll()
    if (!el) return undefined
    const clientHeight = el.clientHeight
    if (clientHeight === 0) return undefined
    const scrollHeight = el.scrollHeight
    const scrollTop = el.scrollTop
    return { scrollTop, scrollHeight, clientHeight, gap: scrollHeight - clientHeight - scrollTop }
  }

  gapNow(): number {
    const el = this.#scroll()
    if (!el) return 0
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  columnHeight(): number {
    return this.#column()?.getBoundingClientRect().height ?? 0
  }

  zoneOf(rect: { top: number; bottom: number }): GeometryZone {
    const view = this.viewportRect()
    if (rect.bottom <= view.top) return 'above'
    if (rect.top >= view.bottom) return 'below'
    return 'inside'
  }

  setTop(top: number, _cause: GeometryCause): void {
    const el = this.#scroll()
    if (!el) return
    // ① 停靠中不写(判词在文件头)。
    if (el.clientHeight === 0) return
    this.#write(el, top)
  }

  stickToBottom(_cause: GeometryCause): void {
    const el = this.#scroll()
    if (!el) return
    if (el.clientHeight === 0) return
    this.#write(el, el.scrollHeight)
  }

  /** **全仓唯一**那一句 `el.scrollTop = …`。 */
  #write(el: HTMLElement, top: number): void {
    el.scrollTop = top
    // ② 写完当场记下读回来的那个数 —— 浏览器会钳,`top` 不一定是落点。
    this.#lastTop = el.scrollTop
  }

  noteScrolled(): { previousTop: number | undefined; top: number } {
    const el = this.#scroll()
    const top = el?.scrollTop ?? 0
    const previousTop = this.#lastTop
    this.#lastTop = top
    return { previousTop, top }
  }

  summarizeResize(entries: readonly ResizeObserverEntry[]): ResizeBatch | undefined {
    const el = this.#scroll()
    if (!el) return undefined
    /*
     * ── 停靠中这一批不是读数(2026-09-10 组件级停靠)────────────────────────
     * 一格会话被切走时它那一层挂上 `content-visibility: hidden`,子树里的盒子
     * 当场消失 —— 观察者因此会收到一批「高度 0」的变化。那不是「内容变矮了」,
     * 是**这棵树此刻没有排版**。一句判据管住整批,而且**排在读任何矩形之前**:
     * 今天 RO 回调的第一行就是它。
     * RO 回调跑在排版之后,读 `clientHeight` 不会逼出第二次排版。
     */
    if (el.clientHeight === 0) return undefined
    const column = this.#column()
    const columnHeights: number[] = []
    let containerChanged = false
    for (const entry of entries) {
      if (entry.target === el) {
        containerChanged = true
        continue
      }
      columnHeights.push(entry.contentRect.height || (column?.getBoundingClientRect().height ?? 0))
    }
    return { containerChanged, columnHeights }
  }

  /**
   * **量这一刻的座位几何** —— 只读,一次读完(算在 `content/seat.ts` 里)。
   *
   * 一次 `getComputedStyle` 取四格:置顶线、输入框那格内衬、字号与行高。
   * 自定义属性是**继承**的,所以从滚动容器上就取得到阅读轴那两格(三档各不相同)。
   *
   * **留账**(正本 §13.1.5 己):这一句每一次尺寸变化都要跑一遍(流式期间约每秒
   * 60 次),而它读的四格在一轮里全是常量。P2-a 的自述是「抽件不改行为」,
   * 所以**原样搬,不顺手优化**。
   */
  measureSeat(): SeatGeometry | undefined {
    const el = this.#scroll()
    const column = this.#column()
    if (!el || !column) return undefined
    /*
     * ── 从**列尾往回数**,不是 `querySelectorAll`(2026-09-15)────────────────
     * `column.querySelectorAll('[data-role="user"]')` 是一次**整棵子树**的前序遍历
     * ——400 条消息的会话上,那就是把 09-01 那笔「每帧按整份账本计价」的账又记一遍。
     * 这一轮就住在列尾:自己那条气泡与它后面那几行(上下文更新行 / 压缩折痕 /
     * 助手那一行),往回数几格就够。`SEAT_SCAN` 给的是上限 —— 数不到就答
     * `undefined`(没有座位),而不是退回去扫全表。
     */
    const kids = column.children
    let user: HTMLElement | undefined
    /** 这一轮最后一件内容 —— 座位垫块与尾槽都不算(前者正是要算的那个数,后者是常驻的地)。 */
    let last: Element | undefined
    /** 座位垫块此刻**真的有多高**(不是算出来的那个数)—— 下面那一句要用它抵掉自己。 */
    let seat: Element | undefined
    /** 列尾那一格尾槽(G 线 P1)。 */
    let tail: Element | undefined
    for (let i = kids.length - 1; i >= 0 && i >= kids.length - SEAT_SCAN; i -= 1) {
      const node = kids[i]
      if (node.hasAttribute(TAIL_ATTR)) {
        tail = node
        continue
      }
      if (node.hasAttribute(SEAT_ATTR)) {
        seat = node
        continue
      }
      if (!last) last = node
      if (node.getAttribute('data-role') === 'user' && node instanceof HTMLElement) {
        user = node
        break
      }
    }
    if (!user || !last) return undefined
    const style = getComputedStyle(el)
    const px = (value: string) => Number.parseFloat(value)
    const userRect = user.getBoundingClientRect()
    const lastBottom = last.getBoundingClientRect().bottom
    /*
     * ── 尾槽也是「底下已经被别人占掉的那一截」(G 线 P1)────────────────────────
     * 座位那条式子(`content/seat.ts`)是一句加法:
     *   `tailHeight + seat + reserveBelow = viewportHeight − sendLine`
     * 尾槽排在座位**之后**,所以它连同它与座位之间那一格间距一起,都是 `reserveBelow`
     * 的一部分 —— 那一格的自述正是「底下已经被别人占掉的那一截」,不必给 `seatHeight`
     * 多开一个入参(多一个入参就是多一处要与 CSS 对账的地方)。
     *
     * **量法是自校正的**:`尾槽下缘 − 最后一件内容的下缘 − 座位此刻的真高` 抵掉了
     * 座位自己(我们正要算的那个数),剩下的恰好是「座位下面那一截常量」——
     * 间距改了、槽高改了,这一句都不用跟着改。夹在 0:量不到(停靠中 / jsdom,
     * 几何全是 0)时答 0,行为退回 G 线 P1 之前。
     */
    const belowSeat = tail
      ? Math.max(
          0,
          tail.getBoundingClientRect().bottom
            - lastBottom
            - (seat ? seat.getBoundingClientRect().height : 0),
        )
      : 0
    return {
      viewportHeight: el.clientHeight,
      sendLine: px(style.getPropertyValue('--send-line')),
      reserveBelow: px(style.paddingBlockEnd) + belowSeat,
      lineHeight: px(style.getPropertyValue('--pr-fs')) * px(style.getPropertyValue('--pr-lh')),
      userHeight: userRect.height,
      tailHeight: lastBottom - userRect.top,
    }
  }

  /**
   * 自己那条气泡该停在哪 —— **滑到置顶线**那一下的目标 `scrollTop`(规矩 ①)。
   *
   * 换算成内容坐标再减去置顶线,最后夹进 `[0, 最大可滚]`。
   *
   * **这个夹子从 09-21 起是常态,不是兜底**(裁定 A,判词在 `seat.ts` 的 `SEAT_LINES`):
   * 座位起手只留六行,总高多半不够把气泡送到置顶线,于是落点就是「贴底」——
   * 气泡下面是六行空白加尾槽。这不影响「发送只滚一次」:目标**在这里**就已经夹好,
   * `Slide` 的每一帧都是朝它插值,单调、无反向。
   */
  sendLineTarget(): number | undefined {
    const el = this.#scroll()
    const column = this.#column()
    if (!el || !column) return undefined
    const user = lastUserRow(column)
    if (!user) return undefined
    const sendLine = Number.parseFloat(getComputedStyle(el).getPropertyValue('--send-line')) || 0
    const top = user.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    return Math.max(0, Math.min(top - sendLine, el.scrollHeight - el.clientHeight))
  }

  lastUserRect(): { top: number; bottom: number } | undefined {
    const column = this.#column()
    if (!column) return undefined
    const user = lastUserRow(column)
    if (!user) return undefined
    const rect = user.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  }

  viewportRect(): { top: number; bottom: number } {
    const el = this.#scroll()
    if (!el) return { top: 0, bottom: 0 }
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  }

  pickFoldAnchor(): AnchoredElement | undefined {
    const el = this.#scroll()
    const column = this.#column()
    if (!el || !column) return undefined
    const top = el.getBoundingClientRect().top
    let anchor: HTMLElement | undefined
    let cursor: Element = column
    for (let depth = 0; depth < FOLD_ANCHOR_DEPTH; depth += 1) {
      const next = firstVisibleChild(cursor, top)
      if (!next) break
      anchor = next
      // 整块都在视口上缘之下 = 它就是「第一块在读的东西」,不必再往里钻。
      if (next.getBoundingClientRect().top >= top - 1) break
      cursor = next
    }
    if (!anchor) return undefined
    const node = anchor
    return { alive: () => node.isConnected, top: () => node.getBoundingClientRect().top }
  }

  writePadHeight(px: number): boolean {
    const pad = this.#pad()
    if (!pad) return false
    pad.style.height = `${px}px`
    return true
  }

  hasLayout(): boolean {
    const el = this.#scroll()
    return !!el && el.clientHeight > 0
  }

  measureAnchor(): ScrollAnchor | undefined {
    const el = this.#scroll()
    return el ? measureScrollAnchor(el) : undefined
  }

  applyAnchor(anchor: ScrollAnchor): boolean {
    const el = this.#scroll()
    if (!el) return false
    return applyScrollAnchor(el, anchor, (top) => this.setTop(top, 'restore'))
  }
}

/* ══ 测试用的那一只 ═════════════════════════════════════════════════════════ */

/** `FakeScrollPort` 的出厂几何 —— 一屏 300、内容 1000、停在顶上。 */
export interface FakeGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  columnHeight: number
}

/**
 * **纯数字的 `ScrollPort`**(vitest 用)。
 *
 * 它把「浏览器会钳」也演出来(`setTop` 夹进 `[0, scrollHeight − clientHeight]`),
 * 因为 `lastTop` 记的就是**读回来的那个数** —— 不夹的话裁决层在测试里看到的
 * `lastTop` 与真机上不是同一件事。
 */
export class FakeScrollPort implements ScrollPort {
  geometry: FakeGeometry
  /** 每一次 `setTop` 都记一笔,给「写入序列」那一族断言用。 */
  readonly writes: { top: number; cause: GeometryCause }[] = []
  /** 垫块上写过的高;`undefined` = 没有垫块这个元素。 */
  padHeights: number[] | undefined = []
  seat: SeatGeometry | undefined = undefined
  target: number | undefined = undefined
  foldAnchor: AnchoredElement | undefined = undefined
  anchor: ScrollAnchor | undefined = undefined
  /** `applyAnchor` 落到哪、答什么 —— 两格都由用例说了算。 */
  applyTo: number | undefined = undefined
  applyAnswer = true
  userRect: { top: number; bottom: number } | undefined = undefined
  #lastTop: number | undefined = undefined

  constructor(geometry?: Partial<FakeGeometry>) {
    this.geometry = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300, columnHeight: 1000, ...geometry }
  }

  get top(): number {
    return this.geometry.scrollTop
  }

  get lastTop(): number | undefined {
    return this.#lastTop
  }

  measure(): ViewportMetrics | undefined {
    const g = this.geometry
    if (g.clientHeight === 0) return undefined
    return {
      scrollTop: g.scrollTop,
      scrollHeight: g.scrollHeight,
      clientHeight: g.clientHeight,
      gap: g.scrollHeight - g.clientHeight - g.scrollTop,
    }
  }

  gapNow(): number {
    const g = this.geometry
    return g.scrollHeight - g.clientHeight - g.scrollTop
  }

  columnHeight(): number {
    return this.geometry.columnHeight
  }

  zoneOf(rect: { top: number; bottom: number }): GeometryZone {
    const view = this.viewportRect()
    if (rect.bottom <= view.top) return 'above'
    if (rect.top >= view.bottom) return 'below'
    return 'inside'
  }

  setTop(top: number, cause: GeometryCause): void {
    if (this.geometry.clientHeight === 0) return
    this.geometry.scrollTop = Math.max(0, Math.min(top, this.geometry.scrollHeight - this.geometry.clientHeight))
    this.writes.push({ top: this.geometry.scrollTop, cause })
    this.#lastTop = this.geometry.scrollTop
  }

  stickToBottom(cause: GeometryCause): void {
    this.setTop(this.geometry.scrollHeight, cause)
  }

  /** 用例自己「滚」一下 —— 与人滚同形:改位置,但不记 `lastTop`(那是滚动回调的事)。 */
  scrollTo(top: number): void {
    this.geometry.scrollTop = top
  }

  noteScrolled(): { previousTop: number | undefined; top: number } {
    const previousTop = this.#lastTop
    this.#lastTop = this.geometry.scrollTop
    return { previousTop, top: this.geometry.scrollTop }
  }

  summarizeResize(entries: readonly { target?: unknown; contentRect: { height: number } }[]): ResizeBatch | undefined {
    if (this.geometry.clientHeight === 0) return undefined
    const columnHeights: number[] = []
    let containerChanged = false
    for (const entry of entries) {
      if (entry.target === 'container') containerChanged = true
      else columnHeights.push(entry.contentRect.height || this.geometry.columnHeight)
    }
    return { containerChanged, columnHeights }
  }

  measureSeat(): SeatGeometry | undefined {
    return this.seat
  }

  sendLineTarget(): number | undefined {
    return this.target
  }

  lastUserRect(): { top: number; bottom: number } | undefined {
    return this.userRect
  }

  viewportRect(): { top: number; bottom: number } {
    return { top: 0, bottom: this.geometry.clientHeight }
  }

  pickFoldAnchor(): AnchoredElement | undefined {
    return this.foldAnchor
  }

  writePadHeight(px: number): boolean {
    if (!this.padHeights) return false
    this.padHeights.push(px)
    return true
  }

  hasLayout(): boolean {
    return this.geometry.clientHeight > 0
  }

  measureAnchor(): ScrollAnchor | undefined {
    return this.anchor
  }

  applyAnchor(_anchor: ScrollAnchor): boolean {
    if (this.applyTo !== undefined) this.setTop(this.applyTo, 'restore')
    return this.applyAnswer
  }
}
