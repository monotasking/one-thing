/**
 * §13.10 M7:**换 agent 在账本上留下一条账**。
 *
 * 从前 `store.updateSessionAgent` 直接走仓库的 `applyMetadataMutation`,绕开了
 * 命令面,于是 `events.jsonl` 里一条 `session/agent-changed` 都没有 ——
 * `run/start.agentId` 只记得每次执行**当时**挂在谁名下,投影既归因不了过去的
 * run,也说不出切换发生过。
 *
 * 用例问的是可观察的后果:切换之后账本上有没有那一行、值对不对、没变的时候
 * 会不会多写一行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', async () => {
  const actual = await vi.importActual<typeof import('@onething/runtime/storage')>('@onething/runtime/storage')
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingSessionPath: (sessionId: string) => path.join(state.sessionsDir, `${sessionId}.json`),
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

const { createSessionWithoutFocus, updateSessionAgent } = await import('../sessions.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } =
  await import('../../session/event-log.js')
const { resetSessionSurfaceCache } = await import('../../session/event-surface.js')
const { resetSessionEventStatsCache } = await import('../../session/event-stats.js')
const { resetSessionPrepareCache } = await import('../../session/prepare.js')
const { foldSessionProjection, projectChatMessages } = await import('@onething/core/session')

const SESSION = '11111111-2222-4333-8444-555555555555'
let fixture: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>>

beforeEach(async () => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-agent-switch-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(state.sessionsDir, { recursive: true })
  fixture = await (await import('../../session/testing/store-layer.js')).installStoreSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionEventStatsCache()
  resetSessionPrepareCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  await fixture?.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

async function events(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  await flushSessionEventLog(SESSION)
  resetSessionEventLogCache(SESSION)
  return readSessionLogEventsSync(SESSION) as unknown as Array<{
    type: string
    data: Record<string, unknown>
  }>
}

describe('§13.10 M7: 换 agent 进账本', () => {
  it('records session/agent-changed with the value that actually landed', async () => {
    // 仓库改的就是手上这只对象,所以先把旧值抄下来再切。
    const createdAgentId = createSessionWithoutFocus(SESSION, 'switch me').agentId
    expect(createdAgentId).toBeTruthy()
    expect(updateSessionAgent(SESSION, 'claude-code-agent')).toBe(true)

    const changed = (await events()).filter(event => event.type === 'session/agent-changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].data).toEqual({ from: createdAgentId, to: 'claude-code-agent' })
  })

  it('folds into session-level meta and adds nothing to the screen', async () => {
    createSessionWithoutFocus(SESSION, 'switch me')
    updateSessionAgent(SESSION, 'claude-code-agent')

    const log = (await events()) as never
    expect(foldSessionProjection(log).sessionMeta.agentId).toBe('claude-code-agent')
    // 换 agent 不是一条消息。
    expect(projectChatMessages(log).messages).toEqual([])
  })

  it('writes nothing when the agent did not actually change', async () => {
    const created = createSessionWithoutFocus(SESSION, 'switch me')
    updateSessionAgent(SESSION, created.agentId ?? '')

    expect((await events()).filter(event => event.type === 'session/agent-changed')).toHaveLength(0)
  })
})
