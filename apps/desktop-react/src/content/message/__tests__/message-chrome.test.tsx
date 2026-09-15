import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatStream } from '../../ChatStream'
import { elapsedMs, readoutTone } from '../StreamReadout'
import { STALL_HARD_MS, STALL_SOFT_MS } from '../../../components/motion'
import { configureChatPort, type ChatPort } from '../../../data/chat-port'
import { useChatSource } from '../../../data/chat-source'
import { configureComposerSink } from '../../../composer/sink'
import { useExposeStore } from '../../../expose/store'
import { useStageStore } from '../../../stage/store'

/**
 * 流式台一「安静编辑器」+ 幽灵动作行(08-31 拍板)的门。
 *
 * 契约逐条:
 *  ① 流式中 = 读数行在场(正在生成 · {耗时}s + 停止),**动作行不在**;
 *  ② 完成后 = 读数行退场,动作行接位;
 *  ③ 动作行是**幽灵**:常驻占位,只动 opacity,悬停整条消息或焦点进来才浮现;
 *  ④ 停止走 composer 那条 sink(同一条通道,不新开);
 *  ⑤ 重试真的发出 `command:retry-message`,带的是这条消息的 id;
 *  ⑥ 复制进的是**折叠产物上的正文**(含代码围栏原文),不是从 DOM 里抠的字;
 *  ⑦ 耗时的口径 = `run/start` 的时刻(消息的 timestamp),不是壳自己起的表。
 *
 * ③ 读的是 CSS 文本 —— jsdom 不跑 CSS Modules 的样式表(同 prose-rhythm 的判例)。
 */

const T0 = 1_700_000_000_000
const SESSION = 's-chrome'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (seq: number): Ledger => ({
  seq,
  time: T0,
  type: 'session/created',
  data: { sessionId: SESSION },
})
const userMessage = (seq: number, id: string, content: string): Ledger => ({
  seq,
  time: T0,
  type: 'user/message',
  data: { message: { id, role: 'user', content, timestamp: T0 } },
})
const runStart = (seq: number, runId: string, assistantMessageId: string, at = T0): Ledger => ({
  seq,
  time: at,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId, timestamp: at },
})
const chunks = (seq: number, runId: string, messageId: string, text: string[]): Ledger => ({
  seq,
  time: T0,
  type: 'assistant/chunks',
  data: {
    runId,
    requestIndex: 0,
    messageId,
    partIndex: 0,
    kind: 'text',
    time0: T0,
    dt: text.map((_, i) => i),
    text,
  },
})
const runEnd = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/end',
  data: { runId, outcome: 'completed' },
})

const retried: Array<{ sessionId: string; messageId: string }> = []

function port(ledger: Ledger[]): ChatPort {
  return {
    ready: async () => undefined,
    /*
     * 页那条路在这只假端口上**说不**(工单 5 ③)—— 于是这一台退回整份账本,
     * 也就是这些用例本来就在测的那条路。假端口给一份空页会把树画成空的,
     * 那是造事实;说不才是它此刻的真话。
     */
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async (sessionId, messageId) => {
      retried.push({ sessionId, messageId })
      return { success: true }
    },
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  }
}

async function mount(ledger: Ledger[]) {
  configureChatPort(port(ledger))
  useExposeStore.setState({ currentSessionId: SESSION })
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream sessionId={SESSION} />)
  })
  await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
  return view
}

/** 一轮**还在跑**的对话(有 run/start、没有 run/end)。 */
const streamingLedger = (at = T0): Ledger[] => [
  created(1),
  userMessage(2, 'm1', '你好'),
  runStart(3, 'r1', 'a1', at),
  chunks(4, 'r1', 'a1', ['好的,我', '来看看']),
]

/** 同一轮,收摊了。 */
const settledLedger = (): Ledger[] => [...streamingLedger(), runEnd(5, 'r1')]

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useChatSource.getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
  retried.length = 0
})

afterEach(async () => {
  await act(async () => {
    useChatSource.getState().reset()
  })
  configureChatPort(undefined)
  configureComposerSink(undefined)
})

