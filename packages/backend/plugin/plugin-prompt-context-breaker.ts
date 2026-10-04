/**
 * 与同目录的 `plugin-prompt-context.ts` 是同概念两半 —— 那半是泛型实现(注册表 + 超时 + 收集),
 * 这半把它钉成 `@shared/ipc` 的具体形状(`AppSettings` / `SkillDefinition` / `PromptContextRole`)
 * 并接上**断路器记账**(每次超时/异常记一次 `promptContext` 失败,成功即清零)。
 * (这只文件从前叫 `plugin-context.wiring.ts`;2026-10-03 去掉后缀时与泛型那一半撞名,
 * 按它多做的那件事 —— 断路器 —— 改名。)
 *
 * 2026-10-04 两半一起从 `prompt/` 搬进插件(越层清零 C1):它们是插件的提示词源,引插件契约与
 * 健康表是本分;留在 prompt(L1)就是提示词拼装去引插件(L2)。插件入口 `plugin.ts` 交出的
 * 同名函数(`registerPromptContextProvider` 等)是这一半带断路器的版本。
 */
import { pluginScope } from './plugin-contract.js'
import {
  PluginPromptContextSource,
  clearPromptContextProvidersForPlugin as clearRuntimePromptContextProvidersForPlugin,
  collectPluginPromptContext as collectRuntimePluginPromptContext,
  type CollectOnethingPluginPromptContextOptions,
  getPromptContextProviderCount as getRuntimePromptContextProviderCount,
  registerPromptContextProvider as registerRuntimePromptContextProvider,
  type OnethingPluginPromptContext,
  type OnethingPluginPromptContextFragmentInput,
  type OnethingPluginPromptContextProvider,
  type OnethingPromptProviderConfig,
  type OnethingPromptProviderConfigValue,
} from './plugin-prompt-context.js'
import type {
  AppSettings,
  PromptContextFragment,
  PromptContextRole,
  SkillDefinition,
} from '@shared/ipc.js'
import type { CorePromptActiveProject as PromptActiveProject, CorePromptKnownProjects as PromptKnownProjects } from '@onething/backend/agent-loop'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from './plugin-health.js'
import { getLogger } from '../logging/logging.js'

const log = getLogger('engine.prompt')


function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

export type PromptProviderConfigValue = OnethingPromptProviderConfigValue
export type PromptProviderConfig = OnethingPromptProviderConfig

export interface PluginPromptContext extends Omit<OnethingPluginPromptContext, 'settings' | 'skills' | 'activeProject' | 'knownProjects'> {
  settings?: AppSettings
  skills: SkillDefinition[]
  activeProject?: PromptActiveProject
  knownProjects?: PromptKnownProjects
}

export interface PluginPromptContextFragmentInput extends Omit<OnethingPluginPromptContextFragmentInput, 'role'> {
  role: PromptContextRole
}

export type PluginPromptContextProvider = (
  context: PluginPromptContext,
) =>
  | Promise<PluginPromptContextFragmentInput | PluginPromptContextFragmentInput[] | string | null | undefined>
  | PluginPromptContextFragmentInput
  | PluginPromptContextFragmentInput[]
  | string
  | null
  | undefined

export function registerPromptContextProvider(
  pluginId: string,
  providerId: string,
  provider: PluginPromptContextProvider,
): () => void {
  return registerRuntimePromptContextProvider(pluginId, providerId, provider as OnethingPluginPromptContextProvider)
}

export function clearPromptContextProvidersForPlugin(pluginId: string): void {
  clearRuntimePromptContextProvidersForPlugin(pluginId)
}

export function getPromptContextProviderCount(): number {
  return getRuntimePromptContextProviderCount()
}

/**
 * The host's health wiring for plugin prompt providers: every timeout /
 * exception counts one failure on the plugin's promptContext scope (the
 * breaker disables the plugin after N in a row), every success clears it.
 * Scope carries no variable suffix ("(timeout)" would split one lane in two).
 * Success reporting is zero-IO — it runs per provider on the send hot path.
 */
export const pluginPromptContextHealthOptions: CollectOnethingPluginPromptContextOptions = {
  onProviderError(providerRef, error) {
    log.error('plugin prompt context provider failed', { providerRef }, error)
  },
  onProviderFailure({ pluginId, providerId, error, timedOut }) {
    reportPluginRuntimeFailure(
      pluginId,
      pluginScope.promptContext(providerId),
      timedOut ? new Error(`timed out: ${describeError(error)}`) : error,
    )
  },
  onProviderSuccess({ pluginId, providerId }) {
    reportPluginRuntimeSuccess(pluginId, pluginScope.promptContext(providerId))
  },
}

/** Plugin providers as a `PromptSource`, with the desktop health wiring. */
export const pluginPromptSource: PluginPromptContextSource =
  new PluginPromptContextSource(pluginPromptContextHealthOptions)

export async function collectPluginPromptContext(
  context: PluginPromptContext,
): Promise<PluginPromptContextFragmentInput[]> {
  return collectRuntimePluginPromptContext(
    context,
    pluginPromptContextHealthOptions,
  ) as Promise<PluginPromptContextFragmentInput[]>
}

export type {
  PromptContextFragment,
}
