/**
 * 内嵌浏览器的 **web 处理者**(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 浏览器器面在浏览器里没有等价物:`WebContentsView` 是 Electron 才有的东西,
 * apps/web 上工作区的 `browser` 页签退回 `<iframe>`,能力位 `embeddedBrowser`
 * 因此是 `false`(本批一格未动)。所以这 19 条**注册了但老实回答做不到** ——
 * 句子与里面的方法名都**逐字**沿用迁移前 `platform/web.ts` 那份
 * `WEB_DESKTOP_ONLY_PLATFORM_METHODS` 名单生成的那句。
 *
 * 为什么不干脆不注册:未注册的域会让 `createRouterClient` 抛,而这些调用点从来
 * 是「拿到一个 `{ success:false }` 就算了」(多数还没 await),换成抛 = 一串
 * unhandled rejection。判例与 A1-a 的 `shell-web/unsupported.ts` 同。
 */
import type { BrowserRoutes } from '@shared/ipc/browser.js'
import { browserRouter } from '@shared/ipc/browser.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'
import { webShellUnsupported } from './unsupported'

/**
 * 迁移前 web 上这些方法回的**就是**这个两字段对象 —— 连 `tabs` / `profiles` /
 * `engineId` 这些「成功才有」的字段都没有。契约上的成功形状补不出它们,所以这里
 * 就地断言:被断言掉的正是那份「失败时不存在」的事实,而不是一个谎。
 */
function unsupported<T>(legacyMethodName: string): T {
  return webShellUnsupported(legacyMethodName) as unknown as T
}

export function createBrowserWebShellHandlers(): WebShellRouteHandlers<BrowserRoutes> {
  return {
    hydrate: async () => unsupported('hydrateBrowser'),
    createTab: async () => unsupported('createBrowserTab'),
    closeTab: async () => unsupported('closeBrowserTab'),
    selectTab: async () => unsupported('selectBrowserTab'),
    navigate: async () => unsupported('navigateBrowser'),
    goBack: async () => unsupported('browserGoBack'),
    goForward: async () => unsupported('browserGoForward'),
    reload: async () => unsupported('reloadBrowser'),
    stop: async () => unsupported('stopBrowser'),
    setBounds: async () => unsupported('setBrowserBounds'),
    setVisible: async () => unsupported('setBrowserVisible'),
    pickElement: async () => unsupported('pickBrowserElement'),
    pickCancel: async () => unsupported('cancelBrowserPick'),
    getSearchEngine: async () => unsupported('getBrowserSearchEngine'),
    setSearchEngine: async () => unsupported('setBrowserSearchEngine'),
    listProfiles: async () => unsupported('listBrowserProfiles'),
    addProfile: async () => unsupported('addBrowserProfile'),
    removeProfile: async () => unsupported('removeBrowserProfile'),
    switchProfile: async () => unsupported('switchBrowserProfile'),
  }
}

export function registerBrowserWebShellDomain(): () => void {
  return registerWebShellDomain(browserRouter, createBrowserWebShellHandlers())
}
