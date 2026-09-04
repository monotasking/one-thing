/**
 * C2-b 定律守卫:**工具进度不进账本**。
 *
 * 三定律里最容易被下一位好心人破坏的一条 —— 「屏幕上看得到的东西,账本上应该也
 * 有一份」听起来很对,而进度恰恰是那条规则的反例:它是**过程读数**,不是会话的
 * 事实。重开会话该看见的是结局(这次调用发生了、参数是什么、结局如何),不是
 * 「当时跑到第 7 行」。
 *
 * 所以这条测试**spy 住账本唯一的写口**(`session/event-writer.ts` 的
 * `writeSessionEvent`),跑一段真的带进度的流,断言那口子从头到尾没被进度碰过。
 *
 * 拆掉 `session.ts` 的空 `case` 不会让它红(那一条守的是另一件事:进度不累进
 * 会话状态);让 `tool-progress` 走一条会落账的路才会 —— 而那正是要防的那件事。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))
/** 账本写口上的探针:每一次 `writeSessionEvent` 的事件类型都记一笔。 */
const written = vi.hoisted(() => ({ types: [] as string[], payloads: [] as unknown[] }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../../../session/shadow.js', () => ({
  scheduleSessionRunShadow: () => undefined,
  checkSessionRunShadow: () => 'skipped',
  checkSessionHistoryShadow: () => 'skipped',
  resetSessionShadowCache: () => undefined,
}))

vi.mock('../../../../session/event-writer.js', () => ({
  writeSessionEvent: (_sessionId: string, type: string, data: unknown) => {
    written.types.push(type)
    written.payloads.push(data)
  },
  registerSessionEventObserver: () => () => undefined,
}))

const { resetSessionEventLogCache } = await import('../../../../session/event-log.js')
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { beginSessionRun, resetSessionRuns } = await import('../../../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { createSessionEventRecorder } = await import('../session-event-recorder.js')
const { createEventSystem, getStreamChannel } = await import('../../../../events/index.js')
const { createBackendHandle, setCurrentBackend } = await import('../../../../current.js')
const { pushSessionToolProgress } = await import('../../../../events/tool-progress-stream.js')

const SESSION = 'progress-ledger'
const CALL_ID = 'c1'

let disposeEventSystem: (() => void) | null = null

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-progress-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')
  written.types = []
  written.payloads = []
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
  const { eventBus, streamChannel } = createEventSystem()
  setCurrentBackend(createBackendHandle({ eventBus, streamChannel }))
  disposeEventSystem = () => {
    eventBus.shutdown()
    streamChannel.shutdown()
  }
  delete process.env.ONETHING_TOOL_PROGRESS
})

afterEach(() => {
  disposeEventSystem?.()
  disposeEventSystem = null
  setCurrentBackend(null)
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 一段「说一句 → 调 bash → 一路报进度」的流。 */
function driveWithProgress(): { chunks: unknown[] } {
  const chunks: unknown[] = []
  getStreamChannel().subscribe(SESSION, chunk => chunks.push(chunk))

  const recorder = createSessionEventRecorder({
    sessionId: SESSION,
    providerId: 'p',
    model: 'm',
    systemPrompt: 'sys',
    tools: [],
    getMessageId: () => 'a1',
  })
  const events: AgentStreamEvent[] = [
    { type: 'turn-start', turn: 1 } as AgentStreamEvent,
    { type: 'text-delta', turn: 1, delta: '我先跑一条命令。' } as AgentStreamEvent,
    { type: 'tool-call-start', turn: 1, toolCallId: CALL_ID, toolName: 'bash' } as AgentStreamEvent,
    {
      type: 'tool-call-delta',
      turn: 1,
      toolCallId: CALL_ID,
      argumentsDelta: '{"command":"seq 1 20"}',
    } as AgentStreamEvent,
  ]
  for (const event of events) recorder.handle(event)
  recorder.flush()

  // ★ 工具开始执行,一路报进度(真链路上这几条由 `executeToolDirectly` 推)。
  for (let i = 1; i <= 20; i += 1) {
    pushSessionToolProgress(SESSION, CALL_ID, {
      message: 'seq 1 20',
      outputTail: `${i - 1}\n${i}`,
      ratio: i / 20,
    })
  }
  return { chunks }
}

describe('C2-b:tool-progress 不进 events.jsonl', () => {
  it('20 条进度上了流管,账本写口一次都没被它碰过', () => {
    const { chunks } = driveWithProgress()

    // 先证这一趟**真的跑了**(空跑会让下面那条恒真)。
    expect(chunks.filter(one => (one as { type?: string }).type === 'tool-progress')).toHaveLength(20)
    // 也证账本那一路真的在记(否则「零 progress」也可能只是因为 recorder 没工作)。
    expect(written.types.length).toBeGreaterThan(0)

    // ★ 定律:账本上一条与进度有关的都没有。
    expect(written.types.filter(type => type.includes('progress'))).toEqual([])
    const dumped = JSON.stringify(written.payloads)
    expect(dumped).not.toContain('tool-progress')
    expect(dumped).not.toContain('outputTail')
  })

  it('进度关掉(ONETHING_TOOL_PROGRESS=0)时账本写的东西逐条相同', () => {
    const withProgress = (() => {
      driveWithProgress()
      return [...written.types]
    })()

    // 重置一趟,这次关着进度再跑同一段流。
    written.types = []
    written.payloads = []
    resetSessionEventLogCache()
    resetSessionRuns()
    beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
    process.env.ONETHING_TOOL_PROGRESS = '0'
    const { chunks } = driveWithProgress()

    expect(chunks.filter(one => (one as { type?: string }).type === 'tool-progress')).toHaveLength(0)
    // 账本那一份**逐条相同** —— 开不开进度对账本一个字节的影响都没有。
    expect(written.types).toEqual(withProgress)
  })
})
