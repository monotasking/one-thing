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
let fixture: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>>

async function loadIsolatedStores(): Promise<typeof import('../sessions.js')> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  const { installStoreSessionLayerForTest } = await import('../../session/testing/store-layer.js')
  fixture = await installStoreSessionLayerForTest()
  return sessions
}

function appendMessage(sessionId: string, message: ChatMessage): ChatMessage {
  return fixture.sessionLayer.commands.appendMessage(sessionId, { message, stampCollab: true })
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
  await fixture?.dispose()
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('room turn epoch marker', () => {
  it('stamps a room turn message as thinking, together with its agentId', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    const stored = appendMessage('room-1', assistantMessage('m-1'))
    expect(stored?.agentId).toBe('fe')
    expect(stored?.source).toBe('collab-turn')
  })

  /**
   * **F4-a(§16.12):`addMessage` 交回的必须是入库的那一条,不是入参那一条。**
   *
   * 这是 P0 端口形状冻结的唯一豁免(§16.11 拍板 1)的护栏。盖章是 COW 的,所以
   * "入参"与"入库"在会盖章的会话上是两个对象 —— 引擎入口拿返回值把助手占位的
   * 署名 / 时刻 / origin 带进 `run/start`,拿错一份账本上就少两格
   * (真机 `agent-exec-…` 的 `1.source` 缺失就是这一格丢的样子,§13.9)。
   *
   * 谁把 `addMessage` 改回 `void`、或者让它返回入参,这里当场红。
   */
  it('addMessage hands back the stored message, stamp included (F4-a port contract)', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    const incoming = assistantMessage('m-1')
    const returned = appendMessage('room-1', incoming)

    // 返回的是盖过章的那一条……
    expect(returned.agentId).toBe('fe')
    expect(returned.source).toBe('collab-turn')
    // ……而调用方手里那条一字未动(COW,P0.1 的纪律)。
    expect(incoming.agentId).toBeUndefined()
    expect(incoming.source).toBeUndefined()
    // 返回的就是落库的那一条,不是第三个副本。
    // 入库那一条 = 盖过章的那一条(store 的消息数组由折叠产物维护,§16.27 / 批 3)。
    expect(returned).not.toBe(incoming)
  })

  it('addMessage returns the message unchanged where nothing stamps it', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('chat-1', '普通会话')

    const incoming = assistantMessage('m-1')
    const returned = appendMessage('chat-1', incoming)

    expect(returned).toBe(incoming)
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

    const stored = appendMessage('room-1', {
      ...assistantMessage('m-drive-origin'),
      origin: { transport: 'api', source: 'collab', receivedAt: 1 },
    } as never)
    expect(stored?.source).toBe('collab-turn')
  })

  it('still yields to a REAL epoch marker on the origin axis', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    const stored = appendMessage('room-1', {
      ...assistantMessage('m-say-origin'),
      origin: { transport: 'api', source: 'collab-say', receivedAt: 1 },
    } as never)
    expect(stored?.source).toBeUndefined()
  })

  it('leaves an utterance alone — say writes its own marker and agentId', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')

    const stored = appendMessage('room-1', assistantMessage('m-1', {
      agentId: 'fe',
      content: '明天下班前',
      source: 'collab-say',
    }))

    expect(stored.source).toBe('collab-say')
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

    const stored = appendMessage('agent-exec-fe', assistantMessage('m-1'))
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

    const stored = appendMessage('work-1', assistantMessage('m-1'))
    expect(stored?.agentId).toBe('fe')
    expect(stored?.source).toBeUndefined()
  })

  it('never marks an ordinary session, and never marks a user message', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('chat-1', '普通会话')
    expect(appendMessage('chat-1', assistantMessage('m-1')).source).toBeUndefined()

    sessions.createSession('room-1', '官网改版组')
    sessions.updateSessionCollab('room-1', { kind: 'room', room: { memberAgentIds: ['fe'] } })
    sessions.updateSessionAgent('room-1', 'fe')
    const stored = appendMessage('room-1', { id: 'u-1', role: 'user', content: '大家看看', timestamp: 1 })
    expect(stored.source).toBeUndefined()
  })
})
