/**
 * U0 合同(`docs/design/ui-event-stream-2026-08.md` §3 U0 行的门):
 * **同一条 delta 序列,落盘打包器与 UI 小批的 part 边界逐一致**。
 *
 * 这不是"我照抄了一遍规则"的断言 —— 两侧跑的是同一台状态机
 * (`@onething/core/session/part-boundary`),这里验的是**接线没接歪**:
 * 采集点盖的章原样传到了 coalescer,而 coalescer 只按那枚章攒批、不再自己判
 * 第二遍边界。哪天有人在 coalescer 里"顺手"重新推断段边界,这条就红。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'
import type { StreamChunk } from '@shared/events/index.js'

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
const { installSessionLayerForTest } = await import('../../../../session/testing/session-layer.js')
let sessionFixture: ReturnType<typeof installSessionLayerForTest>
const { beginSessionRun, endSessionRun, resetSessionRuns } = await import(
  '../../../../session/runs.js'
)
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { createSessionEventRecorder } = await import('../session-event-recorder.js')
const { SessionStreamCoalescer } = await import('../../../../events/stream-coalescer.js')

const SESSION_ID = 'ui-stream-contract'
const MESSAGE_ID = 'assistant-1'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ui-stream-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventLogCache()
  sessionFixture = installSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  await sessionFixture.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/**
 * 一条**故意难为人**的序列:换 kind、参数流插在正文中间、回合分界、steering 的
 * 响应边界 —— 每一处都是一次 part 边界判定。
 */
const DELTAS: AgentStreamEvent[] = [
  { type: 'turn-start', turn: 1 },
  { type: 'text-delta', turn: 1, delta: 'he' },
  { type: 'text-delta', turn: 1, delta: 'llo' },
  { type: 'reasoning-delta', turn: 1, delta: 'thinking' },
  { type: 'text-delta', turn: 1, delta: ' again' },
  { type: 'tool-call-start', turn: 1, toolCallId: 'call-1', toolName: 'echo' },
  { type: 'tool-call-delta', turn: 1, toolCallId: 'call-1', argumentsDelta: '{"a"' },
  { type: 'tool-call-delta', turn: 1, toolCallId: 'call-1', argumentsDelta: ':1}' },
  {
    type: 'tool-call-done',
    turn: 1,
    toolCall: { id: 'call-1', name: 'echo', arguments: '{"a":1}' },
  },
  { type: 'finish', turn: 1, finishReason: 'tool_calls' },
  { type: 'text-delta', turn: 2, delta: 'after tools' },
  { type: 'response-boundary', turn: 2 },
  { type: 'text-delta', turn: 2, delta: 'steered' },
  { type: 'turn-end', turn: 2, finishReason: 'stop' },
] as AgentStreamEvent[]

interface PartShape {
  partIndex: number
  kind: string
  text: string
}

describe('U0 part boundary contract', () => {
  it('落盘打包器与 UI 小批对同一条 delta 序列给出同一组 part 边界', async () => {
    const delivered: StreamChunk[] = []
    const coalescer = new SessionStreamCoalescer({
      sendChunk: (_sessionId, chunk) => {
        delivered.push(chunk as StreamChunk)
      },
    })
    coalescer.start(SESSION_ID, MESSAGE_ID)

    const run = beginSessionRun(SESSION_ID, {
      kind: 'send',
      assistantMessageId: MESSAGE_ID,
      provider: 'test-provider',
      model: 'test-model',
      triggerMessageId: 'user-1',
    })

    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      systemPrompt: 'you are a test',
      getMessageId: () => MESSAGE_ID,
      emitUiEvent: event => coalescer.handleChunk(SESSION_ID, event),
    })

    for (const event of DELTAS) recorder.handle(event)
    recorder.flush()
    // 攒着的最后一批走完(coalescer 的 16ms 闸)。
    coalescer.end(SESSION_ID)
    endSessionRun(SESSION_ID, run.runId, { outcome: 'completed' })
    await flushSessionEventLog(SESSION_ID)

    // ── 落盘那一侧 ──────────────────────────────────────────────
    const events = readSessionLogEventsSync(SESSION_ID)
    const diskParts = new Map<number, PartShape>()
    const diskPartEnds: number[] = []
    for (const record of events) {
      if (record.type === 'assistant/chunks') {
        const data = record.data as {
          partIndex: number
          kind: string
          text: string[]
          messageId: string
          runId: string
        }
        const existing = diskParts.get(data.partIndex)
        if (existing) existing.text += data.text.join('')
        else diskParts.set(data.partIndex, {
          partIndex: data.partIndex,
          kind: data.kind,
          text: data.text.join(''),
        })
      }
      if (record.type === 'assistant/part-end') {
        diskPartEnds.push((record.data as { partIndex: number }).partIndex)
      }
    }

    // ── UI 那一侧 ───────────────────────────────────────────────
    const uiParts = new Map<number, PartShape>()
    const uiPartEnds: number[] = []
    for (const chunk of delivered) {
      if (chunk.type === 'assistant/chunks') {
        const existing = uiParts.get(chunk.partIndex)
        if (existing) existing.text += chunk.text.join('')
        else uiParts.set(chunk.partIndex, {
          partIndex: chunk.partIndex,
          kind: chunk.kind,
          text: chunk.text.join(''),
        })
        // 同名同形:小批必须自带身份,renderer 不再靠"当前活跃流"去猜。
        expect(chunk.messageId).toBe(MESSAGE_ID)
        expect(chunk.runId).toBe(run.runId)
      }
      if (chunk.type === 'assistant/part-end') uiPartEnds.push(chunk.partIndex)
    }

    const sortParts = (map: Map<number, PartShape>): PartShape[] =>
      [...map.values()].sort((a, b) => a.partIndex - b.partIndex)

    // 序列本身要真的产出过多段,否则这条断言什么都没验。
    expect(sortParts(diskParts).length).toBeGreaterThanOrEqual(5)
    expect(sortParts(uiParts)).toEqual(sortParts(diskParts))
    expect(uiPartEnds).toEqual(diskPartEnds)
  })

  it('换 kind / 参数流各自成段,段号跨回合单调不复用', async () => {
    const run = beginSessionRun(SESSION_ID, {
      kind: 'send',
      assistantMessageId: MESSAGE_ID,
      provider: 'test-provider',
      model: 'test-model',
    })
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => MESSAGE_ID,
    })
    for (const event of DELTAS) recorder.handle(event)
    recorder.flush()
    endSessionRun(SESSION_ID, run.runId, { outcome: 'completed' })
    await flushSessionEventLog(SESSION_ID)

    const kindByPart = new Map<number, string>()
    for (const record of readSessionLogEventsSync(SESSION_ID)) {
      if (record.type !== 'assistant/part-end') continue
      const data = record.data as { partIndex: number; kind: string }
      // 段号永不复用:同一个号不会收第二次。
      expect(kindByPart.has(data.partIndex)).toBe(false)
      kindByPart.set(data.partIndex, data.kind)
    }
    expect([...kindByPart.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 'text'],
      [1, 'reasoning'],
      [2, 'text'],
      [3, 'tool-input'],
      [4, 'text'],
      [5, 'text'],
    ])
  })
})
