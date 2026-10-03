/**
 * ACP agent 配置与会话选项的形状(A0-3:只此一份)。
 *
 * 产品层 `runtime/acp/types.ts` 与契约层 `shared/ipc/acp.ts` 都 `import type` 这里:
 * 契约层不许依赖产品层;立这份文件时产品层(非 `*.wiring.ts`)还不许 import `@shared/ipc`,
 * 两边都够得着、又不反向依赖的只有 `@shared/contracts`(那条规则已随第③步拍平撤掉,形状留在这里)。
 */
import type { JsonObject } from '../json.js'

/**
 * 无人应答(没有权限桥、没有人看卡)时,agent 的审批怎么答(A3-a,方案 §3.5 / §8 拍点 2)。
 * 缺省 `'reject'`;`'allow'` 只能由用户显式打开,而且只答 `allow_once`,永不自动选 `allow_always`。
 */
export type ACPUnattendedPolicy = 'reject' | 'allow'
/** @deprecated A3-a 起改名 `ACPUnattendedPolicy`;留一个别名给还没改名的调用方。 */
export type ACPPermissionMode = ACPUnattendedPolicy

export interface ACPAgentConfig {
  id: string
  name: string
  description?: string
  enabled: boolean
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  model?: string
  /**
   * 无人应答时怎么答 agent 的审批;缺省 = `'reject'`。A3-a 之前叫 `permissionMode`(缺省 allow),
   * 老值由 `normalizeACPSettings` 一次性照搬过来。
   */
  unattended?: ACPUnattendedPolicy
  // A3-b 删了 `allowFileSystemAccess` / `allowTerminalAccess`(文件与终端改走 onething 的沙箱、
  // 许可与 TerminalService,能力固定声明)与 `maxTerminals` / `maxTerminalOutputBytes`(变成终端桥
  // 里的常量);老盘上的这四格由 `normalizeACPSettings` 摘掉。
  // A4-b 删了 `mcpServers`(一份原样透传给 `session/new` 的 JSON):agent 拿到的 MCP 名册改由
  // 宿主现组 —— `onething` 那一条(宿主工具面)+ 按 `forwardMcpServers` 透传的用户名册。
  /**
   * 给不给这台 agent 宿主工具面(`mcpServers` 里的 `onething` 那一条,A4-b,方案 §3.6)。
   * 缺省 = 给(`true`);`false` 只剩下透传的用户名册。
   */
  hostTools?: boolean
  /**
   * 把用户自己的 MCP 名册(`settings.mcp.servers` 里启用的)也递给这台 agent(A4-b)。
   * 缺省 = 不递(`false`):用户名册里的凭据不该默认流进一台外部 agent。
   */
  forwardMcpServers?: boolean
  connectTimeoutMs?: number
  promptTimeoutMs?: number
  idleTimeoutMs?: number
  maxBufferedUpdates?: number
  maxSessionRecords?: number
  /**
   * 自定义条目「复制自」哪一台(种子 / 注册表 id,A1-a,方案 §3.9)。有它时 manifest 从那一台
   * 继承,本条只写改过的格;id 仍是自己的。只收 `[a-z0-9-]`。
   */
  basedOn?: string
  /**
   * 要当密钥处理的环境变量**键名**(A1-a 只加字段与校验;值在凭证池 `acp:<id>:<KEY>`,接入归 A3)。
   * 只收 `[A-Za-z_][A-Za-z0-9_]*`。
   */
  secretEnv?: string[]
  /**
   * 从 manifest 带下来的怪癖里,**连接**要读的那几格(A2-a)。它不是用户能改的覆盖 —— 只由
   * `effectiveAgentConfig` 从种子 / 注册表那一条抄过来,于是 `ACPManager` / 客户端(只见得到
   * 配置、见不到名册)也知道「这台 agent 的 persona 走 `session/new._meta`」。
   */
  quirks?: { systemPromptMeta?: 'claude-agent-acp' }
}

