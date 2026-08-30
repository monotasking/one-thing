import { afterEach, describe, expect, it } from 'vitest'
import { PERF_HUD_KEY, perfHudEnabled } from './PerfHud'

/**
 * HUD 开关的三态契约(08-30「探针要会响」拍板):'1' 强制开、'0' 强制关、
 * 没表态走缺省档 —— dev 缺省开(vitest 跑在 dev 语义下,正好当这一档的证人),
 * 生产缺省关在这里测不到(import.meta.env 编译期定死),由构建产物自证。
 * '0' 那一档是新开出来的口子:dev 默认开之后,显式关掉必须仍然可能。
 */
describe('perfHudEnabled 三态', () => {
  afterEach(() => localStorage.removeItem(PERF_HUD_KEY))

  it("没表态:dev 缺省开", () => {
    localStorage.removeItem(PERF_HUD_KEY)
    expect(perfHudEnabled()).toBe(true)
  })

  it("'1':强制开", () => {
    localStorage.setItem(PERF_HUD_KEY, '1')
    expect(perfHudEnabled()).toBe(true)
  })

  it("'0':强制关 —— dev 里也关得掉", () => {
    localStorage.setItem(PERF_HUD_KEY, '0')
    expect(perfHudEnabled()).toBe(false)
  })
})
