import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import {
  getContextCompactReason,
  resolveCompactOutputTokens,
  shouldSkipAutoCompactForProviderUsageMismatch,
  type CoreCompactMessage,
  type CoreCompactSession,
} from './context-compact.js'
import {
  buildContextUsageSnapshot,
} from './context-usage.js'
import type {
  CoreBuildPromptOptions,
  CorePromptRequestMessage,
} from './system-prompt.js'
import {
  agentToolDefinitionsFromSourceTools,
  agentToolsFromToolDefinitions,
  type AgentModelToolDefinition,
  type AgentSourceToolDefinition,
} from '../agent-loop/tools.js'
import { resolveAIToolName } from '../agent-loop/tool-names.js'
import type { Principal } from '../permission/principal.js'
import { coreProviderOwnsItsContextWindow } from './external-agent-providers.js'
import type { AgentTool } from '../agent-loop/types.js'
import { toJsonObject, toJsonValue, type JsonObject } from '../json.js'
import { toLogger, type CompatLogger } from '../logging/index.js'

export interface CoreAgentLoopContextBudget {
  modelContextLength: number
  /**
   * 这一轮打算要多少输出 token。**缺席 = 这个模型的输出上限没人知道,于是
   * 不传 `max_tokens`**(2026-09-09 用户裁定,事故:目录里没有的
   * `deepseek-v4.1-flash-expires-on-0910` 被编造成 4096、对半成 2048,
   * reasoning 吃光后 `length` 收场)。
   *
   * 「知道」只有两个来源:模型目录里有这一条,或用户在
   * `providers[p].maxOutputByModel[model]` 里自己写了。两者都没有就是不知道
   * —— 不许在任何读者处补一个默认数,让 provider 自己说它的默认值是多少。
   */
  reservedOutputTokens?: number
  thresholdPercent: number
}

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

export interface CoreAgentLoopModelLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
}

export interface ResolveAgentLoopContextBudgetOptions {
  capabilities?: CoreAgentLoopModelLimits
  providerId: string
  providerConfig: CoreAgentLoopProviderConfig
  contextCompactThreshold?: number
  resolveModelContextLength?: (model: string, providerId: string) => number | undefined | Promise<number | undefined>
  resolveModelMaxOutputTokens?: (model: string, providerId: string) => number | undefined | Promise<number | undefined>
}

export interface CoreAgentLoopContextBudgetResolution {
  budget: CoreAgentLoopContextBudget
  error?: unknown
}

export interface CoreAgentLoopThinkingContext {
  providerId: string
  providerConfig: CoreAgentLoopProviderConfig
}

export interface CoreAgentLoopMessage {
  role: string
  content?: unknown
  toolCalls?: unknown[]
}

