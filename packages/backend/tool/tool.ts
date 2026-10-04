/**
 * tool:工具用到的纯逻辑模块(层次 L1)。
 *
 * 工具系统本身(契约、各族基类、内置工具、执行管线)在 `toolkit`。这里放的是它们都不认识「工具」这个概念的
 * 那些件:沙箱与敏感文件判定、bash 的分类与执行、后台进程表、编辑引擎与差异块、文件快照 / 变更队列 / 变更账本、
 * 输出累加与截断、两只内置工具的纯逻辑(时间、网页搜索),以及几只 IPC 形状的投影(全靠注入的函数工作)。
 * 另有一套不经 toolkit 的旧工具执行器与注册表(`ToolExecutor` / `ToolRegistry`),只剩 agent 的旧引擎在用。
 *
 * 对外交出九类东西(下面按类分组):工具调用的基本形状与旧执行器、中止、沙箱、bash、后台进程、输出、
 * 文件编辑与差异、内置工具的纯逻辑、IPC 形状层。
 *
 * 依赖:storage(读写 JSON、store 目录)、shared。开给界面的操作在第二入口 `tool-client-api.ts`,不经这里。
 * 只用具名导出,每个名字从声明它的那只文件转交;只交外面真在用的名字。
 */

// 1. 工具调用的基本形状与旧执行器
export type { ToolCall, ToolDefinition, ToolResult } from './tool-types.js'
export type { ToolEffect, ToolPreview } from './tool-effect.js'
export type { CoreToolPermissionGuard } from './tool-permission-guards.js'
export { ToolExecutor } from './tool-executor.js'
export { coreToolDefinitionFromJsonSchema, ToolRegistry } from './tool-engine-registry.js'
export { AllowAllPolicy, DenyAllPolicy } from './tool-policy.js'
export type { PermissionPolicy } from './tool-policy.js'

// 2. 中止
export { createToolAbortError, isToolAbortError } from './tool-abort.js'

// 3. 沙箱与敏感文件
export {
  findCoreReadSandboxRootForPath,
  findCoreSandboxRootForPath,
  getCoreSandboxBoundary,
  getCoreSandboxRoots,
  resolveCoreToolPath,
} from './tool-sandbox.js'
export {
  checkOnethingFileAccess,
  configureOnethingToolSandboxRuntime,
  expandOnethingToolSandboxPath,
  findOnethingReadSandboxRootForPath,
  findOnethingSandboxRootForPath,
  getOnethingDefaultReadRoots,
  getOnethingDownloadsDirectory,
  getOnethingReadSandboxRoots,
  getOnethingToolSandboxBoundary,
  getOnethingToolSandboxRoots,
  isOnethingToolPathContained,
  resolveOnethingToolPath,
} from './tool-sandbox-runtime.js'
export type { CoreFileAccessTargetType } from './tool-sandbox-runtime.js'
export { classifySensitiveFile } from './tool-sensitive-files.js'

// 4. bash:命令分类、执行、权限效果
export { classifyBashCommand, parseCommand, registerBashPolicy } from './tool-bash-classifier.js'
export { createLocalBashOperations, killTrackedDetachedChildren } from './tool-bash-executor.js'
export type { BashOperations } from './tool-bash-executor.js'
export { analyzeBashPermission, filePermissionPattern } from './tool-permission-effects.js'

// 5. 后台进程
export { listBackgroundJobs, readBackgroundJobOutput, refreshBackgroundJob, stopBackgroundJob } from './tool-background-jobs.js'
export type { BackgroundJob } from './tool-background-jobs.js'
export { configureAppBackgroundJobs } from './tool-background-jobs-bound.js'

// 6. 输出累加与截断
export { DEFAULT_OUTPUT_MAX_BYTES, DEFAULT_OUTPUT_MAX_LINES, OutputAccumulator } from './tool-output-accumulator.js'
export type { OutputSnapshot } from './tool-output-accumulator.js'
export { formatSize, utf8Bytes } from './tool-text-truncation.js'

// 7. 文件编辑与差异:编辑引擎、差异块、读写队列、快照、变更账本
export { editFailureError, prepareExactEditPreview } from './tool-edit-engine.js'
export type { ExactEdit } from './tool-edit-engine.js'
export { trimDiff, truncateDiffForDisplay } from './tool-replacers.js'
export { computeDiffHunks, trimDiffHunks, truncateDiffHunksForDisplay } from './tool-diff-hunks.js'
export { coreDiffHunksFromJson, coreDiffHunksToJson } from './tool-diff-hunk-json.js'
export type { CoreDiffHunk } from './tool-diff-hunk-json.js'
export { withFileMutationQueue, withFileReadAccess } from './tool-file-mutation-queue.js'
export { countLineChanges, readTextFileSnapshot } from './tool-file-snapshot.js'
export type { TextFileSnapshot } from './tool-file-snapshot.js'
export { applyFileMutationUndo, recordFileMutationAudit } from './tool-file-mutation-audit.js'
export type { FileMutationOperation, RecordFileMutationAuditResult } from './tool-file-mutation-audit.js'

// 8. 内置工具的纯逻辑:时间、网页搜索
export { executeCoreTimeTool } from './builtin/tool-builtin-time-runtime.js'
export type { CoreTimeArgs } from './builtin/tool-builtin-time-runtime.js'
export { fetchSearchPage, fetchSearchPages } from './builtin/web-search/tool-web-search-page-fetch.js'
export type { FetchedSearchPage, FetchFn, SearchPageRequest } from './builtin/web-search/tool-web-search-page-fetch.js'
export { createBraveSearchProvider } from './builtin/web-search/providers/tool-web-search-brave.js'
export type { BraveSearchProviderAdapters } from './builtin/web-search/providers/tool-web-search-brave.js'
export type { SearchProvider, SearchResponse } from './builtin/web-search/providers/tool-web-search-provider-types.js'

// 9. IPC 形状层
export { listOnethingSettingsTools } from './tool-list-presentation.js'
export type { OnethingToolListIpcLogger } from './tool-list-presentation.js'
export type { OnethingToolCallStateIpcLogger } from './tool-call-state.js'
export type { OnethingToolExecutionIpcLogger } from './tool-execution-context.js'
export type { OnethingToolsIpcLogger } from './tool-ipc-operations.js'
