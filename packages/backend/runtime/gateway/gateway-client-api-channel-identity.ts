/**
 * 渠道身份域(主线 T1 第二批)。
 *
 * 迁移前:desktop 走 旧 Vue 宿主主进程的 `ipc/channel-identity.ts`(已删),
 * server 走 `createServerChannelIdentityApi` —— 一份手写的、只服务于 8 条 HTTP
 * 路由的平行实现,读写的还是**另一个文件**。server 自己的引擎面(会话路由、
 * 出站回投)吃的是 `@onething/backend` 的 `ChannelIdentityStore`,于是同一个 server
 * 进程里 HTTP 看到的档案和引擎用的档案对不上。这里收成一份。
 *
 * 八个方法都是同步的 store 调用,这里逐个包成 `{ success, ... }` ——
 * 那层信封是渲染侧既有的消费形状,不是传输层能替它决定的东西。
 */
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionAccess } from '@onething/backend/runtime/sessions'
import { channelIdentityRouter, type ChannelIdentityRoutes } from '@shared/ipc/channel-identity.js'
import { getChannelIdentityService } from './gateway-channel-identity-service.js'
import { getChannelIdentityStore } from './gateway-channel-identity-store.js'
import { identitySessionKey } from '@onething/backend/runtime/agent-loop'

function failure(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export const channelIdentityRpcHandlers: RpcRouteHandlers<ChannelIdentityRoutes> = {
  async listProfiles() {
    try {
      return { success: true, profiles: getChannelIdentityStore().listProfiles() }
    } catch (error) {
      return failure(error)
    }
  },
  async createProfile(request) {
    try {
      return { success: true, profile: getChannelIdentityStore().createProfile(request) }
    } catch (error) {
      return failure(error)
    }
  },
  async updateProfile(request) {
    try {
      return { success: true, profile: getChannelIdentityStore().updateProfile(request) }
    } catch (error) {
      return failure(error)
    }
  },
  async listLinks(request) {
    try {
      return { success: true, links: getChannelIdentityStore().listLinks(request ?? {}) }
    } catch (error) {
      return failure(error)
    }
  },
  async createLink(request) {
    try {
      return { success: true, link: getChannelIdentityStore().createLink(request) }
    } catch (error) {
      return failure(error)
    }
  },
  async deleteLink(request) {
    try {
      const deleted = getChannelIdentityStore().deleteLink(request?.id ?? '')
      return deleted ? { success: true } : { success: false, error: 'Channel user link not found' }
    } catch (error) {
      return failure(error)
    }
  },
  async resolve(request) {
    try {
      const origin = getChannelIdentityService().resolveOrigin(request.origin)
      return {
        success: true,
        identity: origin.resolvedIdentity,
        origin,
        sessionId: identitySessionKey(origin),
      }
    } catch (error) {
      return failure(error)
    }
  },
  async listDeliveries(_request, context = DESKTOP_RPC_CONTEXT) {
    try {
      const deliveries = getChannelIdentityStore().listDeliveries()
      const visible = new Set(sessionAccess.filterIds(context, deliveries.map(item => item.sessionId)))
      return { success: true, deliveries: deliveries.filter(item => visible.has(item.sessionId)) }
    } catch (error) {
      return failure(error)
    }
  },
}

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `channel-identity` 的契约与处理者。 */
export const CHANNEL_IDENTITY_CLIENT_API = defineClientApi({ id: 'rpc:channel-identity', router: channelIdentityRouter, handlers: channelIdentityRpcHandlers })