export interface CoreResolvedPendingAgentLoopMessage<TContentParts = unknown> {
  id: string
  modelContent: string
  timestamp: number
  contentParts?: TContentParts
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopInputMessage {
  content: string
  timestamp: number
  source?: string
  id?: string
  modelContent?: string
  contentParts?: unknown
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopPromptResolution<TContentParts = unknown> {
  modelContent: string
  contentParts?: TContentParts
}

export interface CorePendingAgentLoopRuntimeMessage {
  role: 'user'
  content: string
}

export interface CorePendingAgentLoopChatMessage<TContentParts = unknown> {
  id: string
  role: 'user'
  content: string
  timestamp: number
  contentParts?: TContentParts
  persisted?: boolean
  origin?: unknown
}

export interface CorePendingAgentLoopInjectionResult<
  TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage,
  TContentParts = unknown,
> {
  messages: Array<TMessage | CorePendingAgentLoopRuntimeMessage>
  chatMessages: Array<CorePendingAgentLoopChatMessage<TContentParts>>
}

export type CoreAgentLoopTurnMessages<TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage> =
  Array<TMessage | CorePendingAgentLoopRuntimeMessage>

export interface CoreAgentLoopBeforeTurnResult<
  TMessage extends CoreAgentLoopMessage = CoreAgentLoopMessage,
> {
  messages: CoreAgentLoopTurnMessages<TMessage>
  /**
   * A steering user message was injected before this turn: the caller must
   * surface it to the loop as a response boundary so the answer starts a
   * new assistant response instead of continuing the interrupted one.
   */
  startNewResponse: boolean
}

export interface CoreAgentLoopPendingMessageAdapters<TContentParts = unknown> {
  createPendingMessageId(): string
  resolvePromptReferences(content: string): CorePendingAgentLoopPromptResolution<TContentParts>
  persistInjectedChatMessage(message: CorePendingAgentLoopChatMessage<TContentParts>): void | Promise<void>
}

export interface CoreAgentLoopTurnQueueAdapters {
  drainSteeringMessages?: () => CorePendingAgentLoopInputMessage[]
  drainFollowUpMessages?: () => CorePendingAgentLoopInputMessage[]
}

/** 瞬态尾块的哨兵:一条 user 消息,正文以这个开头,就是上一轮挂的那一块。 */
export const CORE_EPHEMERAL_TAIL_SENTINEL = '<scratchpad '

export interface CoreAgentLoopEphemeralTail {
  /** 整块正文(自带哨兵开头)。 */
  text: string
  /** 内容版本;与在场那一块相同 = 原样保留,不重挂、不回调。 */
  version: number
}

/**
 * 每 turn 一块的**瞬态尾块** —— 进模型、不进聊天流、不持久化。
 *
 * 语义是**替换而非追加**:先按哨兵把上一块从数组里剥掉,再把新的一块 push 到
 * 尾巴。所以连跑 20 个 turn 也只有一块在场(token 不累积),而缓存前缀只从
 * 尾巴那里失效 —— 那里本来就是边界。
 *
 * 适配器缺席 = 一个字节都不变(整段跳过)。
 */
export interface CoreAgentLoopEphemeralTailAdapters {
  buildEphemeralTail?: (turn: number) => Promise<CoreAgentLoopEphemeralTail | undefined>
  onEphemeralTailInjected?: (info: { turn: number, version: number }) => void
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

export type CoreAgentLoopCompactReason = 'threshold'

export interface CoreAgentLoopCompactState {
  configuredKeepTurns: number
  keepRecentTurns: number
  pass: number
  compacted: boolean
}

export type CoreAgentLoopCompactPassPlan =
  | { kind: 'stop'; state: CoreAgentLoopCompactState }
  | { kind: 'skip-provider-usage-mismatch'; state: CoreAgentLoopCompactState }
  | {
      kind: 'compact'
      state: CoreAgentLoopCompactState
      reason: CoreAgentLoopCompactReason
      keepRecentTurns: number
      pass: number
    }

export type CoreAgentLoopCompactResultPlan =
  | { kind: 'retry'; state: CoreAgentLoopCompactState }
  | { kind: 'stop'; state: CoreAgentLoopCompactState }

export type CoreAgentLoopCompactFinalPlan =
  | { kind: 'none' }
  | { kind: 'rebuild' }

export interface CoreAgentLoopCompactResultLike {
  success: boolean
  skipped?: boolean
  summary?: string
  error?: string
  retainedContextSize?: number
}

export type CoreAgentLoopCompactEventPlan =
  | {
      type: typeof SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED
      success: boolean
      skipped?: boolean
      summary?: string
      error?: string
    }
  | {
      type: typeof SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED
      contextSize: number
    }

export interface CoreAgentLoopCompactSessionLike extends CoreCompactSession {
  contextSize?: number
  lastInputTokens?: number
}

export interface CoreAgentLoopCompactionContext<TSettings, TProviderConfig extends object> {
  sessionId: string
  providerId: string
  providerConfig: TProviderConfig
  settings: TSettings
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CoreAgentLoopCompactLogger = CompatLogger

export interface CoreAgentLoopCompactionAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  getSession(sessionId: string): TSession | null | undefined
  compactSessionContext(input: {
    sessionId: string
    providerId: string
    configWithApiKey: TProviderConfig & { apiKey: string }
    settings: TSettings
    keepRecentTurns: number
    onMessageCreated: (message: unknown) => Promise<void>
    onMessageUpdated: (messageId: string, updates: unknown) => Promise<void>
  }): Promise<TCompactResult>
  emitEvent(sessionId: string, event: CoreAgentLoopCompactEventPlan | { type: typeof SESSION_EVENT_TYPES.MESSAGE_CREATED; message: unknown } | { type: typeof SESSION_EVENT_TYPES.MESSAGE_UPDATED; messageId: string; updates: unknown }): Promise<void>
  rebuildMessages(): Promise<TMessage[]>
  shouldSkipProviderUsageMismatch?: (input: {
    providerId: string
    session: TSession
    modelContextLength: number
    inputTokens?: number
  }) => boolean
  logger?: CoreAgentLoopCompactLogger
}

export interface MaybeCompactAgentLoopContextOptions<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  ctx: CoreAgentLoopCompactionContext<TSettings, TProviderConfig>
  turn: number
  messages: TMessage[]
  budget: CoreAgentLoopContextBudget
  compactEnabled: boolean
  keepRecentTurns: number
  adapters: CoreAgentLoopCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>
}

export type CoreAgentLoopTurnCompactionAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> = Omit<CoreAgentLoopCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>, 'rebuildMessages'>

export interface RunAgentLoopBeforeTurnWithAdaptersOptions<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
> {
  ctx: CoreAgentLoopCompactionContext<TSettings, TProviderConfig>
  turn: number
  messages: TMessage[]
  budget: CoreAgentLoopContextBudget
  compactEnabled: boolean
  keepRecentTurns: number
  rebuildMessages(messages: CoreAgentLoopTurnMessages<TMessage>): Promise<TMessage[]>
  adapters:
    & CoreAgentLoopPendingMessageAdapters<TContentParts>
    & CoreAgentLoopTurnQueueAdapters
    & CoreAgentLoopEphemeralTailAdapters
    & CoreAgentLoopTurnCompactionAdapters<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>
}

export interface RunAgentLoopAfterTurnWithAdaptersOptions<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
> {
  messages: TMessage[]
  adapters: CoreAgentLoopPendingMessageAdapters<TContentParts> & CoreAgentLoopTurnQueueAdapters
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

export function shouldStartAgentLoopContextCompact(options: {
  turn: number
  providerId: string
  compactEnabled: boolean
}): boolean {
  if (options.turn <= 1) return false
  // 能力查询而非身份判定:上下文归执行体自己管时,我们不压缩(E0)。
  if (coreProviderOwnsItsContextWindow(options.providerId)) return false
  if (!options.compactEnabled) return false
  return true
}

export function createAgentLoopCompactState(configuredKeepTurns: number): CoreAgentLoopCompactState {
  const normalizedKeepTurns = Math.max(0, Math.floor(configuredKeepTurns || 0))
  return {
    configuredKeepTurns: normalizedKeepTurns,
    keepRecentTurns: normalizedKeepTurns,
    pass: 1,
    compacted: false,
  }
}

export function positiveTokenLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function resolveAgentLoopContextBudgetValues(input: {
  capabilities?: CoreAgentLoopModelLimits
  registeredModelContextLength?: number
  registeredModelMaxOutputTokens?: number
  providerConfig: CoreAgentLoopProviderConfig
  contextCompactThreshold?: number
}): CoreAgentLoopContextBudget {
  const modelContextLength = positiveTokenLimit(input.capabilities?.maxInputTokens)
    ?? positiveTokenLimit(input.registeredModelContextLength)
    ?? 128000
  // 上限未知就是 undefined,**不再 `?? 0`**(2026-09-09 裁定):0 会一路走到
  // 「替模型编一个数」那条岔路上,而那正是 4096 的老产地。
  const modelMaxOutputTokens = positiveTokenLimit(input.capabilities?.maxOutputTokens)
    ?? positiveTokenLimit(input.registeredModelMaxOutputTokens)
  const perModelOverride = positiveTokenLimit(
    input.providerConfig.maxOutputByModel?.[input.providerConfig.model],
  )
  const halfDefault = modelMaxOutputTokens !== undefined
    ? Math.max(1, Math.floor(modelMaxOutputTokens / 2))
    : undefined
  // 已知上限时的行为一字不变:用户覆盖优先,否则对半,再按上限夹。
  // 上限未知且无覆盖 = undefined = 不传 max_tokens(2026-09-09 裁定:请求侧
  // 只认这两个来源,全局设置那一格已退役)。
  const requested = perModelOverride ?? halfDefault
  const reservedOutputTokens = modelMaxOutputTokens !== undefined
    ? Math.min(requested ?? modelMaxOutputTokens, modelMaxOutputTokens)
    : requested

  return {
    modelContextLength,
    reservedOutputTokens,
    thresholdPercent: input.contextCompactThreshold ?? 85,
  }
}

/**
 * 发请求那一刻的第二道夹(2026-09-08 事故的聊天侧同病):
 * `resolveAgentLoopContextBudgetValues` 只按「注册上限的一半」算预留量,它不看
 * 这一轮真的塞了多少输入 —— 窗口 1048576 的模型上,384000 的一半 192000 加上
 * 701297 的输入照样越窗。所以在把 `maxTokens` 交给 provider 之前,用压缩侧
 * **同一个纯函数**按当前输入 token 再夹一次。
 *
 * 输入读数用 `buildContextUsageSnapshot` 的 `providerInputTokens` 口径
 * (= max(contextSize, lastInputTokens),provider 上一次自己报的数)。
 * **触发判定一字不碰** —— 压缩只认百分比(2026-08-23 裁定),这里改的只是
 * 请求参数。
 *
 * 夹不出结果(注册上限未知 / 窗口已被输入吃满)就原样返回预留量:本函数只
 * 负责往下夹,不负责编一个更大的数,也不负责替调用方决定塞不下时怎么办。
 *
 * 预留量本身缺席(= 输出上限没人知道,2026-09-09 裁定)就回 `undefined`:
 * 不知道上限时**不**拿窗口余量另造一个数,这与 `resolveCompactOutputTokens`
 * 对未注册模型回 undefined 是同一条(2026-08-15)。
 */
export function clampAgentLoopRequestMaxTokens(input: {
  budget: CoreAgentLoopContextBudget
  providerInputTokens: number
}): number | undefined {
  const reserved = input.budget.reservedOutputTokens
  if (reserved === undefined) return undefined
  const clamped = resolveCompactOutputTokens({
    modelContextLength: input.budget.modelContextLength,
    registeredMaxOutputTokens: reserved,
    inputTokens: input.providerInputTokens,
  })
  return clamped ?? reserved
}

/** `buildContextUsageSnapshot` 的 providerInputTokens 口径,单独拿出来复用。 */
export function providerReportedInputTokens(
  session: Pick<CoreCompactSession, 'contextSize' | 'lastInputTokens'> | null | undefined,
): number {
  return Math.max(
    0,
    Math.floor(session?.contextSize ?? 0),
    Math.floor(session?.lastInputTokens ?? 0),
  )
}

export async function resolveAgentLoopContextBudgetWithRegistry(
  options: ResolveAgentLoopContextBudgetOptions,
): Promise<CoreAgentLoopContextBudgetResolution> {
  // 解析出错 = 我们没问出这个模型的上限,那就是不知道:`reservedOutputTokens`
  // 缺席(2026-09-09 裁定),别在兜底里偷偷塞回 4096。
  const fallbackBudget: CoreAgentLoopContextBudget = {
    modelContextLength: positiveTokenLimit(options.capabilities?.maxInputTokens) ?? 128000,
    thresholdPercent: options.contextCompactThreshold ?? 85,
  }

  try {
    const registeredModelContextLength = positiveTokenLimit(options.capabilities?.maxInputTokens)
      ?? positiveTokenLimit(await options.resolveModelContextLength?.(
        options.providerConfig.model,
        options.providerId,
      ))
    const registeredModelMaxOutputTokens = positiveTokenLimit(options.capabilities?.maxOutputTokens)
      ?? positiveTokenLimit(await options.resolveModelMaxOutputTokens?.(
        options.providerConfig.model,
        options.providerId,
      ))

    return {
      budget: resolveAgentLoopContextBudgetValues({
        capabilities: options.capabilities,
        registeredModelContextLength,
        registeredModelMaxOutputTokens,
        providerConfig: options.providerConfig,
        contextCompactThreshold: options.contextCompactThreshold,
      }),
    }
  } catch (error) {
    return { budget: fallbackBudget, error }
  }
}

export function planAgentLoopContextCompactPass(options: {
  state: CoreAgentLoopCompactState
  session?: CoreCompactSession
  providerId: string
  budget: CoreAgentLoopContextBudget
  providerUsageMismatch?: boolean
  inputTokens?: number
}): CoreAgentLoopCompactPassPlan {
  if (options.state.configuredKeepTurns <= 0) {
    return { kind: 'stop', state: options.state }
  }
  if (options.state.pass > options.state.configuredKeepTurns) {
    return { kind: 'stop', state: options.state }
  }
  if (!options.session) {
    return { kind: 'stop', state: options.state }
  }
  if (options.providerUsageMismatch) {
    return { kind: 'skip-provider-usage-mismatch', state: options.state }
  }

  const reason = getContextCompactReason({
    session: options.session,
    modelContextLength: options.budget.modelContextLength,
    thresholdPercent: options.budget.thresholdPercent,
    inputTokens: options.inputTokens,
  })
  if (!reason) {
    return { kind: 'stop', state: options.state }
  }

  return {
    kind: 'compact',
    state: options.state,
    reason,
    keepRecentTurns: options.state.keepRecentTurns,
    pass: options.state.pass,
  }
}

function nextAgentLoopCompactState(
  state: CoreAgentLoopCompactState,
  patch: Partial<CoreAgentLoopCompactState> = {},
): CoreAgentLoopCompactState {
  return {
    ...state,
    ...patch,
  }
}

export function applyAgentLoopContextCompactResult(options: {
  state: CoreAgentLoopCompactState
  reason: CoreAgentLoopCompactReason
  success: boolean
  skipped?: boolean
}): CoreAgentLoopCompactResultPlan {
  if (!options.success) {
    return { kind: 'stop', state: options.state }
  }

  if (options.skipped) {
    const state = nextAgentLoopCompactState(options.state, {
      keepRecentTurns: options.state.keepRecentTurns - 1,
      pass: options.state.pass + 1,
    })
    return state.keepRecentTurns <= 0 || state.pass > state.configuredKeepTurns
      ? { kind: 'stop', state }
      : { kind: 'retry', state }
  }

  return { kind: 'stop', state: nextAgentLoopCompactState(options.state, { compacted: true }) }
}

/**
 * 2026-08-23:hard-limit 触发删除之后,压缩收尾只剩"压过就重建历史"一条路 ——
 * 压缩轮次跑完仍然超阈值,循环就带着现有历史继续走(与既有 'stop' 路径同款),
 * 不再抛错早退。
 */
export function planAgentLoopContextCompactFinal(options: {
  state: CoreAgentLoopCompactState
}): CoreAgentLoopCompactFinalPlan {
  return options.state.compacted ? { kind: 'rebuild' } : { kind: 'none' }
}

export function buildAgentLoopContextCompactEventPlan(
  result: CoreAgentLoopCompactResultLike,
): CoreAgentLoopCompactEventPlan[] {
  const events: CoreAgentLoopCompactEventPlan[] = [{
    type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_COMPLETED,
    success: result.success,
    skipped: result.skipped,
    summary: result.summary,
    error: result.error,
  }]
  if (result.success && !result.skipped) {
    events.push({
      type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED,
      contextSize: result.retainedContextSize ?? 0,
    })
  }
  return events
}

export async function maybeCompactAgentLoopContextWithAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
>(
  options: MaybeCompactAgentLoopContextOptions<TSettings, TProviderConfig, TSession, TMessage, TCompactResult>,
): Promise<TMessage[] | undefined> {
  const { ctx, adapters } = options
  const logger = toLogger(adapters.logger)

  if (!shouldStartAgentLoopContextCompact({
    turn: options.turn,
    providerId: ctx.providerId,
    compactEnabled: options.compactEnabled,
  })) return undefined

  let compactState = createAgentLoopCompactState(options.keepRecentTurns)

  while (true) {
    const session = adapters.getSession(ctx.sessionId)
    const usage = session
      ? buildContextUsageSnapshot({
          session,
          historyMessages: !compactState.compacted && options.messages.length > 0
            ? options.messages as unknown[]
            : undefined,
          modelContextLength: options.budget.modelContextLength,
          thresholdPercent: options.budget.thresholdPercent,
          providerId: ctx.providerId,
          model: (ctx.providerConfig as { model?: string }).model,
        })
      : undefined
    if (
      session &&
      usage &&
      (session.contextSize !== usage.visibleInputTokens ||
        session.lastInputTokens !== usage.visibleInputTokens)
    ) {
      await adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED,
        contextSize: usage.visibleInputTokens,
      })
    }
    const providerUsageMismatch = session
      ? adapters.shouldSkipProviderUsageMismatch?.({
          providerId: ctx.providerId,
          session,
          modelContextLength: options.budget.modelContextLength,
          inputTokens: usage?.visibleInputTokens,
        }) ?? false
      : false
    const passPlan = planAgentLoopContextCompactPass({
      state: compactState,
      session: session ?? undefined,
      providerId: ctx.providerId,
      budget: options.budget,
      providerUsageMismatch,
      inputTokens: usage?.visibleInputTokens,
    })

    if (passPlan.kind === 'stop') break

    if (passPlan.kind === 'skip-provider-usage-mismatch') {
      logger.warn('[AgentLoopRuntime] Skipping context compact because provider usage exceeds registered model context length:', {
        sessionId: ctx.sessionId,
        providerId: ctx.providerId,
        model: (ctx.providerConfig as { model?: unknown }).model,
        contextSize: usage?.visibleInputTokens ?? session?.contextSize ?? session?.lastInputTokens ?? 0,
        modelContextLength: options.budget.modelContextLength,
        source: usage?.source,
      })
      return undefined
    }

    logger.debug('[ContextUsage] decision', {
      sessionId: ctx.sessionId,
      providerId: ctx.providerId,
      model: (ctx.providerConfig as { model?: unknown }).model,
      visibleInputTokens: usage?.visibleInputTokens,
      effectiveInputTokens: usage?.effectiveInputTokens,
      providerInputTokens: usage?.providerInputTokens,
      requestEstimatedInputTokens: usage?.requestEstimatedInputTokens,
      modelContextLength: usage?.modelContextLength ?? options.budget.modelContextLength,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      thresholdPercent: usage?.thresholdPercent ?? options.budget.thresholdPercent,
      reason: passPlan.reason,
      source: usage?.source,
      historyMessageCount: usage?.details.historyMessageCount,
      summaryUsed: usage?.details.summaryUsed,
      turn: options.turn,
    })
    logger.debug('[AgentLoopRuntime] Context compact triggered before agent turn', {
      sessionId: ctx.sessionId,
      model: (ctx.providerConfig as { model?: unknown }).model,
      turn: options.turn,
      modelContextLength: options.budget.modelContextLength,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      keepRecentTurns: passPlan.keepRecentTurns,
      pass: passPlan.pass,
      reason: passPlan.reason,
    })

    const result = await adapters.compactSessionContext({
      sessionId: ctx.sessionId,
      providerId: ctx.providerId,
      configWithApiKey: configWithApiKey(ctx.providerConfig),
      settings: ctx.settings,
      keepRecentTurns: passPlan.keepRecentTurns,
      onMessageCreated: message => adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_CREATED,
        message,
      }),
      onMessageUpdated: (messageId, updates) => adapters.emitEvent(ctx.sessionId, {
        type: SESSION_EVENT_TYPES.MESSAGE_UPDATED,
        messageId,
        updates,
      }),
    })

