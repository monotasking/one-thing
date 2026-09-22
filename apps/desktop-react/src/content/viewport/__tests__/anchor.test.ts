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

  /**
   * ── **交接帧**(G 线 P2-c;正本 §0 ⑤ / §18.3)────────────────────────────
   * 座位吃光、切到普通跟底的那一帧,屏上从前一次性上推 **46px**。病根是一次收缩被
   * 两只手在两帧里各处理一半:这一帧量出来是 0 而 style 上还挂着残高 → 什么都不做;
   * 下一帧 coalescer 写 0、`scrollHeight` 缩掉那一截 → 浏览器钳 → 再下一次 RO 才
   * `stick()`。治法是把两件算进**同一次写**。
   */
  it('交接帧:按「垫块已经归零」的总高贴底,两件合成一次 `setTop`', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    anchor.pad.landed = true
    port.seat = SEAT
    anchor.pad.measure()
    anchor.pad.flushNow()
    const written = anchor.pad.written ?? 0
    expect(written).toBeGreaterThan(0)
    // 座位吃光了:量出来 0,但写进 style 的还是上一次那个数。
    port.seat = { ...SEAT, tailHeight: 10_000 }
    anchor.beginObserving()
    port.geometry.scrollHeight = 1200
    /*
     * **人此刻在底上**(含垫块的那个底)—— 这一支的前提:视口与列底之间只剩
     * 垫块那一截(`gap <= written`)。垫块一归零 `maxScroll` 就少掉 `written`,
     * 浏览器会把这一格钳回去,而这一支把那一下提前做掉。
     */
    port.scrollTo(1200 - 300)
    anchor.onResize(grew(1200), 's1')
    // 1200 − written − 300:内容下缘正好落在视口下缘,那一截垫块留在视口外。
    expect(port.writes).toEqual([{ top: 1200 - written - 300, cause: 'tail-growth' }])
    /*
     * 下一帧垫块缩到 0,`scrollHeight` 少掉 `written` —— 位置**已经**等于新的
     * `maxScroll`,没有可钳的东西。再一次 RO 照旧贴底,算出同一个数。
     */
    anchor.pad.flushNow()
    port.geometry.scrollHeight = 1200 - written
    anchor.onResize(grew(1200 - written), 's1')
    expect(port.writes.at(-1)).toEqual({ top: 1200 - written - 300, cause: 'tail-growth' })
  })

  /**
   * **这一支只吃垫块自己那一截**(超量档真机抓出来的):落点离此刻比垫块还远,
   * 说明视口本来就不在底上 —— 那是别人的账(真店档上列还在补历史,送出去那一下
   * 是一次 102,277px 的跳)。
   */
  it('落点离此刻比垫块还远 → 不写(那不是交接,是别人的账)', () => {
    const { port, anchor } = setup()
    anchor.seatActive = true
    anchor.pad.landed = true
    port.seat = SEAT
    anchor.pad.measure()
    anchor.pad.flushNow()
    port.seat = { ...SEAT, tailHeight: 10_000 }
    anchor.beginObserving()
    // 人离底几万像素(列还在补历史),这一帧不归这一支。
    port.scrollTo(0)
    port.geometry.scrollHeight = 100_000
    anchor.onResize(grew(100_000), 's1')
    expect(port.writes).toEqual([])
  })

  it('垫块是**有意**垫着的(吸收了回缩,还没归零)→ 不进交接那一支', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 4000, clientHeight: 300, scrollTop: 3700 } })
    expect(anchor.pad.requestAbsorb(200)).toBeGreaterThan(0)
    expect(anchor.pad.written).toBe(200)
    port.writes.length = 0
    anchor.beginObserving()
    /*
     * 内容变了,但 gap 仍是 0 —— 那 200px 还**需要**垫着(`relax` 收不掉它)。
     * 垫块不在归零(`height > 0`),所以这一帧仍旧是「不贴底」那条老路。
     */
    anchor.onResize(grew(4100), 's1')
    expect(anchor.pad.absorbed).toBe(200)
    expect(port.writes).toEqual([])
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

