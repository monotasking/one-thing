/**
 * W18 — the agent execution session, at the store boundary.
 *
 * What only an app-layer test can pin down: the ensure is idempotent (one
 * session per agent, forever), it is created HIDDEN (the scheduler's archived
 * precedent, so no list has to learn a new rule), the current-session pointer
 * survives it (creating a session moves it — the user's active tab must not be
 * yanked), and the room pointer is rewritten only when the drive actually moved
 * to another room.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSession {
  id: string
  name: string
  kind?: string
  agentId?: string
  isArchived?: boolean
  archivedAt?: number
  collab?: { roomSessionId?: string }
  messages: unknown[]
}

const AGENTS: Record<string, { id: string; name: string }> = {
  fe: { id: 'fe', name: '小李' },
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  currentSessionId: 'chat-user-was-here',
  created: [] as string[],
  collabWrites: [] as Array<{ id: string; fields: unknown }>,
}))

vi.mock('../../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  updateSessionWorkingDirectory: vi.fn(),
  getSession: (id: string) => mocks.sessions.get(id),
  createSession: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    // The real store moves the pointer at creation — that is the whole reason
    // the caller has to restore it.
    mocks.currentSessionId = id
    return session
  },
  // 幕后建会话走"不动 current 指针"的那个变体:真实 store 里它建完把指针原样
  // 还原,所以这里就是"会话建了、指针没动"。
  createSessionWithoutFocus: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    return session
  },
  getCurrentSessionId: () => mocks.currentSessionId,
  setCurrentSessionId: (id: string) => { mocks.currentSessionId = id },
  updateSessionArchived: (id: string, archived: boolean, at?: number) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return
    session.isArchived = archived
    session.archivedAt = at ?? undefined
  },
  updateSessionAgent: (id: string, agentId: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return false
    session.agentId = agentId
    return true
  },
  updateSessionCollab: (
    id: string,
    fields: { kind?: string | null; collab?: { roomSessionId?: string } | null },
  ) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return false
    mocks.collabWrites.push({ id, fields })
    if (fields.kind !== undefined) session.kind = fields.kind ?? undefined
    if (fields.collab !== undefined) session.collab = fields.collab ?? undefined
    return true
  },
}))

vi.mock('../../agents/index.js', () => ({ findAgent: (id: string) => AGENTS[id] ?? null }))

const { ensureCollabAgentSession, getCollabAgentSessionRoom } = await import('../agent-session.js')

const AGENT_SESSION = 'agent-exec-fe-room-1'

function session(): FakeSession {
  return mocks.sessions.get(AGENT_SESSION) as FakeSession
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.created.length = 0
  mocks.collabWrites.length = 0
  mocks.currentSessionId = 'chat-user-was-here'
})

describe('ensureCollabAgentSession', () => {
  it('creates one hidden, agent-bound session and points it at the room', () => {
    expect(ensureCollabAgentSession('fe', 'room-1')).toBe(AGENT_SESSION)
    expect(session()).toMatchObject({
      id: AGENT_SESSION,
      name: '[执行] 小李',
      kind: 'agent',
      agentId: 'fe',
      isArchived: true,
      collab: { roomSessionId: 'room-1' },
    })
  })

  it('is idempotent — the same agent never gets a second session', () => {
    ensureCollabAgentSession('fe', 'room-1')
    ensureCollabAgentSession('fe', 'room-1')
    ensureCollabAgentSession('fe', 'room-1')
    expect(mocks.created).toEqual([AGENT_SESSION])
    // …and a repeat drive into the same room writes nothing at all.
    expect(mocks.collabWrites).toHaveLength(1)
  })

  it('restores the current-session pointer the creation moved', () => {
    ensureCollabAgentSession('fe', 'room-1')
    expect(mocks.currentSessionId).toBe('chat-user-was-here')
  })

  it('gives another room its OWN session instead of repointing this one', () => {
    // collab-team-v2 §1.1:房间进了 id,指针因此只写一次、永不改写。W18 锁注释
    // 里那三类事故中的「指针被后到者写坏」在结构上消失——两个群各有一条会话,
    // 没有可争的指针。
    ensureCollabAgentSession('fe', 'room-1')
    ensureCollabAgentSession('fe', 'room-2')
    expect(mocks.created).toEqual([AGENT_SESSION, 'agent-exec-fe-room-2'])
    expect(getCollabAgentSessionRoom(AGENT_SESSION)).toBe('room-1')
    expect(getCollabAgentSessionRoom('agent-exec-fe-room-2')).toBe('room-2')
    // 归属标记恒定:room-1 那条会话的指针没有被 room-2 的驱动碰过。
    expect(session().collab).toEqual({ roomSessionId: 'room-1' })
  })

  it('re-asserts hidden + kind on a session that lost them', () => {
    ensureCollabAgentSession('fe', 'room-1')
    session().isArchived = false
    session().kind = undefined
    ensureCollabAgentSession('fe', 'room-1')
    expect(session().isArchived).toBe(true)
    expect(session().kind).toBe('agent')
  })

  it('has no session for an unknown agent', () => {
    expect(ensureCollabAgentSession('ghost', 'room-1')).toBeNull()
    expect(mocks.created).toEqual([])
  })
})

describe('getCollabAgentSessionRoom', () => {
  it('answers only for execution sessions', () => {
    mocks.sessions.set('work-1', {
      id: 'work-1',
      name: '[任务]',
      kind: 'work',
      collab: { roomSessionId: 'room-1' },
      messages: [],
    } satisfies FakeSession)
    expect(getCollabAgentSessionRoom('work-1')).toBeUndefined()
    expect(getCollabAgentSessionRoom('nope')).toBeUndefined()
  })
})
