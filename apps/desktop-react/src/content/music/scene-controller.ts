import { MUSIC_SPIN_DOWN_MS, MUSIC_SPIN_UP_MS } from '../../components/motion'

/**
 * **转盘的惯性**(宠物 P1 起;音乐面 v8 起它是唱片面唯一的一台小机器)。
 *
 * 角速度只在 rAF 里改,**直接写 `transform`**,不进 React 状态(一秒六十次的重渲只为
 * 转一张唱片不值)。v8 起它还把每一帧的角度交给 `onAngle` —— 纹路上那道淡反光跟着
 * 真实转角起伏,惯性停转时一起停。
 *
 * (从前这里还有一台 `DeckController`:唱片收进封套、封套换歌、放片的那一串。v8 的唱片
 * 不收进封套,同一面里换歌只是唱臂走到下一圈,那台机器随旧唱机场景一起删了。)
 */

/* ── 转盘的惯性 ────────────────────────────────────────────────────────── */

/** 满速:33⅓ 转/分 = 200°/s。 */
export const SPIN_DEG_PER_S = 200
/** 一帧最多推进多久(切回前台那一帧不许一下转半圈)。 */
const MAX_FRAME_S = 0.05

/** rAF 的形状。可注入:jsdom 没有真的帧,单测喂一台手摇的。 */
export interface FrameSource {
  request(callback: (now: number) => void): number
  cancel(id: number): void
}

/** 宿主有 rAF 就用它;没有(SSR / 某些测试环境)答 null,转盘只摆不转。 */
export function browserFrames(): FrameSource | null {
  if (typeof requestAnimationFrame !== 'function') return null
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  }
}

export class SpinLoop {
  private readonly frames: FrameSource | null
  private targets: HTMLElement[] = []
  private spinning = false
  private suspended = false
  private velocity = 0
  private angle = 0
  private frame = 0
  private last: number | null = null

  /**
   * 每一帧转到的角度还要交给谁(音乐面 v8:纹路上那道淡反光跟着真实转角起伏)。
   * 它与 `targets` 同一拍画,所以惯性停转时反光也跟着慢慢停、停住就不动。
   */
  private readonly onAngle: ((deg: number) => void) | undefined

  constructor(frames: FrameSource | null, onAngle?: (deg: number) => void) {
    this.frames = frames
    this.onAngle = onAngle
  }

  /** 转哪几个元素(唱片与频闪环)。换了元素就重画一次当前角度。 */
  attach(targets: readonly (HTMLElement | null)[]): void {
    this.targets = targets.filter((el): el is HTMLElement => el !== null)
    this.paint()
  }

  /** 该不该转。`instant` = 直接摆(挂载 / 隐藏后恢复):速度当场到位,不演惯性。 */
  set(spinning: boolean, instant = false): void {
    this.spinning = spinning
    if (instant) this.velocity = spinning ? SPIN_DEG_PER_S : 0
    this.kick()
  }

  /** 隐藏时停掉 rAF;恢复时按当前该不该转直接摆(§8.2「不补播」)。 */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.stop()
      return
    }
    this.velocity = this.spinning ? SPIN_DEG_PER_S : 0
    this.kick()
  }

  /** 此刻在不在排帧(测试读数)。 */
  running(): boolean {
    return this.frame !== 0
  }

  /** 此刻的角速度(°/s,测试读数)。 */
  speed(): number {
    return this.velocity
  }

  dispose(): void {
    this.stop()
    this.targets = []
  }

  /** 推进 `dt` 秒:往目标速度加 / 减速,转一段角度。纯算术,单测直接调。 */
  step(dt: number): void {
    const target = this.spinning ? SPIN_DEG_PER_S : 0
    if (this.velocity < target) {
      this.velocity = Math.min(target, this.velocity + (SPIN_DEG_PER_S * dt * 1000) / MUSIC_SPIN_UP_MS)
    } else if (this.velocity > target) {
      this.velocity = Math.max(target, this.velocity - (SPIN_DEG_PER_S * dt * 1000) / MUSIC_SPIN_DOWN_MS)
    }
    this.angle = (this.angle + this.velocity * dt) % 360
  }

  private kick(): void {
    if (this.frame !== 0 || this.suspended || !this.frames) return
    if (!this.spinning && this.velocity === 0) return
    this.last = null
    this.frame = this.frames.request(this.tick)
  }

  private stop(): void {
    if (this.frame !== 0) this.frames?.cancel(this.frame)
    this.frame = 0
    this.last = null
  }

  private readonly tick = (now: number): void => {
    this.frame = 0
    const dt = this.last === null ? 0 : Math.min(MAX_FRAME_S, Math.max(0, now - this.last) / 1000)
    this.last = now
    this.step(dt)
    this.paint()
    if (this.spinning || this.velocity > 0) {
      const frames = this.frames
      if (frames) this.frame = frames.request(this.tick)
    }
  }

  private paint(): void {
    const value = `rotate(${this.angle}deg)`
    for (const el of this.targets) el.style.transform = value
    this.onAngle?.(this.angle)
  }
}
