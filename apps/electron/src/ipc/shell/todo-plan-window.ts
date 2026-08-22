/**
 * Todo / plan 窗口面的**宿主处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 从前是七条手写 `ipcMain.handle`;现在是 `todoPlanWindowRouter` 的一份处理者表,
 * 走 `shell:invoke` 那一条通道。**语义逐字不变** —— 每个方法调的还是同一个
 * 窗口动作、回的还是同一个 `{ success, error? }`。
 *
 * 本文件不 import electron:动窗口的实现由 `@main/ipc/todo-plan.ts` 作为依赖注进来
 * (那一侧才碰 `BrowserWindow`),于是这张表的形状可以在没有 Electron 的单测里钉住。
 */
import type {
  TodoPlanWindowActionRequest,
  TodoPlanWindowDragRequest,
  TodoPlanWindowPinnedRequest,
  TodoPlanWindowPinnedResponse,
  TodoPlanWindowResponse,
} from '@shared/ipc/todo-plan.js'
import { todoPlanWindowRouter } from '@shared/ipc/todo-plan.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'
import type { TodoPlanWindowRoutes } from '@shared/ipc/todo-plan.js'

export interface TodoPlanWindowShellOperations {
  open(request: TodoPlanWindowActionRequest): TodoPlanWindowResponse
  hide(request: TodoPlanWindowActionRequest): TodoPlanWindowResponse
  toggle(request: TodoPlanWindowActionRequest): TodoPlanWindowResponse
  setPinned(request: TodoPlanWindowPinnedRequest): TodoPlanWindowPinnedResponse
  minimize(): TodoPlanWindowResponse
  zoom(): TodoPlanWindowResponse
  /**
   * 拖窗:拖拽期间每帧一条(rAF 节流,其余时候一条不发)。壳路由的每次调用只多
   * 一个信封字面量 + 一次 Map 查找,和 IPC 结构化克隆 + 一次 setBounds 不在一个
   * 量级 —— 换来的是这条路也能从调用点直达处理者。
   */
  drag(request: TodoPlanWindowDragRequest): TodoPlanWindowResponse
}

export function createTodoPlanWindowShellHandlers(
  operations: TodoPlanWindowShellOperations,
): ShellRouteHandlers<TodoPlanWindowRoutes> {
  return {
    open: async request => operations.open(request ?? {}),
    hide: async request => operations.hide(request ?? {}),
    toggle: async request => operations.toggle(request ?? {}),
    setPinned: async request => operations.setPinned(request),
    minimize: async () => operations.minimize(),
    zoom: async () => operations.zoom(),
    drag: async request => operations.drag(request),
  }
}

export function registerTodoPlanWindowShellDomain(
  operations: TodoPlanWindowShellOperations,
): () => void {
  return registerShellDomain(todoPlanWindowRouter, createTodoPlanWindowShellHandlers(operations))
}