/**
 * 退役的格:A3-b 四格,A4-b 的 `mcpServers`(改由宿主现组,见 `hostTools` / `forwardMcpServers`)。
 * 老盘上 / 壳回显里还可能带着,读的一方(`normalizeACPSettings`、稀疏覆盖)见到就摘,不再写回。
 */
export const RETIRED_ACP_AGENT_FIELDS = [
  'allowFileSystemAccess',
  'allowTerminalAccess',
  'maxTerminals',
  'maxTerminalOutputBytes',
  'mcpServers',
] as const

/**
 * 整个 ACP 设置段(`settings.acp`)。A1-a 从 runtime / `@shared/ipc` 两份合到这里。
 *
 * `agents` 只放**用户手加 / 覆盖**的条目 —— 内置条目来自种子文件
 * (`resources/acp-agents/*.json`),注册表条目来自 ACP 官方清单,二者都不落这张表。
 */
export interface ACPSettings {
  enabled: boolean
  agents: ACPAgentConfig[]
  /** 官方注册表开关。缺省 = 开;`enabled: false` 就不联网,只用种子与已有缓存。 */
  registry?: { enabled?: boolean }
}

// ── 名册(A1-a,方案 `docs/design/acp-integration-2026-09.md` §3.2)──────────────

/** 名册里一行的来处:种子文件 / 官方注册表 / 用户手加。 */
export type AcpAgentSource = 'builtin' | 'registry' | 'user'

/**
 * 一台 agent 的**自述**。数据文件在 `resources/acp-agents/<id>.json`,或由注册表条目折出来;
 * 校验在 `runtime/acp/manifest.ts` 的 `parseAcpAgentManifest`。
 * core / runtime / backend 里没有任何一处写死某一台 agent —— 加一台 = 加一个 JSON 文件。
 */
export interface AcpAgentManifest {
  /** 仅 `[a-z0-9-]`。 */
  id: string
  /** 给人看的名字(产品名)。 */
  name: string
  description?: string
  /** 'Anthropic' / 'OpenAI' / …,只用于分组显示。 */
  vendor?: string
  /** 壳侧图标 key 或 URL;没有就用首字母。 */
  icon?: string
  homepage?: string
  /**
   * 怎么起进程。种子文件必填;注册表里 `binary` / `uvx` 形(A1 不自动下载)的条目没有这一格,
   * 这种条目上榜只为让人看见「有它、怎么装」,不喂给进程管家。
   */
  launch?: {
    command: string
    args?: string[]
    env?: Record<string, string>
  }
  /** 装了没有?探测器只读这一格,不猜。缺 `bins` = 用 `launch.command`。 */
  detect?: {
    bins?: string[]
    /** 拿一行版本号的参数,例如 `['--version']`。缺席 = 不跑它,只看在不在 PATH 上。 */
    versionArgs?: string[]
    minVersion?: string
  }
  install?: {
    /** npm 包名(不带版本号)→ 装法 `npm i -g <pkg>`。 */
    npm?: string
    /** 一句人话或一个链接(装 CLI 本体去哪)。 */
    hint?: string
  }
  /** 「还没登怎么办」的一句话;真正的登录按协议走(§3.5)。 */
  auth?: { hint?: string; loginCommand?: string[] }
  /** 它自己的配置文件 / 目录(§3.9 ⑥)。只用来画「打开配置目录」,onething 不读不写。 */
  configPaths?: string[]
  /** 已知的怪癖,不是能力声明(能力由 `initialize` 握手自报)。 */
  quirks?: {
    promptTimeoutMs?: number
    systemPromptMeta?: 'claude-agent-acp'
  }
  /** 社区 MVP / 协议支持不全的,壳上标「实验」。 */
  experimental?: boolean
  /**
   * 它在官方注册表里叫什么(种子 id 与注册表 id 不同名时填,例如 `claude-code` ↔ `claude-acp`)。
   * 合并时注册表里这一条被种子吃掉,名册里不出现两台同一个 agent。
   */
  registryId?: string
  /**
   * 旧 id(一次性迁移用,例如 `codex` 的旧名 `codex-cli`)。用户覆盖条目与会话里的旧 id 按它
   * 认回这一台;数据写在种子里,代码里不出现任何一个具体的旧名。
   */
  aliases?: string[]
}

