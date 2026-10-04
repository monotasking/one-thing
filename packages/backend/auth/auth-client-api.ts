/**
 * oauth(订阅登录)域 —— 结构债 P4c 第七批,六条数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/oauth.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/oauth.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那六条 oauth invoke 通道);
 *  - `preload/bridge.ts` 的六条包装与 `platform/web.ts` 的六条 REST 镜像
 *    (其中 `oauthRefresh` 在渲染层**零调用点** —— 一条打得通的死镜像);
 *  - `http-server/http-server-routes.ts` 的六条 REST 路由、`http-server/http-server-runtime.ts` 的 `oauth` facade adapter,
 *    以及只服务于它的那套 **per-owner 的第二台 authService**。
 *
 * ## 一台 authService(拍板 #20,同 agents / models / skills 判例)
 *
 * 旧 server 按 owner 各开一台 `OnethingAuthService` + 各自的 `OnethingTokenStore`
 * (`owners/<uid>/<wid>/oauth`),桌面用的是装配层那台
 * `@onething/backend/auth` 单例(令牌住空间凭证池;批 8 之前默认空间是 `<store>/oauth-tokens.json`)。
 * 一个 store 两本令牌账等于把「我登没登录」这件事分叉:桌面登了,浏览器看不见。
 * 搬家取的是桌面那台 —— **web 与桌面从此读同一份凭证**。
 *
 * 顺带,凭证写回目标(`spaceId` / `entryId` / `label`,批 B6)在旧 server 路由上
 * 是被丢掉的(它只转发 `providerId`);走 router 之后它真的传到 `authService` 了 ——
 * 浏览器里往空间凭证池登录从此是真的。批 8(`docs/design/subscription-accounts-2026-09.md`
 * §8)起壳每一发都带 `spaceId`,`status` 答 `accounts[]`(这一池每个订阅账号一行)。
 *
 * ## 后端不开浏览器,壳开(批 1,`docs/design/provider-settings-rework-2026-09.md` §3.1)
 *
 * B1 / C0 R7 那几轮这里问的是「宿主有没有外壳能力」,有就在后端顺手把授权页拉起来。
 * React 壳注入 `shell` 口之后那一支会与壳自己的打开撞成两扇窗,而网页壳根本不该由
 * 后端(可能是别人的机器)开浏览器。于是 `start` **只返回** `authUrl` / `verificationUri`:
 * 桌面壳拿到后调 `openExternal` 自动开并记下开没开成,网页壳把链接放在屏上由用户点。
 *
 * ## 流的生命周期在 authService 里
 *
 * 设备码轮询、回调等待、到点超时与 `cancel` 都在 `OnethingAuthService`;每次相位变化
 * 经全局事件 `oauth:flow` 出网(`auth/auth-oauth-events.ts` 的 `installOAuthBusBroadcaster`)。
 * `devicePoll` 这条动词保留给还在自己轮询的调用方,它与服务自己的轮询走同一口、同一条收尾。
 *
 * ## 两条推送不在这里
 *
 * `OAUTH_TOKEN_REFRESHED` / `OAUTH_TOKEN_EXPIRED` 走
 * `configureOAuthEventBroadcaster`(`./auth-oauth-events.js`)——
 * router 今天没有推送面。`refresh` 里那句「刷新失败 = 令牌过期」因此改走
 * `notifyOAuthTokenExpired`(经事件源),而不是像从前桌面那样直接调 Electron 广播。
 */
import {
  completeOnethingOAuthCallbackForIpc,
  getOnethingOAuthStatusForIpc,
  logoutOnethingOAuthForIpc,
  normalizeCredentialTarget,
  pollOnethingOAuthDeviceFlowForIpc,
  refreshOnethingOAuthForIpc,
  startOnethingOAuthForIpc,
} from '@onething/backend/auth'
import { oauthRouter, type OAuthRoutes } from '@shared/ipc/oauth.js'
import { getAuthService } from '@onething/backend/auth/auth-process-service'
import { notifyOAuthTokenExpired } from '@onething/backend/auth/auth-oauth-events'
import { consolePort, getLogger } from '@onething/backend/logging/logging-configure'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'
import type { RefreshOnethingOAuthForIpcOptions, OnethingOAuthIpcLogger } from '@onething/backend/auth/auth-ipc-operations'
import type { ConsoleLikePort } from '@onething/backend/logging'

const log = getLogger('rpc.oauth')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog: ConsoleLikePort & OnethingOAuthIpcLogger = consolePort(log)

/**
 * 凭证写回目标的归一(批 B6;批 8 起缺席 / 非法 spaceId = **默认空间那一池**,不再是
 * `<store>/oauth-tokens.json` 单槽)。`entryId` 缺席:登录 = 追加(同身份更新那一条),
 * 读 / 退出 = 这一池第一个可用账号。
 */
function targetOf(request: {
  spaceId?: string
  entryId?: string
  label?: string
}): ReturnType<typeof normalizeCredentialTarget> {
  return normalizeCredentialTarget({
    spaceId: request.spaceId,
    entryId: request.entryId,
    label: request.label,
  })
}

export const oauthRpcHandlers: RpcRouteHandlers<OAuthRoutes> = {
  async start(request) {
    const target = targetOf(request)
    // 不递 `openExternal`:后端不开浏览器(见文件头)。
    return startOnethingOAuthForIpc({
      providerId: request.providerId,
      start: providerId => getAuthService().start(providerId, target),
      logger: consoleLog,
    })
  },
  async callback(request) {
    const target = targetOf(request)
    return completeOnethingOAuthCallbackForIpc({
      providerId: request.providerId,
      code: request.code,
      state: request.state,
      completeManualCode: (providerId, code, state) =>
        getAuthService().completeManualCode(providerId, code, state, target),
      logger: consoleLog,
    })
  },
  async devicePoll(request) {
    const target = targetOf(request)
    return pollOnethingOAuthDeviceFlowForIpc({
      providerId: request.providerId,
      flowId: request.flowId,
      deviceCode: request.deviceCode,
      pollDeviceFlow: (providerId, flowId) =>
        getAuthService().pollDeviceFlow(providerId, flowId, target),
      logger: consoleLog,
    })
  },
  async refresh(request) {
    const target = targetOf(request)
    const refreshOnethingOAuthForIpcOptions: RefreshOnethingOAuthForIpcOptions = {
      providerId: request.providerId,
      refreshToken: providerId => getAuthService().refreshToken(providerId, target),
      notifyTokenExpired: notifyOAuthTokenExpired,
      logger: consoleLog,
    };
    return refreshOnethingOAuthForIpc(refreshOnethingOAuthForIpcOptions)
  },
  async status(request) {
    const target = targetOf(request)
    return getOnethingOAuthStatusForIpc({
      providerId: request.providerId,
      getStatus: providerId => getAuthService().getStatus(providerId, target),
      logger: consoleLog,
    })
  },
  async logout(request) {
    const target = targetOf(request)
    return logoutOnethingOAuthForIpc({
      providerId: request.providerId,
      deleteToken: providerId => getAuthService().deleteToken(providerId, target),
      logger: consoleLog,
    })
  },
  async cancel(request) {
    const flowId = typeof request?.flowId === 'string' ? request.flowId : ''
    if (!flowId) return { success: false, cancelled: false, error: 'flowId is required' }
    return { success: true, cancelled: getAuthService().cancel(flowId) }
  },
}


/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `oauth` 的契约与处理者。 */
export const OAUTH_CLIENT_API = defineClientApi({ id: 'rpc:oauth', router: oauthRouter, handlers: oauthRpcHandlers })
