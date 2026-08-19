/**
 * castlabs Electron ships the Widevine CDM, but it must be explicitly readied
 * before EME (`requestMediaKeySystemAccess`) works: call `components.whenReady()`
 * once, after the app is ready, before the browser loads DRM content. It is also
 * part of the embedded-Google-login recipe — the working Flow build readies
 * Widevine, and a real Chrome always has it. See docs/design/browser-v2.md and
 * memory project_embedded_google_login_2026_07.
 *
 * `components` is a named export on the castlabs fork (typed in its @types).
 * Guarded runtime-undefined so a non-castlabs Electron degrades to a no-op.
 * Memoized — safe to call on every browser wake-up.
 */
import { components } from 'electron'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('browser')

let readyPromise: Promise<void> | null = null

export function ensureWidevineReady(): Promise<void> {
	if (readyPromise) return readyPromise
	const comp = components as typeof components | undefined
	readyPromise = comp
		? comp
				.whenReady()
				.then(() => undefined)
				.catch((err) => {
					log.error('widevine components not ready', { fatal: false }, err)
				})
		: Promise.resolve()
	return readyPromise
}
