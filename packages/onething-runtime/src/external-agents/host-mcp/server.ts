/**
 * 进程内 MCP 服务器(§2 `server.ts`)。
 *
 * ## 侦察结论:SDK 的注入口长什么样
 *
 * `@anthropic-ai/claude-agent-sdk@0.3.214` 的 `sdk.d.ts`:
 *
 * ```
 * mcpServers?: Record<string, McpServerConfig>                          // Options
 * McpServerConfig = McpStdioServerConfig | McpSSEServerConfig
 *                 | McpHttpServerConfig | McpSdkServerConfigWithInstance
 * McpSdkServerConfigWithInstance = { type: 'sdk'; name: string; instance: McpServer }
 * createSdkMcpServer(options: {
 *   name, version?, instructions?, tools?: SdkMcpToolDefinition[], alwaysLoad?
 * }): McpSdkServerConfigWithInstance
 * SdkMcpToolDefinition = { name, description, inputSchema: ZodRawShape,
 *                          annotations?, _meta?, handler }
 * ```
 *
 * 也就是说 **in-process 形态是原生支持的**(`type: 'sdk'` + 一个活的 `McpServer`
 * 实例),不需要起 stdio 子进程、不需要开 http 端口。这一条是整个 E3 成立的前提
 * ——如果只支持 stdio,宿主工具就得跨进程走一遍序列化,而 `speakThroughCollabLease`
 * 依赖的 store 与回合登记簿都在这个进程里。
 *
 * `SdkMcpToolDefinition` 是一个**纯对象**,`tool()` 只是它的构造糖。我们因此直接
 * 递纯对象过去:SDK 的依赖面收敛到 `createSdkMcpServer` 一个函数,`tool()` 的
 * 泛型推断(zod 3/4 双支持的那一套)也不必参与进来。
 *
 * ## 一轮一台服务器
 *
 * 服务器**按回合创建**,`execSessionId` 闭包进每个 handler。这不是浪费:
 * connector 本来就是 `concurrentSessions: 'per-process'`(一轮一个 CLI 进程),
 * 而一轮一台服务器让并发隔离成为**结构事实**而不是纪律 —— 两间房同时跑,各自
 * 的 handler 闭包里是各自的会话 id,没有任何一条路能让它们看见对方。
 */
import { toHostMcpToolDefinition, type HostMcpHostTool, type HostMcpToolDefinition } from './tools.js'
import { HOST_MCP_SERVER_NAME, hostMcpToolName } from './types.js'

/** `createSdkMcpServer` 的结构子集 —— SDK 保持软依赖,测试可以替身。 */
export type CreateSdkMcpServerFn = (options: {
  name: string
  version?: string
  instructions?: string
  tools?: HostMcpToolDefinition[]
  alwaysLoad?: boolean
}) => { type: 'sdk'; name: string; instance: unknown }

export interface HostMcpServer {
  /** 服务器名。MCP 全名的中段。 */
  name: string
  /** 直接进 SDK `query()` 的 `mcpServers` 那一格。 */
  config: { type: 'sdk'; name: string; instance: unknown }
  /** 已注入工具的**全名**(`mcp__onething__…`)。 */
  toolNames: string[]
}

/**
 * 服务器给模型的说明。
 *
 * 一句话就够,而且必须说的是**世界模型**而不是用法:这几个工具与 SDK 自带的
 * Read/Write 不同,它们的效果发生在这个应用里(群聊、看板),不是文件系统上。
 * 不说清楚,模型会把 `send_message` 当成"往某个日志里写一行"。
 */
const HOST_MCP_INSTRUCTIONS =
  'Collaboration tools provided by the host app you are working inside. '
  + 'They act on real chats, boards and notes that people can see — '
  + 'send_message is how you actually speak to the room; nothing you write elsewhere is delivered.'

async function defaultCreateSdkMcpServer(): Promise<CreateSdkMcpServerFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.createSdkMcpServer as unknown as CreateSdkMcpServerFn
}

export interface CreateHostMcpServerOptions {
  /** 这台服务器服务的那一轮。闭包进每个 handler。 */
  execSessionId: string
  /** 已过场子门的工具对象 —— 本地回合调的**同一批**。 */
  tools: readonly HostMcpHostTool[]
  /** 测试替身。缺席时惰性 import SDK。 */
  createSdkMcpServer?: CreateSdkMcpServerFn
  logger?: Pick<Console, 'warn'>
}

/**
 * 起一台。`tools` 为空(普通对话、门全关)时返回 `undefined` —— 一台没有工具的
 * MCP 服务器只会在 SDK 的工具列表里多一行噪音。
 *
 * SDK 取不到时**降级而不是抛**:注入失败的代价是这一轮没有发言权(收养兜底还
 * 在,正文不会丢);抛出去的代价是整轮什么都没有。日志留一条 warn —— 这件事
 * 静悄悄地发生才是最坏的结局。
 */
export async function createHostMcpServer(
  options: CreateHostMcpServerOptions,
): Promise<HostMcpServer | undefined> {
  if (options.tools.length === 0) return undefined

  const definitions = options.tools.map(tool =>
    toHostMcpToolDefinition(tool, options.execSessionId),
  )

  /**
   * import 与建服务器**同在一个 try 里**。
   *
   * 分开写过一版:import 有兜底,`createSdkMcpServer(...)` 那一行没有 —— 于是
   * 「SDK 在但建不出来」(工具形状不合它的胃口、SDK 内部换了实现)会把整轮炸掉,
   * 而这正是兜底本来要防的那件事。两条失败路径的**代价相同**(这一轮没有宿主
   * 工具),所以兜底也该相同。
   */
  try {
    const create = options.createSdkMcpServer ?? (await defaultCreateSdkMcpServer())
    const config = create({
      name: HOST_MCP_SERVER_NAME,
      version: '1.0.0',
      instructions: HOST_MCP_INSTRUCTIONS,
      tools: definitions,
      // 永不延迟加载:`send_message` 是发言权本身,一个被 tool search 藏起来的
      // 发言工具等于这一轮又回到了收养兜底。
      alwaysLoad: true,
    })
    return {
      name: HOST_MCP_SERVER_NAME,
      config,
      toolNames: definitions.map(definition => hostMcpToolName(definition.name)),
    }
  } catch (error) {
    options.logger?.warn?.(
      `[host-mcp] host tools not injected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}
