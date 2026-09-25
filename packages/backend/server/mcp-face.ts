/**
 * 活核 HTTP 面上**桥凭据**的那道门(ACP A4-a,`docs/design/acp-integration-2026-09.md` §3.6)。
 *
 * 用户 token 那道闸(`http-identity.ts`)一字不动。这里在它**前面**多看一眼,只接两种请求:
 *
 *  1. `/api/mcp`(任何方法)—— 宿主工具面的 Streamable HTTP 形,给自报 `mcpCapabilities.http`
 *     的 agent 直连(省一个 stdio 桥子进程)。**只认桥凭据**:没有 / 不是活凭据一律 401,
 *     用户 token 也不例外 —— 工具表按凭据算,用户 token 背后没有会话。
 *  2. 带着**活桥凭据**的 `POST /api/rpc` —— stdio 桥(`acp-mcp-bridge.cjs`)走的那条。只放
 *     `host-mcp` 一个域;信封里写别的域 → 403。context 铸成 `{ transport:'http',
 *     bridgeCredential }`,域处理者再查一次表。
 *
 * 其余一切(包括带着活桥凭据去敲别的路径)都不在这里放行:活桥凭据敲别的路径 → 403;
 * 不是活桥凭据 → 原样交回用户 token 那道闸,于是一把**作废了的**桥凭据在 `/api/rpc` 上
 * 自然得到 401 —— 它在哪张表里都查不到。
 *
 * 两条路答的是同一张表、同一次执行:`/api/mcp` 的处理器由产品层那段共用的
 * `installHostMcpToolHandlers` 装,源是进程内的桥对象;stdio 桥装的是同一段,源是对这里
 * `/api/rpc` 的调用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  HOST_MCP_BRIDGE_SERVER_NAME,
  HOST_MCP_HTTP_PATH,
  installHostMcpToolHandlers,
  type HostMcpServerLike,
} from '@onething/runtime/acp/mcp-bridge/server'
import { hostMcpRouter } from '@shared/ipc/host-mcp.js'
import type { RpcDispatchContext, RpcRequest } from '@shared/ipc/rpc.js'
import { dispatchRpc } from '../rpc/registry.js'
import { currentHostMcpBridge } from '../rpc/domains/host-mcp.js'
import type { HostMcpBridge } from '../wiring/acp/host-mcp-bridge.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('server.mcp-face')

/** 桥那条 RPC 的信封上限。工具参数是一两句话,1MiB 已经是很宽的边。 */
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024

function readBearer(request: IncomingMessage): string | undefined {
  const raw = request.headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BRIDGE_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 在用户 token 那道闸前面看一眼。答 `true` = 这条请求归这里(已经或即将应答);`false` =
 * 不关这里的事,原样交回 `http.ts`。
 */
export function serveBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runRequest?: (work: () => Promise<void>) => Promise<void>,
): boolean {
  const isMcpPath = url.pathname === HOST_MCP_HTTP_PATH
  const token = readBearer(request)
  const bridge = currentHostMcpBridge()
  const live = Boolean(token && bridge?.lookup(token))
  if (!isMcpPath && !live) return false

  const work = async (): Promise<void> => {
    if (!live || !bridge || !token) {
      sendJson(response, 401, {
        success: false,
        error: `Unauthorized: ${HOST_MCP_HTTP_PATH} only accepts a live bridge credential.`,
      })
      return
    }
    if (isMcpPath) return serveMcp(request, response, url, bridge, token)
    if (request.method === 'POST' && url.pathname === '/api/rpc') return serveBridgeRpc(request, response, token)
    sendJson(response, 403, { success: false, error: 'Forbidden: a bridge credential only reaches the host-mcp domain.' })
  }
  const guarded = (): Promise<void> => work().catch(error => {
    log.warn('bridge request failed', { path: url.pathname }, error)
    if (response.headersSent || response.destroyed) {
      response.destroy()
      return
    }
    sendJson(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) })
  })
  void (runRequest ? runRequest(guarded) : guarded())
  return true
}

/** stdio 桥那条:`POST /api/rpc`,只放 `host-mcp`。 */
async function serveBridgeRpc(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  let envelope: RpcRequest
  try {
    envelope = JSON.parse((await readBody(request)).toString('utf8')) as RpcRequest
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      error: { message: `Invalid RPC request body: ${error instanceof Error ? error.message : String(error)}` },
    })
    return
  }
  if (envelope?.domain !== hostMcpRouter.domain) {
    sendJson(response, 403, {
      ok: false,
      error: { message: `Forbidden: a bridge credential only reaches the ${hostMcpRouter.domain} domain.` },
    })
    return
  }
  // 身份由这里铸:桥凭据在门口查过了,域处理者再查一次。没有 owner / sandbox —— 这个域用不到,
  // 而给了反倒像是它能去碰文件系统。
  const context: RpcDispatchContext = { transport: 'http', bridgeCredential: token }
  sendJson(response, 200, await dispatchRpc(envelope, context))
}

/**
 * `/api/mcp`:MCP Streamable HTTP。每条请求一台新 `Server`(SDK `createMcpHandler` 的
 * 模型就是每请求一个实例;2025 年代的客户端走它自带的无状态兜底),处理器由共用那段装,
 * 源是进程内的桥对象 —— 凭据闭包进去,每次调用桥对象还会再查一次表。
 *
 * SDK 动态 import:它连着一份 ajv,不该让每一次核心启动都替这条很少被走到的路买单。
 */
async function serveMcp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  bridge: HostMcpBridge,
  token: string,
): Promise<void> {
  const { createMcpHandler, Server } = await import('@modelcontextprotocol/server')
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: HOST_MCP_BRIDGE_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    installHostMcpToolHandlers(server as unknown as HostMcpServerLike, {
      listTools: () => bridge.listTools(token),
      callTool: (name, args) => bridge.callTool(token, name, args),
    })
    return server
  }, {
    onerror: error => log.debug('mcp face rejected a request', { reason: error.message }),
  })
  try {
    const method = request.method || 'GET'
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
    const body = hasBody ? new Uint8Array(await readBody(request)) : undefined
    const answer = await handler.fetch(new Request(url.href, { method, headers, ...(body ? { body } : {}) }))
    response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()))
    if (answer.body) {
      const reader = answer.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(value)
      }
    }
    response.end()
  } finally {
    await handler.close()
  }
}
