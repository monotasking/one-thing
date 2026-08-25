/**
 * U0 / §10.15:**事件出生即带 runId**。
 *
 * 病根不是时序,是"身份在事实下游被分配":事实(`response-boundary`、之后的每
 * 一条 delta)生在 agent-loop 的同步事件流上,而身份(runId / 助手消息号)从前
 * 定在执行器那边 —— 隔着一条异步 chunk 队列。采集点跑赢执行器的那几毫秒里,
 * 新响应的开头被记在**上一条** run、上一条消息上(电池里 1/5 复现)。
 *
 * 修法是把换锚点提到 boundary 的同步点(`onResponseBoundary`)。这条测试就按
 * 那个竞态的形状搭:执行器**故意一步都不走**,只有采集点在跑。
 *  - 接了口:steer 之后的 delta 带新 run / 新消息号;
 *  - 没接口:带的是旧的那一对 —— 即修复前的行为,留在这里当对照。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'

const state = vi.hoisted(() => ({ sessionsDir: '', storeDir: '' }))

vi.mock('@onething/runtime/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/runtime/storage')>()
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../../../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { beginSessionRun, endSessionRun, resetSessionRuns, rotateSessionRun } = await import(
  '../../../../session/runs.js'
)
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { createSessionEventRecorder } = await import('../session-event-recorder.js')

const SESSION_ID = 'steering-run-identity'
const FIRST_MESSAGE = 'assistant-1'
const STEER_MESSAGE = 'assistant-2'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-steer-identity-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** steering 的形状:第 1 轮吐字 → boundary → 第 2 轮接着吐(新的一条消息)。 */
const EVENTS: AgentStreamEvent[] = [
  { type: 'turn-start', turn: 1 },
  { type: 'text-delta', turn: 1, delta: 'first answer' },
  { type: 'response-boundary', turn: 2 },
  { type: 'turn-start', turn: 2 },
  { type: 'text-delta', turn: 2, delta: 'steered answer' },
  { type: 'turn-end', turn: 2, finishReason: 'stop' },
] as AgentStreamEvent[]

interface ChunkRow {
  seq: number
  runId: string
  messageId: string
  text: string
}

async function driveSteering(options: { liftIdentity: boolean }): Promise<{
  firstRunId: string
  steerRunId?: string
  chunks: ChunkRow[]
  runEndSeqs: Map<string, number>
}> {
  const first = beginSessionRun(SESSION_ID, {
    kind: 'send',
    assistantMessageId: FIRST_MESSAGE,
    provider: 'test-provider',
    model: 'test-model',
    triggerMessageId: 'user-1',
  })

  // 执行器那一侧的两格身份(它在真机上要等异步队列才换;这里干脆不换)。
  let recordingMessageId = FIRST_MESSAGE
  let steerRunId: string | undefined

  const recorder = createSessionEventRecorder({
    sessionId: SESSION_ID,
    providerId: 'test-provider',
    model: 'test-model',
    getMessageId: () => recordingMessageId,
    ...(options.liftIdentity
      ? {
          onResponseBoundary: () => {
            // 与执行器 `rotateAssistantWriterIdentity` 逐条同形(去掉 store 写)。
            recordingMessageId = STEER_MESSAGE
            steerRunId = rotateSessionRun(SESSION_ID, {
              kind: 'steer',
              assistantMessageId: STEER_MESSAGE,
              provider: 'test-provider',
              model: 'test-model',
            }).runId
          },
        }
      : {}),
  })

  for (const event of EVENTS) recorder.handle(event)
  recorder.flush()
  endSessionRun(SESSION_ID, first.runId, { outcome: 'completed' })
  await flushSessionEventLog(SESSION_ID)

  const chunks: ChunkRow[] = []
  const runEndSeqs = new Map<string, number>()
  for (const record of readSessionLogEventsSync(SESSION_ID)) {
    if (record.type === 'assistant/chunks') {
      const data = record.data as { runId: string; messageId: string; text: string[] }
      chunks.push({
        seq: record.seq,
        runId: data.runId,
        messageId: data.messageId,
        text: data.text.join(''),
      })
    }
    if (record.type === 'run/end') {
      const data = record.data as { runId: string }
      runEndSeqs.set(data.runId, record.seq)
    }
  }
  return { firstRunId: first.runId, steerRunId, chunks, runEndSeqs }
}

describe('U0 steering identity', () => {
  it('接上同步换锚点口:steer 之后的事件出生即带新 run 与新消息号', async () => {
    const result = await driveSteering({ liftIdentity: true })
    expect(result.steerRunId).toBeTruthy()
    expect(result.steerRunId).not.toBe(result.firstRunId)

    const before = result.chunks.find(row => row.text === 'first answer')
    const after = result.chunks.find(row => row.text === 'steered answer')
    expect(before).toMatchObject({ runId: result.firstRunId, messageId: FIRST_MESSAGE })
    expect(after).toMatchObject({ runId: result.steerRunId, messageId: STEER_MESSAGE })

    // 顺序也要对:被接手那条 run 的 `run/end` 排在新 run 的正文**之前**,
    // 否则读侧折出来的那条消息会把新正文吞进旧节点。
    const firstEnd = result.runEndSeqs.get(result.firstRunId)
    expect(firstEnd).toBeDefined()
    expect(firstEnd as number).toBeLessThan((after as ChunkRow).seq)
  })

  it('不接口(U0 之前的行为):新响应的开头仍被记在上一条 run 上', async () => {
    const result = await driveSteering({ liftIdentity: false })
    const after = result.chunks.find(row => row.text === 'steered answer')
    expect(after).toMatchObject({ runId: result.firstRunId, messageId: FIRST_MESSAGE })
  })
})
