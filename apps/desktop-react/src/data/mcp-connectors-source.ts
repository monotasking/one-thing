import { createMutation, createQuery } from './kernel'
import { mcpConnectorsPort } from './mcp-connectors-port'
import { t, type MessageKey } from '../i18n'
import {
  MCP_SERVER_REDACTED_SECRET,
  type MCPConnectionStatus,
  type MCPServerConfig,
  type MCPServerState,
  type MCPTransportType,
} from '@shared/mcp/types'

/**
 * 设置页「连接器」那一页的取数与写路(2026-10-09,用户令「设置也增加 mcp(连接器)配置」)。
 *
 * ── 屏幕上那一页要的形状 ──────────────────────────────────────────────────
 * 后端交的是 `MCPServerState[]`(配置 + 连接状态 + 三张能力表);屏幕只问每一行六件事:
 * 叫什么、哪种接法、开没开、连上没有(连不上为什么)、几只工具、要不要登录。所以线上形状
 * → 屏幕形状只投一次(`toConnectorRows`),渲染层拿到的是一行一个小对象。
 *
 * ── 看不见的那几格 ──────────────────────────────────────────────────────
 * 壳走 HTTP 面,`command / args / env / cwd / headers` 出进程时被换成哨兵
 * (`MCP_SERVER_REDACTED_SECRET`)。所以:屏幕上 stdio 的那一行只说「本地命令」不显示命令;
 * 编辑时命令行那一格**留空 = 保持原样**(把哨兵原样交回去,后端把真值合并回去),填了才换。
 * 这不是这一页的发明,是 `mcp` 域契约写明的护栏。
 *
 * ── 写路都经 `mcp` 域的方法,不碰整份设置 ────────────────────────────────
 * 增删改 / 连断 / 登出各一条,后端那一侧「写设置 + 改连接 + 重建工具目录」一次做完。
 * 每条写路成功后 `invalidate()` 对账(律①:就地更新,后台补拉,不清屏)。
 */

export type ConnectorStatus = MCPConnectionStatus

export interface ConnectorRow {
  readonly id: string
  readonly name: string
  readonly transport: MCPTransportType
  readonly enabled: boolean
  readonly status: ConnectorStatus
  readonly error?: string
  readonly toolCount: number
  /** http / sse 的地址(stdio 没有;壳看得见它,它不是私密键)。 */
  readonly url?: string
  /** OAuth:要登录(带授权地址)或已授权。 */
  readonly oauth?: { status: 'required' | 'authorized'; authorizationUrl?: string }
  /** 原样的配置,编辑与改开关时当底本(私密格是哨兵)。 */
  readonly config: MCPServerConfig
}

