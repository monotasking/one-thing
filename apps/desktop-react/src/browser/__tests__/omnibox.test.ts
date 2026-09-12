import { describe, expect, it } from 'vitest'

import {
  BROWSER_SEARCH_ENGINES,
  DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  isBrowserSearchInput,
  resolveBrowserOmniboxInput,
  resolveBrowserSearchEngine,
} from '../omnibox'

describe('browser search engines', () => {
  it('every engine carries exactly one %s query slot and an https homepage', () => {
    for (const engine of BROWSER_SEARCH_ENGINES) {
      expect(engine.searchUrl.split('%s')).toHaveLength(2)
      expect(engine.homeUrl).toMatch(/^https:\/\//)
    }
  })

  it('resolves known ids and falls back to the default on unknown/absent ids', () => {
    expect(resolveBrowserSearchEngine('baidu').id).toBe('baidu')
    expect(resolveBrowserSearchEngine('not-an-engine').id).toBe(DEFAULT_BROWSER_SEARCH_ENGINE_ID)
    expect(resolveBrowserSearchEngine(undefined).id).toBe(DEFAULT_BROWSER_SEARCH_ENGINE_ID)
    expect(resolveBrowserSearchEngine(null).id).toBe(DEFAULT_BROWSER_SEARCH_ENGINE_ID)
  })
})

describe('isBrowserSearchInput', () => {
  it('mirrors the resolver: search for spaces/dot-less, navigate otherwise', () => {
    expect(isBrowserSearchInput('electron webview')).toBe(true)
    expect(isBrowserSearchInput('天气')).toBe(true)
    expect(isBrowserSearchInput('example.com')).toBe(false)
    expect(isBrowserSearchInput('https://example.com')).toBe(false)
    expect(isBrowserSearchInput('')).toBe(false)
  })
})

describe('resolveBrowserOmniboxInput', () => {
  const google = resolveBrowserSearchEngine('google')
  const baidu = resolveBrowserSearchEngine('baidu')

  it('returns empty for blank input', () => {
    expect(resolveBrowserOmniboxInput('', google)).toBe('')
    expect(resolveBrowserOmniboxInput('   ', google)).toBe('')
  })

  it('passes explicit schemes through untouched', () => {
    expect(resolveBrowserOmniboxInput('https://example.com/a?b=1', google)).toBe(
      'https://example.com/a?b=1',
    )
    expect(resolveBrowserOmniboxInput('http://example.com', google)).toBe('http://example.com')
  })

  it('prefixes bare hosts with https', () => {
    expect(resolveBrowserOmniboxInput('example.com/path', google)).toBe(
      'https://example.com/path',
    )
  })

  it('searches with the given engine for spaces or dot-less input', () => {
    expect(resolveBrowserOmniboxInput('electron webview', google)).toBe(
      'https://www.google.com/search?q=electron%20webview',
    )
    expect(resolveBrowserOmniboxInput('天气', baidu)).toBe(
      `https://www.baidu.com/s?wd=${encodeURIComponent('天气')}`,
    )
  })

  it('URI-encodes queries so replace() never sees special replacement patterns', () => {
    expect(resolveBrowserOmniboxInput('a $& b', google)).toBe(
      'https://www.google.com/search?q=a%20%24%26%20b',
    )
  })
})
