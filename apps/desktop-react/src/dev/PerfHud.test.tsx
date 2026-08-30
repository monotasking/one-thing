import { afterEach, describe, expect, it } from 'vitest'
import { PERF_HUD_KEY, perfHudEnabled } from './PerfHud'

/**
 * HUD 开关契约(08-30 二次拍板:缺省一律关)。曾短暂 dev 缺省开——那时探针没有
 * 别的出口;通知系统上线后超预算走 notify(silent) 进中心,HUD 回归显式打开的仪表。
 */
describe('perfHudEnabled', () => {
  afterEach(() => localStorage.removeItem(PERF_HUD_KEY))

  it('没表态:缺省关 —— 不再自动出面(超预算的去处是通知中心)', () => {
    localStorage.removeItem(PERF_HUD_KEY)
    expect(perfHudEnabled()).toBe(false)
  })

  it("'1':强制开", () => {
    localStorage.setItem(PERF_HUD_KEY, '1')
    expect(perfHudEnabled()).toBe(true)
  })

  it("'0'(历史显式关的值):同样是关", () => {
    localStorage.setItem(PERF_HUD_KEY, '0')
    expect(perfHudEnabled()).toBe(false)
  })
})
