import { describe, expect, it } from 'vitest'
import { FakeScrollPort } from '../scroll-port'
import { TailPad } from '../tail-pad'
import type { SeatGeometry } from '../../seat'

/**
 * `TailPad` 的三道闸与那格同值短路(G 线 P2-a)。零 DOM:量与写都经
 * `FakeScrollPort`,所以「座位该多高」这件事第一次可以不靠 jsdom 几何测到。
 */

/** 一屏 800、置顶线 24、留白 120、一行 22.4 —— 与真机常规档同量级。 */
const GEOMETRY: SeatGeometry = {
  viewportHeight: 800,
  sendLine: 24,
  reserveBelow: 120,
  userHeight: 60,
  tailHeight: 60,
  lineHeight: 22.4,
}

function setup() {
  const port = new FakeScrollPort()
  port.seat = GEOMETRY
  const pad = new TailPad(port)
  return { port, pad }
}

describe('三道闸:没有座位就恒 0(退化为今天的落底 + 跟随)', () => {
  it('这条会话没发过话(`active` 假)→ 0,而且一次几何都不量', () => {
    const { port, pad } = setup()
    let asked = 0
    port.measureSeat = () => {
      asked += 1
      return GEOMETRY
    }
    pad.landed = true
    expect(pad.measure()).toBe(0)
    expect(asked).toBe(0)
  })

  it('发过话但没落位(`landed` 假)→ 0', () => {
    const { pad } = setup()
    pad.active = true
    expect(pad.measure()).toBe(0)
  })

  it('两格都真但量不到几何 → 0', () => {
    const { port, pad } = setup()
    port.seat = undefined
    pad.active = true
    pad.landed = true
    expect(pad.measure()).toBe(0)
  })

  it('两格都真且量得到 → 六行起手(判词在 `seat.ts` 的 `SEAT_LINES`)', () => {
    const { pad } = setup()
    pad.active = true
    pad.landed = true
    expect(pad.measure()).toBeCloseTo(22.4 * 6, 5)
  })
})

describe('量在这一帧、写在下一帧', () => {
  it('`measure()` 自己不写垫块', () => {
    const { port, pad } = setup()
    pad.active = true
    pad.landed = true
    pad.measure()
    expect(port.padHeights).toEqual([])
  })

  it('`flushNow()` 写一次,同值再调不重复写(那格短路)', () => {
    const { port, pad } = setup()
    pad.active = true
    pad.landed = true
    pad.measure()
    pad.flushNow()
    pad.flushNow()
    expect(port.padHeights).toEqual([22.4 * 6])
    expect(pad.written).toBeCloseTo(22.4 * 6, 5)
  })

  it('没有垫块那个元素时**不记账** —— 下次它挂上来那一写不该被短路掉', () => {
    const { port, pad } = setup()
    port.padHeights = undefined
    pad.active = true
    pad.landed = true
    pad.measure()
    pad.flushNow()
    expect(pad.written).toBeUndefined()
    port.padHeights = []
    pad.flushNow()
    expect(port.padHeights).toEqual([22.4 * 6])
  })
})

describe('退役与卸载', () => {
  it('`retire()` 把四格归零 —— 下一条会话的第一次写不会被上一棵树的数短路', () => {
    const { port, pad } = setup()
    pad.active = true
    pad.landed = true
    pad.measure()
    pad.flushNow()
    pad.retire()
    expect(pad.written).toBeUndefined()
    expect(pad.height).toBe(0)
    expect(pad.landed).toBe(false)
    pad.flushNow()
    expect(port.padHeights).toEqual([22.4 * 6, 0])
  })

  it('`height` 今天就是座位那一半(`#absorbed` 是 P2-b 的空位,恒 0)', () => {
    const { pad } = setup()
    pad.active = true
    pad.landed = true
    const seat = pad.measure()
    expect(pad.height).toBe(seat)
  })
})