describe('一格意图窗口(G 线 P2-c 合一)', () => {
  it('展开那一下:一像素不动,而且不点亮丸', () => {
    const { port, anchor, follows, state } = setup()
    anchor.beginObserving()
    anchor.reportUserToggle({ open: true, durationMs: 0 })
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

  it('窗内:按锚的漂移把 `scrollTop` 收回去', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.scrollTo(500)
    port.foldAnchor = fakeAnchorEl([100, 100, 40])
    anchor.reportUserToggle({ open: false, durationMs: 180 })
    // 第一帧选锚(top=100),这一帧漂移 0。
    anchor.onResize(grew(900), 's1')
    expect(port.writes).toEqual([])
    // 第二帧锚跑到 40,漂了 −60 → scrollTop 收 60。
    anchor.onResize(grew(880), 's1')
    expect(port.writes).toEqual([{ top: 440, cause: 'user-toggle' }])
  })

  it('窗内:上面没东西可让了就夹在 0(让内容动)', () => {
    const { port, anchor } = setup()
    anchor.beginObserving()
    port.scrollTo(10)
    port.foldAnchor = fakeAnchorEl([100, 100, -400])
    anchor.reportUserToggle({ open: false, durationMs: 180 })
    anchor.onResize(grew(900), 's1')
    anchor.onResize(grew(880), 's1')
    expect(port.writes).toEqual([{ top: 0, cause: 'user-toggle' }])
  })

  it('窗口过期 → 当场清掉,这一帧走普通那条路', () => {
    const { port, anchor, state } = setup()
    anchor.beginObserving()
    port.foldAnchor = fakeAnchorEl([100, 40])
    anchor.reportUserToggle({ open: false, durationMs: 180 })
    state.now += 221
    port.geometry.scrollHeight = 1200
    anchor.onResize(grew(1200), 's1')
    // 过期那一次先补一发「此刻离底这么远」(审查裁定 2),这一档 gap 还是 0 → 照旧贴底。
    expect(port.writes).toEqual([{ top: 900, cause: 'tail-growth' }])
  })

  /**
   * **窗口一过要按此刻离底多远重判档**(审查裁定 2,2026-09-22)。
   * 病历:展开那一下把内容撑高一大截,窗口整段早退(不判跟底),过期那一次要是
   * 什么都不做,`stick()` 就按「这一轮还 pinned」把人拽到底 —— 用户报的
   * 「第二次展开视口被拽走 166–435px」正是这条。
   */

  it('换会话不带上一条会话的意图(合一之后一句 `clear()` 清掉整格窗)', () => {
    const { port, anchor } = setup()
    anchor.reportUserToggle({ open: true, durationMs: 0 })
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

/**
 * ── 裁决表 `user-toggle` 那一行(G 线 P2-b,§13.2.2 / §13.6 第 2 条)────────────
 *
 * `deltaH < 0` → 先 `absorb` 再 `pin('reported')`;`deltaH > 0` → 今天的
 * 「按兵不动」(展开那一支为什么不改,判词在 `ViewportAnchor.reportUserToggle`)。
 */
describe('人亲手开合了一块东西', () => {
  /**
   * 一块「此刻多高、报的那一刻顶边在哪、接下来每一帧顶边在哪」的假块。
   * 后两格分开给:`top` 是报的那一刻记下的位置,`tops` 是之后每一帧再问一次的答案。
   */
  function block(height: number, top: number, tops: number[]) {
    return { height, top, anchor: fakeAnchorEl(tops) }
  }

  it('贴底收起:垫块同步补上缩掉的高,而且**在报返回之前**就写好了', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    expect(port.padHeights).toEqual([120])
  })

  it('收起之后那一段:每一帧把**被点的那一块**的顶边按回去', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    // 锚在报的那一刻就选定 —— 不再是下一帧在 RO 回调里现选(晚一拍)。
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [10]) })
    port.writes.length = 0
    port.geometry.columnHeight = 880
    anchor.onResize(grew(880), 's1')
    // 锚往上跑了 30(40 → 10),`scrollTop` 就往回收 30。
    expect(port.writes).toEqual([{ top: 670, cause: 'user-toggle' }])
  })

  it('**它不问 `pickFoldAnchor`** —— 报的人点过名了', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    let asked = 0
    port.pickFoldAnchor = () => { asked += 1; return undefined }
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    anchor.onResize(grew(880), 's1')
    expect(asked).toBe(0)
  })

  it('没点名(重试那一路 / 样例页):退回下一帧现选,垫块一格不动', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    let asked = 0
    port.pickFoldAnchor = () => { asked += 1; return fakeAnchorEl([50, 50]) }
    anchor.reportUserToggle({ open: false, durationMs: 180 })
    expect(port.padHeights).toEqual([])
    anchor.onResize(grew(880), 's1')
    expect(asked).toBe(1)
  })

  /**
   * **展开也钉住被点那一块的顶边**(审查裁定 2,2026-09-22;从前只说一句「别贴底」)。
   * 不垫 —— 展开是长高,没有要吸收的回缩;窗口一过按离底多远重判档。
   */
  it('展开:不垫,但钉住顶边;窗口一过按离底多远重判档', () => {
    const { port, anchor, follows, state } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: true, durationMs: 180, block: block(120, 40, [10]) })
    expect(port.padHeights).toEqual([])
    // 窗口里:锚往上跑了 30 → `scrollTop` 往回收 30(钉住那条顶边)。
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    expect(port.writes).toEqual([{ top: 670, cause: 'user-toggle' }])
    // 窗口过期那一次:离底远了 → browsing,不贴底。
    port.writes.length = 0
    state.now += 221
    anchor.onResize(grew(1400), 's1')
    expect(follows.at(-1)?.mode).toBe('browsing')
    expect(port.writes).toEqual([])
  })

  /**
   * ── **落点**(审查裁定 1):顶边在视口上方时,收起之后那一行落在视口上缘 ────────
   */
  it('顶边在视口里 → 它一像素不动,位置一格不写(与 09-21 那一档逐字相同)', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    expect(port.writes).toEqual([])
    expect(port.padHeights).toEqual([120])
  })

  it('顶边在视口上方 → `scrollTop` 同帧往回收到「那一行落在视口上缘」', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 4000, clientHeight: 300, scrollTop: 3700 } })
    // 那一块高 2000,顶边在视口上缘之上 1500px(视口上缘 = 0)。
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(2000, -1500, [0]) })
    // 先垫后写:垫块按**落点**算,位置往回收 1500。
    expect(port.writes).toEqual([{ top: 2200, cause: 'user-toggle' }])
    expect(port.padHeights?.length).toBe(1)
  })

  it('上内衬不为 0 时落点跟着往下挪(哪天上面多一条带子)', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 4000, clientHeight: 300, scrollTop: 3700 } })
    port.inset = 24
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(2000, -1500, [0]) })
    expect(port.writes).toEqual([{ top: 2176, cause: 'user-toggle' }])
  })

  it('垫块按落点算,而且夹进一屏(真值必然 ≤ 一屏,夹的只是上界那截富余)', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 4000, clientHeight: 300, scrollTop: 3700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(2000, -1500, [0]) })
    expect(anchor.pad.absorbed).toBeLessThanOrEqual(300)
    expect(anchor.pad.absorbed).toBeGreaterThan(0)
  })

  it('动效档「无」(`durationMs: 0`)照报:窗口是那 40ms 余量,补偿照做', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 0, block: block(120, 40, [10]) })
    port.writes.length = 0
    anchor.onResize(grew(880), 's1')
    expect(port.writes).toEqual([{ top: 670, cause: 'user-toggle' }])
  })
})

