import { installSessionLayerForTest } from '../testing/session-layer.js'
/**
 * 轨迹读实现(S3,§12)。
 *
 * 守两件事:
 *  1. 事实来自 `events.jsonl`,不来自 `messages.jsonl` —— 测试里那份消息文件
 *     被**故意写成假的**,读出来的树里不该有它一个字;
 *  2. 一次只读查询**不写盘** —— 读完之后 store 的文件清单与 mtime 逐一相同。
 *     这一条不是洁癖:`getLiveSessionProjection` 的第一步会为未闭合的 run 补写
 *     `run/end`,一个只读出口触发它就等于"看一眼轨迹改了账本"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
}))

const { readSessionTrace, readSessionTraceResponseText, isSafeSessionId } = await import('../trace.js')

let testSessionLayer: ReturnType<typeof installSessionLayerForTest>
// The real subscriptions and projection maps are released by their owner.


beforeEach(() => {
  state.sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-trace-'))
  testSessionLayer = installSessionLayerForTest()
})

afterEach(async () => {
  await testSessionLayer.dispose()
  fs.rmSync(state.sessionsDir, { recursive: true, force: true })
})

let seq = 0
function line(type: string, data: unknown, time = 1_000 + (seq + 1) * 10): string {
  return JSON.stringify({ seq: ++seq, time, type, data })
}

function writeSession(sessionId: string, lines: string[]): void {
  const dir = path.join(state.sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
  // 故意与事件不一致:轨迹读到它就说明读错了地方。
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    `${JSON.stringify({ id: 'a1', role: 'assistant', content: 'THIS TEXT MUST NEVER APPEAR' })}\n`,
  )
}

function sampleRun(sessionId: string): void {
  seq = 0
  writeSession(sessionId, [
    line('session/created', { sessionId, kind: 'chat' }),
    line('user/message', { message: { id: 'u1', role: 'user', content: 'hello there' } }),
    line('run/start', {
      runId: 'run_x', kind: 'send', assistantMessageId: 'a1',
      triggerMessageId: 'u1', provider: 'openai', model: 'gpt-4o',
    }),
    line('request/header', {
      requestIndex: 1, provider: 'openai', model: 'gpt-4o',
      systemPromptHash: 'sys1', toolsHash: 'th1', reason: 'initial', runId: 'run_x',
    }),
    line('request/start', { requestIndex: 1, messageId: 'a1', runId: 'run_x' }),
    line('assistant/chunks', {
      runId: 'run_x', requestIndex: 1, messageId: 'a1', partIndex: 0,
      kind: 'text', time0: 2_000, dt: [0, 5], text: ['hi ', 'there'],
    }),
    line('request/response', {
      runId: 'run_x', requestIndex: 1, messageId: 'a1', finishReason: 'stop',
      parts: [{ partIndex: 0, kind: 'text', len: 8 }],
    }),
    line('request/end', { requestIndex: 1, stopReason: 'stop', runId: 'run_x' }),
    line('run/end', { runId: 'run_x', outcome: 'completed' }),
  ])
}

describe('readSessionTrace', () => {
  it('assembles the run tree from events.jsonl, never from messages', async () => {
    sampleRun('s1')
    const trace = await readSessionTrace('s1')
    expect(trace.sessionId).toBe('s1')
    expect(trace.hasRunEvents).toBe(true)
    expect(trace.runs.map(run => run.runId)).toEqual(['run_x'])
    expect(trace.runs[0].trigger?.preview).toBe('hello there')
    expect(trace.runs[0].requests[0].finishReason).toBe('stop')
    expect(JSON.stringify(trace)).not.toContain('THIS TEXT MUST NEVER APPEAR')
  })

  it('materializes the response text from the chunk fold, on demand only', async () => {
    sampleRun('s2')
    const trace = await readSessionTrace('s2')
    expect(JSON.stringify(trace)).not.toContain('hi there')
    const response = await readSessionTraceResponseText('s2', 'run_x', 1)
    expect(response.text).toBe('hi there')
    expect(response.partCount).toBe(1)
  })

  it('never writes: the store is byte-identical after a read', async () => {
    sampleRun('s3')
    // 未闭合的 run:正是会诱使读侧去 prepare(补写 run/end)的那一种。
    fs.appendFileSync(
      path.join(state.sessionsDir, 's3', 'events.jsonl'),
      `${line('run/start', { runId: 'run_open', kind: 'send', assistantMessageId: 'a2' })}\n`,
    )
    const before = snapshot(state.sessionsDir)
    await readSessionTrace('s3')
    await readSessionTraceResponseText('s3', 'run_open')
    expect(snapshot(state.sessionsDir)).toEqual(before)
  })

  it('filters by run and by last', async () => {
    sampleRun('s4')
    fs.appendFileSync(path.join(state.sessionsDir, 's4', 'events.jsonl'), [
      line('run/start', { runId: 'run_y', kind: 'retry', assistantMessageId: 'a2' }),
      line('request/start', { requestIndex: 2, messageId: 'a2', runId: 'run_y' }),
      line('run/end', { runId: 'run_y', outcome: 'error', error: { message: 'boom' } }),
      '',
    ].join('\n'))

    expect((await readSessionTrace('s4')).runs).toHaveLength(2)
    expect((await readSessionTrace('s4', { last: true })).runs.map(run => run.runId)).toEqual(['run_y'])
    expect((await readSessionTrace('s4', { run: 'run_x' })).runs.map(run => run.runId)).toEqual(['run_x'])
    expect((await readSessionTrace('s4', { last: true })).totalRuns).toBe(2)
  })

  it('a session with no event log is an empty tree, not an error', async () => {
    const trace = await readSessionTrace('never-existed')
    expect(trace).toMatchObject({ sessionId: 'never-existed', totalRuns: 0, runs: [] })
  })

  it('rejects path-shaped session ids', () => {
    expect(isSafeSessionId('../../etc')).toBe(false)
    expect(isSafeSessionId('..')).toBe(false)
    expect(isSafeSessionId('')).toBe(false)
    expect(isSafeSessionId('9f2c-4e1a')).toBe(true)
  })
})

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return out
}
