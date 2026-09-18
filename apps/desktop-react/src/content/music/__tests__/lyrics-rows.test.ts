import { describe, expect, it } from 'vitest'
import {
  INTERLUDE_MIN_SEC,
  currentRowAt,
  fillOf,
  hasWords,
  lyricRowsOf,
  nearestRowTo,
} from '../lyrics-rows'

/**
 * 歌词那一屏的纯算术(音乐面 v7)。判的是「读数怎么折成屏幕上那几行」,不碰 DOM。
 */

const line = (at: number, text: string) => ({ at, text })

describe('折行', () => {
  it('没词的行是间奏,而且只在它真的够长时才占一行', () => {
    const rows = lyricRowsOf(
      [
        line(0, '♪'), // 0 → 20,够长,画三点
        line(20, '第一句'),
        line(24, ''), // 24 → 26,只有两秒,整行不画
        line(26, '第二句'),
      ],
      60,
    )
    expect(rows.map((r) => [r.at, r.interlude])).toEqual([
      [0, true],
      [20, false],
      [26, false],
    ])
    expect(rows[0].end - rows[0].at).toBeGreaterThanOrEqual(INTERLUDE_MIN_SEC)
  })

  it('音符记号是排版不是词 —— 一整首只有 ♪ = 这首没有歌词', () => {
    expect(hasWords(lyricRowsOf([line(0, '♪'), line(30, '♫')], 90))).toBe(false)
    expect(hasWords(lyricRowsOf([line(0, '♪'), line(30, '有词')], 90))).toBe(true)
  })

  it('末句的尾巴取总长;总长答不出时给它五秒', () => {
    expect(lyricRowsOf([line(10, '末句')], 90)[0].end).toBe(90)
    expect(lyricRowsOf([line(10, '末句')], undefined)[0].end).toBe(15)
    // 总长比这一句还早(读数打架)时不许算出一个负的分母。
    expect(lyricRowsOf([line(10, '末句')], 4)[0].end).toBe(15)
  })
})

describe('唱到哪儿', () => {
  const rows = lyricRowsOf([line(0, '一'), line(10, '二'), line(20, '三')], 30)

  it('还没到第一句 = -1', () => {
    expect(currentRowAt(rows, undefined)).toBe(-1)
    expect(currentRowAt(rows, -1)).toBe(-1)
    expect(currentRowAt(rows, 0)).toBe(0)
    expect(currentRowAt(rows, 19.9)).toBe(1)
    expect(currentRowAt(rows, 99)).toBe(2)
  })

  it('逐字填色:句首 0,往回收的那 0.6 秒之前就填满', () => {
    expect(fillOf(rows[0], 0)).toBe(0)
    expect(fillOf(rows[0], 5)).toBeCloseTo(5 / 9.4, 3)
    expect(fillOf(rows[0], 9.4)).toBe(1)
    // 夹在 0…1 之间:位置落在别的句子上时不该算出 1.8。
    expect(fillOf(rows[0], 40)).toBe(1)
    expect(fillOf(rows[0], undefined)).toBe(0)
  })
})

describe('手动滚动时那条定位条', () => {
  const rows = lyricRowsOf([line(0, '一'), line(10, '♪'), line(30, '三')], 40)

  it('取视野正中最近的一句;间奏不参选(seek 到空当等于跳进没声音的地方)', () => {
    const boxes = [
      { top: 0, height: 20 },
      { top: 20, height: 40 },
      { top: 60, height: 20 },
    ]
    expect(rows[1].interlude).toBe(true)
    // 正中压在间奏身上,答的仍是上面那一句。
    expect(nearestRowTo(rows, boxes, 40)).toBe(0)
    expect(nearestRowTo(rows, boxes, 66)).toBe(2)
  })

  it('一句词都没有 = 没有可指的,答 -1', () => {
    const only = lyricRowsOf([line(0, '♪')], 40)
    expect(nearestRowTo(only, [{ top: 0, height: 20 }], 10)).toBe(-1)
  })
})
