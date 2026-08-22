/**
 * 内嵌浏览器(WebContentsView)的渲染侧客户端 —— 结构债 P4 终态批 A1-b(2026-08-23)。
 *
 * 19 个动词走**宿主壳路由**;`platformApi.onBrowserTabsChanged` 不在这里 ——
 * 那是推送(一次合批的标签态广播),router 没有推送面。
 *
 * 浏览器面在 web 上是**注册了的**(`shell-web/browser.ts`),只是老实回「这台宿主
 * 做不到」,文案与迁移前 `platform/web.ts` 那批桩逐字相同 —— 所以调用点仍旧是
 * 「拿到一个 `{ success:false }` 就算了」,而不是要 catch 一个异常。
 */
import { browserRouter } from '@shared/ipc/browser.js'
import { createShellClient } from './shell-client'

export const browserApi = createShellClient(browserRouter)
