import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MUSIC_ARM_MOVE_MS,
  MUSIC_FADE_MS,
  MUSIC_NEEDLE_LEAD_MS,
  MUSIC_SPIN_DOWN_MS,
  MUSIC_SPIN_UP_MS,
  MUSIC_STOW_MS,
  MUSIC_SWAP_MS,
} from '../../../components/motion'
import { DeckController, SPIN_DEG_PER_S, SpinLoop } from '../scene-controller'
import type { FrameSource } from '../scene-controller'

/**
 * 两台小机器的判据(§8.2)。控制器脱离 DOM:计时器由假时钟推,快照逐格断言。
 */

const A = { title: '雨棚下 - 旧电扇', present: true, playing: true }
const B = { title: '慢车 - 林间录音', present: true, playing: true }
const NONE = { title: '', present: false, playing: false }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DeckController', () => {
  it('第一份想要 = 挂载:直接摆,不起计时器', () => {
    const deck = new DeckController()
    deck.sync(A)
    expect(deck.getSnapshot()).toMatchObject({ title: A.title, disc: 'on', arm: 'track', lifted: false, spinning: true, busy: false })
    expect(deck.pendingTimers()).toBe(0)
    const paused = new DeckController()
    paused.sync({ ...A, playing: false })
    expect(paused.getSnapshot()).toMatchObject({ disc: 'on', arm: 'track', lifted: true, spinning: false })
    const empty = new DeckController()
    empty.sync(NONE)
    expect(empty.getSnapshot()).toMatchObject({ title: '', disc: 'stowed', arm: 'rest', spinning: false })
  })

  it('暂停:唱臂原地抬起、转盘停,不起计时器;再放:先转,450ms 后落针', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync({ ...A, playing: false })
    expect(deck.getSnapshot()).toMatchObject({ lifted: true, spinning: false, arm: 'track' })
    deck.sync(A)
    expect(deck.getSnapshot()).toMatchObject({ spinning: true, lifted: true })
    vi.advanceTimersByTime(MUSIC_NEEDLE_LEAD_MS)
    expect(deck.getSnapshot()).toMatchObject({ lifted: false, armMotion: 'settle' })
  })

  it('起转还没落针就又暂停:那只计时器作废', () => {
    const deck = new DeckController()
    deck.sync({ ...A, playing: false })
    deck.sync(A)
    expect(deck.pendingTimers()).toBe(1)
    deck.sync({ ...A, playing: false })
    expect(deck.pendingTimers()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(deck.getSnapshot()).toMatchObject({ lifted: true, spinning: false })
  })

  it('换歌那一串:归位 → 收片 → 换封套 → 放片 → 起转落针', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync(B)
    expect(deck.getSnapshot()).toMatchObject({ busy: true, arm: 'rest', lifted: true, armMotion: 'move', spinning: false, title: A.title })
    vi.advanceTimersByTime(MUSIC_ARM_MOVE_MS)
    expect(deck.getSnapshot()).toMatchObject({ disc: 'stowed', lifted: false })
    vi.advanceTimersByTime(MUSIC_STOW_MS)
    expect(deck.getSnapshot()).toMatchObject({ sleeve: 'out', title: A.title })
    vi.advanceTimersByTime(MUSIC_SWAP_MS / 2)
    expect(deck.getSnapshot()).toMatchObject({ sleeve: 'in', title: B.title, disc: 'stowed' })
    vi.advanceTimersByTime(MUSIC_SWAP_MS / 2)
    expect(deck.getSnapshot()).toMatchObject({ disc: 'on', busy: true })
    vi.advanceTimersByTime(MUSIC_STOW_MS)
    expect(deck.getSnapshot()).toMatchObject({ busy: false, spinning: true, arm: 'rest' })
    vi.advanceTimersByTime(MUSIC_NEEDLE_LEAD_MS)
    expect(deck.getSnapshot()).toMatchObject({ arm: 'track', lifted: true, armMotion: 'move' })
    vi.advanceTimersByTime(MUSIC_ARM_MOVE_MS)
    expect(deck.getSnapshot()).toMatchObject({ arm: 'track', lifted: false })
    expect(deck.pendingTimers()).toBe(0)
  })

  it('一串跑着时又换了一首:封套直接换成最新那首,不补播中间那首', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync(B)
    vi.advanceTimersByTime(100)
    deck.sync({ ...B, title: '潮汐表 - 北岸电台' })
    vi.advanceTimersByTime(MUSIC_ARM_MOVE_MS + MUSIC_STOW_MS + MUSIC_SWAP_MS)
    expect(deck.getSnapshot().title).toBe('潮汐表 - 北岸电台')
    vi.advanceTimersByTime(10_000)
    expect(deck.getSnapshot()).toMatchObject({ busy: false, title: '潮汐表 - 北岸电台', disc: 'on' })
  })

  it('有歌 → 无歌:收片、封套变素面;无歌 → 有歌:放片', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync(NONE)
    vi.advanceTimersByTime(10_000)
    expect(deck.getSnapshot()).toMatchObject({ title: '', disc: 'stowed', arm: 'rest', busy: false, spinning: false })
    deck.sync({ ...B, playing: false })
    expect(deck.getSnapshot()).toMatchObject({ busy: true, sleeve: 'out' })
    vi.advanceTimersByTime(10_000)
    expect(deck.getSnapshot()).toMatchObject({ title: B.title, disc: 'on', arm: 'track', lifted: true, busy: false })
  })

  it('隐藏时:在飞的那一串作废直接摆;藏着期间的变化只摆不演', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync(B)
    deck.setSuspended(true)
    expect(deck.pendingTimers()).toBe(0)
    expect(deck.getSnapshot()).toMatchObject({ title: B.title, disc: 'on', busy: false, spinning: true })
    deck.sync({ ...B, title: '潮汐表 - 北岸电台' })
    expect(deck.pendingTimers()).toBe(0)
    expect(deck.getSnapshot().title).toBe('潮汐表 - 北岸电台')
  })

  it('减弱动态效果:换歌只淡出淡入', () => {
    const deck = new DeckController({ reducedMotion: () => true })
    deck.sync(A)
    deck.sync(B)
    expect(deck.getSnapshot()).toMatchObject({ busy: true, fading: true, title: A.title })
    vi.advanceTimersByTime(MUSIC_FADE_MS)
    expect(deck.getSnapshot()).toMatchObject({ busy: true, fading: false, title: B.title, disc: 'on', spinning: true })
    vi.advanceTimersByTime(MUSIC_FADE_MS)
    expect(deck.getSnapshot()).toMatchObject({ busy: false })
    expect(deck.pendingTimers()).toBe(0)
  })

  it('dispose 清全部计时器;跑到一半被拆,落到「想要的」而不是挂着 busy', () => {
    const deck = new DeckController()
    deck.sync(A)
    deck.sync(B)
    expect(deck.pendingTimers()).toBeGreaterThan(0)
    deck.dispose()
    expect(deck.pendingTimers()).toBe(0)
    expect(deck.getSnapshot()).toMatchObject({ busy: false, title: B.title })
  })
})

