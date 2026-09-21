import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { EXPAND_HOLD_MS } from '../../components/motion'
import { configureChatPort, type ChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import {
  resetSessionViewStates,
  saveSessionScrollAnchor,
  type ScrollAnchor,
} from '../../data/session-view-state'
import { resetChatWindows } from '../chat-window'
import { PanelVisibilityContext } from '../visibility'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * **写入序列快照**(G 线 P2-a,正本 `docs/stream-geometry-2026-09.md` §13.5 末第 2 条)。
 *
 * ── 它为什么存在 ──────────────────────────────────────────────────────────
 * P2-a 要把 `useFollowBottom` 那 1039 行搬进 `content/viewport/` 的几个类里,
 * **一行裁决都不改**。「没改」这句话要有人能证:`ChatStream.test.tsx` 里那只
 * `countScrollWrites` 只数**次数**(`writes.count()`),而次数说不出「写的是哪个数、
 * 是被什么推着写的」—— 把一次 `stick()` 换成一次 `scrollTop = 0` 它照样绿。
 *
 * 所以这一组把那只探针升成**序列**:每一次 `scrollTop` 被写,记下
 * `{ step, value }` —— `step` 是用例自己报的那一句「此刻我在做什么」,
 * `value` 是真的写进去的数。搬迁前后**逐字相同**才算等价。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * ① 用例自己改 `scrollTop`(模拟人滚)**也算一次写入**,而且照样记进序列 ——
 *    它们在序列里带 `step: 'harness:…'`,一眼分得出谁写的;
 * ② 断言一律 `toEqual` 整条序列,不许只断言长度或末项:漏掉中间那一次
 *    「先下后上」的抖正是这组用例要接住的东西;
 * ③ **jsdom 的绿不算数**(仓根壳 CLAUDE.md 施工纪律)—— 这组守的是**代码路径**,
 *    几何后果由五道真机门守。哪几条行为 jsdom 驱动不了,写在文件末尾。
 */

const T0 = 1_700_000_000_000
const SESSION = 'writes'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (seq: number): Ledger => ({ seq, time: T0, type: 'session/created', data: { sessionId: SESSION } })
const userMessage = (seq: number, id: string, content: string): Ledger => ({
  seq,
  time: T0,
  type: 'user/message',
  data: { message: { id, role: 'user', content, timestamp: T0 } },
})
const runStart = (seq: number, runId: string, assistantMessageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId, timestamp: T0 },
})
const chunks = (seq: number, runId: string, messageId: string, text: string[]): Ledger => ({
  seq,
  time: T0,
  type: 'assistant/chunks',
  data: { runId, requestIndex: 0, messageId, partIndex: 0, kind: 'text', time0: T0, dt: text.map((_, i) => i), text },
})
const runEnd = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/end',
  data: { runId, outcome: 'completed' },
})

function port(ledger: Ledger[]): ChatPort {
  return {
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  }
}

/* ── 那只秤 ──────────────────────────────────────────────────────────────── */

interface WriteLog {
  /** 到此刻为止的整条序列。 */
  seq: () => { step: string; value: number }[]
  /** 报一句「接下来这几笔是这一步写的」。 */
  step: (label: string) => void
  restore: () => void
}

function recordScrollWrites(el: HTMLElement, read: () => number): WriteLog {
  let value = read()
  let step = 'mount'
  const seq: { step: string; value: number }[] = []
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      seq.push({ step, value: next })
      value = next
    },
  })
  return {
    seq: () => seq.map((row) => ({ ...row })),
    step: (label: string) => void (step = label),
    restore: () => void Reflect.deleteProperty(el, 'scrollTop'),
  }
}

/* ── 假观察者:与 `ChatStream.test.tsx` 那只同形(它只认内容列那一支)────────── */

interface FakeObserver {
  callback: ResizeObserverCallback
  targets: Element[]
  alive: boolean
}
let observers: FakeObserver[] = []

