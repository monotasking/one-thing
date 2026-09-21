import type { GeometryCause } from './types'
import type { ScrollPort } from './scroll-port'

/**
 * **滑到那个位置**(G 线 P2-a 抽件;判词从 `ChatStream.tsx` 的 `slideScrollTo` /
 * `cancelLanding` 与三格 ref 原样搬过来)。
 *
 * 发送与重试落到置顶线走的是**同一段插值**,所以它只有一个产地:两处各写一遍
 * 就是两条缓动曲线、两套「第二只手」的判据,而它们说的是同一件事。
 * 调用方负责「要不要滑、滑到哪」,这只类只负责「怎么滑过去」。
 *
 * ── 为什么是 JS 插值,不是 `scrollTo({behavior:'smooth'})` ────────────────
 * 与别的几处写点同一条:**定位不是动效**。`behavior: 'smooth'` 在动效档「无」下
 * 照样平滑(它听的是系统的 `prefers-reduced-motion`,不是壳自己那格档位),而这
 * 一下在那一档必须一步到位;它也交不出「此刻滑到哪了」这个读数,而
 * `ScrollPort` 的 `lastTop` 同步必须逐帧做。
 *
 * ── 滑动期间不许被读成「人往上翻」────────────────────────────────────────
 * 「是谁离的底」判的是 `scrollTop` 比上一次小没小(2026-09-12 那条判例)。我们
 * 自己每帧写的那个数要**当场**记进 `lastTop` —— 收口之后那一句在 `setTop` 里,
 * 这里不必再写一遍(滚动事件比写点晚一帧,不记就会拿滑动之前的位置当参照)。
 *
 * ── 人在滑动中间自己滚了 ──────────────────────────────────────────────────
 * 当场收手:下一帧读到的 `scrollTop` 不是我们上一帧写下去的那个数,就说明这台
 * 机器上有第二只手。判据仍然只有位置,没有标志位。
 *
 * **零 DOM**:它只认 `ScrollPort` 与下面那只 `FramePort`,所以 vitest 里喂一对
 * 假的就能把每一帧逐格测到。
 */
export class Slide {
  readonly #port: ScrollPort
  readonly #frames: FramePort
  readonly #durationOf: (distancePx: number) => number
  readonly #onSettle: () => void
  readonly #cause: GeometryCause

  /** 在飞的那一帧的句柄;0 = 没有。`step()` 第一行就把它清成 0(rAF 已经烧掉了)。 */
  #frame = 0
  /** 我们上一帧写下去的那个数(读回来的)——「第二只手」的参照。 */
  #wrote: number | undefined = undefined
  /**
   * **这一刻正在滑**(G 线 P1 加的那一格)。
   *
   * 它的唯一读者是「座位同帧跟上」那只 layout effect:滑动那一段里 `scrollTop`
   * 每帧由我们自己写,此刻再去改 `scrollHeight` 会让浏览器钳一下,而那一钳正好
   * 长得像「有第二只手在滚」—— 插值当场收手,落点作废(09-15 实测过的那 −189px
   * 就是这个形)。
   *
   * 不复用 `#frame`:那一格在 `step()` 的第一行就被清成 0,拿它当「在不在滑」
   * 会在每一帧的开头答错。
   */
  #running = false

  constructor(
    port: ScrollPort,
    options: {
      /** 这一段该滑多久(ms)。**答 0 = 一步到位** —— 动效档「无」下就是它。 */
      durationOf: (distancePx: number) => number
      /** 落定之后回一句(今天那只 `settle`:把 gap 基准对齐)。 */
      onSettle: () => void
      frames?: FramePort
      cause?: GeometryCause
    },
  ) {
    this.#port = port
    this.#durationOf = options.durationOf
    this.#onSettle = options.onSettle
    this.#frames = options.frames ?? hostFrames
    this.#cause = options.cause ?? 'send-landing'
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * 滑到 `target`。
   *
   * 目标在**算的时候**就该由调用方夹进 `[0, 最大可滚]`,所以每一帧都 ≤ 目标,
   * 单调、无反向(判词在 `ScrollPort.sendLineTarget` 与 `seat.ts` 的 `SEAT_LINES`)。
   */
  to(target: number): void {
    const from = this.#port.top
    const distance = Math.abs(target - from)
    const ms = this.#durationOf(distance)
    if (ms === 0 || distance < 1) {
      this.#port.setTop(target, this.#cause)
      this.#onSettle()
      return
    }
    const started = this.#frames.now()
    const step = () => {
      this.#frame = 0
      // 第二只手:我们上一帧写下去的那个数不在了,就是人自己滚了 —— 收手。
      if (this.#wrote !== undefined && Math.abs(this.#port.top - this.#wrote) > 1) {
        this.#wrote = undefined
        this.#running = false
        return
      }
      const k = Math.min(1, (this.#frames.now() - started) / ms)
      // 缓出(三次):起步快、落点轻,与 `--ease-out` 的形同族。
      const eased = 1 - (1 - k) ** 3
      this.#port.setTop(from + (target - from) * eased, this.#cause)
      // 记的是**读回来的**那个数(浏览器会钳)—— 与 `lastTop` 同一条判词。
      this.#wrote = this.#port.top
      if (k < 1) this.#frame = this.#frames.request(step)
      else {
        this.#wrote = undefined
        this.#running = false
        this.#onSettle()
      }
    }
    if (!this.#frames.available) {
      this.#port.setTop(target, this.#cause)
      this.#onSettle()
      return
    }
    this.#running = true
    this.#frame = this.#frames.request(step)
  }

  /** 撤掉在飞的那一帧(换会话 / 卸载 / 下一次落位之前)。 */
  cancel(): void {
    if (this.#frame && this.#frames.available) this.#frames.cancel(this.#frame)
    this.#frame = 0
    this.#wrote = undefined
    this.#running = false
  }
}

/**
 * **帧从哪来**。抽成一格是为了让 `Slide` 在 vitest 里不靠宿主跑起来 ——
 * 今天那只 `typeof requestAnimationFrame !== 'function'` 的判据落在 `available`
 * 上,一个字没松(jsdom / 离屏窗口里帧可能压根不来,那时一步到位)。
 */
export interface FramePort {
  readonly available: boolean
  request(cb: () => void): number
  cancel(handle: number): void
  now(): number
}

/** 宿主那一只。`available` 与今天 `slideScrollTo` 里那句判据逐字同义。 */
export const hostFrames: FramePort = {
  get available() {
    return typeof requestAnimationFrame === 'function'
  },
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  },
  now: () => performance.now(),
}

/** 单测用:手动推帧。 */
export class FakeFrames implements FramePort {
  available = true
  time = 0
  #next = 1
  #queue = new Map<number, () => void>()

  request(cb: () => void): number {
    const handle = this.#next++
    this.#queue.set(handle, cb)
    return handle
  }

  cancel(handle: number): void {
    this.#queue.delete(handle)
  }

  now(): number {
    return this.time
  }

  /** 推一帧:时间往前走 `ms`,把此刻排着的那几只跑掉。 */
  tick(ms: number): void {
    this.time += ms
    const batch = [...this.#queue.values()]
    this.#queue.clear()
    for (const cb of batch) cb()
  }

  get pending(): number {
    return this.#queue.size
  }
}
