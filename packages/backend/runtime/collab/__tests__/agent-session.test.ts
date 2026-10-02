/**
 * W18 Agent 执行会话 — the pure half.
 *
 * Three rules with no store behind them, and each is load-bearing:
 *  - the execution session id is DERIVED from the agent id, so "ensure" is
 *    idempotent across restarts without a registry to keep in sync;
 *  - `say` picks its room by a fixed priority (explicit → the room this session
 *    is bound to → the session itself when it IS a room);
 *  - the room response turn's tool surface follows the TURN, so an execution
 *    session gets the same replacement surface a room turn always had.
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_AGENT_SESSION_PREFIX,
  COLLAB_ROOM_TOOLS,
  collabAgentSessionId,
  collabAgentSessionName,
  isCollabAgentSessionId,
  resolveCollabSayRoomSessionId,
  stripCollabAgentSessionName,
} from '../index.js'
// 工具面的唯一实现在 agents 层(C2「工具面单点」):collab 只出地板表,
// 「这一回合能用哪些工具」由 resolveAgentToolSurface 一处作答。
import { resolveAgentToolSurface } from '../../agents/profile.js'

describe('执行会话 id 派生', () => {
  it('derives a stable id from the agent id (ensure is idempotent by construction)', () => {
    expect(collabAgentSessionId('fe')).toBe(`${COLLAB_AGENT_SESSION_PREFIX}fe`)
    expect(collabAgentSessionId('fe')).toBe(collabAgentSessionId('  fe  '))
    expect(collabAgentSessionId('pm')).not.toBe(collabAgentSessionId('fe'))
  })

  it('has no session for a missing agent id', () => {
    expect(collabAgentSessionId('')).toBeNull()
    expect(collabAgentSessionId('   ')).toBeNull()
  })

  it('recognises its own ids without touching the store', () => {
    expect(isCollabAgentSessionId(collabAgentSessionId('fe')!)).toBe(true)
    expect(isCollabAgentSessionId('room-1')).toBe(false)
    expect(isCollabAgentSessionId(undefined)).toBe(false)
  })

  it('names the hidden session after the agent', () => {
    expect(collabAgentSessionName('小李')).toBe('[执行] 小李')
    expect(collabAgentSessionName('')).toBe('[执行] Agent')
  })

  // W20: the sidebar's Agent group shows the agent's own name, so the badge
  // has to come back off — from the one place that knows how it went on.
  it('takes the badge back off (round-trip), and leaves an unbadged name alone', () => {
    expect(stripCollabAgentSessionName(collabAgentSessionName('小李'))).toBe('小李')
    expect(stripCollabAgentSessionName('小李')).toBe('小李')
    expect(stripCollabAgentSessionName(collabAgentSessionName(''))).toBe('Agent')
    expect(stripCollabAgentSessionName(undefined)).toBe('')
    expect(stripCollabAgentSessionName('  ')).toBe('')
  })
})

describe('say 的房间路由(三级优先级)', () => {
  const base = { sessionId: 'agent-exec-fe' }

  it('takes an explicit room over everything else', () => {
    expect(resolveCollabSayRoomSessionId({
      ...base,
      kind: 'agent',
      requestedRoomSessionId: 'room-2',
      linkedRoomSessionId: 'room-1',
    })).toBe('room-2')
  })

  it('falls back to the room the session is bound to (the drive target / parent room)', () => {
    expect(resolveCollabSayRoomSessionId({
      ...base,
      kind: 'agent',
      linkedRoomSessionId: 'room-1',
    })).toBe('room-1')
    expect(resolveCollabSayRoomSessionId({
      sessionId: 'work-1',
      kind: 'work',
      linkedRoomSessionId: 'room-1',
    })).toBe('room-1')
  })

  it('lets a room session speak into itself (pre-W18 in-room turns)', () => {
    expect(resolveCollabSayRoomSessionId({ sessionId: 'room-1', kind: 'room' })).toBe('room-1')
  })

  it('has nowhere to speak when nothing names a room', () => {
    expect(resolveCollabSayRoomSessionId({ sessionId: 'chat-1', kind: 'chat' })).toBeNull()
    expect(resolveCollabSayRoomSessionId({ ...base, kind: 'agent' })).toBeNull()
    // Blank strings are not a target — they must not shadow the next source.
    expect(resolveCollabSayRoomSessionId({
      ...base,
      kind: 'agent',
      requestedRoomSessionId: '   ',
      linkedRoomSessionId: 'room-1',
    })).toBe('room-1')
  })
})

describe('工具面跟着回合走', () => {
  it('gives an execution session the room surface — own tools plus say + board', () => {
    // Union(2026-07-30 收紧同日撤销):白名单叠加 say/board,没配则不限制。
    // D6-a:v3 的心智回合跑在这个 kind 上,所以地板比房面多一格笔记。
    expect(resolveAgentToolSurface({ sessionKind: 'agent', ownTools: ['read'] }))
      .toEqual(['read', ...COLLAB_ROOM_TOOLS, 'notebook'])
    // 'agent' and 'room' mean the same thing here — the surface follows the
    // turn, not the session that stores the messages.
    expect(resolveAgentToolSurface({ sessionKind: 'agent' }))
      .toEqual(resolveAgentToolSurface({ sessionKind: 'room' }))
  })

  it('leaves work sessions and ordinary sessions untouched', () => {
    expect(resolveAgentToolSurface({ sessionKind: 'work', ownTools: ['read'] }))
      .toEqual(['read', 'board', 'send_message', 'notebook'])
    expect(resolveAgentToolSurface({ sessionKind: 'chat', ownTools: null })).toBeNull()
  })
})
