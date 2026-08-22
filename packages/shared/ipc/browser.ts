/**
 * Browser (embedded WebContentsView) Module
 * Wire contracts for the Workbench embedded browser — a main-process
 * WebContentsView per web-tab, overlaid on a renderer placeholder div.
 * The renderer holds a mirror only; BrowserViewService in
 * apps/electron/src/browser/ is the source of truth. See
 * docs/design/browser-v2.md + docs/design/browser-v2/p0-implementation.md.
 *
 * NOTE: this is the real embedded web browser. It is unrelated to the
 * WorkbenchTab 'browser' type's legacy <iframe>, which stays only as the
 * apps/web (no-WebContentsView host) fallback.
 */

import { defineRouter } from './router.js'

/** Placeholder-div rect the WebContentsView must track, in renderer CSS px (DIP). */
export interface BrowserViewBounds {
	x: number
	y: number
	width: number
	height: number
}

export interface BrowserCreateTabRequest {
	/** Initial URL; omitted → new-tab start page. */
	url?: string
	/** Create in the background without stealing foreground (AI new_tab default). */
	background?: boolean
}

/** One web-tab's mirrored state. Source of truth lives in BrowserViewService. */
export interface BrowserTabInfo {
	id: string
	url: string
	title: string
	favicon?: string
	loading: boolean
	canGoBack: boolean
	canGoForward: boolean
	/** Set when the render process crashed; the view shows a crash page until reload. */
	crashed?: boolean
}

export interface BrowserSimpleResponse {
	success: boolean
	error?: string
}

export interface BrowserCreateTabResponse {
	success: boolean
	tab?: BrowserTabInfo
	error?: string
}

export interface BrowserTabIdRequest {
	tabId: string
}

export interface BrowserNavigateRequest {
	tabId: string
	url: string
}

/** Placeholder geometry sync (renderer→main), throttled on the renderer via rAF. */
export interface BrowserSetBoundsRequest {
	bounds: BrowserViewBounds
}

/**
 * Show/hide the active WebContentsView. Native views sit above all DOM, so the
 * renderer hides the view during collapse animations and when a modal overlay
 * intersects the workbench region (overlay-presence signal). Full geometry sync
 * is TODO(browser-geometry): finalize against terminal's final workbench layout.
 */
export interface BrowserSetVisibleRequest {
	visible: boolean
}

/**
 * Full-state snapshot pulled once on store mount (pull-then-subscribe), before
 * consuming the incremental patch stream — avoids the "panel restored but
 * mirror empty" drift.
 */
export interface BrowserHydrateResponse {
	success: boolean
	tabs: BrowserTabInfo[]
	activeTabId: string | null
	error?: string
}

/**
 * Push payload on IPC_CHANNELS.BROWSER_TABS_CHANGED — a single coalesced batch
 * (~30ms window in the service) instead of ten fine-grained events per
 * navigation. `patch` carries only changed fields per tabId; `removed` lists
 * closed tabs; `activeTabId`/`order` reflect the current tab list when they
 * change. The renderer store applies it in one pass.
 */
export interface BrowserTabsChangedEvent {
	patch: Array<Partial<BrowserTabInfo> & { id: string }>
	removed?: string[]
	activeTabId?: string | null
	/** Full tab-id order, present only when tabs were added/removed/reordered. */
	order?: string[]
}

/**
 * A web element captured in pick mode — becomes a structured composer attachment
 * (element screenshot + text excerpt + source URL/title). See docs/design/browser-v2.md §P2.
 */
export interface PickedWebElement {
	/** The picked element's screenshot as a PNG data URL ('' if capture failed). */
	image: string
	/** Source page URL. */
	sourceUrl: string
	/** Source page title (falls back to hostname). */
	sourceTitle: string
	/** Text excerpt of the element (≤2k chars). */
	excerpt: string
	/** True when the element was larger than the viewport — screenshot is the visible part. */
	clipped: boolean
}

