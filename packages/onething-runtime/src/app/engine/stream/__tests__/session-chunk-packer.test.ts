/**
 * S1a:delta 打包器的四条闸(§3 助手行 / §10.6 第 3 条)。
 *
 * 2 秒 / 64 条 / part 边界 / 请求结束,先到者触发。这条测试直接喂
 * `AgentStreamEvent`,不跑真 runner —— 要钉的是"什么时候落一行、落下来的那一行
 * 无损吗",而不是 runner 的编排(那条由 `session-event-recorder.test.ts` 的真
 * 循环钉)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'
import type { SessionAssistantChunksEvent, SessionLogEventRecord } from '@onething/core/session'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('../../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
  getLogDir: () => path.join(state.storeDir, 'log'),
}))

const { flushSessionEventLog, readSessionLogEvents, resetSessionEventLogCache } = await import(
  '../../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../../session/event-surface.js')
const { beginSessionRun, resetSessionRuns } = await import('../../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../../session/event-stats.js')
const { createSessionEventRecorder, SESSION_CHUNK_BATCH_SIZE } = await import(
  '../session-event-recorder.js'
)

const SESSION = 'packer'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-packer-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
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
  vi.useRealTimers()
})

function recorder() {
  return createSessionEventRecorder({
    sessionId: SESSION,
    providerId: 'p',
    model: 'm',
    systemPrompt: 'sys',
    tools: [],
    getMessageId: () => 'a1',
  })
}

function feed(target: { handle(event: AgentStreamEvent): void }, events: AgentStreamEvent[]): void {
  for (const event of events) target.handle(event)
}

async function chunks(): Promise<SessionAssistantChunksEvent[]> {
  await flushSessionEventLog(SESSION)
  return (await readSessionLogEvents(SESSION)).filter(
    (event): event is SessionAssistantChunksEvent => event.type === 'assistant/chunks',
  )
}

async function all(): Promise<SessionLogEventRecord[]> {
  await flushSessionEventLog(SESSION)
  return readSessionLogEvents(SESSION)
}

describe('assistant/chunks packer', () => {
  it('flushes on the size gate and keeps every delta losslessly', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    const deltas = Array.from({ length: SESSION_CHUNK_BATCH_SIZE + 3 }, (_, index) => `d${index} `)
    feed(target, deltas.map(delta => ({ type: 'text-delta', turn: 1, delta })))

    // 64 条那一闸已经落了一行,剩下 3 条还在攒。
    let rows = await chunks()
    expect(rows).toHaveLength(1)
    expect(rows[0].data.text).toHaveLength(SESSION_CHUNK_BATCH_SIZE)

    target.flush()
    rows = await chunks()
    expect(rows).toHaveLength(2)
    // 无损:两行 fold 回来逐字等于模型吐出来的那串。
    expect(rows.map(row => row.data.text.join('')).join('')).toBe(deltas.join(''))
    // dt 与 text 等长,且每一批从 0 起(相对 time0)。
    for (const row of rows) {
      expect(row.data.dt).toHaveLength(row.data.text.length)
      expect(row.data.dt[0]).toBe(0)
      expect(row.data.dt.every(value => value >= 0)).toBe(true)
    }
  })

  it('flushes on the 2s timer without any other trigger', async () => {
    vi.useFakeTimers()
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    target.handle({ type: 'text-delta', turn: 1, delta: 'slow' })

    expect(await chunks()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2100)
    vi.useRealTimers()
    expect((await chunks()).map(row => row.data.text.join(''))).toEqual(['slow'])
  })

  it('flushes at a part boundary: switching from text to reasoning closes the段', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    feed(target, [
      { type: 'text-delta', turn: 1, delta: 'hello ' },
      { type: 'reasoning-delta', turn: 1, delta: 'hmm' },
    ])

    const rows = await chunks()
    expect(rows).toHaveLength(1)
    expect(rows[0].data.kind).toBe('text')
    expect(rows[0].data.partIndex).toBe(0)

    // part-end 紧跟在它后面,而且不带正文。
    const partEnd = (await all()).find(event => event.type === 'assistant/part-end')
    expect(partEnd?.type === 'assistant/part-end' && partEnd.data).toMatchObject({
      partIndex: 0,
      kind: 'text',
      len: 6,
    })
  })

  it('flushes at request end and gives each part its own index', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    feed(target, [
      { type: 'reasoning-delta', turn: 1, delta: 'think' },
      { type: 'text-delta', turn: 1, delta: 'answer' },
      { type: 'turn-end', turn: 1, finishReason: 'stop' },
    ])

    const rows = await chunks()
    expect(rows.map(row => [row.data.partIndex, row.data.kind, row.data.text.join('')])).toEqual([
      [0, 'reasoning', 'think'],
      [1, 'text', 'answer'],
    ])

    const response = (await all()).find(event => event.type === 'request/response')
    expect(response?.type === 'request/response' && response.data.parts).toEqual([
      { partIndex: 0, kind: 'reasoning', len: 5, hash: expect.any(String) },
      { partIndex: 1, kind: 'text', len: 6, hash: expect.any(String) },
    ])
  })

  it('packs a streamed tool-input into its own part and closes it before tool/call', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    feed(target, [
      { type: 'tool-call-start', turn: 1, toolCallId: 'c1', toolName: 'read' },
      { type: 'tool-call-delta', turn: 1, toolCallId: 'c1', toolName: 'read', argumentsDelta: '{"pa' },
      { type: 'tool-call-delta', turn: 1, toolCallId: 'c1', toolName: 'read', argumentsDelta: 'th":"a"}' },
      { type: 'tool-call-done', turn: 1, toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a"}' } },
    ])

    const ordered = (await all()).map(event => event.type)
    // 参数流先收齐,`tool/call` 才落账(铁律 2 的顺序)。
    expect(ordered.slice(-3)).toEqual(['assistant/chunks', 'assistant/part-end', 'tool/call'])

    const rows = await chunks()
    expect(rows[0].data.kind).toBe('tool-input')
    expect(rows[0].data.toolCallId).toBe('c1')
    expect(rows[0].data.text.join('')).toBe('{"path":"a"}')
  })

  it('records an auto-retry as willRetry, and a final failure as not', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    target.handle({ type: 'auto-retry', turn: 1, attempt: 1, maxAttempts: 3, delayMs: 10, error: '429' })
    target.recordRequestError(Object.assign(new Error('gave up'), { status: 429 }))

    const errors = (await all()).filter(event => event.type === 'request/error')
    expect(errors.map(event => event.type === 'request/error' && event.data)).toEqual([
      { runId: expect.any(String), requestIndex: 1, error: { message: '429' }, willRetry: true, attempt: 1 },
      {
        runId: expect.any(String),
        requestIndex: 1,
        error: { name: 'Error', message: 'gave up', status: 429 },
        willRetry: false,
        attempt: 1,
      },
    ])
  })

  it('records skill activation as its own event', async () => {
    const target = recorder()
    target.handle({ type: 'turn-start', turn: 1 })
    target.handle({
      type: 'tool-call-done',
      turn: 1,
      toolCall: { id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'cat skills/agent-plan/SKILL.md' }) },
    })

    const skill = (await all()).find(event => event.type === 'skill/activated')
    expect(skill?.type === 'skill/activated' && skill.data).toMatchObject({
      messageId: 'a1',
      skill: 'agent-plan',
    })
  })
})
