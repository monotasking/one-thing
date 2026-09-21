import { describe, expect, it } from 'vitest'
import { ViewportAnchor } from '../anchor'
import { FakeScrollPort, type AnchoredElement, type ResizeBatch } from '../scroll-port'
import { FakeFrames } from '../slide'
import { FakeTimers } from '../anchor-recorder'
import type { FollowState } from '../../follow'
import type { ScrollAnchor } from '../../../data/session-view-state'
import type { SeatGeometry } from '../../seat'

/**
 * **裁决表逐格**(G 线 P2-a,正本 §13.2.1 末那句「裁决逻辑一行 DOM 都不碰,
 * 所以 vitest 里喂一只 `FakeScrollPort`(纯数字)就能把它逐格测到,不必靠
 * jsdom 几何」)。
 *
 * 这组用例是那句话的兑现:整只文件**一次 `render()` 都没有**,也没有一个
 * `document`。今天 `fold-anchor` / `expand-hold` 那几组是靠篡改 `clientHeight`
 * 的 property descriptor 撑起来的 —— 它们守的是代码路径,这一组守的是**判据**。
 */

const SEAT: SeatGeometry = {
  viewportHeight: 800,
  sendLine: 24,
  reserveBelow: 120,
  userHeight: 60,
  tailHeight: 60,
  lineHeight: 22.4,
}

function setup(options?: { geometry?: Partial<ConstructorParameters<typeof FakeScrollPort>[0]> }) {
  const port = new FakeScrollPort({ scrollHeight: 1000, clientHeight: 300, scrollTop: 0, ...options?.geometry })
  const frames = new FakeFrames()
  const timers = new FakeTimers()
  const follows: FollowState[] = []
  const saved: { sessionId: string; anchor: ScrollAnchor | undefined }[] = []
  const state = { now: 1000, anchor: undefined as ScrollAnchor | undefined }
  const anchor = new ViewportAnchor(port, {
    onFollowChange: (next) => void follows.push(next),
    expandHoldMs: 220,
    foldSlackMs: 40,
    slideDurationOf: () => 0,
    now: () => state.now,
    frames,
    timers,
    readAnchor: () => state.anchor,
    saveAnchor: (sessionId, a) => void saved.push({ sessionId, anchor: a }),
    settleMs: 120,
  })
  return { port, anchor, follows, saved, state, frames, timers }
}

/** 一批「内容列长到 h」的尺寸变化。 */
const grew = (h: number): ResizeBatch => ({ containerChanged: false, columnHeights: [h] })
/** 一批「容器自己变了」。 */
const container: ResizeBatch = { containerChanged: true, columnHeights: [] }

function fakeAnchorEl(tops: number[]): AnchoredElement {
  let i = 0
  return { alive: () => true, top: () => tops[Math.min(i++, tops.length - 1)] }
}

describe('进场', () => {
  it('pinned + 树上有东西 → 落底一次', () => {
    const { port, anchor } = setup()
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    expect(port.writes).toEqual([{ top: 700, cause: 'tail-growth' }])
  })

  it('空树不落 —— 落了等于什么都没做', () => {
    const { port, anchor } = setup()
    anchor.enter('s1', { hasElement: true, hasMessages: false })
    expect(port.writes).toEqual([])
  })

  it('记着锚点 → 落回那一行,并补一发 `scrolled`(不新开一个 restore 事件)', () => {
    const { port, anchor, follows, state, saved } = setup()
    state.anchor = { messageId: 'm1', offset: -12 }
    port.applyTo = 400
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    expect(port.writes).toEqual([{ top: 400, cause: 'restore' }])
    // gap = 1000 − 300 − 400 = 300 > EPS → browsing
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'none' })
    expect(saved).toEqual([{ sessionId: 's1', anchor: undefined }])
  })

  it('锚点指着一条不在树上的消息 → 老实落底', () => {
    const { port, anchor } = setup()
    const { state } = setup()
    state.anchor = { messageId: 'gone', offset: 0 }
    port.applyAnswer = false
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    expect(port.writes).toEqual([{ top: 700, cause: 'tail-growth' }])
  })

  it('记着 `bottom` 时照旧走落底那一支(不经 applyAnchor)', () => {
    const { port, anchor, state } = setup()
    state.anchor = 'bottom'
    port.applyTo = 999
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    expect(port.writes).toEqual([{ top: 700, cause: 'tail-growth' }])
  })
})

