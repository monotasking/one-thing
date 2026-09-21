import { describe, expect, it } from 'vitest'
import { FakeScrollPort } from '../scroll-port'
import { FakeFrames, Slide } from '../slide'

/**
 * `Slide` 逐帧反证(G 线 P2-a)。**一格 DOM 都不碰** —— 喂一只 `FakeScrollPort`
 * 与一只手推的 `FakeFrames` 就跑得起来,这正是抽件买到的那件东西:
 * 从前这一段插值只能靠真机门(`gate:send-flow` ① 的「滚动段数」)间接量。
 */

function setup(options?: { ms?: number; available?: boolean; scrollTop?: number }) {
  const port = new FakeScrollPort({ scrollTop: options?.scrollTop ?? 0, scrollHeight: 1000, clientHeight: 300 })
  const frames = new FakeFrames()
  if (options?.available === false) frames.available = false
  const settles: number[] = []
  const slide = new Slide(port, {
    durationOf: () => options?.ms ?? 100,
    onSettle: () => void settles.push(port.top),
    frames,
  })
  return { port, frames, slide, settles }
}

describe('一步到位那两支', () => {
  it('时长答 0(动效档「无」)= 一次写、当场落定、不排帧', () => {
    const { port, frames, slide, settles } = setup({ ms: 0 })
    slide.to(400)
    expect(port.writes).toEqual([{ top: 400, cause: 'send-landing' }])
    expect(frames.pending).toBe(0)
    expect(slide.running).toBe(false)
    expect(settles).toEqual([400])
  })

  it('距离不足 1px 也一步到位(不为半像素排一串帧)', () => {
    const { port, frames, slide } = setup({ scrollTop: 400 })
    slide.to(400.4)
    expect(port.writes).toHaveLength(1)
    expect(frames.pending).toBe(0)
  })

  it('宿主没有 rAF(jsdom / 离屏窗口):同样一步到位', () => {
    const { port, frames, slide, settles } = setup({ available: false })
    slide.to(400)
    expect(port.writes).toEqual([{ top: 400, cause: 'send-landing' }])
    expect(frames.pending).toBe(0)
    expect(settles).toEqual([400])
  })
})

describe('插值那一段', () => {
  it('每一帧单调朝目标走,最后一帧落在目标上并落定一次', () => {
    const { port, frames, slide, settles } = setup({ ms: 100 })
    slide.to(400)
    expect(slide.running).toBe(true)
    const seen: number[] = []
    for (let i = 0; i < 6 && frames.pending > 0; i += 1) {
      frames.tick(20)
      seen.push(port.top)
    }
    // 单调不反向(缓出三次曲线,判词在 `Slide.to`)。
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(port.top).toBe(400)
    expect(slide.running).toBe(false)
    expect(settles).toEqual([400])
  })

  it('每一帧都经 `setTop`,所以 `lastTop` 逐帧跟着走(不然下一发滚动被读成「人往上翻」)', () => {
    const { port, frames, slide } = setup({ ms: 100 })
    slide.to(400)
    frames.tick(20)
    expect(port.lastTop).toBe(port.top)
    frames.tick(20)
    expect(port.lastTop).toBe(port.top)
  })

  it('第二只手:上一帧写下去的那个数不在了 = 人自己滚了,当场收手', () => {
    const { port, frames, slide } = setup({ ms: 200 })
    slide.to(600)
    frames.tick(20)
    const wroteFrames = port.writes.length
    // 人插一手:位置不是我们上一帧写下去的那个数。
    port.scrollTo(port.top - 50)
    frames.tick(20)
    expect(port.writes).toHaveLength(wroteFrames)
    expect(slide.running).toBe(false)
    expect(frames.pending).toBe(0)
  })

  it('`cancel()` 撤掉在飞的那一帧,三格状态一起归零', () => {
    const { frames, slide, port } = setup({ ms: 200 })
    slide.to(600)
    frames.tick(20)
    slide.cancel()
    expect(slide.running).toBe(false)
    expect(frames.pending).toBe(0)
    const before = port.writes.length
    frames.tick(200)
    expect(port.writes).toHaveLength(before)
  })

  it('停靠中(`clientHeight === 0`)整段插值一个字都写不出去', () => {
    const port = new FakeScrollPort({ clientHeight: 0, scrollTop: 42 })
    const frames = new FakeFrames()
    const slide = new Slide(port, { durationOf: () => 0, onSettle: () => undefined, frames })
    slide.to(400)
    expect(port.writes).toEqual([])
    expect(port.geometry.scrollTop).toBe(42)
  })
})
