import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatStream } from '../../ChatStream'
import { elapsedSeconds } from '../StreamReadout'
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
  }
}

async function mount(ledger: Ledger[]) {
  configureChatPort(port(ledger))
  useExposeStore.setState({ currentSessionId: SESSION })
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream />)
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
  it('流式中:读数行在场,动作行不在', async () => {
    await mount(streamingLedger())
    expect(screen.getByTestId('chat-readout')).toBeTruthy()
    expect(screen.getByTestId('chat-stop')).toBeTruthy()
    expect(screen.queryByTestId('chat-actions')).toBeNull()
  })

  it('读数行说的那句话是「正在生成 · {耗时}s」', async () => {
    await mount(streamingLedger(Date.now() - 2_000))
    expect(screen.getByTestId('chat-readout').textContent).toMatch(/^正在生成 · \d+\.\ds停止$/)
  })

  it('完成后:读数行退场,动作行接位(复制 / 重试)', async () => {
    await mount(settledLedger())
    expect(screen.queryByTestId('chat-readout')).toBeNull()
    const actions = screen.getByTestId('chat-actions')
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

describe('⑦ 耗时的口径', () => {
  it('从给定起点算,一位小数', () => {
    expect(elapsedSeconds(T0, T0 + 2_345)).toBe('2.3')
    expect(elapsedSeconds(T0, T0)).toBe('0.0')
  })

  it('时钟回拨 / 未来时刻按 0 算,不显示负数', () => {
    expect(elapsedSeconds(T0, T0 - 5_000)).toBe('0.0')
  })
})