/** 窗口过期那一次(审查裁定 2)。 */
describe('窗口过期', () => {
  function block(height: number, top: number, tops: number[]) {
    return { height, top, anchor: fakeAnchorEl(tops) }
  }

  it('窗口过期那一次:离底远了就翻成 browsing,不许再贴底', () => {
    const { port, anchor, state, follows } = setup()
    anchor.beginObserving()
    // **报出来的那一下**才带重判(重试那一路不带,判词在 `FoldHold.rejudge`)。
    anchor.reportUserToggle({ open: true, durationMs: 180, block: block(120, 40, [40]) })
    port.geometry.scrollHeight = 1900
    state.now += 221
    anchor.onResize(grew(1900), 's1')
    expect(follows.at(-1)?.mode).toBe('browsing')
    expect(port.writes).toEqual([])
  })

  it('重试那一路(收起、点不出被点的那一块)**不重判** —— 座位正握着这一轮', () => {
    const { port, anchor, state, follows } = setup()
    anchor.beginObserving()
    port.foldAnchor = fakeAnchorEl([100, 100])
    anchor.reportUserToggle({ open: false, durationMs: 180 })
    port.geometry.scrollHeight = 1900
    state.now += 221
    anchor.onResize(grew(1900), 's1')
    expect(follows).toEqual([])
    expect(port.writes).toEqual([{ top: 1600, cause: 'tail-growth' }])
  })

  it('过期只交出一次 —— 不然每一批尺寸变化都重判一遍', () => {
    const { port, anchor, state, follows } = setup()
    anchor.beginObserving()
    anchor.reportUserToggle({ open: true, durationMs: 180, block: block(120, 40, [40]) })
    port.geometry.scrollHeight = 1900
    state.now += 221
    anchor.onResize(grew(1900), 's1')
    follows.length = 0
    port.geometry.scrollHeight = 1901
    anchor.onResize(grew(1901), 's1')
    // 第二批已经是普通那条路(browsing + 下面长出来了 → 只点丸,不重判)。
    expect(follows).toEqual([])
  })
})

