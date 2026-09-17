import { FrameCoalescer } from '../ui/frame-coalescer'
import type { ReactionGroup } from './manifest'
import { classifyTravel, hasDozedOff, muttersGroupFor, registerPoke, STILL_DOZE_MS } from './pose'
import { mutterHoldMs, SPEAK_HOLD_MS, splitGlyphs, TYPE_LEAD_MS, typeDelayAfter } from './bubble'
import type { PetAction, PetActivity, PetChoice, PetGesture, PetOneShot, PetUtterance } from './types'

/**
 * **栖位里那只宠物的瞬时状态机**(宠物 P0,正本 §7.1 / §7.3 / §7.4)。
 *
 * `PetStage` 是它的壳:React 那一侧只负责把 props 递进来、把快照画出去、把指针
 * 与点击转成这里的动词。**计时器全住在这里**(打字、停留、打盹、一次性动画的重播帧),
 * 所以「卸载清全部计时器」是一句 `dispose()`,而每一条规矩都能脱离 DOM 单测。
 *
 * 它不认识任何一只宠物:台词由宿主注入的 `line(group)` 交来,形象由舞台查表。
 *
 * ── 快照是不可变的 ────────────────────────────────────────────────────────
 * 每次变化造一份新对象交给订阅者(`useSyncExternalStore` 按引用判变没变)。
 */

export interface StageBubble {
  /** 每句话语一个号;换一句就换号(React key、定位、落焦都按它认)。 */
  readonly id: number
  readonly mode: 'speak' | 'mutter'
  readonly glyphs: readonly string[]
  /** 已经出来了几个字。嘀咕一出现就是全句。 */
  readonly typed: number
  /** 字出完了(嘀咕恒为 true)。 */
  readonly done: boolean
  readonly choices?: readonly PetChoice[]
  readonly actions?: readonly PetAction[]
  readonly sticky: boolean
}

export interface StageSnapshot {
  readonly activity: PetActivity
  readonly stillSince: number | null
  /** 最近一次量时钟的时刻(活动变化 / 打盹线到点时更新)。姿势按它算,不在渲染里读表。 */
  readonly now: number
  readonly petted: boolean
  /** 开口中 = 字还在出。 */
  readonly speaking: boolean
  readonly bubble: StageBubble | null
  readonly oneShot: PetOneShot | undefined
}

export interface StageHooks {
  /** 按组取一句嘀咕;这一组没有台词时答 undefined(什么都不说)。 */
  line?: (group: ReactionGroup) => { text: string; holdMs?: number } | undefined
  onSpeakingChange?: (speaking: boolean) => void
  onChoice?: (value: string | null) => void
  onGesture?: (gesture: PetGesture) => void
}

export interface StageControllerOptions {
  activity: PetActivity
  clock?: () => number
  random?: () => number
}

type ActivityKind = 'off' | 'busy' | 'rhythm' | 'still' | 'fault' | 'idle'

function kindOf(activity: PetActivity): ActivityKind {
  return typeof activity === 'object' ? activity.kind : activity
}

interface Press {
  travel: number
  stroking: boolean
  /** 这一下已经作废(撸到一半来了开口):松手什么都不发生,也不许再进撸。 */
  spent: boolean
}

type Timer = ReturnType<typeof setTimeout>

export class PetStageController {
  hooks: StageHooks = {}

  private readonly clock: () => number
  private readonly random: () => number
  private listeners = new Set<() => void>()
  private snap: StageSnapshot

  private press: Press | null = null
  private pokes: readonly number[] = []
  private bubbleSeq = 0

  private typeTimer: Timer | null = null
  private holdTimer: Timer | null = null
  private dozeTimer: Timer | null = null
  /** 一次性动画重播:先撤一帧再给(同一种连着来两次时,换值才会重播)。 */
  private pendingShot: PetOneShot | undefined
  private readonly shotFrame = new FrameCoalescer(() => this.patch({ oneShot: this.pendingShot }))

  constructor(options: StageControllerOptions) {
    this.clock = options.clock ?? Date.now
    this.random = options.random ?? Math.random
    const now = this.clock()
    const still = kindOf(options.activity) === 'still'
    this.snap = {
      activity: options.activity,
      stillSince: still ? now : null,
      now,
      petted: false,
      speaking: false,
      bubble: null,
      oneShot: undefined,
    }
  }

