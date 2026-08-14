/**
 * Markdown 附件域的渲染侧客户端（主线 T 批 3）。
 *
 * 照 E1 判例搭在**壳外**：`electron.ts` / `web.ts` / `bridge.ts` / `channels.ts`
 * 是 `transport:gate` 的四枚计量壳，往里加行等于把只许降不许升的尺子顶红。两个
 * 平台都已经暴露了通用 `rpcInvoke`，域自己搭客户端即可 —— 加一个域 = 一个 router
 * 文件 + 一个 handler 文件 + 装配层一行，四壳零改动。
 */
import { markdownRouter } from '@shared/ipc/markdown.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

/**
 * `rpcInvoke` 在**调用时**才从 `platformApi` 上取：那是一个按访问解析的代理
 * （electron 桥 / web fetch 二选一），提前快照就会把它钉死在模块求值那一刻的
 * 那一侧。
 */
export const markdownApi = createRouterClient(
  markdownRouter,
  request => platformApi.rpcInvoke(request),
)
