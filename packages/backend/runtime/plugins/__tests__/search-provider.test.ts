/**
 * M2 搜索供给方 —— core 契约层(结果形状校验 + 图标枚举 + surface 助手)。
 */
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PERMISSION_SEARCH_PROVIDE,
  PLUGIN_SEARCH_ICONS,
  PLUGIN_SEARCH_PROVIDER_RESULT_CAP,
  isPluginSearchIcon,
  pluginSearchProviderSurface,
  pluginSearchResultHasForbiddenKey,
  sanitizePluginSearchResults,
} from '../search-provider.js'

describe('M2 search provider — 结果形状是宿主枚举的受控子集', () => {
  it('exposes the declaration permission and surface helper', () => {
    expect(PLUGIN_PERMISSION_SEARCH_PROVIDE).toBe('search:provide')
    expect(pluginSearchProviderSurface('emoji')).toBe('search:emoji')
  })

  it('keeps only the allowed fields on a well-formed result', () => {
    const [result] = sanitizePluginSearchResults([
      { id: 'a', title: 'Alpha', subtitle: 'sub', detail: 'det', actionId: 'act', icon: 'emoji' },
    ])
    expect(result).toEqual({ id: 'a', title: 'Alpha', subtitle: 'sub', detail: 'det', actionId: 'act', icon: 'emoji' })
  })

  it('rejects a result that carries a boundary-crossing field entirely', () => {
    // filePath / sessionId / messageId 会让插件结果伪装成内置结果,诱导跳任意会话/文件。
    for (const forbidden of ['filePath', 'sessionId', 'messageId', 'type', 'shortcut', 'matchRanges', 'timestamp']) {
      expect(pluginSearchResultHasForbiddenKey({ id: 'x', title: 'X', [forbidden]: 'anything' })).toBe(true)
      const out = sanitizePluginSearchResults([{ id: 'x', title: 'X', [forbidden]: 'anything' }])
      expect(out, forbidden).toEqual([])
    }
  })

  it('drops results without an id or title', () => {
    expect(sanitizePluginSearchResults([{ title: 'no id' }, { id: 'no-title' }, {}])).toEqual([])
  })

  it('ignores unknown icon names but keeps the result', () => {
    const [result] = sanitizePluginSearchResults([{ id: 'a', title: 'A', icon: 'not-a-real-icon' }])
    expect(result.icon).toBeUndefined()
    expect(result.title).toBe('A')
    for (const icon of PLUGIN_SEARCH_ICONS) expect(isPluginSearchIcon(icon)).toBe(true)
    expect(isPluginSearchIcon('nope')).toBe(false)
  })

  it('caps the number of results a single provider can flood in', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, title: `R${i}` }))
    expect(sanitizePluginSearchResults(many)).toHaveLength(PLUGIN_SEARCH_PROVIDER_RESULT_CAP)
    expect(sanitizePluginSearchResults(many, { cap: 3 })).toHaveLength(3)
  })

  it('returns nothing for a non-array payload', () => {
    expect(sanitizePluginSearchResults(null)).toEqual([])
    expect(sanitizePluginSearchResults('bogus')).toEqual([])
  })
})
