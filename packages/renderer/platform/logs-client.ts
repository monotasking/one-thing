/**
 * 渲染侧日志上行的客户端(logging L3)。
 *
 * 形状照 E1 判例:**壳外一个模块 + 通用 `platformApi.rpcInvoke`,四壳零改动**。
 * 设计文本里写的 `ipc 'log:append'` / `POST /api/logs` 是通道级的说法;
 * 落地取通用信封 —— desktop 走 `rpc:invoke`,web 走 `POST /api/rpc`
 * (与其它路由同一道 Bearer 闸),`transport:gate` 的四枚计量壳一行不动。
 */
import { logsRouter } from '@shared/ipc/logs.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

/**
 * `rpcInvoke` 在**调用时**才从 `platformApi` 上取:那是按访问解析的代理
 * (electron 桥 / web fetch 二选一),提前快照会把它钉死在模块求值那一刻的那一侧。
 */
export const logsApi = createRouterClient(
  logsRouter,
  request => platformApi.rpcInvoke(request),
)
