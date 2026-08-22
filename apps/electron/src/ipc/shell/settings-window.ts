/**
 * 「开设置窗」的**宿主处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 设置窗是一个 `BrowserWindow`,处理者只能住在宿主 —— 所以它走 `shell:invoke`,
 * 而同域的四条数据面(读 / 存 / 系统深浅色 / 代理自检)早在 P4c 第十一批就走了
 * `rpc:invoke` 的 `settingsRouter`。一个域两条通道,分界线就是「要不要 Electron 本体」。
 */
import type {
  OpenSettingsWindowRequest,
  OpenSettingsWindowResponse,
  SettingsWindowRoutes,
} from '@shared/ipc/settings.js'
import { settingsWindowRouter } from '@shared/ipc/settings.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

export interface SettingsWindowShellOperations {
  open(request: OpenSettingsWindowRequest): OpenSettingsWindowResponse
}

export function createSettingsWindowShellHandlers(
  operations: SettingsWindowShellOperations,
): ShellRouteHandlers<SettingsWindowRoutes> {
  return {
    open: async request => operations.open(request ?? {}),
  }
}

export function registerSettingsWindowShellDomain(
  operations: SettingsWindowShellOperations,
): () => void {
  return registerShellDomain(settingsWindowRouter, createSettingsWindowShellHandlers(operations))
}
