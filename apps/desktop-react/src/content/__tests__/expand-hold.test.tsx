import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { EXPAND_HOLD_MS } from '../../components/motion'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { resetSessionViewStates } from '../../data/session-view-state'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * **「人自己点开的东西不许把他推到底」**(2026-09-12 报障二的「位」;通道
 * `content/expand-intent.ts`,窗长 `components/motion.ts` 的 `EXPAND_HOLD_MS`,
 * 落点是 `ChatStream` 那只 ResizeObserver)。
 *
 * ── 为什么这一件非测不可 ──────────────────────────────────────────────────
 * 报障二的病根是**几何分不出两件事**:「模型又吐了一段」与「人点开了一段折痕正文」
 * 都让内容长高、gap 变大、`scrollTop` 不动。pinned 下任何长高都贴底,于是人点开
 * 的那一段当场被推出视野。修法是让动手的那一方自述一句意图 —— 而「自述了之后
 * 位置一像素不动」这句话只有在**真的跑一遍那只观察者**时才证得了,所以这一组
 * 走真的 `ChatStream`(不是直接渲染折痕),自己造 ResizeObserver 与几何。
 *
 * jsdom 不排版,所以几何是**喂进去的**:`scrollHeight` / `clientHeight` /
 * `scrollTop` 三格由下面那份可变的账说了算,观察者的回调也由测试手动开火。
 * 量的是**判据**(哪一支分流跑了),不是像素 —— 像素归真机门 `gate:chat-follow`。
 */

const T0 = 1_700_000_000_000
const SESSION = 'expand-hold'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const ledgerOf = (): Ledger[] => [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId: SESSION } },
  {
    seq: 2,
    time: T0,
    type: 'user/message',
    data: { message: { id: 'm1', role: 'user', content: '你好', timestamp: T0 } },
  },
  {
    seq: 3,
    time: T0,
    type: 'context/turn-update',
    data: { messageId: 'm1', set: { todo: '- [ ] A1' } },
  },
  {
    seq: 4,
    time: T0,
    type: 'run/start',
    data: { runId: 'r1', kind: 'chat', assistantMessageId: 'a1', timestamp: T0 },
  },
  {
    seq: 5,
    time: T0,
    type: 'assistant/chunks',
    data: {
      runId: 'r1',
      requestIndex: 0,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: T0,
      dt: [0],
      text: ['好的'],
    },
  },
]

/** 这次挂载里造出来的那些观察者 —— 找「盯着滚动容器的那一只」就靠它。 */
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

/** 喂给容器的那三格几何。`scrollTop` 可写 —— 产品写它就是「贴底了」。 */
interface Geometry {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

function installGeometry(el: HTMLElement, geo: Geometry) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geo.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geo.scrollTop,
    // **照浏览器那样夹住**:`stick()` 写的是 `scrollHeight`,真机上它落在
    // `scrollHeight − clientHeight`。不夹的话 gap 会算出负数,那是 jsdom 的产物,
    // 不是这台上会发生的事。
    set: (value: number) => {
      geo.scrollTop = Math.min(value, geo.scrollHeight - geo.clientHeight)
    },
  })
}

/** 贴底时 `scrollTop` 该落在哪儿(= `stick()` 的结果)。 */
const bottomOf = (geo: Geometry) => geo.scrollHeight - geo.clientHeight

