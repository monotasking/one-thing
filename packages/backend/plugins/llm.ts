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

import { getSettings } from '../stores/settings.js'
import { resolveProviderApiKey } from '../providers/env.js'
import { resolveUtilityModel } from '../providers/utility-model.js'
import { generateChatResponse } from '../providers/index.js'
import { recordUsage } from '../wiring/usage/index.js'
import type { ProviderConfigWithKey } from '../engine/stream/stream-executor.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('plugins')


/* ── 配额:每插件的调用时刻环 ─────────────────────────────────────────────── */

const rateWindows = new Map<string, number[]>()

/** 测试与进程收摊用:配额账清零。 */
export function resetPluginLlmLedgers(): void {
  rateWindows.clear()
}

/** 超限即抛(不入账);未超则记一次时刻并放行。 */
function enforceQuota(pluginId: string, now: number): void {
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
export async function pluginLlmComplete(
  pluginId: string,
  options: PluginLlmCompleteOptions,
): Promise<PluginLlmCompleteResult> {
  const now = Date.now()
  // 配额先于一切副作用(包括 provider 解析)——超限就是超限。
  enforceQuota(pluginId, now)

  const resolved = resolveManagedProvider()
  if (!resolved) {
    throw new PluginLlmError('unsupported', 'no chat provider is configured on this host')
  }
  const { providerId, config } = resolved
  const maxTokens = clampPluginLlmMaxTokens(options.maxTokens)

  // 硬超时:自建 AbortController,与插件自己的 signal 取较早的那个。
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PLUGIN_LLM_COMPLETE_TIMEOUT_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const pluginSignal = options.signal
  if (pluginSignal) {
    if (pluginSignal.aborted) controller.abort()
    else pluginSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const text = await generateChatResponse(providerId, config, options.messages, {
      temperature: options.temperature,
      maxTokens,
      abortSignal: controller.signal,
      debugPurpose: `plugin:${pluginId}:llm.complete`,
      // 计费:每次调用进账本,source = plugin:<id>。billing 失败绝不打断调用本身。
      onUsage: (usage) => {
        try {
          recordUsage({
            providerId,
            modelId: config.model,
            source: `plugin:${pluginId}`,
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
          })
        } catch (error) {
          log.error('plugin llm.complete usage billing failed', { pluginId }, error)
        }
      },
    })
    return { text }
  } catch (error) {
    if (timedOut) {
      throw new PluginLlmError(
        'timeout',
        `llm.complete exceeded the ${PLUGIN_LLM_COMPLETE_TIMEOUT_MS}ms host timeout`,
      )
    }
    if (pluginSignal?.aborted) {
      throw new PluginLlmError('timeout', 'llm.complete was aborted by the plugin signal')
    }
    throw new PluginLlmError(
      'provider-error',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    clearTimeout(timer)
  }
}
