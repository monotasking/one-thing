/**
 * variables(标量变量)域 —— 结构债 P4c 的第二个域。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/variables.ts` + `variables-controller.ts` 那个手写
 *    IPC 工厂(三条 handle 的通道表)与 `apps/electron/src/main/ipc/variables.ts`
 *    的三行 re-export;
 *  - `preload/bridge.ts` 的三条位置参数包装与 `platform/web.ts` 的三条
 *    `/api/variables/*` 镜像;
 *  - `app/server/http.ts` 的三条 REST 路由与 `server/runtime.ts` 里
 *    **只被这三条路由用到**的 `variables` facade adapter。
 *
 * 这一层只做一件事:**把注册表接到 `@onething/runtime/variables` 的依赖注入投影上**。
 * 错误码(`VariableError.code` → `{ success:false, error, code }`)与 `SetInput`
 * 的拆包都在那批投影里,传输面不复述。
 *
 * 一处**迁后 web 行为会变**,记在这里:被删掉的 server adapter 在三个方法前面
 * 各有一道自己的「会话不存在 → `{ success:false, code:'NOT_FOUND' }`」前置检查,
 * 而桌面那条线从来没有这道检查(注册表自己按 sessionId 取上下文)。搬家取的是
 * **桌面的形状**(本批的宪法是「一个域一条实现」),所以 web 端对一个不存在的
 * sessionId 拿到的不再是 NOT_FOUND,而是注册表按空上下文算出来的那份快照 ——
 * 与桌面逐字一致。同理,web 从此读的是引擎真正在用的那台注册表
 * (`bootstrapVariableSystem()` 装的 app 单例),不再是 server 自己那台
 * per-owner registry。
 */
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionAccess } from '../../session/access.js'
import {
  deleteOnethingVariableForIpc,
  listOnethingVariablesForIpc,
  setOnethingVariableForIpc,
} from '@onething/runtime/variables'
import { getVariableRegistry } from '@onething/runtime/variables/registry'
import type { VariablesRoutes } from '@shared/ipc/variables.js'

export const variablesRpcHandlers: RpcRouteHandlers<VariablesRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'read')
    return listOnethingVariablesForIpc({
      request,
      listVariables: context => getVariableRegistry().list(context),
    })
  },
  async set(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'write')
    return setOnethingVariableForIpc({
      request,
      setVariable: (context, input) => getVariableRegistry().set(context, input),
    })
  },
  async delete(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'write')
    return deleteOnethingVariableForIpc({
      request,
      deleteVariable: (context, name, scope) =>
        getVariableRegistry().delete(context, name, scope),
    })
  },
}
