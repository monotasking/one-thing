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
 * ## 四道护栏(拍板 #20 的纪律:不放宽)
 *
 * 旧 server adapter 比桌面多出来的东西里,有四件是**真的校验/隔离**,逐字保留。
 * B2(`docs/design/backend-transport-forks-2026-09.md`)之后它们分成**两问**:
 * 1 与 2 问的是「这份 payload 出不出进程」(`payloadLeavesProcess`,transport 真
 * 答得了的问题);3 与 4 问的是「调用方是不是本机可信」(`server/host-trust.ts`),
 * 4 还要再细一档(只认桌面内嵌面,见 `canSpawnLocalProcesses`)。
 *
 *  1. **私密字段脱敏**:`command` / `args` / `env` / `cwd` / `url` / `headers` 出
 *     `getServers` 与四条变更结果(add / update / connect / refresh)之前一律换成
 *     `SERVER_REDACTED_SECRET`(`server/mcp-secrets.ts`)。桌面不脱敏 —— 它本来就
 *     在同一台机器上,脱了反而让设置页读不到自己刚填的值。
 *  2. **更新时把脱敏值合并回去**:客户端交回来的配置若在私密键上带着哨兵(或
 *     干脆没带这个键),用磁盘上那份真值补齐,于是「只改个名字」不会把凭证洗掉。
 *  3. **`readConfigFile` 在不可信宿主上不读本机文件**:旧 adapter 递的是
 *     `fileExists: () => false`(一句「文件不存在」),这里逐字照抄 —— 联网的
 *     浏览器不该能拿这条通道当任意文件读取器。本机可信的面(桌面内嵌 / 回环
 *     server)读的是自己机器上那份配置,与桌面 IPC 同权。
 *  4. **stdio 探测默认只给桌面内嵌面**:其余宿主 `ONETHING_SERVER_MCP_STDIO === '1'`
 *     才放行,否则回旧 server 那句
 *     `MCP stdio transport is disabled in the web server runtime.`
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
import { hostLocalTrustOrigin, isHostLocallyTrusted } from '../../server/host-trust.js'
import {
  mergeRedactedMCPServerConfig,
  sanitizeMCPMutationResultForClient,
  sanitizeMCPServerStatesForClient,
} from '../../server/mcp-secrets.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingMCPIpcLogger } from '@onething/runtime/mcp/ipc-operations'
import type { OnethingMCPServerIpcAdapters } from '@onething/runtime/mcp/ipc-operations'

const log = getLogger('rpc.mcp')
/** 投影层收的是鸭子 logger;`@main` 那份原来直接递 `console`,这里递受管的那只。 */
const consoleLog: ConsoleLikePort & OnethingMCPIpcLogger = consolePort(log)

const SERVER_MCP_STDIO_DISABLED_ERROR =
  'MCP stdio transport is disabled in the web server runtime.'

/**
 * payload 会不会走网络离开这个进程。
 *
 * 问的**不是**「调用方远不远」,而是「这份回应要不要出界」—— 出界就摘密钥。
 * 这是 `transport` 真正答得了的问题之一(B2 §2.1 把那个误导的旧名
 * 「远端调用方」换成了它):同一台机器上的 HTTP 面也照样脱敏,因为密文一旦上了 socket
 * 就不在进程里了;桌面 IPC 读的是自己刚填进去的值,不脱。
 */
function payloadLeavesProcess(context: RpcDispatchContext): boolean {
  return context.transport === 'http'
}

/**
 * 能不能替调用方在这台机器上**起一个进程**(mcp stdio probe 的闸)。
 *
 * B2 的保守裁定(方案 §4「请拍板」那一行的取值,施工者按缺省取保守):可信分两
 * 档,只有**桌面内嵌面**(`desktop-embedded`)免闸 —— 它跑在桌面主进程里,与用户
 * 自己点开设置面板去 probe 是同一件事;回环 `server:start` 虽然也算本机可信
 * (files / tools / search 那几道闸对它开),但"起本机子进程"比"读本机文件"更重,
 * 仍旧只由 `ONETHING_SERVER_MCP_STDIO=1` 决定。
 */
function canSpawnLocalProcesses(): boolean {
  return hostLocalTrustOrigin() === 'desktop-embedded'
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
  return payloadLeavesProcess(context) ? sanitizeMCPServerStatesForClient(states) : states
}