/** 探测结果(`detect.ts`)。只在 `refresh()` / RPC `acp.detect` 时刷新,不轮询。 */
export interface AcpAgentDetect {
  installed: boolean
  /** 找到的可执行的绝对路径。 */
  path?: string
  version?: string
  /** 版本低于 manifest 的 `detect.minVersion`。 */
  belowMin?: boolean
  checkedAt: number
}

/**
 * 一台 agent 在**它自己的会话里**自述的一格可调选项(ACP `configOptions`:模型 / 模式 /
 * 思考档……)。onething 不认识「模型」这件事 —— agent 列什么就画什么,选中后原样经
 * `session/set_config_option` 交回去。只收 `select` 那一种;分组的选项在投影时拍平,
 * 组名落进 `group`。
 */
export interface ACPSessionOptionChoice {
  value: string
  name: string
  description?: string
  group?: string
}

export interface ACPSessionOption {
  id: string
  name: string
  /**
   * 缺席 = `select`(A0-3 之前的形状只有这一种,旧读者不必改)。`boolean` 只出现在会话状态
   * (`AcpSessionState.configOptions`)里:`currentValue` 是 `'true'` / `'false'`,`choices` 恒为这两格。
   */
  type?: 'select' | 'boolean'
  description?: string
  /** ACP 的 `category`:`model` / `mode` / `thought_level` / 扩展值。只是提示,不是判据。 */
  category?: string
  currentValue: string
  choices: ACPSessionOptionChoice[]
}

export type ACPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** agent 自报的一种登录方法。`terminal` = onething 开一格终端跑那台 agent 自己的登录程序;`agent` = 调 `authenticate`。 */
export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
  type: 'terminal' | 'agent'
}

/**
 * 崩溃后自动重连的退避(A5,方案 §3.7):agent 进程意外没了之后,下一次要用它时自动重连;
 * 30s 窗内至多 3 次,第 4 次被拒并锁上(`latched`),直到用户在 Agent 页点「重新连接」
 * (`acp.reconnectAgent`,或手动 `connectAgent` / `refreshAgent`)。
 * `attempts` = 窗内已经重连过几次;`until` = 窗内最早那一次过期的时刻(ms),锁上时缺席。
 * 没重连过、也没锁 = 整格缺席。
 */
export interface AcpReconnectBackoff {
  attempts: number
  until?: number
  latched: boolean
}

export interface AcpAgentAuth {
  methods: AcpAuthMethod[]
  required: boolean
  /** agent 经 `_auth/status_update` 推来的原话(例如「not logged in」);没推过为缺席。 */
  label?: string
}

/**
 * 一台 agent 的连接状态投影(`acp.getAgents` 的行,也是全局事件 `acp:agent-state` 的载荷)。
 * A0-2 从 runtime / `@shared/ipc` 两份合到这里,理由同上:全局事件的类型住 `@shared/events`,
 * 它够不着产品层。
 */
