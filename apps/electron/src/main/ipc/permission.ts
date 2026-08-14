/**
 * Permission IPC Handlers
 *
 * Handles IPC communication for permission-related operations.
 *
 * Note: Permission responses now flow through the unified command channel
 * (SESSION_COMMAND → EventBus → Permission subscription) with channel
 * affinity validation.
 *
 * 主线 T 批 3：授权账页（列/撤/清）已整只迁到通用 RPC 通道的 `permissionGrants`
 * 域 —— 那四条是 owner-scoped 的读写面，护栏跟着 `RpcDispatchContext` 搬进了
 * `@onething/app`。留在这里的两条是**运行中**的权限询问：`getPending` 读的是
 * 引擎内存里的活 prompt，`clearSession` 清的是同一份活状态，两者都没有跨宿主
 * 的第二实现可收。
 */

import {
  registerElectronPermissionIpcHandlers,
  type ElectronPermissionSessionId,
} from '@onething/electron-host/ipc/permission'
import {
  clearOnethingPermissionSessionForIpc,
  getOnethingPendingPermissionsForIpc,
} from '@onething/runtime/permissions'
import { Permission } from '@onething/app/permission/index.js'
import { IPC_CHANNELS } from '@shared/ipc.js'

/**
 * Register all permission-related IPC handlers
 */
export function registerPermissionHandlers(): void {
  // Permission responses go through SESSION_COMMAND → EventBus →
  // Permission.initialize() subscription, which validates channel affinity.

  registerElectronPermissionIpcHandlers({
    channels: {
      getPending: IPC_CHANNELS.PERMISSION_GET_PENDING,
      clearSession: IPC_CHANNELS.PERMISSION_CLEAR_SESSION,
    },
    getPending: (sessionId: ElectronPermissionSessionId) => {
      return getOnethingPendingPermissionsForIpc({
        sessionId,
        // Full picture including queued prompts/followers (promptState-labeled)
        // so the renderer can rebuild per-tool-call waiting states on reload.
        getPending: Permission.getPendingPrompts,
        logger: console,
      })
    },
    clearSession: (sessionId: ElectronPermissionSessionId) => {
      return clearOnethingPermissionSessionForIpc({
        sessionId,
        clearSession: Permission.clearSession,
        logger: console,
      })
    },
  })

  console.log('[Permission IPC] Handlers registered')
}
