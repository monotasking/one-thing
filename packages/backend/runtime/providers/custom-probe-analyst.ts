/**
 * 「自动识别」的装配半边(批 4 §7.3,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 探测 / 规则 / 回验是产品层的纯函数(`runtime/providers/custom-probe.ts`);这里只做三件
 * 宿主才知道的事:用哪只 fetch(应用代理那一只)、**请谁来分析**、怎么把它跑一轮。
 *
 * 分析模型的挑法(§7.3 ③):一家**已配好**、**不是自定义服务商**(正在配置的这一家必然是
 * 自定义的 —— 先有鸡先有蛋)、能建出 provider 的家。候选顺序 = 工具模型 → 聊天模型 →
 * 其余已启用的家;一家都没有 = 只走规则,答 `reasonKind: 'no-analyst'`。
 *
 * 端口可注入(`ProbeCustomPorts`):单测替掉 fetch / 分析那一轮,门跑真的。
 */
import { createAgentExecutionLifetime, runAgentLoop } from '@onething/backend/runtime/agent-loop/loop-primitives'
import {
  CUSTOM_ADAPTER_BASE_DIALECT,
  adapterReasoningPath,
  parseAdapterSpecAnswer,
  probeCustomEndpoint,
  renderCustomAdapterProbePrompt,
  verifyAdapterSpec,
} from '@onething/backend/runtime/providers/custom-probe'
import { EXTERNAL_AGENT_DIALECT_ID, getProviderManifest } from '@onething/backend/runtime/providers/manifest'
import type { ProviderDirectModelsFetch } from '@onething/backend/runtime/providers/models-endpoint'
import type { AppSettings } from '@shared/ipc.js'
import type {
  CustomAdapterSpec,
  ProbeCustomProviderRequest,
  ProbeCustomProviderResponse,
} from '@shared/ipc/providers.js'
import { createRequiredAppFetch } from '@onething/backend/provider-binding/bound-fetch.js'
import { getSpaceSettings } from '@onething/backend/runtime/settings'
import { getLogger } from '@onething/backend/runtime/logging/configure-logging'
import { createUtilityProvider, type UtilityProviderRef } from './utility-provider.js'

const log = getLogger('providers.probe')

/** 分析那一轮的上限。答案是一张小 JSON,思考关掉;给足余量是防模型啰嗦。 */
const ANALYSIS_MAX_TOKENS = 1500
const ANALYSIS_TIMEOUT_MS = 90_000

export interface ProbeCustomPorts {
  fetch: ProviderDirectModelsFetch
  /** 这个空间里能当分析模型的那一家。没有 = undefined。 */
  analyst(spaceId: string | undefined): Promise<UtilityProviderRef | undefined>
  /** 跑一轮,答原文。 */
  ask(analyst: UtilityProviderRef, prompt: string): Promise<string>
  now(): number
}

/** 能当分析模型的家:已登记、不是自定义的、不是外部执行体。 */
function isAnalystCandidate(providerId: string): boolean {
  const manifest = getProviderManifest(providerId)
  return Boolean(manifest && manifest.origin !== 'custom' && manifest.dialect !== EXTERNAL_AGENT_DIALECT_ID)
}

function candidateOrder(settings: AppSettings): Array<{ providerId: string; model?: string }> {
  const out: Array<{ providerId: string; model?: string }> = []
  const seen = new Set<string>()
  const push = (providerId: string | undefined, model?: string) => {
    const id = providerId?.trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ providerId: id, ...(model?.trim() ? { model: model.trim() } : {}) })
  }
  push(settings.tools?.toolCallModel?.providerId, settings.tools?.toolCallModel?.model)
  push(settings.ai?.provider)
  for (const [id, config] of Object.entries(settings.ai?.providers ?? {})) {
    if (config?.enabled === false) continue
    push(id)
  }
  return out
}

export async function resolveProbeAnalyst(spaceId: string | undefined): Promise<UtilityProviderRef | undefined> {
  const settings = getSpaceSettings(spaceId)
  for (const candidate of candidateOrder(settings)) {
    if (!isAnalystCandidate(candidate.providerId)) continue
    const config = settings.ai?.providers?.[candidate.providerId]
    if (!config) continue
    const model = candidate.model || config.model || config.selectedModels?.[0]
    if (!model) continue
    try {
      // 复用后台工作那一条建 provider 的路(解析凭据 / 档位 / 能力),只把「用哪一家哪一型」换掉。
      const utility = await createUtilityProvider({
        ...settings,
        tools: { ...settings.tools, toolCallModel: { ...settings.tools?.toolCallModel, providerId: candidate.providerId, model } },
      } as AppSettings)
      if (utility) return utility
    } catch (error) {
      log.debug('analyst candidate could not be built', { providerId: candidate.providerId }, error)
    }
  }
  return undefined
}

