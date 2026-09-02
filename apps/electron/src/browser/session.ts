/**
 * The embedded browser runs on its own persistent partition — never the app UI's
 * defaultSession. This gives persistent cookies/localStorage (login survives
 * restart), skips the app CSP, and gets its own UA + permission + download policy.
 * See docs/design/browser-v2.md §D3.
 */
import { session, type Session } from 'electron'
import { applyElectronNetworkProxySettings, type ElectronProxyConfig } from '../network/proxy.js'

export const BROWSER_PARTITION = 'persist:browser'

/** One session per profile partition (Chrome-style isolated logins). */
const cachedSessions = new Map<string, Session>()

/** Per-partition readiness: resolves once the creation-time proxy replay landed. */
const partitionReady = new Map<string, Promise<void>>()

/**
 * Last proxy config applied app-wide. A profile partition can be created LONG
 * after the last applyBrowserProxy (e.g. the user adds a profile mid-session);
 * without replaying it that partition would browse direct, bypassing the proxy.
 */
let currentProxyConfig: ElectronProxyConfig | null = null

/**
 * The UA the embedded browser presents — the PROVEN recipe for logging into
 * Google inside an embedded Chromium (replicates Flow Browser, which logs into
 * Google on castlabs Electron). Verified against the real "browser may not be
 * secure" block 2026-07-26. **2026-09-03 换回官方 Electron 后这条配方未重验** ——
 * 它由 UA 与 FedCM 两格构成,与 Widevine / CDM 无关(那一格已随换核变成 no-op),
 * 但「不依赖」是推理不是读数,真要用内嵌登录时按同法再验一次。
 *
 * The ONE thing that matters: strip ONLY the ` Electron/<ver>` token and keep
 * EVERYTHING else — the app product token (`onething/x.y.z`) AND the full
 * Chromium build version (`Chrome/146.0.7680.166`). Counter-intuitively, an
 * OVER-cleaned UA (version frozen to `<major>.0.0.0`, app token removed) reads
 * as FAKE to Google's login environment check and triggers "this browser or app
 * may not be secure". The minimal scrub is exactly what the working Flow build
 * sends. Sec-CH-UA still says "Chromium" — that is fine; Flow sends the same and
 * Google does not gate on the "Google Chrome" brand. See docs/design/browser-v2.md.
 */
export function buildChromeUserAgent(defaultUserAgent: string): string {
	return defaultUserAgent.replace(/\sElectron\/\S+/, '')
}

/**
 * Resolve (and lazily initialize) a browser partition session. Defaults to the
 * legacy `persist:browser`; profiles pass their own partition (see profiles.ts).
 * UA MUST be set before any WebContentsView is created on this session —
 * setUserAgent does not affect already-created WebContents (d.ts:12894). Callers
 * create views only after this returns.
 */
export function getBrowserPartitionSession(partition: string = BROWSER_PARTITION): Session {
	const existing = cachedSessions.get(partition)
	if (existing) return existing

	const ses = session.fromPartition(partition)
	ses.setUserAgent(buildChromeUserAgent(ses.getUserAgent()))

	// Browser pages get a hard-deny permission policy by default; a per-domain
	// prompt for media/clipboard lands in P1b.
	ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
	ses.setPermissionCheckHandler(() => false)

	cachedSessions.set(partition, ses)
	// Inherit the current proxy. The replay is async, and a fresh tab now loads
	// the search-engine homepage immediately — callers issuing that first load
	// MUST gate it on whenBrowserPartitionReady(), or the request races setProxy
	// and goes out DIRECT (fails/leaks the direct IP on proxy-dependent networks).
	const replay = currentProxyConfig
		? applyElectronNetworkProxySettings(currentProxyConfig, { session: ses }).catch(() => undefined)
		: Promise.resolve()
	partitionReady.set(partition, replay.then(() => undefined))
	return ses
}

/** Resolves when a partition's creation-time proxy replay has landed (or immediately). */
export function whenBrowserPartitionReady(partition: string = BROWSER_PARTITION): Promise<void> {
	return partitionReady.get(partition) ?? Promise.resolve()
}

/** Every profile partition session created so far. */
export function getAllBrowserSessions(): Session[] {
	return [...cachedSessions.values()]
}

/** Drop a partition session from the cache (e.g. its profile was removed). */
export function removeBrowserPartitionSession(partition: string): void {
	cachedSessions.delete(partition)
	partitionReady.delete(partition)
}

/** Mirror the app's proxy settings onto every browser partition (defaultSession-only otherwise). */
export async function applyBrowserProxy(proxy: ElectronProxyConfig): Promise<void> {
	currentProxyConfig = proxy
	const sessions = getAllBrowserSessions()
	// Ensure at least the default partition carries the proxy even before use.
	if (sessions.length === 0) sessions.push(getBrowserPartitionSession())
	await Promise.all(sessions.map((ses) => applyElectronNetworkProxySettings(proxy, { session: ses })))
}

/** Test seam. */
export function resetBrowserSessionForTests(): void {
	cachedSessions.clear()
	partitionReady.clear()
	currentProxyConfig = null
}
