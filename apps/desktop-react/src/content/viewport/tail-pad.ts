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
 * ── `#absorbed` 是 P2-b 的空位,这一期**不接线** ──────────────────────────
 * §13.2.4 把垫块的高定义成 `max(座位所需, 此刻还需要垫多高)`,后一半是「用户手动
 * 收起一块东西时把缩掉的高吸收掉,页面总高不变(G1)」。P2-a 的自述是抽件不改
 * 行为,所以这里只留一格 0 与一条 `height` 的式子 —— 今天 `Math.max(x, 0) === x`,
 * 与搬迁之前逐字相同。
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
  /** P2-b 的空位:本轮已吸收的回缩。今天恒 0,没有生产者。 */
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

  /** 此刻该多高。P2-b 之后它是两个量的大的那个,今天就是座位那一半。 */
  get height(): number {
    return Math.max(this.#wanted, this.#absorbed)
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
