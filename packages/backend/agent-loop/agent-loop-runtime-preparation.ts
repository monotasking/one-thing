// 一次 agent 运行开跑之前的准备(从 `agent-loop-runtime.ts` 拆出,拆分批 1,D226):从会话、设置与服务商配置
// 算出准备计划、提示词选项、工具计划、技能上下文与直接工具。服务商配置与运行期上下文的那几个共用形状
// (`CoreAgentLoopProviderConfig*`、`CoreAgentLoopRuntime*Like`)由准备计划定义,所以也住在这里。
// 同一家的兄弟文件:`-budget`(上下文预算)、`-compaction`(带适配器的压缩驱动)、`-turn`(回合前后与待注入消息)。
import type {
  CoreBuildPromptOptions,
  CorePromptRequestMessage,
} from './agent-loop-system-prompt.js'
import {
  agentToolDefinitionsFromSourceTools,
  agentToolsFromToolDefinitions,
  type AgentModelToolDefinition,
  type AgentSourceToolDefinition,
} from './agent-loop-tools.js'
import { resolveAIToolName } from './agent-loop-tool-names.js'
import type { Principal } from '@shared/permission/principal.js'
import type { AgentTool } from './agent-loop-types.js'
import { toJsonObject, toJsonValue, type JsonObject } from '@shared/json.js'

export interface CoreAgentLoopProviderConfig {
  model: string
  maxOutputByModel?: Record<string, number | undefined>
}

export interface CoreAgentLoopProviderRuntimeConfigLike extends CoreAgentLoopProviderConfig {
  apiKey?: unknown
  baseUrl?: unknown
  apiType?: unknown
  oauthToken?: unknown
  authContext?: unknown
  /**
   * per-space credential marker, stamped by the host's credential resolution and
   * forwarded verbatim (core never inspects it). The provider factory needs it to
   * know WHERE an in-turn OAuth refresh should write back — the refresh happens
   * deep inside a provider, long after the session id is gone.
   */
  spaceCredential?: unknown
  modelCapabilitiesByModel?: unknown
  models?: unknown
  /**
   * Provider-private knobs, forwarded verbatim and never inspected here. core
   * used to name `zhipuApiMode` / `qwenApiMode` / `qwenRegion` in this
   * interface AND in the Pick below — so every provider that grew its own dial
   * forced an edit to the provider-agnostic layer, and forgetting one dropped
   * the field silently (the Pick is a whitelist; typecheck stays green).
   */
  providerOptions?: unknown
  /**
   * 批 M §5.3 三格:自定义请求头 / 模型列表地址 / 方言覆盖。core 只抄,不解释 ——
   * 从前这张复制表没抄 `dialect`,于是自定义服务商点名方言从来没生效过。
   */
  headers?: unknown
  modelsUrl?: unknown
  dialect?: unknown
}

export type CoreAgentLoopProviderRuntimeConfigFor<TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike> =
  Pick<TProviderConfig,
    | 'apiKey'
    | 'baseUrl'
    | 'providerOptions'
    | 'model'
    | 'apiType'
    | 'oauthToken'
    | 'authContext'
    | 'spaceCredential'
    | 'modelCapabilitiesByModel'
    | 'models'
    | 'headers'
    | 'modelsUrl'
    | 'dialect'
  >

export interface CoreAgentLoopRuntimeSessionLike {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  agentId?: string
}

export interface CoreAgentLoopRuntimeToolSettingsLike extends CoreAgentLoopToolSettings {
  enableToolCalls?: boolean
}

export interface CoreAgentLoopRuntimeSettingsLike<TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined> {
  skills?: {
    enableSkills?: boolean
  }
  tools?: TToolSettings
}

export interface CoreAgentLoopRuntimeContextLike<
  TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
  TSettings extends CoreAgentLoopRuntimeSettingsLike<TToolSettings>,
  TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
> {
  sessionId: string
  providerConfig: TProviderConfig
  settings: TSettings
  toolSettings?: TToolSettings
  executionContext?: unknown
}

export interface CoreAgentLoopProviderHostContext {
  workingDirectory?: string
  localSessionId: string
  /** Opaque trusted host context; never read from model input. */
  executionContext?: unknown
}

export interface CoreAgentLoopRuntimePreparationPlan<
  TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
  TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
> {
  sessionWorkingDir?: string
  sessionWorkingDirRoots?: string[]
  agentId?: string
  skillsEnabled: boolean
  effectiveToolSettings?: TToolSettings
  toolCallsEnabled: boolean
  providerRuntimeConfig: CoreAgentLoopProviderRuntimeConfigFor<TProviderConfig>
  providerHostContext: CoreAgentLoopProviderHostContext
}

