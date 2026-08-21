/**
 * W14b 说话即行动 — the epoch marker is stamped where the message is BORN.
 *
 * The room's assistant turn is the agent's thinking record, not its speech, and
 * every consumer (projection, chain, room UI) decides that from the marker. It
 * is written at the store choke point rather than at the coordinator's turn
 * finale so that (a) the room never paints a full bubble that collapses to a
 * hairline a tick later, and (b) a crash mid-turn cannot leave a thinking
 * record impersonating an utterance nobody made.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null

async function loadIsolatedStores(): Promise<typeof import('../sessions.js')> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  return sessions
}

function assistantMessage(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: '先看看排期', timestamp: 1, ...extra }
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-collab-turn-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('room turn epoch marker', () => {
  it('stamps a room turn message as thinking, together with its agentId', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    sessions.addMessage('room-1', assistantMessage('m-1'))

    const stored = sessions.getSession('room-1')?.messages[0]
    expect(stored?.agentId).toBe('fe')
    expect(stored?.source).toBe('collab-turn')
  })

  it('stamps a turn that carries the drive channel envelope — production shape (真机回归)', async () => {
    // The engine copies the DRIVE's origin onto the reply it creates, so every
    // real room turn arrives as origin.source='collab'. That is inbound
    // routing, not an utterance epoch — the stamp must still fire (the guard
    // once treated it as a marker and the whole turn rendered as legacy
    // speech, src=None 满屏).
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    sessions.addMessage('room-1', {
      ...assistantMessage('m-drive-origin'),
      origin: { transport: 'api', source: 'collab', receivedAt: 1 },
    } as never)

    const stored = sessions.getSession('room-1')?.messages[0]
    expect(stored?.source).toBe('collab-turn')
  })

  it('still yields to a REAL epoch marker on the origin axis', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    sessions.addMessage('room-1', {
      ...assistantMessage('m-say-origin'),
      origin: { transport: 'api', source: 'collab-say', receivedAt: 1 },
    } as never)

    const stored = sessions.getSession('room-1')?.messages[0]
    expect(stored?.source).toBeUndefined()
  })

  it('leaves an utterance alone — say writes its own marker and agentId', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    sessions.addMessage('room-1', assistantMessage('m-1', {
      agentId: 'fe',
      content: '明天下班前',
      source: 'collab-say',
    }))

    expect(sessions.getSession('room-1')?.messages[0].source).toBe('collab-say')
  })

  it('stamps an AGENT execution session turn the same way (W18)', async () => {
    // The turn moved out of the room into the agent's own session; the marker
    // moved with it. The whole session is an execution record, and the harvest
    // reads this marker to tell a thinking record from legacy speech.
    const sessions = await loadIsolatedStores()
    sessions.createSession('agent-exec-fe', '[执行] 小李')
    sessions.updateSessionCollab('agent-exec-fe', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1' },
    })
    sessions.updateSessionAgent('agent-exec-fe', 'fe')

    sessions.addMessage('agent-exec-fe', assistantMessage('m-1'))

    const stored = sessions.getSession('agent-exec-fe')?.messages[0]
    expect(stored?.agentId).toBe('fe')
    expect(stored?.source).toBe('collab-turn')
  })

  it('does not mark a WORK session turn — that view IS the thing you read', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('work-1', '[任务] 加 status.txt')
    sessions.updateSessionCollab('work-1', {
      kind: 'work',
      collab: { roomSessionId: 'room-1', taskId: 'task-1' },
    })
    sessions.updateSessionAgent('work-1', 'fe')

    sessions.addMessage('work-1', assistantMessage('m-1'))

    const stored = sessions.getSession('work-1')?.messages[0]
    expect(stored?.agentId).toBe('fe')
    expect(stored?.source).toBeUndefined()
  })

  it('never marks an ordinary session, and never marks a user message', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('chat-1', '普通会话')
    sessions.addMessage('chat-1', assistantMessage('m-1'))
    expect(sessions.getSession('chat-1')?.messages[0].source).toBeUndefined()

    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')
    sessions.addMessage('room-1', { id: 'u-1', role: 'user', content: '大家看看', timestamp: 1 })
    expect(sessions.getSession('room-1')?.messages[0].source).toBeUndefined()
  })
})
