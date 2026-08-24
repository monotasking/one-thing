/**
 * mcp(Model Context Protocol 服务器)域 —— 结构债 P4c 第六批,整只从手写 IPC
 * 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/mcp.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/mcp.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那十六条 mcp 通道);
 *  - `preload/bridge.ts` 的十六条包装与 `platform/web.ts` 的十六条 REST 镜像;
 *  - `server/http.ts` 的九条 REST 路由 + `/api/mcp/servers/<id>[/action]` 正则块 +
 *    `/api/mcp/servers/<id>/oauth/logout` + `/api/mcp/probe`,以及 `server/runtime.ts`
 *    的 `mcp` facade adapter 与它背后那套 **per-owner 的第二台 `HeadlessMCPManager`**。
 *
 * 逻辑一行没搬:十六条方法**逐条**转调 `@onething/runtime/mcp` 的投影
 * (`*OnethingMCP*ForIpc`),管家取的是进程内那台真 `MCPManager`(桌面 / CLI /
 * server 共用的同一个单例),设置取的是 `@onething/backend/stores/settings` ——
 * 与迁移前 `@main` 那份适配逐字同义。
 *
 * ## 按 `context.transport` 分叉的四道护栏(拍板 #20 的纪律:不放宽)
 *
 * 旧 server adapter 比桌面多出来的东西里,有四件是**真的校验/隔离**,逐字保留在
 * `transport === 'http'` 这一支上:
 *
 *  1. **私密字段脱敏**:`command` / `args` / `env` / `cwd` / `url` / `headers` 出
 *     `getServers` 与四条变更结果(add / update / connect / refresh)之前一律换成
 *     `SERVER_REDACTED_SECRET`(`server/mcp-secrets.ts`)。桌面不脱敏 —— 它本来就
 *     在同一台机器上,脱了反而让设置页读不到自己刚填的值。
 *  2. **更新时把脱敏值合并回去**:客户端交回来的配置若在私密键上带着哨兵(或
 *     干脆没带这个键),用磁盘上那份真值补齐,于是「只改个名字」不会把凭证洗掉。
 *  3. **`readConfigFile` 在 http 上不读本机文件**:旧 adapter 递的是
 *     `fileExists: () => false`(一句「文件不存在」),这里逐字照抄 —— 浏览器不该
 *     能拿这条通道当任意文件读取器。
 *  4. **stdio 探测在 http 上默认关闭**:`ONETHING_SERVER_MCP_STDIO === '1'` 才放行,
 *     否则回旧 server 那句 `MCP stdio transport is disabled in the web server runtime.`
 *     ——`allowMCPStdio` 的默认值本来就是这个环境变量。
 *
 * 剩下两类**不是**护栏,按 #20 / #27 / #28 同判例接受:
 *  - per-owner 的第二台管家与第二份设置(`owners/<uid>/<wid>` 那棵树)—— 一个 store
 *    一台管家,web 与桌面从此读同一份;
 *  - 「连接一律失败」不是这里的门,而是 `configureMCPClientHost` 那个端口的事:
 *    独立 server 默认注入 `DisabledServerMCPClient`,桌面注入真客户端,搬家不动它。
 */
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import type { MCPServerConfig, MCPServerState } from '@onething/core/mcp'
import fs from 'fs'
import {
  addOnethingMCPServerForIpc,
  callOnethingMCPToolForIpc,
  connectOnethingMCPServerForIpc,
  disconnectOnethingMCPServerForIpc,
  getOnethingMCPPromptForIpc,
  getOnethingMCPServersForIpc,
  listOnethingMCPPromptsForIpc,
  listOnethingMCPResourcesForIpc,
  listOnethingMCPToolsForIpc,
  logoutOnethingMCPServerForIpc,
  probeOnethingMCPServerForIpc,
  readOnethingMCPConfigFileForIpc,
  readOnethingMCPResourceForIpc,
  refreshOnethingMCPServerForIpc,
  removeOnethingMCPServerForIpc,
  updateOnethingMCPServerForIpc,
} from '@onething/runtime/mcp'
import {
  MCPManager,
  probeMCPServerConfig,
  registerMCPTools,
} from '@onething/runtime/mcp/index.wiring'
import { getMCPOAuthFlowManager } from '@onething/runtime/mcp/oauth/index'
import type { MCPSettings } from '@shared/ipc/mcp.js'
import type { McpRoutes } from '@shared/ipc/mcp.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import {
  mergeRedactedMCPServerConfig,
  sanitizeMCPMutationResultForClient,
  sanitizeMCPServerStatesForClient,
} from '../../server/mcp-secrets.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.mcp')
/** 投影层收的是鸭子 logger;`@main` 那份原来直接递 `console`,这里递受管的那只。 */
const consoleLog = consolePort(log)

const SERVER_MCP_STDIO_DISABLED_ERROR =
  'MCP stdio transport is disabled in the web server runtime.'

/** 只有网络那一侧要脱敏 —— 桌面读的是自己刚填进去的值。 */
function isRemoteCaller(context: RpcDispatchContext): boolean {
  return context.transport === 'http'
}

function getMCPSettings(): MCPSettings {
  return getSettings().mcp || DEFAULT_MCP_SETTINGS
}

async function saveMCPSettings(mcpSettings: MCPSettings): Promise<void> {
  const settings = getSettings()
  settings.mcp = mcpSettings
  await saveSettings(settings)
}

function mcpServerAdapters() {
  return {
    getSettings: getMCPSettings,
    saveSettings: saveMCPSettings,
    manager: MCPManager,
    registerTools: registerMCPTools,
    logoutOAuth: (serverId: string) => getMCPOAuthFlowManager().logout(serverId),
    logger: consoleLog,
  }
}

