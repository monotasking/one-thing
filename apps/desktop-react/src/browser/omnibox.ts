/**
 * Omnibox —— 地址栏那一行输入怎么变成一个 URL。
 *
 * ## 为什么它住在壳里(B1-a 搬家)
 *
 * 它从前在 `packages/shared/ipc/browser.ts`,和那份 19 动词的 `browserRouter` 契约
 * 一起。那份契约是 2026-08-23 A1-b 立的、**没有任何人 import 过**(B1-a 深查:全仓
 * 零消费者),整只删了 —— 今天浏览器的数据面是 `browser:` 资源(`resources.read` /
 * `resources.do`),不是一份手写 router。
 *
 * 而这三件是**纯的前端判据**:「用户敲的这一行是一个地址,还是一句要搜的话」。
 * 它跨不了进程(主进程从来不问这个问题),所以它不属于 `@shared/ipc` —— 它是壳
 * 自己的事。搬过来之后 `@shared` 里再没有一行 browser。
 *
 * 三个函数与它们的判据**逐字未改**:搬家不是改判据(同批的测试原样搬过来,
 * 一条断言都没动,就是这句话的证据)。
 */

export type BrowserSearchEngineId = 'google' | 'bing' | 'baidu' | 'duckduckgo'

/** A selectable omnibox search engine. `searchUrl` carries a single `%s` query slot. */
export interface BrowserSearchEngine {
  id: BrowserSearchEngineId
  name: string
  /** Two-to-three char label for the start page's engine ring (谷歌/必应/百度/DDG). */
  shortName: string
  /** Single glyph for the start page's inline engine token (G/B/百/D). */
  token: string
  /** The engine's own homepage — reachable from the start page, never auto-opened. */
  homeUrl: string
  /** Query URL template; `%s` is replaced with the URI-encoded query. */
  searchUrl: string
}

export const DEFAULT_BROWSER_SEARCH_ENGINE_ID: BrowserSearchEngineId = 'google'

/**
 * The selectable engines — single source of truth for the omnibox (query URL),
 * the start page's engine ring and the settings picker.
 *
 * **Where the selection is persisted is an open question** (B2). The old shell kept
 * it in the main process (`browser/search-engine.json`); that file went with the Vue
 * host and B1-a did not bring it back — nothing reads a persisted engine yet, so the
 * default below is the whole story today.
 */
export const BROWSER_SEARCH_ENGINES: readonly BrowserSearchEngine[] = [
  {
    id: 'google',
    name: '谷歌 Google',
    shortName: '谷歌',
    token: 'G',
    homeUrl: 'https://www.google.com/',
    searchUrl: 'https://www.google.com/search?q=%s',
  },
  {
    id: 'bing',
    name: '必应 Bing',
    shortName: '必应',
    token: 'B',
    homeUrl: 'https://www.bing.com/',
    searchUrl: 'https://www.bing.com/search?q=%s',
  },
  {
    id: 'baidu',
    name: '百度',
    shortName: '百度',
    token: '百',
    homeUrl: 'https://www.baidu.com/',
    searchUrl: 'https://www.baidu.com/s?wd=%s',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    shortName: 'DDG',
    token: 'D',
    homeUrl: 'https://duckduckgo.com/',
    searchUrl: 'https://duckduckgo.com/?q=%s',
  },
]

/** Engine for an id, falling back to the default on unknown/absent ids. */
export function resolveBrowserSearchEngine(id: string | null | undefined): BrowserSearchEngine {
  return (
    BROWSER_SEARCH_ENGINES.find((engine) => engine.id === id) ??
    BROWSER_SEARCH_ENGINES.find((engine) => engine.id === DEFAULT_BROWSER_SEARCH_ENGINE_ID)!
  )
}

/**
 * True when omnibox input will be searched rather than navigated to. Exported so
 * the omnibox can *show* which of the two Enter does — the "no dot → search"
 * rule is invisible otherwise, and duplicating it in the UI would let the two
 * drift apart.
 */
export function isBrowserSearchInput(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (/^[a-z]+:\/\//i.test(trimmed)) return false
  return /\s/.test(trimmed) || !/\./.test(trimmed)
}

/**
 * Omnibox input → URL: explicit scheme passes through, bare host/path gets
 * https://, anything with a space or without a dot becomes an engine search.
 * Returns '' for empty input (caller skips navigation).
 */
export function resolveBrowserOmniboxInput(raw: string, engine: BrowserSearchEngine): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (isBrowserSearchInput(trimmed)) {
    // encodeURIComponent escapes '$', so the replacement can't trip String.replace's
    // special `$` patterns.
    return engine.searchUrl.replace('%s', encodeURIComponent(trimmed))
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
