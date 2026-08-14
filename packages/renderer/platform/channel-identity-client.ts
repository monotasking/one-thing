/**
 * 渠道身份域的渲染侧客户端(主线 T1 第二批)。
 *
 * 形状照 E1 判例(`session-events-client.ts`):**壳外新建一个模块,走通用
 * `platformApi.rpcInvoke`**,而不是往 `electron.ts` / `web.ts` 各加一行 ——
 * 那两处正是 `transport:gate` 的计量壳,加行等于把只许降不许升的尺子顶红。
 *
 * `rpcInvoke` 在调用时才从 `platformApi` 上取:那是按访问解析的代理
 * (electron 桥 / web fetch 二选一),提前快照会把它钉死在模块求值那一刻的那一侧。
 */
import { channelIdentityRouter } from '@shared/ipc/channel-identity.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const channelIdentityApi = createRouterClient(
  channelIdentityRouter,
  request => platformApi.rpcInvoke(request),
)
