/**
 * toolkit:工具系统(层次 L2)—— 一只工具怎么写、怎么登记、每一轮给模型看哪些、怎么执行。
 *
 * 一次调用走 `校验 → 拦截 → plan → 按效果授权 → apply → 输出预算`;权限只看意图里声明的效果。
 * 这里有工具的契约(zod 输入)、协议件(`Tool` / `Intent` / `Catalog`)、各族基类、全部内置工具、
 * 按场景决定回合工具面的 `resolveScene`、执行管线(运行器、中止、结果)、目录投影与提示词来源。
 *
 * 对外交出这几类东西(下面按类分组):契约;写一只工具要的协议件;各族基类;目录与工具面;
 * 内置工具(每只一组);以及文件末尾 2026-10-04 深层引用收口第三批补的执行管线、装配用的工厂、
 * 目录投影与插件工具、执行结果的形状、外部文本的界定。
 *
 * 依赖:tool(纯逻辑模块)、storage、permission(授权器)、logging、settings、session、file、task、agent-loop、
 * lifecycle、variable、shared,以及包根的当前实例槽 `backend-current`。
 * 引上层功能(resource / plugin / task 的接线)的四只文件 —— `toolkit-wiring`、`toolkit-audit-sink`、
 * `toolkit-tool-ports`、`toolkit-adapters` —— 不经这里交出:进入口会把上层拖进入口闭包并成环,装配处直接引它们。
 * 开给界面的操作在第二入口 `toolkit-client-api-self-evolution.ts`,不经这里。只用具名导出。
 */

export {
  contractForSchema,
  defaultValidationMessage,
  defineInput,
  listZodIssues,
  zodToJsonSchema,
  ZodValidator,
} from './toolkit-contract.js'
export type { ToolContract, ZodValidatorOptions } from './toolkit-contract.js'

/*
 * 写一只工具要的那几样协议件(越层清零 A1,2026-10-04):协作的四只工具搬回 collab 自己注册以后,
 * 别的功能里的工具从入口拿基类、意图与目录,而不是钻进 `toolkit-tool-protocol` 这只内部文件。
 */
export { Catalog, Intent, Tool } from './toolkit-tool-protocol.js'
export type { PlanContext, Preview, Result, RunContext, Scene, ToolSpec } from './toolkit-tool-protocol.js'

export { ReadOnlyTool } from './families/toolkit-families-read-only.js'
export {
  FileTool,
  SandboxViolationError,
  fileReadEffects,
  fileReadPreview,
  fileScopeOf,
  resolveFileToolPath,
} from './families/toolkit-families-file.js'
export type { FileScope, FileToolAdapters, FileToolContextLike, ResolvedFilePath } from './families/toolkit-families-file.js'
export { MAX_REVALIDATION_ATTEMPTS, MutatingFileTool, fileMutationEffect } from './families/toolkit-families-mutating-file.js'
export type {
  FileMutationDiff,
  FileMutationPlan,
  MutatingFileToolAdapters,
} from './families/toolkit-families-mutating-file.js'
export { ProcessTool } from './families/toolkit-families-process.js'
export type {
  CommandClassification,
  CommandScope,
  ForegroundRun,
  ForegroundRunInput,
  ProcessOperationsOptions,
  ProcessToolAdapters,
} from './families/toolkit-families-process.js'

export { NetworkTool } from './families/toolkit-families-network.js'
export { InteractiveTool } from './families/toolkit-families-interactive.js'
export type { InteractiveRequest } from './families/toolkit-families-interactive.js'
export { SessionTool } from './families/toolkit-families-session.js'
export { CapabilityTool, SELF_EVOLUTION_SKILL_NAME } from './families/toolkit-families-capability.js'
export {
  buildMcpPermissionPlan,
  ExternalTool,
  isReadOnlyMcpRouterCall,
  McpTool,
  mcpResultText,
  PluginTool,
  resolveMcpPermissionResourceName,
} from './families/toolkit-families-external.js'
export type {
  ExternalToolIsolation,
  ExternalToolReporter,
  McpPermissionPlan,
  McpToolAdapters,
  McpToolBridge,
  McpToolDescription,
  PluginToolAdapters,
  PluginToolDefinitionLike,
  PluginToolHostContext,
  PluginToolHostResult,
} from './families/toolkit-families-external.js'