/** 过渡中途的四种打断(正本 §15.3 那张表的后四行)。 */
describe('收起到一半被打断', () => {
  function block(height: number, top: number, tops: number[]) {
    return { height, top, anchor: fakeAnchorEl(tops) }
  }

  it('中途再点一次(又展开):后到的那一句说了算,折叠窗被展开窗接替', () => {
    const { port, anchor, state } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [10]) })
    state.now += 50
    anchor.reportUserToggle({ open: true, durationMs: 180, block: block(20, 40, [40]) })
    port.writes.length = 0
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    // 走的是展开那一支:一像素不写。
    expect(port.writes).toEqual([])
  })

  it('中途来了 `tail-growth`:折叠窗在场时整段早退,不贴底、不判丸', () => {
    const { port, anchor, follows } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 } })
    anchor.dispatch({ type: 'scrolled', gap: 700 })
    follows.length = 0
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    port.writes.length = 0
    port.geometry.scrollHeight = 1600
    anchor.onResize(grew(1600), 's1')
    expect(port.writes).toEqual([])
    expect(follows).toEqual([])
  })

  it('中途发送:吸收的那一半当场归零(排一帧写)', () => {
    const { port, anchor } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    expect(port.padHeights).toEqual([120])
    anchor.landOnSendLine()
    expect(anchor.pad.absorbed).toBe(0)
  })

  /**
   * **折叠窗里一格不收**(审查裁定 1 落地那一趟真机抓出来的,判词在 `onScroll` 上):
   * 窗口里那几帧的 gap 说的不是「还需要多少」,是「这一段还没走完」—— 落点那一句
   * `setTop` 自己就会发一发滚动事件,而那一刻那一块还没缩。
   */
  it('中途人滚动:折叠窗里一格不收,窗口过了才按「此刻还需要多少」往下收', () => {
    const { port, anchor, state } = setup({ geometry: { scrollHeight: 1000, clientHeight: 300, scrollTop: 700 } })
    anchor.reportUserToggle({ open: false, durationMs: 180, block: block(120, 40, [40]) })
    expect(anchor.pad.absorbed).toBe(120)
    // 窗口里:人往上滚 50,垫块一格不动。
    port.scrollTo(650)
    anchor.onScroll('s1', true)
    expect(anchor.pad.absorbed).toBe(120)
    // 窗口过了再滚:按「此刻还需要多少」往下收。
    state.now += 221
    anchor.onScroll('s1', true)
    expect(anchor.pad.absorbed).toBe(70)
  })
})

/**
 * **人说了要去哪**(G 线 P2-c;正本 §18.2 那张三态表)。
 *
 * 三处生产者(钢琴键 / 检索命中 / 来源条)从前各写各的滚动位、一处都不经过跟随
 * 状态机 —— 往下跳时那一支读成「没往回走」于是不翻档。这一组钉的就是收编之后
 * 那一句:**落位之后显式重判一次档,问的是落点的 gap,不是此刻的。**
 */
describe('跳转(`jump`)', () => {
  it('落在中间 → browsing(新内容从此不再把人拽走)', () => {
    const { port, anchor, follows } = setup()
    anchor.reportJump({ top: 200 })
    expect(port.writes).toEqual([{ top: 200, cause: 'jump' }])
    expect(follows.at(-1)).toEqual({ mode: 'browsing', unseen: 'none' })
  })

  it('落在底 → pinned', () => {
    const { port, anchor, follows } = setup({ geometry: { scrollTop: 200 } })
    anchor.dispatch({ type: 'scrolled', gap: 500 })
    expect(follows.at(-1)?.mode).toBe('browsing')
    anchor.reportJump({ top: 700 })
    expect(port.writes).toEqual([{ top: 700, cause: 'jump' }])
    expect(follows.at(-1)).toEqual({ mode: 'pinned', unseen: 'none' })
  })

  it('落点**夹进** [0, maxScroll] —— 越界的跳转落在底,不是落在一个不存在的位置', () => {
    const { port, anchor, follows } = setup()
    anchor.reportJump({ top: 99_999 })
    expect(port.writes).toEqual([{ top: 700, cause: 'jump' }])
    expect(follows.at(-1)).toBeUndefined()
    anchor.reportJump({ top: -50 })
    expect(port.writes.at(-1)).toEqual({ top: 0, cause: 'jump' })
  })

  it('平滑那一档照旧平滑(不许变瞬移),而 `lastTop` 留在动画起点', () => {
    const { port, anchor } = setup()
    anchor.reportJump({ top: 400, behavior: 'smooth' })
    expect(port.writes).toEqual([{ top: 400, cause: 'jump', behavior: 'smooth' }])
    /*
     * 记的是**读回来的**那个数 —— 平滑那一段还没开始走,读回来的是起点。
     * 记成目标值的话,接下来那几十发滚动事件里第一发会被读成「人往上翻」。
     */
    expect(port.lastTop).toBe(0)
  })

  it('停靠中(`clientHeight === 0`)一格不做:不写、不判', () => {
    const { port, anchor, follows } = setup({ geometry: { clientHeight: 0 } })
    anchor.reportJump({ top: 200 })
    expect(port.writes).toEqual([])
    expect(follows).toEqual([])
  })
})
