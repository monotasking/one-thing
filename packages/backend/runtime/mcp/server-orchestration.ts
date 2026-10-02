import { createCoreId } from '@onething/backend/core/engine'

type MaybePromise<T> = T | Promise<T>

export interface OnethingMCPServerConfigLike {
  id?: string
  enabled?: boolean
}

export interface OnethingMCPSettingsLike<TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike> {
  enabled: boolean
  servers: TConfig[]
}

export interface OnethingMCPServerStateLike<TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike> {
  config: TConfig
  status: string
  error?: string
  tools: unknown[]
  resources: unknown[]
  prompts: unknown[]
}

export interface OnethingMCPServerManagerLike<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> {
  connectServer(config: TConfig): MaybePromise<unknown>
  disconnectServer(serverId: string): MaybePromise<unknown>
  refreshServer(serverId: string): MaybePromise<unknown>
  removeServer(serverId: string): MaybePromise<unknown>
  updateSettings(settings: OnethingMCPSettingsLike<TConfig>): MaybePromise<unknown>
  getServerState(serverId: string): TState | undefined
}

export interface OnethingMCPServerOrchestrationAdapters<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> {
  getSettings(): MaybePromise<OnethingMCPSettingsLike<TConfig>>
  saveSettings(settings: OnethingMCPSettingsLike<TConfig>): MaybePromise<unknown>
  manager: OnethingMCPServerManagerLike<TConfig, TState>
  registerTools(): MaybePromise<unknown>
  createId?(): string
  /**
   * Forget the OAuth credentials a server authenticated with (issuer-keyed).
   * Optional — hosts without the OAuth flow manager simply omit logout.
   */
  logoutOAuth?(serverId: string): MaybePromise<unknown>
}

export interface AddOnethingMCPServerOptions<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> extends OnethingMCPServerOrchestrationAdapters<TConfig, TState> {
  config: TConfig
}

export interface UpdateOnethingMCPServerOptions<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> extends OnethingMCPServerOrchestrationAdapters<TConfig, TState> {
  config: TConfig
}

export interface ServerIdOnethingMCPServerOptions<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> extends OnethingMCPServerOrchestrationAdapters<TConfig, TState> {
  serverId: string
}

export interface OnethingMCPServerMutationResult<TState = unknown> {
  success: boolean
  server?: TState
  error?: string
}

export interface OnethingMCPSimpleMutationResult {
  success: boolean
  error?: string
}

export function createDisconnectedOnethingMCPServerState<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(config: TConfig): TState {
  return {
    config,
    status: 'disconnected',
    tools: [],
    resources: [],
    prompts: [],
  } as unknown as TState
}

export function cloneOnethingMCPServerState<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(state: TState): TState {
  return JSON.parse(JSON.stringify(state)) as TState
}

export async function addOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: AddOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPServerMutationResult<TState>> {
  const config = withMCPServerId(options.config, options.createId)
  const settings = await options.getSettings()
  await options.saveSettings({
    ...settings,
    servers: [...settings.servers, config],
  })

  if (config.enabled) {
    await options.manager.connectServer(config)
    await options.registerTools()
  }

  const serverState = options.manager.getServerState(config.id)
  return {
    success: true,
    server: serverState
      ? cloneOnethingMCPServerState(serverState)
      : createDisconnectedOnethingMCPServerState<TConfig, TState>(config),
  }
}

export async function updateOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: UpdateOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPServerMutationResult<TState>> {
  const settings = await options.getSettings()
  const index = settings.servers.findIndex(server => server.id === options.config.id)

  if (index === -1) {
    return { success: false, error: 'Server not found' }
  }

  const servers = settings.servers.slice()
  servers[index] = options.config
  const nextSettings = { ...settings, servers }
  await options.saveSettings(nextSettings)
  await options.manager.updateSettings(nextSettings)
  await options.registerTools()

  return {
    success: true,
    server: options.manager.getServerState(options.config.id || ''),
  }
}

export async function removeOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: ServerIdOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPSimpleMutationResult> {
  await options.manager.removeServer(options.serverId)
  const settings = await options.getSettings()
  await options.saveSettings({
    ...settings,
    servers: settings.servers.filter(server => server.id !== options.serverId),
  })
  await options.registerTools()
  return { success: true }
}

export async function connectOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: ServerIdOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPServerMutationResult<TState>> {
  const settings = await options.getSettings()
  const config = settings.servers.find(server => server.id === options.serverId)

  if (!config) {
    return { success: false, error: 'Server not found' }
  }

  await options.manager.connectServer(config)
  await options.registerTools()

  // connectServer swallows connection errors so one bad server cannot break
  // startup for the rest — which meant an explicit "connect" click always
  // reported success and the real reason (bad command, 401, timeout) only
  // reached the main-process log. Read it back off the resulting state.
  const server = options.manager.getServerState(options.serverId)
  if (server?.status === 'error') {
    return {
      success: false,
      error: server.error || 'Failed to connect server',
      server,
    }
  }

  return { success: true, server }
}

export async function disconnectOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: ServerIdOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPSimpleMutationResult> {
  await options.manager.disconnectServer(options.serverId)
  await options.registerTools()
  return { success: true }
}

/**
 * "重新授权": drop the OAuth credentials for this server's issuer, then
 * disconnect. The next connect runs a fresh authorization flow from scratch.
 */
export async function logoutOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: ServerIdOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPSimpleMutationResult> {
  await options.logoutOAuth?.(options.serverId)
  await options.manager.disconnectServer(options.serverId)
  await options.registerTools()
  return { success: true }
}

export async function refreshOnethingMCPServer<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: ServerIdOnethingMCPServerOptions<TConfig, TState>,
): Promise<OnethingMCPServerMutationResult<TState>> {
  await options.manager.refreshServer(options.serverId)
  await options.registerTools()

  return {
    success: true,
    server: options.manager.getServerState(options.serverId),
  }
}

function withMCPServerId<TConfig extends OnethingMCPServerConfigLike>(
  config: TConfig,
  createId = createCoreId,
): TConfig & { id: string } {
  if (config.id) return config as TConfig & { id: string }
  return {
    ...config,
    id: createId(),
  }
}