    try {
      for (const event of buildAgentLoopContextCompactEventPlan(result)) {
        await adapters.emitEvent(ctx.sessionId, event)
      }
    } catch (error) {
      logger.error('[AgentLoopRuntime] context compact event emit error:', undefined, error)
    }

    const resultPlan = applyAgentLoopContextCompactResult({
      state: compactState,
      reason: passPlan.reason,
      success: result.success,
      skipped: result.skipped,
    })
    compactState = resultPlan.state

    if (!result.success) return undefined

    if (resultPlan.kind === 'retry') continue
    break
  }

  const finalPlan = planAgentLoopContextCompactFinal({ state: compactState })

  return finalPlan.kind === 'rebuild' ? adapters.rebuildMessages() : undefined
}

export function getAgentLoopTransientTail<TMessage extends CoreAgentLoopMessage>(messages: TMessage[]): TMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      return messages.slice(index).map(item => ({ ...item }))
    }
  }
  return []
}

export function buildPendingAgentLoopMessageInjections<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(
  messages: TMessage[],
  pendingMessages: Array<CoreResolvedPendingAgentLoopMessage<TContentParts>>,
): CorePendingAgentLoopInjectionResult<TMessage, TContentParts> | undefined {
  if (pendingMessages.length === 0) return undefined

  const nextMessages: Array<TMessage | CorePendingAgentLoopRuntimeMessage> = messages.map(message => ({ ...message }))
  const chatMessages: Array<CorePendingAgentLoopChatMessage<TContentParts>> = []

  for (const pending of pendingMessages) {
    nextMessages.push({ role: 'user', content: pending.modelContent })
    chatMessages.push({
      id: pending.id,
      role: 'user',
      content: pending.modelContent,
      timestamp: pending.timestamp,
      contentParts: pending.contentParts,
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
      ...(pending.persisted ? { persisted: true } : {}),
    })
  }

  return {
    messages: nextMessages,
    chatMessages,
  }
}