describe('跟底:座位那两格判据', () => {
  it('pinned 且座位归零 → 贴底', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([{ top: 900, cause: 'tail-growth' }])
  })

  it('座位还没吃光 → 视口一像素不动(内容长进的是座位里)', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    anchor.pad.landed = true
    port.seat = SEAT
    anchor.beginObserving()
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([])
  })

  it('量出来是 0 但 style 上还挂着残高 → 也不贴(归零那一帧的缝)', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    anchor.pad.landed = true
    port.seat = SEAT
    anchor.pad.measure()
    anchor.pad.flushNow()
    // 座位吃光了:量出来 0,但写进 style 的还是上一次那个数。
    port.seat = { ...SEAT, tailHeight: 10_000 }
    anchor.beginObserving()
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([])
    // 下一帧垫块缩到 0,RO 再来一次 —— 那一次两格都是 0,照旧贴底。
    anchor.pad.flushNow()
    port.geometry.scrollHeight = 1300
    anchor.onResize(grew(1300), 's1')
    expect(port.writes).toEqual([{ top: 1000, cause: 'tail-growth' }])
  })

  it('什么都没变 → 早退(不判丸、不贴底)', () => {
    const { port, anchor, follows } = setup()
    anchor.beginObserving()
    anchor.onResize({ containerChanged: false, columnHeights: [1000] }, 's1')
    expect(port.writes).toEqual([])
    expect(follows).toEqual([])
  })

  it('容器自己变矮 → 重新贴底(它不发滚动事件,没人替它说话)', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.geometry.clientHeight = 200
    anchor.onResize(container, 's1')
    expect(port.writes).toEqual([{ top: 800, cause: 'tail-growth' }])
  })
})

describe('丸:长出来的那一截在不在视口下面', () => {
  it('browsing + gap 变大 → 点亮', () => {
    const { port, anchor, follows } = setup()
    anchor.beginObserving()
    port.scrollTo(0)
    anchor.onScroll('s1', true)
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'none' })
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'reply' })
  })

  it('browsing + 长在视口上面(gap 不变)→ 不点亮', () => {
    const { port, anchor, follows } = setup()
    anchor.beginObserving()
    port.scrollTo(0)
    anchor.onScroll('s1', true)
    const before = follows.length
    // 滚动锚定把 scrollTop 一起加了,gap 不变。
    port.geometry.scrollHeight = 1400
    port.scrollTo(400)
    anchor.onResize(grew(1400), 's1')
    expect(follows.length).toBe(before)
  })
})

describe('「是谁离的底」', () => {
  it('人真往回走了 → 交给状态机', () => {
    const { port, anchor, follows } = setup()
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    port.scrollTo(100)
    anchor.onScroll('s1', true)
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'none' })
  })

  it('gap 张开但位置没往回走(内容自己长的)→ pinned 不动', () => {
    const { port, anchor, follows } = setup()
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    const before = follows.length
    // 我们贴到 700,内容又长了几像素 —— 位置没变,gap 从 0 变成 4.5。
    port.geometry.scrollHeight = 1004.5
    anchor.onScroll('s1', true)
    expect(follows.length).toBe(before)
  })

  it('容器不在手时:判档那一段跳过,去抖那一发照旧重排', () => {
    const { anchor, timers, saved, follows } = setup()
    anchor.onScroll('s1', false)
    expect(follows).toEqual([])
    timers.advance(200)
    expect(saved).toEqual([{ sessionId: 's1', anchor: undefined }])
  })
})

describe('两格意图窗口', () => {
  it('展开窗内:一像素不动,而且不点亮丸', () => {
    const { port, anchor, follows, state } = setup()
    anchor.beginObserving()
    anchor.noteUserExpand()
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    expect(port.writes).toEqual([])
    // pinned 下按此刻离底多远重新判档 —— 与「滚动停下来了」逐字相同。
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'none' })
    // 窗口过期之后照旧贴底。
    state.now += 221
    port.geometry.scrollHeight = 1500
    anchor.onResize(grew(1500), 's1')
    expect(port.writes).toHaveLength(0)
  })

  it('折叠窗内:按锚的漂移把 `scrollTop` 收回去', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.scrollTo(500)
    port.foldAnchor = fakeAnchorEl([100, 100, 40])
    anchor.noteFold(180)
    // 第一帧选锚(top=100),这一帧漂移 0。
    anchor.onResize(grew(900), 's1')
    expect(port.writes).toEqual([])
    // 第二帧锚跑到 40,漂了 −60 → scrollTop 收 60。
    anchor.onResize(grew(880), 's1')
    expect(port.writes).toEqual([{ top: 440, cause: 'user-toggle' }])
  })

  it('折叠窗内:上面没东西可让了就夹在 0(让内容动)', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.scrollTo(10)
    port.foldAnchor = fakeAnchorEl([100, 100, -400])
    anchor.noteFold(180)
    anchor.onResize(grew(900), 's1')
    anchor.onResize(grew(880), 's1')
    expect(port.writes).toEqual([{ top: 0, cause: 'user-toggle' }])
  })

  it('折叠窗过期 → 当场清掉,这一帧走普通那条路', () => {
    const { port, anchor, state } = setup()
    anchor.beginObserving()
    port.foldAnchor = fakeAnchorEl([100, 40])
    anchor.noteFold(180)
    state.now += 221
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([{ top: 900, cause: 'tail-growth' }])
  })

  it('换会话不带上一条会话的展开意图', () => {
    const { port, anchor } = setup()
    anchor.noteUserExpand()
    anchor.enter('s2', { hasElement: true, hasMessages: false })
    anchor.beginObserving()
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([{ top: 900, cause: 'tail-growth' }])
  })
})

