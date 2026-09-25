import { describe, expect, it, vi } from 'vitest'
import { applySessionUpdate, createAcpSessionState } from '@onething/runtime/acp/session-state'
import type { AcpSessionState } from '@onething/runtime/acp'
import type { SessionTitleSource } from '@shared/ipc/chat.js'
import { AcpTitleProjection } from '../title-projection.js'

/**
 * agent 起的标题 → 会话名(A2-b)。判据只有一格:`titleSource === 'user'` 的会话不动;缺席当作自动。
 */

type Update = Parameters<typeof applySessionUpdate>[1]

function titled(title: string | null, localSessionId = 's1'): AcpSessionState {
  const base = createAcpSessionState({ localSessionId, agentId: 'fake', acpSessionId: 'acp-1' })
  return applySessionUpdate(base, { sessionUpdate: 'session_info_update', title } as unknown as Update)
}

function harness(sessions: Record<string, { name?: string; titleSource?: SessionTitleSource }>) {
  const rename = vi.fn((sessionId: string, title: string) => {
    sessions[sessionId] = { ...sessions[sessionId], name: title, titleSource: 'auto' }
  })
  const projection = new AcpTitleProjection({ getSession: id => sessions[id], rename })
  return { projection, rename, sessions }
}

describe('AcpTitleProjection', () => {
  it('renames an auto-titled (or never-titled) session to the agent title', () => {
    const { projection, rename, sessions } = harness({ s1: { name: 'New Chat' }, s2: { name: 'Old auto', titleSource: 'auto' } })
    projection.observe(titled('Fix the login bug'))
    projection.observe(titled('Refactor search', 's2'))
    expect(rename).toHaveBeenCalledWith('s1', 'Fix the login bug')
    expect(rename).toHaveBeenCalledWith('s2', 'Refactor search')
    expect(sessions.s1).toEqual({ name: 'Fix the login bug', titleSource: 'auto' })
  })

  it('never overwrites a session the user renamed', () => {
    const { projection, rename, sessions } = harness({ s1: { name: 'My own name', titleSource: 'user' } })
    projection.observe(titled('Agent title'))
    expect(rename).not.toHaveBeenCalled()
    expect(sessions.s1.name).toBe('My own name')
  })

  it('skips the same title, an empty / cleared title and an unknown session', () => {
    const { projection, rename } = harness({ s1: { name: 'Same' } })
    projection.observe(titled('Same'))
    projection.observe(titled('  '))
    projection.observe(titled(null))
    projection.observe(titled('Ghost', 'nope'))
    expect(rename).not.toHaveBeenCalled()

    projection.observe(titled('Next'))
    projection.observe(titled('Next'))
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('stops after dispose', () => {
    const { projection, rename } = harness({ s1: { name: 'New Chat' } })
    projection.dispose()
    projection.observe(titled('Late'))
    expect(rename).not.toHaveBeenCalled()
  })
})
