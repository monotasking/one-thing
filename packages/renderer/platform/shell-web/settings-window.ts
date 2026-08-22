/**
 * 「开设置窗」的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 浏览器里没有第二扇窗,所以这不是降级而是**同一件事的另一种做法**:换页内 hash
 * 路由。逐字沿用迁移前 `platform/web.ts` 里那三行。
 */
import type {
  OpenSettingsWindowRequest,
  SettingsWindowRoutes,
} from '@shared/ipc/settings.js'
import { settingsWindowRouter } from '@shared/ipc/settings.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export function createSettingsWindowWebShellHandlers(): WebShellRouteHandlers<SettingsWindowRoutes> {
  return {
    open: async (request: OpenSettingsWindowRequest) => {
      window.location.hash = request?.tab
        ? `#/settings?tab=${encodeURIComponent(request.tab)}`
        : '#/settings'
      return { success: true }
    },
  }
}

export function registerSettingsWindowWebShellDomain(): () => void {
  return registerWebShellDomain(settingsWindowRouter, createSettingsWindowWebShellHandlers())
}
