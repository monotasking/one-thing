import type {
  JsonSchemaObject,
  JsonValue,
} from '@onething/core'
import type {
  CorePromptActiveProject,
  CorePromptKnownProjects,
} from '@onething/core/engine'

export interface CoreSnapshotSkillFile {
  name: string
  path: string
  type: 'markdown' | 'script' | 'template' | 'other'
}

export type CoreSnapshotSkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'custom'
export type CoreSnapshotToolRenderKind = 'text' | 'bash' | 'diff' | 'file' | 'search' | 'image' | 'custom'

export interface CoreSnapshotSkillConditions {
  fallbackForToolsets?: string[]
  requiresToolsets?: string[]
  fallbackForTools?: string[]
  requiresTools?: string[]
}

export interface CoreSnapshotSkillDefinition {
  id: string
  name: string
  description: string
  source: CoreSnapshotSkillSource
  category?: string
  tags?: string[]
  relatedSkills?: string[]
  conditions?: CoreSnapshotSkillConditions
  disableModelInvocation?: boolean
  platforms?: string[]
  path: string
  directoryPath: string
  rootPath?: string
  relativePath?: string
  enabled: boolean
  allowedTools?: string[]
  instructions: string
  runtimeContext?: string
  files?: CoreSnapshotSkillFile[]
}

export interface CoreSnapshotToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  required?: boolean
  enum?: string[]
  default?: JsonValue
}

export interface CoreSnapshotToolDefinition {
  id: string
  name: string
  description: string
  parameters: CoreSnapshotToolParameter[]
  parameterSchema?: JsonSchemaObject
  enabled: boolean
  autoExecute: boolean
  permissionGuard?: 'safe' | 'sandboxed' | 'internal-check' | 'permission-gated' | 'external'
  executionMode?: 'parallel' | 'sequential'
  renderKind?: CoreSnapshotToolRenderKind
  category: 'builtin' | 'custom'
  source?: 'builtin' | 'plugin' | 'mcp'
  serverId?: string
  serverName?: string
}

export interface CoreSnapshotMCPDefinition {
  description?: string
  parameters?: Array<{
    name: string
    type: string
    description: string
    required?: boolean
    enum?: string[]
  }>
}

export type CoreSnapshotPromptProviderConfigValue = string | number | boolean | null | undefined | object

export interface CoreProviderConfigForPrompt {
  [key: string]: CoreSnapshotPromptProviderConfigValue
}

export interface CoreSystemPromptSnapshotSession {
  agentId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
}

export interface CoreSystemPromptSnapshotAgent {
  id?: string
  name?: string
}

export interface CoreSystemPromptSnapshotProvider<TProviderConfig extends object = object> {
  providerId: string
  model: string
  providerConfig: TProviderConfig
  providerSupported: boolean
  credentialsReady: boolean
}

export interface CoreSystemPromptSnapshotToolSettings {
  enableToolCalls?: boolean
  tools?: Record<string, { enabled?: boolean; autoExecute?: boolean } | undefined>
}

export interface CoreSystemPromptSnapshotSettings {
  skills?: { enableSkills?: boolean }
  tools?: CoreSystemPromptSnapshotToolSettings
}

export interface CoreSystemPromptSnapshotAgentLoopStream {
  enabled: boolean
  enabledBy: 'env' | 'settings' | 'default'
  providerSupported: boolean
  active: boolean
  supportedProviderIds: string[]
}

export interface CoreSystemPromptSnapshotPromptResult {
  systemPrompt: string
}

export interface CoreSystemPromptSnapshotToolInitContext<TSkill> {
  skills: ReturnType<typeof skillForInit>[]
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  providerId: string
  providerConfig: {
    apiKey: string
    baseUrl?: string
    model: string
  }
}

export interface BuildOnethingSystemPromptSnapshotForIpcLogger {
  error?: (...args: unknown[]) => void
}

export type BuildOnethingSystemPromptSnapshotForIpcResult<TSnapshot> =
  | { success: true; snapshot: TSnapshot }
  | { success: false; error: string }

export async function buildOnethingSystemPromptSnapshotForIpc<TSnapshot>(
  options: {
    sessionId: string
    buildSnapshot(sessionId: string): Promise<TSnapshot>
    errorMessage?(error: unknown, fallback: string): string
    logger?: BuildOnethingSystemPromptSnapshotForIpcLogger
  },
): Promise<BuildOnethingSystemPromptSnapshotForIpcResult<TSnapshot>> {
  try {
    return {
      success: true,
      snapshot: await options.buildSnapshot(options.sessionId),
    }
  } catch (error) {
    options.logger?.error?.('[Prompts] Failed to build system prompt snapshot:', error)
    return {
      success: false,
      error: options.errorMessage?.(error, 'Failed to build system prompt snapshot')
        ?? (error instanceof Error && error.message
          ? error.message
          : 'Failed to build system prompt snapshot'),
    }
  }
}