export {
  configureToolkitCatalog,
  getToolkitCatalog,
  resolveToolkitSurface,
  toolkitAgentSourceTools,
} from './toolkit-host.js'
export type { ToolkitAgentSourceTool, ToolkitSurfaceInput } from './toolkit-host.js'

export { resolveScene } from './toolkit-scene.js'
export type { ResolveSceneInput, SceneSessionLike } from './toolkit-scene.js'

export { BashTool, BASH_DESCRIPTION, BashInputSchema, createBashTool } from './builtin/toolkit-builtin-bash.js'
export type { BashInput, BashToolAdapters } from './builtin/toolkit-builtin-bash.js'
export { createEditTool, EditTool, EDIT_DESCRIPTION, EDIT_TOOL_PROMPT, EditInputSchema } from './builtin/toolkit-builtin-edit.js'
export type { EditInput, EditToolAdapters } from './builtin/toolkit-builtin-edit.js'
export { createReadTool, READ_DESCRIPTION, ReadInputSchema, ReadTool } from './builtin/toolkit-builtin-read.js'
export type { ReadInput, ReadToolAdapters } from './builtin/toolkit-builtin-read.js'
export {
  configureSearchToolAdapters,
  createSearchTool,
  getSearchToolAdapters,
  parseSearchTime,
  renderPreview,
  searchDescription,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_TOOL_PROMPT,
  SearchInputSchema,
  SearchTool,
} from './builtin/toolkit-builtin-search.js'
export type {
  SearchInput,
  SearchToolAdapters,
  SearchToolHit,
  SearchToolIncomplete,
  SearchToolPage,
  SearchToolPrincipal,
  SearchToolQuery,
} from './builtin/toolkit-builtin-search.js'
export { createTimeTool, TIME_DESCRIPTION, TimeInputSchema, TimeTool } from './builtin/toolkit-builtin-time.js'
export type { TimeInput } from './builtin/toolkit-builtin-time.js'
export {
  createVariableTool,
  VARIABLE_DESCRIPTION,
  VARIABLE_TOOL_PROMPT,
  VariableInputSchema,
  VariableTool,
} from './builtin/toolkit-builtin-variable.js'
export type {
  RuntimeContextVariable,
  RuntimeVariableContext,
  RuntimeVariableRegistry,
  RuntimeVariableSetInput,
  VariableAction,
  VariableInput,
  VariableToolAdapters,
} from './builtin/toolkit-builtin-variable.js'
export { createWriteTool, WRITE_DESCRIPTION, WRITE_TOOL_PROMPT, WriteInputSchema, WriteTool } from './builtin/toolkit-builtin-write.js'
export type { WriteInput, WriteToolAdapters } from './builtin/toolkit-builtin-write.js'

