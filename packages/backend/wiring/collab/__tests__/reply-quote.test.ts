/**
 * W13.2 — the app-layer write: patch the snapshot onto an already-persisted
 * reply and broadcast it on the SAME update chain W8's reactions ride.
 *
 * What a pure test cannot reach: the author label comes from the agents store
 * (not from the message), the room guard, and the fact that the broadcast is
 * `message:updated` — the one event the coordinator deliberately does not
 * listen to, so a quote can never open a willingness round.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'

interface FakeMessage {
  id: string
  role: string
  content: string
  agentId?: string
  source?: string
  replyTo?: { messageId: string; authorLabel: string; excerpt: string }
}

const mocks = vi.hoisted(() => ({
  /** 「我的资料」为空 = 全链路回退到「用户」,与今天的行为逐字一致。 */
  settings: { general: {} } as { general: { userProfile?: Record<string, string> } },
  sessions: new Map<string, { id: string; kind?: string; messages: FakeMessage[] }>(),
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  updateMessageReplyTo: vi.fn(),
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', async () => {
  const facade = await import('../../../session/testing/facade-mock.js')
  return {
    sessionCommands: {
      ...facade.sessionCommands,
      // 迁移前这条写走 `store.updateMessageReplyTo`;命令面上它是一次普通 patch。
      patchMessage: (
        sessionId: string,
        payload: { messageId: string; patch: { replyTo?: FakeMessage['replyTo'] } },
      ) => {
        mocks.updateMessageReplyTo(sessionId, payload.messageId, payload.patch.replyTo)
        return facade.sessionCommands.patchMessage(sessionId, payload)
      },
    },
  }
})
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../../store.js', () => ({
  updateSessionWorkingDirectory: vi.fn(),
  // 用户身份现取(agent-dm-user.md §2.2):引用快照的作者行读它。
  getSettings: () => mocks.settings,
  getSession: (id: string) => mocks.sessions.get(id),
  updateMessageReplyTo: (sessionId: string, messageId: string, replyTo: FakeMessage['replyTo']) => {
    mocks.updateMessageReplyTo(sessionId, messageId, replyTo)
    const message = mocks.sessions.get(sessionId)?.messages.find(item => item.id === messageId)
    if (!message) return false
    message.replyTo = replyTo
    return true
  },
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

vi.mock('../../agents/index.js', () => ({
  findAgent: (id: string) => (id === 'fe' ? { id: 'fe', name: '小李' } : null),
}))

const { attachCollabReplyTo } = await import('../reply-quote.js')

const ROOM = 'room-1'

function seed(messages: FakeMessage[], kind = 'room'): void {
  mocks.sessions.set(ROOM, { id: ROOM, kind, messages })
}

/** trigger, one interposed message, then the reply → the gap earns a quote. */
function seedGapped(): void {
  seed([
    { id: 'u1', role: 'user', content: '登录页什么时候能好?' },
    { id: 'a0', role: 'assistant', agentId: 'fe', content: '插一句,接口刚合上' },
    { id: 'd1', role: 'user', content: '(小李 · 被 @ 激活)', source: 'collab' },
    { id: 'a1', role: 'assistant', agentId: 'fe', content: '明天下班前' },
  ])
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.emitted.length = 0
  mocks.updateMessageReplyTo.mockClear()
})

describe('attachCollabReplyTo', () => {
  it('patches the snapshot and broadcasts message:updated', () => {
    seedGapped()
    const snapshot = attachCollabReplyTo(ROOM, 'a1', 'u1')

    expect(snapshot).toEqual({ messageId: 'u1', authorLabel: '用户', excerpt: '登录页什么时候能好?' })
    expect(mocks.updateMessageReplyTo).toHaveBeenCalledWith(ROOM, 'a1', snapshot)
    expect(mocks.emitted).toEqual([{
      sessionId: ROOM,
      event: { type: 'message:updated', messageId: 'a1', updates: { replyTo: snapshot } },
    }])
  })

  it('signs a quoted agent message with its roster name', () => {
    seed([
      { id: 'a0', role: 'assistant', agentId: 'fe', content: '先做接口再做页面' },
      { id: 'u1', role: 'user', content: '收到' },
      { id: 'd1', role: 'user', content: '(阿明 · 主动接话)', source: 'collab' },
      { id: 'a1', role: 'assistant', agentId: 'pm', content: '那我排一下' },
    ])
    expect(attachCollabReplyTo(ROOM, 'a1', 'a0')?.authorLabel).toBe('小李')
  })

  it('writes nothing when the reply is adjacent to its trigger', () => {
    seed([
      { id: 'u1', role: 'user', content: '在吗' },
      { id: 'd1', role: 'user', content: '(小李 · 被 @ 激活)', source: 'collab' },
      { id: 'a1', role: 'assistant', agentId: 'fe', content: '在' },
    ])
    expect(attachCollabReplyTo(ROOM, 'a1', 'u1')).toBeNull()
    expect(mocks.updateMessageReplyTo).not.toHaveBeenCalled()
    expect(mocks.emitted).toEqual([])
  })

  it('writes nothing without a trigger, off a room, or for a missing message', () => {
    seedGapped()
    expect(attachCollabReplyTo(ROOM, 'a1', undefined)).toBeNull()
    expect(attachCollabReplyTo(ROOM, 'a1', 'ghost')).toBeNull()
    expect(attachCollabReplyTo('nope', 'a1', 'u1')).toBeNull()

    seedGapped()
    mocks.sessions.get(ROOM)!.kind = 'chat'
    expect(attachCollabReplyTo(ROOM, 'a1', 'u1')).toBeNull()
    expect(mocks.updateMessageReplyTo).not.toHaveBeenCalled()
  })
})