function Harness({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  return <ChatStream sessionId={sessionId} scrollRef={ref} />
}

function fakePort() {
  configureChatPort({
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: ledgerOf() as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  })
}

/** 此刻的「现在」。`performance.now` 被钉在它上面 —— 窗口过没过由测试说了算。 */
let now = 0

let view: ReturnType<typeof render>

/** 装好一台:真的 ChatStream + 喂进去的几何,进场时贴底(gap = 0)。 */
async function mount(sessionId = SESSION) {
  fakePort()
  useExposeStore.setState({ currentSessionId: sessionId })
  await act(async () => {
    view = render(<Harness sessionId={sessionId} />)
  })
  await waitFor(() => expect(chatSources.ensure(sessionId).getState().status).not.toBe('loading'))
  const el = view.container.querySelector('[data-testid="chat-stream"]') as HTMLElement
  const geo: Geometry = { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }
  installGeometry(el, geo)
  return { el, geo }
}

/** 盯着滚动容器的那一只(`clampMeasurer` 也会造一只,按目标认人)。 */
function streamObserver(el: HTMLElement): FakeObserver {
  const found = [...observers].reverse().find((o) => o.alive && o.targets.includes(el))
  if (!found) throw new Error('没有一只观察者盯着滚动容器 —— RO effect 没跑?')
  return found
}

/**
 * 内容长高了。`height` 是内容列此刻的高度(比上一次大就是「长高」),
 * 几何由调用方先改好 —— 真机上这两件事本来就是同一拍发生的。
 */
function grow(el: HTMLElement, height: number) {
  const column = el.firstElementChild as Element
  const entry = { target: column, contentRect: { height } } as unknown as ResizeObserverEntry
  const observer = streamObserver(el)
  act(() => {
    observer.callback([entry], observer as unknown as ResizeObserver)
  })
}

const pill = () => screen.queryByTestId('chat-follow-pill')
const label = () => screen.getByTestId('context-delta-label')

beforeEach(() => {
  observers = []
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  useStageStore.setState({ locale: 'zh' })
  resetSessionViewStates()
  chatSources.ensure(SESSION).getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
})

afterEach(() => {
  view?.unmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('没人报意图:长高照旧贴底(兜底,这一格一个字没动)', () => {
  it('pinned 下内容长高 —— scrollTop 被赋成 scrollHeight', async () => {
    const { el, geo } = await mount()
    geo.scrollHeight = 1300
    grow(el, 100)
    expect(geo.scrollTop).toBe(bottomOf(geo))
  })
})

describe('人自己点开的东西:位置一动不动', () => {
  it('点开折痕之后那一拍长高 —— scrollTop 一像素不动,丸也不亮', async () => {
    const { el, geo } = await mount()
    fireEvent.click(label())
    geo.scrollHeight = 1300
    grow(el, 100)
    // 位置不动 = 他要读的那一段还在他眼前。
    expect(geo.scrollTop).toBe(500)
    // 按此刻离底多远重新判档:gap 300 > EPS → browsing,但**什么都没长出来给他看**
    // (那一截正是他自己点开的),所以丸不该亮。
    expect(pill()).toBeNull()
  })

  it('窗口内展开还在一帧一帧推 —— 已经是 browsing 了,丸仍不亮(那一截是他自己点开的)', async () => {
    const { el, geo } = await mount()
    fireEvent.click(label())
    geo.scrollHeight = 1300
    grow(el, 100)
    // 第一拍翻成 browsing(gap 300 > EPS)。过渡的第二、第三帧还在窗口内:
    // 走 browsing 那一支的 `grew` 会把丸点亮 —— 而下面长出来的正是他点开的那一段。
    now += 50
    geo.scrollHeight = 1400
    grow(el, 200)
    now += 50
    geo.scrollHeight = 1500
    grow(el, 300)
    expect(geo.scrollTop).toBe(500)
    expect(pill()).toBeNull()
    // 窗口一过,下面再长就是真的没看见的东西了。
    now += EXPAND_HOLD_MS
    geo.scrollHeight = 1700
    grow(el, 500)
    expect(pill()).not.toBeNull()
  })

  it('窗口过了之后的长高照旧按几何判 —— browsing 下不贴底,丸亮起来', async () => {
    const { el, geo } = await mount()
    fireEvent.click(label())
    geo.scrollHeight = 1300
    grow(el, 100)
    expect(geo.scrollTop).toBe(500)

    now += EXPAND_HOLD_MS + 1
    geo.scrollHeight = 1600
    grow(el, 200)
    // 已经是 browsing(上一拍翻的),所以不贴底;这一截是真的长在他没看见的下面。
    expect(geo.scrollTop).toBe(500)
    expect(pill()).not.toBeNull()
  })

  /**
   * **G 线 P2-b 审查裁定 2 改了这一条**(2026-09-22)。
   *
   * 从前这里断言「窗口过后照旧跟底,跟底没丢」—— 那是把「人点开了一样东西」读成
   * **一段限时的按兵不动**。裁定把它改成**一次不可逆的翻档**:展开窗里**每一批**
   * 尺寸变化都按「此刻离底多远」重判,内容一长出来 gap 变大,状态机当场翻成
   * browsing,之后再长也不贴底(丸会亮起来说「回到最新」)。
   *
   * 理由是超量档上量出来的:定长窗口在 400 条 / 十一万像素那条会话上短于一帧,
   * 窗口一断 `stick()` 就把人拽走(实测 11,454–27,018px)。判词整段在
   * `ViewportAnchor.onResize` 的折叠分支上。
   *
   * **「展开没让内容溢出」那一档不变**:gap 仍 ≤ EPS 时重判的结果就是 pinned,
   * 所以位置一像素不动 —— 下面第一段断言原样保留。
   */
  it('点开的那一段没把人挤离底(gap 仍 ≤ EPS);再长出来的那一截不再把人拽到底', async () => {
    const { el, geo } = await mount()
    fireEvent.click(label())
    // 展开没让内容溢出:gap 还是 0,重判的结果照旧 pinned,位置一像素不动。
    grow(el, 100)
    expect(geo.scrollTop).toBe(500)

    now += EXPAND_HOLD_MS + 1
    geo.scrollHeight = 1300
    grow(el, 200)
    // 这一截长在他没看见的下面 —— 翻档已经发生,不贴底,丸亮起来。
    expect(geo.scrollTop).toBe(500)
    expect(pill()).not.toBeNull()
  })

  it('换会话把意图清零 —— 那一格说的是「那边有人点开了一样东西」', async () => {
    const { el } = await mount()
    fireEvent.click(label())
    // 时钟一动不动:窗口在时间上仍然开着,清零的只能是换会话那一句。
    await act(async () => {
      view.rerender(<Harness sessionId="expand-hold-2" />)
    })
    await waitFor(() =>
      expect(chatSources.ensure('expand-hold-2').getState().status).not.toBe('loading'),
    )
    const next = view.container.querySelector('[data-testid="chat-stream"]') as HTMLElement
    expect(next).toBe(el)
    const geo: Geometry = { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }
    installGeometry(next, geo)
    geo.scrollHeight = 1300
    grow(next, 100)
    expect(geo.scrollTop).toBe(bottomOf(geo))
  })
})

/**
 * ── 出场那一下不许把跟底弄丢(2026-09-12,真机探针抓到的那条竞态)────────────
 *
 * 病历(`gate:chat-follow` ④ 上的页内探针):浏览器一帧里**先跑滚动事件、后跑
 * ResizeObserver**,于是内容一帧一帧长的时候 ——
 *   RO(第 n 帧)贴底 → `scrollTop` 落在那一刻的底
 *   → 滚动事件排到第 n+1 帧才派,而那一帧内容又长了几像素
 *   → 回调量到 `gap = 4.5 > AT_BOTTOM_EPS(2)` → 判成「人往上翻了」,跟底从此丢掉
 *     (真机读数:此后每条新消息离底 38 → 263 → 431 → … 逐条累加)。
 * 修法只用位置:**人往上翻 = `scrollTop` 变小**;位置没往回走就不是人干的。
 */
describe('内容一帧一帧长的时候,跟底不许丢', () => {
  it('gap 张开但 scrollTop 没往回走 —— 还是 pinned,下一拍照旧贴底', async () => {
    const { el, geo } = await mount()
    // 先量一次,好让「上一次人在第几像素」有个数(第一次没有旧值,按老办法照判)。
    act(() => {
      fireEvent.scroll(el)
    })
    geo.scrollHeight = 1300
    grow(el, 100)
    expect(geo.scrollTop).toBe(bottomOf(geo))

    // 过渡还在跑:这一帧又长了 4px,而滚动事件才轮到上一帧那次贴底。
    geo.scrollHeight = 1304
    act(() => {
      fireEvent.scroll(el)
    })
    expect(pill()).toBeNull()

    // 还是 pinned,所以下一拍 RO 照旧把它贴回底。
    grow(el, 120)
    expect(geo.scrollTop).toBe(bottomOf(geo))
  })

  it('人真的往上翻(scrollTop 变小)照旧翻成 browsing', async () => {
    const { el, geo } = await mount()
    act(() => {
      fireEvent.scroll(el)
    })
    geo.scrollTop = 100
    act(() => {
      fireEvent.scroll(el)
    })
    // 离底 400 —— 这一下是人干的,跟底该丢。
    geo.scrollHeight = 1400
    grow(el, 100)
    expect(geo.scrollTop).toBe(100)
    expect(pill()).not.toBeNull()
  })
})

/*
 * ── CSS 的事实:出场与展开的形 ────────────────────────────────────────────
 * jsdom 不排版也不算层叠,所以这几条按 `.entry[data-removed]` 那条判例的办法读
 * 样式表原文。**先剥注释** —— 病历文本里出现同样的字会让断言自红(既有判例)。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const readCss = (rel: string) =>
  readFileSync(path.join(here, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('出场:事后出现的那一行三量一起过渡', () => {
  const css = readCss('../ChatStream.module.css')

  it('.rowLate 把高度 / 行距 / 不透明度串在同一条过渡上', () => {
    const rule = css.match(/\.rowLate\s*\{([^}]*)\}/)
    expect(rule?.[1]).toContain('interpolate-size: allow-keywords')
    expect(rule?.[1]).toContain('height: auto')
    expect(rule?.[1]).toContain('height var(--dur-release)')
    expect(rule?.[1]).toContain('margin-block-start var(--dur-release)')
    expect(rule?.[1]).toContain('opacity var(--dur-release)')
  })

  it('起手那一格由顶层 @starting-style 给(挂载那一刻没有「改前」高度可量)', () => {
    const at = css.match(/@starting-style\s*\{\s*\.rowLate\s*\{([^}]*)\}/)
    expect(at?.[1]).toContain('height: 0')
    expect(at?.[1]).toContain('margin-block-start: calc(-1 * var(--sp-6))')
    expect(at?.[1]).toContain('opacity: 0')
  })

  it('折痕自己的皮肤里没有出场动效了 —— 出场是「那一行」的事', () => {
    expect(readCss('../ContextDeltaSeam.module.css')).not.toContain('animation:')
  })
})

describe('展开:正文自上向下推开', () => {
  const css = readCss('../seam/Seam.module.css')
  const body = css.match(/\.seamBody\s*\{([^}]*)\}/)?.[1] ?? ''

  it('.seamBody 走高度过渡,不再是整块淡入', () => {
    expect(body).toContain('interpolate-size: allow-keywords')
    expect(body).toContain('height: auto')
    expect(body).toContain('height var(--dur-release)')
    expect(body).toContain('padding-block var(--dur-release)')
    expect(body).not.toContain('animation:')
  })

  it('起手高度与内衬都从 0 起(否则一上来就有一格空盒子撑着)', () => {
    const at = css.match(/@starting-style\s*\{\s*\.seamBody\s*\{([^}]*)\}/)
    expect(at?.[1]).toContain('height: 0')
    expect(at?.[1]).toContain('padding-block: 0')
    expect(at?.[1]).toContain('opacity: 0')
  })
})
