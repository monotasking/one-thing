/**
 * chat(聊天面)域的渲染侧客户端 —— 结构债 P4c 第五批。
 *
 * 形状照 `sessions-client.ts` / `media-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的六个壳方法
 * 多是位置参数的(`updateMessageThinkingTime(sessionId, messageId, thinkingTime)`),
 * 这里一律是信封:`chatApi.updateMessageThinkingTime({ sessionId, messageId,
 * thinkingTime })`。无参的 `getActiveStreams` 按本仓惯例递 `{}`。
 *
 * `getActiveStreams` 的读数从此只有 `sessionIds` 一个字段名(桌面那条实现的
 * 形状);被删掉的 `GET /api/streams/active` 回的 `streams` 不再存在。
 *
 * 没搬过来的仍在 `platformApi` 上:`resumeAfterToolConfirm`(拍板 #21 —— 它往
 * 引擎递 `sender`,信封里没有那一格)与会话流的**推送**订阅
 * (`onSessionStream` / `onSessionEvent`)—— router 没有推送面。
 */
import { chatRouter } from '@shared/ipc/chat.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const chatApi = createRouterClient(chatRouter, request =>
  platformApi.rpcInvoke(request),
)
