/**
 * S3.1(§10.11):技能宣告的**两个落点挂在同一次宣告上**。
 *
 * 判定点只有一个,在引擎里(`startAgentLoopToolExecution`)。宿主这一侧收到那一次
 * `sendSkillActivated`,同时落:
 *   - `message.skillUsed`(产品事实,消息上的那一格)
 *   - `skill/activated`(那条 run 的账,`events.jsonl`)
 *
 * 影子门比的就是这两处的一致性 —— 以前它们各认各的,真机上出现过"账本有、消息
 * 没有"(session fe5261d9)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '', skills: [] as unknown[][] }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../session/shadow.js', () => ({
  scheduleSessionRunShadow: () => undefined,
  checkSessionRunShadow: () => 'skipped',
  checkSessionHistoryShadow: () => 'skipped',
  resetSessionShadowCache: () => undefined,
}))

vi.mock('../../store.js', () => ({
  addMessageStep: () => {},
  updateMessageStep: () => {},
  updateSessionContextSize: () => {},
  updateMessageSkill: (...args: unknown[]) => {
    state.skills.push(args)
  },
}))

vi.mock('../index.js', () => ({
  getEventBus: () => ({ emit: async () => {} }),
  getStreamChannel: () => ({ push: () => {} }),
}))

const { flushSessionEventLog, readSessionLogEvents, resetSessionEventLogCache } = await import(
  '../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../session/event-surface.js')
const { beginSessionRun, resetSessionRuns } = await import('../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../session/event-stats.js')
const { createEventOnlyEmitter } = await import('../event-only-emitter.js')

const SESSION = 'skill-landing'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-skill-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  state.skills = []
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

describe('skill announcement landing (S3.1)', () => {
it('one announcement lands on the message AND in the event log', async () => {
  const emitter = createEventOnlyEmitter({
    sessionId: SESSION,
    assistantMessageId: 'a1',
  } as Parameters<typeof createEventOnlyEmitter>[0])

  emitter.sendSkillActivated('lenovo-scripts')
  await flushSessionEventLog(SESSION)

  expect(state.skills).toEqual([[SESSION, 'a1', 'lenovo-scripts']])

  const events = await readSessionLogEvents(SESSION)
  const activated = events.filter(event => event.type === 'skill/activated')
  expect(activated).toHaveLength(1)
  expect(activated[0].data).toMatchObject({ messageId: 'a1', skill: 'lenovo-scripts' })
  // run 身份跟着走 —— 投影按 runId 归位,messageId 只是兜底。
  expect((activated[0].data as { runId?: string }).runId).toEqual(expect.any(String))
})
})
