/**
 * `@onething/app` 的 toolkit 装配面(设计文档 §6)。
 *
 * 端口实现与投影器住在这里,因为它们是**这个宿主**与内核之间的那一层:权限核、
 * 后台进程表、`@shared/ipc` 契约、store —— 产品层碰不得的东西,装配层可以。
 *
 * 一处未接线:R2a 只把这些零件建好并单测,引擎/agent-loop/旧 registry/IPC bridge/
 * 渲染器一个字都没动。
 */

export { createPermissionAuthorizer, PermissionAuthorizer } from './authorizer.js'
export type { PermissionAuthorizerOptions } from './authorizer.js'

export { AuditProjector, combineObservers } from './audit-observer.js'
export type { AuditProjectorOptions, ToolAuditRecord, ToolAuditSink } from './audit-observer.js'

export { deriveLegacyPermissionGuard } from './guard-projection.js'
export type { DeriveGuardOptions } from './guard-projection.js'

export {
  createIpcObserver,
  executionResultFromOutcome,
  IpcProjector,
  metadataUpdateFromAnnotate,
  partialResultFromEvent,
  splitResultContent,
  stepFromEvent,
} from './ipc-observer.js'
export type {
  ExecutionResultProjectionInput,
  LegacyMetadataUpdate,
  LegacyToolAttachment,
  LegacyToolCallbacks,
} from './ipc-observer.js'

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
} from './mcp-catalog.js'

export {
  toolDefinitionFromToolkitTool,
  toolDefinitionsFromCatalog,
  toolkitCatalogToolDefinitions,
} from './catalog-projection.js'

export {
  registerPluginToolInCatalog,
  unregisterPluginToolFromCatalog,
} from './plugin-tools.js'
export type { RegisterPluginToolInput } from './plugin-tools.js'

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
