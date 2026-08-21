/**
 * variables(标量变量)域的渲染侧客户端 —— 结构债 P4c。
 *
 * 形状照 `spaces-client.ts` / `practice-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的三个壳方法
 * 是位置参数的(`setVariable(sessionId, name, value, description, scope)`),
 * 这里一律是信封:`variablesApi.set({ sessionId, name, value, description, scope })`。
 *
 * 变量的实时更新不在这里:那条走 `session:variables-updated` 会话事件,
 * 这个域只负责初始快照与写。
 */
import { variablesRouter } from '@shared/ipc/variables.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const variablesApi = createRouterClient(variablesRouter, request =>
  platformApi.rpcInvoke(request),
)
