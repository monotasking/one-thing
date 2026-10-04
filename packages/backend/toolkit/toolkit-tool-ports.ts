/**
 * `@onething/backend` 的 toolkit 装配面(设计文档 §6)。
 *
 * 端口实现与投影器住在这里,因为它们是**这个宿主**与内核之间的那一层:权限核、
 * 后台进程表、`@shared/ipc` 契约、store —— 产品层碰不得的东西,装配层可以。
 *
 * 一处未接线:R2a 只把这些零件建好并单测,引擎/agent-loop/旧 registry/IPC bridge/
 * 渲染器一个字都没动。
 */

export { createPermissionAuthorizer, PermissionAuthorizer } from './toolkit-authorizer.js'
export type { PermissionAuthorizerOptions } from './toolkit-authorizer.js'

export { AuditProjector, combineObservers } from '@onething/backend/toolkit/toolkit-audit-observer'
export type { AuditProjectorOptions, ToolAuditRecord, ToolAuditSink } from '@onething/backend/toolkit/toolkit-audit-observer'

export { deriveLegacyPermissionGuard } from '@onething/backend/toolkit/toolkit-guard-projection'
export type { DeriveGuardOptions } from '@onething/backend/toolkit/toolkit-guard-projection'

export {
  createIpcObserver,
  executionResultFromOutcome,
  IpcProjector,
  metadataUpdateFromAnnotate,
  partialResultFromEvent,
  splitResultContent,
  stepFromEvent,
} from '@onething/backend/toolkit/toolkit-ipc-observer'
export type {
  ExecutionResultProjectionInput,
  LegacyMetadataUpdate,
  LegacyToolAttachment,
  LegacyToolCallbacks,
} from '@onething/backend/toolkit/toolkit-ipc-observer'

export { BackgroundJobRegistry } from './toolkit-jobs.js'
export type { BackgroundJobRegistryOptions } from './toolkit-jobs.js'

export {
  bashAdapters,
  createCatalogForTier,
  createDesktopCatalog,
  createHeadlessCatalog,
  createReadonlyCatalog,
  FeatureToolRuntime,
  mutatingFileAdapters,
  readAdapters,
  registerFeatureTools,
  variableAdapters,
} from './toolkit-tier-catalogs.js'
export type { CatalogAdapters, ToolCatalogTier } from './toolkit-tier-catalogs.js'

export {
  askUserAdapters,
  goalAdapters,
  practiceAdapters,
  radioAdapters,
  taskPorts,
  webOpenAdapters,
  webSearchAdapters,
} from './toolkit-adapters.js'

export { createFeatureInspectTool, FeatureInspectTool } from './builtin/toolkit-builtin-feature-inspect.js'
export { createFeatureMountTool, FeatureMountTool } from './builtin/toolkit-builtin-feature-mount.js'
export { createFeatureUnmountTool, FeatureUnmountTool } from './builtin/toolkit-builtin-feature-unmount.js'

export { toolkitAuditSink } from './toolkit-audit-sink.js'

export {
  refreshMcpToolsInCatalog,
  resetMcpCatalogSyncForTests,
  syncMcpToolsIntoCatalog,
} from '@onething/backend/toolkit/toolkit-mcp-catalog'

export { toolkitPromptFragments, toolkitPromptSource } from '@onething/backend/toolkit/toolkit-prompt-source'

export type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMetadataUpdate,
  ToolPartialResultUpdate,
} from '@onething/backend/toolkit/toolkit-execution-types'

export {
  toolDefinitionFromToolkitTool,
  toolDefinitionsFromCatalog,
  toolkitCatalogToolDefinitions,
} from '@onething/backend/toolkit/toolkit-catalog-projection'

export {
  registerPluginToolInCatalog,
  unregisterPluginToolFromCatalog,
} from '@onething/backend/toolkit/toolkit-plugin-tools'
export type { RegisterPluginToolInput } from '@onething/backend/toolkit/toolkit-plugin-tools'

export {
  buildToolkitCatalog,
  getOrBuildToolkitCatalog,
  refreshToolkitMcpTools,
  resetToolkitCatalogForTests,
  runToolkitToolDirectly,
} from './toolkit-wiring.js'
export type { ToolkitDirectContext } from './toolkit-wiring.js'

export {
  createAppToolRunner,
  createSandboxPolicy,
  createToolOutputSpill,
  sessionSnapshotFor,
} from './toolkit-runner-factory.js'
export type { AppToolRunnerOptions } from './toolkit-runner-factory.js'
