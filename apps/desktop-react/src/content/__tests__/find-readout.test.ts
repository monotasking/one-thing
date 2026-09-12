import { describe, expect, it } from 'vitest'
import { findReadout } from '../find-readout'

/**
 * **查找读数三档 —— 一处判据,一组断言**(B3-b 合一)。
 *
 * 从前这组断言在 `terminal/__tests__/terminal-leaf.test.tsx` 与
 * `browser/__tests__/browser-b3a.test.tsx` 里各有一份(各自对着各自那只函数)。
 * 合一之后它们只剩「屏幕上那一格写的是什么」那半边的渲染断言 ——
 * **两处消费、一处判据**,而这就是那一处。
 *
 * 反证:把「`total <= 0` 答 `'0'`」那一支改成 `return null` → 这里红,
 * 终端与浏览器那两组渲染断言也跟着红(三处一起,正说明它们吃的是同一只)。
 */
describe('findReadout', () => {
  it('没词 → 整格不画', () => {
    expect(findReadout({ query: '', ordinal: 0, total: 0 })).toBeNull()
    expect(findReadout({ query: '', ordinal: 3, total: 17 })).toBeNull()
  })

  it('有词、零命中 →「0」(不变红、不抖、不弹东西)', () => {
    expect(findReadout({ query: 'x', ordinal: 0, total: 0 })).toBe('0')
  })

  it('序号不知道 → 只报总数,不编一个序号出来', () => {
    // 网页那一侧:Chromium 的中间结果偶尔只给总数(`activeMatchOrdinal` = 0)。
    expect(findReadout({ query: 'x', ordinal: 0, total: 9 })).toBe('9')
    // 终端那一侧:xterm 超出高亮上限时报 `resultIndex = -1`,调用点 `+1` 之后是 0。
    expect(findReadout({ query: 'x', ordinal: -1 + 1, total: 9 })).toBe('9')
  })

  it('序号知道 →「第几 / 共几」', () => {
    expect(findReadout({ query: 'x', ordinal: 3, total: 17 })).toBe('3/17')
  })
})