export interface CoreSystemPromptSnapshotBuildPromptInput<TSettings, TSkill> {
  sessionId: string
  agentId?: string
  providerId: string
  providerConfig: Record<string, CoreSnapshotPromptProviderConfigValue>
  settings: TSettings
  hasTools: boolean
  skills: TSkill[]
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  activeProject?: CorePromptActiveProject
  knownProjects?: CorePromptKnownProjects
  toolNames: string[]
  mcpToolNames: string[]
  historyMessages: []
}

type CoreSystemPromptSnapshotToolMap<TSettings extends CoreSystemPromptSnapshotSettings> =
  NonNullable<NonNullable<TSettings['tools']>['tools']>

export interface BuildSystemPromptSnapshotWithAdaptersOptions<
  TSettings extends CoreSystemPromptSnapshotSettings,
  TProviderConfig extends object,
  TTool extends CoreSnapshotToolDefinition,
  TSkill extends CoreSnapshotSkillDefinition,
> {
  sessionId: string
  getSession(sessionId: string): CoreSystemPromptSnapshotSession | undefined
  getSettings(): TSettings
  resolveProvider(settings: TSettings, sessionId: string): Promise<CoreSystemPromptSnapshotProvider<TProviderConfig>>
  resolveAgentLoopStreamRoute(input: {
    providerId: string
    settings: TSettings
  }): CoreSystemPromptSnapshotAgentLoopStream
  getSkills(workingDirectory?: string, agentId?: string): TSkill[]
  initializeTools?(context: CoreSystemPromptSnapshotToolInitContext<TSkill>): Promise<void> | void
  getEnabledTools(toolSettings?: CoreSystemPromptSnapshotToolMap<TSettings>): Promise<TTool[]> | TTool[]
  /** 决策点 #1 hybrid: mode-resolved MCP tool defs (flat array or router). */
  getMCPToolDefinitions(): TTool[]
  sourceToolsToModelDefinitions(tools: TTool[]): Record<string, CoreSnapshotMCPDefinition>
  resolveModelSupportsTools(input: {
    provider: CoreSystemPromptSnapshotProvider<TProviderConfig>
    agentLoopActive: boolean
    workingDirectory?: string
    sessionId: string
  }): Promise<boolean> | boolean
  getNativeProviderTools(input: {
    providerId: string
    providerConfig: TProviderConfig
    toolSettings?: TSettings['tools']
    supportsTools: boolean
  }): Promise<string[]> | string[]
  /**
   * `sessionId` 让宿主把会话解析成 space —— 项目名册批 B4 起 per-space,
   * 快照必须与真回合看同一份名册。宿主可以忽略它。
   */
  buildProjectDirsPromptVars(
    workingDirectory?: string,
    options?: { sessionId?: string },
  ): {
    active?: CorePromptActiveProject
    known?: CorePromptKnownProjects
  }
  getAgent(agentId?: string): CoreSystemPromptSnapshotAgent
  /**
   * The tool allowlist that a REAL turn on this session would resolve
   * (resolveAgentToolSurface: the agent's own list unioned with whatever its
   * session kind implies). `null` means unrestricted.
   *
   * Without this the snapshot listed every globally-enabled tool, so the one
   * screen that shows "what is this turn assembled from" was wrong for every
   * agent that has an allowlist — and wrong in the reassuring direction.
   * Optional so non-agent hosts can omit it; omitting means unrestricted.
   */
  getAgentToolAllowlist?(session: CoreSystemPromptSnapshotSession): string[] | null
  buildPrompt(input: CoreSystemPromptSnapshotBuildPromptInput<TSettings, TSkill>): Promise<CoreSystemPromptSnapshotPromptResult> | CoreSystemPromptSnapshotPromptResult
  now?: () => number
}

export interface CoreSystemPromptSnapshot<
  TAgentLoopStream = CoreSystemPromptSnapshotAgentLoopStream,
> {
  sessionId: string
  generatedAt: number
  providerId: string
  model: string
  providerSupported: boolean
  credentialsReady: boolean
  workingDirectory?: string
  agentId?: string
  agentName?: string
  systemPrompt: string
  systemPromptChars: number
  tools: {
    enableToolCalls: boolean
    modelSupportsTools: boolean
    hasTools: boolean
    configuredCount: number
    modelFacingCount: number
    builtin: ReturnType<typeof toolSnapshot>[]
    mcp: ReturnType<typeof mcpToolSnapshot>[]
    nativeProvider: ReturnType<typeof nativeToolSnapshot>[]
  }
  agentLoopStream: TAgentLoopStream
  skills: {
    enabled: boolean
    includedInPrompt: boolean
    count: number
    items: ReturnType<typeof skillSnapshot>[]
  }
}

