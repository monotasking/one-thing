/**
 * 角色后缀 `.wiring`(I2,P3'e-A2b):与同目录的 `plugin-context.ts` 是同概念两半 ——
 * 那半是泛型的产品实现(注册表 + 超时 + 收集),这半把它钉成 `@shared/ipc` 的具体
 * 形状(`AppSettings` / `SkillDefinition` / `PromptContextRole`)并接上**桌面那套
 * 断路器记账**(每次超时/异常记一次 `promptContext` 失败,成功即清零)。
 * 只有装配层与别的 `.wiring` 读它;`prompts/index.ts` 刻意不再导出它。
 */
import { pluginScope } from '@onething/core/plugins'
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
} from './plugin-context.js'
import type {
  AppSettings,
  PromptContextFragment,
  PromptContextRole,
  SkillDefinition,
} from '@shared/ipc.js'
import type {
  CorePromptActiveProject as PromptActiveProject,
  CorePromptKnownProjects as PromptKnownProjects,
} from '@onething/core/engine'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '../plugins/health.js'
import { getLogger } from '../logging/index.js'

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
