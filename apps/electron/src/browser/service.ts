/**
 * BrowserViewService — source of truth for the embedded browser. One
 * WebContentsView per web-tab, overlaid on the renderer's placeholder div; the
 * renderer store is a mirror fed by a single coalesced BROWSER_TABS_CHANGED
 * batch. Lives in the electron-host layer (NOT the assembly layer like the
 * terminal service) because its surface is all electron (WebContentsView /
 * session / debugger) and P0 has no cross-host consumer — see
 * docs/design/browser-v2/p0-implementation.md §1.
 *
 * Geometry (bounds/visible/fullscreen) is written against today's single-Tabs
 * workbench; TODO(browser-geometry): revisit after terminal P1 split-tree.
 */
import { WebContentsView, net, session, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
	type BrowserSearchEngineId,
	type BrowserTabInfo,
	type BrowserTabsChangedEvent,
	type BrowserViewBounds,
	type PickedWebElement,
} from '@shared/ipc.js'
import {
	getBrowserPartitionSession,
	removeBrowserPartitionSession,
	whenBrowserPartitionReady,
} from './session.js'
import { getSearchEngineId, setSearchEngineId } from './search-engine.js'
import { ensureWidevineReady } from './widevine.js'
import { PICK_SCRIPT, CANCEL_PICK_SCRIPT, type RawPickedElement } from './pick-script.js'
import {
	DEFAULT_PROFILE_ID,
	getActiveProfileId,
	partitionForProfile,
	listProfiles as loadProfileList,
	addProfile as persistAddProfile,
	removeProfile as persistRemoveProfile,
	setActiveProfile as persistSetActiveProfile,
	type BrowserProfile,
} from './profiles.js'
import {
	createTabStateCoalescer,
	roundBoundsToDip,
	type DipRect,
	type TabStateCoalescer,
} from './tab-state.js'

const COALESCE_MS = 30

export interface BrowserBroadcaster {
	sendTabsChanged(event: BrowserTabsChangedEvent): void
}

/** Host provides the main window so views can be attached to its contentView. */
export type BrowserWindowProvider = () => BrowserWindow | null | undefined

interface TabRecord {
	id: string
	view: WebContentsView
	info: BrowserTabInfo
	/** The profile partition this tab was born on — its loads wait on THAT proxy replay. */
	partition: string
}

export class BrowserViewService {
	private readonly tabs = new Map<string, TabRecord>()
	private order: string[] = []
	private activeTabId: string | null = null
	/** Which browser profile (isolated login partition) new tabs open on. */
	private activeProfileId: string | null = null
	private bounds: DipRect = { x: 0, y: 0, width: 0, height: 0 }
	private visible = true
	/** HTML5 fullscreen (a page video, etc.) — the active view fills the whole window. */
	private fullscreen = false
	private readonly onWindowResize = () => {
		if (this.fullscreen) this.applyActiveBounds()
	}
	private readonly coalescer: TabStateCoalescer
	private flushTimer: ReturnType<typeof setTimeout> | null = null

	constructor(
		private readonly windowProvider: BrowserWindowProvider,
		private readonly getBroadcaster: () => BrowserBroadcaster | null,
	) {
		this.coalescer = createTabStateCoalescer((event) => {
			this.getBroadcaster()?.sendTabsChanged(event)
		})
		// Widevine must be readied before the browser loads DRM content; kick it off
		// the moment the browser subsystem first wakes (memoized). Since 2026-09-03
		// this is a **no-op in production** — the repo runs official Electron, which
		// ships no CDM; the call survives so a CDM-bearing base would just work.
		void ensureWidevineReady()
	}

	createTab(url?: string, background = false): BrowserTabInfo {
		const id = randomUUID()
		// No explicit URL → an EMPTY tab: url '' means "start page", the renderer's
		// own DOM (docs/design/browser-ui/newtab-4up.html 案一). Nothing is loaded
		// and the WebContentsView stays hidden (see applyActiveVisibility) until the
		// user actually navigates — no engine homepage, no network on tab open.
		const initialUrl = url ?? ''
		const partition = partitionForProfile(this.ensureActiveProfile())
		const view = new WebContentsView({
			webPreferences: {
				session: getBrowserPartitionSession(partition),
			},
		})
		const info: BrowserTabInfo = {
			id,
			url: initialUrl,
			title: '',
			loading: false,
			canGoBack: false,
			canGoForward: false,
		}
		const record: TabRecord = { id, view, info, partition }
		this.tabs.set(id, record)
		this.order.push(id)
		this.wireWebContents(record)

		const win = this.windowProvider()
		win?.contentView.addChildView(view)
		view.setVisible(false)

		if (!background || this.activeTabId === null) {
			this.setActiveTab(id)
		}
		this.coalescer.mark(id, info)
		this.coalescer.setOrder(this.order)
		this.scheduleFlush()

		// STRIPPED: the CDP identity override + persistent debugger were my own
		// addition and an untested variable in Google's "not secure" block (Google
		// flags debugger/automation). Cleanest embedded state = clean Chrome UA
		// string (session.setUserAgent) + proxy, NO CDP attached. Testing whether
		// a naked embedded browser passes Google where the "clever" one failed.
		if (initialUrl) this.loadWhenPartitionReady(record, initialUrl)
		return info
	}

