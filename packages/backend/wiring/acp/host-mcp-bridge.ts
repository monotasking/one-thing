/**
 * ACP 宿主工具面的**桥与凭据**(A4-a,`docs/design/acp-integration-2026-09.md` §3.6 / §11.5)。
 *
 * 今天的宿主工具面是一台进程内 MCP 实例(`createSdkMcpServer`),只有 Claude SDK 吃得下。
 * ACP 的 `NewSessionRequest.mcpServers` 只认可序列化的四种形状,所以这里给它两条路:
 *
 *  - **stdio 桥**(通吃):`{ name: 'onething', command: <这台宿主的 node / Electron>,
 *    args: [acp-mcp-bridge.cjs], env: [URL, 凭据, ELECTRON_RUN_AS_NODE=1] }` —— agent 把桥
 *    当子进程起,桥在 stdio 上说 MCP、对活核 `POST /api/rpc` 说 `host-mcp.*`;
 *  - **HTTP 直连**(agent 自报 `mcpCapabilities.http` 时,省一个子进程):
 *    `{ type: 'http', name: 'onething', url: <面>/api/mcp, headers: [Bearer <凭据>] }`。
 *
 * ## 凭据即归因
 *
 * 每个 (agentId, localSessionId) 签**一枚**桥凭据(`randomBytes(24).base64url`,只在内存里)。
 * 两条路上进来的每一次调用都拿它查这张表:查到了,就知道这是哪台 agent、替哪条会话、用哪份
 * 执行身份在说话 —— agent 自己传不了这些,所以也冒充不了。`callTool` 用它现算一份
 * `HostToolTurnContext`,交给与 Claude 路**同一只**包装(`hostMcpToolDefinitionWith`),
 * 于是 `send_message` 走的还是那张牌、那把租约、那个幂等窗 —— E3 那条链一个字不改。
 *
 * 凭据不是用户 token,两张表互不相认:用户 token 调 `host-mcp` 一律拒(context 里没有
 * `bridgeCredential`),桥凭据也打不开 `host-mcp` 以外的任何一扇门(`server/mcp-face.ts`)。
 * 会话收了 / 子系统 dispose 时作废;作废之后同一把钥匙再来 → HTTP 面 401、域处理者拒。
 *
 * ## 工具集
 *
 * 与 Claude 路同一张表(`resolveHostToolSurface`:场子门 + 白名单过滤后的协作四件),外加
 * `send_notification`(给人发一条通知,不进聊天正文)。表每次现问 —— 场子、白名单、手里
 * 那张牌都可能在两次调用之间变。
 *
 * ## 运行时接线(A4-b)
 *
 * connector 在握手之后、`session/new` 之前经 `wiring/external-agents` 的 `hostMcp` 端口调
 * `mintCredential`(同一对沿用同一枚),把 `mcpServers` 递给 `ACPManager.openSession`;每一轮
 * 开头 `beginTurn` 把这一轮的 `messageId` / 中止信号挂到钥匙背后,收场时摘掉。作废三处:
 * 会话删了(`revokeSession`)、agent 进程没了(`revokeAgent`,它起的桥子进程随它一起死)、
 * 子系统 dispose(`revokeAll`)—— 都在 `AcpSubsystem` 里订。
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { MCPServerConfig } from '@onething/core/mcp'
import {
  hostMcpToolDefinitionWith,
  type HostMcpCallResult,
  type HostMcpHostTool,
  type HostToolTurnContext,
} from '@onething/runtime/external-agents'
import {
  HOST_MCP_BRIDGE_ENV,
  HOST_MCP_BRIDGE_SERVER_NAME,
  HOST_MCP_HTTP_PATH,
  normalizeInputSchema,
} from '@onething/runtime/acp/mcp-bridge/server'
import { HOST_MCP_UNAUTHORIZED, type HostMcpToolListing } from '@shared/ipc/host-mcp.js'
import type { AgentNotificationEvent } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'
import type { HostToolSurface } from '../external-agents/host-tools.js'
import { httpDiscoveryUrl, readHttpDiscovery } from '../../server/discovery.js'
import { getSettings } from '../../stores/settings.js'
import { resolveAcpMcpBridgePath } from './mcp-bridge-path.js'

const log = getLogger('app.acp.host-mcp')

// ── ACP `McpServer` 的结构子集(不 import SDK 类型:这里只产数据,形状由协议定)──────────

export interface AcpNameValue {
  name: string
  value: string
}

export interface AcpMcpServerStdio {
  name: string
  command: string
  args: string[]
  env: AcpNameValue[]
}

export interface AcpMcpServerHttp {
  type: 'http' | 'sse'
  name: string
  url: string
  headers: AcpNameValue[]
}

export type AcpMcpServerEntry = AcpMcpServerStdio | AcpMcpServerHttp

/** agent 握手自报的 `agentCapabilities.mcpCapabilities`(协议那张表的子集)。 */
export interface AcpMcpCapabilities {
  http?: boolean
  sse?: boolean
}

