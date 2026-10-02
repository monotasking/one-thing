/**
 * 批 6 留账:流到一半失败、换凭证重试时,失败那一次已经从旧文字流通道出去的半句收不回
 * (流帧词汇里没有「作废」,也不为它加)。账本在 `request/error` 上点名作废那几段
 * (`discardParts`),这条账本事件原样随总线下发(`SESSION_LEDGER_EVENT`);`Session`
 * 据它把同号的几截从累计值里摘掉,于是 dev 下 `sessions.validation` 不再报「内容不一致」。
 */
import { describe, expect, it } from 'vitest'
import { Session } from '../session.js'
import { SESSION_EVENT_TYPES } from '@shared/events/session-event-types.js'
import type { SessionEventEnvelope } from '@onething/backend/runtime/event-bus/types'
import type { StreamChunkBase } from '@shared/events/stream-chunks.js'

const stamp = (runId: string, partIndex: number, charOffset = 0) => ({
  messageId: 'm1', runId, requestIndex: 0, partIndex, kind: 'text', charOffset, gen: 0,
})

const text = (value: string, runId?: string, partIndex?: number): StreamChunkBase =>
  ({
    type: 'text-delta',
    text: value,
    ...(runId !== undefined && partIndex !== undefined ? { stamp: stamp(runId, partIndex) } : {}),
  } as unknown as StreamChunkBase)

const reasoning = (value: string, runId: string, partIndex: number): StreamChunkBase =>
  ({ type: 'reasoning-delta', reasoning: value, stamp: { ...stamp(runId, partIndex), kind: 'reasoning' } } as unknown as StreamChunkBase)

function ledger(record: unknown): SessionEventEnvelope {
  return {
    sessionId: 's1',
    seq: 1,
    timestamp: 0,
    event: { type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record },
  } as unknown as SessionEventEnvelope
}

const requestError = (runId: string, discardParts: number[] | undefined, willRetry = true) => ({
  type: 'request/error',
  data: { runId, requestIndex: 0, error: { message: '429' }, willRetry, attempt: 1, ...(discardParts ? { discardParts } : {}) },
})

describe('Session · 账本点名作废的段从累计值里摘掉', () => {
  it('失败那次的半句被摘掉,重试那一遍的整句留下', () => {
    const session = new Session('s1')
    session.applyChunk(reasoning('想一想', 'r1', 0))
    session.applyChunk(text('半', 'r1', 1))
    session.applyChunk(text('句', 'r1', 1))
    session.applyEvent(ledger(requestError('r1', [0, 1])))
    session.applyChunk(text('完整回答', 'r1', 2))
    expect(session.state.accumulatedContent).toBe('完整回答')
    expect(session.state.accumulatedReasoning).toBe('')
  })

  it('只摘点名的那条执行、那几段;别的执行同号段不动', () => {
    const session = new Session('s1')
    session.applyChunk(text('前一段。', 'r1', 0))
    session.applyChunk(text('别人的', 'r0', 1))
    session.applyChunk(text('半句', 'r1', 1))
    session.applyEvent(ledger(requestError('r1', [1])))
    expect(session.state.accumulatedContent).toBe('前一段。别人的')
  })

  it('没章的字认不到,不摘;不重试 / 没点名 / 别的账本事件一律不动', () => {
    const session = new Session('s1')
    session.applyChunk(text('旁路'))
    session.applyChunk(text('半句', 'r1', 0))
    session.applyEvent(ledger(requestError('r1', [0], false)))
    session.applyEvent(ledger(requestError('r1', undefined)))
    session.applyEvent(ledger({ type: 'assistant/part-end', data: { runId: 'r1', partIndex: 0 } }))
    expect(session.state.accumulatedContent).toBe('旁路半句')
    session.applyEvent(ledger(requestError('r1', [0])))
    expect(session.state.accumulatedContent).toBe('旁路')
  })

  it('新一轮 stream:start 连段表一起清', () => {
    const session = new Session('s1')
    session.applyChunk(text('上一轮', 'r1', 0))
    session.applyEvent({
      sessionId: 's1', seq: 2, timestamp: 0,
      event: { type: SESSION_EVENT_TYPES.STREAM_START, assistantMessageId: 'm2' },
    } as unknown as SessionEventEnvelope)
    session.applyChunk(text('这一轮', 'r2', 0))
    session.applyEvent(ledger(requestError('r1', [0])))
    expect(session.state.accumulatedContent).toBe('这一轮')
  })
})