describe('① / ② 同一个位置,永远只有一个在', () => {
  /**
   * **2026-09-15 单 B ⑤ 改的就是这一条的后半句。**
   *
   * 从前它写的是「动作行**不在**」—— 条件渲染,于是收尾那一帧卸掉读数行、挂上
   * 动作行,两者高度不同,内容缩一截、贴着底的页面被钳一下 `scrollTop`
   * (单 A 的门量到 12px)。现在两张脸**同格同高**:动作行常驻在 DOM 里,
   * 流式中只是 `opacity: 0` + `inert`。所以判据从「在不在 DOM 里」换成
   * **「哪张脸亮着」**(`data-face`)与**「暗的那张点不动也念不到」**(`inert`)。
   */
  it('流式中:读数行亮着,动作行在同一格里暗着(inert)', async () => {
    await mount(streamingLedger())
    expect(screen.getByTestId('chat-readout')).toBeTruthy()
    expect(screen.getByTestId('chat-stop')).toBeTruthy()
    expect(screen.getByTestId('chat-chrome').getAttribute('data-face')).toBe('readout')
    // 动作行在 DOM 里(这一格的高由它说了算),但这一刻不许被 Tab 走到、不许被念到。
    const actions = screen.getByTestId('chat-actions')
    expect(actions.closest('[inert]')).toBeTruthy()
  })

  it('读数行说的那句话是「正在生成 · {耗时}」(单位由 formatDuration 带出来)', async () => {
    await mount(streamingLedger(Date.now() - 2_000))
    expect(screen.getByTestId('chat-readout').textContent).toMatch(/^正在生成 · \d+\.\ds停止$/)
    // 阈值以内 = 在流那一档,读数行不说静默也不说「可能卡住了」。
    expect(screen.getByTestId('chat-readout').getAttribute('data-tone')).toBe('live')
  })

  it('完成后:读数行退场,动作行接位(复制 / 重试)', async () => {
    await mount(settledLedger())
    // 读数行**真的卸载**(它身上挂着一只 100ms 的表,常驻就是按会话长度计价)——
    // 高度稳定靠的是动作行那一张常驻,判词在 `MessageChrome.tsx`。
    expect(screen.queryByTestId('chat-readout')).toBeNull()
    expect(screen.getByTestId('chat-chrome').getAttribute('data-face')).toBe('actions')
    const actions = screen.getByTestId('chat-actions')
    expect(actions.closest('[inert]')).toBeNull()
    expect(actions.textContent).toContain('复制')
    expect(actions.textContent).toContain('重试')
  })

  it('用户消息没有动作行(编辑重发是另一件事,留账)', async () => {
    const { container } = await mount(settledLedger())
    const user = container.querySelector('[data-role="user"]')
    expect(user?.querySelector('[data-testid="chat-actions"]')).toBeNull()
  })
})

describe('③ 幽灵:常驻占位,只动 opacity', () => {
  const css = readFileSync(path.resolve(__dirname, '../MessageChrome.module.css'), 'utf-8')
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('常态 opacity:0,浮现走 --dur-hover-fade', () => {
    expect(rules).toMatch(/\.actions\s*\{[^}]*opacity:\s*0/)
    expect(rules).toMatch(/\.actions\s*\{[^}]*transition:\s*opacity\s+var\(--dur-hover-fade\)/)
  })

  it('判据是**整条消息**的 hover,外加 focus-within(键盘也算在看)', () => {
    expect(rules).toMatch(/\[data-message-id\]:hover\s+\.actions/)
    expect(rules).toMatch(/\.actions:focus-within/)
  })

  it('零位移:不许用 display / visibility 藏它(那会在浮现时推走下文)', () => {
    expect(rules).not.toMatch(/\.actions\s*\{[^}]*display:\s*none/)
    expect(rules).not.toMatch(/visibility/)
    // 零底零框:动作行自己不涂底、不描边(底只在字钮的悬停态上,那是"可以点"的回执)。
    expect(rules).not.toMatch(/\.actions\s*\{[^}]*(background|border)/)
  })
})

describe('④⑤⑥ 三颗钮真的接在那三条线上', () => {
  it('停止走 composerSink().abort() —— 同一条通道,不新开', async () => {
    let aborted = 0
    configureComposerSink({
      send: () => true,
      notice: () => undefined,
      abort: () => {
        aborted += 1
      },
      startSession: async () => undefined,
    })
    await mount(streamingLedger())
    fireEvent.click(screen.getByTestId('chat-stop'))
    expect(aborted).toBe(1)
  })

  it('重试发出 command:retry-message,带的是这条消息的 id', async () => {
    await mount(settledLedger())
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-action-retry'))
    })
    await waitFor(() => expect(retried).toHaveLength(1))
    expect(retried[0]).toEqual({ sessionId: SESSION, messageId: 'a1' })
  })

  it('复制进剪贴板的是折叠产物上的整条正文', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    await mount(settledLedger())
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-action-copy'))
    })
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    // 两条 delta 折成的那一整句 —— 不是从 DOM 里抠的字。
    expect(writeText.mock.calls[0][0]).toBe('好的,我来看看')
  })
})

