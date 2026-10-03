import { describe, expect, it } from 'vitest'
import {
  collectGoalFileSpans,
  summarizeGoalFileChanges,
  type GoalFileMutationRecordLike,
} from '../file-changes.js'

const SINCE = Date.parse('2026-07-14T00:00:00.000Z')

function record(overrides: Partial<GoalFileMutationRecordLike>): GoalFileMutationRecordLike {
  return {
    sessionId: 's1',
    timestamp: '2026-07-14T10:00:00.000Z',
    filePath: '/repo/a.ts',
    beforeExists: true,
    afterExists: true,
    beforeContent: 'one\ntwo',
    afterContent: 'one\ntwo\nthree',
    ...overrides,
  }
}

describe('summarizeGoalFileChanges', () => {
  it('reduces multiple edits of one file to the net earliest-before → latest-after span', () => {
    const changes = summarizeGoalFileChanges(
      [
        record({
          timestamp: '2026-07-14T10:00:00.000Z',
          beforeContent: 'a',
          afterContent: 'a\nb',
        }),
        record({
          timestamp: '2026-07-14T11:00:00.000Z',
          beforeContent: 'a\nb',
          afterContent: 'a\nb\nc\nd',
        }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )

    expect(changes).toEqual([{ path: '/repo/a.ts', added: 3, removed: 0 }])
  })

  it('drops files that end up byte-identical (edited then reverted)', () => {
    const changes = summarizeGoalFileChanges(
      [
        record({ beforeContent: 'a', afterContent: 'a\nb', timestamp: '2026-07-14T10:00:00.000Z' }),
        record({ beforeContent: 'a\nb', afterContent: 'a', timestamp: '2026-07-14T11:00:00.000Z' }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )
    expect(changes).toEqual([])
  })

  it('counts created and deleted files against empty content', () => {
    const changes = summarizeGoalFileChanges(
      [
        record({
          filePath: '/repo/new.ts',
          beforeExists: false,
          beforeContent: '',
          afterContent: 'x\ny\nz',
        }),
        record({
          filePath: '/repo/gone.ts',
          afterExists: false,
          beforeContent: 'p\nq',
          afterContent: '',
        }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )

    expect(changes).toEqual([
      { path: '/repo/gone.ts', added: 0, removed: 2 },
      { path: '/repo/new.ts', added: 3, removed: 0 },
    ])
  })

  it('ignores other sessions and mutations before the goal window', () => {
    const changes = summarizeGoalFileChanges(
      [
        record({ sessionId: 'other' }),
        record({ timestamp: '2026-07-13T23:00:00.000Z' }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )
    expect(changes).toEqual([])
  })

  // A reorder nets out to 0/0 under a multiset count, but the file did change
  // and the review diff must show it. The numstat row is the honest 0/0.
  it('keeps a pure line reorder, which the review diff can still show', () => {
    const reorder = record({ beforeContent: 'a\nb', afterContent: 'b\na' })
    expect(summarizeGoalFileChanges([reorder], { sessionId: 's1', sinceMs: SINCE })).toEqual([
      { path: '/repo/a.ts', added: 0, removed: 0 },
    ])
    expect(collectGoalFileSpans([reorder], { sessionId: 's1', sinceMs: SINCE })).toHaveLength(1)
  })
})

describe('collectGoalFileSpans', () => {
  it('carries the net before/after content the review diffs are built from', () => {
    const spans = collectGoalFileSpans(
      [
        record({
          timestamp: '2026-07-14T10:00:00.000Z',
          beforeContent: 'a',
          afterContent: 'a\nb',
        }),
        record({
          timestamp: '2026-07-14T11:00:00.000Z',
          beforeContent: 'a\nb',
          afterContent: 'a\nb\nc',
        }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )

    expect(spans).toEqual([
      {
        path: '/repo/a.ts',
        beforeExists: true,
        beforeContent: 'a',
        afterExists: true,
        afterContent: 'a\nb\nc',
      },
    ])
  })

  // The card and the review must never disagree about which files a goal
  // touched, so both projections drop the same reverted file.
  it('drops reverted files, matching the numstat summary', () => {
    const spans = collectGoalFileSpans(
      [
        record({ beforeContent: 'a', afterContent: 'a\nb', timestamp: '2026-07-14T10:00:00.000Z' }),
        record({ beforeContent: 'a\nb', afterContent: 'a', timestamp: '2026-07-14T11:00:00.000Z' }),
      ],
      { sessionId: 's1', sinceMs: SINCE },
    )
    expect(spans).toEqual([])
  })
})
