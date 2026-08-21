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
 */
import type { RouteHandlers } from '@onething/core/ipc'
import { saveOnethingUiStateForIpc, type OnethingUiStatePatch } from '@onething/runtime/storage'
import { appStateRouter, type AppStateRoutes } from '@shared/ipc/app-state.js'
import { getAppState } from '../../stores/app-state.js'
import {
  getOnethingAppStatePath,
} from '@onething/runtime/storage'
import { registerRouterHandlers } from '../registry.js'

export const appStateRpcHandlers: RouteHandlers<AppStateRoutes> = {
  async get() {
    return getAppState()
  },
  // 补丁语义:只有出现的键才落盘(合并在 `mergeOnethingUiState` 里,不在这层)。
  // `workspace` / `sessionReadMarks` 在契约上是不透明载荷(形状归渲染层),
  // 主进程这一侧在这里收窄一次 —— 存储层只按键名整块写,不解释内容。
  async saveUiState(request) {
    return saveOnethingUiStateForIpc(getOnethingAppStatePath(), request as OnethingUiStatePatch)
  },
}

export function registerAppStateRpcDomain(): () => void {
  return registerRouterHandlers(appStateRouter, appStateRpcHandlers)
}
