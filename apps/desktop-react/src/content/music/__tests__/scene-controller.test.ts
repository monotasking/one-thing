import { describe, expect, it } from 'vitest'
import { MUSIC_SPIN_DOWN_MS, MUSIC_SPIN_UP_MS } from '../../../components/motion'
import { SPIN_DEG_PER_S, SpinLoop } from '../scene-controller'
import type { FrameSource } from '../scene-controller'

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

describe('SpinLoop:把每一帧的角度交出去(音乐面 v8 的淡反光)', () => {
  it('转的时候每帧报角度;停住之后不再报', () => {
    let pending: ((now: number) => void) | null = null
    let now = 0
    const frames: FrameSource = {
      request: (cb) => {
        pending = cb
        return 1
      },
      cancel: () => {
        pending = null
      },
    }
    const seen: number[] = []
    const loop = new SpinLoop(frames, (deg) => seen.push(deg))
    loop.set(true, true)
    for (let i = 0; i < 5; i++) {
      now += 16
      const cb = pending as ((t: number) => void) | null
      pending = null
      cb?.(now)
    }
    expect(seen.length).toBeGreaterThanOrEqual(5)
    expect(new Set(seen.map((d) => d.toFixed(2))).size).toBeGreaterThan(1)
    loop.set(false, true)
    const before = seen.length
    const cb = pending as ((t: number) => void) | null
    pending = null
    cb?.(now + 16)
    expect(pending).toBeNull()
    expect(seen.length - before).toBeLessThanOrEqual(1)
    loop.dispose()
  })
})
