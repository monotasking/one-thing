/**
 * Todo / plan 的**窗口面**（主线 T1 第一批之后剩下的部分）。
 *
 * 数据面（读快照 / 增删改重命名 / 在文件管理器里显示目录）已迁到通用 RPC 通道
 * （`todoPlanRouter` → `@onething/app/rpc/domains/todo-plan.ts`）。这里只剩两样
 * 东西，都是宿主原生、迁不走的：
 *
 *  1. 四条窗口动作 —— 直接操作 BrowserWindow；
 *  2. `configureTodoPlanHost` 的端口注入 —— 变更广播（webContents.send）与
 *     Finder 里显示目录。注入必须留在这里，**RPC 域那边靠的正是这两个端口**：
 *     未注入端口的宿主（server / CLI）自然降级，而不是各写一份。
 */
import { registerElectronTodoPlanIpcHandlers } from '@onething/electron-host/ipc/todo-plan'
import type { ElectronTodoPlanPinnedRequest } from '@onething/electron-host/ipc/todo-plan'
import {
  IPC_CHANNELS,
  type TodoPlanWindowActionRequest,
  type TodoPlanWindowDragRequest,
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
import { configureTodoPlanHost } from '@onething/app/todo-plan/store.js'

export function registerTodoPlanHandlers(): void {
  configureTodoPlanHost({
    broadcastChanged: payload => broadcastElectronTodoPlanChanged({
      channel: IPC_CHANNELS.TODO_PLAN_CHANGED,
      payload,
    }),
    revealDirectory: revealElectronTodoPlanDirectory,
  })
  registerElectronTodoPlanIpcHandlers({
    channels: {
      openWindow: IPC_CHANNELS.TODO_PLAN_OPEN_WINDOW,
      hideWindow: IPC_CHANNELS.TODO_PLAN_HIDE_WINDOW,
      toggleWindow: IPC_CHANNELS.TODO_PLAN_TOGGLE_WINDOW,
      setWindowPinned: IPC_CHANNELS.TODO_PLAN_SET_WINDOW_PINNED,
      minimizeWindow: IPC_CHANNELS.TODO_PLAN_MINIMIZE_WINDOW,
      zoomWindow: IPC_CHANNELS.TODO_PLAN_ZOOM_WINDOW,
      dragWindow: IPC_CHANNELS.TODO_PLAN_DRAG_WINDOW,
    },
    openWindow: request =>
      runOnethingTodoPlanWindowActionForIpc({
        request: request as TodoPlanWindowActionRequest | undefined,
        action: openTodoPlanWindow,
      }),
    hideWindow: request =>
      runOnethingTodoPlanWindowActionForIpc({
        request: request as TodoPlanWindowActionRequest | undefined,
        action: hideTodoPlanWindow,
      }),
    toggleWindow: request =>
      runOnethingTodoPlanWindowActionForIpc({
        request: request as TodoPlanWindowActionRequest | undefined,
        action: toggleTodoPlanWindow,
      }),
    setWindowPinned: (request: ElectronTodoPlanPinnedRequest) =>
      setOnethingTodoPlanWindowPinnedForIpc({
        pinned: request.pinned,
        setPinned: setTodoPlanWindowPinned,
      }),
    // 自绘红绿灯的黄 / 绿两枚。红点复用 hideWindow —— 这扇窗是隐藏不是销毁。
    minimizeWindow: () =>
      runOnethingTodoPlanWindowActionForIpc({
        action: () => minimizeTodoPlanWindow(),
      }),
    zoomWindow: () =>
      runOnethingTodoPlanWindowActionForIpc({
        action: () => zoomTodoPlanWindow(),
      }),
    dragWindow: request =>
      runOnethingTodoPlanWindowActionForIpc({
        request: request as TodoPlanWindowDragRequest | undefined,
        action: dragRequest => dragTodoPlanWindow(dragRequest),
      }),
  })
}
