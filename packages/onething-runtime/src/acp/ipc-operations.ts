import { createCoreId } from '@onething/core/engine'

type MaybePromise<T> = T | Promise<T>

export interface OnethingACPAgentConfigLike {
  id?: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  permissionMode?: 'allow' | 'reject' | string
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
    options.manager.updateSettings(await options.getSettings())
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
    const config = normalizeOnethingACPAgentConfig(options.config, options.createId)
    if (!config.command) throw new Error('ACP agent command is required')

    const settings = await options.getSettings()
    if (settings.agents.some(agent => agent.id === config.id)) {
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
    const config = normalizeOnethingACPAgentConfig(options.config, options.createId)
    if (!config.command) throw new Error('ACP agent command is required')

    const settings = await options.getSettings()
    const index = settings.agents.findIndex(agent => agent.id === config.id)
    if (index === -1) throw new Error(`ACP agent "${config.id}" not found`)

    const agents = settings.agents.slice()
    agents[index] = config as TConfig
    await options.saveSettings({ ...settings, agents })

    return { success: true, agent: options.manager.getAgentState(config.id) }
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
    options.manager.updateSettings(await options.getSettings())
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
    options.manager.updateSettings(await options.getSettings())
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

export function normalizeOnethingACPAgentConfig<TConfig extends OnethingACPAgentConfigLike>(
  config: TConfig,
  createId = createOnethingACPAgentId,
): TConfig & {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  permissionMode: 'allow' | 'reject'
} {
  const command = config.command?.trim() || ''
  return {
    ...config,
    id: config.id || createId(),
    name: config.name?.trim() || command || 'ACP Agent',
    command,
    args: Array.isArray(config.args) ? config.args : [],
    env: config.env && typeof config.env === 'object' ? config.env : undefined,
    enabled: config.enabled !== false,
    permissionMode: config.permissionMode === 'reject' ? 'reject' : 'allow',
  }
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
