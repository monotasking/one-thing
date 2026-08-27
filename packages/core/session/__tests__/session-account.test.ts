/**
 * **会话账折叠器的确定性预检**(§17.7.1 批 2 / #8b-i)。
 *
 * 这套东西唯一的隐性失败模式是"折叠器偷偷读了事件之外的东西"——墙钟、进程态、
 * 上一次的中间量。一旦有,批 3 把 refold 那道门扩栏(文件字节重折的会话账 ≡ 活
 * 会话账)之后就会随机红,而随机红的门最后一定被人调绿(纪律 11 的反面)。
 *
 * 所以这里问三件事:
 *  1. 同一条事件序列**折两次**逐格相等;
 *  2. 从**文件字节**(逐行 JSON)折出来的账 ≡ 逐条**增量**折出来的账
 *     —— refold 扩栏的前身,本批先以单测形态存在;
 *  3. 产地表逐格成立(盖章面与今天 reducer 的分支逐字对齐)。
 */

import { describe, expect, it } from 'vitest'
import {
  createSessionAccountState,
  foldSessionAccount,
  reduceSessionAccount,
  type SessionAccountFoldContext,
  type SessionAccountState,
} from '../account.js'
import type { SessionLogEventRecord } from '../events/types.js'

type AnyRecord = Record<string, unknown>

let seq = 0
function event(type: string, data: AnyRecord, time: number): SessionLogEventRecord {
  seq += 1
  return { seq, time, type, data } as unknown as SessionLogEventRecord
}

/** 一条覆盖每一种会动账的事件的序列(顺序即时间序)。 */
function buildLedger(): SessionLogEventRecord[] {
  seq = 0
  return [
    event('session/created', { sessionId: 's1' }, 1_000),
    event('user/message', { message: { id: 'm1', role: 'user', content: 'hi', timestamp: 1_001 } }, 1_001),
    // 流式助手占位:命令面一条不写,`run/start` 是它在账本上的那一格。
    event('run/start', {
      runId: 'r1',
      kind: 'send',
      assistantMessageId: 'm2',
      provider: 'deepseek',
      model: 'deepseek-chat',
      timestamp: 1_002,
      createdAssistantMessage: true,
    }, 1_009),
    event('request/response', {
      runId: 'r1',
      requestIndex: 1,
      messageId: 'm2',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    }, 1_010),
    event('run/end', { runId: 'r1', outcome: 'completed' }, 1_011),
    // 旁录:一格都不该盖。
    event('tool/audit', { toolCallId: 't1' }, 1_020),
    // patchMessage 写的那一条 —— reducer 的 patchMessage 分支不盖 `updatedAt`。
    event('message/patched', { messageId: 'm2', patch: { skillUsed: 'x' } }, 1_030),
    // upsert 命中支写的那一条 —— reducer 盖。
    event('message/patched', { messageId: 'm2', patch: { content: 'y' }, via: 'upsert' }, 1_040),
    // 直接落定的助手消息(非流式)走 `system/message`,自带 provider/model。
    event('system/message', {
      message: { id: 'm3', role: 'assistant', content: 'done', provider: 'openai', model: 'gpt-x', timestamp: 1_050 },
    }, 1_050),
    event('message/deleted', { messageId: 'm3' }, 1_060),
  ]
}

/** 折叠上下文:截断类事件问"之后还剩哪些消息"。测试里给一份固定答案。 */
function context(messages: AnyRecord[] = []): SessionAccountFoldContext {
  return { sessionId: 's1', messagesAfter: () => messages as never }
}

function fold(events: SessionLogEventRecord[], ctx = context()): SessionAccountState {
  return foldSessionAccount(events, ctx)
}

describe('会话账折叠器 —— 确定性预检', () => {
  it('同一条事件序列折两次,逐格相等', () => {
    const events = buildLedger()
    expect(fold(events)).toEqual(fold(buildLedger()))
  })

  it('从文件字节折 ≡ 逐条增量折', () => {
    const events = buildLedger()
    // "文件字节":逐行 JSON 编码之后再解回来 —— 与 refold 那道门读账本的走法同形。
    const bytes = events.map(record => JSON.stringify(record)).join('\n')
    const parsed = bytes
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as SessionLogEventRecord)

    const wholeFile = fold(parsed)

    let incremental = createSessionAccountState()
    for (const record of events) {
      incremental = reduceSessionAccount(incremental, record, context())
    }

    expect(wholeFile).toEqual(incremental)
  })

  it('折叠器不读墙钟:同一条事件在不同时刻折出同一本账', () => {
    const events = buildLedger()
    const first = fold(events)
    // 隔一段"真实时间"再折一次(墙钟一定变了,账不许变)。
    const later = fold(buildLedger())
    expect(later.updatedAt).toBe(first.updatedAt)
    expect(later).toEqual(first)
  })
})

