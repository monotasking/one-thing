import { describe, expect, it } from 'vitest'
import type { MusicProgrammeEntryDTO, MusicRadioSpinDTO } from '@shared/ipc/music'
import {
  angleAtPoint,
  angleForSide,
  bandAt,
  deckGeometry,
  labelColorsFor,
  needleAt,
  needleRadius,
  R_IN,
  R_OUT,
  recordSideOf,
  sideAtAngle,
  sideProgress,
  UNKNOWN_TRACK_S,
} from '../record-geometry'

const spin = (title: string, durationS?: number): MusicRadioSpinDTO => ({ title, at: '2026-09-18T12:00:00Z', durationS })
const entry = (title: string, durationS?: number, say?: string): MusicProgrammeEntryDTO => ({
  encryptedId: title.padEnd(32, '0').slice(0, 32),
  title,
  durationS,
  say,
})

describe('deckGeometry', () => {
  it('narrow: record hugs the left, lyrics fill the rest; wide: record + lyrics centred', () => {
    const n = deckGeometry(420, 300, false)
    expect(n.D).toBe(Math.round(420 * 0.47))
    expect(n.lyricsRight).toBe(0)
    expect(n.lyricsLeft).toBeGreaterThan(n.rx + n.D)
    const w = deckGeometry(1040, 380, true)
    expect(w.D).toBe(348)
    const blockW = w.lyricsLeft - w.rx + 460
    expect(Math.abs(w.rx - (1040 - (w.rx + blockW)))).toBeLessThan(2)
  })
  it('rest angle puts the needle off the record; the groove range is monotone and reachable', () => {
    const g = deckGeometry(420, 300, false)
    expect(needleRadius(g, 0)).toBeGreaterThan(1)
    const outer = angleForSide(g, 0)
    const inner = angleForSide(g, 1)
    expect(inner).toBeGreaterThan(outer)
    expect(needleRadius(g, outer)).toBeCloseTo(R_IN, 2)
    expect(needleRadius(g, inner)).toBeCloseTo(R_OUT, 2)
    expect(sideAtAngle(g, angleForSide(g, 0.37))).toBeCloseTo(0.37, 2)
  })
  it('the lyric anchor sits at the needle height mid-side (needle reads the lyric)', () => {
    const g = deckGeometry(1040, 380, true)
    const mid = needleAt(g, angleForSide(g, 0.5))
    expect(Math.abs(mid.y - g.anchorY)).toBeLessThan(g.R * 0.12)
  })
  it('angleAtPoint inverts needleAt', () => {
    const g = deckGeometry(420, 300, false)
    const n = needleAt(g, 23)
    expect(angleAtPoint(g, n.x, n.y)).toBeCloseTo(23, 5)
  })
})

describe('recordSideOf', () => {
  it('no song = no side', () => {
    expect(recordSideOf({ nowTitle: undefined, nowDuration: 100, recent: [], entries: [] })).toBeNull()
  })
  it('third song of the run: two played bands, then current, then two from the programme', () => {
    const side = recordSideOf({
      nowTitle: 'c',
      nowDuration: 180,
      recent: [spin('c', 180), spin('b', 200), spin('a')],
      entries: [entry('d', 190, '先说一句'), entry('e'), entry('f'), entry('g')],
    })!
    expect(side.letter).toBe('A')
    expect(side.bands.map((b) => [b.title, b.kind, b.seconds, b.talk])).toEqual([
      ['a', 'played', UNKNOWN_TRACK_S, false],
      ['b', 'played', 200, false],
      ['c', 'current', 180, false],
      ['d', 'ahead', 190, true],
      ['e', 'ahead', UNKNOWN_TRACK_S, false],
    ])
    expect(side.current).toBe(2)
    expect(side.overflow).toBe(2)
  })
  it('sixth song opens side B as its first band', () => {
    const recent = ['f', 'e', 'd', 'c', 'b', 'a'].map((t) => spin(t, 100))
    const side = recordSideOf({ nowTitle: 'f', nowDuration: 100, recent, entries: [entry('g')] })!
    expect(side.letter).toBe('B')
    expect(side.current).toBe(0)
    expect(side.bands.map((b) => b.title)).toEqual(['f', 'g'])
  })
  it('player plays something the radio did not record: it is the first band', () => {
    const side = recordSideOf({ nowTitle: 'x', nowDuration: undefined, recent: [spin('a')], entries: [] })!
    expect(side.current).toBe(0)
    expect(side.bands[0]).toMatchObject({ title: 'x', seconds: UNKNOWN_TRACK_S })
  })
})

describe('progress and bands', () => {
  const side = recordSideOf({
    nowTitle: 'b',
    nowDuration: 100,
    recent: [spin('b', 100), spin('a', 100)],
    entries: [entry('c', 200)],
  })!
  it('sideProgress counts the played bands plus the position', () => {
    expect(sideProgress(side, 50)).toBeCloseTo(150 / 400)
    expect(sideProgress(side, 999)).toBeCloseTo(200 / 400)
  })
  it('bandAt never goes back to a played band', () => {
    expect(bandAt(side, 0.05)).toEqual({ index: 1, seconds: 0 })
    expect(bandAt(side, 0.3)).toEqual({ index: 1, seconds: 20 })
    expect(bandAt(side, 0.75)).toEqual({ index: 2, seconds: 100 })
  })
})

it('label colours are a pure function of the title', () => {
  expect(labelColorsFor('雨棚下 - 旧电扇')).toEqual(labelColorsFor('雨棚下 - 旧电扇'))
  expect(labelColorsFor('a')).not.toEqual(labelColorsFor('b'))
})