	/**
	 * Every load goes through here: a freshly created profile partition applies
	 * setProxy async, and the first request must not race it out DIRECT. Settled
	 * partitions resolve in a microtask. The tab waits on ITS OWN partition —
	 * the active profile may have moved on since the tab was born.
	 */
	private loadWhenPartitionReady(record: TabRecord, url: string): void {
		void whenBrowserPartitionReady(record.partition)
			.then(() => {
				if (!record.view.webContents.isDestroyed()) {
					return record.view.webContents.loadURL(url)
				}
			})
			.catch(() => undefined)
	}

	/**
	 * Closing the LAST tab leaves a fresh start page behind rather than an empty
	 * panel: the panel has no "no tab" state to fall back to (its viewport is a
	 * placeholder rect), and a start page now costs nothing — no view, no request.
	 * `respawn: false` is for callers that are about to open their own tab (profile
	 * switch), where a respawn would land on the OLD profile.
	 */
	closeTab(tabId: string, respawn = true): void {
		const record = this.tabs.get(tabId)
		if (!record) return
		// Destroying the focused view leaves the window with nothing focused —
		// hand focus back to the app renderer so the start page's line is live
		// immediately (⌘W then typing, with no click in between).
		const hadFocus = this.isRecordFocused(record)
		this.detachAndDestroy(record)
		this.tabs.delete(tabId)
		this.order = this.order.filter((id) => id !== tabId)

		if (this.activeTabId === tabId) {
			this.activeTabId = null
			const next = this.order[this.order.length - 1] ?? null
			if (next) this.setActiveTab(next)
			else this.coalescer.setActive(null)
		}
		this.coalescer.remove(tabId)
		this.coalescer.setOrder(this.order)
		if (respawn && this.order.length === 0) this.createTab()
		if (hadFocus) this.windowProvider()?.webContents.focus()
		this.scheduleFlush()
	}

	/** Close whatever tab is active — the ⌘W path when the page owns focus. */
	closeActiveTab(): void {
		if (this.activeTabId) this.closeTab(this.activeTabId)
	}

	/**
	 * True when the embedded page itself owns keyboard focus. The menu is the only
	 * place ⌘T/⌘W can be caught while a WebContentsView has focus (DOM keydown
	 * never reaches the app renderer then), so the menu asks this to decide
	 * whether those keys belong to the browser or to the chat tab tree.
	 */
	hasFocus(): boolean {
		const record = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
		return !!record && this.isRecordFocused(record)
	}

	private isRecordFocused(record: TabRecord): boolean {
		const wc = record.view.webContents
		return !wc.isDestroyed() && wc.isFocused()
	}

	selectTab(tabId: string): void {
		if (!this.tabs.has(tabId)) return
		this.setActiveTab(tabId)
		this.scheduleFlush()
	}

	navigate(tabId: string, url: string): void {
		const record = this.tabs.get(tabId)
		if (!record) return
		this.loadWhenPartitionReady(record, url)
	}

	goBack(tabId: string): void {
		const wc = this.tabs.get(tabId)?.view.webContents
		if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
	}

	goForward(tabId: string): void {
		const wc = this.tabs.get(tabId)?.view.webContents
		if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
	}

	reload(tabId: string): void {
		this.tabs.get(tabId)?.view.webContents.reload()
	}

	stop(tabId: string): void {
		this.tabs.get(tabId)?.view.webContents.stop()
	}

