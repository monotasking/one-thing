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
} from '@onething/runtime/prompts'
import type {
  AppSettings,
  PromptContextFragment,
  PromptContextRole,
  SkillDefinition,
} from '@shared/ipc.js'
import type {
  PromptActiveProject,
  PromptKnownProjects,
} from './types.js'
import {
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
} from '../../plugins/health.js'
import { getLogger } from '../../wiring/logging/index.js'

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
