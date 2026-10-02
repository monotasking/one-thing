import { describe, expect, it } from 'vitest'
import { matchSongFromSearch, songPlayFlagFromSearch } from '../identify.js'
import { ncmMusicProvider } from '../providers/ncm/index.js'

const HEX = 'D71F6E90EA704F1C44183933E7E0F197'

/** Parse through the real ncm provider — the pair the production path uses. */
const records = (raw: unknown[]) =>
  ncmMusicProvider.cli.parse.searchRecords(JSON.stringify({ code: 200, data: { records: raw } }))

describe('matchSongFromSearch', () => {
  it('matches only an exact "name - artist" against the player title', () => {
    const parsed = records([
      { id: HEX, originalId: 30431364, name: '光', artists: [{ name: '陈粒' }] },
    ])
    expect(matchSongFromSearch(parsed, '光 - 陈粒')).toEqual({
      encryptedId: HEX,
      originalId: '30431364',
    })
    // The exact failure this guards: a bare or drifted title must NOT match.
    expect(matchSongFromSearch(parsed, '光')).toBeNull()
    expect(matchSongFromSearch(parsed, '光 - 陈粒粒')).toBeNull()
  })

  it('skips covers and picks the exact artist', () => {
    const cover = HEX.slice(0, 31) + '8'
    const parsed = records([
      { id: cover, originalId: 1, name: '晴天', artists: [{ name: 'B-KLl' }] },
      { id: HEX, originalId: 2, name: '晴天', artists: [{ name: '周杰伦' }] },
    ])
    expect(matchSongFromSearch(parsed, '晴天 - 周杰伦')?.encryptedId).toBe(HEX)
  })

  it('malformed ids never survive the ncm parser (32-hex is NetEase law)', () => {
    const parsed = records([
      { id: 'short', originalId: 1, name: 'x', artists: [{ name: 'y' }] },
    ])
    expect(parsed).toEqual([])
    expect(matchSongFromSearch(parsed, 'x - y')).toBeNull()
    expect(matchSongFromSearch(records([]), 'x - y')).toBeNull()
    expect(ncmMusicProvider.cli.parse.searchRecords('not json')).toEqual([])
  })

  it('a single-id record mirrors its primary id into originalId', () => {
    // Generic contract for future providers without a dual-id model.
    expect(
      matchSongFromSearch(
        [{ primaryId: 'abc', title: 'x', artist: 'y' }],
        'x - y',
      ),
    ).toEqual({ encryptedId: 'abc', originalId: 'abc' })
  })
})

describe('songPlayFlagFromSearch (silent-start post-mortem)', () => {
  it('reads the flag off the id-matched record, case-insensitively', () => {
    const parsed = records([
      { id: HEX.slice(0, 31) + '8', name: '海浪', playFlag: true }, // a different version
      { id: HEX.toLowerCase(), name: '海浪', playFlag: false },
    ])
    expect(songPlayFlagFromSearch(parsed, { encryptedId: HEX })).toBe(false)
  })

  it('falls back to originalId when the encrypted id is not in the results', () => {
    // 琵琶语 field case: the curated album variant ranked below the search
    // cutoff under its own encrypted id, but originalId still pins the record.
    const parsed = records([
      { id: HEX.slice(0, 31) + '8', originalId: 120169, name: '琵琶语', playFlag: false },
    ])
    expect(
      songPlayFlagFromSearch(parsed, { encryptedId: HEX, originalId: '120169' }),
    ).toBe(false)
    expect(
      songPlayFlagFromSearch(parsed, { encryptedId: HEX, originalId: '999' }),
    ).toBeNull()
  })

  it('null when the id is absent or the flag is missing', () => {
    expect(
      songPlayFlagFromSearch(records([{ id: HEX, name: 'x' }]), { encryptedId: HEX }),
    ).toBeNull()
    expect(songPlayFlagFromSearch([], { encryptedId: HEX })).toBeNull()
  })
})
