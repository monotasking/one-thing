import type { ScrollAnchor } from '../../data/session-view-state'

/**
 * **「看到哪儿」的尾随去抖**(G 线 P2-a 抽件;判词从 `ChatStream.tsx` 的
 * `anchorTimer` / `scheduleAnchorSave` 与进场那只 effect 原样搬过来)。
 *
 * 每一次滚动重排计时器,停稳 `settleMs` 之后量一次、记一笔。连滚一百下只在最后
 * 停下来那一次量,而量的是**还挂在文档上**的那个容器。
 *
 * 不设「这一下是不是我自己滚的」标志位 —— 与「是谁离的底」同一条纪律(理由全文
 * 在 `content/follow.ts` 文件头)。我们自己贴底那几下量出来就是 `'bottom'`,
 * 而那句话恰好是真的:此刻人就在最新处。代价是**冷载入那条路上**消息到齐后的
 * 自动贴底会把上一次记的锚点改写成 `'bottom'`(留账 ② 说的「锚点留着下次用」到此
 * 为止)—— 那不是说谎,是这一帧的事实;真要保住它得先治「冷载入不落锚点」那一格,
 * 那是另一单。
 *
 * ── 两个口,两条判据,不合并 ──────────────────────────────────────────────
 * · `schedule()` 去抖那一发**带停靠守卫**:它可能落在已经被停靠之后,那时容器
 *   没有排版,量出来的「离底 0」是假的(判词在 `measureScrollAnchor` 的 0 高度
 *   那一句上);
 * · `saveNow()` **不带**:进场落定与离场兜底那两处调的就是它,`measureScrollAnchor`
 *   自己只看 `isConnected`,量不到照旧答 `undefined`、不当一次写。
 *
 * **零 DOM**:量与守卫都由调用方交进来的两只函数答,所以 vitest 里喂一对假的
 * 就能把去抖与跨会话那几条逐格测到。
 */
export class AnchorRecorder {
  readonly #hasLayout: () => boolean
  readonly #measure: () => ScrollAnchor | undefined
  readonly #save: (sessionId: string, anchor: ScrollAnchor | undefined) => void
  readonly #settleMs: number
  readonly #timers: TimerPort
  #handle: number | undefined = undefined

  constructor(options: {
    hasLayout: () => boolean
    measure: () => ScrollAnchor | undefined
    save: (sessionId: string, anchor: ScrollAnchor | undefined) => void
    settleMs: number
    timers?: TimerPort
  }) {
    this.#hasLayout = options.hasLayout
    this.#measure = options.measure
    this.#save = options.save
    this.#settleMs = options.settleMs
    this.#timers = options.timers ?? hostTimers
  }

  /** 人滚了一下 —— 重排计时器。停稳之后才量(量在停下来那一下)。 */
  schedule(sessionId: string): void {
    if (this.#handle !== undefined) this.#timers.clear(this.#handle)
    this.#handle = this.#timers.set(() => {
      this.#handle = undefined
      // 去抖那一发可能落在**已经被停靠**之后:那时容器没有排版,量出来的
      // 「离底 0」是假的。
      if (this.#hasLayout()) this.#save(sessionId, this.#measure())
    }, this.#settleMs)
  }

  /** 此刻量到的就是真的,当场记一笔(进场落定 / 落位落稳 / 离场兜底)。 */
  saveNow(sessionId: string): void {
    this.#save(sessionId, this.#measure())
  }

  /**
   * 撤掉还没到点的那一发。
   *
   * **换会话时必须撤**:它闭包着**上一条**会话的 id,而此刻容器里已经是下一条
   * 会话的几何了。
   */
  cancel(): void {
    if (this.#handle === undefined) return
    this.#timers.clear(this.#handle)
    this.#handle = undefined
  }

  /** 单测读面:此刻有没有一发在飞。 */
  get pending(): boolean {
    return this.#handle !== undefined
  }
}

/** 计时器从哪来 —— 抽成一格,好让去抖在 vitest 里不靠真时钟跑。 */
export interface TimerPort {
  set(cb: () => void, ms: number): number
  clear(handle: number): void
}

export const hostTimers: TimerPort = {
  set: (cb, ms) => window.setTimeout(cb, ms),
  clear: (handle) => window.clearTimeout(handle),
}

/** 单测用:手动到点。 */
export class FakeTimers implements TimerPort {
  #next = 1
  readonly #queue = new Map<number, { cb: () => void; at: number }>()
  time = 0

  set(cb: () => void, ms: number): number {
    const handle = this.#next++
    this.#queue.set(handle, { cb, at: this.time + ms })
    return handle
  }

  clear(handle: number): void {
    this.#queue.delete(handle)
  }

  /** 时间往前走 `ms`,把到点的那几只跑掉。 */
  advance(ms: number): void {
    this.time += ms
    for (const [handle, row] of [...this.#queue]) {
      if (row.at > this.time) continue
      this.#queue.delete(handle)
      row.cb()
    }
  }

  get pending(): number {
    return this.#queue.size
  }
}