export function skillForInit(skill: CoreSnapshotSkillDefinition) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    category: skill.category,
    tags: skill.tags,
    relatedSkills: skill.relatedSkills,
    conditions: skill.conditions,
    disableModelInvocation: skill.disableModelInvocation,
    platforms: skill.platforms,
    path: skill.path,
    directoryPath: skill.directoryPath,
    rootPath: skill.rootPath,
    relativePath: skill.relativePath,
    enabled: skill.enabled,
    instructions: skill.instructions,
    runtimeContext: skill.runtimeContext,
    files: skill.files?.map(file => ({
      name: file.name,
      path: file.path,
      type: file.type,
    })),
  }
}

export function toolSnapshot(tool: CoreSnapshotToolDefinition) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    modelFacingName: tool.id,
    source: tool.source ?? (
      tool.id.startsWith('mcp:') ? 'mcp' : tool.category === 'custom' ? 'plugin' : 'builtin'
    ),
    serverId: tool.serverId,
    serverName: tool.serverName,
    enabled: tool.enabled,
    autoExecute: tool.autoExecute,
    permissionGuard: tool.permissionGuard,
    executionMode: tool.executionMode,
    renderKind: tool.renderKind,
    parameters: tool.parameters,
  }
}

export function normalizeToolParameterType(type: string | undefined): CoreSnapshotToolParameter['type'] {
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'object' || type === 'array') {
    return type
  }
  return 'string'
}

export function mcpToolSnapshot(name: string, definition: CoreSnapshotMCPDefinition) {
  return {
    id: name,
    name,
    description: definition.description,
    category: 'mcp',
    modelFacingName: name,
    source: 'mcp' as const,
    enabled: true,
    autoExecute: false,
    permissionGuard: 'permission-gated' as const,
    executionMode: 'sequential' as const,
    parameters: definition.parameters?.map(param => ({
      ...param,
      type: normalizeToolParameterType(param.type),
    })),
  }
}

export function nativeToolSnapshot(name: string) {
  return {
    id: name,
    name,
    description: name === 'image_generation'
      ? 'Native image output'
      : 'Native provider tool',
    category: 'native-provider',
    modelFacingName: name,
    source: 'native-provider' as const,
    enabled: true,
    autoExecute: false,
  }
}

export function providerConfigForPrompt<TConfig extends object>(
  providerConfig: TConfig,
): Record<string, CoreSnapshotPromptProviderConfigValue> {
  return { ...providerConfig } as Record<string, CoreSnapshotPromptProviderConfigValue>
}

export function skillSnapshot(skill: CoreSnapshotSkillDefinition) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    category: skill.category,
    tags: skill.tags,
    enabled: skill.enabled,
    allowedTools: skill.allowedTools,
    relatedSkills: skill.relatedSkills,
    platforms: skill.platforms,
    conditions: skill.conditions,
    path: skill.path,
    directoryPath: skill.directoryPath,
    rootPath: skill.rootPath,
    relativePath: skill.relativePath,
    files: skill.files?.map(file => ({
      name: file.name,
      path: file.path,
      type: file.type,
    })),
  }
}

export async function buildSystemPromptSnapshotWithAdapters<
  TSettings extends CoreSystemPromptSnapshotSettings,
  TProviderConfig extends object,
  TTool extends CoreSnapshotToolDefinition,
  TSkill extends CoreSnapshotSkillDefinition,
