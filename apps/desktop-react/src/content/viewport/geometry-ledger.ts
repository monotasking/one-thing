import type { GeometryCause } from './types'

/**
 * **dev 运行时断言:上过屏的东西不许偷偷变矮**(G 线 P2-c;正本 §1 推论五、§18.4)。
 *
 * ── 它是宪法的哪一条 ──────────────────────────────────────────────────────
 *  · **G3**「块有直播形,自动收缩不存在」—— 流式期间高度只增不减,会变矮的只有
 *    一种原因:**用户自己点的**。所以这里的判据是「变矮了,而 `cause` 不是
 *    `user-toggle`」;
 *  · **G4**「落定那一帧几何上什么都不发生」—— 收尾只许换透明度、颜色、停动画,
 *    不许换高度。所以 `settle` 那一格判的是 `deltaH !== 0`。
 *
 * ── 为什么只 `warn` 不抛 ──────────────────────────────────────────────────
 * 它会在**存量**上报出一批今天没人知道的违例(`.rowLate` 那条高度过渡几乎肯定
 * 中招)。抛的话等于把一条诊断线变成一条崩溃线,而这一单的自述是**先量**:
 * 第一批报出来的要逐条归类进留账,**不许顺手改产品**(仓根「行为裁定须先问」)。
 *
 * ── 为什么每个 `sourceId` 只报一次 ────────────────────────────────────────
 * 一段过渡逐帧都会报,不去重的话一次收起就是十几行同样的话,真正的第二条违例
 * 反而被冲走。**记的是「这一件报过了」**,而不是一个全局闩:两件东西各自违例
 * 要看得见两条。
 *
 * ── prod 零开销 ───────────────────────────────────────────────────────────
 * 这只类**只在 `import.meta.env.DEV` 下被 new 出来**(`use-viewport-anchor.ts`
 * 那一句);prod 下 `ViewportAnchor.#ledger` 是 `undefined`,每个报点都是一句
 * `this.#ledger?.…` 的空跳。表也只在那时才建。
 *
 * **零 DOM、零 React**:`sourceId` 是一个字符串,高是一个数 —— 所以 vitest 里
 * 喂一只假 logger 就能把每一条违例路径钉住。
 */
export interface GeometryViolationSink {
  (message: string, fields: Record<string, unknown>): void
}

export class GeometryLedger {
  readonly #warn: GeometryViolationSink
  /** 上过屏的每一件最后一次量到的高。 */
  readonly #seen = new Map<string, number>()
  /** 已经报过的那几件 —— 一段过渡逐帧都会报,不去重就刷屏。 */
  readonly #warned = new Set<string>()

  constructor(warn: GeometryViolationSink) {
    this.#warn = warn
  }

  /**
   * 记一次高,并判「变矮了没有」。
   *
   * `cause === 'user-toggle'` 是**唯一**允许变矮的原因(G3);其余任何一格 cause
   * 下变矮都是违例。高度**照记**——报过之后接着量,不然一件违例过的东西从此
   * 失去监督。
   */
  note(sourceId: string, cause: GeometryCause, height: number): void {
    if (!Number.isFinite(height)) return
    const before = this.#seen.get(sourceId)
    this.#seen.set(sourceId, height)
    if (before === undefined || cause === 'user-toggle') return
    const shrink = before - height
    // 亚像素的来回不是「变矮」—— 与这一线其余判据同一把尺子(0.5px)。
    if (shrink <= 0.5) return
    this.#flag(sourceId, '上过屏的东西变矮了,而这一下不是人点的', {
      sourceId, cause, before, after: height, shrinkPx: Number(shrink.toFixed(2)),
    })
  }

  /**
   * 落定那一帧(G4):**几何上什么都不许发生**。`deltaH` 不是 0 就是违例。
   *
   * 它与 `note` 分开,因为 `settle` 判的不是方向而是「动没动」——落定那一下长高
   * 同样是违例(内容形态换了但不许改高)。
   */
  settle(sourceId: string, deltaH: number): void {
    if (!Number.isFinite(deltaH)) return
    if (Math.abs(deltaH) <= 0.5) return
    this.#flag(`${sourceId}:settle`, '落定那一帧几何上不许有变化', {
      sourceId, cause: 'settle' satisfies GeometryCause, deltaH: Number(deltaH.toFixed(2)),
    })
  }

  /** 换会话 / 卸载:这张表说的是**那边**的事。 */
  reset(): void {
    this.#seen.clear()
    this.#warned.clear()
  }

  /** 单测读面:报过哪几件。 */
  get warned(): readonly string[] {
    return [...this.#warned]
  }

  #flag(key: string, message: string, fields: Record<string, unknown>): void {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    this.#warn(message, fields)
  }
}