export async function injectPendingAgentLoopMessagesWithAdapters<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(options: {
  messages: TMessage[]
  pendingMessages: CorePendingAgentLoopInputMessage[]
  adapters: CoreAgentLoopPendingMessageAdapters<TContentParts>
}): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const resolvedPendingMessages = resolvePendingAgentLoopMessages<TContentParts>(
    options.pendingMessages,
    {
      createId: options.adapters.createPendingMessageId,
      resolvePromptReferences: options.adapters.resolvePromptReferences,
    },
  )
  const injection = buildPendingAgentLoopMessageInjections<TMessage, TContentParts>(
    options.messages,
    resolvedPendingMessages,
  )
  if (!injection) return undefined

  for (const chatMessage of injection.chatMessages) {
    if (chatMessage.persisted) continue
    await options.adapters.persistInjectedChatMessage({
      id: chatMessage.id,
      role: chatMessage.role,
      content: chatMessage.content,
      timestamp: chatMessage.timestamp,
      contentParts: chatMessage.contentParts,
      ...(chatMessage.origin !== undefined ? { origin: chatMessage.origin } : {}),
    })
  }

  return injection.messages
}

export function resolvePendingAgentLoopMessages<TContentParts = unknown>(
  pendingMessages: CorePendingAgentLoopInputMessage[],
  options: {
    resolvePromptReferences: (content: string) => CorePendingAgentLoopPromptResolution<TContentParts>
    createId: () => string
  },
): CoreResolvedPendingAgentLoopMessage<TContentParts>[] {
  return pendingMessages.map(pending => {
    if (typeof pending.modelContent === 'string') {
      return {
        id: pending.id ?? options.createId(),
        modelContent: pending.modelContent,
        timestamp: pending.timestamp,
        contentParts: pending.contentParts as TContentParts | undefined,
        ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
        ...(pending.persisted ? { persisted: true } : {}),
      }
    }

    const resolvedPromptRefs = options.resolvePromptReferences(pending.content)
    return {
      id: pending.id ?? options.createId(),
      modelContent: resolvedPromptRefs.modelContent,
      timestamp: pending.timestamp,
      contentParts: resolvedPromptRefs.contentParts,
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
      ...(pending.persisted ? { persisted: true } : {}),
    }
  })
}

