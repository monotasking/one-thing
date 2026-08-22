/**
 * 系统通知与 dock 徽标的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * web 端刻意降级为**只剩未读墨点**(那一半在渲染层自己的 store 里)。这不是
 * "还没做"而是刻意留白:浏览器的 Notification 要先问权限,而一个页面在用户没
 * 要求的情况下弹权限框是骚扰。真要做,入口该是设置里的一次显式授权。
 *
 * 两条都如实回成功 —— 逐字沿用迁移前 `platform/web.ts` 里那只 notify 命名空间。
 */
import type { NotifyRoutes } from '@shared/ipc/notify.js'
import { notifyRouter } from '@shared/ipc/notify.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export function createNotifyWebShellHandlers(): WebShellRouteHandlers<NotifyRoutes> {
  return {
    show: async () => ({ success: true }),
    setBadge: async () => ({ success: true }),
  }
}

export function registerNotifyWebShellDomain(): () => void {
  return registerWebShellDomain(notifyRouter, createNotifyWebShellHandlers())
}
