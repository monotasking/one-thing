/**
 * **按节点缓存的物化视图 ≡ 每次重算**(§17.7.1 批 1)。
 *
 * 批 1 把物化缓存从"进程级失效号 + 按会话 id 的表"换成节点自持的惰性 memo:
 * 成品按 `(投影节点, node.rev)` 记住,归约器里每一条要往节点上写的分支都经
 * `forWrite` 让号前进。这套东西的**唯一**失败模式是**漏了一处 rev**——某条
 * 事件改了节点却没换号,于是读侧交出上一刻那一份,而且悄无声息。
 *
 * 所以这道门逐条事件地问同一个问题:memo 组装出来的那一份,与**完全不用 memo**
 * 现算的那一份,逐格相等吗?脚本走过的事件类型就是被这道门覆盖的那些;新加一个
 * 会写节点的事件类型,在这里补一行。
 *
 * 第二条断言问的是**粒度**:改第二条 run 的时候,第一条消息交出来的必须还是
 * **同一个对象**(命中 memo)。少了它,这个文件在"每次都重算"的实现下也会全绿。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '' }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

const { materializeNode } = await import('@onething/core/session')
const { rehydrateSessionFromStorage } = await import('@onething/runtime/sessions/session-dehydrate')
const { appendSessionLogEvent, flushSessionEventLog, resetSessionEventLogCache } =
  await import('../event-log.js')
const { getLiveSessionProjection, resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { sessionProjectionOptions } = await import('../projection-blobs.js')
const { materializeSessionMessages } = await import('../materialized-messages.js')

const SESSION = 'memo-1'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-memo-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  resetSessionEventLogCache()
  resetSessionProjectionCache()
  resetSessionPrepareCache()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 完全不经 memo 的那一份:每条可见节点现物化 + 深拷 + 补水(读侧同一条链)。 */
function freshMessages(): unknown[] {
  const projection = getLiveSessionProjection(SESSION)
  const options = sessionProjectionOptions(SESSION)
  const messages: unknown[] = []
  for (const node of projection.nodes) {
    if (node.hidden) continue
    const detached = structuredClone(materializeNode(node, options))
    messages.push(rehydrateSessionFromStorage({ messages: [detached] }).messages?.[0] ?? detached)
  }
  return messages
}

type Script = readonly (readonly [string, Record<string, unknown>, Record<string, unknown>?])[]

/** 一条脚本里覆盖到的每一种"会写节点"的事件。 */
const SCRIPT: Script = [
  ['user/message', { message: { id: 'u1', role: 'user', content: 'hi', timestamp: 1000 } }, { surfaceOp: 'append' }],
  ['run/start', {
    runId: 'r1', kind: 'send', assistantMessageId: 'a1', triggerMessageId: 'u1',
    timestamp: 2000, provider: 'openai', model: 'gpt-4o',
  }, { surfaceOp: 'append' }],
  ['request/start', { runId: 'r1', requestIndex: 1, messageId: 'a1' }],
  ['assistant/first-token', { runId: 'r1', messageId: 'a1' }],
  ['assistant/chunks', {
    runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0,
    kind: 'reasoning', time0: 2001, dt: [0, 1], text: ['think', 'ing'],
  }],
  ['assistant/part-end', {
    runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'reasoning', len: 8,
  }],
  ['assistant/chunks', {
    runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1,
    kind: 'text', time0: 2010, dt: [0], text: ['hello'],
  }],
  ['tool/call', {
    runId: 'r1', messageId: 'a1', callId: 'c1', name: 'read',
    argumentsRaw: '{"path":"a"}', turnIndex: 1,
  }],
  ['permission/asked', { runId: 'r1', requestId: 'p1', toolCallId: 'c1' }],
  ['permission/answered', { runId: 'r1', requestId: 'p1', toolCallId: 'c1', approved: false, reason: 'nope' }],
  ['tool/result', { runId: 'r1', callId: 'c1', isError: false, resultPreview: 'ok', sourceSeq: 8 }],
  ['tool/audit', { runId: 'r1', callId: 'c1', toolId: 'read', outcome: 'ok', previewTitle: 'Read a' }],
  ['tool/annotate', { runId: 'r1', callId: 'c1', title: 'Read a (annotated)' }],
  ['skill/activated', { runId: 'r1', messageId: 'a1', skill: 'demo' }],
  ['request/response', {
    runId: 'r1', requestIndex: 1, messageId: 'a1', finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  }],
  ['request/end', { runId: 'r1', requestIndex: 1, stopReason: 'stop' }],
  ['assistant/part-end', {
    runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 1, kind: 'text', len: 5,
  }],
  ['message/patched', { messageId: 'a1', patch: { runId: 'r1' } }],
  ['context/turn-update', { messageId: 'u1', set: { datetime: 'now' } }],
  ['run/end', { runId: 'r1', outcome: 'completed' }],
  // 第二轮:steering 换消息(`continuesRunId` 回头改的是**上一条** run 的节点)。
  ['user/message', { message: { id: 'u2', role: 'user', content: 'more', timestamp: 3000 } }, { surfaceOp: 'append' }],
  ['run/start', {
    runId: 'r2', kind: 'send', assistantMessageId: 'a2', triggerMessageId: 'u2', timestamp: 4000,
  }, { surfaceOp: 'append' }],
  ['assistant/chunks', {
    runId: 'r2', requestIndex: 2, messageId: 'a2', partIndex: 0,
    kind: 'text', time0: 4001, dt: [0], text: ['part one'],
  }],
  ['run/start', {
    runId: 'r3', kind: 'steer', assistantMessageId: 'a3', continuesRunId: 'r2', timestamp: 5000,
  }, { surfaceOp: 'append' }],
  ['assistant/chunks', {
    runId: 'r3', requestIndex: 3, messageId: 'a3', partIndex: 0,
    kind: 'text', time0: 5001, dt: [0], text: ['part two'],
  }],
  ['request/end', { runId: 'r3', requestIndex: 3, stopReason: 'stop' }],
  ['run/end', { runId: 'r3', outcome: 'completed' }],
  // 压缩:占位消息 + 换掉它的那条标记。
  ['system/message', { message: { id: 'k1', role: 'system', content: 'compacting', timestamp: 6000 } }, { surfaceOp: 'append' }],
  ['session/compacted', {
    messageId: 'k1', summary: 'done', compactedMessageCount: 2, status: 'completed',
  }],
  // 两种"看不见":删除一条 / 编辑重发改写一条。
  ['message/deleted', { messageId: 'u2' }],
  ['user/message-edited', {
    messageId: 'u1', message: { id: 'u1b', role: 'user', content: 'hi again', timestamp: 7000 },
  }],
]

