/**
 * 原生「打开」对话框的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 浏览器没有这样一次宿主对话框。回一次"用户取消了"是迁移前那只桩的逐字形状 ——
 * 二十来个调用点全都写着「canceled 就什么也不做」,所以这是最不惊动人的实话。
 */
import type { DialogRoutes } from '@shared/ipc/dialog.js'
import { dialogRouter } from '@shared/ipc/dialog.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export function createDialogWebShellHandlers(): WebShellRouteHandlers<DialogRoutes> {
  return {
    showOpen: async () => ({ canceled: true, filePaths: [] }),
  }
}

export function registerDialogWebShellDomain(): () => void {
  return registerWebShellDomain(dialogRouter, createDialogWebShellHandlers())
}