	/**
	 * Enter element-pick mode on a tab: inject the pick overlay, wait for the
	 * user to click an element (or cancel), then screenshot the picked rect and
	 * assemble a structured attachment. Resolves null on cancel (Esc / re-toggle
	 * / navigation), never throws to the caller. See docs/design/browser-v2.md §P2.
	 */
	async pickElement(tabId: string): Promise<PickedWebElement | null> {
		const record = this.tabs.get(tabId)
		if (!record || record.view.webContents.isDestroyed()) return null
		const wc = record.view.webContents
		let raw: RawPickedElement | null
		try {
			raw = (await wc.executeJavaScript(PICK_SCRIPT, true)) as RawPickedElement | null
		} catch {
			// Page navigated / context destroyed mid-pick — treat as cancel.
			return null
		}
		if (!raw || wc.isDestroyed()) return null

		// The picked rect is viewport CSS px — the same space capturePage clips in.
		let image = ''
		try {
			const shot = await wc.capturePage({
				x: raw.rect.x,
				y: raw.rect.y,
				width: raw.rect.width,
				height: raw.rect.height,
			})
			image = shot.isEmpty() ? '' : shot.toDataURL()
		} catch {
			image = ''
		}

		return {
			image,
			sourceUrl: raw.sourceUrl,
			sourceTitle: raw.sourceTitle,
			excerpt: raw.excerpt,
			clipped: raw.clipped,
		}
	}

	/** Cancel an in-flight pick on a tab (host-driven, e.g. re-toggling the button). */
	cancelPick(tabId: string): void {
		const wc = this.tabs.get(tabId)?.view.webContents
		if (wc && !wc.isDestroyed()) {
			void wc.executeJavaScript(CANCEL_PICK_SCRIPT, true).catch(() => undefined)
		}
	}

	setBounds(bounds: BrowserViewBounds): void {
		this.bounds = roundBoundsToDip(bounds)
		this.applyActiveBounds()
	}

	setVisible(visible: boolean): void {
		this.visible = visible
		this.applyActiveVisibility()
	}

	hydrate(): { tabs: BrowserTabInfo[]; activeTabId: string | null } {
		return {
			tabs: this.order.map((id) => ({ ...this.tabs.get(id)!.info })),
			activeTabId: this.activeTabId,
		}
	}

	killAll(): void {
		if (this.fullscreen) this.setFullscreen(false)
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		for (const record of this.tabs.values()) this.detachAndDestroy(record)
		this.tabs.clear()
		this.order = []
		this.activeTabId = null
	}

	// ── search engine (omnibox queries + the start page's default) ─

	getSearchEngine(): { engineId: BrowserSearchEngineId } {
		return { engineId: getSearchEngineId() }
	}

	/** Persist the selection; unknown ids keep the current one. Existing tabs stay put. */
	setSearchEngine(engineId: string): { engineId: BrowserSearchEngineId } {
		setSearchEngineId(engineId)
		return this.getSearchEngine()
	}

	// ── profiles (Chrome-style isolated logins) ────────────────

	private ensureActiveProfile(): string {
		if (this.activeProfileId === null) this.activeProfileId = getActiveProfileId()
		return this.activeProfileId
	}

	listProfiles(): { profiles: BrowserProfile[]; activeProfileId: string } {
		return { profiles: loadProfileList().profiles, activeProfileId: this.ensureActiveProfile() }
	}

	addProfile(name: string): { profiles: BrowserProfile[]; activeProfileId: string } {
		persistAddProfile(name)
		return this.listProfiles()
	}

	/** Switch the active profile: close the old profile's tabs, open a fresh one. */
	switchProfile(profileId: string): { profiles: BrowserProfile[]; activeProfileId: string } {
		if (!persistSetActiveProfile(profileId)) return this.listProfiles()
		if (this.ensureActiveProfile() !== profileId) {
			for (const tabId of [...this.order]) this.closeTab(tabId, false)
			this.activeProfileId = profileId
			this.createTab()
		}
		return this.listProfiles()
	}

	/**
	 * Remove a profile (the default is never removable). If it was active, switch
	 * back to default first, then wipe the removed profile's partition storage so
	 * "remove" actually logs the account out.
	 */
	removeProfile(profileId: string): { profiles: BrowserProfile[]; activeProfileId: string } {
		if (profileId === DEFAULT_PROFILE_ID) return this.listProfiles()
		const wasActive = this.ensureActiveProfile() === profileId
		const partition = partitionForProfile(profileId)
		const newActive = persistRemoveProfile(profileId)
		if (wasActive) this.switchProfile(newActive)
		try {
			void session.fromPartition(partition).clearStorageData().catch(() => undefined)
		} catch {
			// partition may not exist on disk — nothing to wipe
		}
		// Evict the dead partition so it stops riding along in proxy re-application
		// and the cache doesn't grow without bound on profile churn.
		removeBrowserPartitionSession(partition)
		return this.listProfiles()
	}

