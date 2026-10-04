/**
 * Provider 目录与配额查询域(主线 T1 第二批)。
 *
 * 替换 `apps/electron/src/main/ipc/providers.ts`(已删)与 server 的
 * `runtime.providers.{list,usage,envStatus}` + `/api/providers*` 三条路由。
 *
 * **两处不是等价搬迁,说清楚:**
 * 1. `list` —— server 原本返回的是一张写死的表(local + 内建 provider info),
 *    而 desktop 走 `getAvailableProviders()` 读注册表。注册表由
 *    `configureAppProviderRegistry()` 在 `createOnethingBackend` 里装配,**每个
 *    宿主都跑**,所以 server 迁完拿到的是真注册表,不是降级。
 * 2. `quota`(批 5 从 `usage` 改名)—— 读 `backend.quota`(`quota`):manifest 的
 *    `quotaSource` → 配额源注册表,这里一个 provider 名都不认。凭证按请求带的空间(缺席 =
 *    默认空间)与凭证 id(缺席 = 密钥策略的只读 `decide`)取,headless 宿主的 token store
 *    有 plaintext 回退(见 `auth/auth-host-ports.ts` 的契约),所以 server 照走真链路。
 *
 * 本文件后半是设置页「自动识别自定义服务商」那一步(`probeCustom`)的装配半边,见下面那一节的说明。
 */
import type { RouteHandlers } from '@shared/ipc/router'
import {
  providersRouter,
  type ProviderInfo,
  type ProvidersRoutes,
  type CustomAdapterSpec,
  type ProbeCustomProviderRequest,
  type ProbeCustomProviderResponse,
} from '@shared/ipc/providers.js'
import {
  getProviderEnvStatus,
  inspectOnethingProviderEnvStatusForIpc,
  listLabeledDialectsForIpc,
  listOnethingProvidersForIpc,
  type ListOnethingProvidersOptions,
  type OnethingProviderPresentationIpcLogger,
  adapterReasoningPath,
  customAdapterBaseDialectId,
  EXTERNAL_AGENT_DIALECT_ID,
  getProviderManifest,
  parseAdapterSpecAnswer,
  probeCustomEndpoint,
  renderCustomAdapterProbePrompt,
  verifyAdapterSpec,
  type ProviderDirectModelsFetch,
} from '@onething/backend/provider'
import { DEFAULT_SPACE_ID } from '@onething/backend/space/space-types'
import { createUtilityProvider, getAvailableProviders, type UtilityProviderRef } from '@onething/backend/provider-call'
import { consolePort, getLogger } from '@onething/backend/logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import { getCurrentBackendInstance } from '@onething/backend/backend-current.js'
import { defineClientApi } from '@onething/backend/http-server/http-server-dispatch-table.js'

import { createAgentExecutionLifetime, runAgentLoop } from '@onething/backend/agent-loop'
import type { AppSettings } from '@shared/ipc.js'
import { createRequiredAppFetch, getSpaceSettings } from '@onething/backend/settings'

const log = getLogger('ipc.providers')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingProviderPresentationIpcLogger = consolePort(log)


export const providersRpcHandlers: RouteHandlers<ProvidersRoutes> = {
  async list() {
    const listOnethingProvidersOptions: ListOnethingProvidersOptions<ProviderInfo> & { logger?: OnethingProviderPresentationIpcLogger | undefined; } = { getAvailableProviders, logger: consoleLog };
    return listOnethingProvidersForIpc(listOnethingProvidersOptions)
  },
  /** 「接口类型」下拉(批 3 §6.1):方言自述人话名,有名字的才进。只读,不碰网。 */
  async listDialects() {
    return listLabeledDialectsForIpc()
  },
  async quota(request) {
    const providerId = request?.providerId ?? ''
    const service = getCurrentBackendInstance()?.quota
    if (!providerId || !service) return { quota: { kind: 'unsupported' } }
    return service.get({
      providerId,
      spaceId: request?.spaceId || DEFAULT_SPACE_ID,
      ...(request?.credentialId ? { credentialId: request.credentialId } : {}),
      ...(request?.force ? { force: true } : {}),
    })
  },
  /**
   * 自定义服务商对话框「自动识别」(批 4 §7.3):探两发 + 规则先判 + 分析模型只填偏差 +
   * 真响应回验。**不写盘** —— 对话框里点「应用」才把适配表写进那一家。
   */
  async probeCustom(request) {
    try {
      return await probeCustomProvider(request)
    } catch (error) {
      log.warn('probeCustom failed', {}, error)
      return {
        ok: false,
        reasonKind: 'unreachable' as const,
        error: error instanceof Error ? error.message : String(error),
        analyzed: false,
      }
    }
  },
  async envStatus(request) {
    return inspectOnethingProviderEnvStatusForIpc({
      providerId: request?.providerId ?? '',
      getProviderEnvStatus,
      logger: consoleLog,
    })
  },
}



/*
 * ── 「自动识别」的装配半边(批 4 §7.3,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 探测 / 规则 / 回验是产品层的纯函数(`provider/provider-custom-probe.ts`);这里只做三件
 * 宿主才知道的事:用哪只 fetch(应用代理那一只)、**请谁来分析**、怎么把它跑一轮。
 *
 * 分析模型的挑法(§7.3 ③):一家**已配好**、**不是自定义服务商**(正在配置的这一家必然是
 * 自定义的 —— 先有鸡先有蛋)、能建出 provider 的家。候选顺序 = 工具模型 → 聊天模型 →
 * 其余已启用的家;一家都没有 = 只走规则,答 `reasonKind: 'no-analyst'`。
 *
 * 端口可注入(`ProbeCustomPorts`):单测替掉 fetch / 分析那一轮,门跑真的。
 *
 * (D30 暂放在 `rpc/domains/providers-custom-probe-analyst.ts`;包根归位时并进本文件,只把它的 `log` 改名 `probeLog`,日志命名空间不变。)
 */

/** 「自动识别」那半边自己的日志命名空间(与上面的 `ipc.providers` 分开,沿用从前的名字)。 */
const probeLog = getLogger('providers.probe')

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
      probeLog.debug('analyst candidate could not be built', { providerId: candidate.providerId }, error)
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
    probeLog.info('custom endpoint probe failed', { reason: probe.reason })
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
        probeLog.info('custom endpoint analysis call failed', { providerId: analyst.providerId }, error)
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
  const dialect = customAdapterBaseDialectId(spec.wire)
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

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `providers` 的契约与处理者。 */
export const PROVIDERS_CLIENT_API = defineClientApi({ id: 'rpc:providers', router: providersRouter, handlers: providersRpcHandlers })
