import {
  CORE_PROMPT_ORDER_PLUGIN,
  type CoreBuildPromptContextOptions,
  type CorePromptActiveProject,
  type CorePromptFragment,
  type CorePromptKnownProjects,
  type CorePromptProviderConfig,
  type CorePromptProviderConfigValue,
} from '@onething/core/engine'
import type { PromptSource } from './composer.js'
import {
  CORE_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS,
  isCorePluginTimeoutError,
  runWithPluginTimeout,
} from '@onething/core/plugins'

export type OnethingPromptContextRole = 'system' | 'developer' | 'user'
export type OnethingPromptProviderConfigValue = CorePromptProviderConfigValue
export type OnethingPromptProviderConfig = CorePromptProviderConfig

export interface OnethingPromptSkillDefinition {
  name: string
  description: string
  source: string
  directoryPath?: string
  path?: string
  files?: Array<{ name: string }>
  instructions?: string
}

export interface OnethingPluginPromptContext {
  sessionId?: string
  /**
   * 这一回合归属的 agent(F4 身份面)。**纯透传**:值就是回合入口解析好的那一个
   * (`preparation.agentId`,源头是会话级 `agentId`),不是在这里现查 ——
   * 现查会让同一回合的三处身份口径各自漂。
   *
   * 缺省 undefined = 这条会话没有绑 agent。插件的 agent scope 读取公式
   * ("自己的 scope + global")就以它为依据;拿不到 agent 时只剩 global,
   * 那是正确的降级,不是错误。
   */
  agentId?: string
  providerId?: string
  model?: string
  providerConfig?: OnethingPromptProviderConfig
  settings?: unknown
  hasTools: boolean
  skills: OnethingPromptSkillDefinition[]
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  activeProject?: CorePromptActiveProject
  knownProjects?: CorePromptKnownProjects
  toolNames?: string[]
  mcpToolNames?: string[]
}

export interface OnethingPluginPromptContextFragmentInput {
  role: OnethingPromptContextRole
  source?: string
  content: string
  /**
   * Which provider produced it. Stamped by the collector, never by the plugin —
   * it is the identity the turn-channel block dedupes on
   * (`plugin:<pluginId>/<providerId>`), so it must not be forgeable.
   */
  pluginId?: string
  providerId?: string
}

export type OnethingPluginPromptContextProvider = (
  context: OnethingPluginPromptContext,
) =>
  | Promise<OnethingPluginPromptContextFragmentInput | OnethingPluginPromptContextFragmentInput[] | string | null | undefined>
  | OnethingPluginPromptContextFragmentInput
  | OnethingPluginPromptContextFragmentInput[]
  | string
  | null
  | undefined

export interface OnethingPluginPromptContextFailure {
  pluginId: string
  providerId: string
  error: unknown
  timedOut: boolean
}

export interface OnethingPluginPromptContextSuccess {
  pluginId: string
  providerId: string
}

export interface CollectOnethingPluginPromptContextOptions {
  onProviderError?: (providerRef: string, error: unknown) => void
  /** 结构化失败上报 —— 失败计数熔断按 pluginId + scope 记账。 */
  onProviderFailure?: (failure: OnethingPluginPromptContextFailure) => void
  /**
   * 成功上报 —— 没有它,promptContext 这条车道的连败计数永远清不掉,
   * 一个偶发超时会跨天累加成误禁。必须是零 IO 的纯内存回调(它在每次发消息的
   * 热路径上,每个 provider 各调一次)。
   */
  onProviderSuccess?: (success: OnethingPluginPromptContextSuccess) => void
  /** 每个 provider 的超时预算;<=0 关闭(仅测试用)。 */
  timeoutMs?: number
}

interface RegisteredProvider {
  pluginId: string
  providerId: string
  provider: OnethingPluginPromptContextProvider
}

const providers = new Map<string, RegisteredProvider>()

export function normalizeInjectedPromptContextRole(_role: OnethingPromptContextRole): OnethingPromptContextRole {
  return 'developer'
}

function key(pluginId: string, providerId: string): string {
  return `${pluginId}:${providerId}`
}

export function normalizePromptContextProviderId(value: string): string {
  return value.trim().replace(/^\/+/, '') || 'default'
}

export function registerPromptContextProvider(
  pluginId: string,
  providerId: string,
  provider: OnethingPluginPromptContextProvider,
): () => void {
  const normalizedId = normalizePromptContextProviderId(providerId)
  const providerKey = key(pluginId, normalizedId)
  providers.set(providerKey, { pluginId, providerId: normalizedId, provider })

  return () => {
    providers.delete(providerKey)
  }
}