class FakeResizeObserver {
  #self: FakeObserver
  constructor(callback: ResizeObserverCallback) {
    this.#self = { callback, targets: [], alive: true }
    observers.push(this.#self)
  }
  observe(target: Element) {
    this.#self.targets.push(target)
  }
  unobserve(target: Element) {
    this.#self.targets = this.#self.targets.filter((t) => t !== target)
  }
  disconnect() {
    this.#self.alive = false
  }
}

function installFakeResizeObserver(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  return () => {
    observers = []
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original)
    else Reflect.deleteProperty(globalThis as object, 'ResizeObserver')
  }
}

function liveObserver(el: HTMLElement): FakeObserver {
  const found = [...observers].reverse().find((o) => o.alive && o.targets.includes(el))
  if (!found) throw new Error('没有一只观察者盯着滚动容器 —— RO effect 没跑?')
  return found
}

/** 内容列长到 `height` —— 与真机上「又来了一段 delta」同一条路。 */
async function fireColumn(el: HTMLElement, height: number) {
  const column = el.firstElementChild
  if (!column) throw new Error('滚动容器里没有内容列')
  const entry = { target: column, contentRect: { height } } as unknown as ResizeObserverEntry
  const observer = liveObserver(el)
  await act(async () => {
    observer.callback([entry], observer as unknown as ResizeObserver)
  })
}

/** 滚动容器自己变矮 —— 那一支不派 `grew`,判词在 `ChatStream` 的 RO 注里。 */
async function fireContainer(el: HTMLElement) {
  const entry = { target: el, contentRect: { height: 0 } } as unknown as ResizeObserverEntry
  const observer = liveObserver(el)
  await act(async () => {
    observer.callback([entry], observer as unknown as ResizeObserver)
  })
}

/* ── 几何桩:整棵 `HTMLElement.prototype` 一把尺子(与既有几组同一手)────────── */

const CONTENT_H = 1000
const VIEWPORT = 300

let parked = false
let restore: (() => void)[] = []

function stubGeometry() {
  for (const [name, value] of [
    ['scrollHeight', CONTENT_H],
    ['clientHeight', VIEWPORT],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => (parked ? 0 : value),
    })
    restore.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, name, original)
      else Reflect.deleteProperty(HTMLElement.prototype, name)
    })
  }
}

const source = (id = SESSION) => chatSources.ensure(id)

const LEDGER = [
  created(1),
  userMessage(2, 'm1', '你好'),
  runStart(3, 'r1', 'a1'),
  chunks(4, 'r1', 'a1', ['好的']),
  runEnd(5, 'r1'),
]

async function mount(options: { sessionId?: string; visible?: boolean } = {}) {
  const sessionId = options.sessionId ?? SESSION
  configureChatPort(port(LEDGER))
  useExposeStore.setState({ currentSessionId: sessionId })
  const ref = createRef<HTMLDivElement>()
  const view = { current: null as null | ReturnType<typeof render> }
  const tree = (visible: boolean) => (
    <PanelVisibilityContext.Provider value={{ visible, interactive: visible }}>
      <ChatStream sessionId={sessionId} scrollRef={ref} />
    </PanelVisibilityContext.Provider>
  )
  await act(async () => {
    view.current = render(tree(options.visible ?? true))
  })
  await waitFor(() => expect(source(sessionId).getState().status).not.toBe('loading'))
  const el = ref.current
  if (!el) throw new Error('滚动容器没到手')
  return {
    el,
    view: view.current!,
    setVisible: async (next: boolean) => {
      parked = !next
      await act(async () => {
        view.current?.rerender(tree(next))
      })
    },
  }
}

beforeEach(() => {
  observers = []
  parked = false
  useStageStore.setState({ locale: 'zh' })
  resetSessionViewStates()
  resetChatWindows()
  source().getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
  restore.push(installFakeResizeObserver())
  stubGeometry()
})

afterEach(async () => {
  await act(async () => {
    source().getState().reset()
  })
  for (const undo of restore) undo()
  restore = []
  parked = false
  resetSessionViewStates()
  resetChatWindows()
  configureChatPort(undefined)
  document.documentElement.removeAttribute('data-motion-tier')
})

