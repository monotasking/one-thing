/**
 * 外壳能力(打开路径 / 打开外链 / 数据目录)的**宿主处理者**(结构债 P4 终态批
 * A1-b,2026-08-23)。
 *
 * 接的是 `apps/electron/src/ipc/shell-controller.ts` 那三条**字面量通道**
 * (`shell:open-path` / `shell:open-external` / `app:get-data-path`)—— 它们从来不在
 * `IPC_CHANNELS` 表上,transport 门数不到,A1-a 的报告点了名。第四条
 * `window:set-button-visibility` 不在这里:它动的是**发起窗本身**,归 `window` 域。
 *
 * 三条的实现一格没动(`openElectronPath` / `openElectronExternal` /
 * `getOnethingStorePath`),由 `@main/ipc/shell.ts` 注入;`openPath` 仍旧原样回
 * Electron 的那个错误串。本文件因此一行 electron 都不 import。
 */
import type {
  ShellOpenExternalRequest,
  ShellOpenExternalResponse,
  ShellOpenPathRequest,
  ShellRoutes,
} from '@shared/ipc/shell.js'
import { shellRouter } from '@shared/ipc/shell.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

export interface ShellOperations {
  /** Electron `shell.openPath` 的原样回值:空串 = 成功。 */
  openPath(filePath: string): Promise<string>
  openExternal(url: string): Promise<ShellOpenExternalResponse>
  /** 这台宿主的 store 根。 */
  getDataPath(): string
}

export function createShellHandlers(
  operations: ShellOperations,
): ShellRouteHandlers<ShellRoutes> {
  return {
    openPath: async (request: ShellOpenPathRequest) => operations.openPath(request?.filePath ?? ''),
    openExternal: async (request: ShellOpenExternalRequest) =>
      operations.openExternal(request?.url ?? ''),
    getDataPath: async () => operations.getDataPath(),
  }
}

export function registerShellShellDomain(operations: ShellOperations): () => void {
  return registerShellDomain(shellRouter, createShellHandlers(operations))
}