	// ── internals ──────────────────────────────────────────────

	private setActiveTab(tabId: string): void {
		if (this.activeTabId === tabId) return
		const prev = this.activeTabId ? this.tabs.get(this.activeTabId) : null
		prev?.view.setVisible(false)
		this.activeTabId = tabId
		this.applyActiveBounds()
		this.applyActiveVisibility()
		this.coalescer.setActive(tabId)
	}

	private applyActiveBounds(): void {
		if (!this.activeTabId) return
		const view = this.tabs.get(this.activeTabId)?.view
		if (!view) return
		if (this.fullscreen) {
			const win = this.windowProvider()
			if (win) {
				const [width, height] = win.getContentSize()
				view.setBounds({ x: 0, y: 0, width, height })
				return
			}
		}
		view.setBounds(this.bounds)
	}

	private setFullscreen(next: boolean): void {
		if (this.fullscreen === next) return
		this.fullscreen = next
		const win = this.windowProvider()
		if (next) win?.on('resize', this.onWindowResize)
		else win?.off('resize', this.onWindowResize)
		this.applyActiveBounds()
	}

	/**
	 * A tab with no URL is on the start page — the renderer draws that in DOM, so
	 * this tab's (blank white) native view must stay hidden or it would cover it.
	 * Gating here rather than in the renderer keeps one owner of view visibility;
	 * the gate lifts by itself when the first navigation commits a URL.
	 */
	private applyActiveVisibility(): void {
		for (const [id, record] of this.tabs) {
			record.view.setVisible(this.visible && id === this.activeTabId && !!record.info.url)
		}
	}

	private detachAndDestroy(record: TabRecord): void {
		const win = this.windowProvider()
		try {
			win?.contentView.removeChildView(record.view)
		} catch {
			// window already gone
		}
		if (!record.view.webContents.isDestroyed()) {
			record.view.webContents.close()
		}
	}

	private wireWebContents(record: TabRecord): void {
		const wc = record.view.webContents

		// New-window requests (target=_blank, window.open, ctrl-click) open an
		// in-app tab — NOT the system browser. Opening externally makes the
		// embedded browser feel broken (a search-result click escapes the app).
		// Full opener/postMessage preservation for OAuth popups is P1a's
		// createWindow override; here we lose opener but keep the URL in-app,
		// and non-http schemes (mailto:, etc.) still hand off to the OS.
		wc.setWindowOpenHandler(({ url, disposition }) => {
			if (/^https?:\/\//i.test(url)) {
				// cmd/middle-click opens in the background; target=_blank foregrounds.
				this.createTab(url, disposition === 'background-tab')
			} else if (url && url !== 'about:blank') {
				void shell.openExternal(url)
			}
			return { action: 'deny' }
		})

		const refresh = (patch: Partial<BrowserTabInfo>) => {
			const wasBlank = !record.info.url
			Object.assign(record.info, patch)
			this.syncNavFlags(record)
			// Leaving the start page (first committed URL) un-gates this tab's view.
			if (wasBlank && record.info.url) this.applyActiveVisibility()
			this.coalescer.mark(record.id, { ...record.info })
			this.scheduleFlush()
		}

		wc.on('page-title-updated', (_e, title) => refresh({ title }))
		wc.on('page-favicon-updated', (_e, favicons) => {
			const iconUrl = favicons[0]
			if (!iconUrl) {
				refresh({ favicon: undefined })
				return
			}
			if (iconUrl.startsWith('data:')) {
				refresh({ favicon: iconUrl })
				return
			}
			// Fetch through the BROWSER partition (not the app renderer, whose
			// defaultSession may carry a proxy → ERR_NO_SUPPORTED_PROXIES, and
			// which shouldn't reach out to arbitrary page resources anyway).
			void fetchFaviconDataUrl(iconUrl).then((dataUrl) => {
				if (this.tabs.has(record.id)) refresh({ favicon: dataUrl })
			})
		})
		// Loading state drives the omnibox progress bar, so it must mean "the main
		// document is being replaced" — NOT Electron's did-start-loading, which
		// mirrors the WebContents' AGGREGATE loading flag. Measured on Electron 41:
		// a late iframe (ad/embed/lazy widget) and same-document navigations
		// (pushState/replaceState — every SPA link click, and infinite-scroll pages
		// rewrite the URL while you scroll) all flip did-start-loading on and back
		// off within milliseconds. Chrome's own tab spinner filters those out via
		// ShouldShowLoadingUI(), which Electron doesn't expose, so we reconstruct it:
		// main-frame cross-document navigation only. (fetch/XHR and lazy <img> were
		// measured NOT to trigger it — those were never the problem.)
		wc.on('did-start-navigation', (details) => {
			if (!details.isMainFrame || details.isSameDocument) return
			refresh({ loading: true, crashed: false })
		})
		// Aggregate stop is the accurate "everything settled" signal, but a page
		// with a long-polling iframe may never reach it — the main frame finishing
		// or failing clears the bar first, whichever lands earlier.
		wc.on('did-stop-loading', () => refresh({ loading: false }))
		wc.on('did-finish-load', () => refresh({ loading: false }))
		wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
			if (isMainFrame) refresh({ loading: false })
		})
		wc.on('did-navigate', (_e, url) => refresh({ url }))
		wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
			if (isMainFrame) refresh({ url })
		})
		wc.on('render-process-gone', () => refresh({ crashed: true, loading: false }))

		// HTML5 fullscreen (YouTube etc.): the native view fills the window
		// instead of staying pinned to the panel rect. Only the active tab can
		// trigger this via user gesture.
		wc.on('enter-html-full-screen', () => this.setFullscreen(true))
		wc.on('leave-html-full-screen', () => this.setFullscreen(false))
	}

	private syncNavFlags(record: TabRecord): void {
		const history = record.view.webContents.navigationHistory
		record.info.canGoBack = history.canGoBack()
		record.info.canGoForward = history.canGoForward()
		// `url` is written ONLY by createTab and the did-navigate events on purpose:
		// '' now means "on the start page", and getURL() can already report a
		// *pending* URL at did-start-navigation time — filling it in from there
		// would blank the start page (and reveal the white native view) before the
		// new page has committed a single pixel.
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			this.coalescer.flush()
		}, COALESCE_MS)
		this.flushTimer.unref?.()
	}
}

