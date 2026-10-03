import {
  callOnethingMCPTool,
  getOnethingMCPPrompt,
  listOnethingMCPPrompts,
  listOnethingMCPResources,
  listOnethingMCPTools,
  readOnethingMCPResource,
} from './capability-operations.js'
import {
  addOnethingMCPServer,
  connectOnethingMCPServer,
  disconnectOnethingMCPServer,
  logoutOnethingMCPServer,
  refreshOnethingMCPServer,
  removeOnethingMCPServer,
  updateOnethingMCPServer,
  type OnethingMCPServerConfigLike,
  type OnethingMCPServerManagerLike,
  type OnethingMCPServerStateLike,
  type OnethingMCPSettingsLike,
} from './server-orchestration.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingMCPIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingMCPIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export interface OnethingMCPServerIpcAdapters<
  TConfig extends OnethingMCPServerConfigLike = OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig> = OnethingMCPServerStateLike<TConfig>,
> {
  getSettings(): MaybePromise<OnethingMCPSettingsLike<TConfig>>
  saveSettings(settings: OnethingMCPSettingsLike<TConfig>): MaybePromise<unknown>
  manager: OnethingMCPServerManagerLike<TConfig, TState>
  registerTools(): MaybePromise<unknown>
  logger?: OnethingMCPIpcLogger
}

export async function getOnethingMCPServersForIpc<TState>(
  options: {
    getServerStates(): MaybePromise<TState[]>
    logger?: OnethingMCPIpcLogger
  },
): Promise<OnethingMCPIpcResult<{ servers: TState[] }>> {
  try {
    return {
      success: true,
      servers: await options.getServerStates(),
    }
  } catch (error) {
    return mcpIpcError(options.logger, 'get servers', error, 'Failed to get servers')
  }
}

export async function addOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { config: TConfig },
) {
  try {
    return await addOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'add server', error, 'Failed to add server')
  }
}

export async function updateOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { config: TConfig },
) {
  try {
    return await updateOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'update server', error, 'Failed to update server')
  }
}

export async function removeOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { serverId: string },
) {
  try {
    return await removeOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'remove server', error, 'Failed to remove server')
  }
}

export async function connectOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { serverId: string },
) {
  try {
    return await connectOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'connect server', error, 'Failed to connect server')
  }
}

export async function disconnectOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { serverId: string },
) {
  try {
    return await disconnectOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'disconnect server', error, 'Failed to disconnect server')
  }
}

export async function logoutOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { serverId: string },
) {
  try {
    return await logoutOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'logout server', error, 'Failed to log out of server')
  }
}

/**
 * P2-2 preflight probe: the host injects its probe (electron: the desktop
 * wiring; web server: the stdio-gated ServerMCPClient wiring) so transport
 * policy stays host-owned. Nothing persists — the probe is read-only.
 */
export async function probeOnethingMCPServerForIpc<TConfig extends OnethingMCPServerConfigLike>(
  options: {
    config: TConfig
    probe(config: TConfig): Promise<unknown>
    logger?: OnethingMCPIpcLogger
  },
) {
  try {
    return await options.probe(options.config)
  } catch (error) {
    return mcpIpcError(options.logger, 'probe server', error, 'Failed to probe server')
  }
}

export async function refreshOnethingMCPServerForIpc<
  TConfig extends OnethingMCPServerConfigLike,
  TState extends OnethingMCPServerStateLike<TConfig>,
>(
  options: OnethingMCPServerIpcAdapters<TConfig, TState> & { serverId: string },
) {
  try {
    return await refreshOnethingMCPServer(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'refresh server', error, 'Failed to refresh server')
  }
}

export async function listOnethingMCPToolsForIpc<TTool>(
  options: {
    getAllTools(): TTool[]
    logger?: OnethingMCPIpcLogger
  },
): Promise<OnethingMCPIpcResult<{ tools: TTool[] }>> {
  try {
    return listOnethingMCPTools(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'get tools', error, 'Failed to get tools')
  }
}

export async function callOnethingMCPToolForIpc<TArgs = unknown, TContent = unknown>(
  options: {
    serverId: string
    toolName: string
    args: TArgs
    callTool(
      serverId: string,
      toolName: string,
      args: TArgs,
    ): MaybePromise<{ success: boolean; content?: TContent; error?: string; isError?: boolean }>
    logger?: OnethingMCPIpcLogger
  },
) {
  try {
    return await callOnethingMCPTool(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'call tool', error, 'Failed to call tool')
  }
}

export async function listOnethingMCPResourcesForIpc<TResource>(
  options: {
    getAllResources(): TResource[]
    logger?: OnethingMCPIpcLogger
  },
): Promise<OnethingMCPIpcResult<{ resources: TResource[] }>> {
  try {
    return listOnethingMCPResources(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'get resources', error, 'Failed to get resources')
  }
}

export async function readOnethingMCPResourceForIpc<TContent = unknown>(
  options: {
    serverId: string
    uri: string
    readResource(serverId: string, uri: string): MaybePromise<{ success: boolean; content?: TContent; error?: string }>
    logger?: OnethingMCPIpcLogger
  },
) {
  try {
    return await readOnethingMCPResource(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'read resource', error, 'Failed to read resource')
  }
}

export async function listOnethingMCPPromptsForIpc<TPrompt>(
  options: {
    getAllPrompts(): TPrompt[]
    logger?: OnethingMCPIpcLogger
  },
): Promise<OnethingMCPIpcResult<{ prompts: TPrompt[] }>> {
  try {
    return listOnethingMCPPrompts(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'get prompts', error, 'Failed to get prompts')
  }
}

export async function getOnethingMCPPromptForIpc<TArgs = unknown, TMessages = unknown>(
  options: {
    serverId: string
    name: string
    args: TArgs
    getPrompt(serverId: string, name: string, args: TArgs): MaybePromise<{
      success: boolean
      messages?: TMessages
      error?: string
    }>
    logger?: OnethingMCPIpcLogger
  },
) {
  try {
    return await getOnethingMCPPrompt(options)
  } catch (error) {
    return mcpIpcError(options.logger, 'get prompt', error, 'Failed to get prompt')
  }
}

export async function readOnethingMCPConfigFileForIpc<TContent = unknown>(
  options: {
    filePath: string
    fileExists(filePath: string): MaybePromise<boolean>
    readTextFile(filePath: string): MaybePromise<string>
    parseJson?(content: string): TContent
    logger?: OnethingMCPIpcLogger
  },
): Promise<OnethingMCPIpcResult<{ content: TContent }>> {
  try {
    if (!await options.fileExists(options.filePath)) {
      return { success: false, error: 'File not found' }
    }

    const content = await options.readTextFile(options.filePath)
    return {
      success: true,
      content: options.parseJson ? options.parseJson(content) : JSON.parse(content),
    }
  } catch (error) {
    return mcpIpcError(options.logger, 'read config file', error, 'Failed to read config file')
  }
}

function mcpIpcError(
  logger: OnethingMCPIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[MCP IPC] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
