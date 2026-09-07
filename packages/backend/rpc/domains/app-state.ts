/**
 * app-state(应用状态)域 —— 结构债 P4c 的第三个域。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/app-state.ts` + `app-state-controller.ts` 的手写 IPC
 *    工厂与 `apps/electron/src/main/ipc/app-state.ts` 的三行 re-export;
 *  - `preload/bridge.ts` 的两条包装与 `platform/web.ts` 的
 *    `GET /api/app-state` / `POST /api/app-state/ui` 两条镜像;
 *  - `app/server/http.ts` 的两条 REST 路由与 `server/runtime.ts` 里
 *    **只被这两条路由用到**的 `appState` facade adapter。
 *
 * **迁后 web 行为会变,而且这次变得不小**,记在这里:被删掉的 server adapter 的
 * `get` **不是** `app-state.json` 的镜像 —— 它现场拼一份最小状态(当前会话 id 取自
 * 请求上下文、`openTabs` 恒为「一个 chat 页」、`sidebarCollapsed` 恒为 false),
 * 工作区树与已读标记一律缺席。搬到桌面那条实现之后,web 读的是**同一个 store 的
 * 那份真 `app-state.json`**:浏览器打开会 hydrate 出桌面的工作区页签树与侧栏状态。
 * 这与 A 期「一个 store 一台 core」的方向一致(spaces 的拍板 #11 同型),但它是
 * 一次**可感知**的变化,不是零行为变化。
 *
 * `saveUiState` 那侧本来就是同一份文件:旧 adapter 在非默认 owner 上直接
 * `{ success: true }` 空转、默认 owner 落到同一个 store。搬完只剩后者。
 *
 * ---
 * 2026-09-07 之后,这个域多了两件事,上面的判例一条没作废:
 *
 *  1. **状态按租户分文件**:默认 owner 仍然是那份 `app-state.json`,别的 owner 落在
 *     `ui-state/<uid>/<wid>/app-state.json`。渲染层交上来的 `workspace` /
 *     `sessionReadMarks` 仍然是不透明载荷,这一层只按键名整块写,不解释内容。
 *  2. **`currentSessionId` 指向读不到的会话时,交出去的是空串**(`visibleState`)。
 *     这是一次**可感知**的行为变化,被裁定为「算修 bug」而保留(裁定正本 §3):
 *     `app-state.json` 里那一格是**全局**的,谁开会话谁盖章,而它一旦指向一条已经
 *     被删掉、或者根本不归这个调用者的会话,渲染层 hydrate 出来就是一个指向空处
 *     的当前会话 —— 表现是开壳定位到一条不存在的对话。注意它**只影响交出去的那
 *     一份**:盘上那一格不动,别的 owner 读自己那份时照旧。
 */
/**
 * Persisted UI layout belongs to the configured operator and tenant.
 * The opaque renderer-owned workspace format is stored intact in that scope;
 * it never grants permission to read a referenced session.
 */
import path from 'node:path'
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { AppState, AppStateRoutes } from '@shared/ipc/app-state.js'
import {
  getOnethingAppStatePath,
  getOnethingStorePath,
  readOnethingAppState,
  saveOnethingUiStateForIpc,
  type OnethingUiStatePatch,
} from '@onething/runtime/storage'
import { DEFAULT_SESSION_OWNER, requestSessionOwner, sessionAccess } from '../../session/access.js'
import { tenantDirectory } from '../../server/tenant-paths.js'

function statePath(context: RpcDispatchContext): string {
  const owner = requestSessionOwner(context)
  if (owner.userId === DEFAULT_SESSION_OWNER.userId && owner.workspaceId === DEFAULT_SESSION_OWNER.workspaceId) {
    return getOnethingAppStatePath()
  }
  return path.join(tenantDirectory(path.join(getOnethingStorePath(), 'ui-state'),
    owner.userId!, owner.workspaceId!), 'app-state.json')
}

function visibleState(state: AppState, context: RpcDispatchContext): AppState {
  // Legacy host focus is global and may be updated by a different operator's
  // session creation. Do not expose that session id through UI hydration.
  const currentSessionId = state.currentSessionId
    ? sessionAccess.filterIds(context, [state.currentSessionId])[0] ?? ''
    : ''
  return { ...state, currentSessionId }
}

export const appStateRpcHandlers: RpcRouteHandlers<AppStateRoutes> = {
  async get(_request, context = DESKTOP_RPC_CONTEXT) {
    return visibleState(readOnethingAppState(statePath(context)), context)
  },
  async saveUiState(request, context = DESKTOP_RPC_CONTEXT) {
    // Preserve the renderer's opaque layout and patch semantics in its own file.
    const result = saveOnethingUiStateForIpc(statePath(context), request as OnethingUiStatePatch)
    return result.success ? { ...result, state: visibleState(result.state, context) } : result
  },
}
