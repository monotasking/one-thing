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

export { AuditProjector, combineObservers } from '@onething/backend/toolkit/audit-observer'
export type { AuditProjectorOptions, ToolAuditRecord, ToolAuditSink } from '@onething/backend/toolkit/audit-observer'

export { deriveLegacyPermissionGuard } from '@onething/backend/toolkit/guard-projection'
export type { DeriveGuardOptions } from '@onething/backend/toolkit/guard-projection'

export {
  createIpcObserver,
  executionResultFromOutcome,
  IpcProjector,
  metadataUpdateFromAnnotate,
  partialResultFromEvent,
  splitResultContent,
  stepFromEvent,
} from '@onething/backend/toolkit/ipc-observer'
export type {
  ExecutionResultProjectionInput,
  LegacyMetadataUpdate,
  LegacyToolAttachment,
  LegacyToolCallbacks,
} from '@onething/backend/toolkit/ipc-observer'

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
} from './tier-catalogs.js'
export type { CatalogAdapters, ToolCatalogTier } from './tier-catalogs.js'

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
} from '@onething/backend/toolkit/mcp-catalog'

export { toolkitPromptFragments, toolkitPromptSource } from '@onething/backend/toolkit/prompt-source'

export type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMetadataUpdate,
  ToolPartialResultUpdate,
} from '@onething/backend/toolkit/execution-types'

export {
  toolDefinitionFromToolkitTool,
  toolDefinitionsFromCatalog,
  toolkitCatalogToolDefinitions,
} from '@onething/backend/toolkit/catalog-projection'

export {
  registerPluginToolInCatalog,
  unregisterPluginToolFromCatalog,
} from '@onething/backend/toolkit/plugin-tools'
export type { RegisterPluginToolInput } from '@onething/backend/toolkit/plugin-tools'

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
} from './runner-factory.js'
export type { AppToolRunnerOptions } from './runner-factory.js'
