/**
 * 「关掉发起窗」的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 一个浏览器标签页里没有属于我们的窗可关。逐字沿用迁移前 `platform/web.ts` 那行。
 */
import type { WindowRoutes } from '@shared/ipc/window.js'
import { windowRouter } from '@shared/ipc/window.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export function createWindowWebShellHandlers(): WebShellRouteHandlers<WindowRoutes> {
  return {
    close: async () => ({ success: false }),
  }
}

export function registerWindowWebShellDomain(): () => void {
  return registerWebShellDomain(windowRouter, createWindowWebShellHandlers())
}
