import { FrameCoalescer } from '../../ui/frame-coalescer'
import { seatHeight } from '../seat'
import type { ScrollPort } from './scroll-port'

/**
 * **卷尾垫块**(G 线 P2-a 抽件;正本 `docs/stream-geometry-2026-09.md` §13.2.4、
 * `docs/send-flow-2026-09.md` §3)。
 *
 * 今天它就是「座位」那一件:发送那一帧自己的话滚到置顶线,**下面整个视口留给
 * 回复**,那块空白由列尾一块垫块占着 —— 回复长一截它缩一截,`scrollHeight` 不变,
 * 于是「跟底」在座位长满之前什么都不用做,视口一像素不动。
 *
 * 四格状态,写点各只有一处(今天 `ChatStream.tsx` 的四格 ref):
 *  · `#wanted`(`seatHeightRef`)—— 此刻算出来该多高。**算在观察器回调里(只读)、
 *    写在下一帧**(`ui/frame-coalescer.ts`:观察器回调只读不写);
 *  · `#written`(`seatWrittenRef`)—— 已经写进 style 的那个数,省掉每帧一次同值写;
 *  · `#landed`(`seatLandedRef`)—— **这一轮真的落到置顶线上了吗**。座位与那一下
 *    滑动是一件事:座位的定义是「自己那条停在置顶线上之后,底下留给回复的那块地」。
 *    没滑过就没有那块地 —— 人在上面翻着的时候发送(规矩 ⑦:那时视口不归这一轮)、
 *    或者那一拍量不到几何(停靠中 / jsdom),座位一律是 0;
 *  · `#active`(React 那一侧的 `seatActive`)—— 这条会话此刻有没有座位
 *    (= 这次进场之后自己发过话)。垫块本身照旧挂着:它是一个高度为 0 的空 div,
 *    而**留着它**意味着下一次发送由同一个节点原位接管,上面那些旧内容一像素不动。
 *
 * ── `#absorbed`:**此刻还需要垫多高**(G 线 P2-b 接线,§13.6 第 1 条)────────
 * 垫块的高是 `max(座位所需, 已吸收的回缩)`,后一半治的是「贴底时手动收起一块东西,
 * 屏上其余内容往下掉一截」:页面总高一缩,浏览器当场钳 `scrollTop`(§0 ①,849–15054px)。
 *
 * **它不是一个累加器,是一个算出来的量**(§13.6 第 1 条推翻了 §13.2.4 的全额累加):
 *   `needed = 视口下缘 − 内容下缘 = 已写的高 − gap`
 * (`gap = scrollHeight − clientHeight − scrollTop`,而 `scrollHeight` 里含着垫块
 * 自己,两式一减就把垫块抵掉了)—— 即「为了让**当前** `scrollTop` 仍然合法,列尾
 * 最少还要垫多高」。申请那一刻内容还没缩,所以把要缩的那个数加进去做投影:
 *   `required = max(0, 已写的高 − gap + shrinkPx)`
 * 之后**只减不增**(`relax`):人往上滚 / 内容又长出来,需要的都变少,跟着缩 ——
 * 缩的永远是视口下方那一截,所以不会钳位。下一次发送归零。
 *
 * **夹进 `clientHeight`,不再有「全有或全无」那条特判**(审查裁定 1,2026-09-22)。
 * 那条特判(`required > clientHeight` 就一格不垫)是 09-21 的权宜:当时「顶边不动」
 * 被理解成「连一条已经跑到屏外的顶边也要钉住」,于是收起一块比视口还高的东西就要
 * 垫十几屏。裁定把落点改成
 *   **收起之后被点那一块的顶边 y = max(它收起前的顶边 y, 视口上缘 + 上内衬)**
 * ——顶边在屏外时它落在视口上缘,而那时「视口下缘 − 内容下缘」**必然 ≤ 一屏**,
 * 夹法自己就成立了。`requestAbsorb` 因此多收一格「收缩之后 `scrollTop` 要落在哪」,
 * 算的是**那个落点**的 `needed`,不是当下位置的。
 *
 * ── 写口仍然只有一个(§13.1.5 乙)────────────────────────────────────────
 * 两个量各只改自己那一格然后排一帧,**`flushNow()` 是唯一算高、唯一写 style 的地方**。
 * 所以「两个产地算出两个数」那条隐患不成立:数只有一个,在写口那一句现算,
 * 那格同值短路照旧成立。
 *
 * **零 DOM**:量与写都经 `ScrollPort`,所以 vitest 里喂一只 `FakeScrollPort`
 * 就能把三道闸与那格同值短路逐格测到。
 */
export class TailPad {
  readonly #port: ScrollPort
  readonly #coalescer: FrameCoalescer

  #wanted = 0
  #written: number | undefined = undefined
  #landed = false
  #active = false
  /** 此刻还需要为「已吸收的回缩」垫多高(判词在文件头)。只减不增,发送归零。 */
  #absorbed = 0

  constructor(port: ScrollPort) {
    this.#port = port
    this.#coalescer = new FrameCoalescer(() => this.flushNow())
  }

  /** 这条会话此刻有没有座位(React 那一侧的 `seatActive`,渲染期事实)。 */
  set active(next: boolean) {
    this.#active = next
  }

  get active(): boolean {
    return this.#active
  }

  /** 这一轮落到置顶线上了吗。落位那一路写它,`measure()` 读它。 */
  get landed(): boolean {
    return this.#landed
  }

  set landed(next: boolean) {
    this.#landed = next
  }

