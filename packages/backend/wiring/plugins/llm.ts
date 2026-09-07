/**
 * N7-b 的**装配层实现**:受管 LLM 调用口。
 *
 * 协议在 core(`@onething/core/plugins` 的 llm.ts):权限枚举、披露文案、受管常量、
 * 请求/结果形状、结构化错误、纯校验。这里放**受管三要素** —— 与 pi 的裸
 * `ctx.modelRegistry` 的全部差异都在这一个文件里:
 *
 *  1. **provider 解析**:走宿主自己的 provider 解析(默认聊天 provider + 它的 apiKey),
 *     复用 summarizeInChunks 拿 provider+apiKey 的同一条 `generateChatResponse` 路径。
 *     插件**永远拿不到 apiKey / registry** —— 它只交出 messages,拿回 text。
 *  2. **计费**:每次调用记进 usage 账本,`source = plugin:<id>`。账本已有 source
 *     维度,于是用户在用量页看得见"哪个插件烧了多少 token"。
 *  3. **超时 + 配额**:硬超时(PLUGIN_LLM_COMPLETE_TIMEOUT_MS)防单次挂住压缩路径;
 *     按插件的滚动窗口频率闸(PLUGIN_LLM_RATE_LIMIT / 窗口)防"compact 钩子里
 *     无限调 LLM"那条不收敛的账。
 *
 * ## 配额口径(诚实说明它按插件、不按会话)
 *
 * 规格写的是"每插件每会话",但 `api.llm.complete({messages})` **不携带会话**
 * (插件可以在事件 handler / 定时任务 / compact 钩子里任何地方调它)。与 N1 的
 * 循环闸同一条道理:让插件自己传 sessionId 会让闸可被规避(传假的就永远不超)。
 * 所以这里按**插件**计频 —— 它兜住的正是规格担心的那条(一个插件在钩子里狂调),
 * 而按插件恰好不可规避。见交付报告的"与规格差异"。
 */
import {
  PLUGIN_LLM_COMPLETE_TIMEOUT_MS,
  PLUGIN_LLM_RATE_LIMIT,
  PLUGIN_LLM_RATE_WINDOW_MS,
  PluginLlmError,
  clampPluginLlmMaxTokens,
  type PluginLlmCompleteOptions,
  type PluginLlmCompleteResult,
} from '@onething/core/plugins'

import { QuiescibleScopes } from '@onething/core/lifecycle'
import { getSettings } from '../../stores/settings.js'
import { resolveProviderApiKey } from '@onething/runtime/providers/env.wiring'
import { resolveUtilityModel } from '@onething/runtime/providers/utility-model.wiring'
import { generateChatResponse } from '../providers/index.js'
import { captureUsageRecorder } from '../usage/index.js'
import type { ProviderConfigWithKey } from '../engine/stream/stream-executor.js'
import { getLogger } from '../logging/index.js'
import { getCurrentBackendInstance } from '../../current.js'

const log = getLogger('plugins')


/* ── 配额:每插件的调用时刻环 ─────────────────────────────────────────────── */

/** 超限即抛(不入账);未超则记一次时刻并放行。 */
function enforceQuota(rateWindows: Map<string, number[]>, pluginId: string, now: number): void {
  const window = (rateWindows.get(pluginId) ?? []).filter(at => now - at < PLUGIN_LLM_RATE_WINDOW_MS)
  if (window.length >= PLUGIN_LLM_RATE_LIMIT) {
    rateWindows.set(pluginId, window)
    throw new PluginLlmError(
      'quota',
      `llm.complete quota exceeded: more than ${PLUGIN_LLM_RATE_LIMIT} calls within `
      + `${PLUGIN_LLM_RATE_WINDOW_MS}ms for plugin "${pluginId}"`,
    )
  }
  window.push(now)
  rateWindows.set(pluginId, window)
}

/* ── provider 解析(默认聊天 provider + 它的 apiKey)─────────────────────────── */

interface ResolvedManagedProvider {
  providerId: string
  config: ProviderConfigWithKey
}

/**
 * 走宿主的 provider 解析。解析不出(没配 provider / 没模型)→ null,调用方抛
 * `unsupported`。
 *
 * **路由口径(2026-08-12 用户裁决:整理类的活走工具模型)**:先问
 * `settings.tools.toolCallModel`,没配才回落当前默认聊天 provider —— 与
 * `createUtilityProvider` **同一个解析器**(`resolveUtilityModel`),而不是在这里
 * 再抄一份判据。理由与那份注释里写的一样:插件的 `llm.complete` 是后台工作
 * (提取、摘要、分类),不该默默烧用户正在聊天的那个贵模型。
 *
 * 回落是刻意开着的(`fallbackToChatProvider: true`):没配工具模型时行为与改动前
 * **逐字节相同**,所以这不是一次会让既有插件失灵的变更。
 */
function resolveManagedProvider(): ResolvedManagedProvider | null {
  const settings = getSettings()
  const resolved = resolveUtilityModel(settings, true)
  if (!resolved) return null
  const providerConfig = settings.ai?.providers?.[resolved.providerId]
  if (!providerConfig) return null
  const apiKey = resolveProviderApiKey(resolved.providerId, providerConfig) || ''
  return {
    providerId: resolved.providerId,
    config: { ...providerConfig, model: resolved.model, apiKey } as ProviderConfigWithKey,
  }
}