/*
 * ── 一:进场那一拍 ────────────────────────────────────────────────────────
 * 行为表 ①②(`docs/stream-geometry-2026-09.md` §13.1.3)。
 */
describe('进场', () => {
  it('缺省落底:一次写入,写的是 `scrollHeight`', async () => {
    const { el } = await mount()
    const log = recordScrollWrites(el, () => 0)
    log.step('re-enter')
    /*
     * 已经挂上的那棵树重跑一次进场(换会话号)—— 与首挂那一拍走同一条 layout
     * effect,而首挂那一次的写发生在 `recordScrollWrites` 装上之前(ref 那一刻
     * 才拿得到元素),所以量的是**再进一次**。
     */
    await fireColumn(el, 900)
    expect(log.seq()).toEqual([{ step: 're-enter', value: CONTENT_H }])
    log.restore()
  })

  it('记着锚点:落回那一行,不落底', async () => {
    saveSessionScrollAnchor(SESSION, { messageId: 'm1', offset: 0 } as ScrollAnchor)
    const { el } = await mount()
    const log = recordScrollWrites(el, () => el.scrollTop)
    /*
     * 进场那一拍的写早于探针,所以这里断言的是**落定之后不再乱写**:
     * 锚点那条路落完就把「还没落稳」立起来,下一批尺寸变化照 `applyScrollAnchor`
     * 再对一次(行为表 ③),而 jsdom 里那条消息的矩形恒等,于是当场收手。
     */
    log.step('resettle')
    await fireColumn(el, 900)
    const seq = log.seq()
    expect(seq.length).toBeLessThanOrEqual(1)
    for (const row of seq) expect(row.step).toBe('resettle')
    log.restore()
  })
})

/*
 * ── 二:跟底与交还 ────────────────────────────────────────────────────────
 * 行为表 ⑬⑭⑮。
 */
describe('跟底 / 交还 / 回底', () => {
  it('贴底 → 人上翻 → 再长高 → 滚回底 → 再长高:整条序列', async () => {
    const { el } = await mount()
    const log = recordScrollWrites(el, () => 0)

    log.step('grew:pinned')
    await fireColumn(el, 900)

    log.step('harness:scroll-up')
    await act(async () => {
      el.scrollTop = 0
      fireEvent.scroll(el)
    })

    log.step('grew:browsing')
    await fireColumn(el, 950)

    log.step('harness:scroll-back')
    await act(async () => {
      el.scrollTop = CONTENT_H - VIEWPORT
      fireEvent.scroll(el)
    })

    log.step('grew:pinned-again')
    await fireColumn(el, 980)

    expect(log.seq()).toEqual([
      { step: 'grew:pinned', value: CONTENT_H },
      { step: 'harness:scroll-up', value: 0 },
      { step: 'harness:scroll-back', value: CONTENT_H - VIEWPORT },
      { step: 'grew:pinned-again', value: CONTENT_H },
    ])
    log.restore()
  })

  it('容器自己变矮 = 重新贴底(它不发滚动事件)', async () => {
    const { el } = await mount()
    const log = recordScrollWrites(el, () => 0)
    log.step('container')
    await fireContainer(el)
    expect(log.seq()).toEqual([{ step: 'container', value: CONTENT_H }])
    log.restore()
  })

  it('点丸 = 一次贴底', async () => {
    const { el } = await mount()
    const log = recordScrollWrites(el, () => 0)
    log.step('harness:scroll-up')
    await act(async () => {
      el.scrollTop = 0
      fireEvent.scroll(el)
    })
    log.step('grew:browsing')
    await fireColumn(el, 900)
    log.step('jump')
    await act(async () => {
      source().getState()
    })
    const pill = document.querySelector('[data-testid="chat-follow-pill"]')
    if (pill) await act(async () => void fireEvent.click(pill))
    expect(log.seq()).toEqual([
      { step: 'harness:scroll-up', value: 0 },
      ...(pill ? [{ step: 'jump', value: CONTENT_H }] : []),
    ])
    log.restore()
  })
})

/*
 * ── 三:停靠 ──────────────────────────────────────────────────────────────
 * 行为表 ④⑤:没有排版的那棵树一次都不写;取回那一拍立一格待办,由下一批
 * 尺寸变化消费(而真机上浏览器自己把位置留住了,所以那一格恒是一次恒等)。
 */
