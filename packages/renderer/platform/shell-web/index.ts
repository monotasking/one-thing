/**
 * web 壳的全部窗口域 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * `platform/web.ts` 调这一处一次,把十个域一次性绑进 `shell-web/registry` 的
 * 派发表;`platformApi.shellInvoke` 打的就是那张表。加一个窗口域 = 这里一行,
 * `web.ts` 的管道一行不动 —— 与桌面侧「不再往 `@main/ipc/handlers.ts` 加一行」
 * 对称。
 */
import { registerBrowserWebShellDomain } from './browser'
import { registerDeeplinkWebShellDomain } from './deeplink'
import { registerDialogWebShellDomain } from './dialog'
import {
  registerMediaWindowWebShellDomain,
  type MediaWindowWebShellDeps,
} from './media-window'
import { registerNotifyWebShellDomain } from './notify'
import {
  registerSearchWindowWebShellDomain,
  type SearchWindowWebShellDeps,
} from './search-window'
import { registerSettingsWindowWebShellDomain } from './settings-window'
import { registerShellWebShellDomain } from './shell'
import { registerTodoPlanWindowWebShellDomain } from './todo-plan-window'
import { registerWindowWebShellDomain } from './window'

export interface WebShellDeps extends SearchWindowWebShellDeps, MediaWindowWebShellDeps {}

export function registerWebShellDomains(deps: WebShellDeps): () => void {
  const disposers = [
    registerTodoPlanWindowWebShellDomain(),
    registerSearchWindowWebShellDomain(deps),
    registerSettingsWindowWebShellDomain(),
    registerWindowWebShellDomain(),
    registerDialogWebShellDomain(),
    registerMediaWindowWebShellDomain(deps),
    registerNotifyWebShellDomain(),
    registerDeeplinkWebShellDomain(),
    // A1-b:浏览器 19 条与外壳三条。前者在 web 上一律老实回做不到(`embeddedBrowser`
    // 能力位仍是 false),后者只有 `openExternal` 有真实现(`window.open`)。
    registerBrowserWebShellDomain(),
    registerShellWebShellDomain(),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export {
  dispatchWebShell,
  hasWebShellDomain,
  registerWebShellDomain,
  resetWebShellRegistryForTests,
  WEB_SHELL_MISSING_CODE,
} from './registry'
export {
  TODO_PLAN_WEB_WINDOW_EVENT,
  dispatchTodoPlanWindowAction,
} from './todo-plan-window'
