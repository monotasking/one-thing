/**
 * sessions(会话)域的渲染侧客户端 —— 结构债 P4c 第五批。
 *
 * 形状照 `media-client.ts` / `skills-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的二十六个壳
 * 方法多是位置参数的(`renameSession(sessionId, newName)`、
 * `updateSessionModel(sessionId, provider, model)`),这里一律是信封:
 * `sessionsApi.rename({ sessionId, newName })`、
 * `sessionsApi.updateModel({ sessionId, provider, model })`。
 *
 * 无参的三条(`list` / `listMeta` / `getCacheStats`)按本仓惯例递 `{}`。
 *
 * 没搬过来的仍在 `platformApi` 上:会话相关的**推送**订阅
 * (`onSessionMessagesChanged` / `onContextSizeUpdated` / `onSessionEvent` /
 * `onSessionStream`)—— router 没有推送面。命令总线的入口是
 * `session-command-client.ts`,不是这里。
 */
import { sessionsRouter } from '@shared/ipc/sessions.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const sessionsApi = createRouterClient(sessionsRouter, request =>
  platformApi.rpcInvoke(request),
)
