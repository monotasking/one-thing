import { mcpRouter, type McpRoutes } from '@shared/ipc/mcp'
import type { MCPServerConfig } from '@shared/mcp/types'

/**
 * 设置页「连接器」(MCP 服务器)那一页与后端之间的那一层**端口**(2026-10-09)。
 *
 * 判例与 `browser-settings-port` / `network-settings-port` 逐字相同:形状是 `mcp` RPC 域的
 * **子集**(七条方法各自对应 `mcpRouter` 的一条,一个字段都没多),存在的唯一理由是**可测**:
 * 这一页的全部判据(状态怎么折成点、命令行怎么拆、改名不洗掉凭证)都是纯逻辑,不该为了测它
 * 去起一台后端。
 *
 * 这一页**不走** `settings.saveSettings` 整份写回:MCP 的增删改连在 `mcp` 域里各是一条方法,
 * 后端那一侧写设置、改连接、重建工具目录是一件事的三半(`mcp-server-orchestration.ts`),
 * 壳拿整份设置去写会绕过后两半。
 */
export interface McpConnectorsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  getServers(): Promise<McpRoutes['getServers']['output']>
  addServer(config: MCPServerConfig): Promise<McpRoutes['addServer']['output']>
  updateServer(config: MCPServerConfig): Promise<McpRoutes['updateServer']['output']>
  removeServer(serverId: string): Promise<McpRoutes['removeServer']['output']>
  connectServer(serverId: string): Promise<McpRoutes['connectServer']['output']>
  disconnectServer(serverId: string): Promise<McpRoutes['disconnectServer']['output']>
  logoutServer(serverId: string): Promise<McpRoutes['logoutServer']['output']>
}

let port: McpConnectorsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureMcpConnectorsPort(next: McpConnectorsPort | undefined): void {
  port = next
  pending = undefined
}

/** 真实现**惰性**建:它要的是那个连通之后才存在的客户端,换了端口的测试不该把连通面拖进来。 */
async function realPort(): Promise<McpConnectorsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(mcpRouter)
  return {
    ready: () => whenConnected(),
    getServers: () => api.getServers({}),
    addServer: (config) => api.addServer({ config }),
    updateServer: (config) => api.updateServer({ config }),
    removeServer: (serverId) => api.removeServer({ serverId }),
    connectServer: (serverId) => api.connectServer({ serverId }),
    disconnectServer: (serverId) => api.disconnectServer({ serverId }),
    logoutServer: (serverId) => api.logoutServer({ serverId }),
  }
}

let pending: Promise<McpConnectorsPort> | undefined

export function mcpConnectorsPort(): Promise<McpConnectorsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