export async function askProbeAnalyst(analyst: UtilityProviderRef, prompt: string): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ANALYSIS_TIMEOUT_MS)
  const executionLifetime = createAgentExecutionLifetime()
  try {
    const result = await runAgentLoop({
      provider: analyst.provider,
      executionLifetime,
      model: analyst.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      selectedToolNames: [],
      maxTurns: 1,
      temperature: 0,
      maxTokens: ANALYSIS_MAX_TOKENS,
      thinking: 'disabled',
      sessionId: 'providers:probe-custom',
      messageId: `providers:probe-custom:${Date.now()}`,
      abortSignal: abort.signal,
    })
    return result.text ?? ''
  } finally {
    clearTimeout(timer)
    void executionLifetime.drain().catch(() => {})
  }
}

const DEFAULT_PORTS: ProbeCustomPorts = {
  fetch: (input, init) => createRequiredAppFetch({ policy: 'default' })(input, init),
  analyst: resolveProbeAnalyst,
  ask: askProbeAnalyst,
  now: () => Date.now(),
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function probeCustomProvider(
  request: ProbeCustomProviderRequest,
  overrides: Partial<ProbeCustomPorts> = {},
): Promise<ProbeCustomProviderResponse> {
  const ports = { ...DEFAULT_PORTS, ...overrides }
  const baseUrl = request?.baseUrl?.trim() ?? ''
  if (!baseUrl) return { ok: false, reasonKind: 'unreachable', error: 'No endpoint URL configured', analyzed: false }

  const probe = await probeCustomEndpoint({
    baseUrl,
    ...(request.apiKey?.trim() ? { apiKey: request.apiKey.trim() } : {}),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.modelsUrl?.trim() ? { modelsUrl: request.modelsUrl.trim() } : {}),
    ...(request.hintModel?.trim() ? { hintModel: request.hintModel.trim() } : {}),
    fetchImpl: ports.fetch,
    now: ports.now,
  })
  if (!probe.ok) {
    log.info('custom endpoint probe failed', { reason: probe.reason })
    return { ok: false, reasonKind: probe.reason, error: probe.detail, analyzed: false }
  }

  let spec: CustomAdapterSpec | undefined = probe.spec
  let analyzed = false
  let noAnalyst = false
  if (probe.needsAnalysis) {
    const analyst = await ports.analyst(request.spaceId).catch(() => undefined)
    if (!analyst) {
      noAnalyst = true
    } else {
      analyzed = true
      let answer = ''
      try {
        answer = await ports.ask(analyst, renderCustomAdapterProbePrompt(probe.wire, probe.samples))
      } catch (error) {
        log.info('custom endpoint analysis call failed', { providerId: analyst.providerId }, error)
        return { ok: false, reasonKind: 'analysis-failed', error: describe(error), analyzed }
      }
      const parsed = parseAdapterSpecAnswer(answer, probe.wire)
      if (!parsed) {
        return {
          ok: false,
          reasonKind: 'analysis-failed',
          error: answer.replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty answer)',
          analyzed,
        }
      }
      spec = {
        ...parsed,
        probe: {
          at: ports.now(),
          model: probe.model,
          confidence: parsed.probe?.confidence ?? 'medium',
          notes: parsed.probe?.notes ?? '',
        },
      }
    }
  }

  const verdict = await verifyAdapterSpec(spec, probe.samples)
  if (!verdict.ok) {
    return {
      ok: false,
      reasonKind: 'verify-failed',
      error: `${verdict.reason}: ${verdict.detail}`,
      analyzed,
      spec,
    }
  }
  const dialect = CUSTOM_ADAPTER_BASE_DIALECT[spec.wire]
  const reasoningPath = adapterReasoningPath(spec, probe.samples)
  return {
    ok: true,
    spec,
    analyzed,
    ...(noAnalyst ? { reasonKind: 'no-analyst' as const } : {}),
    summary: {
      wireLabelKey: `providers.dialect.${dialect}`,
      dialect,
      ...(reasoningPath ? { reasoningPath } : {}),
      modelCount: verdict.modelCount || probe.modelCount,
    },
  }
}
