/**
 * `@onething/backend` 的 toolkit 装配面(设计文档 §6)。
 *
 * 端口实现与投影器住在这里,因为它们是**这个宿主**与内核之间的那一层:权限核、
 * 后台进程表、`@shared/ipc` 契约、store —— 产品层碰不得的东西,装配层可以。
 *
 * 一处未接线:R2a 只把这些零件建好并单测,引擎/agent-loop/旧 registry/IPC bridge/
 * 渲染器一个字都没动。
 */

export { createPermissionAuthorizer, PermissionAuthorizer } from './authorizer.js'
export type { PermissionAuthorizerOptions } from './authorizer.js'

export { AuditProjector, combineObservers } from '@onething/runtime/toolkit/audit-observer'
export type { AuditProjectorOptions, ToolAuditRecord, ToolAuditSink } from '@onething/runtime/toolkit/audit-observer'

export { deriveLegacyPermissionGuard } from '@onething/runtime/toolkit/guard-projection'
export type { DeriveGuardOptions } from '@onething/runtime/toolkit/guard-projection'

export {
  createIpcObserver,
  executionResultFromOutcome,
  IpcProjector,
  metadataUpdateFromAnnotate,
  partialResultFromEvent,
  splitResultContent,
  stepFromEvent,
} from '@onething/runtime/toolkit/ipc-observer.wiring'
export type {
  ExecutionResultProjectionInput,
  LegacyMetadataUpdate,
  LegacyToolAttachment,
  LegacyToolCallbacks,
} from '@onething/runtime/toolkit/ipc-observer.wiring'

export { BackgroundJobRegistry } from './jobs.js'
export type { BackgroundJobRegistryOptions } from './jobs.js'

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
} from './catalog.js'
export type { CatalogAdapters, ToolCatalogTier } from './catalog.js'

export {
  askUserAdapters,
  boardAdapters,
  collabAdapters,
  goalAdapters,
  historyAdapters,
  notebookAdapters,
  practiceAdapters,
  radioAdapters,
  sendMessageAdapters,
  taskPorts,
  webOpenAdapters,
  webSearchAdapters,
} from './adapters.js'

export { createFeatureInspectTool, FeatureInspectTool } from './builtin/feature-inspect.js'
export { createFeatureMountTool, FeatureMountTool } from './builtin/feature-mount.js'
export { createFeatureUnmountTool, FeatureUnmountTool } from './builtin/feature-unmount.js'

export { toolkitAuditSink } from './audit-sink.js'

export {
  refreshMcpToolsInCatalog,
  resetMcpCatalogSyncForTests,
  syncMcpToolsIntoCatalog,
} from '@onething/runtime/toolkit/mcp-catalog.wiring'

export { toolkitPromptFragments, toolkitPromptSource } from '@onething/runtime/toolkit/prompt-source'

export type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMetadataUpdate,
  ToolPartialResultUpdate,
} from '@onething/runtime/toolkit/execution-types.wiring'

export {
  toolDefinitionFromToolkitTool,
  toolDefinitionsFromCatalog,
  toolkitCatalogToolDefinitions,
} from '@onething/runtime/toolkit/catalog-projection.wiring'

export {
  registerPluginToolInCatalog,
  unregisterPluginToolFromCatalog,
} from '@onething/runtime/toolkit/plugin-tools'
export type { RegisterPluginToolInput } from '@onething/runtime/toolkit/plugin-tools'

export {
  buildToolkitCatalog,
  getOrBuildToolkitCatalog,
  refreshToolkitMcpTools,
  resetToolkitCatalogForTests,
  runToolkitToolDirectly,
} from './wiring.js'
export type { ToolkitDirectContext } from './wiring.js'

export {
  createAppToolRunner,
  createSandboxPolicy,
  createToolOutputSpill,
  sessionSnapshotFor,
} from './runner.js'
export type { AppToolRunnerOptions } from './runner.js'
