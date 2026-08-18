/**
 * Tool System Entry Point
 *
 * Provides a unified interface for the tool system.
 * All tools use the Tool.define() pattern.
 */

// Re-export types
export type {
  ToolDefinition,
  ToolCall,
  ToolParameter,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  RegisteredTool,
  AIToolSchema,
} from './types.js'

export { toAIToolSchema } from './types.js'

// Re-export Tool.define() types and utilities
export { Tool, zodToJsonSchema, isAsyncTool } from './core/tool.js'
export type {
  ToolMetadata,
  ToolContext,
  ToolResult,
  CanonicalToolResult,
  ToolExecutionMode,
  ToolRenderKind,
  ToolRenderShell,
  ToolInfo,
  ToolConfig,
  ToolInfoAsync,
  ToolInfoUnion,
  ToolInitResult,
  InitContext,
} from './core/tool.js'

// Re-export replacement utilities
export {
  replace,
  normalizeLineEndings,
  trimDiff,
  REPLACERS,
} from './core/replacers.js'
export type { Replacer } from './core/replacers.js'

// Re-export registry functions
export {
  registerTool,
  unregisterTool,
  getTool,
  getToolAsync,
  hasTool,
  getAllTools,
  getAllToolsAsync,
  getAllStaticTools,
  getAllAsyncTools,
  getEnabledTools,
  getEnabledToolsAsync,
  getEnabledStaticTools,
  getEnabledAsyncTools,
  getToolsForAI,
  executeTool,
  analyzeTool,
  validateToolArgs,
  createToolCall,
  canAutoExecute,
  getToolExecutionMode,
  getToolPromptFragments,
  toolPromptSource,
  initializeHeadlessToolRegistry,
  initializeReadonlyToolRegistry,
  initializeToolRegistry,
  isInitialized,
  // Async tool support
  setInitContext,
  getInitContext,
  initializeAsyncTools,
} from './registry.js'

export { toolResultToStructured, textFromToolResult, isCanonicalToolResult } from '@onething/core/tools'

// Re-export permission system
export { Permission } from '../permission/index.js'
