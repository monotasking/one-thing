import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createScratchpadPushScheduler,
  DEFAULT_SCRATCHPAD_PUSH_PREFS,
  describeScratchpadPushStatus,
  normalizeScratchpadPushPrefs,
  readScratchpadPushPrefs,
  scratchpadPushStorageKey,
  writeScratchpadPushPrefs,
  type ScratchpadPushStatusInput,
} from '../scratchpad-push'

function status(patch: Partial<ScratchpadPushStatusInput> = {}): string {
  return describeScratchpadPushStatus({
    auto: true,
    timing: 'anytime',
    waitSeconds: 5,
    hasPending: true,
    countdownSeconds: null,
    replying: false,
    replyingKnown: true,
    justSentChars: null,
    ...patch,
  })
}

describe('推送偏好 · 认不出来的一律回缺省', () => {
  it('缺省是关着的 —— 自动把没说要发的话发出去,得由人明确开一次', () => {
    expect(DEFAULT_SCRATCHPAD_PUSH_PREFS.auto).toBe(false)
    expect(normalizeScratchpadPushPrefs(undefined)).toEqual(DEFAULT_SCRATCHPAD_PUSH_PREFS)
    expect(normalizeScratchpadPushPrefs('nonsense')).toEqual(DEFAULT_SCRATCHPAD_PUSH_PREFS)
  })

  it('半个对象只修坏的那一半,好的那一半留着', () => {
    expect(normalizeScratchpadPushPrefs({ auto: true, timing: 'later', waitSeconds: 7 })).toEqual({
      auto: true,
      timing: 'anytime',
      waitSeconds: 5,
    })
  })

  it('只认档位里的等待时长 —— "3.5 秒"这种值不许存进来', () => {
    expect(normalizeScratchpadPushPrefs({ waitSeconds: 30 }).waitSeconds).toBe(30)
    expect(normalizeScratchpadPushPrefs({ waitSeconds: 3.5 }).waitSeconds).toBe(5)
  })

  it('独立窗与内嵌卡片各记各的', () => {
    expect(scratchpadPushStorageKey('todoPlanWindow')).toBe('todoPlanWindowScratchpadPush')
    expect(scratchpadPushStorageKey('todoPlanCard')).toBe('todoPlanCardScratchpadPush')
  })
})

describe('推送偏好 · 存取', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { store = {} },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('写进去读回来', () => {
    writeScratchpadPushPrefs('k', { auto: true, timing: 'while-replying', waitSeconds: 10 })
    expect(readScratchpadPushPrefs('k')).toEqual({
      auto: true,
      timing: 'while-replying',
      waitSeconds: 10,
    })
  })

  it('存了一坨坏 JSON —— 回缺省,不是抛', () => {
    store.k = '{ 这不是 json'
    expect(readScratchpadPushPrefs('k')).toEqual(DEFAULT_SCRATCHPAD_PUSH_PREFS)
  })

  it('没有 localStorage 的环境里读写都不炸', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => writeScratchpadPushPrefs('k', DEFAULT_SCRATCHPAD_PUSH_PREFS)).not.toThrow()
    expect(readScratchpadPushPrefs('k')).toEqual(DEFAULT_SCRATCHPAD_PUSH_PREFS)
  })
})

describe('推送状态行 · 只说已经成立的事', () => {
  it('刚发完压过一切 —— 那是这一刻最要紧的事实', () => {
    expect(status({ justSentChars: 42, auto: false })).toBe('已推送选中的 42 字')
  })

  it('关着就是关着', () => {
    expect(status({ auto: false })).toBe('手动推送')
  })

  it('没有待推送的内容时不承诺"停笔 N 秒后推送"', () => {
    expect(status({ hasPending: false })).toBe('没有待推送的内容')
    expect(status({ hasPending: false, timing: 'while-replying' })).toBe('没有待推送的内容')
  })

  it('倒计时中报剩余秒数,平时报档位', () => {
    expect(status()).toBe('停笔 5 秒后推送')
    expect(status({ countdownSeconds: 3 })).toBe('还有 3 秒后推送')
  })

  it('「仅回复中」:等的时候和正在推的时候不是同一句话', () => {
    expect(status({ timing: 'while-replying' })).toBe('AI 回复时一并推送')
    expect(status({ timing: 'while-replying', replying: true })).toBe('正在随本轮回复推送')
  })

  it('宿主查不到回复状态就直说,不假装在等', () => {
    expect(status({ timing: 'while-replying', replyingKnown: false })).toBe('无法判断回复状态')
  })
})

describe('停笔倒计时器', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('一秒一跳,跳到 0 才发', () => {
    const onFire = vi.fn()
    const ticks: Array<number | null> = []
    const scheduler = createScratchpadPushScheduler({ onFire, onTick: t => ticks.push(t) })

    scheduler.arm(3)
    expect(ticks).toEqual([3])

    vi.advanceTimersByTime(2000)
    expect(ticks).toEqual([3, 2, 1])
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(onFire).toHaveBeenCalledTimes(1)
    expect(ticks.at(-1)).toBeNull()
    expect(scheduler.remaining).toBeNull()

    // 发完就停:不许自己接着跑第二轮。
    vi.advanceTimersByTime(5000)
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('重新 arm = 重新计时 —— 这正是"停笔多久"的含义', () => {
    const onFire = vi.fn()
    const scheduler = createScratchpadPushScheduler({ onFire })

    scheduler.arm(3)
    vi.advanceTimersByTime(2000)
    expect(scheduler.remaining).toBe(1)

    scheduler.arm(3)
    expect(scheduler.remaining).toBe(3)
    vi.advanceTimersByTime(2000)
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('解除之后不再发,并且回一次 null 让状态行归位', () => {
    const onFire = vi.fn()
    const ticks: Array<number | null> = []
    const scheduler = createScratchpadPushScheduler({ onFire, onTick: t => ticks.push(t) })

    scheduler.arm(2)
    scheduler.disarm()
    expect(ticks.at(-1)).toBeNull()

    vi.advanceTimersByTime(10_000)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('dispose 之后 arm 是空操作 —— 卸载后的组件不该还能发消息', () => {
    const onFire = vi.fn()
    const scheduler = createScratchpadPushScheduler({ onFire })

    scheduler.dispose()
    scheduler.arm(1)
    vi.advanceTimersByTime(5000)
    expect(onFire).not.toHaveBeenCalled()
  })
})
