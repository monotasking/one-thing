/**
 * 草稿纸的**推送设置**:开不开自动推送、什么时机推、停笔等多久。
 *
 * ## 为什么是 localStorage 而不是 settings
 * 与 `todo-panel-mode.ts` 同一条判据:这是"我这扇窗现在想怎么用"的当下偏好,
 * 不是账户级配置,也不该跟着会话走。容错风格照抄那份文件 —— 存不下不是错误,
 * 认不出的值一律回到缺省。
 *
 * ## 这个文件只装**纯逻辑**
 * 状态文案(`describeScratchpadPushStatus`)与倒计时器(`createScratchpadPushScheduler`)
 * 都不碰 Vue、不碰 DOM:它们是这件事里唯二会算错的地方,所以摘出来单独钉测试
 * (`__tests__/scratchpad-push.test.ts`)。宿主只负责接线。
 */

export type ScratchpadPushTiming = 'anytime' | 'while-replying'

export interface ScratchpadPushPrefs {
  /** 自动推送总开关。关掉时下面两项只是灰着的记忆,不参与判断。 */
  auto: boolean
  timing: ScratchpadPushTiming
  /** 「随时」档的停笔等待秒数;只取 `SCRATCHPAD_PUSH_WAIT_OPTIONS` 里的值。 */
  waitSeconds: number
}

export const SCRATCHPAD_PUSH_TIMINGS: readonly ScratchpadPushTiming[] = ['anytime', 'while-replying']

export const SCRATCHPAD_PUSH_WAIT_OPTIONS: readonly number[] = [2, 5, 10, 30]

/**
 * 缺省**关着**。自动把用户没说要发的话发给模型是一件有后果的事,得由人明确
 * 打开一次 —— 缺省开等于替用户做了这个决定。
 */
export const DEFAULT_SCRATCHPAD_PUSH_PREFS: ScratchpadPushPrefs = {
  auto: false,
  timing: 'anytime',
  waitSeconds: 5,
}

export function normalizeScratchpadPushTiming(raw: unknown): ScratchpadPushTiming {
  return raw === 'while-replying' ? 'while-replying' : 'anytime'
}

export function normalizeScratchpadPushWaitSeconds(raw: unknown): number {
  const value = Number(raw)
  return SCRATCHPAD_PUSH_WAIT_OPTIONS.includes(value)
    ? value
    : DEFAULT_SCRATCHPAD_PUSH_PREFS.waitSeconds
}

export function normalizeScratchpadPushPrefs(raw: unknown): ScratchpadPushPrefs {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScratchpadPushPrefs>
  return {
    auto: source.auto === true,
    timing: normalizeScratchpadPushTiming(source.timing),
    waitSeconds: normalizeScratchpadPushWaitSeconds(source.waitSeconds),
  }
}

/** 与 TodoPlanPanel 的 `storagePrefix` 同源:独立窗与内嵌卡片各记各的。 */
export function scratchpadPushStorageKey(storagePrefix: string): string {
  return `${storagePrefix}ScratchpadPush`
}

/**
 * localStorage 在测试 / 无浏览器环境可能缺席。判据卡在**方法在不在**而不是
 * "全局有没有"(Node 22 起 globalThis 上有一个方法全 undefined 的空壳)。
 */
function safeStorage(): Storage | null {
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    return typeof storage?.getItem === 'function' ? storage : null
  } catch {
    return null
  }
}

export function readScratchpadPushPrefs(storageKey: string): ScratchpadPushPrefs {
  const raw = safeStorage()?.getItem(storageKey)
  if (!raw) return { ...DEFAULT_SCRATCHPAD_PUSH_PREFS }
  try {
    return normalizeScratchpadPushPrefs(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SCRATCHPAD_PUSH_PREFS }
  }
}

export function writeScratchpadPushPrefs(storageKey: string, prefs: ScratchpadPushPrefs): void {
  try {
    safeStorage()?.setItem(storageKey, JSON.stringify(normalizeScratchpadPushPrefs(prefs)))
  } catch {
    // 存不下不是错误,只是不持久。
  }
}

export interface ScratchpadPushStatusInput {
  auto: boolean
  timing: ScratchpadPushTiming
  waitSeconds: number
  /** 水位之后还有没有没发过的内容。 */
  hasPending: boolean
  /** 倒计时中的剩余秒数;`null` = 没在倒计时。 */
  countdownSeconds: number | null
  /** 这一刻 AI 是不是正在回复(宿主查得到才有意义,见 `replyingKnown`)。 */
  replying: boolean
  /** 宿主能不能查到"正在回复"。查不到时「仅回复中」是禁用的,这里也得说实话。 */
  replyingKnown: boolean
  /** 刚发出去多少字;`null` = 不在"刚发完"的短暂窗口里。 */
  justSentChars: number | null
}

/**
 * 状态行的**唯一**出处。
 *
 * 一条纪律:这句话只描述**已经成立的事实或已经排好的动作**,不预测。所以
 * 「停笔 N 秒后推送」只在真的有待推送内容时说 —— 没有内容时说它就是在承诺
 * 一件不会发生的事。
 */
export function describeScratchpadPushStatus(input: ScratchpadPushStatusInput): string {
  if (input.justSentChars !== null) return `已推送选中的 ${input.justSentChars} 字`
  if (!input.auto) return '手动推送'
  if (input.timing === 'while-replying') {
    if (!input.replyingKnown) return '无法判断回复状态'
    if (!input.hasPending) return '没有待推送的内容'
    return input.replying ? '正在随本轮回复推送' : 'AI 回复时一并推送'
  }
  if (input.countdownSeconds !== null) return `还有 ${input.countdownSeconds} 秒后推送`
  if (!input.hasPending) return '没有待推送的内容'
  return `停笔 ${input.waitSeconds} 秒后推送`
}

export interface ScratchpadPushSchedulerOptions {
  onFire: () => void
  /** 每一跳的剩余秒数(含 arm 当下那一跳);`null` = 已解除。 */
  onTick?: (remaining: number | null) => void
  /** 只为测试留的注入口;缺省就是真的一秒。 */
  tickMs?: number
}

export interface ScratchpadPushScheduler {
  arm(seconds: number): void
  disarm(): void
  readonly remaining: number | null
  dispose(): void
}

/**
 * 停笔倒计时器 —— 一秒一跳,跳到 0 就发。
 *
 * 为什么一秒一跳而不是一发 `setTimeout`:状态行要把倒计时**给人看**(用户得
 * 来得及后悔),而"还有几秒"只有逐跳才拿得到。重新 `arm` 就是重新计时,
 * 这正是"停笔多久"的含义。
 */
export function createScratchpadPushScheduler(
  options: ScratchpadPushSchedulerOptions,
): ScratchpadPushScheduler {
  const tickMs = options.tickMs ?? 1000
  let timer: ReturnType<typeof setInterval> | null = null
  let remaining: number | null = null
  let disposed = false

  function stop(notify: boolean) {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    const had = remaining !== null
    remaining = null
    if (notify && had) options.onTick?.(null)
  }

  return {
    arm(seconds: number) {
      if (disposed) return
      const total = Math.max(1, Math.round(seconds))
      stop(false)
      remaining = total
      options.onTick?.(remaining)
      timer = setInterval(() => {
        if (remaining === null) return
        remaining -= 1
        if (remaining > 0) {
          options.onTick?.(remaining)
          return
        }
        stop(true)
        options.onFire()
      }, tickMs)
    },
    disarm() {
      stop(true)
    },
    get remaining() {
      return remaining
    },
    dispose() {
      disposed = true
      stop(false)
    },
  }
}
