/**
 * Plugin System — public entry point.
 *
 * Usage:
 *   import { bootstrapPluginSystem } from './plugins/index.js'
 *   await bootstrapPluginSystem(eventBus, streamEngine)
 */

export type {
  CorePluginInfo,
  CorePluginManagerHost,
} from '@onething/core/plugins'

export { bootstrapPluginSystem, getPluginManager, PluginManager } from './manager.js'
export {
  getPluginThemeKnobVariables,
  getPluginThemeOverrideTable,
  getPluginThemeOverrideTokenValues,
} from './theme-overrides.js'
export type { PluginThemeOverrideTable } from './theme-overrides.js'
export type { PluginInfo } from './manager.js'
export type {
  PluginAPI,
  PluginEntry,
  PluginManifest,
  PluginDefinition,
  PluginToolDefinition,
  PluginToolContext,
  PluginToolResult,
  CorePluginToolExecutionMode,
  PluginCommandDefinition,
  PluginCommandContext,
  PluginPromptContext,
  PluginPromptContextProvider,
  BeforeContextCompactContext,
  BeforeContextCompactHook,
  PluginEventHandler,
  PluginStore,
  MinimalPluginUI,
} from './types.js'
