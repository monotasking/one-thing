/**
 * 宿主工具面的**跨进程出口**共用的那一段(ACP A4-a,`docs/design/acp-integration-2026-09.md`
 * §3.6):给一台 MCP `Server` 装上 `tools/list` / `tools/call` 两个处理器,答案从一只
 * {@link HostMcpToolSource} 来。
 *
 * 两个出口吃同一段:
 *  - **stdio 桥**(`entry.ts` → `acp-mcp-bridge.cjs`):源 = 对活核 `POST /api/rpc`
 *    `host-mcp.*` 的调用({@link createRpcToolSource});
 *  - **HTTP 直连**(`backend/runtime/acp/acp-client-api-host-mcp-face.ts` 的 `/api/mcp`):源 = 进程内那只桥对象。
 *
 * 所以「工具表长什么样、调用失败怎么说」只有这一份;两个出口的差别只剩传输。
 *
 * 这个文件**不 import SDK**(与 `external-agents/host-mcp/server.ts` 的
 * `CreateSdkMcpServerFn`、CLI `mcp-command.ts` 的 `McpServerLike` 同一条纪律):调用方把
 * 自己的 `Server` 递进来,测试可以递替身,而这里的接触面小到一眼看得完。它也**不 import
 * 共享层的 IPC 契约**(产品层的禁令),域名与方法名在下面写成字面量,由装配层的单测对齐
 * `hostMcpRouter`。
 */

/** 桥进程读的两格环境变量。签发方(装配层)与桥入口说同一个名字 —— 名字归这里。 */
export const HOST_MCP_BRIDGE_ENV = Object.freeze({
  url: 'ONETHING_MCP_URL',
  token: 'ONETHING_MCP_TOKEN',
} as const)

/** agent 侧看到的服务器名(`mcp__onething__…`),与进程内那台(`HOST_MCP_SERVER_NAME`)同名。 */
export const HOST_MCP_BRIDGE_SERVER_NAME = 'onething'

/** HTTP 直连那张面挂在活核的哪条路径上。 */
export const HOST_MCP_HTTP_PATH = '/api/mcp'

/**
 * 桥说的 RPC 域。**必须**与共享层 `ipc/host-mcp.ts` 的 `hostMcpRouter` 一致 —— 这里
 * 不能 import 它(见文件头),对齐由 `backend/runtime/acp/__tests__/acp-client-api-host-mcp.test.ts` 钉住。
 */
export const HOST_MCP_RPC = Object.freeze({
  domain: 'host-mcp',
  listTools: 'listTools',
  callTool: 'callTool',
} as const)

export interface HostMcpToolListingLike {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface HostMcpCallResultLike {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** 两个出口的答案从这里来。 */
export interface HostMcpToolSource {
  listTools(): Promise<HostMcpToolListingLike[]>
  callTool(name: string, args: Record<string, unknown>): Promise<HostMcpCallResultLike>
}

/** 两个处理器共用的请求形状 —— 不吃 SDK 的请求类型。 */
export interface HostMcpIncomingRequest {
  params?: { name?: string; arguments?: unknown }
}

/** SDK `Server` 里这里用得到的那一格。 */
export interface HostMcpServerLike {
  setRequestHandler(method: string, handler: (request: HostMcpIncomingRequest) => Promise<unknown>): void
}

/** MCP 要求 `inputSchema.type === 'object'`;形状不对就给一张空对象模式,不让一只工具拖垮整张表。 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)
    && (schema as { type?: unknown }).type === 'object') {
    return schema as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}

function errorResult(text: string): HostMcpCallResultLike {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * 装两个处理器。零状态:每次 `tools/list` 现问源 —— 工具表跟着会话的场子 / 白名单走,
 * 钉在启动时就会在场子变了之后说谎(与 CLI `createResourceMcpServer` 选低层 API 的
 * 理由逐字相同)。
 *
 * `tools/call` 的失败**一律翻成 `isError` 的工具结果**,不抛成 JSON-RPC 错误:凭据作废、
 * 核心没了、网络断了,对模型来说都是「这一下没成」,而一条它读得懂的文字比一个协议错误
 * 码有用 —— 协议错误在多数 agent 里会被当成服务器坏了,整台 MCP 被摘掉。
 */
export function installHostMcpToolHandlers(server: HostMcpServerLike, source: HostMcpToolSource): void {
  server.setRequestHandler('tools/list', async () => {
    const tools = await source.listTools()
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeInputSchema(tool.inputSchema),
      })),
    }
  })

  server.setRequestHandler('tools/call', async (request) => {
    const name = typeof request.params?.name === 'string' ? request.params.name : ''
    const raw = request.params?.arguments
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    if (!name) return errorResult('tools/call needs a tool name')
    try {
      return await source.callTool(name, args)
    } catch (error) {
      return errorResult(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export interface RpcToolSourceOptions {
  /** 活核的根地址(`http://127.0.0.1:<port>`),不带 `/api/rpc`。 */
  url: string
  /** 桥凭据。 */
  token: string
  /** 测试替身;缺席用全局 `fetch`。 */
  fetch?: typeof fetch
  /** 一次调用的上限,毫秒。缺省 10 分钟:`send_message` 可能要等一张审批卡。 */
  timeoutMs?: number
}

/** 缺省的单次调用上限。工具可能在等人点审批卡,所以给得很宽;它只防「核心挂了永远不答」。 */
export const HOST_MCP_RPC_TIMEOUT_MS = 10 * 60_000

/**
 * stdio 桥的源:每个 MCP 请求 = 一次 `POST <url>/api/rpc`,`Authorization: Bearer <桥凭据>`。
 *
 * 失败的说法分三档,每一档都是模型读得懂的一句话:401(凭据作废 / 核心换了一台)、
 * RPC `{ ok:false }`(域处理者的原话)、网络 / 超时(核心没了)。
 */
export function createRpcToolSource(options: RpcToolSourceOptions): HostMcpToolSource {
  const doFetch = options.fetch ?? fetch
  const endpoint = `${options.url.replace(/\/+$/, '')}/api/rpc`
  const timeoutMs = options.timeoutMs ?? HOST_MCP_RPC_TIMEOUT_MS

  async function call<T>(method: string, payload: unknown): Promise<T> {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ domain: HOST_MCP_RPC.domain, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error('the host no longer accepts this bridge credential (the session was closed or the app restarted)')
    }
    if (!response.ok) throw new Error(`host answered HTTP ${response.status}`)
    const body = await response.json() as { ok?: boolean; data?: unknown; error?: { message?: string } }
    if (body?.ok !== true) throw new Error(body?.error?.message ?? 'host-mcp call failed')
    return body.data as T
  }

  return {
    async listTools() {
      const data = await call<{ tools?: HostMcpToolListingLike[] }>(HOST_MCP_RPC.listTools, {})
      return Array.isArray(data?.tools) ? data.tools : []
    },
    async callTool(name, args) {
      return call<HostMcpCallResultLike>(HOST_MCP_RPC.callTool, { name, args })
    },
  }
}
