/**
 * 渠道身份域(主线 T1 第二批)。
 *
 * 迁移前:desktop 走 `apps/electron/src/main/ipc/channel-identity.ts`(已删),
 * server 走 `createServerChannelIdentityApi` —— 一份手写的、只服务于 8 条 HTTP
 * 路由的平行实现,读写的还是**另一个文件**。server 自己的引擎面(会话路由、
 * 出站回投)吃的是 `@onething/backend` 的 `ChannelIdentityStore`,于是同一个 server
 * 进程里 HTTP 看到的档案和引擎用的档案对不上。这里收成一份。
 *
 * 八个方法都是同步的 store 调用,这里逐个包成 `{ success, ... }` ——
 * 那层信封是渲染侧既有的消费形状,不是传输层能替它决定的东西。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import {
  channelIdentityRouter,
  type ChannelIdentityRoutes,
} from '@shared/ipc/channel-identity.js'
import {
  getChannelIdentityService,
  getChannelIdentityStore,
  identitySessionKey,
} from '../../channel/index.js'
import { registerRouterHandlers } from '../registry.js'

function failure(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export const channelIdentityRpcHandlers: RouteHandlers<ChannelIdentityRoutes> = {
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
  async listDeliveries() {
    try {
      return { success: true, deliveries: getChannelIdentityStore().listDeliveries() }
    } catch (error) {
      return failure(error)
    }
  },
}

export function registerChannelIdentityRpcDomain(): () => void {
  return registerRouterHandlers(channelIdentityRouter, channelIdentityRpcHandlers)
}