describe('物化 memo 是节点自持的(§17.7.1 批 1)', () => {
  it('逐条事件之后,memo 组装 ≡ 完全重算', () => {
    // 先建活投影:写入口的观察者**不主动建表**,建了它才会把后面每一条折进来。
    getLiveSessionProjection(SESSION)
    for (const [type, data, options] of SCRIPT) {
      appendSessionLogEvent(SESSION, type as never, data as never, options as never)
      const fresh = freshMessages()
      const memoized = materializeSessionMessages(SESSION)
      if (fresh.length === 0) {
        expect(memoized, `after ${type}`).toBeUndefined()
        continue
      }
      expect(memoized, `after ${type}`).toEqual(fresh)
    }
  })

  it('改一条 run 只重算那一条:别的消息交出来的还是同一个对象', () => {
    getLiveSessionProjection(SESSION)
    for (const [type, data, options] of SCRIPT.slice(0, 21)) {
      appendSessionLogEvent(SESSION, type as never, data as never, options as never)
    }
    const before = materializeSessionMessages(SESSION)
    expect(before).toBeDefined()
    const firstUser = before?.[0]
    const firstAssistant = before?.[1]

    appendSessionLogEvent(SESSION, 'user/message' as never, {
      message: { id: 'u9', role: 'user', content: 'again', timestamp: 8000 },
    } as never, { surfaceOp: 'append' } as never)
    appendSessionLogEvent(SESSION, 'run/start' as never, {
      runId: 'r9', kind: 'send', assistantMessageId: 'a9', triggerMessageId: 'u9', timestamp: 9000,
    } as never, { surfaceOp: 'append' } as never)
    appendSessionLogEvent(SESSION, 'assistant/chunks' as never, {
      runId: 'r9', requestIndex: 9, messageId: 'a9', partIndex: 0,
      kind: 'text', time0: 9001, dt: [0], text: ['new'],
    } as never)

    const after = materializeSessionMessages(SESSION)
    expect(after?.[0]).toBe(firstUser)
    expect(after?.[1]).toBe(firstAssistant)
    // 新的那条当然是新算的。
    expect(after?.at(-1)).not.toBe(before?.at(-1))
  })

  it('什么都没变的时候交回的是同一个数组实例(换装点据此不写会话对象)', () => {
    getLiveSessionProjection(SESSION)
    for (const [type, data, options] of SCRIPT.slice(0, 21)) {
      appendSessionLogEvent(SESSION, type as never, data as never, options as never)
    }
    expect(materializeSessionMessages(SESSION)).toBe(materializeSessionMessages(SESSION))
  })
})
