/**
 * **会话生命周期订阅口**(共享层读侧补齐 E 批)。
 *
 * 折叠是纯函数,所以主体测的是它 —— 不用造宿主。最后一节钉的是"订阅口真的骑
 * **当前宿主那份客户端的事件枢纽**上的 `session:event`",那是这个模块 C2 之后
 * 唯一的接线事实(折叠器本体已搬进 `@onething/client`,这里只剩接线)。
 */
import { describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { SessionEventEnvelope } from '@shared/events/index.js'

const hoisted = vi.hoisted(() => ({
  handlers: [] as ((envelope: SessionEventEnvelope) => void)[],
  unsubscribed: 0,
}))

vi.mock('../client', () => ({
  currentClient: () => ({
    events: {
      on: (name: string, callback: (envelope: SessionEventEnvelope) => void) => {
        // 名字打错就收不到 —— 这一格钉的正是"骑的是 `session:event` 那条"。
        if (name !== 'session:event') return () => {}
        hoisted.handlers.push(callback)
        return () => {
          hoisted.unsubscribed += 1
        }
      },
    },
  }),
}))

const { foldSessionLifecycleEvent, onSessionLifecycle } = await import('../session-lifecycle')

function envelope(event: unknown, sessionId = 's1'): SessionEventEnvelope {
  return { sessionId, sequence: 1, timestamp: 0, event } as unknown as SessionEventEnvelope
}

describe('foldSessionLifecycleEvent —— 建', () => {
  it('账本第一条 `session/created` 折成 created', () => {
    const folded = foldSessionLifecycleEvent(envelope({
      type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
      record: {
        seq: 1,
        type: 'session/created',
        data: { sessionId: 'new-1', kind: 'room', agentId: 'a1' },
      },
    }))
    expect(folded).toEqual({
      type: 'created',
      sessionId: 'new-1',
      kind: 'room',
      agentId: 'a1',
    })
  })

  it('普通对话没有 kind 时那一格干脆缺席', () => {
    const folded = foldSessionLifecycleEvent(envelope({
      type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
      record: { seq: 1, type: 'session/created', data: { sessionId: 'new-2' } },
    }))
    expect(folded).toEqual({ type: 'created', sessionId: 'new-2' })
  })

  it('账本上其余的词一律放过 —— 生命周期只有建这一条', () => {
    for (const type of ['user/message', 'run/start', 'tool/call', 'session/compacted']) {
      expect(foldSessionLifecycleEvent(envelope({
        type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
        record: { seq: 2, type, data: {} },
      }))).toBeUndefined()
    }
  })
})

describe('foldSessionLifecycleEvent —— 删', () => {
  it('`session:removed` 折成 deleted,带上级联的那一批', () => {
    const folded = foldSessionLifecycleEvent(envelope({
      type: SESSION_EVENT_TYPES.SESSION_REMOVED,
      sessionId: 'parent',
      cascadedSessionIds: ['parent', 'child'],
    }, 'parent'))
    expect(folded).toEqual({
      type: 'deleted',
      sessionId: 'parent',
      cascadedSessionIds: ['parent', 'child'],
    })
  })

  it('缺 cascadedSessionIds 时退化成只有自己', () => {
    const folded = foldSessionLifecycleEvent(envelope({
      type: SESSION_EVENT_TYPES.SESSION_REMOVED,
      sessionId: 'only',
    }, 'only'))
    expect(folded).toEqual({ type: 'deleted', sessionId: 'only', cascadedSessionIds: ['only'] })
  })

  it('用的是会话事件那条词,不是全局总线那条 —— 两张表的值必须不相交', () => {
    expect(SESSION_EVENT_TYPES.SESSION_REMOVED).toBe('session:removed')
    expect(Object.values(SESSION_EVENT_TYPES)).not.toContain('session:deleted')
  })
})

describe('foldSessionLifecycleEvent —— 不是这两件事', () => {
  it('普通会话事件、坏信封一律 undefined', () => {
    expect(foldSessionLifecycleEvent(envelope({ type: SESSION_EVENT_TYPES.STREAM_START }))).toBeUndefined()
    expect(foldSessionLifecycleEvent(envelope(undefined))).toBeUndefined()
    expect(foldSessionLifecycleEvent(envelope({}))).toBeUndefined()
    expect(foldSessionLifecycleEvent(undefined as never)).toBeUndefined()
  })
})

describe('onSessionLifecycle', () => {
  it('骑客户端事件枢纽的 session:event,只把这两件事交出去', () => {
    hoisted.handlers = []
    hoisted.unsubscribed = 0
    const seen: unknown[] = []
    const off = onSessionLifecycle(event => seen.push(event))
    const emit = hoisted.handlers[0]

    emit(envelope({ type: SESSION_EVENT_TYPES.STREAM_START }))
    emit(envelope({
      type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
      record: { seq: 1, type: 'session/created', data: { sessionId: 'x' } },
    }))
    emit(envelope({ type: SESSION_EVENT_TYPES.SESSION_REMOVED, sessionId: 'x' }, 'x'))

    expect(seen).toEqual([
      { type: 'created', sessionId: 'x' },
      { type: 'deleted', sessionId: 'x', cascadedSessionIds: ['x'] },
    ])

    off()
    expect(hoisted.unsubscribed).toBe(1)
  })
})
