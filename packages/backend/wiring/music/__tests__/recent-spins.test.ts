import { describe, expect, it } from 'vitest'
import type { OnethingRadioBrief } from '@onething/runtime/music/radio-store'
import { recentSpins } from '../recent-spins.js'

const A = 'A'.repeat(32)
const B = 'B'.repeat(32)
const C = 'C'.repeat(32)

function brief(patch: Partial<OnethingRadioBrief>): OnethingRadioBrief {
  return { active: true, intent: '', played: [], skipped: [], loved: [], ...patch }
}

describe('recentSpins (the brief\'s `recent`, 2026-09-18)', () => {
  it('newest first, only this run, durations carried, verdicts by id and time', () => {
    const out = recentSpins(
      brief({
        startedAt: '2026-09-18T12:00:00Z',
        played: [
          { title: 'old', at: '2026-09-17T12:00:00Z', encryptedId: C },
          { title: 'a', at: '2026-09-18T12:01:00Z', encryptedId: A, durationS: 200 },
          { title: 'b', at: '2026-09-18T12:04:00Z', encryptedId: B },
          { title: 'c', at: '2026-09-18T12:06:00Z', encryptedId: C },
        ],
        loved: [{ title: 'a', at: '2026-09-18T12:02:00Z', encryptedId: A.toLowerCase() }],
        // a skip of C from yesterday must not stick to tonight's C
        skipped: [
          { title: 'b', at: '2026-09-18T12:05:00Z', encryptedId: B },
          { title: 'old', at: '2026-09-17T12:01:00Z', encryptedId: C },
        ],
      }),
    )
    expect(out.map((s) => [s.title, s.verdict, s.durationS])).toEqual([
      ['c', undefined, undefined],
      ['b', 'skip', undefined],
      ['a', 'love', 200],
    ])
  })
  it('caps at RADIO_RECENT_LIMIT', () => {
    const played = Array.from({ length: 30 }, (_, i) => ({ title: `s${i}`, at: `2026-09-18T12:${String(i).padStart(2, '0')}:00Z` }))
    const out = recentSpins(brief({ startedAt: '2026-09-18T11:00:00Z', played }))
    expect(out).toHaveLength(12)
    expect(out[0]?.title).toBe('s29')
  })
})