export {
  createAskUserTool,
  ASK_USER_ABORTED_REASON,
  ASK_USER_DESCRIPTION,
  ASK_USER_TIMEOUT_MS,
  AskUserInputSchema,
  AskUserTool,
} from './builtin/toolkit-builtin-ask-user.js'
export type { AskUserAbortInput, AskUserAnswerRecord, AskUserAskInput, AskUserInput, AskUserToolAdapters } from './builtin/toolkit-builtin-ask-user.js'
export { createGoalTool, GOAL_DESCRIPTION, GOAL_TOOL_ID, GoalInputSchema, GoalTool } from './builtin/toolkit-builtin-goal.js'
export type { GoalInput, GoalToolAdapters } from './builtin/toolkit-builtin-goal.js'
export {
  createPracticeTool,
  PRACTICE_DESCRIPTION,
  PracticeInputSchema,
  PracticeTool,
} from './builtin/toolkit-builtin-practice.js'
export type { PracticeInput, PracticeToolAdapters } from './builtin/toolkit-builtin-practice.js'
/*
 * K3-b —— `radio` 这只工具退役了(音乐成了一个 scheme,`music/music-resource-spec.ts`),
 * 但**它的适配器形状留下来**:那四条端口(开台 / 关台 / 状态 / 点歌)是装配层与
 * 音乐子系统之间既有的一份契约,`radioAdapters()` 与新的 `MusicResourceProvider`
 * 吃的都是它。类型搬到 `./toolkit-radio-adapters.js`(纯类型,没有工具了)。
 */
export type { RadioToolAdapters, RadioToolStatus } from './toolkit-radio-adapters.js'
export { createTaskTool, TASK_DESCRIPTION, TaskInputSchema, TaskTool } from './builtin/toolkit-builtin-task.js'
export type { TaskDispatchOutcome, TaskDispatchRequest, TaskInput, TaskToolPorts } from './builtin/toolkit-builtin-task.js'
export {
  createWebOpenTool,
  WEB_OPEN_DESCRIPTION,
  WebOpenInputSchema,
  WebOpenTool,
} from './builtin/toolkit-builtin-web-open.js'
export type { WebOpenInput, WebOpenToolAdapters } from './builtin/toolkit-builtin-web-open.js'
export {
  createWebSearchTool,
  WEB_SEARCH_DESCRIPTION,
  WebSearchInputSchema,
  WebSearchTool,
} from './builtin/toolkit-builtin-web-search.js'
export type { WebSearchInput, WebSearchToolAdapters } from './builtin/toolkit-builtin-web-search.js'

/*
 * 深层引用收口第三批(2026-10-04):外面从前直接钻进内部文件拿的名字,补在这里,每个从声明它的那只文件转交。
 */
// 执行管线:运行器、中止、结果、意图里的授权判定、端口形状
export { ToolRunner } from './toolkit-runner.js'
export { AbortScope } from './toolkit-abort-scope.js'
export { Outcome, TOOL_CANCELLED_MESSAGE } from './toolkit-outcome.js'
export { Decision } from './toolkit-intent.js'
export { resultToText, textResult } from './toolkit-result.js'
export type { Invocation } from './toolkit-run-context.js'
export { combineValidators } from './toolkit-ports.js'
export type { Authorizer, Clock, Observer, PartialValidator, SandboxPolicy, ValidationResult, Validator } from './toolkit-ports.js'

// 装配用的工厂:运行器、沙箱策略、授权器、执行登记表、文件适配器
export { createAppToolRunner, createSandboxPolicy, sessionWorkspaceRootFor } from './toolkit-runner-factory.js'
export { createPermissionAuthorizer } from './toolkit-authorizer.js'
export { ToolExecutionRegistry } from './toolkit-executions.js'
export { mutatingFileAdapters, readAdapters } from './toolkit-file-adapters.js'

// 目录投影、提示词来源与插件工具
export { toolDefinitionFromToolkitTool, toolkitCatalogToolDefinitions } from './toolkit-catalog-projection.js'
export { toolkitPromptSource } from './toolkit-prompt-source.js'
export { registerPluginToolInCatalog, unregisterPluginToolFromCatalog } from './toolkit-plugin-tools.js'
export type { ToolCatalogTier } from './toolkit-tier-catalogs.js'

// 执行结果与审计记录的形状
export type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMetadataUpdate,
  ToolPartialResultUpdate,
} from './toolkit-execution-types.js'
export type { ToolAuditRecord } from './toolkit-audit-observer.js'

// 外部文本(网页正文、搜索结果)的界定:标成数据,不是指令
export { wrapUntrustedText } from './toolkit-untrusted-text.js'