const FAVICON_MAX_BYTES = 256 * 1024

/**
 * Fetch a favicon on the browser partition and return a data: URL so the app
 * renderer never issues the request itself. Failures resolve to undefined
 * (renderer shows the Globe fallback).
 */
function fetchFaviconDataUrl(url: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false
		const done = (value: string | undefined) => {
			if (!settled) {
				settled = true
				resolve(value)
			}
		}
		try {
			const request = net.request({ url, session: getBrowserPartitionSession() })
			const chunks: Buffer[] = []
			let bytes = 0
			request.on('response', (response) => {
				const rawType = response.headers['content-type']
				const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) || 'image/png'
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.length
					if (bytes > FAVICON_MAX_BYTES) {
						request.abort()
						done(undefined)
						return
					}
					chunks.push(chunk)
				})
				response.on('end', () => {
					if (!chunks.length) return done(undefined)
					done(`data:${contentType};base64,${Buffer.concat(chunks).toString('base64')}`)
				})
				response.on('error', () => done(undefined))
			})
			request.on('error', () => done(undefined))
			request.end()
		} catch {
			done(undefined)
		}
	})
}

// ── host injection ports (consulted per call) ────────────────

let broadcaster: BrowserBroadcaster | null = null
let windowProvider: BrowserWindowProvider = () => null
let serviceInstance: BrowserViewService | null = null

export function configureBrowserBroadcaster(next: BrowserBroadcaster | null): void {
	broadcaster = next
}

export function configureBrowserWindowProvider(next: BrowserWindowProvider): void {
	windowProvider = next
}

/**
 * The service only if it already exists. For callers that must not *wake* the
 * browser subsystem just to ask a question — the menu consults this on every
 * ⌘T/⌘W, and getBrowserViewService() would spin up Widevine on first press.
 */
export function peekBrowserViewService(): BrowserViewService | null {
	return serviceInstance
}

export function getBrowserViewService(): BrowserViewService {
	serviceInstance ??= new BrowserViewService(
		() => windowProvider(),
		() => broadcaster,
	)
	return serviceInstance
}

/**
 * Shutdown reaping — wired into the desktop beforeQuit cleanup table (the real
 * quit path; backend.shutdown() is NOT run by the Electron host). No-op when no
 * browser tab was ever created.
 */
export function killAllBrowserTabs(): void {
	serviceInstance?.killAll()
}
