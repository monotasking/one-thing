import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { ChatStream } from '../ChatStream'
import { configureChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { useExposeStore } from '../../expose/store'
import { useStageStore } from '../../stage/store'
import {
  addAgentNotice,
  agentNoticeOfFrame,
  configureAgentNoticesPort,
  NOTICE_CAP,
  receiveAgentNotice,
  startAgentNotices,
  stopAgentNotices,
  useAgentNotices,
} from '../../data/agent-notices-source'

/**
 * agent 发给人的提醒(`agent:notification`,ACP A2-c 壳半边):认形、落表、会话不在屏上
 * 才进通知中心、以及在 `ChatStream` 里按时间插在消息之间的那一行系统行。
 */

const notify = vi.fn()
vi.mock('../../services/notify', () => ({ notify: (draft: unknown) => notify(draft) }))

const T0 = 1_700_000_000_000
const SESSION = 'agent-notice'

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  notify.mockClear()
  stopAgentNotices()
})

afterEach(() => {
  configureAgentNoticesPort(undefined)
  stopAgentNotices()
})

const frame = (patch: Record<string, unknown> = {}) => ({
  type: 'agent:notification',
  sessionId: SESSION,
  agentId: 'fake-agent',
  message: 'tests are green',
  title: 'CI',
  level: 'success',
  at: T0 + 500,
  ...patch,
})

describe('认形:推送面是不可信输入', () => {
  it('三格缺一不认;级别认不出落 info;时刻缺了用收到那一刻', () => {
    expect(agentNoticeOfFrame(frame({ sessionId: '' }))).toBeNull()
    expect(agentNoticeOfFrame(frame({ agentId: 3 }))).toBeNull()
    expect(agentNoticeOfFrame(frame({ message: undefined }))).toBeNull()
    expect(agentNoticeOfFrame(null)).toBeNull()
    expect(agentNoticeOfFrame(frame({ level: 'shout', at: 'x' }), 42)).toMatchObject({ level: 'info', at: 42 })
  })

  it('每条会话至多留 NOTICE_CAP 条,按 at 升序', () => {
    for (let i = 0; i < NOTICE_CAP + 5; i += 1) {
      addAgentNotice({ sessionId: SESSION, agentId: 'a', message: `m${i}`, level: 'info', at: T0 + (NOTICE_CAP + 5 - i) })
    }
    const list = useAgentNotices.getState().bySession[SESSION]!
    expect(list).toHaveLength(NOTICE_CAP)
    expect(list.every((n, i) => i === 0 || list[i - 1].at <= n.at)).toBe(true)
  })
})

describe('两个落点:会话里一行 + 不在屏上才进通知中心', () => {
  it('会话不在屏上 → 落表且 notify(标题 = agent 名 + 它给的标题,正文 = 原话)', () => {
    const entry = receiveAgentNotice(frame(), { isSessionOnScreen: () => false })
    expect(entry).toMatchObject({ sessionId: SESSION, message: 'tests are green' })
    expect(useAgentNotices.getState().bySession[SESSION]).toHaveLength(1)
    expect(notify).toHaveBeenCalledWith({
      level: 'success',
      title: 'fake-agent:CI',
      body: 'tests are green',
      source: 'agent:fake-agent',
    })
  })

  it('会话在屏上 → 只落那一行,不再弹', () => {
    receiveAgentNotice(frame(), { isSessionOnScreen: (id) => id === SESSION })
    expect(useAgentNotices.getState().bySession[SESSION]).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('订阅走端口:起一次(幂等),推一帧就进表', async () => {
    let push: ((data: unknown) => void) | undefined
    const onNotice = vi.fn((cb: (data: unknown) => void) => {
      push = cb
      return () => undefined
    })
    configureAgentNoticesPort({ ready: async () => undefined, onNotice })
    await Promise.all([
      startAgentNotices({ isSessionOnScreen: () => true }),
      startAgentNotices({ isSessionOnScreen: () => true }),
    ])
    expect(onNotice).toHaveBeenCalledTimes(1)
    push?.(frame())
    expect(useAgentNotices.getState().bySession[SESSION]).toHaveLength(1)
  })
})

type Ledger = { seq: number; time: number; type: string; data: unknown }

const LEDGER: Ledger[] = [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId: SESSION } },
  { seq: 2, time: T0, type: 'user/message', data: { message: { id: 'm1', role: 'user', content: '跑一下测试', timestamp: T0 } } },
  { seq: 3, time: T0 + 1000, type: 'user/message', data: { message: { id: 'm2', role: 'user', content: '好了吗', timestamp: T0 + 1000 } } },
]

async function mountStream() {
  configureChatPort({
    ready: async () => undefined,
    readPage: () => Promise.reject(new Error('no page in this fake port')),
    readToolResult: () => Promise.resolve(undefined),
    listRaw: async () => ({ events: [...LEDGER] as never }),
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
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ChatStream sessionId={SESSION} />)
  })
  await waitFor(() => expect(chatSources.ensure(SESSION).getState().status).toBe('ready'))
  return view
}

describe('系统行:按时间插在消息之间', () => {
  beforeEach(() => {
    chatSources.ensure(SESSION).getState().reset()
  })

  it('提醒在两条消息之间到达 → 那一行就在它们之间,不带 data-message-id', async () => {
    const { container } = await mountStream()
    await act(async () => {
      receiveAgentNotice(frame(), { isSessionOnScreen: () => true })
    })
    const row = container.querySelector('[data-agent-notice]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.hasAttribute('data-message-id')).toBe(false)
    expect((row.previousElementSibling as HTMLElement).getAttribute('data-message-id')).toBe('m1')
    expect((row.nextElementSibling as HTMLElement).getAttribute('data-message-id')).toBe('m2')
    // 一句话三格:agent · 它给的标题 · 原话;级别只上图标(数据属性在行上)。
    expect(row.textContent).toContain('fake-agent 的通知')
    expect(row.textContent).toContain('CI')
    expect(row.textContent).toContain('tests are green')
    expect(row.querySelector('[data-level="success"]')).toBeTruthy()
  })

  it('比所有消息都晚 → 排在最后一条消息之后', async () => {
    const { container } = await mountStream()
    await act(async () => {
      receiveAgentNotice(frame({ at: T0 + 9_000 }), { isSessionOnScreen: () => true })
    })
    const row = container.querySelector('[data-agent-notice]') as HTMLElement
    expect((row.previousElementSibling as HTMLElement).getAttribute('data-message-id')).toBe('m2')
  })

  it('别的会话的提醒不进这一条', async () => {
    const { container } = await mountStream()
    await act(async () => {
      receiveAgentNotice(frame({ sessionId: 'other' }), { isSessionOnScreen: () => true })
    })
    expect(container.querySelector('[data-agent-notice]')).toBeNull()
  })
})