function projectMutation<T extends { server?: MCPServerState }>(
  result: T,
  context: RpcDispatchContext,
): T {
  return payloadLeavesProcess(context) ? sanitizeMCPMutationResultForClient(result) : result
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
    const mCPServerIpcAdapters: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { config: MCPServerConfig; } = {
      ...mcpServerAdapters(),
      config: request.config,
    };
    const result = (await addOnethingMCPServerForIpc(mCPServerIpcAdapters)) as McpRoutes['addServer']['output']
    return projectMutation(result, context)
  },
  async updateServer(request, context = DESKTOP_RPC_CONTEXT) {
    // 护栏 2:客户端拿到的是脱敏后的配置,交回来时把真值合并回去。桌面不走这一步
    // (它拿到的本来就是真值,合并等于空操作,但保持形状「只有 http 有分叉」)。
    const config = payloadLeavesProcess(context)
      ? mergeRedactedMCPServerConfig(
          request.config,
          getMCPSettings().servers.find(
            (server: MCPServerConfig) => server.id === request.config.id,
          ),
        )
      : request.config
    const mCPServerIpcAdapters2: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { config: MCPServerConfig; } = {
      ...mcpServerAdapters(),
      config,
    };
    const result = (await updateOnethingMCPServerForIpc(mCPServerIpcAdapters2)) as McpRoutes['updateServer']['output']
    return projectMutation(result, context)
  },
  async removeServer(request) {
    const mCPServerIpcAdapters3: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { serverId: string; } = {
      ...mcpServerAdapters(),
      serverId: request.serverId,
    };
    return removeOnethingMCPServerForIpc(mCPServerIpcAdapters3) as Promise<McpRoutes['removeServer']['output']>
  },
  async connectServer(request, context = DESKTOP_RPC_CONTEXT) {
    const mCPServerIpcAdapters4: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { serverId: string; } = {
      ...mcpServerAdapters(),
      serverId: request.serverId,
    };
    const result = (await connectOnethingMCPServerForIpc(mCPServerIpcAdapters4)) as McpRoutes['connectServer']['output']
    return projectMutation(result, context)
  },
  async disconnectServer(request) {
    const mCPServerIpcAdapters5: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { serverId: string; } = {
      ...mcpServerAdapters(),
      serverId: request.serverId,
    };
    return disconnectOnethingMCPServerForIpc(mCPServerIpcAdapters5) as Promise<McpRoutes['disconnectServer']['output']>
  },
  async logoutServer(request) {
    const mCPServerIpcAdapters6: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { serverId: string; } = {
      ...mcpServerAdapters(),
      serverId: request.serverId,
    };
    return logoutOnethingMCPServerForIpc(mCPServerIpcAdapters6) as Promise<McpRoutes['logoutServer']['output']>
  },
  async probeServer(request) {
    // 护栏 4:起本机进程这件事,默认只给桌面内嵌面(见 `canSpawnLocalProcesses`)。
    if (
      !canSpawnLocalProcesses()
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
    const mCPServerIpcAdapters7: OnethingMCPServerIpcAdapters<MCPServerConfig, MCPServerState> & { serverId: string; } = {
      ...mcpServerAdapters(),
      serverId: request.serverId,
    };
    const result = (await refreshOnethingMCPServerForIpc(mCPServerIpcAdapters7)) as McpRoutes['refreshServer']['output']
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
  async readConfigFile(request) {
    // 护栏 3:不可信宿主拿到的是一句「文件不存在」,与旧 adapter 逐字同义。
    // B2:判据从 `transport === 'http'` 改成本机可信 —— 读本机上那份 MCP 配置
    // 文件,桌面内嵌面与回环 server 与桌面 IPC 同权。
    const remote = !isHostLocallyTrusted()
    return readOnethingMCPConfigFileForIpc({
      filePath: remote ? '' : request.filePath,
      fileExists: remote ? () => false : filePath => fs.existsSync(filePath),
      readTextFile: remote ? () => '' : filePath => fs.readFileSync(filePath, 'utf-8'),
      logger: consoleLog,
    }) as Promise<McpRoutes['readConfigFile']['output']>
  },
}

