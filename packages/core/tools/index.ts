export { ToolExecutor } from './executor.js'
export type { ToolExecutorOptions } from './executor.js'
export {
  TOOL_ABORT_ERROR_NAME,
  createToolAbortError,
  isToolAbortError,
} from './abort.js'
export type { ToolAbortError } from './abort.js'
export {
  coreDiffHunksFromJson,
  coreDiffHunksToJson,
} from './diff-hunks.js'
export type {
  CoreDiffHunk,
  CoreDiffHunkLine,
} from './diff-hunks.js'
export {
  isBarrierEffect,
} from './tool-effect.js'
export type {
  ToolEffect,
  ToolEffectKind,
  ToolEffectMetadata,
  ToolEffectMetadataValue,
  ToolPreview,
} from './tool-effect.js'
export {
  isCanonicalToolResult,
  summarizeToolFailureParameters,
  textFromToolResult,
  toolFailureResultForAI,
  toolFailureText,
  toolResultToStructured,
} from './tool-result.js'
export type {
  CanonicalToolResult,
  CanonicalToolResultContentPart,
  ToolFailureLike,
  ToolFailureParameterSummary,
  ToolFailureResultForAI,
  ToolResultLike,
} from './tool-result.js'
export { AllowAllPolicy, DenyAllPolicy } from './policy.js'
export type { PermissionPolicy } from './policy.js'
/**
 * R4b —— `*WithAdapters` 那一族(旧注册表的注入式壳)与围绕 `ToolInfo` 的那批
 * 帮手随旧树删除。留下来的只有**新树还在用**的三个纯投影函数,外加 `AgentEngine`
 * 自己那台最小注册表(`ToolRegistry` + `types.ts` 的 `ToolDefinition` —— 它是
 * agent-engine 的工具形状,与被删掉的 `ToolInfo` 不是一回事)。
 */
export { ToolRegistry } from './registry.js'
export {
  coreToolContextFromHost,
  coreToolDefinitionFromJsonSchema,
  coreToolParameterFromSchema,
  coreToolValidationFailureMessage,
  extractCoreErrorMessage,
  normalizeCoreToolParameterType,
} from './registry.js'
export type {
  CoreMaybePromise,
  CoreToolDecision,
  CoreToolDefinitionFromJsonSchemaInput,
  CoreToolFailureResult,
  CoreToolHostExecutionContext,
  CoreToolJsonSchemaLike,
  CoreToolParameterDefinition,
  CoreToolParameterType,
  CoreToolRegistryKind,
  CoreToolRegistryRegisterResult,
  CoreToolRuntimeContext,
  CoreToolSettingsLike,
  CoreToolValidationResult,
} from './registry.js'
export { executeToolCalls } from './tool-loop.js'
/**
 * `permissionGuard` 的概念在新树里已经不存在(它是 `spec.effects` 的派生值,
 * 见 `app/toolkit/guard-projection.ts`);这两个判据活着,是因为**派生表**要按
 * 同一套集合给出旧字段的值,而宿主契约里那个字段还在(标了 deprecated)。
 */
export {
  isAutoExecutePermissionGuard,
  isInjectablePermissionGuard,
} from './permission-guards.js'
export type {
  CoreToolPermissionGuard,
  CoreToolPermissionGuardLike,
} from './permission-guards.js'
export type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from './types.js'
