import type {
  AppSettings,
  OAuthToken,
  ProviderConfig,
  SkillDefinition,
  SystemPromptSnapshot,
  ToolDefinition,
} from '@shared/ipc.js'
import type { ProviderAuthContext } from '@onething/runtime/auth/types.wiring'
import * as store from '../../store.js'
import {
  createAgentProviderFromRuntime,
} from '../../providers/agent-runtime.js'
import { defaultAgent, findAgent } from '../../agents/index.js'
import { resolveAgentProfileForSession } from '../../agents/profile.js'
import { getSkillsForSession } from '../../skills/session-skills.js'
import { getMCPToolDefinitionsForModel } from '../../mcp/index.js'
import { buildProjectDirsPromptVars } from '../../project-dirs/index.js'
import {
  isProviderSupported,
} from '../../providers/index.js'
import * as modelRegistry from '../../providers/model-registry.js'
import {
  getEffectiveProviderConfig,
  resolveProviderAuth,
} from '../stream/provider-helpers.js'
import { getCodexNativeToolsForConfig } from '../stream/codex-native-tools.js'
import { resolveToolkitSurface } from '@onething/runtime/toolkit'
import { toolDefinitionFromToolkitTool } from '../../toolkit/catalog-projection.js'
import { resolveAgentLoopStreamRoute } from '../stream/agent-loop-selection.js'
import { buildPrompt } from './system-prompt.js'
import {
  agentSupportsTools,
  agentToolDefinitionsFromSourceTools,
  resolveAgentModelCapabilities,
} from '@onething/core/agent-loop'
import {
  buildSystemPromptSnapshotWithAdapters,
} from '@onething/runtime/prompts'

type ProviderConfigWithAuth = ProviderConfig & {
  authContext?: ProviderAuthContext
  oauthToken?: OAuthToken
  /** Packed upstream by withResolvedProviderBaseUrl; forwarded, never read here. */
  providerOptions?: Record<string, unknown>
}

function providerRuntimeApiType(providerConfig: ProviderConfigWithAuth): 'openai' | 'anthropic' | undefined {
  const apiType = 'apiType' in providerConfig ? providerConfig.apiType : undefined
  return apiType === 'openai' || apiType === 'anthropic' ? apiType : undefined
}

async function resolveModelSupportsToolsForSnapshot(options: {
  provider: Awaited<ReturnType<typeof resolveProviderForSnapshot>>
  agentLoopActive: boolean
  workingDirectory?: string
  sessionId: string
}): Promise<boolean> {
  if (!options.provider.providerSupported) return false

  if (options.agentLoopActive) {
    const agentProvider = createAgentProviderFromRuntime(options.provider.providerId, {
      apiKey: options.provider.providerConfig.apiKey,
      baseUrl: typeof options.provider.providerConfig.baseUrl === 'string'
        ? options.provider.providerConfig.baseUrl
        : undefined,
      model: options.provider.model,
      apiType: providerRuntimeApiType(options.provider.providerConfig),
      providerOptions: options.provider.providerConfig.providerOptions,
      oauthToken: options.provider.providerConfig.oauthToken,
      authContext: options.provider.providerConfig.authContext,
      modelCapabilitiesByModel: options.provider.providerConfig.modelCapabilitiesByModel,
      models: options.provider.providerConfig.models,
    }, {
      workingDirectory: options.workingDirectory,
      localSessionId: options.sessionId,
    })

    if (agentProvider) {
      const capabilities = await resolveAgentModelCapabilities(agentProvider, options.provider.model)
      return agentSupportsTools(capabilities)
    }
  }

  return modelRegistry.modelSupportsTools(options.provider.model, options.provider.providerId)
    .catch(() => false)
}

