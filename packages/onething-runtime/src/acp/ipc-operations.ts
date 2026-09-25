import { createCoreId } from '@onething/core/engine'
import { describeAcpAgentConfigProblem, effectiveAgentConfig } from './manifest.js'
import { RETIRED_ACP_AGENT_FIELDS, type ACPAgentConfig, type AcpAgentManifest } from '@shared/contracts/acp.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingACPAgentConfigLike {
  id?: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  unattended?: 'allow' | 'reject' | string
  /** A3-a 之前的名字;读到就照原词搬进 `unattended`,不再写回。 */
  permissionMode?: 'allow' | 'reject' | string
  basedOn?: string
  secretEnv?: string[]
}

export interface OnethingACPSettingsLike<TConfig extends OnethingACPAgentConfigLike = OnethingACPAgentConfigLike> {
  enabled: boolean
  agents: TConfig[]
}

export interface OnethingACPIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface OnethingACPIpcAdapters<
  TConfig extends OnethingACPAgentConfigLike = OnethingACPAgentConfigLike,
  TState = unknown,
> {
  getSettings(): MaybePromise<OnethingACPSettingsLike<TConfig>>
  saveSettings(settings: OnethingACPSettingsLike<TConfig>): MaybePromise<unknown>
  manager: {
    updateSettings(settings: OnethingACPSettingsLike<TConfig>): MaybePromise<unknown>
    getAgentStates(): TState[]
    getAgentState(agentId: string): TState | undefined
    connectAgent(agentId: string): MaybePromise<TState>
    disconnectAgent(agentId: string): MaybePromise<unknown>
    refreshAgent(agentId: string): MaybePromise<TState>
    cancelSession(sessionId: string, agentId?: string): MaybePromise<unknown>
  }
  logger?: OnethingACPIpcLogger
  createId?(): string
  /**
   * 名册里有这台吗(种子 / 注册表来的不在设置里)。有 → `updateAgent` 给它新建一条覆盖,
   * 而不是答「找不到」。缺席 = 只认设置里的条目(A1 之前的行为)。
   */
  isRosterAgent?(agentId: string): boolean
  /** 「复制自」那一台的生效配置;`addAgent` 的 `basedOn` 没写命令时从它补起法。 */
  resolveBasedOn?(agentId: string): { command: string; args?: string[] } | undefined
  /**
   * 种子 / 注册表来的那一台的 manifest(用户自己手加的条目答 undefined)。写这一台的覆盖时,
   * 只存与 manifest 推出来的值**不同**的格(稀疏覆盖,方案 §3.9 ①)。
   */
  rosterManifest?(agentId: string): AcpAgentManifest | undefined
}

