/**
 * 会话事件日志的渲染侧客户端(主线 E1)。
 *
 * **这是一个新文件,而不是往 `electron.ts` / `web.ts` 各加一行。**
 * 那两处一行原本是 T0 试点域立下的形状,但 `web.ts` 是 `transport:gate` 的四枚
 * 计量壳之一 —— 往里加行等于把那把只许降不许升的尺子顶红。既然两个平台都已经
 * 暴露了**通用**的 `rpcInvoke`(desktop 走 `rpc:invoke`,web 走 `POST /api/rpc`),
 * 一个域完全可以在壳外自己搭客户端:这正是主线 T 想要证明的水位 ——
 * **加一个域 = 一个 router 文件 + 一个 handler 文件 + 装配层一行,四壳零改动。**
 *
 * 代价说清楚:这个域的方法不挂在 `platformApi` 上,调用点得引这个模块。
 * 换来的是四壳 diff 为零。
 */
import { sessionEventsRouter } from '@shared/ipc/session-events.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

/**
 * `rpcInvoke` 在**调用时**才从 `platformApi` 上取:那是一个按访问解析的代理
 * (electron 桥 / web fetch 二选一),提前快照就会把它钉死在模块求值那一刻的
 * 那一侧。与 `electron.ts` 里 `invoke` 的写法同一条道理。
 */
export const sessionEventsApi = createRouterClient(
  sessionEventsRouter,
  request => platformApi.rpcInvoke(request),
)
