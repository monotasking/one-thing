/**
 * **字节回归**:打包行的字节与落账时机,在编解码器搬家前后逐字节相同
 * (F4-c 定律二,`docs/design/session-event-sourcing-2026-08.md` §16.19 / §16.21)。
 *
 * 定律二说"打包是压缩,不是语义"。搬家(段边界状态机 + 攒批 + 两道闸从
 * recorder 迁进 `core/session/events/chunk-codec.ts`)只有一条验收:**盘上那几行
 * 一个字节都不许变**。这条用例把一个固定剧本喂给真 recorder,读回
 * `events.jsonl` 的原始文本,与金样逐字节比。
 *
 * ## 怎么造的金样(下一个人要重录时照做)
 *
 * 1. `git checkout <搬家前的 commit> -- packages/core/session packages/backend/wiring/engine/stream/session-event-recorder.ts`
 * 2. `ONETHING_RECORD_CHUNK_BYTES=1 npx vitest run .../session-chunk-bytes.test.ts`
 *    —— 本文件只用 recorder 的公开面,所以在搬家前的树上照样跑得起来;
 * 3. 把生产代码换回来,不带 env 再跑一遍 —— 绿 = 逐字节相同。
 *
 * ## 剧本为什么这么写
 *
 * 四道闸各走一遍(64 条 / 2 秒 / part 边界 / 请求结束),外加参数流自成一段、
 * 换 kind 换段、引擎自合成正文那一条。时钟与定时器全假(`setSystemTime(0)` +
 * 手动推进),所以 `time` / `time0` / `dt` 全是定值;唯一的随机量 `runId`
 * (`randomUUID`)按出现顺序归一成 `<run-1>`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@onething/core/agent-loop'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

// 影子断言与本文件要证明的事无关(它身后是读门面与整棵 store 树)。
vi.mock('../../../../session/shadow.js', () => ({
  scheduleSessionRunShadow: () => undefined,
  checkSessionRunShadow: () => 'skipped',
  checkSessionHistoryShadow: () => 'skipped',
  resetSessionShadowCache: () => undefined,
}))

const { flushSessionEventLog, resetSessionEventLogCache } = await import(
  '../../../../session/event-log.js'
)
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { installSessionLayerForTest } = await import('../../../../session/testing/session-layer.js')
let sessionFixture: ReturnType<typeof installSessionLayerForTest>
const { beginSessionRun, resetSessionRuns } = await import('../../../../session/runs.js')
const { resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { createSessionEventRecorder, SESSION_CHUNK_BATCH_SIZE } = await import(
  '../session-event-recorder.js'
)

const SESSION = 'bytes'
const GOLDEN = path.join(import.meta.dirname, 'fixtures', 'chunk-bytes-golden.jsonl')

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-chunk-bytes-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')
  resetSessionEventLogCache()
  sessionFixture = installSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  vi.useRealTimers()
  await flushSessionEventLog()
  await sessionFixture.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 随机量归一:runId 按出现顺序换成 `<run-N>`。 */
function normalize(text: string): string {
  const ids = new Map<string, string>()
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => {
    let alias = ids.get(id)
    if (!alias) {
      alias = `<run-${ids.size + 1}>`
      ids.set(id, alias)
    }
    return alias
  })
}

it('packs the same bytes at the same moments as before the codec moved house', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1', provider: 'p', model: 'm' })

  const target = createSessionEventRecorder({
    sessionId: SESSION,
    providerId: 'p',
    model: 'm',
    systemPrompt: 'sys',
    // `execute` 不进目录快照(`toToolSchemas` 只抄 name/description/parameters),
    // 所以它在不在都不影响这份金样的字节。
    tools: [{
      name: 'read',
      description: 'read a file',
      parameters: { type: 'object' },
      execute: async () => ({ content: '' }),
    }],
    getMessageId: () => 'a1',
  })

  const feed = (event: AgentStreamEvent, advanceMs = 1): void => {
    target.handle(event)
    vi.advanceTimersByTime(advanceMs)
  }

  feed({ type: 'turn-start', turn: 1 })
  // 换 kind 换段(part 边界闸)。
  feed({ type: 'text-delta', turn: 1, delta: 'he' })
  feed({ type: 'text-delta', turn: 1, delta: 'llo' }, 5)
  feed({ type: 'reasoning-delta', turn: 1, delta: 'why' }, 3)
  feed({ type: 'text-delta', turn: 1, delta: 'back' }, 2)
  // 2 秒闸:没有任何别的触发,定时器自己把这一批落了。
  vi.advanceTimersByTime(2100)
  feed({ type: 'text-delta', turn: 1, delta: 'after-timer' })
  // 64 条闸。
  for (let index = 0; index < SESSION_CHUNK_BATCH_SIZE; index += 1) {
    feed({ type: 'text-delta', turn: 1, delta: `d${index} ` })
  }
  // 引擎自合成的一段正文(与 text-delta 同一条路)。
  target.recordSynthesizedText('synth')
  vi.advanceTimersByTime(1)
  // 参数流自成一段,收齐之后 `tool/call` 才落账。
  feed({ type: 'tool-call-start', turn: 1, toolCallId: 'c1', toolName: 'read' })
  feed({ type: 'tool-call-delta', turn: 1, toolCallId: 'c1', toolName: 'read', argumentsDelta: '{"pa' })
  feed({ type: 'tool-call-delta', turn: 1, toolCallId: 'c1', toolName: 'read', argumentsDelta: 'th":"a"}' })
  feed({
    type: 'tool-call-done',
    turn: 1,
    toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a"}' },
  })
  // 请求结束闸。
  feed({ type: 'turn-end', turn: 1, finishReason: 'stop' })
  target.flush()

  vi.useRealTimers()
  await flushSessionEventLog(SESSION)
  const actual = normalize(
    fs.readFileSync(path.join(state.sessionsDir, SESSION, 'events.jsonl'), 'utf8'),
  )

  if (process.env.ONETHING_RECORD_CHUNK_BYTES === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true })
    fs.writeFileSync(GOLDEN, actual)
    return
  }
  expect(actual).toBe(fs.readFileSync(GOLDEN, 'utf8'))
})
