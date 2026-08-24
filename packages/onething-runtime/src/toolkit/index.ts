/**
 * `@onething/runtime/toolkit` —— R1 的工具树(`docs/design/tool-system-oop-2026-08.md`
 * §4/§8)。
 *
 * 与旧 `tools/` 并行存在、**一处未接线**:R1 的验收全部在 `__tests__/parity/` 的
 * 对拍里完成(同一组夹具喂给新旧两条路,比模型文本、权限输入、错误路径、渲染信息)。
 * 引擎侧的三处缝是 R2。
 *
 * 产品层的三条禁令(桌面宿主运行时、宿主 IPC 契约包、装配层)在这棵子树上原样
 * 成立 —— 静态检查器逐字扫这些名字,所以这段注释也不写它们。
 */

export {
  contractForSchema,
  defaultValidationMessage,
  defineInput,
  listZodIssues,
  zodToJsonSchema,
  ZodValidator,
} from './contract.js'
export type { ToolContract, ZodValidatorOptions } from './contract.js'

export { ReadOnlyTool } from './families/read-only.js'
export {
  FileTool,
  SandboxViolationError,
  fileScopeOf,
} from './families/file.js'
export type { FileScope, FileToolAdapters, FileToolContextLike, ResolvedFilePath } from './families/file.js'
export { MAX_REVALIDATION_ATTEMPTS, MutatingFileTool } from './families/mutating-file.js'
export type {
  FileMutationDiff,
  FileMutationPlan,
  MutatingFileToolAdapters,
} from './families/mutating-file.js'
export { ProcessTool } from './families/process.js'
export type {
  CommandClassification,
  CommandScope,
  ForegroundRun,
  ForegroundRunInput,
  ProcessOperationsOptions,
  ProcessToolAdapters,
} from './families/process.js'

export { NetworkTool } from './families/network.js'
export { CollabTool, collabActorAgentId, sceneVenue } from './families/collab.js'
export type { CollabScope, CollabToolAdapters } from './families/collab.js'
export { InteractiveTool } from './families/interactive.js'
export type { InteractiveRequest } from './families/interactive.js'
export { SessionTool } from './families/session.js'
export { CapabilityTool, SELF_EVOLUTION_SKILL_NAME } from './families/capability.js'
export {
  buildMcpPermissionPlan,
  ExternalTool,
  isReadOnlyMcpRouterCall,
  McpTool,
  mcpResultText,
  PluginTool,
  resolveMcpPermissionResourceName,
} from './families/external.js'
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
} from './families/external.js'

export {
  configureToolkitCatalog,
  getToolkitCatalog,
  resolveToolkitSurface,
  toolkitAgentSourceTools,
} from './host.js'
export type { ToolkitAgentSourceTool, ToolkitSurfaceInput } from './host.js'

export { resolveScene } from './scene.js'
export type { ResolveSceneInput, SceneSessionLike } from './scene.js'

export { BashTool, BASH_DESCRIPTION, BashInputSchema, createBashTool } from './builtin/bash.js'
export type { BashInput, BashToolAdapters } from './builtin/bash.js'
export { createEditTool, EditTool, EDIT_DESCRIPTION, EDIT_TOOL_PROMPT, EditInputSchema } from './builtin/edit.js'
export type { EditInput, EditToolAdapters } from './builtin/edit.js'
export { createReadTool, READ_DESCRIPTION, ReadInputSchema, ReadTool } from './builtin/read.js'
export type { ReadInput, ReadToolAdapters } from './builtin/read.js'
export { createTimeTool, TIME_DESCRIPTION, TimeInputSchema, TimeTool } from './builtin/time.js'
export type { TimeInput } from './builtin/time.js'
export {
  createVariableTool,
  VARIABLE_DESCRIPTION,
  VARIABLE_TOOL_PROMPT,
  VariableInputSchema,
  VariableTool,
} from './builtin/variable.js'
export type {
  RuntimeContextVariable,
  RuntimeVariableContext,
  RuntimeVariableRegistry,
  RuntimeVariableSetInput,
  VariableAction,
  VariableInput,
  VariableToolAdapters,
} from './builtin/variable.js'
export { createWriteTool, WRITE_DESCRIPTION, WRITE_TOOL_PROMPT, WriteInputSchema, WriteTool } from './builtin/write.js'
export type { WriteInput, WriteToolAdapters } from './builtin/write.js'

export {
  createAskUserTool,
  ASK_USER_ABORTED_REASON,
  ASK_USER_DESCRIPTION,
  ASK_USER_TIMEOUT_MS,
  AskUserInputSchema,
  AskUserTool,
} from './builtin/ask-user.js'
export type { AskUserAbortInput, AskUserAnswerRecord, AskUserAskInput, AskUserInput, AskUserToolAdapters } from './builtin/ask-user.js'
export {
  BOARD_DESCRIPTION,
  BoardInputSchema,
  BoardTool,
  createBoardTool,
} from './builtin/board.js'
export type { BoardInput, BoardToolAdapters, BoardToolContext } from './builtin/board.js'
export { createGoalTool, GOAL_DESCRIPTION, GOAL_TOOL_ID, GoalInputSchema, GoalTool } from './builtin/goal.js'
export type { GoalInput, GoalToolAdapters } from './builtin/goal.js'
export {
  createHistoryTool,
  HISTORY_DESCRIPTION,
  HISTORY_MAX_LIMIT,
  HistoryInputSchema,
  HistoryTool,
} from './builtin/history.js'
export type { HistoryEntry, HistoryInput, HistoryToolAdapters, HistoryToolResult } from './builtin/history.js'
export {
  createNotebookTool,
  NOTEBOOK_DESCRIPTION,
  NOTEBOOK_NOTE_MAX_CHARS,
  NotebookInputSchema,
  NotebookTool,
} from './builtin/notebook.js'
export type { NotebookInput, NotebookToolAdapters, NotebookToolResult } from './builtin/notebook.js'
export {
  createPracticeTool,
  PRACTICE_DESCRIPTION,
  PracticeInputSchema,
  PracticeTool,
} from './builtin/practice.js'
export type { PracticeInput, PracticeToolAdapters } from './builtin/practice.js'
export { createRadioTool, RADIO_DESCRIPTION, RadioInputSchema, RadioTool } from './builtin/radio.js'
export type { RadioInput, RadioToolAdapters, RadioToolStatus } from './builtin/radio.js'
export {
  createSendMessageTool,
  SEND_MESSAGE_DESCRIPTION,
  SendMessageInputSchema,
  SendMessageTool,
} from './builtin/send-message.js'
export type {
  CollabDmSendResult,
  SayToolResult,
  SendMessageInput,
  SendMessageToolAdapters,
} from './builtin/send-message.js'
export { createTaskTool, TASK_DESCRIPTION, TaskInputSchema, TaskTool } from './builtin/task.js'
export type { TaskDispatchOutcome, TaskDispatchRequest, TaskInput, TaskToolPorts } from './builtin/task.js'
export {
  createWebOpenTool,
  WEB_OPEN_DESCRIPTION,
  WebOpenInputSchema,
  WebOpenTool,
} from './builtin/web-open.js'
export type { WebOpenInput, WebOpenToolAdapters } from './builtin/web-open.js'
export {
  createWebSearchTool,
  WEB_SEARCH_DESCRIPTION,
  WebSearchInputSchema,
  WebSearchTool,
} from './builtin/web-search.js'
export type { WebSearchInput, WebSearchToolAdapters } from './builtin/web-search.js'