describe('会话账折叠器 —— 产地逐格', () => {
  it('`updatedAt` 只认账目事件:旁录与无 via 的 patched 都不盖', () => {
    const account = fold(buildLedger())
    // 最后一条账目事件是 `message/deleted`(1_060)。
    expect(account.updatedAt).toBe(1_060)

    const upToPatch = fold(buildLedger().slice(0, 7))
    // 序列的第 7 条是无 `via` 的 `message/patched`;它之前最后一条账目事件是
    // `run/start{createdAssistantMessage}`,而那一格盖的是**占位消息的时刻**。
    expect(upToPatch.updatedAt).toBe(1_002)
  })

  it('`message/patched{via:"upsert"}` 盖章,`tool/audit` 不盖', () => {
    const base = createSessionAccountState()
    const patched = reduceSessionAccount(
      base,
      event('message/patched', { messageId: 'm', patch: { a: 1 } }, 5_000),
      context(),
    )
    expect(patched.updatedAt).toBeUndefined()
    expect(patched).toBe(base)

    const upserted = reduceSessionAccount(
      base,
      event('message/patched', { messageId: 'm', patch: { a: 1 }, via: 'upsert' }, 5_001),
      context(),
    )
    expect(upserted.updatedAt).toBe(5_001)

    const audited = reduceSessionAccount(
      base,
      event('tool/audit', { toolCallId: 't' }, 5_002),
      context(),
    )
    expect(audited).toBe(base)
  })

  it('`run/start` 不带 createdAssistantMessage 时一格都不盖(确认后恢复那条路)', () => {
    const base = createSessionAccountState()
    const resumed = reduceSessionAccount(
      base,
      event('run/start', {
        runId: 'r9',
        kind: 'resume',
        assistantMessageId: 'm9',
        provider: 'p',
        model: 'm',
        timestamp: 9_000,
      }, 9_001),
      context(),
    )
    expect(resumed).toBe(base)
  })

  it('`lastProvider` / `lastModel`:占位那一路认 run/start,落定那一路认消息自带', () => {
    const account = fold(buildLedger())
    expect(account.lastProvider).toBe('openai')
    expect(account.lastModel).toBe('gpt-x')

    const untilRun = fold(buildLedger().slice(0, 3))
    expect(untilRun.lastProvider).toBe('deepseek')
    expect(untilRun.lastModel).toBe('deepseek-chat')
  })

  it('`session/model-changed`:用户手动挑模型那一路也进账(容器侧由 applySessionModel 写)', () => {
    const base = createSessionAccountState()
    const picked = reduceSessionAccount(
      base,
      event('session/model-changed', { to: 'dall-e-3', provider: 'openai' }, 6_000),
      context(),
    )
    expect(picked.lastModel).toBe('dall-e-3')
    expect(picked.lastProvider).toBe('openai')
    // 它不是账目事件 —— `updatedAt` 一格不动(容器那一侧同样不由归约器盖)。
    expect(picked.updatedAt).toBeUndefined()
  })

  it('usage 三件按 `request/response.usage` 累加,contextSize 认最近一次请求', () => {
    // 取到 `run/end` 为止 —— 整份序列末尾那条 `message/deleted` 是截断,会把账扣掉
    // (下一只用例专门问它)。
    const account = fold(buildLedger().slice(0, 5))
    expect(account.totalInputTokens).toBe(100)
    expect(account.totalOutputTokens).toBe(20)
    expect(account.totalTokens).toBe(120)
    expect(account.contextSize).toBe(100)
    expect(account.lastInputTokens).toBe(100)
  })

  it('截断:按剩下的消息反推扣减,并把修复算进 lastTruncation', () => {
    const events = buildLedger()
    const account = foldSessionAccount(
      [
        ...events.slice(0, 5),
        event('message/deleted', { messageId: 'm2' }, 2_000),
      ],
      // 截断之后只剩用户那条(没有 usage)→ 120 全额扣回。
      context([{ id: 'm1', role: 'user' }]),
    )
    expect(account.totalTokens).toBe(0)
    expect(account.totalInputTokens).toBe(0)
    expect(account.lastTruncation?.subtracted).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    })
    // 剩下的消息一格 usage 都没有 → 重算出来的上下文是 0。
    expect(account.contextSize).toBe(0)
    expect(account.lastInputTokens).toBe(0)
  })

  it('`session/compacted` 落 summary 三件;失败的那条不落', () => {
    const base = createSessionAccountState()
    const ok = reduceSessionAccount(
      base,
      event('session/compacted', {
        summary: 's',
        messageId: 'c1',
        compactedMessageCount: 3,
        compactedThroughMessageId: 'm1',
      }, 7_000),
      context(),
    )
    expect(ok.summary).toBe('s')
    expect(ok.summaryUpToMessageId).toBe('m1')
    expect(ok.summaryCreatedAt).toBe(7_000)

    const failed = reduceSessionAccount(
      base,
      event('session/compacted', {
        summary: '',
        messageId: 'c2',
        compactedMessageCount: 0,
        status: 'failed',
      }, 7_001),
      context(),
    )
    expect(failed).toBe(base)
  })
})
