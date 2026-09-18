import {
  MUSIC_ARM_MOVE_MS,
  MUSIC_FADE_MS,
  MUSIC_NEEDLE_LEAD_MS,
  MUSIC_SPIN_DOWN_MS,
  MUSIC_SPIN_UP_MS,
  MUSIC_STOW_MS,
  MUSIC_SWAP_MS,
} from '../../components/motion'

/**
 * **唱机场景的两台小机器**(宠物 P1,正本 `docs/design/pet-system-2026-09.md` §8.2)。
 *
 *  · `DeckController` —— 唱片、封套、唱臂**此刻摆成什么样**,以及从一种摆法走到
 *    另一种摆法的那一串(换歌、收片、放片、起转落针、暂停抬臂)。计时器全住在这里,
 *    所以「卸载清全部计时器」是一句 `dispose()`,每一条规矩都能脱离 DOM 单测
 *    (与 `pets/stage-controller.ts` 同一手)。
 *  · `SpinLoop` —— 转盘的惯性。角速度只在 rAF 里改,**直接写 `transform`**,不进 React
 *    状态(一秒六十次的重渲只为转一张唱片不值)。
 *
 * ── 只有一个判据:「想要的」与「摆着的」差在哪 ─────────────────────────────
 * 宿主每次把读数折成 `DeckDesired` 递进来(`sync`)。控制器不认识「上一次读数是什么」,
 * 它只比「此刻摆着的」与「想要的」:差在歌名就换歌、差在有没有歌就收 / 放、只差
 * 在转不转就起转 / 暂停。**一串动画跑着的时候来了新的想要,不插队也不丢**:那一串
 * 跑完再比一次(于是连跳三首只会从「此刻摆着的」直接换到第三首,不会补播中间两首)。
 *
 * ── 快照是不可变的 ──────────────────────────────────────────────────────
 * 每次变化造一份新对象交给订阅者(`useSyncExternalStore` 按引用判变没变)。
 */

export interface DeckDesired {
  /** 展示串「歌名 - 歌手」;没有就是空串。 */
  title: string
  /** 有歌:有歌名,或者没歌名但在放。 */
  present: boolean
  playing: boolean
}

export interface DeckSnapshot {
  /** 封套与标签上印的那一首(空串 = 素面)。 */
  readonly title: string
  /** 唱片在转盘上,还是收在封套里。 */
  readonly disc: 'on' | 'stowed'
  /** 封套在位,还是抽出去换片的那半程。 */
  readonly sleeve: 'in' | 'out'
  /** 唱臂靠在支架上,还是在唱片上方(角度由播放位置算)。 */
  readonly arm: 'rest' | 'track'
  readonly lifted: boolean
  /** 唱臂这一下怎么动:抬着移一大段,还是落下 / 挪一小段。 */
  readonly armMotion: 'move' | 'settle'
  /** 转盘该不该转(惯性由 `SpinLoop` 自己演)。 */
  readonly spinning: boolean
  /** 换歌 / 收片 / 放片那一串在跑:唱臂不许拖。 */
  readonly busy: boolean
  /** 减弱动态效果档下,那一串换成淡出淡入:此刻是淡出去的那一半。 */
  readonly fading: boolean
  /** 每一次「直接摆」(挂载 / 隐藏期间 / 淡出之后)加一:转盘据此跳到满速或停住,不补演惯性。 */
  readonly placedSeq: number
}

export interface DeckControllerOptions {
  /** 此刻是不是减弱动态效果档。缺省永远否。 */
  reducedMotion?: () => boolean
}

type Timer = ReturnType<typeof setTimeout>

const INITIAL: DeckSnapshot = {
  title: '',
  disc: 'stowed',
  sleeve: 'in',
  arm: 'rest',
  lifted: false,
  armMotion: 'settle',
  spinning: false,
  busy: false,
  fading: false,
  placedSeq: 0,
}

function sameDesired(a: DeckDesired | null, b: DeckDesired): boolean {
  return a !== null && a.title === b.title && a.present === b.present && a.playing === b.playing
}

export class DeckController {
  private readonly reducedMotion: () => boolean
  private listeners = new Set<() => void>()
  private snap: DeckSnapshot = INITIAL
  private desired: DeckDesired | null = null
  private suspended = false
  private timers = new Set<Timer>()

  constructor(options: DeckControllerOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? (() => false)
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): DeckSnapshot => this.snap

  // ── 宿主递进来的三件事 ──────────────────────────────────────────────────

  /** 读数折成的「想要的」。第一次到 = 挂载:直接摆,不播任何动画(§8.2 第一行)。 */
  sync(next: DeckDesired): void {
    const first = this.desired === null
    if (sameDesired(this.desired, next)) return
    this.desired = next
    if (first || this.suspended) {
      this.place()
      return
    }
    // 一串在跑:跑完自己再比一次。
    if (this.snap.busy) return
    this.reconcile()
  }

  /**
   * 隐藏(架子收起 / 窗口转后台)。藏起来那一刻就地收工:在飞的那一串作废,直接摆成
   * 「想要的」;藏着期间来的变化也只摆不演 —— 恢复时屏上已经是对的,不补播(§8.2)。
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended && this.desired !== null) this.place()
  }

  /**
   * 清全部计时器。一串跑到一半被拆,摆法就地落到「想要的」,别让 `busy` 永远挂着
   * (StrictMode 的模拟卸载会再挂回来)。之后控制器仍可用。
   */
  dispose(): void {
    const midway = this.timers.size > 0
    this.clearTimers()
    if (midway && this.desired !== null) this.place()
  }

