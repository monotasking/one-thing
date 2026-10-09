/**
 * 已知的本机 MCP 服务器:机器上装了就**默认填进设置**(2026-10-09,用户令「mcp 应用默认填好」)。
 *
 * 一张表,一行一台:`detect()` 看机器上有没有它,有就交出一条现成的服务器配置。后端起 MCP 子系统
 * 之前跑一遍 `seedKnownMCPServers`:表里检测得到、设置里还没有、用户也没删过的,填进 `servers`
 * 并落盘;用户在设置里删掉一台已知服务器,它的 id 记进 `dismissedKnownServers`,以后不再填回来。
 * 用户只是关掉(`enabled: false`)的不动 —— id 还在,不算「没有」。
 *
 * 今天只有一行:Codex 装在本机的 Computer Use MCP(`docs/design/computer-use-2026-10.md` §3.1 的配方)。
 * 再接一台已知服务器 = 这张表多一行,别处零改动。
 *
 * 探测只看文件在不在,不起任何进程;`CODEX_HOME` 照用户环境(缺省 `~/.codex`)。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { MCPServerConfig, MCPSettings } from '@shared/mcp/types'

/** 探测时看得见的环境:平台、环境变量、文件在不在。单测注入假的。 */
export interface KnownMCPServerProbe {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homeDir: string
  exists(filePath: string): boolean
}

export interface KnownMCPServer {
  readonly id: string
  /** 机器上有它就交出配置;没有就 `undefined`。 */
  detect(probe: KnownMCPServerProbe): MCPServerConfig | undefined
}

export const CODEX_COMPUTER_USE_SERVER_ID = 'codex-computer-use'

/** ChatGPT.app 自带的签名 `codex`:服务只认祖先进程里有 OpenAI 签名的来访者,所以拿它当跳板。 */
const CODEX_SIGNED_LAUNCHER = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

function codexHomeOf(probe: KnownMCPServerProbe): string {
  const configured = probe.env.CODEX_HOME?.trim()
  return configured || path.join(probe.homeDir, '.codex')
}

/** Codex 电脑操控那台闭源 MCP 的配方(§3.1);门 `scripts/gate-codex-computer-use.mjs` 按同一条断言。 */
export function codexComputerUseServerConfig(codexHome: string): MCPServerConfig {
  const client = path.join(
    codexHome, 'computer-use', 'Codex Computer Use.app', 'Contents', 'SharedSupport',
    'SkyComputerUseClient.app', 'Contents', 'MacOS', 'SkyComputerUseClient',
  )
  return {
    id: CODEX_COMPUTER_USE_SERVER_ID,
    name: 'Codex Computer Use',
    transport: 'stdio',
    enabled: true,
    command: CODEX_SIGNED_LAUNCHER,
    // 默认 seatbelt 会把客户端杀掉(mach-lookup launchservicesd 被拒),所以关沙箱;跳板只负责「签名的父进程」。
    args: ['sandbox', '-c', 'sandbox_mode="danger-full-access"', '--', client, 'mcp'],
    cwd: path.join(codexHome, 'computer-use'),
    env: { CODEX_HOME: codexHome },
  }
}

export const KNOWN_MCP_SERVERS: readonly KnownMCPServer[] = [
  {
    id: CODEX_COMPUTER_USE_SERVER_ID,
    detect(probe) {
      if (probe.platform !== 'darwin') return undefined
      const config = codexComputerUseServerConfig(codexHomeOf(probe))
      const client = config.args?.[4]
      if (!client || !probe.exists(CODEX_SIGNED_LAUNCHER) || !probe.exists(client)) return undefined
      return config
    },
  },
]

export function isKnownMCPServerId(id: string): boolean {
  return KNOWN_MCP_SERVERS.some(server => server.id === id)
}

/** 真机上的探测环境。 */
export function realKnownMCPServerProbe(): KnownMCPServerProbe {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    exists: filePath => existsSync(filePath),
  }
}

export interface SeedKnownMCPServersResult {
  readonly settings: MCPSettings
  /** 这次新填进去的 id;空 = 设置原样返回(同一个对象)。 */
  readonly added: readonly string[]
}

/**
 * 纯函数:把检测到、设置里没有、用户没删过的已知服务器填进 `servers`。
 * 没有要填的就把传进来的 `settings` 原样交回(同一个引用),调用方据此决定要不要落盘。
 */
export function seedKnownMCPServers(
  settings: MCPSettings,
  probe: KnownMCPServerProbe,
  table: readonly KnownMCPServer[] = KNOWN_MCP_SERVERS,
): SeedKnownMCPServersResult {
  const present = new Set(settings.servers.map(server => server.id))
  const dismissed = new Set(settings.dismissedKnownServers ?? [])
  const added: MCPServerConfig[] = []
  for (const known of table) {
    if (present.has(known.id) || dismissed.has(known.id)) continue
    const config = known.detect(probe)
    if (config) added.push(config)
  }
  if (added.length === 0) return { settings, added: [] }
  return {
    settings: { ...settings, servers: [...settings.servers, ...added] },
    added: added.map(config => config.id),
  }
}

/** 用户删掉一台已知服务器之后的设置:记进 `dismissedKnownServers`(不是已知的 id 原样返回)。 */
export function dismissKnownMCPServer(settings: MCPSettings, serverId: string): MCPSettings {
  if (!isKnownMCPServerId(serverId)) return settings
  const dismissed = settings.dismissedKnownServers ?? []
  if (dismissed.includes(serverId)) return settings
  return { ...settings, dismissedKnownServers: [...dismissed, serverId] }
}