describe('SpinLoop:惯性', () => {
  function crank() {
    const queue = new Map<number, (now: number) => void>()
    let seq = 0
    const frames: FrameSource = {
      request: (cb) => {
        seq += 1
        queue.set(seq, cb)
        return seq
      },
      cancel: (id) => void queue.delete(id),
    }
    let now = 0
    const tick = (ms: number) => {
      now += ms
      const due = [...queue.entries()]
      queue.clear()
      for (const [, cb] of due) cb(now)
    }
    return { frames, tick, pending: () => queue.size }
  }

  it('0.9s 起到满速,1.6s 靠惯性停下,停下之后不再排帧', () => {
    const { frames, tick, pending } = crank()
    const el = document.createElement('div')
    const spin = new SpinLoop(frames)
    spin.attach([el])
    spin.set(true)
    tick(0)
    for (let t = 0; t < MUSIC_SPIN_UP_MS / 2; t += 16) tick(16)
    expect(spin.speed()).toBeGreaterThan(0)
    expect(spin.speed()).toBeLessThan(SPIN_DEG_PER_S)
    for (let t = 0; t < MUSIC_SPIN_UP_MS; t += 16) tick(16)
    expect(spin.speed()).toBe(SPIN_DEG_PER_S)
    expect(el.style.transform).toMatch(/^rotate\(/)

    spin.set(false)
    for (let t = 0; t < MUSIC_SPIN_DOWN_MS / 2; t += 16) tick(16)
    expect(spin.speed()).toBeGreaterThan(0)
    for (let t = 0; t < MUSIC_SPIN_DOWN_MS; t += 16) tick(16)
    expect(spin.speed()).toBe(0)
    expect(pending()).toBe(0)
  })

  it('直接摆:速度当场到位;隐藏停帧,恢复按该不该转直接摆', () => {
    const { frames, pending } = crank()
    const spin = new SpinLoop(frames)
    spin.set(true, true)
    expect(spin.speed()).toBe(SPIN_DEG_PER_S)
    expect(pending()).toBe(1)
    spin.setSuspended(true)
    expect(pending()).toBe(0)
    spin.set(false)
    spin.setSuspended(false)
    expect(spin.speed()).toBe(0)
    expect(pending()).toBe(0)
  })

  it('没有帧源:只摆不转,也不抛', () => {
    const spin = new SpinLoop(null)
    spin.set(true)
    expect(spin.running()).toBe(false)
    spin.dispose()
  })
})