  /** 此刻挂着的计时器个数(测试读数)。 */
  pendingTimers(): number {
    return this.timers.size
  }

  // ── 判据 ────────────────────────────────────────────────────────────────

  private reconcile(): void {
    const want = this.desired
    if (!want) return
    const shown = this.snap
    const wantTitle = want.present ? want.title : ''
    // 唱片永远在转盘上(素面 = 没歌),所以只有「印的是哪一首」会引出换片那一串。
    if (shown.title !== wantTitle) return this.sequence()
    this.clearTimers()
    if (!want.present) {
      // 没歌:唱臂归位、转盘停,素面唱片留在盘上(空转盘会被读成「坏了」)。
      this.patch({ spinning: false, arm: 'rest', lifted: false, armMotion: 'settle' })
      return
    }
    // 同一首:只差在转不转。上一次起转还没落针就被暂停,那几只计时器作废。
    if (want.playing) this.startPlaying()
    else this.pause()
  }

  /** 挂载 / 隐藏 / 淡出之后:不演,直接摆成「想要的」。 */
  private place(): void {
    const want = this.desired
    if (!want) return
    this.clearTimers()
    this.patch({
      title: want.present ? want.title : '',
      disc: 'on',
      sleeve: 'in',
      arm: want.present ? 'track' : 'rest',
      lifted: want.present && !want.playing,
      armMotion: 'settle',
      spinning: want.present && want.playing,
      busy: false,
      fading: false,
      placedSeq: this.snap.placedSeq + 1,
    })
  }

  /** 开始放(同一首):先转,450ms 后唱臂抬着移过去(已经在上方就只落下)。 */
  private startPlaying(): void {
    if (this.reducedMotion()) {
      this.patch({ spinning: true, arm: 'track', lifted: false, armMotion: 'settle' })
      return
    }
    const shown = this.snap
    if (shown.spinning && shown.arm === 'track' && !shown.lifted) return
    this.patch({ spinning: true })
    this.after(MUSIC_NEEDLE_LEAD_MS, () => {
      if (this.snap.arm === 'track') {
        this.patch({ lifted: false, armMotion: 'settle' })
        return
      }
      this.patch({ arm: 'track', lifted: true, armMotion: 'move' })
      this.after(MUSIC_ARM_MOVE_MS, () => this.patch({ lifted: false, armMotion: 'settle' }))
    })
  }

  /** 暂停:唱臂原地抬起(在支架上就抬着移到当前位置),转盘靠惯性停。 */
  private pause(): void {
    const atRest = this.snap.arm === 'rest'
    this.patch({ spinning: false, arm: 'track', lifted: true, armMotion: atRest && !this.reducedMotion() ? 'move' : 'settle' })
  }

  /**
   * 换片那一串:唱臂归位 → 唱片收进封套 → 封套换成新的一首 → 唱片滑出落回转盘。
   * 换到「没歌」也走同一串,只是回来的是一张**素面唱片**(没有标签)——空转盘看着像坏了,
   * 而唱机上留着一张唱片才是「现在没放」的样子。
   * 跑完 `busy` 落下,再比一次(此刻若在放,就是起转 + 落针到**此刻的**播放位置)。
   */
  private sequence(): void {
    this.clearTimers()
    if (this.reducedMotion()) {
      this.patch({ busy: true, fading: true })
      this.after(MUSIC_FADE_MS, () => {
        this.place()
        this.patch({ busy: true, fading: false })
        this.after(MUSIC_FADE_MS, () => this.finish())
      })
      return
    }

    const steps: Array<() => number> = [
      () => {
        const settled = this.snap.arm === 'rest' && !this.snap.lifted
        this.patch({ busy: true, arm: 'rest', lifted: !settled, armMotion: 'move', spinning: false })
        return settled ? 0 : MUSIC_ARM_MOVE_MS
      },
      () => {
        this.patch({ lifted: false, disc: 'stowed' })
        return MUSIC_STOW_MS
      },
      () => {
        this.patch({ busy: true, sleeve: 'out' })
        return MUSIC_SWAP_MS / 2
      },
      () => {
        // 读**这一刻**想要的歌名:一串跑着时又换了一首,封套直接换成最新那一首。
        // 没歌就换成空串 —— 回到盘上的是一张素面唱片。
        const want = this.desired
        this.patch({ title: want?.present ? want.title : '', sleeve: 'in' })
        return MUSIC_SWAP_MS / 2
      },
      () => {
        this.patch({ disc: 'on' })
        return MUSIC_STOW_MS
      },
    ]

    const run = (i: number) => {
      if (i >= steps.length) {
        this.finish()
        return
      }
      const wait = steps[i]()
      if (wait <= 0) run(i + 1)
      else this.after(wait, () => run(i + 1))
    }
    run(0)
  }

  private finish(): void {
    this.patch({ busy: false })
    this.reconcile()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private patch(next: Partial<DeckSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    for (const listener of this.listeners) listener()
  }
}

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

  constructor(frames: FrameSource | null) {
    this.frames = frames
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
  }
}
