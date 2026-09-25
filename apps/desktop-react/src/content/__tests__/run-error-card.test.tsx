import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'

/**
 * **出错收场的那一轮要上屏**(2026-09-24,ACP「发了没反应」报障)。
 *
 * 账本上 `run/end outcome:error` 带着后端那句原话,投影把它落成 assistant 消息的
 * `errorDetails`;而错误卡那一格从前只认 `role === 'error'`,于是 provider 在第一个
 * 字之前就抛错的那一轮(ACP agent 找不到 / 适配器没装 / 鉴权失败)在屏幕上是一条
 * 空白消息。这里用真机那本账的形状(`0d822b25…` 前 12 行)钉:那句话要原样出现。
 */

const T0 = 1_700_000_000_000
const SESSION = 'run-error-card'
const REASON = 'ACP agent "pi" not found'

type Ledger = { seq: number; time: number; type: string; data: unknown }

function ledger(end: { outcome: string; error?: { name: string; message: string } }): Ledger[] {
  return [
    { seq: 1, time: T0, type: 'session/created', data: { sessionId: SESSION } },
    {
      seq: 2,
      time: T0,
      type: 'user/message',
      data: { message: { id: 'm1', role: 'user', content: 'hi', timestamp: T0 } },
    },
    {
      seq: 3,
      time: T0,
      type: 'run/start',
      data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', provider: 'acp', model: 'pi', timestamp: T0 },
    },
    { seq: 4, time: T0, type: 'run/end', data: { runId: 'r1', ...end } },
  ]
}

const source = () => chatSources.ensure(SESSION)

async function mount(events: Ledger[]) {
  configureChatPort({
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...events] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
    listPendingPermissions: async () => ({ success: true, pending: [] }),
    respondPermission: async () => ({ success: true }),
  })
  useExposeStore.setState({ currentSessionId: SESSION })
  const view = await act(async () => render(<ChatStream sessionId={SESSION} />))
  await waitFor(() => expect(source().getState().status).toBe('ready'))
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  source().getState().reset()
  useExposeStore.setState({ currentSessionId: '' })
})

afterEach(async () => {
  await act(async () => {
    source().getState().reset()
  })
})

describe('出错收场的那一轮', () => {
  it('assistant 消息上的 errorDetails 画成错误卡,后端原话一字不改', async () => {
    await mount(ledger({ outcome: 'error', error: { name: 'Error', message: REASON } }))
    const card = await screen.findByRole('alert')
    expect(card.textContent).toContain(REASON)
    expect(card.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a1')
  })

  it('正常收场的那一轮没有错误卡', async () => {
    await mount(ledger({ outcome: 'completed' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