describe('停靠取回', () => {
  it('浏览档:把位置摆回去,而且到此为止(不往下走)', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.scrollTo(120)
    anchor.onScroll('s1', true)
    port.scrollTo(0)
    anchor.noteUnpark()
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    expect(port.writes).toEqual([{ top: 120, cause: 'restore' }])
  })

  it('跟底档:不看记的那个数,照旧往下走贴底(位置是算出来的)', () => {
    const { port, anchor } = setup()
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    port.writes.length = 0
    anchor.noteUnpark()
    port.geometry.scrollHeight = 1400
    anchor.beginObserving()
    anchor.onResize(grew(1400), 's1')
    expect(port.writes).toEqual([{ top: 1100, cause: 'tail-growth' }])
  })
})

describe('发送 / 重试落位', () => {
  it('贴底时发送:座位先写到位,再滑到落点', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    port.seat = SEAT
    port.target = 420
    anchor.landOnSendLine()
    expect(anchor.pad.landed).toBe(true)
    expect(port.padHeights).toEqual([22.4 * 6])
    expect(port.writes).toEqual([{ top: 420, cause: 'send-landing' }])
  })

  it('人上翻着发送:一像素不动,座位也不留(规矩 ⑦)', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    port.seat = SEAT
    port.target = 420
    port.scrollTo(0)
    anchor.onScroll('s1', true)
    anchor.landOnSendLine()
    expect(anchor.pad.landed).toBe(false)
    expect(port.writes).toEqual([])
  })

  it('停靠中发送:什么都不做(与贴底同一把尺子)', () => {
    const { port, anchor } = setup({ geometry: { clientHeight: 0 } })
    anchor.seatActive = true
    port.seat = SEAT
    port.target = 420
    anchor.landOnSendLine()
    expect(anchor.pad.landed).toBe(false)
    expect(port.writes).toEqual([])
  })

  it('重试:气泡整条都在视口里 → 不滑动(规矩 ⑥ 的字面)', () => {
    const { port, anchor } = setup()
    port.userRect = { top: 10, bottom: 200 }
    port.target = 420
    anchor.landOnRetry()
    expect(anchor.pad.landed).toBe(false)
    expect(port.writes).toEqual([])
  })

  it('重试:气泡在视口上面 → 按发送那条路滑过去', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    port.seat = SEAT
    port.userRect = { top: -1400, bottom: -1200 }
    port.target = 420
    anchor.landOnRetry()
    expect(anchor.pad.landed).toBe(true)
    expect(port.writes).toEqual([{ top: 420, cause: 'send-landing' }])
  })
})

describe('进场落锚点之后再对', () => {
  it('第一批尺寸变化照锚点再对一次,位置不再动就当场收手', () => {
    const { port, anchor, state, saved } = setup()
    state.anchor = { messageId: 'm1', offset: -12 }
    port.applyTo = 400
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    anchor.beginObserving()
    port.writes.length = 0
    saved.length = 0
    // 再对一次落在同一个位置 → 落稳了,记一笔。
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([{ top: 400, cause: 'restore' }])
    expect(saved).toEqual([{ sessionId: 's1', anchor: undefined }])
  })

  it('还在漂就接着对,而且这一批不判丸也不贴底', () => {
    const { port, anchor, state, follows } = setup()
    state.anchor = { messageId: 'm1', offset: -12 }
    port.applyTo = 400
    anchor.enter('s1', { hasElement: true, hasMessages: true })
    anchor.beginObserving()
    port.writes.length = 0
    const before = follows.length
    port.applyTo = 588
    anchor.onResize(grew(1200), 's1')
    expect(port.writes).toEqual([{ top: 588, cause: 'restore' }])
    expect(follows.length).toBe(before)
  })
})
