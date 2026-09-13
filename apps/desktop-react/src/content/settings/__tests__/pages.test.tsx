import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import {
  DEFAULT_SETTINGS_PAGE,
  SETTINGS_PAGES,
  isSettingsPageId,
  settingsPageOf,
} from '../pages'
import { zh } from '../../../i18n/zh'
import { en } from '../../../i18n/en'

/**
 * **页表本身的判据**(2026-09-13 分页)。
 *
 * 这一组不渲染任何一页 —— 那是 `settings-nav.test.tsx` 与各页自己的用例的事。
 * 它守的是**表**:id 不重复、缺省页在表上、两处文案都译过、`layout` 只有两档、
 * 每一行都答得出一个 React 元素。
 */
describe('设置页表', () => {
  it('id 不重复', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('缺省页在表上,而且 `isSettingsPageId` 认得表上每一个 id', () => {
    expect(isSettingsPageId(DEFAULT_SETTINGS_PAGE)).toBe(true)
    for (const page of SETTINGS_PAGES) expect(isSettingsPageId(page.id)).toBe(true)
  })

  it('**存档是不可信输入**:认不出的东西一律不是页 id', () => {
    for (const bad of ['nope', '', 'General', 0, null, undefined, {}, ['general']]) {
      expect(isSettingsPageId(bad)).toBe(false)
    }
  })

  it('认不出的 id 落缺省页 —— 屏幕上永远有一页', () => {
    expect(settingsPageOf('nope' as never).id).toBe(DEFAULT_SETTINGS_PAGE)
    for (const page of SETTINGS_PAGES) expect(settingsPageOf(page.id)).toBe(page)
  })

  it('`layout` 只有两档,而 `fill` 今天只有模型服务那一页', () => {
    for (const page of SETTINGS_PAGES) expect(['form', 'fill']).toContain(page.layout)
    expect(SETTINGS_PAGES.filter((p) => p.layout === 'fill').map((p) => p.id)).toEqual(['models'])
  })

  it('导航行与页标题共用的那个键,zh / en 都译过(不是拿 key 当文案画)', () => {
    for (const page of SETTINGS_PAGES) {
      expect(zh[page.titleKey], `zh 缺 ${page.titleKey}`).toBeTruthy()
      expect(en[page.titleKey], `en 缺 ${page.titleKey}`).toBeTruthy()
    }
  })

  /*
   * `render()` 只**造元素**,不挂载 —— 挂载要起一堆 store 与假端口,而这一条守的
   * 是「表上每一行都指得出一件东西」,不是那件东西画得对不对。
   */
  it('每一行都造得出一个元素', () => {
    for (const page of SETTINGS_PAGES) expect(isValidElement(page.render())).toBe(true)
  })
})
