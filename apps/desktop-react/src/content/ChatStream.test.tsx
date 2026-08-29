import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from './ChatStream'
import { configureChatPort, type ChatPort } from '../data/chat-port'
import { useChatSource } from '../data/chat-source'
import { useExposeStore } from '../expose/store'
import { useStageStore } from '../stage/store'

/**
 * 组件层只钉「屏幕上到底出现了什么」—— 折叠与尾巴的判据在 data/ 那两只测试里。
 * 素材一律经**真的数据源**进来(端口换成假的),所以这一层顺带证明了
 * 「屏幕上画的就是折叠器的输出」这句话在组件这一端也成立。
 */

const T0 = 1_700_000_000_000
const SESSION = 's1'

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
const toolCall = (seq: number, runId: string, messageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/call',
  data: { runId, messageId, callId: 'c1', name: 'read', argumentsRaw: '{}' },
})
const toolResult = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'tool/result',
  data: { runId, callId: 'c1', isError: false, resultPreview: '读到了', result: { text: '读到了' } },
})

let sendResult: () => Promise<{ success: boolean; error?: string }> = async () => ({ success: true })

function port(ledger: Ledger[]): ChatPort {
  return {
    ready: async () => undefined,
    listRaw: async () => ({ events: [...ledger] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => sendResult(),
  }
}

async function mount(ledger: Ledger[], sessionId = SESSION) {
  configureChatPort(port(ledger))
  useExposeStore.setState({ currentSessionId: sessionId })
  // 起底是异步的(effect → open → listRaw → 按帧推屏),整段包进 act 里等它落定。
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream />)
  })
  if (sessionId) await waitFor(() => expect(useChatSource.getState().status).not.toBe('loading'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useChatSource.getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
  sendResult = async () => ({ success: true })
})

afterEach(async () => {
  // RTL 的自动 cleanup 注册得比这条早,而 afterEach 是后进先出 —— 所以这一句
  // 跑的时候组件还挂着。归零会推一次 state,包进 act 里才不吵 React。
  await act(async () => {
    useChatSource.getState().reset()
  })
  configureChatPort(undefined)
})

describe('空态:三种各说各话,一种都不回退到假数据', () => {
  it('还没有当前会话', async () => {
    await mount([], '')
    expect(screen.getByText('还没有选中会话')).toBeTruthy()
  })

  it('这条会话还没有消息', async () => {
    await mount([created(1)])
    expect(screen.getByText('这条会话还没有消息')).toBeTruthy()
  })

  it('读不到时把后端说的那句话原样摆出来,不回退到 mock', async () => {
    configureChatPort({
      ...port([]),
      listRaw: async () => {
        throw new Error('listRaw 炸了')
      },
    })
    useExposeStore.setState({ currentSessionId: SESSION })
    render(<ChatStream />)
    await waitFor(() => expect(screen.getByText('读不到这条会话')).toBeTruthy())
    expect(screen.getByText('listRaw 炸了')).toBeTruthy()
  })
})

describe('消息树:画的就是折叠器的输出', () => {
  it('角色分侧,每条都挂 data-message-id(TOC 的落点)', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
    ])
    const rows = Array.from(container.querySelectorAll('[data-message-id]'))
    expect(rows.map((row) => row.getAttribute('data-message-id'))).toEqual(['m1', 'a1'])
    expect(rows.map((row) => row.getAttribute('data-role'))).toEqual(['user', 'assistant'])
    expect(screen.getByText('你好')).toBeTruthy()
    expect(screen.getByText('好的')).toBeTruthy()
  })

  it('正文按纯文本画,换行照实保留(富渲染是后批)', async () => {
    await mount([created(1), userMessage(2, 'm1', '第一行\n第二行')])
    const bubble = screen.getByText(/第一行/)
    expect(bubble.textContent).toBe('第一行\n第二行')
  })

  it('工具调用折成一行摘要:工具名 + 状态(参数流还开着就照实说)', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '读一下'),
      runStart(3, 'r1', 'a1'),
      toolCall(4, 'r1', 'a1'),
    ])
    const card = container.querySelector('[data-tool-status]')
    expect(card?.getAttribute('data-tool-status')).toBe('input-streaming')
    // 状态是后端枚举,查字典换成人话。
    expect(card?.textContent).toBe('read参数生成中')
  })

  it('结果回来了 = 已完成 —— 状态照折叠说的走,渲染层不自己判', async () => {
    const { container } = await mount([
      created(1),
      userMessage(2, 'm1', '读一下'),
      runStart(3, 'r1', 'a1'),
      toolCall(4, 'r1', 'a1'),
      toolResult(5, 'r1'),
    ])
    const card = container.querySelector('[data-tool-status]')
    expect(card?.getAttribute('data-tool-status')).toBe('completed')
    expect(card?.textContent).toBe('read已完成')
  })

  it('run 还开着 = 流中态指示在场;收了就没有', async () => {
    await mount([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    expect(screen.getByTestId('chat-streaming')).toBeTruthy()

    await act(async () => {
      useChatSource.setState({ activeMessageId: undefined })
    })
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
  })
})

describe('overlay 车道', () => {
  it('发出去的那条立刻上屏(还没落账,所以是 pending)', async () => {
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().send('刚发的一条')
    })
    expect(screen.getByTestId('chat-pending-sending').textContent).toContain('刚发的一条')
  })

  it('发不出去 = 摆出后端说的理由,给一个重试和一个不发了', async () => {
    sendResult = async () => ({ success: false, error: '引擎没接住' })
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().send('会失败的一条')
    })
    await waitFor(() => expect(screen.getByTestId('chat-pending-failed')).toBeTruthy())
    expect(screen.getByText('引擎没接住')).toBeTruthy()

    fireEvent.click(screen.getByText('不发了'))
    await waitFor(() => expect(screen.queryByTestId('chat-pending-failed')).toBeNull())
  })

  it('拒绝一组问题:进流,但说得轻一点', async () => {
    await mount([created(1)])
    await act(async () => {
      useChatSource.getState().notice('ask-rejected')
    })
    expect(screen.getByText('(拒绝了这组问题)')).toBeTruthy()
  })
})
