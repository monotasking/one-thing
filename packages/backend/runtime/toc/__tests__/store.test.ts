import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SEGMENT_LOG_COMPACT_THRESHOLD, createSessionSegmentStore } from '../store.js'
import type { SessionSegment } from '../types.js'

let root: string

function store() {
  return createSessionSegmentStore({ getSessionsDir: () => root })
}

function segment(id: string, overrides: Partial<SessionSegment> = {}): SessionSegment {
  return {
    id,
    origin: 'inferred',
    kind: 'task',
    title: `segment ${id}`,
    detail: '',
    files: [],
    startedAt: 0,
    turnCount: 1,
    revision: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'toc-store-'))
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('session segment store', () => {
  it('returns nothing for a session that has no segments yet', async () => {
    expect(await store().read('s1')).toEqual([])
  })

  it('round-trips appended segments', async () => {
    const s = store()
    await s.append('s1', [segment('a', { startedAt: 100 }), segment('b', { startedAt: 200 })])

    const read = await s.read('s1')
    expect(read.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('lets a later append supersede an earlier revision of the same segment', async () => {
    // Segments are revised on nearly every turn; the log is append-only and
    // the fold is what makes the newest write win.
    const s = store()
    await s.append('s1', [segment('a', { title: 'first reading', revision: 0 })])
    await s.append('s1', [segment('a', { title: 'what it turned out to be', revision: 1 })])

    const read = await s.read('s1')
    expect(read).toHaveLength(1)
    expect(read[0]?.title).toBe('what it turned out to be')
    expect(read[0]?.revision).toBe(1)
  })

  it('orders segments by start time regardless of write order', async () => {
    const s = store()
    await s.append('s1', [segment('late', { startedAt: 900 })])
    await s.append('s1', [segment('early', { startedAt: 100 })])

    expect((await s.read('s1')).map(entry => entry.id)).toEqual(['early', 'late'])
  })

  it('skips a corrupt line instead of losing the whole table of contents', async () => {
    const s = store()
    await s.append('s1', [segment('a')])
    await fsp.appendFile(path.join(root, 's1', 'segments.jsonl'), '{ this is not json\n', 'utf-8')
    await s.append('s1', [segment('b')])

    expect((await s.read('s1')).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('compacts the log once it grows past the threshold', async () => {
    const s = store()
    for (let i = 0; i <= SEGMENT_LOG_COMPACT_THRESHOLD + 1; i++) {
      await s.append('s1', [segment('a', { title: `revision ${i}`, revision: i })])
    }

    const raw = await fsp.readFile(path.join(root, 's1', 'segments.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    // One live segment, so compaction should collapse the log to a single line.
    expect(lines.length).toBeLessThanOrEqual(2)

    const read = await s.read('s1')
    expect(read).toHaveLength(1)
    expect(read[0]?.revision).toBe(SEGMENT_LOG_COMPACT_THRESHOLD + 1)
  })

  it('keeps sessions separate', async () => {
    const s = store()
    await s.append('s1', [segment('a')])
    await s.append('s2', [segment('b')])

    expect((await s.read('s1')).map(entry => entry.id)).toEqual(['a'])
    expect((await s.read('s2')).map(entry => entry.id)).toEqual(['b'])
  })

  it('clears a session and tolerates clearing one that has nothing', async () => {
    const s = store()
    await s.append('s1', [segment('a')])
    await s.clear('s1')
    expect(await s.read('s1')).toEqual([])
    await expect(s.clear('s1')).resolves.toBeUndefined()
  })

  it('does not throw when the append target is unwritable', async () => {
    // Losing a TOC entry must never break the turn that produced it.
    const s = createSessionSegmentStore({
      getSessionsDir: () => path.join(root, 'file-in-the-way'),
      logger: { error: () => {} },
    })
    await fsp.writeFile(path.join(root, 'file-in-the-way'), 'not a directory', 'utf-8')

    await expect(s.append('s1', [segment('a')])).resolves.toBeUndefined()
  })
})
