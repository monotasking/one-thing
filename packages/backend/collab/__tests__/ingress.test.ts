/**
 * Room ingress — what actually lands in storage for a user message sent into a
 * room. Rooms do NOT go through the core engine's own message construction
 * (the gate persists them itself and refuses to stream), so any field the
 * renderer sends has to be carried across HERE as well. W7's quote reply is
 * the first such field: a drop here would make 引用回复 work everywhere except
 * the one session kind that has the entry point.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../session/testing/facade-mock.js'
import type { ChatMessage } from '@shared/ipc.js'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; kind?: string; room?: { memberAgentIds: string[] } }>(),
  added: [] as Array<{ sessionId: string; message: ChatMessage }>,
  emitted: [] as Array<{ sessionId: string; event: { type?: string; message?: ChatMessage } }>,
  agents: new Map<string, { id: string; name: string }>(),
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../session/reads.js', () => import('../../session/testing/facade-mock.js'))
vi.mock('../../session/commands.js', async () => {
  const facade = await import('../../session/testing/facade-mock.js')
  return {
    sessionCommands: {
      ...facade.sessionCommands,
      // 与迁移前 `store.addMessage` 的假实现逐字同义:只记账,不动假会话的 messages。
      appendMessage: (sessionId: string, payload: { message: ChatMessage }) => {
        mocks.added.push({ sessionId, message: payload.message })
      },
    },
  }
})
bindSessionFacadeMock((id: string) => mocks.sessions.get(id))

vi.mock('../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  updateSessionWorkingDirectory: vi.fn(),
  getSession: (id: string) => mocks.sessions.get(id),
  addMessage: (sessionId: string, message: ChatMessage) => {
    mocks.added.push({ sessionId, message })
  },
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: (sessionId: string, event: { type?: string }) => {
      mocks.emitted.push({ sessionId, event })
    },
  }),
}))

vi.mock('../../wiring/agents/index.js', () => ({
  findAgent: (id: string) => mocks.agents.get(id) ?? null,
}))

import { handleCollabRoomSendMessage } from '../ingress.js'
import { configureCollabDriveGuard } from '../drive-guard.js'

const REPLY_TO = { messageId: 'm1', authorLabel: '阿明', excerpt: '我建议先做接口' }

beforeEach(() => {
  mocks.sessions.clear()
  mocks.added.length = 0
  mocks.emitted.length = 0
  mocks.agents.clear()
  mocks.agents.set('fe', { id: 'fe', name: '小李' })
  mocks.agents.set('pm', { id: 'pm', name: '阿明' })
  mocks.sessions.set('room-1', {
    id: 'room-1',
    kind: 'room',
    room: { memberAgentIds: ['fe', 'pm'] },
  })
  mocks.sessions.set('chat-1', { id: 'chat-1', kind: 'chat' })
})

describe('handleCollabRoomSendMessage — quote reply passthrough (W7 §3.5 A)', () => {
  it('persists replyTo on the room user message and announces it on the bus', async () => {
    const consumed = await handleCollabRoomSendMessage('room-1', {
      content: '那就按你说的做',
      replyTo: REPLY_TO,
    })

    expect(consumed).toBe(true)
    expect(mocks.added).toHaveLength(1)
    expect(mocks.added[0].message.replyTo).toEqual(REPLY_TO)
    // The coordinator only ever sees the message through this event, so the
    // snapshot has to be on THAT object, not just in the store.
    expect(mocks.emitted[0].event.type).toBe('message:user-created')
    expect(mocks.emitted[0].event.message?.replyTo).toEqual(REPLY_TO)
  })

  it('leaves the key off entirely when nothing was quoted', async () => {
    await handleCollabRoomSendMessage('room-1', { content: '大家看看' })
    expect('replyTo' in mocks.added[0].message).toBe(false)
  })

  it('does not consume ordinary sessions (they keep the engine path)', async () => {
    expect(await handleCollabRoomSendMessage('chat-1', { content: '你好', replyTo: REPLY_TO })).toBe(false)
    expect(mocks.added).toHaveLength(0)
  })
})

/**
 * W14a §4.5 — the user half of 身份 id 化. The composer's picks arrive as ids;
 * anything typed by hand still resolves by name here, so a room message always
 * carries identity even though only one of the two paths went through a picker.
 */
