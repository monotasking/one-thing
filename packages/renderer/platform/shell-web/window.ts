/**
 * 发起窗自己那两件事的 **web 处理者**(结构债 P4 终态批 A1-a / A1-b,2026-08-23)。
 *
 * 一个浏览器标签页里既没有属于我们的窗可关,也没有红绿灯可显隐。两条都逐字沿用
 * 迁移前 `platform/web.ts` 里的答复。
 */
import type { WindowRoutes } from '@shared/ipc/window.js'
import { windowRouter } from '@shared/ipc/window.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'
import { webShellUnsupported } from './unsupported'

export function createWindowWebShellHandlers(): WebShellRouteHandlers<WindowRoutes> {
  return {
    close: async () => ({ success: false }),
    // 红绿灯是 macOS 原生窗的三枚按钮(A1-b 迁入)。逐字沿用迁移前那份不支持
    // 名单生成的那句 —— 唯一的调用点(`App.vue`)本来就 `.catch(() => {})`。
    setButtonVisibility: async () => webShellUnsupported('setWindowButtonVisibility'),
  }
}

export function registerWindowWebShellDomain(): () => void {
  return registerWebShellDomain(windowRouter, createWindowWebShellHandlers())
}