export interface ACPAgentState {
  config: ACPAgentConfig
  status: ACPConnectionStatus
  error?: string
  connectedAt?: number
  lastUsedAt?: number
  pid?: number
  protocolVersion?: number
  agentInfo?: {
    name?: string
    version?: string
  }
  /**
   * agent 在 `initialize` 里自报的 `agentCapabilities`,原样交出(A0-4,方案 §6)。
   * 契约层不 import ACP SDK,于是按 JSON 收;读的人要逐字比对或按键取值,不需要 SDK 的类型。
   * 未连过 = 缺席。
   */
  capabilities?: JsonObject
  /**
   * `InitializeResponse` 顶层的 `_meta`(`agentCapabilities` 的兄弟格)原样交出(A6-a)。扩展自报住在
   * 这里而不在能力表里 —— 例如 claude-agent-acp / codex-acp 的 `steering.supported`(`_session/steering`)。
   * agent 没带 = 缺席。
   */
  handshakeMeta?: JsonObject
  sessionCount: number
  activePromptCount: number
  /** 崩溃重连的退避(A5);没重连过也没锁 = 缺席。 */
  backoff?: AcpReconnectBackoff
  /**
   * 登录(A3-c,方案 §3.5 / §3.9 ②):agent 在 `initialize` 里自报的 `authMethods`,加上
   * 「此刻要不要登录」。`required` 由 agent 以 `-32000 auth_required` 拒掉开会话 / 一轮,或
   * `_auth/status_update` 推「没登录」置上;一轮成功、`acp.authenticate` 成功(终端型 = 那条
   * 登录程序退出码 0)时清掉。没连过、也没被拒过 = 缺席。
   */
  auth?: AcpAgentAuth
  /**
   * 名册那一半(A1-a):这台 agent 的自述、来处与探测结果。进程管家(`ACPManager` / `ACPClient`)
   * 不认识名册,它产出的状态没有这三格;由装配层(`AcpSubsystem`)在 RPC 与全局事件出口处补上,
   * 所以在类型上是可缺的 —— 经 `acp.getAgents` / `acp:agent-state` 到壳的行一定带着。
   */
  manifest?: AcpAgentManifest
  source?: AcpAgentSource
  detect?: AcpAgentDetect
}

// ── 会话级状态(A0-2,方案 `docs/design/acp-integration-2026-09.md` §3.3)──────────

export interface AcpSessionMode {
  id: string
  name: string
  description?: string
}

export interface AcpSessionCommand {
  name: string
  description: string
  inputHint?: string
}

export interface AcpPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * agent 的计划。`planId` 是 §3.3 形状之外多出的一格:`plan_removed` 带着 id 来,
 * 不记 id 就分不清它删的是不是眼前这一份。旧式整份 `plan` 没有 id,于是缺席。
 */
export type AcpSessionPlan =
  | { kind: 'items'; planId?: string; entries: AcpPlanEntry[] }
  | { kind: 'markdown'; planId?: string; markdown: string }
  | { kind: 'file'; planId?: string; path: string }

export interface AcpSessionNotice {
  severity: 'info' | 'warning' | 'error'
  title: string
  description?: string
  at: number
}

export interface AcpSessionProcess {
  status: ACPConnectionStatus
  error?: string
  pid?: number
  /** 同 `ACPAgentState.backoff`(A5):承载这条会话的进程此刻的重连退避。 */
  backoff?: AcpReconnectBackoff
}

/**
 * agent 那边的一条会话(A5,协议 `session/list` 的 `SessionInfo`)。`adoptedSessionId` =
 * 它已经对应着的本地会话(链接表里有、本地会话也还在);没有 = 还没认领过。
 */
export interface AcpRemoteSessionInfo {
  acpSessionId: string
  cwd: string
  title?: string
  updatedAt?: string
  adoptedSessionId?: string
}

/**
 * 一条 ACP 会话**此刻的状态**:与哪条消息无关、agent 可以在没有 prompt 在飞时推来的那些
 * (模式 / 可用命令 / 选项 / 计划 / 用量 / 标题 / 通知 / 压缩),加上承载它的进程。
 * 回合里说了什么(文本 / 思考 / 工具)不在这里,那是回合事件流。
 *
 * 形状住契约层:产品层的 reducer(`runtime/acp/session-state.ts`)产出它,
 * 全局事件 `acp:session-state` 与 RPC `acp.sessionState` 原样交出它。
 */
export interface AcpSessionState {
  localSessionId: string
  agentId: string
  acpSessionId?: string
  modes?: { current: string; available: AcpSessionMode[] }
  configOptions: ACPSessionOption[]
  commands: AcpSessionCommand[]
  plan?: AcpSessionPlan
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } }
  info?: { title?: string; updatedAt?: string }
  /** 最近 20 条,新的在后。 */
  notices: AcpSessionNotice[]
  compaction?: { status: 'in_progress' | 'done'; startedAt: number }
  process: AcpSessionProcess
}
