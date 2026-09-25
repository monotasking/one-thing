/**
 * `acp-mcp-bridge.cjs` 的入口(ACP A4-a,`docs/design/acp-integration-2026-09.md` §3.6)。
 *
 * 一个**薄进程**:ACP agent 按 `session/new` 收到的 `mcpServers` 里那条 stdio 形把它起起来,
 * 它在 stdio 上说 MCP,把每个 `tools/list` / `tools/call` 转成对活核 `POST /api/rpc`
 * `host-mcp.*` 的一次调用。它自己**没有任何工具、任何状态**:工具表、执行、审批、持牌校验
 * 全在活核那一侧,钥匙(桥凭据)决定这一侧替哪条会话说话。
 *
 * 为什么要这样一个进程而不是把进程内 MCP 实例递过去:ACP 的 `mcpServers` 只认 stdio / http
 * / sse / acp 四种**可序列化**的形状,Claude SDK 那种 `type: 'sdk'` 的活实例过不了进程边界。
 * stdio 是四种里唯一一种每家 agent 都支持的,所以这条桥「所有 agent 通吃」;支持 http 的
 * agent 连这个子进程都省了(直连 `/api/mcp`)。
 *
 * 三份构建配方(React 主进程 / CLI / server)各出一份,永远落在宿主入口旁边,与
 * `search-worker.cjs` 同一条规矩;桌面上由 Electron 二进制带 `ELECTRON_RUN_AS_NODE=1` 起,
 * server / CLI 上就是 node。所以这里只许用 node 内建与能被 esbuild 打进来的纯 JS ——
 * 没有 electron,没有原生模块。
 *
 * ## stdout 是协议信道,一个字都不许多
 *
 * MCP stdio 的约定:stdout 只走 JSON-RPC 帧。排障写 stderr,而且只在起不来 / 连接断了
 * 这种时刻写一行 —— agent 多半会把 MCP 子进程的 stderr 抄进它自己的日志。
 */
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  createRpcToolSource,
  HOST_MCP_BRIDGE_ENV,
  HOST_MCP_BRIDGE_SERVER_NAME,
  installHostMcpToolHandlers,
  type HostMcpServerLike,
} from './server.js'

function stderr(line: string): void {
  try {
    process.stderr.write(`[onething-mcp-bridge] ${line}\n`)
  } catch {
    // stderr 也写不出去就算了 —— 不能因为一行排障把协议连接带下水。
  }
}

async function main(): Promise<void> {
  const url = process.env[HOST_MCP_BRIDGE_ENV.url]
  const token = process.env[HOST_MCP_BRIDGE_ENV.token]
  if (!url || !token) {
    stderr(`missing ${HOST_MCP_BRIDGE_ENV.url} / ${HOST_MCP_BRIDGE_ENV.token}; this process is started by the onething host, not by hand`)
    process.exit(2)
  }

  const server = new Server(
    { name: HOST_MCP_BRIDGE_SERVER_NAME, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // 与进程内那台同一句世界模型:这些工具作用在应用里,不是文件系统上。
      instructions: 'Tools provided by the onething app you are working inside. '
        + 'They act on real chats, boards and notifications that people can see.',
    },
  )
  installHostMcpToolHandlers(server as unknown as HostMcpServerLike, createRpcToolSource({ url, token }))

  const closed = new Promise<void>(resolve => {
    server.onclose = () => resolve()
  })
  await server.connect(new StdioServerTransport())
  await closed
}

// CJS 产物里没有顶层 await(esbuild 的 cjs 格式不接),所以包成一个函数。
main().then(
  () => process.exit(0),
  (error: unknown) => {
    stderr(`fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