// ── 凭据 ─────────────────────────────────────────────────────────────────────

export interface MintCredentialOptions {
  /** agent 自报的 MCP 传输能力。缺席 = 只认 stdio(协议的基线)。 */
  mcpCapabilities?: AcpMcpCapabilities | null
  /** agent 配置上的「把我的 MCP 名册也给它」开关。缺席 / false = 不透传。 */
  forwardMcpServers?: boolean
  /** 工具的工作目录(与 agent 那一侧的 cwd 同一个)。 */
  cwd?: string
  /** 宿主可信的执行身份;缺席 = 本机默认用户(与 Claude 路同一个缺省)。 */
  executionContext?: unknown
  /**
   * agent 配置上的「给它宿主工具面」开关(A4-b)。缺席 / true = 给;false = 不给 `onething` 那一条
   * (只剩透传的用户名册)—— 这时不该来签凭据,见 {@link HostMcpBridge.forwardedMcpServers}。
   */
  hostTools?: boolean
}

export interface MintedCredential {
  token: string
  /** 直接进 `session/new` / `load` / `resume` 的 `mcpServers`。 */
  mcpServers: AcpMcpServerEntry[]
}

interface CredentialEntry {
  readonly token: string
  readonly agentId: string
  readonly localSessionId: string
  executionContext?: unknown
  workingDirectory?: string
  /** 这一轮流进哪条 assistant 消息(A4-b 回合切换时由 `setTurn` 更新)。 */
  messageId?: string
  abortSignal?: AbortSignal
}

/** 查不到凭据时抛的那一种。message 以 {@link HOST_MCP_UNAUTHORIZED} 起头。 */
export class HostMcpUnauthorizedError extends Error {
  constructor(detail = 'this bridge credential is unknown or has been revoked') {
    super(`${HOST_MCP_UNAUTHORIZED}: ${detail}`)
    this.name = 'HostMcpUnauthorizedError'
  }
}

// ── send_notification ─────────────────────────────────────────────────────────

export const SEND_NOTIFICATION_TOOL_ID = 'send_notification'

const NOTIFICATION_LEVELS = ['info', 'success', 'warn', 'error'] as const

const sendNotificationParameters = z.object({
  message: z.string().min(1).max(2000),
  title: z.string().max(200).optional(),
  level: z.enum(NOTIFICATION_LEVELS).optional(),
})

/** 与上面那份 zod 逐格对应的 JSON Schema(过线给 agent 的那一份)。 */
const sendNotificationInputSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'What the person should know. One or two sentences.' },
    title: { type: 'string', description: 'Optional short headline.' },
    level: { type: 'string', enum: [...NOTIFICATION_LEVELS], description: 'Defaults to info.' },
  },
  required: ['message'],
  additionalProperties: false,
} as const

export type HostNotification = Omit<AgentNotificationEvent, 'type'>

/**
 * `send_notification` 是这张表里唯一一只**不在工具目录里**的:它不是本地回合的工具(本地
 * 回合的 AI 就在应用里,用不着「通知应用里的人」),只有外面的 agent 需要一条「叫人看一眼」
 * 的路。所以它就地定义,形状与目录来的那几只完全相同(`HostMcpHostTool`),执行同样经
 * `hostMcpToolDefinitionWith` 那只包装 —— 凭据作废时同样答「这一轮已经结束了」。
 *
 * 归属由凭据定:`sessionId` 取自语境(凭据背后那条会话),`agentId` 是签凭据时记下的那台
 * —— 两者都不从参数收。
 */
