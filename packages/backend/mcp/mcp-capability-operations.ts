type MaybePromise<T> = T | Promise<T>

export interface ListOnethingMCPToolsResult<TTool = unknown> {
  success: true
  tools: TTool[]
}

export function listOnethingMCPTools<TTool = unknown>(
  options: { getAllTools(): TTool[] },
): ListOnethingMCPToolsResult<TTool> {
  return {
    success: true,
    tools: options.getAllTools(),
  }
}

export interface OnethingMCPToolCallAdapterResult<TContent = unknown> {
  success: boolean
  content?: TContent
  error?: string
  isError?: boolean
}

export interface CallOnethingMCPToolOptions<TArgs = unknown, TContent = unknown> {
  serverId: string
  toolName: string
  args: TArgs
  callTool(
    serverId: string,
    toolName: string,
    args: TArgs,
  ): MaybePromise<OnethingMCPToolCallAdapterResult<TContent>>
}

export interface CallOnethingMCPToolResult<TContent = unknown> {
  success: boolean
  content?: TContent
  error?: string
  isError?: boolean
}

export async function callOnethingMCPTool<TArgs = unknown, TContent = unknown>(
  options: CallOnethingMCPToolOptions<TArgs, TContent>,
): Promise<CallOnethingMCPToolResult<TContent>> {
  const result = await options.callTool(options.serverId, options.toolName, options.args)
  return {
    success: result.success,
    content: result.content,
    error: result.error,
    isError: result.isError,
  }
}

export interface ListOnethingMCPResourcesResult<TResource = unknown> {
  success: true
  resources: TResource[]
}

export function listOnethingMCPResources<TResource = unknown>(
  options: { getAllResources(): TResource[] },
): ListOnethingMCPResourcesResult<TResource> {
  return {
    success: true,
    resources: options.getAllResources(),
  }
}

export interface OnethingMCPReadResourceAdapterResult<TContent = unknown> {
  success: boolean
  content?: TContent
  error?: string
}

export interface ReadOnethingMCPResourceOptions<TContent = unknown> {
  serverId: string
  uri: string
  readResource(
    serverId: string,
    uri: string,
  ): MaybePromise<OnethingMCPReadResourceAdapterResult<TContent>>
}

export interface ReadOnethingMCPResourceResult<TContent = unknown> {
  success: boolean
  content?: TContent
  error?: string
}

export async function readOnethingMCPResource<TContent = unknown>(
  options: ReadOnethingMCPResourceOptions<TContent>,
): Promise<ReadOnethingMCPResourceResult<TContent>> {
  const result = await options.readResource(options.serverId, options.uri)
  return {
    success: result.success,
    content: result.content,
    error: result.error,
  }
}

export interface ListOnethingMCPPromptsResult<TPrompt = unknown> {
  success: true
  prompts: TPrompt[]
}

export function listOnethingMCPPrompts<TPrompt = unknown>(
  options: { getAllPrompts(): TPrompt[] },
): ListOnethingMCPPromptsResult<TPrompt> {
  return {
    success: true,
    prompts: options.getAllPrompts(),
  }
}

export interface OnethingMCPGetPromptAdapterResult<TMessages = unknown> {
  success: boolean
  messages?: TMessages
  error?: string
}

export interface GetOnethingMCPPromptOptions<TArgs = unknown, TMessages = unknown> {
  serverId: string
  name: string
  args: TArgs
  getPrompt(
    serverId: string,
    name: string,
    args: TArgs,
  ): MaybePromise<OnethingMCPGetPromptAdapterResult<TMessages>>
}

export interface GetOnethingMCPPromptResult<TMessages = unknown> {
  success: boolean
  messages?: TMessages
  error?: string
}

export async function getOnethingMCPPrompt<TArgs = unknown, TMessages = unknown>(
  options: GetOnethingMCPPromptOptions<TArgs, TMessages>,
): Promise<GetOnethingMCPPromptResult<TMessages>> {
  const result = await options.getPrompt(options.serverId, options.name, options.args)
  return {
    success: result.success,
    messages: result.messages,
    error: result.error,
  }
}
