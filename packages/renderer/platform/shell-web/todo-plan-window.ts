/**
 * Todo / plan 窗口面的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 浏览器里那块面板是嵌在页面里的一块,不是一扇窗:开 / 收 / 切 / 置顶在 web 上是
 * 一个页内 CustomEvent(工作区面板注册表订阅它);自绘红绿灯与手动拖窗则**没有
 * 等价物** —— 老实回 `success: false`,而不是派一个假的本地事件去骗调用点。
 *
 * 两段都是迁移前 `platform/web.ts` 里那几行的逐字搬迁。
 */
import type {
  TodoPlanWindowActionRequest,
  TodoPlanWindowPinnedRequest,
  TodoPlanWindowRoutes,
} from '@shared/ipc/todo-plan.js'
import { todoPlanWindowRouter } from '@shared/ipc/todo-plan.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export const TODO_PLAN_WEB_WINDOW_EVENT = 'todo-plan:web-window-action'

type TodoPlanWebWindowAction = 'open' | 'hide' | 'toggle' | 'pin'

export function dispatchTodoPlanWindowAction(
  action: TodoPlanWebWindowAction,
  detail: { request?: TodoPlanWindowActionRequest; pinned?: boolean } = {},
): void {
  const target = typeof window === 'undefined' ? undefined : window
  if (!target?.dispatchEvent) return
  const payload = { action, ...detail }
  const event
    = typeof CustomEvent === 'function'
      ? new CustomEvent(TODO_PLAN_WEB_WINDOW_EVENT, { detail: payload })
      : ({
          type: TODO_PLAN_WEB_WINDOW_EVENT,
          detail: payload,
        } as unknown as Event)
  target.dispatchEvent(event)
}

export function createTodoPlanWindowWebShellHandlers(): WebShellRouteHandlers<TodoPlanWindowRoutes> {
  return {
    open: async (request: TodoPlanWindowActionRequest) => {
      dispatchTodoPlanWindowAction('open', { request })
      return { success: true }
    },
    hide: async (request: TodoPlanWindowActionRequest) => {
      dispatchTodoPlanWindowAction('hide', { request })
      return { success: true }
    },
    toggle: async (request: TodoPlanWindowActionRequest) => {
      dispatchTodoPlanWindowAction('toggle', { request })
      return { success: true }
    },
    setPinned: async (request: TodoPlanWindowPinnedRequest) => {
      dispatchTodoPlanWindowAction('pin', { pinned: request?.pinned })
      return { success: true, pinned: request?.pinned }
    },
    // 自绘红绿灯与手动拖窗是**桌面窗**的事:浏览器里没有窗可挪,也没有系统交通灯
    // 要替代,所以这三条老实地报 false。
    minimize: async () => ({ success: false }),
    zoom: async () => ({ success: false }),
    drag: async () => ({ success: false }),
  }
}

export function registerTodoPlanWindowWebShellDomain(): () => void {
  return registerWebShellDomain(todoPlanWindowRouter, createTodoPlanWindowWebShellHandlers())
}
