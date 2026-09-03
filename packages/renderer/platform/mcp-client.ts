/**
 * mcp(Model Context Protocol 服务器)域的渲染侧客户端 —— 结构债 P4c 第六批。
 *
 * 形状照 `acp-client.ts` / `chat-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的十六个壳方法
 * 多是位置参数的(`mcpCallTool(serverId, toolName, args)`),这里一律是信封:
 * `mcpApi.callTool({ serverId, toolName, arguments: args })`。无参的
 * `getServers` / `getTools` / `getResources` / `getPrompts` 按本仓惯例递 `{}`。
 *
 * 本域没有推送面:server 推来的 list-changed 由主进程侧的客户端就地回灌,
 * 渲染层看到的是下一次 `getServers` 的读数。
 */
import { mcpRouter } from '@shared/ipc/mcp.js'
import { clientApi } from './client'

export const mcpApi = clientApi(mcpRouter)