  /**
   * 挂上(舞台的挂载 effect 调)。挂载:按当前活动直接摆姿势,不播 wake;still 从
   * 构造那一刻起算打盹线(§7.1 第一行)。`dispose()` 之后再 `start()`(StrictMode 的
   * 模拟卸载→再挂载)会把打盹线按剩下的时间重新排上。
   */
  start(): void {
    const { activity, stillSince } = this.snap
    if (kindOf(activity) !== 'still' || stillSince === null || this.dozeTimer !== null) return
    const left = STILL_DOZE_MS - (this.clock() - stillSince)
    if (left > 0) this.armDoze(left)
    else this.patch({ now: this.clock() })
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): StageSnapshot => this.snap

  // ── 活动(§7.1 第二行)─────────────────────────────────────────────────

  setActivity(next: PetActivity): void {
    const prev = this.snap.activity
    if (kindOf(prev) === kindOf(next)) {
      // 同一种活动换参数(rhythm 换了 bpm):只换拍子,不算「活动变化」。
      if (prev !== next) this.patch({ activity: next })
      return
    }
    const now = this.clock()
    const wasDozing = hasDozedOff({ activity: prev, stillSince: this.snap.stillSince, now })
    const nextStill = kindOf(next) === 'still'
    this.clearTimer('doze')
    this.patch({ activity: next, stillSince: nextStill ? now : null, now })
    if (nextStill) this.armDoze(STILL_DOZE_MS)

    if (kindOf(prev) === 'off') {
      this.shoot('wake')
    } else if (wasDozing && kindOf(next) !== 'off') {
      // 打盹被叫醒:跳一下,嘀咕一句「我没睡」—— 但正在显示的气泡不打断。
      this.shoot('startle')
      if (!this.snap.bubble) this.mutterGroup('woke')
    }
  }

  // ── 话语(§7.4)────────────────────────────────────────────────────────

  /** 新话语替换当前气泡(同一时刻只有一句)。`null` = 宿主清掉。 */
  say(utterance: PetUtterance | null): void {
    this.clearTimer('type')
    this.clearTimer('hold')
    if (!utterance) {
      this.hide()
      return
    }
    const id = ++this.bubbleSeq
    const glyphs = splitGlyphs(utterance.text)
    const sticky = utterance.sticky === true
    if (utterance.mode === 'speak') {
      // 撸时来的开口结束撸,松手前也结束(§7.1 第三行)。
      const endStroke = this.press?.stroking === true
      if (this.press) this.press = { ...this.press, stroking: false, spent: true }
      this.patch({
        bubble: { id, mode: 'speak', glyphs, typed: 0, done: false, choices: utterance.choices, actions: utterance.actions, sticky },
        ...(endStroke ? { petted: false } : {}),
      })
      this.setSpeaking(true)
      this.typeTimer = setTimeout(() => this.typeNext(id, utterance.holdMs), TYPE_LEAD_MS)
      return
    }
    this.patch({
      bubble: { id, mode: 'mutter', glyphs, typed: glyphs.length, done: true, choices: utterance.choices, actions: utterance.actions, sticky },
    })
    this.setSpeaking(false)
    if (!sticky && !utterance.choices?.length) {
      this.holdTimer = setTimeout(() => this.hideIf(id), mutterHoldMs(utterance.holdMs, this.random))
    }
  }

  /** 选了一个选项(`null` = Esc,等于不选)。只在选项已经亮出来时成立。 */
  choose(value: string | null): boolean {
    const bubble = this.snap.bubble
    if (!bubble?.done || !bubble.choices?.length) return false
    this.hide()
    this.hooks.onChoice?.(value)
    return true
  }

  /** Esc:有选项在等就等于不选;否则不认这一下(交给外层)。 */
  escape(): boolean {
    return this.choose(null)
  }

  /** 按了常驻 / 开口气泡上的动作按钮。 */
  act(index: number): void {
    const action = this.snap.bubble?.actions?.[index]
    if (!action) return
    this.hide()
    action.onSelect()
  }

  // ── 手势(§7.3)────────────────────────────────────────────────────────

  pressStart(): void {
    this.press = { travel: 0, stroking: false, spent: false }
  }

  pressMove(dx: number): void {
    const press = this.press
    if (!press || press.spent) return
    const travel = press.travel + Math.abs(dx)
    this.press = { ...press, travel }
    if (press.stroking || classifyTravel(travel) !== 'stroke') return
    this.press = { ...this.press, stroking: true }
    const bubble = this.snap.bubble
    // 进入撸:当前嘀咕气泡收起(常驻的留着 —— 它只归宿主与动作按钮管)。
    if (bubble && bubble.mode === 'mutter' && !bubble.sticky && !bubble.choices?.length) this.hide()
    this.patch({ petted: true })
  }