function sendNotificationTool(notify: (notification: HostNotification) => void, agentId: string): HostMcpHostTool {
  return {
    id: SEND_NOTIFICATION_TOOL_ID,
    description: 'Show a notification to the person using the host app (for example when a long task '
      + 'finishes or you need their attention). It does not post into the chat.',
    parameters: sendNotificationParameters,
    inputSchema: sendNotificationInputSchema,
    async execute(args, ctx) {
      const parsed = sendNotificationParameters.safeParse(args)
      if (!parsed.success) {
        return { output: `Notification not shown: ${parsed.error.issues.map(issue => issue.message).join('; ')}` }
      }
      notify({
        sessionId: ctx.sessionId,
        agentId,
        message: parsed.data.message,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        level: parsed.data.level ?? 'info',
        at: Date.now(),
      })
      return { output: 'Notification shown.' }
    },
  }
}

// ── 桥对象 ────────────────────────────────────────────────────────────────────

export interface HostMcpBridgeDeps {
  /** 活核 HTTP 面的根地址。缺席 = 这个进程没有 HTTP 面(CLI daemon)→ 不给宿主工具那一条。 */
  faceUrl?: () => string | undefined
  /** `acp-mcp-bridge.cjs` 的位置。缺席 = 找不到 → agent 没有 http 能力时不给宿主工具那一条。 */
  bridgePath?: () => string | undefined
  /** stdio 那一条的 command。缺省 `process.execPath`(桌面 = Electron,server / CLI = node)。 */
  execPath?: string
  /** 用户自己的 MCP 名册(`settings.mcp.servers`)。 */
  userMcpServers?: () => readonly MCPServerConfig[]
  /** 协作四件那一半的工具面。缺省 = `wiring/external-agents/host-tools.ts` 的 `resolveHostToolSurface`。 */
  resolveSurface?: (request: { localSessionId: string; executionContext?: unknown }) => Promise<HostToolSurface | undefined>
  /** `send_notification` 的出口。缺省 = 全局事件 `agent:notification`。 */
  notify?: (notification: HostNotification) => void
  /** 测试替身。缺省 `randomBytes(24).base64url`。 */
  mintToken?: () => string
}

export class HostMcpBridge {
  /** token → 条目。**实例字段**:它随 `AcpSubsystem` 生死(assembly:gate 不许模块级槽)。 */
  private readonly entries = new Map<string, CredentialEntry>()
  /** `${agentId}\0${localSessionId}` → token:一对一枚。 */
  private readonly byPair = new Map<string, string>()
  private readonly deps: HostMcpBridgeDeps

  constructor(deps: HostMcpBridgeDeps = {}) {
    this.deps = {
      faceUrl: liveFaceUrl,
      bridgePath: resolveAcpMcpBridgePath,
      userMcpServers: () => getSettings().mcp?.servers ?? [],
      ...deps,
    }
  }

  /** 此刻有几枚活凭据(观测 / 测试)。 */
  get size(): number {
    return this.entries.size
  }

  /**
   * 给 (agentId, localSessionId) 签一枚凭据,并组好要递给 agent 的 `mcpServers`。
   *
   * **同一对再签 = 同一枚**(刷新 cwd / 身份,不换钥匙):一条会话多轮、断线重连后的
   * `session/load` 都应当沿用 agent 手里已经起着的那条桥 —— 换钥匙会让它还活着的桥子进程
   * 当场变成一把废钥匙。真要换,先 `revoke`。
   */
  mintCredential(agentId: string, localSessionId: string, options: MintCredentialOptions = {}): MintedCredential {
    if (!agentId || !localSessionId) throw new Error('mintCredential needs an agentId and a localSessionId')
    const pairKey = `${agentId}\0${localSessionId}`
    const existing = this.byPair.get(pairKey)
    let entry = existing ? this.entries.get(existing) : undefined
    if (!entry) {
      const token = (this.deps.mintToken ?? defaultMintToken)()
      entry = { token, agentId, localSessionId }
      this.entries.set(token, entry)
      this.byPair.set(pairKey, token)
    }
    if (options.cwd !== undefined) entry.workingDirectory = options.cwd
    if (options.executionContext !== undefined) entry.executionContext = options.executionContext

    return { token: entry.token, mcpServers: this.composeMcpServers(entry.token, options) }
  }

