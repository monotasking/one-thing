/**
 * task —— 派工:把一段活派给一条后台工作会话、干完叫醒调用方、把整段成果投回去
 * (自举差距审计 P0-3 / P0-5,`docs/audit/self-hosting-gap-audit-2026-08-11.md`)。
 *
 * 对外交出三类东西:
 * - 纯口径(住 `task-rules.ts`):工具 id、并发上限与两只超时、工作会话的判据与它读的形状、
 *   工作会话看不见哪些工具、拒绝的人话、回投正文的排版、工作会话的名字;
 * - 派工层(住 `task-dispatch.ts`):`createTaskDispatchLayer`(装配建一份,投递函数由装配递进来)、
 *   进程单槽的 `dispatchTask` / `runningTaskCount` 与它们的形状;
 * - `task` 工具的端口工厂 `taskToolPorts`(装配递给工具目录)。
 *
 * D202:从前入口里直接写着口径实现,而派工层因为引插件入口的投递函数、交出就成环,只能让装配深引。
 * 投递函数改成装配递进来的端口之后环拆了,派工层与端口工厂都经这里交出。
 *
 * 依赖(入口值闭包实测,481 只文件):session、event、agent-loop、logging(经它们带进 provider、settings、storage 等)
 * 与包根的当前实例槽;引擎、工具系统与插件只有类型引用,不进值图。
 */

export {
  TASK_MAX_CONCURRENT_PER_SESSION,
  TASK_START_TIMEOUT_MS,
  TASK_TOOL_ID,
  TASK_WALL_CLOCK_MS,
  describeTaskRejection,
  isTaskSession,
  renderTaskReport,
  sessionHiddenToolIds,
  taskSessionName,
} from './task-rules.js'
export type {
  TaskOutcome,
  TaskRejectionReason,
  TaskReportInput,
  TaskSessionLike,
  TaskSessionMarkLike,
} from './task-rules.js'

export { createTaskDispatchLayer, dispatchTask, runningTaskCount } from './task-dispatch.js'
export type { TaskDispatchLayer } from './task-dispatch.js'
export { taskToolPorts } from './task-tool-adapters.js'