export async function collectPluginPromptContext(
  context: OnethingPluginPromptContext,
  options: CollectOnethingPluginPromptContextOptions = {},
): Promise<OnethingPluginPromptContextFragmentInput[]> {
  const fragments: OnethingPluginPromptContextFragmentInput[] = []
  const timeoutMs = options.timeoutMs ?? CORE_PLUGIN_PROMPT_CONTEXT_TIMEOUT_MS

  for (const item of [...providers.values()]) {
    try {
      // 这里挂在**每次发消息**的热路径上(prompts/builder.ts 的 collectPlugins)。
      // 之前是裸 await:一个不 resolve 的 provider = 所有会话的发消息永久卡死,
      // 而插件卡片还显示 Active。超时后丢弃这一段,绝不阻塞发消息。
      const result = await runWithPluginTimeout(
        `promptContext:${item.pluginId}/${item.providerId}`,
        timeoutMs,
        () => item.provider(context),
      )
      const entries = Array.isArray(result) ? result : [result]
      for (const entry of entries) {
        if (!entry) continue
        if (typeof entry === 'string') {
          fragments.push({
            role: 'developer',
            source: `plugins/${item.pluginId}/${item.providerId}`,
            content: entry,
            pluginId: item.pluginId,
            providerId: item.providerId,
          })
          continue
        }
        fragments.push({
          role: normalizeInjectedPromptContextRole(entry.role),
          source: entry.source || `plugins/${item.pluginId}/${item.providerId}`,
          content: entry.content,
          pluginId: item.pluginId,
          providerId: item.providerId,
        })
      }
      options.onProviderSuccess?.({ pluginId: item.pluginId, providerId: item.providerId })
    } catch (error) {
      options.onProviderError?.(`${item.pluginId}/${item.providerId}`, error)
      options.onProviderFailure?.({
        pluginId: item.pluginId,
        providerId: item.providerId,
        error,
        timedOut: isCorePluginTimeoutError(error),
      })
    }
  }

  return fragments
}

export function clearPromptContextProvidersForPlugin(pluginId: string): void {
  for (const item of providers.values()) {
    if (item.pluginId === pluginId) {
      providers.delete(key(item.pluginId, item.providerId))
    }
  }
}

export function getPromptContextProviderCount(): number {
  return providers.size
}

export function clearAllPromptContextProviders(): void {
  providers.clear()
}

/** The group name that switches every plugin provider off at once. */
export const PLUGIN_PROMPT_GROUP = 'plugins'

/**
 * Plugin providers as a `PromptSource`. The host constructs it with the
 * health callbacks (timeout / failure / success → breaker); the product
 * default composer constructs it bare.
 *
 * Provider output is recomputed every turn by definition, so it rides the
 * **turn channel** — it never belonged in a prefix that is supposed to be
 * identical across sessions. Each provider gets its own block id
 * (`plugin:<pluginId>/<providerId>`) so a chatty provider does not force a
 * quiet one to re-send; they all share the group `plugins`, which is what
 * `disabledSections: ['plugins']` (collab rooms) still keys on.
 */
export class PluginPromptContextSource implements PromptSource {
  readonly name = 'plugins'

  constructor(private readonly options: CollectOnethingPluginPromptContextOptions = {}) {}

  async collect(ctx: CoreBuildPromptContextOptions): Promise<CorePromptFragment[]> {
    const fragments = await collectPluginPromptContext(pluginPromptContextFrom(ctx), this.options)
    return fragments.map(fragment => ({
      id: pluginPromptBlockId(fragment),
      slot: 'section' as const,
      channel: 'turn' as const,
      group: PLUGIN_PROMPT_GROUP,
      source: fragment.source ?? 'plugin',
      order: CORE_PROMPT_ORDER_PLUGIN,
      content: fragment.content,
    }))
  }
}

/**
 * The dedupe key of one provider's block. Falls back to the group name when a
 * fragment predates the stamped identity — one shared block is a degraded
 * dedupe, never a lost paragraph.
 */
export function pluginPromptBlockId(
  fragment: Pick<OnethingPluginPromptContextFragmentInput, 'pluginId' | 'providerId'>,
): string {
  if (!fragment.pluginId) return PLUGIN_PROMPT_GROUP
  return `plugin:${fragment.pluginId}/${fragment.providerId ?? 'default'}`
}

/** The slice of the build context a plugin provider is allowed to see. */
export function pluginPromptContextFrom(ctx: CoreBuildPromptContextOptions): OnethingPluginPromptContext {
  const providerModel = ctx.providerConfig?.model
  return {
    sessionId: ctx.sessionId,
    // F4:身份透传。ctx.agentId 是回合入口解析好的那一个,与 persona 取的是
    // 同一个字段,所以插件看到的身份与提示词里的身份恒一致。
    agentId: ctx.agentId,
    providerId: ctx.providerId,
    model: ctx.model?.trim()
      || (typeof providerModel === 'string' && providerModel.trim() ? providerModel.trim() : undefined),
    providerConfig: ctx.providerConfig,
    settings: ctx.settings,
    hasTools: ctx.hasTools,
    skills: ctx.skills,
    workingDirectory: ctx.workingDirectory,
    workingDirectoryRoots: ctx.workingDirectoryRoots,
    activeProject: ctx.activeProject,
    knownProjects: ctx.knownProjects,
    toolNames: ctx.toolNames,
    mcpToolNames: ctx.mcpToolNames,
  }
}
