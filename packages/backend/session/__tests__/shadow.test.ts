/**
 * 记录面(`session/shadow.ts`)—— **恒等门退役之后剩下的那半边**(F4-c c4,§16.24)。
 *
 * 这个文件从前有八组用例,七组是恒等门自己的(run 断言 / 历史断言 / 老会话豁免 /
 * 方向标记 / 不等折叠 / 关闸)。门退役了,那七组随它一起走 —— 它们断言的是一台
 * 已经不存在的机器。留下来的是**记录面本身**,它今天服务于唯一常驻的耐久门
 * (`refold.ts`):
 *
 *  - **差异摘要**:2KB 预算截得住、长值截成"前 120 字 + 总长"、相等的形状给空表;
 *  - **`runs` 换了产地**(c4):从前是 run 断言顺手记的一笔,现在由 `endSessionRun`
 *    自己记 —— 它回答的本来就是"这一轮跑了多少个 run",与哪道门在比无关;
 *  - **关闸**:`ONETHING_SESSION_SHADOW=0` 之后一条账都不记,而**事件照旧落盘**
 *    (那正是关闸这条纪律的全部意义:关掉的是记账,不是账本)。
 *
 * refold 那道门自己的用例在 `refold.test.ts` / `refold-slices.test.ts`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  session: undefined as unknown,
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const {
  getSessionShadowLogPath,
  resetSessionShadowCache,
  summarizeShadowDiff,
} = await import('../shadow.js')
const { flushSessionEventLog, resetSessionEventLogCache } = await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { beginSessionRun, endSessionRun, resetSessionRuns } = await import('../runs.js')
const {
  flushSessionEventStats,
  readSessionShadowStats,
  resetSessionEventStatsCache,
} = await import('../event-stats.js')

const SESSION = 'shadow-1'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-shadow-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.session = { id: SESSION }
  resetSessionEventLogCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  resetSessionShadowCache()
})

afterEach(async () => {
  delete process.env.ONETHING_SESSION_SHADOW
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1000 }
}

/** 一个最小 run:用户消息 + 一条只有文本的助手回答。 */
function recordSimpleRun(assistantId: string, text: string): string {
  writeSessionEvent(SESSION, 'user/message', {
    message: userMessage('u1', 'hi') as never,
  }, { surfaceOp: 'append' })
  const run = beginSessionRun(SESSION, {
    kind: 'send',
    assistantMessageId: assistantId,
    triggerMessageId: 'u1',
    timestamp: 2000,
    provider: 'openai',
    model: 'gpt-4o',
  })
  writeSessionEvent(SESSION, 'assistant/chunks', {
    runId: run.runId,
    requestIndex: 1,
    messageId: assistantId,
    partIndex: 0,
    kind: 'text',
    time0: 2001,
    dt: [0],
    text: [text],
  })
  writeSessionEvent(SESSION, 'assistant/part-end', {
    runId: run.runId,
    requestIndex: 1,
    messageId: assistantId,
    partIndex: 0,
    kind: 'text',
    len: text.length,
  })
  writeSessionEvent(SESSION, 'request/end', { runId: run.runId, requestIndex: 1 })
  writeSessionEvent(SESSION, 'message/patched', {
    messageId: assistantId,
    patch: { runId: run.runId },
  })
  return run.runId
}

function shadowLines(): Array<Record<string, unknown>> {
  try {
    return fs.readFileSync(getSessionShadowLogPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

describe('diff summary', () => {
  it('reports the first differences and keeps the line under the 2KB budget', () => {
    const a = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, content: 'x'.repeat(300) }))
    const b = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, content: 'y'.repeat(300) }))
    const { diff, truncated } = summarizeShadowDiff(a, b)

    expect(diff.length).toBeGreaterThan(0)
    expect(diff.length).toBeLessThanOrEqual(12)
    expect(truncated).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(diff), 'utf8')).toBeLessThanOrEqual(2048)
    // 长值被截断成"前 120 字 + 总长",不是整段抄进日志。
    expect(diff[0].a).toContain('…(300)')
  })

  it('is empty for equal shapes regardless of key order', () => {
    expect(summarizeShadowDiff({ a: 1, b: 2 }, { b: 2, a: 1 }).diff).toEqual([])
  })
})

describe('runs accounting (F4-c c4: 产地从恒等门搬到 endSessionRun)', () => {
  it('counts one run per completed run — no gate involved', async () => {
    const runId = recordSimpleRun('a1', 'hello')
    await endSessionRun(SESSION, runId, { outcome: 'completed' })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 1, mismatches: 0 })
  })
})

describe('the off switch', () => {
  it('ONETHING_SESSION_SHADOW=0 records nothing at all', async () => {
    process.env.ONETHING_SESSION_SHADOW = '0'
    const runId = recordSimpleRun('a1', 'hello')
    await endSessionRun(SESSION, runId, { outcome: 'completed' })

    flushSessionEventStats()
    expect(readSessionShadowStats()).toMatchObject({ runs: 0, mismatches: 0 })
    expect(shadowLines()).toHaveLength(0)
  })

  it('still writes the events themselves while the shadow is off', async () => {
    process.env.ONETHING_SESSION_SHADOW = '0'
    const runId = recordSimpleRun('a1', 'hello')
    await endSessionRun(SESSION, runId, { outcome: 'completed' })
    await flushSessionEventLog(SESSION)

    const { readSessionLogEventsSync } = await import('../event-log.js')
    const types = readSessionLogEventsSync(SESSION).map(event => event.type)
    expect(types).toContain('run/start')
    expect(types).toContain('run/end')
  })
})
