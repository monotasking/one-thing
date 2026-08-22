/**
 * 深链确认门请求面的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * `onething://` 只有桌面宿主接得到 —— 注册 URL scheme 是操作系统级的事,浏览器里
 * 没有"外面点一条链接回到这个标签页"这种东西。两条都是诚实的实现:ready 说成功
 * (队列本来就不存在),respond 说得清地失败(而不是回一个假的成功,让调用方
 * 以为投递过了)。逐字沿用迁移前 `platform/web.ts`。
 */
import type { DeeplinkRoutes } from '@shared/ipc/deeplink.js'
import { deeplinkRouter } from '@shared/ipc/deeplink.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export function createDeeplinkWebShellHandlers(): WebShellRouteHandlers<DeeplinkRoutes> {
  return {
    ready: async () => ({ success: true }),
    respond: async () => ({
      success: false,
      error: 'deep links are desktop-only',
    }),
  }
}

export function registerDeeplinkWebShellDomain(): () => void {
  return registerWebShellDomain(deeplinkRouter, createDeeplinkWebShellHandlers())
}
