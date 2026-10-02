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
} from '@onething/backend/runtime/plugins/plugin-contract'

export { bootstrapPluginSystem, getPluginManager, PluginManager } from './plugin-manager.js'
export {
  getPluginThemeKnobVariables,
  getPluginThemeOverrideTable,
  getPluginThemeOverrideTokenValues,
} from './theme-override-table.js'
export type { PluginThemeOverrideTable } from './theme-override-table.js'
export type { PluginInfo } from './plugin-manager.js'
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