function isEphemeralTailMessage(message: { role?: string, content?: unknown }): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(CORE_EPHEMERAL_TAIL_SENTINEL)
}

/**
 * 把瞬态尾块换成新的一块。返回 undefined = 没有任何变化(数组原样,调用方不必
 * 重建)。
 *
 * 三种情况:
 *  - 没有适配器 / 适配器返回 undefined → 剥掉在场的旧块(纸被清空了就不该还挂着),
 *    没有旧块则原样返回 undefined。
 *  - 在场那块版本相同 → **原样保留**,不重挂也不发回调(逐字去重,免得同一
 *    版本在账上被消费两次)。
 *  - 其余 → 剥旧 + push 新 + 回调。
 */
export async function applyAgentLoopEphemeralTail<TMessage extends CoreAgentLoopMessage>(options: {
  messages: CoreAgentLoopTurnMessages<TMessage>
  turn: number
  adapters: CoreAgentLoopEphemeralTailAdapters
}): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const { messages, adapters } = options
  const existingIndex = messages.findIndex(isEphemeralTailMessage)
  const tail = adapters.buildEphemeralTail
    ? await adapters.buildEphemeralTail(options.turn)
    : undefined

  if (!tail) {
    if (existingIndex < 0) return undefined
    return messages.filter(message => !isEphemeralTailMessage(message))
  }

  if (existingIndex >= 0) {
    const existing = messages[existingIndex]
    if (typeof existing.content === 'string' && existing.content === tail.text) {
      // 已经在场且逐字相同 —— 什么都不做才是对的。
      return undefined
    }
  }

  const next: CoreAgentLoopTurnMessages<TMessage> = messages.filter(
    message => !isEphemeralTailMessage(message),
  )
  next.push({ role: 'user', content: tail.text })
  adapters.onEphemeralTailInjected?.({ turn: options.turn, version: tail.version })
  return next
}

