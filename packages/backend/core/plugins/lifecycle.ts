import {
  CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS,
  runWithPluginTimeout,
} from './runtime-guard.js'
import { toLogger, type CompatLogger, type Logger } from '../logging/index.js'

export interface CoreBeforeContextCompactContext<
  TSettings = unknown,
  TMessage = unknown,
  TConfigWithApiKey = unknown,
> {
  sessionId: string
  providerId: string
  configWithApiKey: TConfigWithApiKey
  settings: TSettings
  keepRecentTurns?: number
  messagesToSummarize: TMessage[]
}

/**
 * beforeContextCompact 的**返回契约**(N7-a)。
 *
 * 老钩子返回 `void` 继续走宿主自压(append-only:加一个可选返回值,不破坏任何
 * 既有钩子)。返回了非空 `summary` 的钩子,宿主**跳过默认压缩**,直接用它写会话
 * 摘要 —— 这就是"插件从搬运升到判断"的那一步。
 */
export interface CoreBeforeContextCompactResult {
  /** 替换宿主默认压缩的摘要。空串 / 省略 = 不替换,继续宿主自压。 */
  summary?: string
}

/**
 * 替换摘要的硬长度上界。它要写进一条 compact 消息并回灌进后续请求的上下文,
 * 不能无界 —— 超限硬截。约 20k 字符足够一份结构化的多轮摘要,又短到不会把
 * "压缩"本身变成新的膨胀源。
 */
export const CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS = 20_000

/** 胜出的替换摘要 + 归属(记日志:谁替换了宿主压缩)。 */
export interface CoreBeforeContextCompactOutcome {
  /** 规范化(trim + 非空 + 长度约束)之后的替换摘要。 */
  summary: string
  pluginId: string
  hookId: string
}

/** 替换摘要的宿主约束:非字符串 / 空串 = 无替换;超长硬截。 */
function normalizeReplacementSummary(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length <= CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS)
}

export type CoreBeforeContextCompactHook<TContext = CoreBeforeContextCompactContext> = (
  context: TContext,
) => Promise<CoreBeforeContextCompactResult | void> | CoreBeforeContextCompactResult | void

export interface CoreAfterAssistantResponseContext<
  TSettings = unknown,
  TSession = unknown,
  TMessage = unknown,
  TProviderConfig = unknown,
> {
  sessionId: string
  assistantMessageId: string
  /**
   * F4 身份面:这一回合归属的 agent(纯透传,零新状态)。与 promptContext /
   * 工具 ctx 的同名字段是**同一个语义**。缺省 undefined = 没绑 agent。
   *
   * 注意这条钩子在 collab 会话上根本不跑(装配层 isCollabSession 门控),所以
   * "协调器逐次翻 session.agentId" 那个危险在这条线上不成立。
   */
  agentId?: string
  session: TSession
  messages: TMessage[]
  lastUserMessage: string
  lastAssistantMessage: string
  providerId: string
  providerConfig: TProviderConfig
  settings: TSettings
}

export type CoreAfterAssistantResponseHook<TContext = CoreAfterAssistantResponseContext> = (
  context: TContext,
) => Promise<void> | void

interface RegisteredPluginHook<THook> {
  pluginId: string
  hookId: string
  hook: THook
}

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginLifecycleLogger = CompatLogger

export interface CorePluginLifecycleRegistryOptions {
  logger?: CorePluginLifecycleLogger
  /** 每个钩子的超时预算;<=0 关闭超时。 */
  timeoutMs?: number
  /** 钩子超时或抛错时回调,供失败计数熔断消费。 */
  onHookFailure?(input: { pluginId: string; hookId: string; scope: string; error: unknown }): void
  onHookSuccess?(input: { pluginId: string; hookId: string; scope: string }): void
}

export class CorePluginLifecycleRegistry<
  TBeforeContext = CoreBeforeContextCompactContext,
  TAfterContext = CoreAfterAssistantResponseContext,
