import { describe, expect, it, vi } from 'vitest'
import { createSessionProjectionState, reduceSessionProjection, type SessionLogEventRecord } from '@onething/core/session'
import { createSessionEventReads } from '../events-reads.js'

function projection() {
  let state = createSessionProjectionState()
  let seq = 0
  const write = (type: SessionLogEventRecord['type'], data: unknown) => {
    state = reduceSessionProjection(state, { type, data, seq: ++seq, time: seq } as SessionLogEventRecord)
  }
  write('message/imported', { message: { id: 'history', role: 'user', content: 'old', timestamp: 1,
    attachments: [{ id: 'image', base64Data: { hash: 'abcd1234', bytes: 4, mime: 'image/png' } }],
  } })
  write('run/start', { runId: 'active', kind: 'send', assistantMessageId: 'current', timestamp: 2 })
  write('assistant/chunks', { runId: 'active', requestIndex: 0, messageId: 'current', partIndex: 0,
    kind: 'text', time0: 3, dt: [0], text: ['first'] })
  return { get state() { return state }, write }
}

describe('event read projection memo ownership', () => {
  it('preserves old snapshots, rev and hidden semantics across revisions', () => {
    const source = projection()
    const resolveBlob = vi.fn(() => 'AAAA')
    const reads = createSessionEventReads({ getLogPath: () => 'unused',
      projections: { getLiveSessionProjection: () => source.state, hasLiveSessionProjection: () => true },
      materializeOptions: () => ({ resolveBlob }),
    })
    try {
      const first = reads.eventsListMessages('a')!
      expect(first[1].contentParts ?? []).toEqual([])
      expect(reads.eventsListMessages('a')).toBe(first)
      expect(resolveBlob).toHaveBeenCalledTimes(1)
      source.write('assistant/chunks', { runId: 'active', requestIndex: 0, messageId: 'current', partIndex: 0,
        kind: 'text', time0: 4, dt: [0], text: [' second'] })
      const next = reads.eventsListMessages('a')!
      expect(next[0]).toBe(first[0])
      expect(next[1].content).toBe('first second')
      expect(first[1].content).toBe('first')
      expect(resolveBlob).toHaveBeenCalledTimes(1)
      // Imported nested fields are detached even if the live projection is
      // mutated in place by its legitimate owner on the next revision.
      const imported = source.state.nodes[0]
      if (imported.kind !== 'message') throw new Error('Expected imported node')
      ;(imported.message.attachments as Array<{ id: string }>)[0].id = 'changed'
      imported.rev++
      expect((first[0].attachments as Array<{ id: string }>)[0].id).toBe('image')
      expect((reads.eventsListMessages('a')![0].attachments as Array<{ id: string }>)[0].id).toBe('changed')
      source.write('message/deleted', { messageId: 'history' })
      expect(reads.eventsListMessages('a')!.map(message => message.id)).toEqual(['current'])
      expect(first.map(message => message.id)).toEqual(['history', 'current'])
      expect(next[0].seq).toBe(first[0].seq)
    } finally { reads.dispose() }
  })

  it('partitions by session and generation and clears one session without evicting another', () => {
    let source = projection()
    const resolves = new Map<string, number>()
    const reads = createSessionEventReads({ getLogPath: () => 'unused',
      projections: { getLiveSessionProjection: () => source.state, hasLiveSessionProjection: () => true },
      materializeOptions: id => ({ resolveBlob: () => { resolves.set(id, (resolves.get(id) ?? 0) + 1); return id } }),
    })
    try {
      const a = reads.eventsListMessages('a')!
      const b = reads.eventsListMessages('b')!
      expect(a[0]).not.toBe(b[0])
      expect(a[0].attachments?.[0].base64Data).toBe('a')
      expect(b[0].attachments?.[0].base64Data).toBe('b')
      reads.resetSessionEventReadCache('a')
      expect(reads.eventsListMessages('a')![0]).not.toBe(a[0])
      expect(reads.eventsListMessages('b')).toBe(b)
      expect(resolves).toEqual(new Map([['a', 2], ['b', 1]]))
      source = projection()
      expect(reads.eventsListMessages('b')![0]).not.toBe(b[0])
      reads.resetSessionEventReadCache()
      reads.eventsListMessages('b')
      expect(resolves.get('b')).toBe(3)
    } finally { reads.dispose() }
  })

  it('does not memoize a missing or failed blob resolution before later recovery', () => {
    const source = projection()
    let available = false
    const resolveBlob = vi.fn(() => available ? 'recovered' : undefined)
    const onIssue = vi.fn()
    const reads = createSessionEventReads({ getLogPath: () => 'unused',
      projections: { getLiveSessionProjection: () => source.state, hasLiveSessionProjection: () => true },
      materializeOptions: () => ({ resolveBlob, onIssue }),
    })
    try {
      const missing = reads.eventsListMessages('a')!
      expect(onIssue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'blob-missing' }))
      available = true
      const recovered = reads.eventsListMessages('a')!
      expect(resolveBlob).toHaveBeenCalledTimes(2)
      expect(recovered[0].attachments?.[0].base64Data).toBe('recovered')
      expect(missing[0].attachments?.[0].base64Data).toMatchObject({ hash: 'abcd1234' })
      expect(reads.eventsListMessages('a')).toBe(recovered)
      expect(resolveBlob).toHaveBeenCalledTimes(2)
    } finally { reads.dispose() }
  })
})
