/**
 * Todo / plan 的**窗口面接线**。
 *
 * 数据面（读快照 / 增删改重命名 / 在文件管理器里显示目录）走通用 RPC 通道
 * （`todoPlanRouter` → `@onething/backend/rpc/domains/todo-plan.ts`）。这里只剩两样
 * 东西，都是宿主原生、迁不走的：
 *
 *  1. 七条窗口动作 —— 直接操作 BrowserWindow。它们于 2026-08-23（结构债 P4 终态批
 *     A1-a）从七条手写通道改为**宿主壳路由**上的一份处理者表
 *     （`todoPlanWindowRouter` → `@onething/electron-host/ipc/shell/todo-plan-window`），
 *     语义逐字不变；
 *  2. `configureTodoPlanHost` 的端口注入 —— 变更广播（webContents.send）与
 *     Finder 里显示目录。注入必须留在这里，**RPC 域那边靠的正是这两个端口**：
 *     未注入端口的宿主（server / CLI）自然降级，而不是各写一份。
 */
import { registerTodoPlanWindowShellDomain } from '@onething/electron-host/ipc/shell/todo-plan-window'
import {
  IPC_CHANNELS,
  type TodoPlanWindowActionRequest,
  type TodoPlanWindowDragRequest,
  type TodoPlanWindowPinnedRequest,
} from '@shared/ipc.js'
import {
  dragTodoPlanWindow,
  hideTodoPlanWindow,
  minimizeTodoPlanWindow,
  openTodoPlanWindow,
  setTodoPlanWindowPinned,
  toggleTodoPlanWindow,
  zoomTodoPlanWindow,
} from '@onething/electron-host/window'
import {
  broadcastElectronTodoPlanChanged,
  revealElectronTodoPlanDirectory,
} from '@onething/electron-host/todo-plan/notifications'
import {
  runOnethingTodoPlanWindowActionForIpc,
  setOnethingTodoPlanWindowPinnedForIpc,
} from '@onething/runtime/todo-plan'
import { configureTodoPlanHost, type TodoPlanHostPorts } from '@onething/backend/wiring/todo-plan/store.js'

/**
 * A1:这两件宿主能力也进桌面那张 `OnethingHostPorts` 表(`main-process.ts`),
 * 于是装配的第一步就接上,而不是等 `initializeIPC()`(afterTools 钩子)才接。
 * 定义留在这里 —— 广播往哪儿发是 todo 域自己的事;导出的只是那张表要引用的值。
 * `registerTodoPlanHandlers` 里那次调用保留:同一个对象再赋一次是空操作,而这个
 * 域的接线在自己的注册函数里读得完整。
 */
export const electronTodoPlanHostPorts: TodoPlanHostPorts = {
  broadcastChanged: payload => broadcastElectronTodoPlanChanged({
    channel: IPC_CHANNELS.TODO_PLAN_CHANGED,
    payload,
  }),
  revealDirectory: revealElectronTodoPlanDirectory,
}

export function registerTodoPlanHandlers(): void {
  configureTodoPlanHost(electronTodoPlanHostPorts)
  registerTodoPlanWindowShellDomain({
    open: (request: TodoPlanWindowActionRequest) =>
      runOnethingTodoPlanWindowActionForIpc({
        request,
        action: openTodoPlanWindow,
      }),
    hide: (request: TodoPlanWindowActionRequest) =>
      runOnethingTodoPlanWindowActionForIpc({
        request,
        action: hideTodoPlanWindow,
      }),
    toggle: (request: TodoPlanWindowActionRequest) =>
      runOnethingTodoPlanWindowActionForIpc({
        request,
        action: toggleTodoPlanWindow,
      }),
    setPinned: (request: TodoPlanWindowPinnedRequest) =>
      setOnethingTodoPlanWindowPinnedForIpc({
        pinned: request.pinned,
        setPinned: setTodoPlanWindowPinned,
      }),
    // 自绘红绿灯的黄 / 绿两枚。红点复用 hide —— 这扇窗是隐藏不是销毁。
    minimize: () =>
      runOnethingTodoPlanWindowActionForIpc({
        action: () => minimizeTodoPlanWindow(),
      }),
    zoom: () =>
      runOnethingTodoPlanWindowActionForIpc({
        action: () => zoomTodoPlanWindow(),
      }),
    drag: (request: TodoPlanWindowDragRequest) =>
      runOnethingTodoPlanWindowActionForIpc({
        request,
        action: dragRequest => dragTodoPlanWindow(dragRequest),
      }),
  })
}
