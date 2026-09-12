import { useCallback, useSyncExternalStore } from 'react'

/**
 * **内嵌浏览器檐下那两件临时的东西**(B3-a · 壳半边):一个网页在要一格能力,
 * 以及一次下载落在了哪儿。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ① 生命周期
 * ══════════════════════════════════════════════════════════════════════════
 * | 事件 | 这里发生什么 |
 * | --- | --- |
 * | import | 一张空表。零往返、零订阅(事实由 `browser-source.ts` 那条唯一订阅喂进来) |
 * | 一问到了 | 进那一格 tab 的队尾。**屏幕上只画队头**(同一 tab 多问排队) |
 * | 那一问结了 | 出队。三条收场共用这一条事实(答了 / 超时 / tab 没了) |
 * | 一次下载 | 按落点去重、最近一次在最前;上限 `MAX_DOWNLOAD_ROWS` |
 * | 换宿主 / 叶重挂 | **一格都不动**(状态按 tabId 存在模块里) |
 * | tab 关掉 | `forgetBrowserNotices` —— 由 `closed` 那条事实调 |
 * | HMR | `resetBrowserNotices` |
 *
 * ## 为什么它不是「通知」
 *
 * 两件都**长在那片叶的檐下**,不进任何全局通知面。一次权限询问问的是「**这一页**
 * 能不能拿你的位置」,而屏幕上说得出「这一页」的地方只有那片叶 —— 挂到全局去,
 * 「哪一页在问」就变成读者自己去配对的活儿(与权限卡长在工具卡里、不长在消息尾
 * 是同一条判词)。下载同理:它是这一格 tab 干的事。
 *
 * ## 下载为什么只画一行
 *
 * 一行 = 一次下载。表里留着最近几条,而**画的永远是最近变动的那一条** ——
 * 一发 `done` 会把它自己顶到最前。同时下三个文件的人看到的是最后动的那一个,
 * 其余仍然在表里(它们各自 `done` 的时候会轮到自己上屏)。
 * **不画进度条、不画 spinner、不弹 Toast**:后端那一侧根本不发百分比
 * (判词在 `electron/browser/download.ts` 上),画一条自己走到 80% 再等的进度是编。
 */

/** 一个网页在要一格能力。形逐格对着自述里 `permissionRequested` 的载荷。 */
export interface WebPermissionAsk {
  tabId: string
  requestId: string
  permission: string
  /** 谁在问。空串 = 这一页没有说得出的来源(卡上据此分档,不编一个出来)。 */
  origin: string
}

export interface BrowserDownloadNotice {
  tabId: string
  filename: string
  state: 'started' | 'done' | 'failed'
  path: string
}

export interface BrowserNotices {
  /** 队列。屏幕上只画 `[0]`。 */
  asks: readonly WebPermissionAsk[]
  /** 最近变动的在最前。屏幕上只画 `[0]`。 */
  downloads: readonly BrowserDownloadNotice[]
}

const EMPTY: BrowserNotices = { asks: [], downloads: [] }

/** 一格 tab 最多记几条下载。判词在文件头。 */
export const MAX_DOWNLOAD_ROWS = 5

const byTab = new Map<string, BrowserNotices>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function browserNoticesOf(tabId: string): BrowserNotices {
  return byTab.get(tabId) ?? EMPTY
}

function put(tabId: string, next: BrowserNotices): void {
  byTab.set(tabId, next)
  emit()
}

/** 一问到了。**同一个 requestId 不进两次**(SSE 是广播,重放是常态)。 */
export function browserPermissionRequested(ask: WebPermissionAsk): void {
  const now = browserNoticesOf(ask.tabId)
  if (now.asks.some((row) => row.requestId === ask.requestId)) return
  put(ask.tabId, { ...now, asks: [...now.asks, ask] })
}

/** 那一问结了(答了 / 超时 / tab 没了)。出队;不在队里就什么都不做。 */
export function browserPermissionResolved(event: { tabId: string; requestId: string }): void {
  const now = browserNoticesOf(event.tabId)
  const asks = now.asks.filter((row) => row.requestId !== event.requestId)
  if (asks.length === now.asks.length) return
  put(event.tabId, { ...now, asks })
}

/** 一次下载的一态。按落点去重,最近变动的顶到最前。 */
export function browserDownloadFact(notice: BrowserDownloadNotice): void {
  const now = browserNoticesOf(notice.tabId)
  const rest = now.downloads.filter((row) => row.path !== notice.path)
  put(notice.tabId, { ...now, downloads: [notice, ...rest].slice(0, MAX_DOWNLOAD_ROWS) })
}

/**
 * 把一行下载读数收掉(那颗 ×)。
 *
 * **只收读数,不动那个文件** —— 屏幕上那一行是一句话,不是那份下载本身。
 */
export function dismissBrowserDownload(tabId: string, path: string): void {
  const now = browserNoticesOf(tabId)
  const downloads = now.downloads.filter((row) => row.path !== path)
  if (downloads.length === now.downloads.length) return
  put(tabId, { ...now, downloads })
}

/** 这一格 tab 没了。由 `browser-source.ts` 的事实表在 `closed` 上调。 */
export function forgetBrowserNotices(tabId: string): void {
  if (!byTab.delete(tabId)) return
  emit()
}

export function useBrowserNotices(tabId: string): BrowserNotices {
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, []),
    useCallback(() => browserNoticesOf(tabId), [tabId]),
  )
}

/** 回到出厂。测试与 HMR 用;幂等。 */
export function resetBrowserNotices(): void {
  byTab.clear()
  listeners.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetBrowserNotices)
}
