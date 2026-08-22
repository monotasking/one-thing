/**
 * 系统通知与 dock 徽标的**宿主处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 这一层**只执行**:弹一条通知、画一个墨点。"该不该弹"全部在 renderer 判定
 * (窗口焦点、会话可见性、未读水位、冷却窗都在那边的 store 里),把那些状态搬进
 * 主进程等于造第二份真源 —— 这条纪律搬家时一格没动。
 *
 * 通知点击要唤回的是**发起这次调用的那扇窗**,所以 `show` 吃
 * `ShellDispatchContext.callerId`:从前它是 `event.sender`,现在是宿主盖的章,
 * 来源同一个,只是不再穿过一条专用通道。
 */
import type {
  NotifyRoutes,
  NotifySimpleResponse,
  SetBadgeRequest,
  ShowNotificationRequest,
} from '@shared/ipc/notify.js'
import { notifyRouter } from '@shared/ipc/notify.js'
import {
  registerShellDomain,
  type ShellDispatchContext,
  type ShellRouteHandlers,
} from '../shell-registry.js'

export interface NotifyShellOperations {
  show(
    request: ShowNotificationRequest,
    callerId: number | undefined,
  ): Promise<NotifySimpleResponse>
  setBadge(request: SetBadgeRequest): Promise<NotifySimpleResponse>
}

export function createNotifyShellHandlers(
  operations: NotifyShellOperations,
): ShellRouteHandlers<NotifyRoutes> {
  return {
    show: async (request, context: ShellDispatchContext = {}) =>
      operations.show(request, context.callerId),
    setBadge: async request => operations.setBadge(request),
  }
}

export function registerNotifyShellDomain(operations: NotifyShellOperations): () => void {
  return registerShellDomain(notifyRouter, createNotifyShellHandlers(operations))
}
