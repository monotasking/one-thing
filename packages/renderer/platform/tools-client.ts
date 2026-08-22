/**
 * tools(工具面)域的渲染侧客户端 —— 结构债 P4c 第九批。
 *
 * 形状照 `themes-client.ts` / `gateway-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。**本域零推送** —— 工具的执行进展走会话
 * 事件/流,不是这个域的通道。
 *
 * 这里额外做一件事:**保留旧的位置参数签名**。`executeTool` / `updateToolCall`
 * 从前是四个位置参数,router 上是单 id 包对象;包一层之后调用点一个字不用改,
 * 也不必学会新的入参形状。
 *
 * 无参的 `getTools` 按本仓惯例递 `{}`。
 */
import type { ToolCall } from '@shared/ipc/tools.js'
import type { JsonObject } from '@shared/json.js'
import { toolsRouter } from '@shared/ipc/tools.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const tools = createRouterClient(toolsRouter, request => platformApi.rpcInvoke(request))

export const toolsApi = {
  getTools: () => tools.getTools({}),
  executeTool: (
    toolId: string,
    args: JsonObject,
    messageId: string,
    sessionId: string,
  ) => tools.executeTool({ toolId, arguments: args, messageId, sessionId }),
  cancelTool: (toolCallId: string) => tools.cancelTool({ toolCallId }),
  listBackgroundJobs: (options?: { includeInactive?: boolean }) =>
    tools.backgroundJobsList(options ?? {}),
  stopBackgroundJob: (jobId: string) => tools.backgroundJobsStop({ jobId }),
  /** R4b 之后刷的是 MCP 工具面;全仓今天没有调用点,契约保留。 */
  refreshAsyncTools: (request?: { workingDirectory?: string }) =>
    tools.refreshAsyncTools(request ?? {}),
  updateToolCall: (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    updates: Partial<ToolCall>,
  ) => tools.updateToolCall({ sessionId, messageId, toolCallId, updates }),
}
