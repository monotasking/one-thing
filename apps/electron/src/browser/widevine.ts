/**
 * Widevine CDM 就绪。DRM 内容(EME / `requestMediaKeySystemAccess`)要先在 app ready
 * 之后、浏览器加载前调一次 `components.whenReady()`。它也曾是内嵌 Google 登录配方的
 * 一环 —— 参照的 Flow build 会 ready Widevine,真 Chrome 也一直有。见
 * docs/design/browser-v2.md 与 memory project_embedded_google_login_2026_07。
 *
 * **今天这个函数在生产上恒为 no-op**(2026-09-03):`components` 是 castlabs
 * `electron-releases` fork 的具名导出,本仓已换回官方 `electron@41.1.1`,官方构建
 * 既不带 CDM 也不导出这个名字(`electron.d.ts` 里搜不到它)。所以这里**不能**写
 * `import { components } from 'electron'` —— 那是一条按 castlabs 的类型写的 import,
 * 在官方类型下直接编译不过。改成从 electron 命名空间上按名字取:取不到就 resolve,
 * 哪天真换回带 CDM 的底座,同一段代码不改一个字就会重新生效。
 *
 * 换核的代价用户已知情:内嵌浏览器不再能播 DRM 内容;登录配方本身(FedCM off + UA
 * 只删 Electron token)不依赖 Widevine。
 *
 * Memoized —— 每次浏览器唤醒都调是安全的。
 */
import * as electron from 'electron'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('browser')

/** castlabs fork 上的 `components` 形状里,这个函数是我们唯一用到的那一格。 */
type WidevineComponents = { whenReady(): Promise<unknown> }

let readyPromise: Promise<void> | null = null

export function ensureWidevineReady(): Promise<void> {
	if (readyPromise) return readyPromise
	const comp = (electron as unknown as { components?: WidevineComponents }).components
	readyPromise = typeof comp?.whenReady === 'function'
		? comp
				.whenReady()
				.then(() => undefined)
				.catch((err) => {
					log.error('widevine components not ready', { fatal: false }, err)
				})
		: Promise.resolve()
	return readyPromise
}
