import type { ScrollAnchor } from '../../data/session-view-state'

/**
 * 进场落回锚点之后**最多再对几轮**(2026-09-10)。
 *
 * 它不是一段时长(所以不进 `components/motion.ts` 那张时长镜像表),是一个
 * **轮数上限**:一轮 = 一次尺寸变化回调,也就是「又有一批跳渲的行渲出了真高」。
 * 六轮是「有界」这件事的落点 —— 停不下来就说明有别的东西在改排版,那时候老实
 * 停手比跟着跑一辈子好。
 */
export const ANCHOR_RESETTLE_ROUNDS = 6

/**
 * **进场落回锚点还没落稳的那一格**(G 线 P2-a 抽件;今天 `ChatStream.tsx` 的
 * `restoreRef`)。
 *
 * ── 为什么要再对(2026-09-10,`content-visibility: auto` 的直接后果)────────
 * 消息行现在是**跳渲**的:没进过视口的那些行占的是 `--msg-intrinsic-h` 那个估高
 * 的位。于是进场那一下算出来的落点是「按估高摆出来的那张排版」里的落点 ——
 * 赋完 `scrollTop`,锚点那一行连同它周围几行当场渲出真高,那张排版就变了,锚点行
 * 跟着漂。真机读数:190 轮的会话上漂掉整整一条消息(切回来停在上一条回答的中间,
 * 离原位 188px)。
 *
 * 所以进场只**立一格「还没落稳」**,真正再对由那只 ResizeObserver 做 ——
 * 「跳渲的行渲出真高了」这件事在浏览器那一侧的唯一表现就是**尺寸变了**,而那正是
 * 观察者的定义。不排 `requestAnimationFrame`:帧不是判据(离屏窗口里它还可能压根
 * 不来),而「排一帧再看看」与「变了就再对一次」相比,前者既可能来早(还没渲完)
 * 也可能来晚。
 *
 * **零 DOM、零 React**:它只记「对谁、还剩几轮」,对不对得上由调用方量。
 */
export class EntryRestore {
  #state: { anchor: ScrollAnchor; left: number } | undefined = undefined

  /** 进场落成了 —— 立一格,有界。 */
  arm(anchor: ScrollAnchor, rounds: number = ANCHOR_RESETTLE_ROUNDS): void {
    this.#state = { anchor, left: rounds }
  }

  /**
   * 作废(换会话 / 落稳了)。
   *
   * **换会话必须清**:它闭包着上一条会话的锚点。
   */
  clear(): void {
    this.#state = undefined
  }

  /** 此刻还在对吗;在对的话对的是哪一个锚。 */
  get anchor(): ScrollAnchor | undefined {
    return this.#state?.anchor
  }

  /**
   * 又对了一轮:扣掉一轮,按「还动不动得了」判落没落稳,落稳就当场作废。
   *
   * 三条判据与今天那一句 `||` 逐字同义,**次序也一样**:
   *  ① 那条消息不在树上了(`applied === false`)—— 没什么可对的;
   *  ② 再对一次没有把 `scrollTop` 挪动超过一个 `eps`,说明这张排版已经稳了;
   *  ③ 轮数用完(有界)。
   *
   * **扣轮数排在判据之前**,与今天那一句 `restoring.left -= 1` 的位置相同。
   */
  consume(applied: boolean, moved: number, eps: number): boolean {
    const state = this.#state
    if (!state) return true
    state.left -= 1
    const landed = !applied || Math.abs(moved) <= eps || state.left <= 0
    if (landed) this.#state = undefined
    return landed
  }

  /** 单测读面:还剩几轮。 */
  get left(): number | undefined {
    return this.#state?.left
  }
}