export interface CoreAgentLoopPromptRuntimeContextLike<
  TProviderConfig extends CoreBuildPromptOptions['providerConfig'],
  TSettings = unknown,
> {
  sessionId: string
  providerId: string
  providerConfig: TProviderConfig
  settings: TSettings
  voiceConversation?: boolean
  speakMode?: boolean
}

export interface CoreAgentLoopPromptBuildInput<
  TProviderConfig extends CoreBuildPromptOptions['providerConfig'] = CoreBuildPromptOptions['providerConfig'],
  TSettings = unknown,
> {
  ctx: CoreAgentLoopPromptRuntimeContextLike<TProviderConfig, TSettings>
  agentId?: string
  hasTools: boolean
  skills: CoreBuildPromptOptions['skills']
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  activeProject?: CoreBuildPromptOptions['activeProject']
  knownProjects?: CoreBuildPromptOptions['knownProjects']
  toolNames?: string[]
  mcpToolNames?: string[]
  historyMessages: CorePromptRequestMessage[]
}

export interface CoreAgentLoopThinkingContext {
  providerId: string
  providerConfig: CoreAgentLoopProviderConfig
}

export interface CoreAgentLoopProviderConfigWithOptionalKey {
  apiKey?: string
}

export type CoreAgentLoopSkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'custom'

export interface CoreAgentLoopSkillLike {
  id: string
  name: string
  description: string
  source: CoreAgentLoopSkillSource
  category?: string
  tags?: string[]
  relatedSkills?: string[]
  platforms?: string[]
  conditions?: {
    fallbackForToolsets?: string[]
    requiresToolsets?: string[]
    fallbackForTools?: string[]
    requiresTools?: string[]
  }
  path: string
  directoryPath: string
  rootPath?: string
  relativePath?: string
  enabled: boolean
  instructions: string
  runtimeContext?: string
  disableModelInvocation?: boolean
  files?: Array<{ name: string; path: string; type: string }>
}

export interface CoreAgentLoopSkillContext {
  name: string
  description?: string
  instructions?: string
  source?: string
  location?: string
  disableModelInvocation?: boolean
}

export interface CoreAgentLoopInitSkillSnapshot {
  id: string
  name: string
  description: string
  source: CoreAgentLoopSkillSource
  category?: string
  tags?: string[]
  relatedSkills?: string[]
  conditions?: CoreAgentLoopSkillLike['conditions']
  disableModelInvocation?: boolean
  platforms?: string[]
  path: string
  directoryPath: string
  rootPath?: string
  relativePath?: string
  enabled: boolean
  instructions: string
  runtimeContext?: string
  files?: Array<{ name: string; path: string; type: string }>
}

export interface CoreAgentLoopToolSettings {
  tools?: Record<string, { enabled?: boolean } | undefined>
}

export interface CoreAgentLoopToolPlan<TTool extends AgentSourceToolDefinition = AgentSourceToolDefinition> {
  enabledTools: TTool[]
  builtinToolDefinitions: Record<string, AgentModelToolDefinition>
  mcpToolDefinitions: Record<string, AgentModelToolDefinition>
  modelToolDefinitions: Record<string, AgentModelToolDefinition>
  hasTools: boolean
  toolNames: string[]
  mcpToolNames: string[]
}

export interface CoreAgentLoopDirectToolRuntimeContext {
  executionContext?: unknown
  sessionId: string
  messageId: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: AbortSignal
  /**
   * Who is running this turn — minted at the engine boundary, carried here.
   * The tool executor used to receive only `sessionId`, which is why every
   * downstream consumer re-derived an actor from `session.agentId` (a field
   * stamped on EVERY session, so its presence proves nothing).
   */
  principal?: Principal
  /**
   * F4 身份面:这一回合归属的 agent。**与 principal 分开的两件事** —— principal
   * 是被证明过的行动主体(权限判定),这个是回合入口一次解析出来的身份归属
   * (作用域用:插件按 "自己的 scope + global" 读写)。合并成一个字段会让
   * "权限降级到 system" 顺手把插件的作用域也擦掉。
   */
  agentId?: string
}

export interface CoreAgentLoopDirectToolMetadataUpdate {
  title?: string
  metadata?: unknown
}

export interface CoreAgentLoopDirectToolResultLike {
  success: boolean
  data?: unknown
  error?: string
  requiresConfirmation?: boolean
  commandType?: 'read-only' | 'dangerous' | 'forbidden'
  aborted?: boolean
  rejected?: boolean
  rejectionReason?: string
}