> {
  private beforeCompactHooks = new Map<string, RegisteredPluginHook<CoreBeforeContextCompactHook<TBeforeContext>>>()
  private afterResponseHooks = new Map<string, RegisteredPluginHook<CoreAfterAssistantResponseHook<TAfterContext>>>()
  private readonly logger: Logger
  private readonly options: CorePluginLifecycleRegistryOptions

  constructor(loggerOrOptions: CorePluginLifecycleLogger | CorePluginLifecycleRegistryOptions = {}) {
    const options: CorePluginLifecycleRegistryOptions = typeof (loggerOrOptions as { error?: unknown }).error === 'function'
      ? { logger: loggerOrOptions as CorePluginLifecycleLogger }
      : (loggerOrOptions as CorePluginLifecycleRegistryOptions)
    this.options = options
    this.logger = toLogger(options.logger)
  }

  registerBeforeContextCompactHook(
    pluginId: string,
    hookId: string,
    hook: CoreBeforeContextCompactHook<TBeforeContext>,
  ): () => void {
    const hookKey = this.key(pluginId, hookId)
    this.beforeCompactHooks.set(hookKey, {
      pluginId,
      hookId,
      hook,
    })
    return () => {
      this.beforeCompactHooks.delete(hookKey)
    }
  }

  registerAfterAssistantResponseHook(
    pluginId: string,
    hookId: string,
    hook: CoreAfterAssistantResponseHook<TAfterContext>,
  ): () => void {
    const hookKey = this.key(pluginId, hookId)
    this.afterResponseHooks.set(hookKey, {
      pluginId,
      hookId,
      hook,
    })
    return () => {
      this.afterResponseHooks.delete(hookKey)
    }
  }

  /**
   * N7-a:可返回替换摘要。逐钩子跑(每个带超时预算),**第一个**返回非空 summary
   * 的胜出,后续钩子不再询问(它们的观察副作用此前已发生)。
   *
   * **fail-open**:任一钩子抛错 / 超时被当作"没返回摘要",继续问下一个;全体都没
   * 返回则回 undefined,调用方回落宿主自压 —— 压缩坏了绝不能让会话卡住。
   * 失败仍进 onHookFailure(熔断账),与 afterAssistantResponse 同规。
   */
  async runBeforeContextCompactHooks(
    context: TBeforeContext,
  ): Promise<CoreBeforeContextCompactOutcome | undefined> {
    const timeoutMs = this.options.timeoutMs ?? CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS
    const scope = 'beforeContextCompact'
    for (const item of [...this.beforeCompactHooks.values()]) {
      const label = `${item.pluginId}/${item.hookId}`
      try {
        const result = await runWithPluginTimeout(`${scope}:${label}`, timeoutMs, () =>
          item.hook(context))
        this.options.onHookSuccess?.({ pluginId: item.pluginId, hookId: item.hookId, scope })
        const summary = normalizeReplacementSummary(
          (result as CoreBeforeContextCompactResult | void | undefined)?.summary,
        )
        if (summary) {
          return { summary, pluginId: item.pluginId, hookId: item.hookId }
        }
      } catch (error) {
        this.logger.error(`[PluginLifecycle] ${scope} failed for "${label}":`, undefined, error)
        this.options.onHookFailure?.({ pluginId: item.pluginId, hookId: item.hookId, scope, error })
      }
    }
    return undefined
  }

  async runAfterAssistantResponseHooks(context: TAfterContext): Promise<void> {
    await this.runHooks('afterAssistantResponse', this.afterResponseHooks, context)
  }

  /**
   * 逐钩子跑,每个都带超时预算。
   *
   * 之前这里是裸 await:一个不 resolve 的钩子会把上下文压缩(以及排在它后面的
   * 所有钩子)永久挂住。catch 挡得住抛错,挡不住挂起。
   */
  private async runHooks<TContext, THook extends (context: TContext) => Promise<void> | void>(
    scope: string,
    hooks: Map<string, RegisteredPluginHook<THook>>,
    context: TContext,
  ): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? CORE_PLUGIN_LIFECYCLE_HOOK_TIMEOUT_MS
    for (const item of [...hooks.values()]) {
      const label = `${item.pluginId}/${item.hookId}`
      try {
        await runWithPluginTimeout(`${scope}:${label}`, timeoutMs, () => item.hook(context))
        this.options.onHookSuccess?.({ pluginId: item.pluginId, hookId: item.hookId, scope })
      } catch (error) {
        this.logger.error(`[PluginLifecycle] ${scope} failed for "${label}":`, undefined, error)
        this.options.onHookFailure?.({
          pluginId: item.pluginId,
          hookId: item.hookId,
          scope,
          error,
        })
      }
    }
  }

  clearLifecycleHooksForPlugin(pluginId: string): void {
    for (const item of this.beforeCompactHooks.values()) {
      if (item.pluginId === pluginId) {
        this.beforeCompactHooks.delete(this.key(item.pluginId, item.hookId))
      }
    }
    for (const item of this.afterResponseHooks.values()) {
      if (item.pluginId === pluginId) {
        this.afterResponseHooks.delete(this.key(item.pluginId, item.hookId))
      }
    }
  }

  clear(): void {
    this.beforeCompactHooks.clear()
    this.afterResponseHooks.clear()
  }

  getHookCounts(): { beforeContextCompact: number; afterAssistantResponse: number } {
    return {
      beforeContextCompact: this.beforeCompactHooks.size,
      afterAssistantResponse: this.afterResponseHooks.size,
    }
  }

  private key(pluginId: string, hookId: string): string {
    return `${pluginId}:${hookId.trim() || 'default'}`
  }
}
