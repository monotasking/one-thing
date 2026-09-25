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
  /** 冻结线上每一行最后一次量到的高与宽(`noteFrozen`;宽用来认「整列重排」)。 */
  readonly #rows = new Map<string, { height: number; width: number }>()
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

  /**
   * **冻结线上的一行**(G 线 P4-b ②,正本 §22.3):一轮进行中,不是活的那一行、也不是
   * 列尾那一行,高度**不许变** —— 变矮变高同为违例,每行只报一次。
   *
   * `cause` 由锚定器给:`undefined` = 这一行此刻**不在冻结线上**(没有一轮在跑 / 它就是
   * 活的那一行 / 它是列尾),**只记基准不判**;`user-toggle` = 人正开合着东西,允许变
   * (与 `note` 同一格例外);其余 cause 下任何变化都报。
   *
   * ── 为什么不拿 `note` 判变矮、这里只判变高(§22.3 原写法)────────────────
   * 两条理由,都是量出来之前就能看见的:① `note` 没有「只记不判」那一档 —— 冻结线
   * 之外的那段时间(轮与轮之间、改窗宽)行高会合法地变,基准要跟着记,而经 `note` 记
   * 就会被它判;② 同一次变矮会在 `note` 与这里各报一条、键不同去不了重。所以两个方向
   * 在这一个口里判,方向写进报文。
   *
   * ── 列宽变了不判 ─────────────────────────────────────────────────────────
   * 行高是列宽的函数:人拖窄了窗,每一行都会变 —— 那是整列重排,不是「这一行偷偷变」。
   * 宽变了(超过亚像素那一格)就只换基准。
   */
  noteFrozen(rowId: string, height: number, width: number, cause: GeometryCause | undefined): void {
    if (!Number.isFinite(height) || !Number.isFinite(width)) return
    const before = this.#rows.get(rowId)
    this.#rows.set(rowId, { height, width })
    if (before === undefined || cause === undefined || cause === 'user-toggle') return
    if (Math.abs(width - before.width) > 0.5) return
    const delta = height - before.height
    // 亚像素的来回不是「变了」—— 与这一线其余判据同一把尺子(0.5px)。
    if (Math.abs(delta) <= 0.5) return
    this.#flag(`${rowId}:frozen`, delta < 0
      ? '冻结线上的一行变矮了,而这一下不是人点的'
      : '冻结线上的一行长高了,而这一下不是人点的', {
      sourceId: rowId, cause, before: before.height, after: height, deltaPx: Number(delta.toFixed(2)),
    })
  }

  /** 换会话 / 卸载:这张表说的是**那边**的事。 */
  reset(): void {
    this.#seen.clear()
    this.#rows.clear()
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