export interface BuildAgentLoopDirectToolsWithAdaptersOptions<
  TResult extends CoreAgentLoopDirectToolResultLike,
  TPartialResultUpdate = unknown,
> {
  definitions: Record<string, AgentModelToolDefinition>
  context: CoreAgentLoopDirectToolRuntimeContext
  executeToolDirectly: (
    toolName: string,
    args: JsonObject,
    context: {
      sessionId: string
      messageId: string
      toolCallId: string
      executionContext?: unknown
      workingDirectory?: string
      workingDirectoryRoots?: string[]
      abortSignal?: AbortSignal
      principal?: Principal
      /** F4:回合归属的 agent(见 CoreAgentLoopDirectToolRuntimeContext.agentId)。 */
      agentId?: string
      onMetadata?: (update: CoreAgentLoopDirectToolMetadataUpdate) => void
      onPartialResult?: (update: TPartialResultUpdate) => void
    },
  ) => Promise<TResult>
}

export function configWithApiKey<TConfig extends object>(
  config: TConfig,
): TConfig & { apiKey: string } {
  return {
    ...config,
    apiKey: (config as { apiKey?: string }).apiKey ?? '',
  }
}

export function agentLoopSkillContexts<TSkill extends CoreAgentLoopSkillLike>(
  skills: TSkill[],
): CoreAgentLoopSkillContext[] {
  return skills
    .filter(skill => skill.enabled !== false && !skill.disableModelInvocation)
    .map(skill => ({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      source: skill.path,
      location: skill.path,
      disableModelInvocation: skill.disableModelInvocation,
    }))
}

export function agentLoopInitSkills<TSkill extends CoreAgentLoopSkillLike>(
  skills: TSkill[],
): CoreAgentLoopInitSkillSnapshot[] {
  return skills.map(skill => ({
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
    files: skill.files?.map(file => ({ name: file.name, path: file.path, type: file.type })),
  }))
}

export function planAgentLoopRuntimePreparation<
  TProviderConfig extends CoreAgentLoopProviderRuntimeConfigLike,
  TSettings extends CoreAgentLoopRuntimeSettingsLike<TToolSettings>,
  TToolSettings extends CoreAgentLoopRuntimeToolSettingsLike | undefined,
>(input: {
  ctx: CoreAgentLoopRuntimeContextLike<TProviderConfig, TSettings, TToolSettings>
  session?: CoreAgentLoopRuntimeSessionLike | null
}): CoreAgentLoopRuntimePreparationPlan<TProviderConfig, TToolSettings> {
  const sessionWorkingDir = input.session?.workingDirectory
  const sessionWorkingDirRoots = input.session?.workingDirectoryRoots
  const effectiveToolSettings = input.ctx.toolSettings ?? input.ctx.settings.tools

  return {
    sessionWorkingDir,
    sessionWorkingDirRoots,
    agentId: input.session?.agentId,
    skillsEnabled: input.ctx.settings.skills?.enableSkills !== false,
    effectiveToolSettings,
    toolCallsEnabled: effectiveToolSettings?.enableToolCalls !== false,
    providerRuntimeConfig: {
      apiKey: input.ctx.providerConfig.apiKey,
      baseUrl: input.ctx.providerConfig.baseUrl,
      providerOptions: input.ctx.providerConfig.providerOptions,
      model: input.ctx.providerConfig.model,
      apiType: input.ctx.providerConfig.apiType,
      oauthToken: input.ctx.providerConfig.oauthToken,
      authContext: input.ctx.providerConfig.authContext,
      spaceCredential: input.ctx.providerConfig.spaceCredential,
      modelCapabilitiesByModel: input.ctx.providerConfig.modelCapabilitiesByModel,
      models: input.ctx.providerConfig.models,
      headers: input.ctx.providerConfig.headers,
      modelsUrl: input.ctx.providerConfig.modelsUrl,
      dialect: input.ctx.providerConfig.dialect,
    } as CoreAgentLoopProviderRuntimeConfigFor<TProviderConfig>,
    providerHostContext: {
      workingDirectory: sessionWorkingDir,
      localSessionId: input.ctx.sessionId,
      ...(input.ctx.executionContext === undefined ? {} : { executionContext: input.ctx.executionContext }),
    },
  }
}

export function planAgentLoopPromptBuildOptions<
  TProviderConfig extends CoreBuildPromptOptions['providerConfig'],
  TSettings,
