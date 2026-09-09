/**
 * R2a —— `AuditProjector` 的钉子。
 *
 * 它只该看 Runner 发的那几条生命周期证词。一条工具事件都不该进审计 —— 那份证词是
 * 工具自己写的,而"打算做什么 vs 实际做了什么"必须由系统作证。
 */

import { describe, expect, it } from 'vitest'
import { Decision, Intent, Outcome, makeEffect, textResult } from '@onething/core/toolkit'
import type { Invocation } from '@onething/core/toolkit'
import { AuditProjector, combineObservers, type ToolAuditRecord } from '../audit-observer.js'

function invocationFor(overrides: Partial<Invocation> = {}): Invocation {
  return {
    callId: 'call-1',
    toolId: 'write',
    input: {},
    sessionId: 'session-1',
    messageId: 'message-1',
    principal: { kind: 'user', userId: 'local' },
    ...overrides,
  }
}

const INTENT = Intent.of({
  effects: [
    makeEffect('file_write', ['/repo/*']),
    makeEffect('file_write', ['/other/*']),
    makeEffect('external_directory', ['/other/*']),
  ],
  preview: { title: 'Create a.ts' },
  payload: null,
})

function projector() {
  const records: ToolAuditRecord[] = []
  return { records, observer: new AuditProjector(record => records.push(record), { now: () => 1_700 }) }
}

describe('AuditProjector', () => {
  it('planned + decided + finished 攒成一条记录,finished 时落盘', () => {
    const { records, observer } = projector()
    const invocation = invocationFor()

    observer.on(invocation, { type: 'lifecycle', phase: 'planned', intent: INTENT })
    observer.on(invocation, { type: 'lifecycle', phase: 'decided', decision: Decision.allow({ asked: true }) })
    expect(records).toHaveLength(0)

    observer.on(invocation, { type: 'lifecycle', phase: 'finished', outcome: Outcome.ok(textResult('ok')) })
    expect(records).toEqual([{
      callId: 'call-1',
      toolId: 'write',
      sessionId: 'session-1',
      // K2a':主体原样转手 —— 无会话的那一档没有会话可回溯,这一格是唯一的线索。
      principal: { kind: 'user', userId: 'local' },
      messageId: 'message-1',
      // 效果**类**去重,条数如实报 —— 索引看类,细节在 preview。
      effects: ['file_write', 'external_directory'],
      effectCount: 3,
      previewTitle: 'Create a.ts',
      decision: 'allow',
      asked: true,
      outcome: 'ok',
      at: 1_700,
    }])
  })

  it('工具事件一条都不进审计', () => {
    const { records, observer } = projector()
    const invocation = invocationFor()
    observer.on(invocation, { type: 'progress', message: 'half way' })
    observer.on(invocation, { type: 'annotate', title: 'faked', details: { decision: 'allow' } })
    observer.on(invocation, { type: 'partial', result: textResult('x') })
    observer.on(invocation, { type: 'lifecycle', phase: 'finished', outcome: Outcome.aborted() })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'aborted', effects: [], effectCount: 0, decision: undefined })
  })

  it('拦截器的归因进记录(被挡下的那一次根本没有 planned)', () => {
    const { records, observer } = projector()
    const invocation = invocationFor()
    observer.on(invocation, {
      type: 'lifecycle', phase: 'intercepted', action: 'block', by: ['plugin:guard'], reason: 'nope',
    })
    observer.on(invocation, { type: 'lifecycle', phase: 'finished', outcome: Outcome.denied('nope') })
    expect(records[0]).toMatchObject({
      outcome: 'denied',
      intercepted: { action: 'block', by: ['plugin:guard'] },
    })
  })

  it('并行的两次调用各记各的(一个字段会让它们互相覆盖)', () => {
    const { records, observer } = projector()
    const first = invocationFor({ callId: 'a', toolId: 'read' })
    const second = invocationFor({ callId: 'b', toolId: 'bash' })

    observer.on(first, { type: 'lifecycle', phase: 'planned', intent: Intent.none(null) })
    observer.on(second, { type: 'lifecycle', phase: 'planned', intent: INTENT })
    observer.on(second, { type: 'lifecycle', phase: 'finished', outcome: Outcome.failed(new Error('boom')) })
    observer.on(first, { type: 'lifecycle', phase: 'finished', outcome: Outcome.ok(textResult('ok')) })

    expect(records.map(record => [record.callId, record.outcome, record.effectCount]))
      .toEqual([['b', 'failed', 3], ['a', 'ok', 0]])
  })

  it('sink 自己炸了不影响别人(它是旁观者)', () => {
    const boom = new AuditProjector(() => { throw new Error('disk full') })
    expect(() => boom.on(invocationFor(), {
      type: 'lifecycle', phase: 'finished', outcome: Outcome.ok(textResult('ok')),
    })).not.toThrow()
  })
})

describe('combineObservers', () => {
  it('把多个观察者摊成一个,并且一个坏掉不拖垮另一个', () => {
    const seen: string[] = []
    const observer = combineObservers(
      { on: () => { throw new Error('projector exploded') } },
      { on: (_invocation, event) => seen.push(event.type) },
    )
    observer.on(invocationFor(), { type: 'progress' })
    expect(seen).toEqual(['progress'])
  })
})
