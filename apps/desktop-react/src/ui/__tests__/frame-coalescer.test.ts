import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameCoalescer } from '../frame-coalescer'

/**
 * `ui/frame-coalescer` 的三格规格(09-10 立法,病历见它自己的文件头)。
 * 这只件唯一的职责是「把观察器量到的东西挪出派发循环」,所以测的也只有三件:
 * 一帧只排一次、撤得掉、没有 rAF 的宿主里降级成同步。
 */
describe('FrameCoalescer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('一帧内多次 schedule 只跑一次 run', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    const run = vi.fn()
    const c = new FrameCoalescer(run)
    c.schedule()
    c.schedule()
    c.schedule()
    expect(frames).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()
    frames[0](0)
    expect(run).toHaveBeenCalledTimes(1)
    // 那一帧过去之后再排,是新的一帧。
    c.schedule()
    expect(frames).toHaveLength(2)
  })

  it('cancel 撤掉待发那一帧:run 一次都不跑', () => {
    const frames: FrameRequestCallback[] = []
    const cancelled: number[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id))
    const run = vi.fn()
    const c = new FrameCoalescer(run)
    c.schedule()
    c.cancel()
    expect(cancelled).toEqual([1])
    expect(run).not.toHaveBeenCalled()
    // 撤过之后还能再排(闩已归零),不是一次性的。
    c.schedule()
    expect(frames).toHaveLength(2)
  })

  it('宿主没有 requestAnimationFrame → schedule 当场同步跑(降级)', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const run = vi.fn()
    const c = new FrameCoalescer(run)
    c.schedule()
    expect(run).toHaveBeenCalledTimes(1)
    c.schedule()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
