/**
 * A3(M6):在场推导走真 sessions store 的集成测试。
 *
 * 规则本身在产品层 presence 的测试里;这里只盯装配面:元数据取对了没有
 * (kind/agentId/collab/room 四个字段真的从索引里出来),以及
 * `hasAnyReference` 的取反没写反。每个用例一套隔离的 store 根(临时 HOME +
 * resetModules),沿用 stores/__tests__/sessions-collab-turn.test.ts 的手法。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../../../stores/sessions.js') | null = null

interface IsolatedModules {
  sessions: typeof import('../../../stores/sessions.js')
  presence: typeof import('../presence.js')
}

async function loadIsolated(): Promise<IsolatedModules> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../../../stores/sessions.js')
  const presence = await import('../presence.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  return { sessions, presence }
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-agent-presence-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('listAgentPresence(真 store)', () => {
  it('从会话索引里现算四路', async () => {
    const { sessions, presence } = await loadIsolated()

    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe', 'pm'] } })

    sessions.createSession('agent-exec-fe-room-1', '[执行] 小李')
    sessions.updateSessionCollab('agent-exec-fe-room-1', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1' },
    })
    sessions.updateSessionAgent('agent-exec-fe-room-1', 'fe')

    sessions.createSession('work-1', '[任务] 加 status.txt')
    sessions.updateSessionCollab('work-1', {
      kind: 'work',
      collab: { roomSessionId: 'room-1', taskId: 't-1' },
    })
    sessions.updateSessionAgent('work-1', 'fe')

    // 无关:普通直聊 + 别人的执行会话
    sessions.createSession('chat-1', '随便聊聊')
    sessions.updateSessionAgent('chat-1', 'fe')
    sessions.createSession('agent-exec-pm-room-1', '[执行] 小王')
    sessions.updateSessionCollab('agent-exec-pm-room-1', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1' },
    })
    sessions.updateSessionAgent('agent-exec-pm-room-1', 'pm')

    expect(presence.listAgentPresence('fe')).toEqual({
      dmRoomId: null,
      roomSessionIds: ['room-1'],
      execSessionIds: ['agent-exec-fe-room-1'],
      workSessionIds: ['work-1'],
    })
  })

  it('执行会话被 isArchived 藏起来也照样算得到(在场 ≠ 可见)', async () => {
    const { sessions, presence } = await loadIsolated()

    // 生产里的常驻会话就是这么建的(app/collab/agent-session.ts:归档即隐藏)。
    sessions.createSession('agent-exec-fe-room-1', '[执行] 小李')
    sessions.updateSessionCollab('agent-exec-fe-room-1', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1' },
    })
    sessions.updateSessionAgent('agent-exec-fe-room-1', 'fe')
    sessions.updateSessionArchived('agent-exec-fe-room-1', true, Date.now())

    expect(presence.listAgentPresence('fe').execSessionIds).toEqual(['agent-exec-fe-room-1'])
  })

  it('一个 agent 在多群 → 多条执行会话(collab-team-v2 拓扑)', async () => {
    const { sessions, presence } = await loadIsolated()

    for (const roomSessionId of ['room-1', 'room-2']) {
      sessions.createSession(roomSessionId, `群 ${roomSessionId}`)
      sessions.updateSessionCollab(roomSessionId, { kind: 'room', room: { memberAgentIds: ['fe'] } })
      const execId = `agent-exec-fe-${roomSessionId}`
      sessions.createSession(execId, '[执行] 小李')
      sessions.updateSessionCollab(execId, { kind: 'agent', collab: { roomSessionId } })
      sessions.updateSessionAgent(execId, 'fe')
    }

    const result = presence.listAgentPresence('fe')
    expect([...result.roomSessionIds].sort()).toEqual(['room-1', 'room-2'])
    expect([...result.execSessionIds].sort()).toEqual(['agent-exec-fe-room-1', 'agent-exec-fe-room-2'])
  })

  it('空 store / 未知 agent → 四路全空', async () => {
    const { presence } = await loadIsolated()
    expect(presence.listAgentPresence('ghost')).toEqual({
      dmRoomId: null,
      roomSessionIds: [],
      execSessionIds: [],
      workSessionIds: [],
    })
  })
})

describe('hasAnyReference(A2 硬删 vs 退休的依赖)', () => {
  it('有房间成员引用 = 被引用', async () => {
    const { sessions, presence } = await loadIsolated()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })

    expect(presence.hasAnyReference('fe')).toBe(true)
    expect(presence.hasAnyReference('pm')).toBe(false)
  })

  it('只有执行会话也算被引用', async () => {
    const { sessions, presence } = await loadIsolated()
    sessions.createSession('agent-exec-fe-room-1', '[执行] 小李')
    sessions.updateSessionCollab('agent-exec-fe-room-1', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1' },
    })
    sessions.updateSessionAgent('agent-exec-fe-room-1', 'fe')

    expect(presence.hasAnyReference('fe')).toBe(true)
  })

  it('直聊会话绑着它也算被引用(在场四路看不见的那一格)', async () => {
    // 履历四栏按定义不认 kind='chat',但那条会话的 agentId 就是它的 persona
    // 绑定,整段转录的署名都指着这个 id —— 按在场面判定会把它当"从未被引用"删掉。
    const { sessions, presence } = await loadIsolated()
    sessions.createSession('chat-1', '随便聊聊')
    sessions.updateSessionAgent('chat-1', 'fe')

    expect(presence.listAgentPresence('fe')).toMatchObject({
      dmRoomId: null,
      roomSessionIds: [],
      execSessionIds: [],
      workSessionIds: [],
    })
    expect(presence.hasAnyReference('fe')).toBe(true)
  })

  it('从未被引用过的 agent → false(A2 才允许对它硬删)', async () => {
    const { sessions, presence } = await loadIsolated()
    sessions.createSession('chat-1', '随便聊聊')

    expect(presence.hasAnyReference('fe')).toBe(false)
    expect(presence.hasAnyReference('')).toBe(false)
    expect(presence.hasAnyReference(undefined)).toBe(false)
  })
})