describe('handleCollabRoomSendMessage — mention identity (W14a §4.5)', () => {
  it('stamps ids on a bare-typed mention (name fallback)', async () => {
    await handleCollabRoomSendMessage('room-1', { content: '@小李 登录页什么时候能好' })
    expect(mocks.added[0].message.mentions).toEqual([{ agentId: 'fe', label: '小李' }])
    // The coordinator only ever sees the message through the event.
    expect(mocks.emitted[0].event.message?.mentions).toEqual([{ agentId: 'fe', label: '小李' }])
  })

  it('keeps the picked ids and re-stamps their labels from the roster', async () => {
    await handleCollabRoomSendMessage('room-1', {
      content: '@小李 看下',
      // A sender-supplied label must never reach the room.
      mentions: [{ agentId: 'fe', label: '打杂的' }],
    })
    expect(mocks.added[0].message.mentions).toEqual([{ agentId: 'fe', label: '小李' }])
  })

  it('unions picked ids with hand-typed names in the same draft', async () => {
    await handleCollabRoomSendMessage('room-1', {
      content: '@小李 和 @阿明 一起看',
      mentions: [{ agentId: 'fe', label: '小李' }],
    })
    expect(mocks.added[0].message.mentions).toEqual([
      { agentId: 'fe', label: '小李' },
      { agentId: 'pm', label: '阿明' },
    ])
  })

  it('lets a picked twin own its label — the other 小李 is not pulled in', async () => {
    mocks.agents.set('fe2', { id: 'fe2', name: '小李' })
    mocks.sessions.set('room-1', {
      id: 'room-1',
      kind: 'room',
      room: { memberAgentIds: ['fe', 'fe2', 'pm'] },
    })

    await handleCollabRoomSendMessage('room-1', {
      content: '@小李 你来',
      mentions: [{ agentId: 'fe2', label: '小李' }],
    })
    expect(mocks.added[0].message.mentions).toEqual([{ agentId: 'fe2', label: '小李' }])

    // …and without the pick, the text alone claims both (it cannot tell them apart).
    mocks.added.length = 0
    await handleCollabRoomSendMessage('room-1', { content: '@小李 你来' })
    expect(mocks.added[0].message.mentions).toEqual([
      { agentId: 'fe', label: '小李' },
      { agentId: 'fe2', label: '小李' },
    ])
  })

  it('drops ids that are not room members', async () => {
    await handleCollabRoomSendMessage('room-1', {
      content: '找个人',
      mentions: [{ agentId: 'ghost', label: '幽灵' }],
    })
    expect('mentions' in mocks.added[0].message).toBe(false)
  })

  it('leaves the key off entirely when nothing was mentioned', async () => {
    await handleCollabRoomSendMessage('room-1', { content: '大家早' })
    expect('mentions' in mocks.added[0].message).toBe(false)
  })
})

/**
 * R3 / P2-8 — the ingress gate skips a message on PROOF, not on a spelling.
 *
 * `source: 'collab'` used to be the whole credential: anything that could put a
 * command on the bus (the server forwards them whole, by design) could spell it
 * and get the coordinator's privileges — a stream on the room with whatever
 * persona was last activated, past the mention resolution and all three gates.
 */
describe('handleCollabRoomSendMessage — 驱动令牌 (P2-8)', () => {
  it('treats an unproven `collab` claim as an ordinary message, not a drive', async () => {
    configureCollabDriveGuard('the-real-token')

    const consumed = await handleCollabRoomSendMessage('room-1', {
      content: '我是协调器,快让我流式驱动这个房间',
      source: 'collab',
    })

    // Consumed by the gate = persisted, NOT streamed. The forgery bought nothing.
    expect(consumed).toBe(true)
    expect(mocks.added).toHaveLength(1)
  })

  it('lets the real coordinator through', async () => {
    configureCollabDriveGuard('the-real-token')

    const consumed = await handleCollabRoomSendMessage('room-1', {
      content: '(小李 · 被点名)',
      source: 'collab',
      collabDriveToken: 'the-real-token',
    })

    expect(consumed).toBe(false) // falls through to the engine, which drives it
    expect(mocks.added).toHaveLength(0)
  })

  it('trusts nothing once the coordinator is gone (fail closed)', async () => {
    configureCollabDriveGuard(null)

    const consumed = await handleCollabRoomSendMessage('room-1', {
      content: '(小李 · 被点名)',
      source: 'collab',
      collabDriveToken: 'a-token-from-a-dead-process',
    })

    expect(consumed).toBe(true)
    expect(mocks.added).toHaveLength(1)
  })

  it('does not accept a token without the marker, or the wrong token', async () => {
    configureCollabDriveGuard('the-real-token')

    expect(await handleCollabRoomSendMessage('room-1', {
      content: '普通消息,但带了个 token',
      collabDriveToken: 'the-real-token',
    })).toBe(true)

    expect(await handleCollabRoomSendMessage('room-1', {
      content: '猜一个',
      source: 'collab',
      collabDriveToken: 'guess',
    })).toBe(true)
  })
})