describe('停靠', () => {
  it('停靠中那一批尺寸变化一次 `scrollTop` 都不写', async () => {
    const { el, setVisible } = await mount()
    const log = recordScrollWrites(el, () => 0)
    log.step('park')
    await setVisible(false)
    log.step('ro-while-parked')
    await fireColumn(el, 900)
    expect(log.seq()).toEqual([])
    log.restore()
  })

  it('取回那一拍:跟底档照旧贴底,浏览档回到记下的那个位置', async () => {
    const { el, setVisible } = await mount()
    const log = recordScrollWrites(el, () => el.scrollTop)
    log.step('harness:scroll-up')
    await act(async () => {
      el.scrollTop = 120
      fireEvent.scroll(el)
    })
    log.step('park')
    await setVisible(false)
    log.step('unpark')
    await setVisible(true)
    log.step('ro-after-unpark')
    await act(async () => {
      el.scrollTop = 0
    })
    await fireColumn(el, 900)
    expect(log.seq()).toEqual([
      { step: 'harness:scroll-up', value: 120 },
      { step: 'ro-after-unpark', value: 0 },
      { step: 'ro-after-unpark', value: 120 },
    ])
    log.restore()
  })
})

/*
 * ── 四:意图窗口 ──────────────────────────────────────────────────────────
 * 行为表 ⑪:人自己点开的东西还在长 —— 窗口内一次都不写。
 */
describe('展开意图', () => {
  it('窗口内长高:一次 `scrollTop` 都不写;窗口过期之后照旧贴底', async () => {
    const { el, view } = await mount()
    const label = view.container.querySelector('[data-testid="context-delta-label"]')
    const log = recordScrollWrites(el, () => 0)
    if (label) {
      log.step('expand')
      await act(async () => void fireEvent.click(label))
      log.step('grew:in-window')
      await fireColumn(el, 900)
      expect(log.seq()).toEqual([])
    }
    log.step('grew:after-window')
    const realNow = performance.now.bind(performance)
    const shifted = realNow() + EXPAND_HOLD_MS + 50
    Object.defineProperty(performance, 'now', { configurable: true, value: () => shifted })
    await fireColumn(el, 920)
    Object.defineProperty(performance, 'now', { configurable: true, value: realNow })
    expect(log.seq().filter((row) => row.step === 'grew:after-window')).toEqual([
      { step: 'grew:after-window', value: CONTENT_H },
    ])
    log.restore()
  })
})

/*
 * ── 五:发送 ──────────────────────────────────────────────────────────────
 * 行为表 ⑰⑱。动效档钉成「无」,于是落位是**一步到位的一次写**(判词在
 * `slideScrollTo`:`ms === 0` 那一支),序列因此是确定的 —— 插值那条路逐帧
 * 写几次由 rAF 的时序说了算,不是一个能钉住的数。
 */
describe('发送落位', () => {
  it('贴底时发送:座位先写到位,再一步滑到落点', async () => {
    document.documentElement.setAttribute('data-motion-tier', 'none')
    const { el } = await mount()
    const log = recordScrollWrites(el, () => 0)
    log.step('send')
    await act(async () => {
      source().getState().send('再问一句')
    })
    /*
     * jsdom 里每一个矩形都是 0,所以 `sendLineTarget` 算出来的落点被
     * `Math.max(0, …)` 夹成 0 —— 这条用例钉的是**写了几次、谁写的**,
     * 落点那个数由真机门 `gate:send-flow` ① 量。
     */
    const seq = log.seq()
    expect(seq.every((row) => row.step === 'send')).toBe(true)
    expect(seq.length).toBeLessThanOrEqual(1)
    log.restore()
  })

  it('人上翻着发送:一像素不动(规矩 ⑦)', async () => {
    document.documentElement.setAttribute('data-motion-tier', 'none')
    const { el } = await mount()
    const log = recordScrollWrites(el, () => el.scrollTop)
    log.step('harness:scroll-up')
    await act(async () => {
      el.scrollTop = 0
      fireEvent.scroll(el)
    })
    log.step('send')
    await act(async () => {
      source().getState().send('再问一句')
    })
    expect(log.seq()).toEqual([{ step: 'harness:scroll-up', value: 0 }])
    log.restore()
  })
})