>(input: CoreAgentLoopPromptBuildInput<TProviderConfig, TSettings>): CoreBuildPromptOptions {
  return {
    sessionId: input.ctx.sessionId,
    agentId: input.agentId,
    providerId: input.ctx.providerId,
    model: typeof input.ctx.providerConfig?.model === 'string'
      ? input.ctx.providerConfig.model
      : undefined,
    providerConfig: input.ctx.providerConfig,
    settings: input.ctx.settings,
    hasTools: input.hasTools,
    skills: input.skills,
    workingDirectory: input.workingDirectory,
    workingDirectoryRoots: input.workingDirectoryRoots,
    activeProject: input.activeProject,
    knownProjects: input.knownProjects,
    toolNames: input.toolNames,
    mcpToolNames: input.mcpToolNames,
    voiceConversation: input.ctx.voiceConversation,
    speakMode: input.ctx.speakMode ?? input.ctx.voiceConversation,
    historyMessages: input.historyMessages,
  }
}

export function planAgentLoopTools<TTool extends AgentSourceToolDefinition>(input: {
  toolLoadingEnabled: boolean
  allEnabledTools: TTool[]
  mcpRouterTool?: AgentSourceToolDefinition | null
  /**
   * 决策点 #1 hybrid: the mode-resolved MCP tool definitions (flat array OR
   * the single router, mutually exclusive upstream). Takes precedence over
   * the legacy singular `mcpRouterTool` when provided.
   */
  mcpTools?: readonly AgentSourceToolDefinition[]
  toolSettings?: CoreAgentLoopToolSettings
  /**
   * Per-agent tool allowlist (tool ids). null/undefined = no restriction.
   * When present, only listed tools survive — including the MCP router.
   */
  allowedToolIds?: readonly string[] | null
}): CoreAgentLoopToolPlan<TTool> {
  const allowed = input.allowedToolIds && input.allowedToolIds.length > 0
    ? new Set(input.allowedToolIds)
    : null
  const enabledTools = input.toolLoadingEnabled
    ? input.allEnabledTools.filter(tool =>
        !tool.id.startsWith('mcp:') && (!allowed || allowed.has(tool.id)))
    : []
  const mcpCandidates: readonly AgentSourceToolDefinition[] =
    input.mcpTools ?? (input.mcpRouterTool ? [input.mcpRouterTool] : [])
  const visibleMCPTools = input.toolLoadingEnabled
    ? mcpCandidates.filter(tool =>
        input.toolSettings?.tools?.[tool.id]?.enabled !== false
        && (!allowed || allowed.has(tool.id)))
    : []
  const mcpToolDefinitions = visibleMCPTools.length > 0
    ? agentToolDefinitionsFromSourceTools(visibleMCPTools)
    : {}
  const hasTools = Boolean(
    input.toolLoadingEnabled &&
    (enabledTools.length > 0 || Object.keys(mcpToolDefinitions).length > 0),
  )
  const builtinToolDefinitions = hasTools ? agentToolDefinitionsFromSourceTools(enabledTools) : {}
  const modelToolDefinitions = hasTools ? { ...builtinToolDefinitions, ...mcpToolDefinitions } : {}

  return {
    enabledTools,
    builtinToolDefinitions,
    mcpToolDefinitions,
    modelToolDefinitions,
    hasTools,
    toolNames: Object.keys(builtinToolDefinitions),
    mcpToolNames: Object.keys(mcpToolDefinitions),
  }
}

export function buildAgentLoopDirectToolsWithAdapters<
  TResult extends CoreAgentLoopDirectToolResultLike,
  TPartialResultUpdate = unknown,
>(
  options: BuildAgentLoopDirectToolsWithAdaptersOptions<TResult, TPartialResultUpdate>,
): AgentTool[] {
  return agentToolsFromToolDefinitions(options.definitions, async (name, args, toolCtx) => {
    const result = await options.executeToolDirectly(resolveAIToolName(name), args, {
      sessionId: options.context.sessionId,
      messageId: options.context.messageId,
      toolCallId: toolCtx.toolCallId,
      workingDirectory: options.context.workingDirectory,
      workingDirectoryRoots: options.context.workingDirectoryRoots,
      abortSignal: toolCtx.abortSignal ?? options.context.abortSignal,
      principal: options.context.principal,
      executionContext: options.context.executionContext,
      agentId: options.context.agentId,
      onMetadata: toolCtx.onMetadata
        ? update => toolCtx.onMetadata?.({
            title: update.title,
            metadata: toJsonObject(update.metadata),
          })
        : undefined,
      onPartialResult: toolCtx.onPartialResult
        ? update => toolCtx.onPartialResult?.(update as Parameters<NonNullable<typeof toolCtx.onPartialResult>>[0])
        : undefined,
    })

    return {
      ...result,
      data: toJsonValue(result.data),
    }
  })
}