  /** 已经写进 style 的那个数;`undefined` = 一次都没写过(读作「没有残高」)。 */
  get written(): number | undefined {
    return this.#written
  }

  /** 此刻该多高 —— 两个量里大的那个。**这一句是唯一算高的地方**(见文件头)。 */
  get height(): number {
    return Math.max(this.#wanted, this.#absorbed)
  }

  /** 此刻为「已吸收的回缩」垫着多高。单测与门的读面。 */
  get absorbed(): number {
    return this.#absorbed
  }

  /**
   * **申请吸收 `shrinkPx` 的回缩**(G2 的前半段;`shrinkPx` 正数,是**上界** ——
   * 报的人给的是「这一块此刻多高」,收起之后它还剩一行)。
   *
   * 同步把垫块加长**并当场写到位**,返回之后调用方才可以让那一块真的缩。
   * 返回真的多垫了多少:够高了(或停靠中量不到几何)答 0。
   *
   * **过让是自愈的**:多垫的那一截让 gap 变大,下一批尺寸变化里 `relax` 自己把它
   * 减掉 —— 不是一段留在屏上的空白。
   */
  requestAbsorb(shrinkPx: number, landingTop?: number): number {
    if (!(shrinkPx > 0)) return 0
    const m = this.#port.measure()
    // 停靠中(`clientHeight === 0`)一切读写恒等 —— 与三道闸同一把尺子。
    if (!m) return 0
    /*
     * `landingTop` = 收缩之后 `scrollTop` 要落在哪(审查裁定 1;不给就是「留在原地」,
     * 那一支与 09-21 那条式子 `已写的高 − gap + shrinkPx` 逐字等价 —— 展开代入即得)。
     * 「收缩之后的内容高」用 `shrinkPx` 这个**上界**算,所以 `needed` 是上界:
     * 多垫的那一截由 `relax` 在下一批尺寸变化里收回去。
     */
    const top = landingTop ?? m.scrollTop
    const contentAfter = m.scrollHeight - (this.#written ?? 0) - shrinkPx
    const needed = Math.max(0, top + m.clientHeight - contentAfter)
    /*
     * 夹进一屏:落点定在「顶边最高只到视口上缘」之后,**真值必然 ≤ 一屏**
     * (那一行连同它后面的内容至多填不满一屏),所以夹一下只会削掉上界那一截富余,
     * 不会削到真需要的那一截。
     */
    const required = Math.min(needed, m.clientHeight)
    if (required <= this.#absorbed) return 0
    const gained = required - this.#absorbed
    this.#absorbed = required
    this.flushNow()
    return gained
  }

  /**
   * **只减不增**:按「此刻还需要多少」往下收(`needed = 已写的高 − gap`)。
   *
   * 两条路都到这儿:人往上滚(gap 变大)、内容又长出来(`tail-growth`,同样让
   * gap 变大 —— 于是「新内容先吃垫块」,视口一像素不动)。缩的永远是**视口下方
   * 看不见的那一截**,所以不会钳位。
   *
   * **只记账、只排一帧,不当场写 style**:它的调用点在观察器回调与滚动回调里,
   * 「观察器回调只读不写」那条法禁的就是在那里改布局。
   */
  relax(gap: number): void {
    if (this.#absorbed <= 0) return
    const needed = Math.max(0, (this.#written ?? 0) - gap)
    if (needed >= this.#absorbed) return
    this.#absorbed = needed
    this.#coalescer.schedule()
  }

  /** 下一次发送:吸收的那一半归零(§2 拍点 3 的后半句)。座位那一半由落位自己重算。 */
  releaseAbsorbed(): void {
    if (this.#absorbed === 0) return
    this.#absorbed = 0
    this.#coalescer.schedule()
  }

  /**
   * **量一次座位**(只读),把结果存下来并排下一帧写。返回算出来的高。
   *
   * 座位不存在(没发过话 / 没落位 / 量不到几何)时恒 0 —— 那正是「退化为今天的
   * 落底 + 跟随」。
   */
  measure(): number {
    const geometry = this.#active && this.#landed ? this.#port.measureSeat() : undefined
    const next = geometry ? seatHeight(geometry) : 0
    this.#wanted = next
    /*
     * **只在数真的变了时才排那一帧**。流式期间这一句每秒跑几十遍,而绝大多数
     * 没有座位的会话上它算出来恒是 0 —— 照排的话就是白排一帧 rAF、白跑一次
     * 写(与「观察器不许自伤」同一条账)。
     */
    if (next !== this.#written) this.#coalescer.schedule()
    return next
  }

  /**
   * **同帧写到位** —— 发送落位、收场那一拍、以及「座位同帧跟上内容」那三条路要它
   * (今天 `writeSeat` 的三个同步调用点),下一帧那一次由 coalescer 调。
   *
   * 没有垫块那个元素时**不记账**:下一次它挂上来那一写不该被短路掉
   * (今天 `if (!seatRef.current) return` 排在记账之前,逐字同义)。
   */
  flushNow(): void {
    const next = this.height
    if (this.#written === next) return
    if (!this.#port.writePadHeight(next)) return
    this.#written = next
  }

  /**
   * 座位退役 / 换会话:那格「已写的数」也要归零 —— 不然下一条会话的第一次写会被
   * 一个属于上一棵树的数短路掉。
   */
  retire(): void {
    this.#written = undefined
    this.#wanted = 0
    this.#absorbed = 0
    this.#landed = false
  }

  /** 排着的那一帧属于已经不在的那棵树 —— 卸载时撤掉。 */
  dispose(): void {
    this.#coalescer.cancel()
  }
}