/** 线上形状 → 屏幕形状,按名字排(名字相同按 id,顺序稳定)。 */
export function toConnectorRows(states: readonly MCPServerState[]): ConnectorRow[] {
  return states
    .map((state): ConnectorRow => ({
      id: state.config.id,
      name: state.config.name || state.config.id,
      transport: state.config.transport,
      enabled: state.config.enabled,
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
      toolCount: state.tools?.length ?? 0,
      ...(state.config.url ? { url: state.config.url } : {}),
      ...(state.oauth ? { oauth: state.oauth } : {}),
      config: state.config,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export const connectorsQuery = createQuery<ConnectorRow[]>('mcpConnectors', async () => {
  const port = await mcpConnectorsPort()
  await port.ready()
  const response = await port.getServers()
  // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并留住上一份(律②)。
  if (!response.success) throw new Error(response.error || t('connectors.loadFailed'))
  return toConnectorRows(response.servers ?? [])
})

/** 有没有一行还在路上(连接中)—— 页面据此决定要不要轮询。 */
export function connectorsStillSettling(rows: readonly ConnectorRow[] | undefined): boolean {
  return (rows ?? []).some((row) => row.status === 'connecting')
}

function failed(error: string | undefined, fallback: MessageKey): never {
  throw new Error(error || t(fallback))
}

/** 开 / 关一行。乐观翻开关,后端按新配置连或断。 */
export const setConnectorEnabledMutation = createMutation<{ id: string; enabled: boolean }, void>(
  'mcpConnectors.setEnabled',
  {
    key: (input) => input.id,
    optimistic: (input) =>
      connectorsQuery.patch((prev) =>
        prev?.map((row) => (row.id === input.id ? { ...row, enabled: input.enabled } : row)),
      ),
    run: async (input) => {
      const row = connectorsQuery.get().data?.find((item) => item.id === input.id)
      if (!row) return
      const port = await mcpConnectorsPort()
      const response = await port.updateServer({ ...row.config, enabled: input.enabled })
      if (!response.success) failed(response.error, 'connectors.saveFailed')
    },
    settle: () => connectorsQuery.invalidate(),
  },
)

export const reconnectConnectorMutation = createMutation<string, void>('mcpConnectors.reconnect', {
  key: (id) => id,
  optimistic: (id) =>
    connectorsQuery.patch((prev) =>
      prev?.map((row) => (row.id === id ? { ...row, status: 'connecting', error: undefined } : row)),
    ),
  run: async (id) => {
    const port = await mcpConnectorsPort()
    const response = await port.connectServer(id)
    if (!response.success) failed(response.error, 'connectors.connectFailed')
  },
  settle: () => connectorsQuery.invalidate(),
})

export const removeConnectorMutation = createMutation<string, void>('mcpConnectors.remove', {
  key: (id) => id,
  optimistic: (id) => connectorsQuery.patch((prev) => prev?.filter((row) => row.id !== id)),
  run: async (id) => {
    const port = await mcpConnectorsPort()
    const response = await port.removeServer(id)
    if (!response.success) failed(response.error, 'connectors.removeFailed')
  },
  settle: () => connectorsQuery.invalidate(),
})

/** 登出 = 忘掉这一台的 OAuth 凭证;下次连会重新要登录。 */
export const logoutConnectorMutation = createMutation<string, void>('mcpConnectors.logout', {
  key: (id) => id,
  run: async (id) => {
    const port = await mcpConnectorsPort()
    const response = await port.logoutServer(id)
    if (!response.success) failed(response.error, 'connectors.saveFailed')
  },
  settle: () => connectorsQuery.invalidate(),
})

// ── 新建 / 编辑的草稿 ─────────────────────────────────────────────────────

export interface ConnectorDraft {
  /** 编辑已有的那一行时带着它;新建没有。 */
  readonly id?: string
  readonly name: string
  readonly transport: MCPTransportType
  /** stdio:一整行命令(`npx -y some-mcp@latest --flag`),拆法见 `splitCommandLine`。 */
  readonly commandLine: string
  readonly cwd: string
  /** `KEY=VALUE`,一行一条(或分号分隔)。 */
  readonly env: string
  /** http / sse 的地址。 */
  readonly url: string
}

export function emptyConnectorDraft(): ConnectorDraft {
  return { name: '', transport: 'stdio', commandLine: '', cwd: '', env: '', url: '' }
}

/**
 * 从一行现成的配置起草稿。私密格(命令 / 工作目录 / 环境变量)壳看不见 —— 它们在草稿里是**空**
 * 的,屏幕上写「已设置,留空保持原样」;只有 url 原样带出来。
 */
export function draftFromRow(row: ConnectorRow): ConnectorDraft {
  const config = row.config
  const visible = (value: string | undefined) => (value && value !== MCP_SERVER_REDACTED_SECRET ? value : '')
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    commandLine: visible(config.command)
      ? [config.command!, ...(config.args ?? [])].map((word) => quoteWord(word)).join(' ')
      : '',
    cwd: visible(config.cwd),
    env: '',
    url: config.url ?? '',
  }
}

function quoteWord(word: string): string {
  return /[\s"']/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word
}

/**
 * 一行命令拆成 `[command, ...args]`:认双引号与单引号(里面的空格不拆),`\"` 是转义。
 * 不是 shell —— 不展开变量、不认管道;它只回答「这一行写的是哪几个词」。
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasWord = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        current += line[i + 1]
        i += 1
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
    } else if (/\s/.test(ch)) {
      if (hasWord) {
        words.push(current)
        current = ''
        hasWord = false
      }
    } else {
      current += ch
      hasWord = true
    }
  }
  if (hasWord) words.push(current)
  return words
}

/** `KEY=VALUE` 一行一条(换行或分号分隔);没有 `=` 的行忽略。 */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/[\n;]/)) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

export function connectorDraftValidation(draft: ConnectorDraft): MessageKey | undefined {
  if (!draft.name.trim()) return 'connectors.nameRequired'
  if (draft.transport === 'stdio') {
    // 编辑已有的那一行可以留空(保持原样);新建必须给命令。
    if (!draft.id && splitCommandLine(draft.commandLine).length === 0) return 'connectors.commandRequired'
    return undefined
  }
  if (!draft.url.trim()) return 'connectors.urlRequired'
  try {
    const url = new URL(draft.url.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'connectors.urlInvalid'
  } catch {
    return 'connectors.urlInvalid'
  }
  return undefined
}

/**
 * 草稿 → 要交给后端的配置。编辑时以 `existing` 当底本:留空的私密格原样带回哨兵(= 保持),
 * 填了的才换;换接法(stdio ↔ http)时另一边的格清掉。
 */
export function connectorDraftToConfig(draft: ConnectorDraft, existing?: MCPServerConfig): MCPServerConfig {
  const base: MCPServerConfig = {
    id: draft.id ?? existing?.id ?? newConnectorId(),
    name: draft.name.trim(),
    transport: draft.transport,
    enabled: existing?.enabled ?? true,
  }
  if (draft.transport === 'stdio') {
    const words = splitCommandLine(draft.commandLine)
    const keep = words.length === 0 && existing?.transport === 'stdio'
    const env = parseEnvText(draft.env)
    const keepEnv = Object.keys(env).length === 0 && existing?.transport === 'stdio' && existing.env !== undefined
    const cwd = draft.cwd.trim()
    const keepCwd = cwd === '' && existing?.transport === 'stdio' && existing.cwd !== undefined
    return {
      ...base,
      command: keep ? existing!.command : words[0],
      ...(keep ? (existing!.args ? { args: existing!.args } : {}) : { args: words.slice(1) }),
      ...(keepCwd ? { cwd: existing!.cwd } : cwd ? { cwd } : {}),
      ...(keepEnv ? { env: existing!.env } : Object.keys(env).length ? { env } : {}),
    }
  }
  return {
    ...base,
    url: draft.url.trim(),
    ...(existing?.transport === draft.transport && existing.headers ? { headers: existing.headers } : {}),
  }
}

function newConnectorId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `connector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 新建或保存一行。新建走 `addServer`(后端按 `enabled` 当场去连),编辑走 `updateServer`。 */
export const saveConnectorMutation = createMutation<ConnectorDraft, void>('mcpConnectors.save', {
  key: (draft) => draft.id ?? 'new',
  run: async (draft) => {
    const invalid = connectorDraftValidation(draft)
    if (invalid) throw new Error(t(invalid))
    const existing = draft.id ? connectorsQuery.get().data?.find((row) => row.id === draft.id)?.config : undefined
    const config = connectorDraftToConfig(draft, existing)
    const port = await mcpConnectorsPort()
    const response = draft.id ? await port.updateServer(config) : await port.addServer(config)
    if (!response.success) failed(response.error, 'connectors.saveFailed')
  },
  settle: () => connectorsQuery.invalidate(),
})

export function resetConnectorsSettings(): void {
  connectorsQuery.reset()
  setConnectorEnabledMutation.reset()
  reconnectConnectorMutation.reset()
  removeConnectorMutation.reset()
  logoutConnectorMutation.reset()
  saveConnectorMutation.reset()
}
