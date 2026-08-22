/**
 * 原生「打开」对话框的**宿主处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 从前是 `dialog:show-open` 那条手写通道(渲染侧调用点全仓最多的一条宿主能力);
 * 现在是 `dialogRouter.showOpen`。入参与出参形状一字未动。
 */
import type {
  DialogRoutes,
  ShowOpenDialogRequest,
  ShowOpenDialogResponse,
} from '@shared/ipc/dialog.js'
import { dialogRouter } from '@shared/ipc/dialog.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

export interface DialogShellOperations {
  showOpen(request: ShowOpenDialogRequest): Promise<ShowOpenDialogResponse>
}

export function createDialogShellHandlers(
  operations: DialogShellOperations,
): ShellRouteHandlers<DialogRoutes> {
  return {
    showOpen: async request => operations.showOpen(request ?? {}),
  }
}

export function registerDialogShellDomain(operations: DialogShellOperations): () => void {
  return registerShellDomain(dialogRouter, createDialogShellHandlers(operations))
}
