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

/**
 * ── 第二个量:**此刻还需要为「已吸收的回缩」垫多高**(G 线 P2-b,§13.6 第 1 条)──
 *
 * 式子 `needed = 已写的高 − gap`,申请那一刻按 `+ shrinkPx` 投影,夹进
 * `[0, clientHeight]`,之后只减不增。下面每一条转移各一格。
 */
describe('吸收回缩:两个量,一个写口', () => {
  /** 一屏 300、内容 1000、停在底(gap = 0)。 */
  function atBottom() {
    const port = new FakeScrollPort({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 })
    return { port, pad: new TailPad(port) }
  }

  it('贴底收起 400px:垫块正好补上 400,页面总高因此不变', () => {
    const { port, pad } = atBottom()
    expect(pad.requestAbsorb(400)).toBe(300)
    // 夹在一屏:要的是 400,给得出的只有 300(判词在文件头)。
    expect(pad.absorbed).toBe(300)
    expect(port.padHeights).toEqual([300])
  })

  it('一屏放得下时一格不夹:收起 120px → 垫 120px', () => {
    const { port, pad } = atBottom()
    expect(pad.requestAbsorb(120)).toBe(120)
    expect(pad.height).toBe(120)
    expect(port.padHeights).toEqual([120])
  })

  it('人在上面翻着(gap 够大)→ 一格都不垫:那一下本来就不会钳', () => {
    const port = new FakeScrollPort({ scrollHeight: 5000, clientHeight: 300, scrollTop: 0 })
    const pad = new TailPad(port)
    expect(pad.requestAbsorb(400)).toBe(0)
    expect(pad.absorbed).toBe(0)
    expect(port.padHeights).toEqual([])
  })

  it('停靠中(`clientHeight === 0`)量不到几何 → 答 0、一格不改', () => {
    const port = new FakeScrollPort({ clientHeight: 0 })
    const pad = new TailPad(port)
    expect(pad.requestAbsorb(400)).toBe(0)
    expect(pad.absorbed).toBe(0)
  })

  it('人往上滚:`relax` 按「此刻还需要多少」往下收,缩的是视口下方那一截', () => {
    const { pad } = atBottom()
    pad.requestAbsorb(120)
    expect(pad.absorbed).toBe(120)
    // 往上滚 50 → gap 变成 50 → 需要的少 50。
    pad.relax(50)
    expect(pad.absorbed).toBe(70)
    // 再往上滚过头 → 收到 0 为止,不会变成负数。
    pad.relax(500)
    expect(pad.absorbed).toBe(0)
  })

  it('**只减不增**:gap 又变回 0 也不会自己长回去', () => {
    const { pad } = atBottom()
    pad.requestAbsorb(120)
    pad.relax(50)
    pad.relax(0)
    expect(pad.absorbed).toBe(70)
  })

  it('内容又长出来先吃垫块 —— 与人往上滚同一句(gap 变大)', () => {
    const { pad } = atBottom()
    pad.requestAbsorb(120)
    // 流式又长了 30px:gap 变大 30 → 垫块缩 30,`scrollHeight` 一格不变。
    pad.relax(30)
    expect(pad.absorbed).toBe(90)
  })

  it('下一次发送归零(排一帧写,不当场写)', () => {
    const { port, pad } = atBottom()
    pad.requestAbsorb(120)
    expect(port.padHeights).toEqual([120])
    pad.releaseAbsorbed()
    expect(pad.absorbed).toBe(0)
    // 排的那一帧还没跑,style 上仍是 120;跑了才写 0。
    expect(port.padHeights).toEqual([120])
    pad.flushNow()
    expect(port.padHeights).toEqual([120, 0])
  })

  /**
   * **座位在场时照样按同一条式子算,不是「座位够高就不必垫」**。
   *
   * 座位的定义是几何算出来的(`viewport − sendLine − tailHeight − reserveBelow`),
   * 内容缩一截它自己也会长一截 —— 可那是**下一批 RO** 的事,而钳位就发生在这一帧。
   * 所以这一刻照垫,下一帧座位自己算到同一个数,两个量对上,`flushNow` 那格同值
   * 短路让 style 只写一次。
   */
  it('座位在场:申请照样按同一条式子算(座位下一帧才长回来,钳位在这一帧)', () => {
    const port = new FakeScrollPort({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 })
    port.seat = GEOMETRY
    const pad = new TailPad(port)
    pad.active = true
    pad.landed = true
    const seat = pad.measure()
    pad.flushNow()
    expect(port.padHeights).toEqual([seat])
    pad.requestAbsorb(10)
    expect(pad.height).toBe(seat + 10)
    expect(port.padHeights).toEqual([seat, seat + 10])
    // 同值短路:再 flush 一次不写第二遍。
    pad.flushNow()
    expect(port.padHeights).toEqual([seat, seat + 10])
  })

  it('换会话 / 座位退役:两个量一起归零', () => {
    const { pad } = atBottom()
    pad.requestAbsorb(120)
    pad.retire()
    expect(pad.absorbed).toBe(0)
    expect(pad.height).toBe(0)
  })
})