  /** 作废一枚。答它原来在不在。 */
  revoke(token: string): boolean {
    const entry = this.entries.get(token)
    if (!entry) return false
    this.entries.delete(token)
    const pairKey = `${entry.agentId}\0${entry.localSessionId}`
    if (this.byPair.get(pairKey) === token) this.byPair.delete(pairKey)
    return true
  }

  /** 会话收了:这条会话名下的所有凭据(可能不止一台 agent)一起作废。答作废了几枚。 */
  revokeSession(localSessionId: string): number {
    let count = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.localSessionId === localSessionId && this.revoke(entry.token)) count += 1
    }
    return count
  }

  /** 子系统 dispose:全部作废。 */
  revokeAll(): void {
    this.entries.clear()
    this.byPair.clear()
  }

  /**
   * 这把钥匙背后的语境。查不到 = `undefined`。
   *
   * 这里答的是**稳定的那一半**(agent / 会话 / 身份 / 目录 / 消息):房与牌要问存储,
   * `callTool` 每次现算。
   */
  lookup(token: string | undefined): HostToolTurnContext | undefined {
    const entry = token ? this.entries.get(token) : undefined
    return entry ? this.contextOf(entry) : undefined
  }

  /** A4-b:回合切换时更新这把钥匙背后的「这一轮」。钥匙不在答 false。 */
  setTurn(token: string, turn: { messageId?: string; abortSignal?: AbortSignal }): boolean {
    const entry = this.entries.get(token)
    if (!entry) return false
    entry.messageId = turn.messageId
    entry.abortSignal = turn.abortSignal
    return true
  }

  /**
   * 连接器那一面(A4-b):按 (agentId, localSessionId) 把这一轮挂上去,答一个收场时调的函数。
   * 这对还没有钥匙(`hostTools: false`、或者面不在)→ 什么都不做。收场只摘**自己挂上的那一轮**:
   * 下一轮已经挂上来了(中止之后立刻重发)就不去动它。
   */
  beginTurn(agentId: string, localSessionId: string, turn: { messageId?: string; abortSignal?: AbortSignal }): () => void {
    const token = this.byPair.get(`${agentId}\0${localSessionId}`)
    if (!token || !this.setTurn(token, turn)) return () => undefined
    const entry = this.entries.get(token)
    return () => {
      if (!entry || this.entries.get(token) !== entry) return
      if (entry.messageId !== turn.messageId || entry.abortSignal !== turn.abortSignal) return
      entry.messageId = undefined
      entry.abortSignal = undefined
    }
  }

  /** agent 进程没了:它名下的所有凭据一起作废(它起的桥子进程随它死了)。答作废了几枚。 */
  revokeAgent(agentId: string): number {
    let count = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.agentId === agentId && this.revoke(entry.token)) count += 1
    }
    return count
  }

  /** `tools/list` 的答案。钥匙不对抛 {@link HostMcpUnauthorizedError}。 */
  async listTools(token: string | undefined): Promise<HostMcpToolListing[]> {
    const entry = this.requireEntry(token)
    const tools = await this.toolTable(entry)
    return tools.map(tool => ({
      name: tool.id,
      description: tool.description,
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }))
  }

  /**
   * `tools/call`。钥匙不对抛 {@link HostMcpUnauthorizedError};工具不在这张表里答一条
   * `isError` 的结果(不抛 —— 模型据此知道换一只,而不是以为宿主坏了)。
   */
  async callTool(token: string | undefined, name: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> {
    const entry = this.requireEntry(token)
    const surface = await this.surfaceOf(entry)
    const tools = [...(surface?.tools ?? []), this.notificationTool(entry)]
    const tool = tools.find(candidate => candidate.id === name)
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool "${name}". Call tools/list for the current set.` }], isError: true }
    }

    const context: HostToolTurnContext = {
      ...this.contextOf(entry),
      ...(surface ? { roomSessionId: surface.roomSessionId, executionContext: surface.executionContext } : {}),
      ...(surface?.leaseId ? { leaseId: surface.leaseId } : {}),
    }
    // 语境每次现问:执行途中钥匙被作废,包装答「这一轮已经结束了」,与 Claude 路同一句。
    const definition = hostMcpToolDefinitionWith(tool, () =>
      this.entries.get(entry.token) === entry ? context : undefined,
    )
    const result = await definition.handler(args, undefined)
    log.info('host tool call', {
      agentId: entry.agentId,
      sessionId: entry.localSessionId,
      tool: name,
      isError: result.isError === true,
    })
    return result
  }

  /**
   * 组 `mcpServers`。规则(§3.6 / §11.5):
   *
   *  ① 宿主那一条,**至多一条**:agent 自报 `http` → HTTP 直连(省一个子进程);否则 stdio 桥。
   *     面地址拿不到(这个进程不服务 HTTP,例如 CLI daemon)→ 两条都不给:桥进程连不回
   *     一个不存在的面。stdio 形还要找得到 `acp-mcp-bridge.cjs`,找不到同样不给。
   *  ② 用户自己的 MCP 名册,**只在 `forwardMcpServers === true` 时**透传:只取启用的;
   *     stdio 逐条转成 `{ name, command, args, env: [{name,value}] }`(`cwd` 协议里没有这一格,
   *     丢);http / sse 只给自报了对应能力的 agent。与宿主那一条撞名的跳过 —— agent 那一侧
   *     同名两台是未定义行为。
   */
  composeMcpServers(token: string, options: MintCredentialOptions = {}): AcpMcpServerEntry[] {
    const capabilities = options.mcpCapabilities ?? {}
    const servers: AcpMcpServerEntry[] = []

    const face = options.hostTools === false ? undefined : this.deps.faceUrl?.()
    if (options.hostTools === false) {
      // 用户关了这台 agent 的宿主工具面:不给 `onething` 那一条,名册透传照旧按开关。
    } else if (face) {
      const base = face.replace(/\/+$/, '')
      if (capabilities.http === true) {
        servers.push({
          type: 'http',
          name: HOST_MCP_BRIDGE_SERVER_NAME,
          url: `${base}${HOST_MCP_HTTP_PATH}`,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        })
      } else {
        const bridgePath = this.deps.bridgePath?.()
        if (bridgePath) {
          servers.push({
            name: HOST_MCP_BRIDGE_SERVER_NAME,
            command: this.deps.execPath ?? process.execPath,
            args: [bridgePath],
            env: [
              { name: HOST_MCP_BRIDGE_ENV.url, value: base },
              { name: HOST_MCP_BRIDGE_ENV.token, value: token },
              // 桌面上 command 是 Electron 二进制,这一格让它以 node 身份跑;node 上它是无害的一格。
              { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            ],
          })
        } else {
          log.warn('no acp-mcp-bridge.cjs on this host; the agent gets no host tools this session')
        }
      }
    } else {
      log.warn('no live HTTP face in this process; the agent gets no host tools this session')
    }

    servers.push(...this.forwardedMcpServers(options))
    return servers
  }

  /**
   * 只有透传的那一半(`forwardMcpServers === true` 时的用户名册)。`hostTools: false` 的 agent
   * 走这里 —— 不签凭据,因为没有 `onething` 那一条要用它。
   */
  forwardedMcpServers(options: Pick<MintCredentialOptions, 'mcpCapabilities' | 'forwardMcpServers'> = {}): AcpMcpServerEntry[] {
    if (options.forwardMcpServers !== true) return []
    const capabilities = options.mcpCapabilities ?? {}
    const servers: AcpMcpServerEntry[] = []
    for (const server of this.deps.userMcpServers?.() ?? []) {
      const forwarded = forwardUserMcpServer(server, capabilities)
      if (!forwarded) continue
      if (forwarded.name === HOST_MCP_BRIDGE_SERVER_NAME) {
        log.warn('user MCP server shadows the host server name; not forwarded', { serverId: server.id })
        continue
      }
      servers.push(forwarded)
    }
    return servers
  }

  // ── 内部 ──

  private requireEntry(token: string | undefined): CredentialEntry {
    const entry = token ? this.entries.get(token) : undefined
    if (!entry) throw new HostMcpUnauthorizedError()
    return entry
  }

  private contextOf(entry: CredentialEntry): HostToolTurnContext {
    return {
      agentId: entry.agentId,
      ...(entry.executionContext === undefined ? {} : { executionContext: entry.executionContext }),
      roomSessionId: entry.localSessionId,
      execSessionId: entry.localSessionId,
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      ...(entry.workingDirectory ? { workingDirectory: entry.workingDirectory } : {}),
      ...(entry.abortSignal ? { abortSignal: entry.abortSignal } : {}),
    }
  }

  private async surfaceOf(entry: CredentialEntry): Promise<HostToolSurface | undefined> {
    const resolve = this.deps.resolveSurface ?? defaultResolveSurface
    try {
      return await resolve({
        localSessionId: entry.localSessionId,
        ...(entry.executionContext === undefined ? {} : { executionContext: entry.executionContext }),
      })
    } catch (error) {
      // 协作那一半解析失败(会话越权 / 存储读不到)不该连 `send_notification` 一起带走。
      log.warn('host tool surface unavailable for this credential', { sessionId: entry.localSessionId }, error)
      return undefined
    }
  }

  private async toolTable(entry: CredentialEntry): Promise<HostMcpHostTool[]> {
    const surface = await this.surfaceOf(entry)
    return [...(surface?.tools ?? []), this.notificationTool(entry)]
  }

  private notificationTool(entry: CredentialEntry): HostMcpHostTool {
    return sendNotificationTool(this.deps.notify ?? defaultNotify, entry.agentId)
  }
}

// ── 缺省依赖 ──────────────────────────────────────────────────────────────────

/**
 * 这个进程自己服务的那张 HTTP 面的根地址。
 *
 * 读的是发现文件 `<store>/run/http.json`,并且**只认自己写的那一份**(`pid === process.pid`):
 * 桌面的内嵌面与 `server:start` 都在监听之后写它;CLI daemon 不服务 HTTP,答 `undefined`。
 * 盘上躺着的若是别的进程的宣告(React 壳挂在一台活核上时),那台核的凭据表里没有我们签的
 * 钥匙 —— 把 agent 指过去只会换来 401,所以不认。
 *
 * 监听在通配地址(`0.0.0.0` / `::`)时换成回环:桥是本机子进程,永远从本机连回来。
 */
function liveFaceUrl(): string | undefined {
  try {
    const record = readHttpDiscovery()
    if (!record || record.pid !== process.pid) return undefined
    const host = record.host === '0.0.0.0' ? '127.0.0.1' : record.host === '::' ? '::1' : record.host
    return httpDiscoveryUrl({ ...record, host })
  } catch (error) {
    log.warn('cannot read the http discovery record', {}, error)
    return undefined
  }
}

function defaultMintToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * 工具面走动态 import:它那棵树(会话仓库、工具目录、v3 登记簿)只有真有调用进来时才需要,
 * 不该因为子系统被构造就进每一份单测的模块图。
 */
async function defaultResolveSurface(request: { localSessionId: string; executionContext?: unknown }): Promise<HostToolSurface | undefined> {
  const { resolveHostToolSurface } = await import('../external-agents/host-tools.js')
  return resolveHostToolSurface(request)
}

function defaultNotify(notification: HostNotification): void {
  void import('../../events/index.js').then(({ getEventBus }) => {
    getEventBus().emitGlobal({ type: 'agent:notification', ...notification })
  }).catch(error => log.warn('agent notification not delivered', { sessionId: notification.sessionId }, error))
}

/** 用户名册里的一条 → ACP 那一侧的一条。不该给的答 `undefined`。 */
export function forwardUserMcpServer(server: MCPServerConfig, capabilities: AcpMcpCapabilities): AcpMcpServerEntry | undefined {
  if (!server.enabled) return undefined
  const name = server.name || server.id
  if (server.transport === 'stdio') {
    if (!server.command) return undefined
    return {
      name,
      command: server.command,
      args: [...(server.args ?? [])],
      env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value })),
    }
  }
  if ((server.transport === 'http' && capabilities.http === true) || (server.transport === 'sse' && capabilities.sse === true)) {
    if (!server.url) return undefined
    return {
      type: server.transport,
      name,
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    }
  }
  return undefined
}
