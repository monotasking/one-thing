import { describe, expect, it } from 'vitest'
import { lyricIndexAt, positionAt, splitTitle } from '../turntable'
import { applyProgrammeAction } from '../../../data/music-source'

describe('歌名拆两半', () => {
  it('「歌名 - 歌手」', () => {
    expect(splitTitle('可惜没如果 - 林俊杰')).toEqual({ name: '可惜没如果', artist: '林俊杰' })
  })
  it('歌名里自带横杠时按最后一个分隔拆', () => {
    expect(splitTitle('A - B Remix - 某人')).toEqual({ name: 'A - B Remix', artist: '某人' })
  })
  it('认不出分隔 / 空', () => {
    expect(splitTitle('晴天')).toEqual({ name: '晴天', artist: '' })
    expect(splitTitle(undefined)).toEqual({ name: '', artist: '' })
  })
})

describe('播放钟', () => {
  const sample = { position: 10, duration: 20, playing: true, sampledAt: 1000 }
  it('播放中按墙钟往前推', () => {
    expect(positionAt(sample, 4000)).toBe(13)
  })
  it('推到总长为止', () => {
    expect(positionAt(sample, 60_000)).toBe(20)
  })
  it('暂停停在读数上;时钟倒退不往回推', () => {
    expect(positionAt({ ...sample, playing: false }, 9000)).toBe(10)
    expect(positionAt(sample, 0)).toBe(10)
  })
  it('歌词行:还没到第一行是 -1', () => {
    const lines = [{ at: 5 }, { at: 9 }, { at: 30 }]
    expect(lyricIndexAt(lines, 0)).toBe(-1)
    expect(lyricIndexAt(lines, 9)).toBe(1)
    expect(lyricIndexAt(lines, 100)).toBe(2)
  })
})

describe('节目单编辑的乐观补丁', () => {
  const view = { entries: ['a', 'b', 'c'].map((id) => ({ encryptedId: id, title: id })) }
  const ids = (v: typeof view) => v.entries.map((e) => e.encryptedId).join('')

  it('remove / promote / move', () => {
    expect(ids(applyProgrammeAction(view, { action: { kind: 'remove', encryptedId: 'b' } }))).toBe('ac')
    expect(ids(applyProgrammeAction(view, { action: { kind: 'promote', encryptedId: 'c' } }))).toBe('cab')
    expect(ids(applyProgrammeAction(view, { action: { kind: 'move', encryptedId: 'a', toIndex: 1 } }))).toBe('bac')
  })

  it('认不出的编辑原样交回', () => {
    expect(applyProgrammeAction(view, { action: { kind: 'remove', encryptedId: 'zz' } })).toBe(view)
    expect(applyProgrammeAction(view, {})).toBe(view)
    expect(applyProgrammeAction(view, { action: { kind: 'move', encryptedId: 'a' } })).toBe(view)
  })
})
