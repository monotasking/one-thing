/**
 * permission(运行中的权限询问)域 —— 结构债 P4c 的第四个域。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/permission.ts` 的手写 IPC 工厂与
 *    `apps/electron/src/main/ipc/permission.ts` 把它接到 core `Permission` 上的壳
 *    (那个文件整只删掉 —— 它一条推送都没有:`permission:request` 走会话事件);
 *  - `preload/bridge.ts` 的两条包装与 `platform/web.ts` 的
 *    `GET /api/sessions/:id/permissions/pending` / `POST …/clear` 两条镜像;
 *  - `app/server/http.ts` 里那条正则路由的两个分支,与 `server/runtime.ts` 的
 *    `permissions.getPending` / `permissions.clearSession` 两个 adapter 方法
 *    (`permissions.respond` **不动** —— 它服务的是 `/api/permissions/:id/respond`,
 *    走的是命令总线,不属于本次搬家)。
 *
 * 两处**迁后 web 行为会变**,记在这里:
 *  1. 被删掉的 adapter 在两个方法前各有一道桌面没有的「会话不存在 →
 *     `{ success:false, error:'Session not found' }`」前置检查。搬家取的是桌面的
 *     形状,所以一个不存在的 sessionId 现在拿到的是 `{ success:true, pending: [] }`。
 *  2. 被删掉的 `getPending` 还有一条**回声后端**分支(`backend.persistsMessages`
 *     为假时读 server 自己维护的 `pendingPermissions` 镜像)。真引擎那一侧本来就
 *     走 `Permission.getPendingPrompts`,与桌面同一份;回声后端只出现在 server 的
 *     测试夹具里,搬完之后那条镜像没有读者。
 *
 * 应答不在这个域里:`command:permission-respond` 是命令总线上的一条命令,由 core
 * 校验通道亲和性。授权账页(列/撤/清)是 `permissionGrants` 域。
 */
import type { PermissionInfo } from '@shared/ipc/permissions.js'
import type { RouteHandlers } from '@onething/core/ipc'
import {
  clearOnethingPermissionSessionForIpc,
  getOnethingPendingPermissionsForIpc,
} from '@onething/runtime/permissions'
import type { PermissionRoutes } from '@shared/ipc/permissions.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { Permission } from '../../wiring/permission/index.js'

const log = getLogger('rpc.permission')
/** 旧线传的是裸 `console`;结构化 logger 的鸭子端口替身(area ① 统一后删)。 */
const consoleLog = consolePort(log)

export const permissionRpcHandlers: RouteHandlers<PermissionRoutes> = {
  // 全景(含 promptState 标注的排队 prompt),这样重载的客户端能按 toolCallId
  // 重建每一张等待卡 —— 只给 actionable 的那批,排队中的卡片就会凭空消失。
  async getPending(request) {
    return getOnethingPendingPermissionsForIpc<PermissionInfo>({
      sessionId: request.sessionId,
      getPending: sessionId =>
        Permission.getPendingPrompts(sessionId) as unknown as PermissionInfo[],
      logger: consoleLog,
    })
  },
  async clearSession(request) {
    return clearOnethingPermissionSessionForIpc({
      sessionId: request.sessionId,
      clearSession: Permission.clearSession,
      logger: consoleLog,
    })
  },
}