export async function runAgentLoopBeforeTurnWithAdapters<
  TSettings,
  TProviderConfig extends object,
  TSession extends CoreAgentLoopCompactSessionLike,
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
  TCompactResult extends CoreAgentLoopCompactResultLike = CoreAgentLoopCompactResultLike,
>(
  options: RunAgentLoopBeforeTurnWithAdaptersOptions<
    TSettings,
    TProviderConfig,
    TSession,
    TMessage,
    TContentParts,
    TCompactResult
  >,
): Promise<CoreAgentLoopBeforeTurnResult<TMessage> | undefined> {
  let nextMessages: CoreAgentLoopTurnMessages<TMessage> = options.messages
  // F9:「这一轮到底换没换消息」用显式标记记,不靠 `nextMessages === options.messages`
  // 比引用 —— COW 之后身份判断随时可能恒为假(上游换了数组,内容却一字未动),
  // 那样这条路会把"什么都没发生"报成"重开一条回复"。
  let changed = false
  const pendingSteeringMessages = options.adapters.drainSteeringMessages?.() ?? []
  const injectedMessages = await injectPendingAgentLoopMessagesWithAdapters({
    messages: nextMessages as TMessage[],
    pendingMessages: pendingSteeringMessages,
    adapters: options.adapters,
  })
  const startNewResponse = Boolean(injectedMessages)
  if (injectedMessages) {
    nextMessages = injectedMessages
    changed = true
  }

  const compactAdapters: CoreAgentLoopCompactionAdapters<
    TSettings,
    TProviderConfig,
    TSession,
    TMessage,
    TCompactResult
  > = {
    getSession: options.adapters.getSession,
    compactSessionContext: options.adapters.compactSessionContext,
    emitEvent: options.adapters.emitEvent,
    shouldSkipProviderUsageMismatch: options.adapters.shouldSkipProviderUsageMismatch,
    logger: options.adapters.logger,
    rebuildMessages: () => options.rebuildMessages(nextMessages),
  }
  const compactedMessages = await maybeCompactAgentLoopContextWithAdapters({
    ctx: options.ctx,
    turn: options.turn,
    messages: nextMessages as TMessage[],
    budget: options.budget,
    compactEnabled: options.compactEnabled,
    keepRecentTurns: options.keepRecentTurns,
    adapters: compactAdapters,
  })
  if (compactedMessages) {
    // 压缩 rebuild 是从会话历史重新拼的,天然不含尾块 —— 所以压完之后要重新挂,
    // 而不是"压缩后这一轮就没有草稿纸了"。
    const compactedWithTail = await applyAgentLoopEphemeralTail({
      messages: compactedMessages,
      turn: options.turn,
      adapters: options.adapters,
    })
    return { messages: compactedWithTail ?? compactedMessages, startNewResponse }
  }

  // 尾块最后挂:它是**瞬态**的,不该参与上面那两处按历史算的预算判定
  // (算进去等于让一块随时会消失的内容去触发压缩)。
  const withTail = await applyAgentLoopEphemeralTail({
    messages: nextMessages,
    turn: options.turn,
    adapters: options.adapters,
  })
  if (withTail) {
    nextMessages = withTail
    changed = true
  }

  return changed ? { messages: nextMessages, startNewResponse } : undefined
}

export async function runAgentLoopAfterTurnWithAdapters<
  TMessage extends CoreAgentLoopMessage,
  TContentParts = unknown,
>(
  options: RunAgentLoopAfterTurnWithAdaptersOptions<TMessage, TContentParts>,
): Promise<CoreAgentLoopTurnMessages<TMessage> | undefined> {
  const steeringMessages = options.adapters.drainSteeringMessages?.() ?? []
  if (steeringMessages.length > 0) {
    return injectPendingAgentLoopMessagesWithAdapters({
      messages: options.messages,
      pendingMessages: steeringMessages,
      adapters: options.adapters,
    })
  }

  const followUpMessages = options.adapters.drainFollowUpMessages?.() ?? []
  return injectPendingAgentLoopMessagesWithAdapters({
    messages: options.messages,
    pendingMessages: followUpMessages,
    adapters: options.adapters,
  })
}
