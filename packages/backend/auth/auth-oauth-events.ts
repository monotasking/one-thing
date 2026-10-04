/**
 * OAuth 令牌事件的**推送端口** —— 结构债 P4c 第七批。
 *
 * oauth 域的六条数据面已经迁到通用 RPC 通道(`oauthRouter` +
 * `backend/auth/auth-client-api.ts`),而 router 今天只有请求/响应面、没有推送面。
 * 两条推送(`OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED`)因此留在原地,
 * 按 practice 判例(`configurePracticeEventBroadcaster`)改成一个**注入端口**:
 * 谁在跑就由谁决定往哪儿广播。
 *
 *  - 桌面(`apps/electron/src/main/ipc/oauth.ts`)注入 `webContents.send`,
 *    payload 与从前逐字相同(`{ providerId }` / `{ providerId, error }`);
 *  - server(`backend/http-server/http-server-runtime.ts`)**串联**上去,把事件扇进
 *    `GET /api/oauth/events` 那条 SSE —— 单槽端口串联的判例同 todo-plan /
 *    scratchpad(`{ ...previous, broadcast: e => { previous?.(e); fanOut(e) } }`,
 *    并在 shutdown 时还原)。
 *
 * 事件源只有一个:装配层那台 `authService` 单例。监听在**第一次注入时**才挂上去
 * (import 本身零副作用 —— 见 `packages/backend/__tests__/import-side-effect-free.test.ts`),
 * 从没注入过的进程(CLI 守护)因此连监听都不装。
 */
import { getAuthService, type AuthService } from './auth-process-service.js'
import type { OnethingAuthFlowEvent } from '@onething/backend/auth'
import { getEventBus, isEventSystemInitialized } from '@onething/backend/event'
import { getLogger } from '@onething/backend/logging/logging-configure'

const log = getLogger('app.oauth.events')

export type OAuthTokenEvent =
  | { type: 'oauth:token-refreshed'; providerId: string }
  | { type: 'oauth:token-expired'; providerId: string; error?: string }

export type OAuthEventBroadcaster = (event: OAuthTokenEvent) => void

let broadcaster: OAuthEventBroadcaster | null = null
let listenersInstalled = false

function emit(event: OAuthTokenEvent): void {
  broadcaster?.(event)
}

/**
 * 把 `authService` 的两条事件接到本端口上。幂等,且**只在有人注入时**才装 ——
 * 端口是空的时候装监听没有意义,只会让 import 带上副作用。
 */
function installAuthServiceListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  getAuthService().on('token-refreshed', (data: { providerId: string }) => {
    emit({ type: 'oauth:token-refreshed', providerId: data.providerId })
  })
  getAuthService().on('token-expired', (data: { providerId: string; error?: string }) => {
    emit({ type: 'oauth:token-expired', providerId: data.providerId, error: data.error })
  })
}

export function configureOAuthEventBroadcaster(next: OAuthEventBroadcaster | null): void {
  broadcaster = next
  if (next) installAuthServiceListeners()
}

/** 当前注入的广播器 —— 单槽端口串联用,理由同 `getScratchpadHostPorts`。 */
export function getOAuthEventBroadcaster(): OAuthEventBroadcaster | null {
  return broadcaster
}

/**
 * 让 `refresh` 那条「刷新失败 = 令牌过期」也走同一条推送路。
 *
 * 从前两个宿主在这里分叉:桌面直接调 `broadcastElectronOAuthTokenExpired`,
 * server 调 `service.emit('token-expired', …)`。收敛成 server 那一侧的形状 ——
 * 经过事件源,于是桌面与 SSE 拿到的是同一份、同一次事件。渲染层收到的 payload
 * 一字未变。
 */
export function notifyOAuthTokenExpired(providerId: string, error?: string): void {
  getAuthService().emit('token-expired', { providerId, error })
}

/**
 * 登录流与令牌过期的**总线广播器**(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1)。
 *
 * 上面那个单槽端口服务的是旧的 `/api/oauth/events` SSE;React 壳只订 `GET /api/events`,
 * 所以这里把 `authService` 的两条事件接成两种全局事件 `oauth:flow` / `oauth:token-expired`
 * (`GLOBAL_EVENT_LEAVES_PROCESS` 里登记为出网),壳零通道代码。
 *
 * 写法照 `acp/acp-events.ts`:**发送时才取总线**;装配还没造出总线就 warn 一行丢掉 ——
 * 装配完成之前不会有人起登录流,真到了那一步,壳的 `oauth.status` 重问会补齐。
 *
 * 装配层在事件系统之后调它一次,返回的退订函数 `backend.own()` 掉 —— 于是两次 assemble
 * 之间监听不会叠。
 */
export function installOAuthBusBroadcaster(
  source: Pick<AuthService, 'on' | 'off'> = getAuthService(),
): () => void {
  const onFlow = (event: OnethingAuthFlowEvent): void => {
    if (!isEventSystemInitialized()) {
      log.warn('oauth flow event dropped before assembly', { providerId: event.providerId, phase: event.phase })
      return
    }
    getEventBus().emitGlobal({
      type: 'oauth:flow',
      providerId: event.providerId,
      flowId: event.flowId,
      phase: event.phase,
      ...(event.error ? { error: event.error } : {}),
    })
  }
  const onExpired = (event: { providerId: string; error?: string }): void => {
    if (!isEventSystemInitialized()) {
      log.warn('oauth token-expired event dropped before assembly', { providerId: event.providerId })
      return
    }
    getEventBus().emitGlobal({
      type: 'oauth:token-expired',
      providerId: event.providerId,
      ...(event.error ? { error: event.error } : {}),
    })
  }
  source.on('flow', onFlow)
  source.on('token-expired', onExpired)
  return () => {
    source.off('flow', onFlow)
    source.off('token-expired', onExpired)
  }
}