>(
  options: BuildSystemPromptSnapshotWithAdaptersOptions<TSettings, TProviderConfig, TTool, TSkill>,
): Promise<CoreSystemPromptSnapshot> {
  const session = options.getSession(options.sessionId)
  if (!session) {
    throw new Error('Session not found')
  }

  const settings = options.getSettings()
  const provider = await options.resolveProvider(settings, options.sessionId)
  const agentLoopStream = options.resolveAgentLoopStreamRoute({
    providerId: provider.providerId,
    settings,
  })
  const skillsEnabled = settings.skills?.enableSkills !== false
  const enabledSkills = skillsEnabled ? options.getSkills(session.workingDirectory, session.agentId) : []
  const enableToolCalls = settings.tools?.enableToolCalls !== false
  const providerRecord = provider.providerConfig as Record<string, unknown>

  if (enableToolCalls) {
    await options.initializeTools?.({
      skills: enabledSkills.map(skillForInit),
      workingDirectory: session.workingDirectory,
      workingDirectoryRoots: session.workingDirectoryRoots,
      providerId: provider.providerId,
      providerConfig: {
        apiKey: String(providerRecord.apiKey || ''),
        baseUrl: typeof providerRecord.baseUrl === 'string'
          ? providerRecord.baseUrl
          : undefined,
        model: provider.model,
      },
    })
  }

  const allEnabledTools = enableToolCalls
    ? await options.getEnabledTools(settings.tools?.tools)
    : []
  // Mirror planAgentLoopTools (core/engine/agent-loop-runtime.ts): a real turn
  // drops `mcp:` singles unconditionally and then keeps only what the agent's
  // allowlist permits. The snapshot used to skip the second half, so it
  // reported tools this agent can never call.
  const agentToolAllowlist = options.getAgentToolAllowlist?.(session) ?? null
  const allowedToolIds = agentToolAllowlist?.length ? new Set(agentToolAllowlist) : null
  const builtinTools = allEnabledTools
    .filter(tool => !tool.id.startsWith('mcp:'))
    .filter(tool => !allowedToolIds || allowedToolIds.has(tool.id))
  // 决策点 #1 hybrid: the MCP side arrives mode-resolved (flat array OR the
  // single router, mutually exclusive upstream); the same per-tool settings
  // and allowlist filters apply to each entry.
  const mcpToolDefinitions = enableToolCalls ? options.getMCPToolDefinitions() : []
  const visibleMCPTools = mcpToolDefinitions.filter(tool =>
    settings.tools?.tools?.[tool.id]?.enabled !== false
    && (!allowedToolIds || allowedToolIds.has(tool.id)),
  )
  const mcpTools = visibleMCPTools.length > 0
    ? options.sourceToolsToModelDefinitions(visibleMCPTools)
    : {}
  const modelSupportsTools = await options.resolveModelSupportsTools({
    provider,
    agentLoopActive: agentLoopStream.active,
    workingDirectory: session.workingDirectory,
    sessionId: options.sessionId,
  })
  const nativeProviderTools = await options.getNativeProviderTools({
    providerId: provider.providerId,
    providerConfig: provider.providerConfig,
    toolSettings: settings.tools,
    supportsTools: modelSupportsTools,
  })
  const hasTools = modelSupportsTools && (
    builtinTools.length > 0 ||
    Object.keys(mcpTools).length > 0 ||
    nativeProviderTools.length > 0
  )
  const builtinToolDefinitions = hasTools
    ? options.sourceToolsToModelDefinitions(builtinTools)
    : {}
  const projectVars = options.buildProjectDirsPromptVars(session.workingDirectory, {
    sessionId: options.sessionId,
  })
  const agent = options.getAgent(session.agentId)
  const requestMessages = await options.buildPrompt({
    sessionId: options.sessionId,
    agentId: session.agentId,
    providerId: provider.providerId,
    providerConfig: providerConfigForPrompt(provider.providerConfig),
    settings,
    hasTools,
    skills: enabledSkills,
    workingDirectory: session.workingDirectory,
    workingDirectoryRoots: session.workingDirectoryRoots,
    activeProject: projectVars.active,
    knownProjects: projectVars.known,
    toolNames: [...Object.keys(builtinToolDefinitions), ...nativeProviderTools],
    mcpToolNames: Object.keys(mcpTools),
    historyMessages: [],
  })

  return {
    sessionId: options.sessionId,
    generatedAt: options.now?.() ?? Date.now(),
    providerId: provider.providerId,
    model: provider.model,
    providerSupported: provider.providerSupported,
    credentialsReady: provider.credentialsReady,
    workingDirectory: session.workingDirectory,
    agentId: agent.id,
    agentName: agent.name,
    systemPrompt: requestMessages.systemPrompt,
    systemPromptChars: requestMessages.systemPrompt.length,
    tools: {
      enableToolCalls,
      modelSupportsTools,
      hasTools,
      configuredCount: allEnabledTools.length + Object.keys(mcpTools).length + nativeProviderTools.length,
      modelFacingCount: Object.keys(builtinToolDefinitions).length + Object.keys(mcpTools).length + nativeProviderTools.length,
      builtin: builtinTools.map(toolSnapshot),
      mcp: Object.entries(mcpTools).map(([name, definition]) => mcpToolSnapshot(name, definition)),
      nativeProvider: nativeProviderTools.map(nativeToolSnapshot),
    },
    agentLoopStream,
    skills: {
      enabled: skillsEnabled,
      includedInPrompt: requestMessages.systemPrompt.includes('# Skills'),
      count: enabledSkills.length,
      items: enabledSkills.map(skillSnapshot),
    },
  }
}