  /** 松手(`up`)或这一下作废(`cancel`:指针被收走 / 窗口失焦 / Esc)。 */
  pressEnd(kind: 'up' | 'cancel'): void {
    const press = this.press
    this.press = null
    if (!press) return
    if (press.stroking) {
      this.patch({ petted: false })
      this.hooks.onGesture?.({ kind: 'stroke' })
      if (this.canMutterOver()) this.mutterGroup(kindOf(this.snap.activity) === 'off' ? 'strokedAsleep' : 'stroked')
      return
    }
    if (kind === 'up' && !press.spent && classifyTravel(press.travel) === 'poke') this.poke()
  }

  /** 点一下(指针松手判成点,或键盘 Enter / Space)。 */
  poke(): void {
    this.hooks.onGesture?.({ kind: 'poke' })
    if (this.snap.speaking) {
      this.shoot('twitch')
      return
    }
    this.shoot('squish')
    const counted = registerPoke(this.pokes, this.clock())
    this.pokes = counted.history
    if (!this.canMutterOver()) return
    this.mutterGroup(counted.annoyed ? 'annoyed' : muttersGroupFor(this.snap.activity))
  }

  /** 宿主说「用户喜欢了这个」:冒爱心 + 嘀咕 `liked`。 */
  love(): void {
    this.shoot('love')
    if (this.canMutterOver()) this.mutterGroup('liked')
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────

  /** 清全部计时器与按压状态。之后控制器仍可用(StrictMode 的模拟卸载会再挂回来)。 */
  dispose(): void {
    this.clearTimer('type')
    this.clearTimer('hold')
    this.clearTimer('doze')
    this.shotFrame.cancel()
    this.press = null
    if (this.snap.speaking) this.setSpeaking(false)
  }

  /** 此刻挂着的计时器个数(测试读数)。 */
  pendingTimers(): number {
    return [this.typeTimer, this.holdTimer, this.dozeTimer].filter(Boolean).length
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private typeNext(id: number, holdMs: number | undefined): void {
    this.typeTimer = null
    const bubble = this.snap.bubble
    if (!bubble || bubble.id !== id) return
    const typed = bubble.typed + 1
    if (typed < bubble.glyphs.length) {
      this.patch({ bubble: { ...bubble, typed } })
      this.typeTimer = setTimeout(() => this.typeNext(id, holdMs), typeDelayAfter(bubble.glyphs[typed - 1]))
      return
    }
    this.patch({ bubble: { ...bubble, typed: bubble.glyphs.length, done: true } })
    this.setSpeaking(false)
    // 带选项:一直等到选择 / 新话语 / Esc。常驻:一直在。其余:停一会儿收起。
    if (bubble.choices?.length || bubble.sticky) return
    this.holdTimer = setTimeout(() => this.hideIf(id), holdMs ?? SPEAK_HOLD_MS)
  }

  /**
   * 一句本地嘀咕能不能盖掉当前气泡:没有气泡、或是一句普通嘀咕、或是一句已经说完
   * 的开口 —— 可以;带选项 / 常驻的气泡在等人做决定,嘀咕不许把它顶掉(宿主会等不到回调)。
   */
  private canMutterOver(): boolean {
    const bubble = this.snap.bubble
    if (!bubble) return true
    if (bubble.sticky || bubble.choices?.length) return false
    return bubble.mode === 'mutter' || bubble.done
  }

  private mutterGroup(group: ReactionGroup): void {
    const line = this.hooks.line?.(group)
    if (!line) return
    this.say({ mode: 'mutter', text: line.text, holdMs: line.holdMs })
  }

  private hide(): void {
    this.clearTimer('type')
    this.clearTimer('hold')
    if (this.snap.bubble) this.patch({ bubble: null })
    this.setSpeaking(false)
  }

  private hideIf(id: number): void {
    this.holdTimer = null
    if (this.snap.bubble?.id === id) this.hide()
  }

  private armDoze(ms: number): void {
    this.dozeTimer = setTimeout(() => {
      this.dozeTimer = null
      this.patch({ now: this.clock() })
    }, ms)
  }

  private shoot(kind: PetOneShot): void {
    this.pendingShot = kind
    if (this.snap.oneShot !== undefined) this.patch({ oneShot: undefined })
    this.shotFrame.schedule()
  }

  private setSpeaking(speaking: boolean): void {
    if (this.snap.speaking === speaking) return
    this.patch({ speaking })
    this.hooks.onSpeakingChange?.(speaking)
  }

  private clearTimer(which: 'type' | 'hold' | 'doze'): void {
    const key = `${which}Timer` as const
    const timer = this[key]
    if (timer !== null) clearTimeout(timer)
    this[key] = null
  }

  private patch(next: Partial<StageSnapshot>): void {
    this.snap = { ...this.snap, ...next }
    for (const listener of this.listeners) listener()
  }
}