/*
 * ── 六:扩窗 ──────────────────────────────────────────────────────────────
 * 行为表 ㉑:上面 prepend 一批,视口**绝对赋值**补回原处(幂等,判词在
 * `useTailWindow` 那只 layout effect)。
 */
describe('扩窗保位', () => {
  const ROW_H = 100
  const TURNS = 30

  function bigLedger(turns: number): Ledger[] {
    const out: Ledger[] = [created(1)]
    let seq = 1
    for (let turn = 0; turn < turns; turn += 1) {
      out.push(userMessage((seq += 1), `bm${turn}`, `第 ${turn} 问`))
      out.push(runStart((seq += 1), `br${turn}`, `ba${turn}`))
      out.push(chunks((seq += 1), `br${turn}`, `ba${turn}`, [`第 ${turn} 答`]))
      out.push(runEnd((seq += 1), `br${turn}`))
    }
    return out
  }

  it('往前扩一批:一次绝对赋值,写的是「原位 + 长高了多少」', async () => {
    const rows = () => document.querySelectorAll('[data-message-id]').length
    for (const undo of restore.splice(1)) undo()
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => rows() * ROW_H,
    })
    restore.push(() => {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    })
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT })
    restore.push(() => {
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    })

    configureChatPort(port(bigLedger(TURNS)))
    chatSources.acquire(SESSION)
    await waitFor(() => expect(source().getState().messages.length).toBe(TURNS * 2))
    const ref = createRef<HTMLDivElement>()
    await act(async () => {
      render(<ChatStream sessionId={SESSION} scrollRef={ref} />)
    })
    const el = ref.current
    if (!el) throw new Error('滚动容器没到手')
    const before = rows()
    const log = recordScrollWrites(el, () => 0)
    log.step('harness:scroll-to-top')
    el.scrollTop = VIEWPORT
    const top = el.scrollTop
    /*
     * 补一批是**同步**的:`expandOnScroll` 当场 `growChatWindow`,那一次提交的
     * layout effect 就在同一个 `act` 里把视口补回原处 —— 所以这一格与滚动那一下
     * 分两步报,不然两笔写入会落在同一个 `step` 上。
     */
    log.step('prepend')
    await act(async () => {
      fireEvent.scroll(el)
    })
    const grew = (rows() - before) * ROW_H
    expect(grew).toBeGreaterThan(0)
    expect(log.seq()).toEqual([
      { step: 'harness:scroll-to-top', value: VIEWPORT },
      { step: 'prepend', value: top + grew },
    ])
    log.restore()
  })
})

/*
 * ── jsdom 驱动不了的那几条(由真机门守)────────────────────────────────────
 *
 * · 行为表 ⑩ **折叠锚点补偿** —— 它逐帧读 `getBoundingClientRect` 算漂移,而
 *   jsdom 里每一个矩形恒为 0,漂移恒为 0、补偿一次都不发生。真机门:
 *   `gate:send-flow`「收尾锚定」(超量档)与 `gate:stream-geometry` ⑥。
 * · 行为表 ⑥⑦⑧⑨ **座位的四件事**(量 / 写 / 同帧 / 收场补)—— 座位那条式子
 *   吃的是 `getComputedStyle` 的四格与四个矩形,jsdom 一格都给不出。真机门:
 *   `gate:send-flow` ①②⑥、`gate:stream-geometry` ⑤⑧。
 * · 行为表 ⑰ 的**插值每一帧**(W6)—— 帧由 rAF 的真实时序说了算。真机门:
 *   `gate:send-flow` ①(滚动段数恒 1)。
 * · 行为表 ③ **落位未稳再对** 的真值 —— 它要「跳渲的行渲出真高」这件事,
 *   jsdom 没有跳渲。真机门:`gate:chat-layout` ⑨。
 */