export type OnethingACPIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export async function getOnethingACPAgentsForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: Pick<OnethingACPIpcAdapters<TConfig, TState>, 'getSettings' | 'manager' | 'logger'>,
): Promise<OnethingACPIpcResult<{ agents: TState[] }>> {
  try {
    await options.manager.updateSettings(await options.getSettings())
    return { success: true, agents: options.manager.getAgentStates() }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function addOnethingACPAgentForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: OnethingACPIpcAdapters<TConfig, TState> & { config: TConfig },
): Promise<OnethingACPIpcResult<{ agent: TState | undefined }>> {
  try {
    const rosterManifest = options.config.id ? options.rosterManifest?.(options.config.id) : undefined
    if (rosterManifest) {
      // 种子 / 注册表那一台还没有覆盖:存一条稀疏覆盖;已经有了就是重复。
      const problem = describeAcpAgentConfigProblem(options.config as Partial<ACPAgentConfig>)
      if (problem) throw new Error(problem)
      const settings = await options.getSettings()
      if (settings.agents.some(agent => agent.id === rosterManifest.id)) {
        throw new Error(`ACP agent "${rosterManifest.id}" already exists`)
      }
      const override = sparseOnethingACPRosterOverride(options.config, rosterManifest)
      await options.saveSettings({ ...settings, agents: [...settings.agents, override] })
      return { success: true, agent: options.manager.getAgentState(rosterManifest.id) }
    }
    const config = normalizeOnethingACPAgentConfig(options.config, options.createId)
    const problem = describeAcpAgentConfigProblem(config)
    if (problem) throw new Error(problem)
    if (config.basedOn) {
      const base = options.resolveBasedOn?.(config.basedOn)
      if (!base) throw new Error(`ACP agent "${config.basedOn}" not found`)
      // 「复制为自定义」:起法没写就从那一台补,之后这一条与那一台各自独立。
      if (!config.command) {
        config.command = base.command
        if (!options.config.args) config.args = [...(base.args ?? [])]
      }
    }
    if (!config.command) throw new Error('ACP agent command is required')

    const settings = await options.getSettings()
    if (settings.agents.some(agent => agent.id === config.id) || options.isRosterAgent?.(config.id)) {
      throw new Error(`ACP agent "${config.id}" already exists`)
    }

    await options.saveSettings({
      ...settings,
      agents: [...settings.agents, config as TConfig],
    })

    return { success: true, agent: options.manager.getAgentState(config.id) }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function updateOnethingACPAgentForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: OnethingACPIpcAdapters<TConfig, TState> & { config: TConfig },
): Promise<OnethingACPIpcResult<{ agent: TState | undefined }>> {
  try {
    const rosterManifest = options.config.id && options.isRosterAgent?.(options.config.id)
      ? options.rosterManifest?.(options.config.id)
      : undefined
    const config = rosterManifest
      ? sparseOnethingACPRosterOverride(options.config, rosterManifest)
      : normalizeOnethingACPAgentConfig(options.config, options.createId)
    const problem = describeAcpAgentConfigProblem(config as Partial<ACPAgentConfig>)
    if (problem) throw new Error(problem)
    // 种子 / 注册表那一台的覆盖可以不带命令(起法来自 manifest);其余条目没命令起不来。
    if (!rosterManifest && !config.command && !config.basedOn) throw new Error('ACP agent command is required')

    const settings = await options.getSettings()
    const index = settings.agents.findIndex(agent => agent.id === config.id)
    const agents = settings.agents.slice()
    if (index !== -1) agents[index] = config as TConfig
    // 种子 / 注册表来的那一台第一次被改:新建一条(稀疏)覆盖。
    else if (rosterManifest) agents.push(config as TConfig)
    else throw new Error(`ACP agent "${config.id}" not found`)
    await options.saveSettings({ ...settings, agents })

    return { success: true, agent: options.manager.getAgentState(config.id ?? '') }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function removeOnethingACPAgentForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: OnethingACPIpcAdapters<TConfig, TState> & { agentId: string },
): Promise<OnethingACPIpcResult> {
  try {
    const settings = await options.getSettings()
    await options.manager.disconnectAgent(options.agentId)
    await options.saveSettings({
      ...settings,
      agents: settings.agents.filter(agent => agent.id !== options.agentId),
    })
    return { success: true }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function connectOnethingACPAgentForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: Pick<OnethingACPIpcAdapters<TConfig, TState>, 'getSettings' | 'manager' | 'logger'> & { agentId: string },
): Promise<OnethingACPIpcResult<{ agent: TState }>> {
  try {
    await options.manager.updateSettings(await options.getSettings())
    const agent = await options.manager.connectAgent(options.agentId)
    return { success: true, agent }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function disconnectOnethingACPAgentForIpc(
  options: {
    agentId: string
    disconnectAgent(agentId: string): MaybePromise<unknown>
    logger?: OnethingACPIpcLogger
  },
): Promise<OnethingACPIpcResult> {
  try {
    await options.disconnectAgent(options.agentId)
    return { success: true }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function refreshOnethingACPAgentForIpc<
  TConfig extends OnethingACPAgentConfigLike,
  TState,
>(
  options: Pick<OnethingACPIpcAdapters<TConfig, TState>, 'getSettings' | 'manager' | 'logger'> & { agentId: string },
): Promise<OnethingACPIpcResult<{ agent: TState }>> {
  try {
    await options.manager.updateSettings(await options.getSettings())
    const agent = await options.manager.refreshAgent(options.agentId)
    return { success: true, agent }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

export async function cancelOnethingACPSessionForIpc(
  options: {
    sessionId: string
    agentId?: string
    cancelSession(sessionId: string, agentId?: string): MaybePromise<unknown>
    logger?: OnethingACPIpcLogger
  },
): Promise<OnethingACPIpcResult> {
  try {
    await options.cancelSession(options.sessionId, options.agentId)
    return { success: true }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

/**
 * 切会话模式(A2-b,`session/set_mode`)的信封:没给 `modeId` 答结构化失败,不去碰 agent;
 * 成功答切完之后的状态表(没有就 `null`)。
 */
export async function setOnethingACPSessionModeForIpc<TState>(
  options: {
    sessionId: string
    modeId: string
    agentId?: string
    setSessionMode(sessionId: string, modeId: string, agentId?: string): MaybePromise<TState | undefined>
    logger?: OnethingACPIpcLogger
  },
): Promise<OnethingACPIpcResult<{ state: TState | null }>> {
  if (!options.modeId) return { success: false, error: 'modeId is required' }
  try {
    const state = await options.setSessionMode(options.sessionId, options.modeId, options.agentId)
    return { success: true, state: state ?? null }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

/**
 * 名册类读动作(A1-a:`acp.detect` / `acp.refreshRegistry`)的投影:跑完答整张名册,
 * 抛错答 `{ success: false, error }`。探测 / 联网本身在装配层(名册住那里),这里只管信封。
 */
export async function runOnethingACPRosterOperationForIpc<TState>(
  options: { run(): MaybePromise<TState[]>; logger?: OnethingACPIpcLogger },
): Promise<OnethingACPIpcResult<{ agents: TState[] }>> {
  try {
    return { success: true, agents: await options.run() }
  } catch (error) {
    return acpIpcError(options.logger, error)
  }
}

/** 与 manifest 推出来的值相等就不存的格(它们在覆盖里出现,多半是壳把整份生效配置回显了)。 */
const ROSTER_DERIVED_FIELDS = ['name', 'description', 'command', 'args', 'env', 'unattended'] as const

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 种子 / 注册表那一台的**稀疏覆盖**(A1-a,方案 §3.9 ①「只存改过的字段」)。
 *
 * 为什么非稀疏不可:壳改一台种子 agent 时回显的是整份生效配置。整份存下来,它的 id / 命令 /
 * 参数与种子逐字相等,名册就会把它当成 A1 之前写回老盘的拷贝丢掉 —— 用户点的「启用」随之
 * 静默消失;命令空着时归一还会合成一个 `'ACP Agent'` 的名字盖掉种子的名字。
 *
 * 规则:`id` 永远留;`enabled` 只在调用方显式给了布尔值时留;`name` / `description` /
 * `command` / `args` / `env` / `unattended` 与 `effectiveAgentConfig(manifest)` 推出来的值
 * 相等(空串、空数组、空对象、`unattended: 'reject'` 分别等同于缺席 / 缺省)就丢;`hostTools: true` /
 * `forwardMcpServers: false`(A4-b 两格的缺省)也丢;其余
 * 带着的格(`secretEnv` / 各种超时 / `cwd` …)原样留。老名 `permissionMode` 先搬成 `unattended`。
 */
export function sparseOnethingACPRosterOverride<TConfig extends OnethingACPAgentConfigLike>(
  config: TConfig,
  manifest: AcpAgentManifest,
): TConfig {
  const derived = effectiveAgentConfig(manifest) as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { id: manifest.id }
  for (const [key, raw] of Object.entries(migrateLegacyUnattended(config))) {
    if (key === 'id' || raw === undefined) continue
    // A3-b 退役的四格(壳可能还回显着):不存。
    if ((RETIRED_ACP_AGENT_FIELDS as readonly string[]).includes(key)) continue
    if (key === 'enabled') {
      if (typeof raw === 'boolean') out.enabled = raw
      continue
    }
    // A4-b 两格的缺省(给宿主工具 / 不透传名册)等同于缺席:壳回显整份时不把缺省值写成覆盖。
    if (key === 'hostTools') {
      if (raw === false) out.hostTools = false
      continue
    }
    if (key === 'forwardMcpServers') {
      if (raw === true) out.forwardMcpServers = true
      continue
    }
    if ((ROSTER_DERIVED_FIELDS as readonly string[]).includes(key)) {
      let value: unknown = typeof raw === 'string' ? raw.trim() : raw
      let base: unknown = derived[key]
      if (key === 'args') base = base ?? []
      if (key === 'env' && value && typeof value === 'object' && Object.keys(value).length === 0) value = undefined
      if (key === 'unattended') base = base ?? 'reject'
      if (value === '' || value === undefined || sameJson(value, base)) continue
      out[key] = value
      continue
    }
    out[key] = raw
  }
  return out as TConfig
}

export function normalizeOnethingACPAgentConfig<TConfig extends OnethingACPAgentConfigLike>(
  config: TConfig,
  createId = createOnethingACPAgentId,
): TConfig & {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  unattended: 'allow' | 'reject'
} {
  const command = config.command?.trim() || ''
  const migrated = migrateLegacyUnattended(config)
  return {
    ...migrated,
    id: config.id || createId(),
    name: config.name?.trim() || command || 'ACP Agent',
    command,
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env && typeof config.env === 'object' ? config.env : undefined,
    enabled: config.enabled !== false,
    unattended: migrated.unattended === 'allow' ? 'allow' : 'reject',
  }
}

/**
 * A3-a 改名:`permissionMode` → `unattended`,原词照搬(两个都在时新名胜);老名删掉不再写回。
 * 缺席仍是缺席 —— 缺省拒由读的一方(`ACPClient`)兜。
 */
function migrateLegacyUnattended<TConfig extends OnethingACPAgentConfigLike>(config: TConfig): TConfig {
  if (!('permissionMode' in config)) return config
  const { permissionMode, ...rest } = config
  const unattended = rest.unattended ?? permissionMode
  return (unattended === undefined ? rest : { ...rest, unattended }) as TConfig
}

function createOnethingACPAgentId(): string {
  return `acp-${createCoreId()}`
}

function acpIpcError(
  logger: OnethingACPIpcLogger | undefined,
  error: unknown,
): { success: false; error: string } {
  logger?.error?.('[ACP IPC] Operation failed:', error)
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