/**
 * Response of BROWSER_PICK_ELEMENT. `element` is null when the user cancelled
 * (Escape / re-toggle / navigation) — a normal outcome, not an error.
 */
export interface BrowserPickResponse {
	success: boolean
	element?: PickedWebElement | null
	error?: string
}

// ── search engines ───────────────────────────────────────────

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
 * The selectable engines — single source of truth for the renderer omnibox
 * (query URL), the start page's engine ring and the settings picker. The
 * selection itself is persisted by the main process (browser/search-engine.json).
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

/** Response of BROWSER_GET/SET_SEARCH_ENGINE — the persisted selection. */
export interface BrowserSearchEngineResponse {
	success: boolean
	engineId: BrowserSearchEngineId
	error?: string
}

export interface BrowserSetSearchEngineRequest {
	engineId: string
}

/** A browser profile — an isolated persistent partition (Chrome-style login). */
export interface BrowserProfile {
	id: string
	name: string
}

export interface BrowserProfilesResponse {
	success: boolean
	profiles: BrowserProfile[]
	activeProfileId: string
	error?: string
}

export interface BrowserAddProfileRequest {
	name: string
}

export interface BrowserProfileIdRequest {
	profileId: string
}

/**
 * 内嵌浏览器的**宿主壳路由**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 19 条请求面从 `IPC_CHANNELS.BROWSER_*` 那批手写通道搬到 `shell:invoke` 上的一份
 * 处理者表(`apps/electron/src/ipc/shell/browser.ts`)。判据与 A1-a 的八个窗口域
 * 一致:处理者动的是 `WebContentsView` —— 主进程里真真切切的一扇原生视图 ——
 * 所以它是**壳面**而不是数据面,去的是宿主那张派发表,不是装配层的 `rpc:invoke`。
 *
 * **`BROWSER_TABS_CHANGED` 不在这张表上**:那是推送(一次合批的标签态广播),
 * router 今天没有推送面,所以它连同 `onBrowserTabsChanged` 一起原样留在手写通道上。
 *
 * 每条的输入/输出都复用上面那批既有类型 —— 这批只搬路,不改 wire 形状。无参的三条
 * (`hydrate` / `getSearchEngine` / `listProfiles`)按 router 的惯例收一个空信封。
 */
export type BrowserRoutes = {
	hydrate: { input: Record<string, never>; output: BrowserHydrateResponse }
	createTab: { input: BrowserCreateTabRequest; output: BrowserCreateTabResponse }
	closeTab: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	selectTab: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	navigate: { input: BrowserNavigateRequest; output: BrowserSimpleResponse }
	goBack: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	goForward: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	reload: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	stop: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	setBounds: { input: BrowserSetBoundsRequest; output: BrowserSimpleResponse }
	setVisible: { input: BrowserSetVisibleRequest; output: BrowserSimpleResponse }
	pickElement: { input: BrowserTabIdRequest; output: BrowserPickResponse }
	pickCancel: { input: BrowserTabIdRequest; output: BrowserSimpleResponse }
	getSearchEngine: { input: Record<string, never>; output: BrowserSearchEngineResponse }
	setSearchEngine: { input: BrowserSetSearchEngineRequest; output: BrowserSearchEngineResponse }
	listProfiles: { input: Record<string, never>; output: BrowserProfilesResponse }
	addProfile: { input: BrowserAddProfileRequest; output: BrowserProfilesResponse }
	removeProfile: { input: BrowserProfileIdRequest; output: BrowserProfilesResponse }
	switchProfile: { input: BrowserProfileIdRequest; output: BrowserProfilesResponse }
}

export const browserRouter = defineRouter<BrowserRoutes>('browser', [
	'hydrate',
	'createTab',
	'closeTab',
	'selectTab',
	'navigate',
	'goBack',
	'goForward',
	'reload',
	'stop',
	'setBounds',
	'setVisible',
	'pickElement',
	'pickCancel',
	'getSearchEngine',
	'setSearchEngine',
	'listProfiles',
	'addProfile',
	'removeProfile',
	'switchProfile',
])