function projectStates(context: RpcDispatchContext): MCPServerState[] {
  const states = MCPManager.getServerStates()
  return isRemoteCaller(context) ? sanitizeMCPServerStatesForClient(states) : states
}

function projectMutation<T extends { server?: MCPServerState }>(
  result: T,
  context: RpcDispatchContext,
): T {
  return isRemoteCaller(context) ? sanitizeMCPMutationResultForClient(result) : result
}

/** 与 `server/runtime.ts` 里 `allowMCPStdio` 的默认值同源(环境变量,每次现读)。 */
function serverAllowsMcpStdio(): boolean {
  return process.env.ONETHING_SERVER_MCP_STDIO === '1'
}

export const mcpRpcHandlers: RpcRouteHandlers<McpRoutes> = {
  async getServers(_request, context = DESKTOP_RPC_CONTEXT) {
    return getOnethingMCPServersForIpc({
      getServerStates: () => projectStates(context),
      logger: consoleLog,
    }) as Promise<McpRoutes['getServers']['output']>
  },
  async addServer(request, context = DESKTOP_RPC_CONTEXT) {
    const result = (await addOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      config: request.config,
    })) as McpRoutes['addServer']['output']
    return projectMutation(result, context)
  },
  async updateServer(request, context = DESKTOP_RPC_CONTEXT) {
    // 护栏 2:客户端拿到的是脱敏后的配置,交回来时把真值合并回去。桌面不走这一步
    // (它拿到的本来就是真值,合并等于空操作,但保持形状「只有 http 有分叉」)。
    const config = isRemoteCaller(context)
      ? mergeRedactedMCPServerConfig(
          request.config,
          getMCPSettings().servers.find(
            (server: MCPServerConfig) => server.id === request.config.id,
          ),
        )
      : request.config
    const result = (await updateOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      config,
    })) as McpRoutes['updateServer']['output']
    return projectMutation(result, context)
  },
  async removeServer(request) {
    return removeOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      serverId: request.serverId,
    }) as Promise<McpRoutes['removeServer']['output']>
  },
  async connectServer(request, context = DESKTOP_RPC_CONTEXT) {
    const result = (await connectOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      serverId: request.serverId,
    })) as McpRoutes['connectServer']['output']
    return projectMutation(result, context)
  },
  async disconnectServer(request) {
    return disconnectOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      serverId: request.serverId,
    }) as Promise<McpRoutes['disconnectServer']['output']>
  },
  async logoutServer(request) {
    return logoutOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      serverId: request.serverId,
    }) as Promise<McpRoutes['logoutServer']['output']>
  },
  async probeServer(request, context = DESKTOP_RPC_CONTEXT) {
    // 护栏 4:起本机进程这件事,网络那一侧默认不给。
    if (
      isRemoteCaller(context)
      && request.config?.transport === 'stdio'
      && !serverAllowsMcpStdio()
    ) {
      return { ok: false, error: SERVER_MCP_STDIO_DISABLED_ERROR }
    }
    return probeOnethingMCPServerForIpc({
      config: request.config,
      probe: config => probeMCPServerConfig(config),
      logger: consoleLog,
    }) as Promise<McpRoutes['probeServer']['output']>
  },
  async refreshServer(request, context = DESKTOP_RPC_CONTEXT) {
    const result = (await refreshOnethingMCPServerForIpc({
      ...mcpServerAdapters(),
      serverId: request.serverId,
    })) as McpRoutes['refreshServer']['output']
    return projectMutation(result, context)
  },
  async getTools() {
    return listOnethingMCPToolsForIpc({
      getAllTools: () => MCPManager.getAllTools(),
      logger: consoleLog,
    }) as Promise<McpRoutes['getTools']['output']>
  },
  async callTool(request) {
    return callOnethingMCPToolForIpc({
      serverId: request.serverId,
      toolName: request.toolName,
      args: request.arguments,
      callTool: (serverId, toolName, args) => MCPManager.callTool(serverId, toolName, args),
      logger: consoleLog,
    }) as Promise<McpRoutes['callTool']['output']>
  },
  async getResources() {
    return listOnethingMCPResourcesForIpc({
      getAllResources: () => MCPManager.getAllResources(),
      logger: consoleLog,
    }) as Promise<McpRoutes['getResources']['output']>
  },
  async readResource(request) {
    return readOnethingMCPResourceForIpc({
      serverId: request.serverId,
      uri: request.uri,
      readResource: (serverId, uri) => MCPManager.readResource(serverId, uri),
      logger: consoleLog,
    }) as Promise<McpRoutes['readResource']['output']>
  },
  async getPrompts() {
    return listOnethingMCPPromptsForIpc({
      getAllPrompts: () => MCPManager.getAllPrompts(),
      logger: consoleLog,
    }) as Promise<McpRoutes['getPrompts']['output']>
  },
  async getPrompt(request) {
    return getOnethingMCPPromptForIpc({
      serverId: request.serverId,
      name: request.name,
      args: request.arguments,
      getPrompt: (serverId, name, args) => MCPManager.getPrompt(serverId, name, args),
      logger: consoleLog,
    }) as Promise<McpRoutes['getPrompt']['output']>
  },
  async readConfigFile(request, context = DESKTOP_RPC_CONTEXT) {
    // 护栏 3:网络那一侧拿到的是一句「文件不存在」,与旧 adapter 逐字同义。
    const remote = isRemoteCaller(context)
    return readOnethingMCPConfigFileForIpc({
      filePath: remote ? '' : request.filePath,
      fileExists: remote ? () => false : filePath => fs.existsSync(filePath),
      readTextFile: remote ? () => '' : filePath => fs.readFileSync(filePath, 'utf-8'),
      logger: consoleLog,
    }) as Promise<McpRoutes['readConfigFile']['output']>
  },
}