async function resolveProviderForSnapshot(settings: AppSettings, sessionId: string): Promise<{
  providerId: string
  model: string
  providerConfig: ProviderConfigWithAuth
  providerSupported: boolean
  credentialsReady: boolean
}> {
  const { providerId, providerConfig, model } = getEffectiveProviderConfig(settings, sessionId)
  const providerSupported = isProviderSupported(providerId)
  const authContext = await resolveProviderAuth(providerId, providerConfig).catch(() => null)
  const providerConfigWithAuth: ProviderConfigWithAuth = {
    ...providerConfig,
    model,
    selectedModels: providerConfig?.selectedModels ?? [model],
    apiKey: authContext?.kind === 'api-key' ? authContext.apiKey : '',
    ...(authContext ? { authContext } : {}),
    oauthToken: authContext?.kind === 'oauth' ? authContext.token : providerConfig?.oauthToken,
  }

  return {
    providerId,
    model,
    providerConfig: providerConfigWithAuth,
    providerSupported,
    credentialsReady: Boolean(authContext),
  }
}

/**
 * 场景面要的那一格。技能面读不出来(装配还没到、宿主没配 skills 适配器)时给空组
 * 而不是抛:一个快照面板不该因为技能目录没准备好就整块炸掉,而空组只影响
 * "skill 带进来的工具"那一小格。
 */
function enabledSkillNamesForSnapshot(
  session: { workingDirectory?: string; agentId?: string } | null | undefined,
): string[] {
  try {
    return getSkillsForSession(session?.workingDirectory, session?.agentId).map(skill => skill.name)
  } catch {
    return []
  }
}

export async function buildSystemPromptSnapshot(sessionId: string): Promise<SystemPromptSnapshot> {
  const snapshot = await buildSystemPromptSnapshotWithAdapters<
    AppSettings,
    ProviderConfigWithAuth,
    ToolDefinition,
    SkillDefinition
  >({
    sessionId,
    getSession: id => store.getSession(id),
    getSettings: () => store.getSettings(),
    resolveProvider: resolveProviderForSnapshot,
    resolveAgentLoopStreamRoute,
    getSkills: getSkillsForSession,
    /*
     * "这一回合模型看得见哪些工具"由 `Surface` 回答(§10.2-④)。
     *
     * 比 R3b 之前的旧快照多算一道**场景面**(协作四件套的场子、goal 的 active、
     * task 的套娃闸、skill 带进来的工具)—— 真回合本来就有那一道,而旧快照没有,
     * 于是它会把这条会话里根本调不到的工具报成"已装配"。下游那道 allowlist 过滤
     * 原样保留:`Surface` 已经过过一遍,再过一次是幂等的。
     *
     * 目录没装上(宿主没走 backend)时它给空组 —— 这台宿主确实没有工具。
     */
    getEnabledTools: toolSettings => {
      const session = store.getSession(sessionId)
      const surface = resolveToolkitSurface({
        session: session as Parameters<typeof resolveToolkitSurface>[0]['session'],
        enabledSkillNames: enabledSkillNamesForSnapshot(session),
        allowlist: resolveAgentProfileForSession(sessionId).tools,
        toolSettings: toolSettings as Readonly<Record<string, { enabled?: boolean; autoExecute?: boolean }>> | undefined,
      })
      return surface ? surface.tools().map(toolDefinitionFromToolkitTool) : []
    },
    getMCPToolDefinitions: getMCPToolDefinitionsForModel,
    sourceToolsToModelDefinitions: tools => agentToolDefinitionsFromSourceTools(tools),
    resolveModelSupportsTools: resolveModelSupportsToolsForSnapshot,
    getNativeProviderTools: getCodexNativeToolsForConfig,
    buildProjectDirsPromptVars,
    // persona 功能兜底(域模型 §3.3),与 system-prompt.ts 的 host 同一条规则。
    getAgent: (agentId?: string) => findAgent(agentId) ?? defaultAgent(),
    // 走真回合那条解析(C2 工具面单点):agent 自带白名单 + 会话 kind 隐含的
    // grant + dm 分格,一个都不能少 —— 否则这个面板会把 agent 调不到的工具
    // 报成"已装配"。
    getAgentToolAllowlist: () => resolveAgentProfileForSession(sessionId).tools,
    buildPrompt,
  })

  const codexNative = snapshot.tools.nativeProvider.map(tool => ({
    ...tool,
    source: 'codex-native' as const,
    category: 'codex-native',
    description: tool.name === 'image_generation'
      ? 'Codex native image generation'
      : 'Codex native tool',
  }))

  return {
    ...snapshot,
    tools: {
      ...snapshot.tools,
      codexNative,
    },
  } as SystemPromptSnapshot
}
