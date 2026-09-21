import type { AnchoredElement } from './scroll-port'

/**
 * **两格「人动了手,接下来这么久归他」的时限窗口**(G 线 P2-a 抽件;今天
 * `ChatStream.tsx` 的 `holdUntilRef` 与 `foldHoldRef`)。
 *
 * ── 这一期**只是搬,没有合一** ────────────────────────────────────────────
 * §13.2.2 的终态是「方向由 `GeometryChange.deltaH` 的正负说」,两条通道合成一条。
 * 那是 P2-c;P2-a 的自述是抽件不改行为,所以这里**仍是两格**,判据逐字照搬 ——
 * `content/expand-intent.ts` / `content/fold-intent.ts` 两条 context 原样留着。
 *
 * ── 为什么是两格,不是一格 ────────────────────────────────────────────────
 *  · 展开那一格说的是「**别贴底**」—— 内容长高,跟底那一半按兵不动就够了;
 *  · 折起那一格说的是「**把人正在读的那一行钉住**」—— 内容变矮,不动手屏幕会往上抽。
 * 一格布尔分不出这两件事该做什么,合并回去就是把两条相反的补偿挤进一个判据。
 *
 * ── 为什么记的是「到什么时候为止」,不是一个布尔闩 ────────────────────────
 * 展开 / 折叠都是一段**过渡 / FLIP**,尺寸变化会**逐帧**来好几次,一次性闩被第一帧
 * 消费掉之后,后面那几帧照旧跟底(报障二仍在);而且短会话里第一帧往往还没溢出,
 * gap 仍是 0,状态压根不会翻成 browsing。
 *
 * **为什么不是 `transitionend`**:动效档「无」下它根本不发、被打断时也不发,而且
 * 四个消费者(折痕 / 压缩折痕 / 思考段 / 工具卡)各自的过渡挂在各自的元素上,要
 * 一一接线;截止时刻是一个数,谁报都一样。
 *
 * **零 DOM**:`now` 由调用方给(今天 `performance.now()`),锚是 `AnchoredElement`。
 */
export class IntentWindow {
  /**
   * **人自己点开的那样东西还在长,到这一刻为止**(2026-09-12 报障二的「位」)。
   * 0 = 没有这回事。
   */
  #expandUntil = 0

  /**
   * **流里有一块正在折起来,这段时间钉住视口**(单 B ④)。
   *
   * `anchor` 在**这一段的第一帧**选定并记下它当时的位置,之后每一帧把它按回去。
   * 选锚要在排版之后(RO 回调里),所以报的那一头只记截止时刻,不碰几何。
   */
  #fold: FoldHold | undefined = undefined

  /** 「我这一下是用户点开的,别贴底」。`ms` 由调用方给(`EXPAND_HOLD_MS`)。 */
  noteExpand(now: number, ms: number): void {
    this.#expandUntil = now + ms
  }

  /** 「我这一块开始往回折了,接下来这么久请钉住视口」。`ms` 已含余量。 */
  noteFold(now: number, ms: number): void {
    this.#fold = { until: now + ms }
  }

  /**
   * 换会话不带上一条会话的意图 —— 那格截止时刻说的是「**那边**有人点开了一样东西」。
   *
   * 只清展开那一格,与今天进场那只 layout effect 里的 `holdUntilRef.current = 0`
   * 逐字相同(折叠那一格今天不在换会话时清:它自己过期,而且它的锚会因为
   * `alive()` 变假而重选)。
   */
  clearExpand(): void {
    this.#expandUntil = 0
  }

  /** 此刻还在展开窗里吗(今天那句 `performance.now() < holdUntilRef.current`)。 */
  expanding(now: number): boolean {
    return now < this.#expandUntil
  }

  /**
   * 此刻的折叠窗。**过期就当场清掉并答 `undefined`** —— 与今天那两句
   * `if (performance.now() > hold.until) foldHoldRef.current = undefined; else …`
   * 逐字同义(注意是 `>` 不是 `>=`)。
   */
  folding(now: number): FoldHold | undefined {
    const hold = this.#fold
    if (!hold) return undefined
    if (now > hold.until) {
      this.#fold = undefined
      return undefined
    }
    return hold
  }

  /** 单测读面。 */
  get expandUntil(): number {
    return this.#expandUntil
  }
}

/**
 * 折叠那一段钉住的是谁、钉在哪。
 *
 * 两格都是**可选**的:这一段的第一帧才选锚(选锚要在排版之后),而在选到之前
 * 每一帧都会再试一次 —— 今天那一句 `if (!hold.anchor || !hold.anchor.isConnected)`。
 */
export interface FoldHold {
  readonly until: number
  anchor?: AnchoredElement
  top?: number
}
