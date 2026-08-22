/**
 * acp(外部 Agent Client Protocol 代理)域的渲染侧客户端 —— 结构债 P4c 第六批。
 *
 * 形状照 `chat-client.ts` / `sessions-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的八个壳方法
 * 都是位置参数的(`acpConnectAgent(agentId)`),这里一律是信封:
 * `acpApi.connectAgent({ agentId })`。无参的 `getAgents` 按本仓惯例递 `{}`。
 *
 * 本域没有推送面:agent 连上以后的流是**会话事件**,由 `onSessionEvent` /
 * `onSessionStream` 送,与这个客户端无关。
 */
import { acpRouter } from '@shared/ipc/acp.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const acpApi = createRouterClient(acpRouter, request =>
  platformApi.rpcInvoke(request),
)
