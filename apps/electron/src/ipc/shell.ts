/**
 * 外壳能力的宿主接线(结构债 P4 终态批 A1-b,2026-08-23)。
 *
 * 四条**字面量通道**(`shell:open-path` / `shell:open-external` /
 * `app:get-data-path` / `window:set-button-visibility`)在本批全部消失:
 * 前三条进新立的 `shellRouter`(处理者表在 `ipc/shell/shell.ts`),第四条动的是
 * **发起窗本身**,所以进 A1-a 就有的 `windowRouter`(`ipc/shell/window.ts` +
 * `ipc/window.ts` 的注册点)。`shell-controller.ts` 那只裸 `ipcMain.handle` 工厂
 * 随之整只删掉。
 *
 * 三件真实现一格没动:`openElectronPath` / `openElectronExternal` 仍在
 * `shell/operations.ts`,数据目录仍是 `getOnethingStorePath()`。
 */
import { getOnethingStorePath } from '@onething/runtime/storage'
import { openElectronExternal, openElectronPath } from '../shell/operations.js'
import { registerShellShellDomain } from './shell/shell.js'

export function registerShellHandlers(): void {
  registerShellShellDomain({
    openPath: (filePath: string) => openElectronPath(filePath),
    openExternal: (url: string) => openElectronExternal(url),
    getDataPath: () => getOnethingStorePath(),
  })
}
