// @vitest-environment happy-dom
/**
 * The renderer half of the quote-reply chain (W7 §3.5 A): the snapshot the
 * composer built has to reach the `command:send-message` envelope, because
 * that envelope is what the engine persists from. A drop here would look
 * exactly like a working feature until the message came back without its
 * quote.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getSessions: vi.fn(async () => ({ success: true, sessions: [] })),
  getSettings: vi.fn(async () => ({ success: true, settings: {} })),
}))

// 命令总线是 `session-command` RPC 域(结构债 P4c 第四批),不再是 platformApi 上的属性。
const sessionCommands = vi.hoisted(() => ({
  emit: vi.fn(async (_request: { sessionId: string; command: Record<string, unknown> }) => ({ success: true })),
}))

vi.mock('@/platform', () => ({ platformApi: api }))
vi.mock('@/platform/session-command-client', () => ({ sessionCommands }))

// The send path resolves the picker's provider through the sibling stores;
// they are not what this test is about (and settings reaches for browser
// storage on init), so they answer with the neutral shape.
vi.mock('../sessions', () => ({
  useSessionsStore: () => ({
    isNewChatDraftId: () => false,
    getSessionItem: () => undefined,
  }),
}))

vi.mock('../settings', () => ({
  useSettingsStore: () => ({ settings: {} }),
}))

import { useChatStore } from '../chat'

const REPLY_TO = { messageId: 'm1', authorLabel: '阿明', excerpt: '我建议先做接口' }

beforeEach(() => {
  setActivePinia(createPinia())
  sessionCommands.emit.mockClear()
})

describe('chatStore.sendMessage — replyTo passthrough', () => {
  it('puts the snapshot on the send-message command', async () => {
    await useChatStore().sendMessage('room-1', '就按这个来', undefined, { replyTo: REPLY_TO })
    const [{ sessionId, command }] = sessionCommands.emit.mock.calls[0]
    expect(sessionId).toBe('room-1')
    expect(command.type).toBe('command:send-message')
    expect(command.replyTo).toEqual(REPLY_TO)
  })

  it('leaves the key off an ordinary send', async () => {
    await useChatStore().sendMessage('chat-1', '你好')
    const [{ command }] = sessionCommands.emit.mock.calls[0]
    expect('replyTo' in command).toBe(false)
  })
})