/* ── 受管调用 ─────────────────────────────────────────────────────────────── */

/**
 * `api.llm.complete` 的宿主落点。messages 已在 core 校验过(非空、role 合法)。
 *
 * 失败一律抛 `PluginLlmError`(quota / unsupported / timeout / provider-error),
 * 由插件自己 catch;在 compact 钩子里没 catch 时 N7-a 的 fail-open 兜底。
 */
export interface PluginLlmOwner {
  assertActive(): void
  runTask<T>(label: string, work: () => Promise<T>): Promise<T>
}

/** One Backend owns every raw provider promise, including a timed-out caller. */
export class PluginLlmService {
  /* 「闸 + 一群档」与凭证策略逐字相同,收进了 core(工单 5 §1)。 */
  private readonly scopes = new QuiescibleScopes<PluginLlmScope>()
  private readonly rateWindows = new Map<string, number[]>()

  constructor(private readonly owner?: PluginLlmOwner) {}

  createScope(pluginId: string): PluginLlmScope {
    this.assertActive()
    return this.scopes.add(new PluginLlmScope(pluginId, this))
  }

  assertActive(): void {
    if (this.scopes.closed) throw new PluginLlmError('unsupported', 'plugin model service is shutting down')
    this.owner?.assertActive()
  }

  admit(pluginId: string): void {
    this.assertActive()
    enforceQuota(this.rateWindows, pluginId, Date.now())
  }

  run<T>(pluginId: string, work: () => Promise<T>): Promise<T> {
    return this.owner
      ? this.owner.runTask(`plugin:${pluginId}:llm.complete`, work)
      : Promise.resolve().then(work)
  }

  quiesce(): void { this.scopes.quiesce() }

  drain(): Promise<void> { return this.scopes.drain() }

  release(scope: PluginLlmScope): void { this.scopes.release(scope) }
}

/** A PluginState captures this scope; re-enabling the same id gets a new one. */
export class PluginLlmScope {
  private closing = false
  private readonly pending = new Map<Promise<string>, AbortController>()

  constructor(private readonly pluginId: string, private readonly service: PluginLlmService) {}

  quiesce(): void {
    this.closing = true
    for (const controller of this.pending.values()) {
      controller.abort(new PluginLlmError('unsupported', 'plugin was disposed'))
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.keys()])
    if (this.closing) this.service.release(this)
  }

  async complete(options: PluginLlmCompleteOptions): Promise<PluginLlmCompleteResult> {
    if (this.closing) throw new PluginLlmError('unsupported', 'plugin was disposed')
    this.service.assertActive()
    if (options.signal?.aborted) throw new PluginLlmError('timeout', 'llm.complete was aborted by the plugin signal')
    this.service.admit(this.pluginId)
    const resolved = resolveManagedProvider()
    if (!resolved) throw new PluginLlmError('unsupported', 'no chat provider is configured on this host')
    const { providerId, config } = resolved
    // Capture before any await. Billing remains attached to the store that paid for the request.
    const record = captureUsageRecorder()
    const controller = new AbortController()
    const onPluginAbort = () => controller.abort(new PluginLlmError('timeout', 'llm.complete was aborted by the plugin signal'))
    const pluginSignal = options.signal
    pluginSignal?.addEventListener('abort', onPluginAbort, { once: true })
    let rejectAbort!: (error: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      controller.abort(new PluginLlmError('timeout', `llm.complete exceeded the ${PLUGIN_LLM_COMPLETE_TIMEOUT_MS}ms host timeout`))
    }, PLUGIN_LLM_COMPLETE_TIMEOUT_MS)
    timer.unref?.()
    let rawSettled = false
    try {
      const raw = this.service.run(this.pluginId, async () => {
        controller.signal.throwIfAborted()
        return generateChatResponse(providerId, config, options.messages, {
          temperature: options.temperature,
          maxTokens: clampPluginLlmMaxTokens(options.maxTokens),
          abortSignal: controller.signal,
          debugPurpose: `plugin:${this.pluginId}:llm.complete`,
          onUsage: usage => {
            // A provider emitting after its own promise has settled no longer owns a write.
            if (rawSettled) return
            try {
              record({ providerId, modelId: config.model, source: `plugin:${this.pluginId}`, usage })
            } catch (error) {
              log.error('plugin llm.complete usage billing failed', { pluginId: this.pluginId }, error)
            }
          },
        })
      })
      this.pending.set(raw, controller)
      const finished = () => { rawSettled = true; this.pending.delete(raw) }
      void raw.then(finished, finished)
      return { text: await Promise.race([raw, cancelled]) }
    } catch (error) {
      if (error instanceof PluginLlmError) throw error
      throw new PluginLlmError('provider-error', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      pluginSignal?.removeEventListener('abort', onPluginAbort)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }
}

export function capturePluginLlmScope(pluginId: string): PluginLlmScope | undefined {
  return getCurrentBackendInstance()?.pluginModels.createScope(pluginId)
}