/**
 * 重试钮的禁灰(2026-09-08 事故 ef079fd7)。
 *
 * 事故的形状:一条请求 129 秒零回包,那期间**上一条已经落账的回复**底下那颗重试钮
 * 照常点得动,用户连点了十几下,每一下都变成一条 core 当场答 success 的命令。
 * 所以判据不是「这条消息在不在流」,而是**这条会话的引擎在不在跑** —— 一条早就跑完
 * 的消息底下那颗钮,在别人跑着的时候也不该点得动。
 *
 * 走原生 `disabled`:jsdom 与浏览器一样不给禁着的钮派 click,所以「点不动」与
 * 「点了不派发」是同一条断言的两面。
 */
describe('重试钮:引擎在跑时禁灰', () => {
  /** a1 已经收摊(动作行在场),同一条会话上另起了一轮 r2(引擎在跑)。 */
  const busyAgainLedger = (): Ledger[] => [...settledLedger(), runStart(6, 'r2', 'a2')]

  it('引擎闲着:钮点得动', async () => {
    await mount(settledLedger())
    const button = screen.getByTestId('chat-action-retry') as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  /**
   * **单 B ⑤ 之后这两条要点名是哪一条消息的钮**(2026-09-15)。
   *
   * 这份账本上有两条助手消息:收摊的 a1 与在跑的 a2。从前在跑的那一条**不渲染**
   * 动作行,所以 `screen.getByTestId` 全文唯一;现在两张脸同格同高,a2 那一格里
   * 也有一份(暗着 + `inert`),`getByTestId` 于是撞上两个。
   *
   * 这不是放宽判据,是**把判据说准**:这两条问的从来就是「**a1 那条**的重试钮
   * 禁没禁」,而「全文只有一个」是当时的巧合。
   */
  const actionIn = (messageId: string, testId: string): HTMLButtonElement => {
    const row = document.querySelector(`[data-message-id="${messageId}"]`)
    if (!row) throw new Error(`账本上没有 ${messageId} 这一行`)
    const el = row.querySelector(`[data-testid="${testId}"]`)
    if (!(el instanceof HTMLButtonElement)) throw new Error(`${messageId} 那一行里没有 ${testId}`)
    return el
  }

  it('引擎在跑:钮禁着,点下去一条命令都不发', async () => {
    await mount(busyAgainLedger())
    const button = actionIn('a1', 'chat-action-retry')
    expect(button.disabled).toBe(true)

    await act(async () => {
      fireEvent.click(button)
    })
    expect(retried).toHaveLength(0)
  })

  it('复制钮不受牵连(禁的是重试这一件事,不是整行)', async () => {
    await mount(busyAgainLedger())
    expect(actionIn('a1', 'chat-action-copy').disabled).toBe(false)
  })

  it('禁灰配方与库件同源:只降透明度,hover 那一格挂 :not(:disabled)', () => {
    const rules = readFileSync(
      path.resolve(__dirname, '../MessageChrome.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rules).toMatch(/\.ghost:disabled\s*\{[^}]*opacity:\s*var\(--btn-disabled-o\)/)
    expect(rules).toMatch(/\.ghost:hover:not\(:disabled\)/)
  })
})

describe('⑦ 耗时的口径', () => {
  /*
   * 09-05:这里量的从此是**毫秒**,不是字符串 —— 怎么写出来收进了
   * `format/quantity.formatDuration`(§5.7 一个产地),它自己那张表在
   * `src/format/__tests__/quantity.test.ts`。这一格只守「量得对不对」。
   */
  it('从给定起点算', () => {
    expect(elapsedMs(T0, T0 + 2_345)).toBe(2_345)
    expect(elapsedMs(T0, T0)).toBe(0)
  })

  it('时钟回拨 / 未来时刻按 0 算,不显示负数', () => {
    expect(elapsedMs(T0, T0 - 5_000)).toBe(0)
  })
})

/**
 * §6.6 活性读数。判据是**静默**不是总耗时:一轮跑十分钟但每秒都在吐字是正常的。
 * 三档由两个阈值切开,阈值的产地是 `components/motion.ts`(拆掉哪一档都会让
 * 「在流」与「卡住」重新长成同一副样子 —— 那正是这一格要治的病)。
 */
describe('§6.6 活性读数:三档', () => {
  it('阈值以内 = 在流;软阈值起 = 静默;硬阈值起 = 可能卡住', () => {
    expect(readoutTone(0)).toBe('live')
    expect(readoutTone(STALL_SOFT_MS)).toBe('live')
    expect(readoutTone(STALL_SOFT_MS + 1)).toBe('stalled')
    expect(readoutTone(STALL_HARD_MS)).toBe('stalled')
    expect(readoutTone(STALL_HARD_MS + 1)).toBe('stuck')
  })
})
