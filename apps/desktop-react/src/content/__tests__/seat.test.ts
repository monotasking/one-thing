import { describe, expect, it } from 'vitest'
import { SEAT_LINES, SEAT_MIN_LINES, seatHeight } from '../seat'

/**
 * 座位几何的五支(正本 `docs/send-flow-2026-09.md` §3,起手那一格 09-21 按用户裁定
 * 改小,判词在 `docs/stream-geometry-2026-09.md` §8 裁定 A)。
 *
 * 纯函数,所以这一层不必起浏览器:量几何是 `ChatStream` 的活,**算**是这里的活。
 * 真机那一半在 `scripts/gate-send-flow.mjs` ①(发送后到座位长满,滚动只发生一段)
 * 与 `scripts/gate-stream-geometry.mjs` ⑧(落位后气泡下方的空白 ≤ 六行 + 尾槽)。
 */

const LINE = 22.4 // --pr-fs 14 × --pr-lh 1.6
const MIN = LINE * SEAT_MIN_LINES // 67.2 —— 三行下限
const CAP = LINE * SEAT_LINES // 134.4 —— 起手封顶

/** 一台常见的机器:760 高的聊天区、24 的置顶线、输入框那一格内衬 100。 */
const BASE = {
  viewportHeight: 760,
  sendLine: 24,
  reserveBelow: 100,
  lineHeight: LINE,
}

describe('座位几何', () => {
  it('① 常态:起手那一格减掉这一轮已经长了多高', () => {
    // room = 760 − 24 − 100 = 636;气泡 40 高,回复还没开口(tail = 气泡本身)。
    expect(seatHeight({ ...BASE, userHeight: 40, tailHeight: 40 })).toBeCloseTo(CAP, 5)
    // 回复长了 100 —— 座位缩掉同样多,`scrollHeight` 一格不变。
    expect(seatHeight({ ...BASE, userHeight: 40, tailHeight: 140 })).toBeCloseTo(CAP - 100, 5)
  })

  it('② 起手六行封顶:地再空也只留六行(09-21 用户裁定)', () => {
    // 空荡荡的一屏:room − userHeight = 596,远多于六行 —— 只留六行。
    expect(seatHeight({ ...BASE, userHeight: 40, tailHeight: 40 })).toBeCloseTo(CAP, 5)
    // 窗子再高一倍也还是六行:起手不再随视口走。
    expect(seatHeight({ ...BASE, viewportHeight: 1600, userHeight: 40, tailHeight: 40 })).toBeCloseTo(CAP, 5)
    // 气泡把地占到只剩 100(< 六行 134.4)时,按剩下的那点算 —— 取两者的小的。
    expect(seatHeight({ ...BASE, userHeight: 536, tailHeight: 536 })).toBeCloseTo(100, 5)
  })

  it('① 长满就归零,不会变成负数(之后退役为普通跟底)', () => {
    expect(seatHeight({ ...BASE, userHeight: 40, tailHeight: 40 + CAP })).toBe(0)
    expect(seatHeight({ ...BASE, userHeight: 40, tailHeight: 5000 })).toBe(0)
  })

  it('③ 三行下限:气泡快把地占满时,起手仍留三行', () => {
    // room − userHeight = 636 − 600 = 36 < 三行(67.2)→ 兜到下限(六行封顶不参与:36 已经更小)。
    expect(seatHeight({ ...BASE, userHeight: 600, tailHeight: 600 })).toBeCloseTo(MIN, 5)
    // **下限管的是起手不是终身**:回复照样把它吃掉,不留一块永远跟不了底的死白。
    expect(seatHeight({ ...BASE, userHeight: 600, tailHeight: 600 + MIN })).toBe(0)
  })

  it('④ 视口太矮:能用的地连三行都不到 → 答 0(退化为今天的落底 + 跟随)', () => {
    // 窄窗子:760 → 150,减掉置顶线与内衬只剩 26 < 67.2。
    expect(seatHeight({ ...BASE, viewportHeight: 150, userHeight: 40, tailHeight: 40 })).toBe(0)
    // 输入框打了十行字把内衬撑到 700 —— 同一支,产地不同。
    expect(seatHeight({ ...BASE, reserveBelow: 700, userHeight: 40, tailHeight: 40 })).toBe(0)
    // 停靠中 / jsdom:几何全是 0,同样答 0(量不到就不留座位)。
    expect(
      seatHeight({ viewportHeight: 0, sendLine: 0, reserveBelow: 0, lineHeight: 0, userHeight: 0, tailHeight: 0 }),
    ).toBe(0)
  })

  it('⑤ 自己那条比视口还高:座位取下限', () => {
    expect(seatHeight({ ...BASE, userHeight: 2000, tailHeight: 2000 })).toBeCloseTo(MIN, 5)
  })

  it('读数里混进 NaN 时当 0 算,不把 NaN 写到样式上', () => {
    // 气泡量不到 → 当 0 高:起手仍是六行,气泡之后那 40 照旧算长出来的。
    expect(seatHeight({ ...BASE, userHeight: Number.NaN, tailHeight: 40 })).toBeCloseTo(CAP - 40, 5)
    // 一行有多高量不到 → 下限与封顶都算不出来 → 老实答 0(退化,不是猜一个数)。
    expect(seatHeight({ ...BASE, lineHeight: Number.NaN, userHeight: 40, tailHeight: 40 })).toBe(0)
  })
})
