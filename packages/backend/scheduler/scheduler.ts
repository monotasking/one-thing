/**
 * scheduler —— 定时任务:cron 表达式、进程级调度器(状态落 `<store>/scheduler/state.json`)、
 * 用户自建的定时任务(到点让 agent 跑一回合)与运行历史。
 *
 * 对外交出三类东西:
 * - cron 表达式的纯函数(解析、匹配、算下一次 / 本次、判时区);
 * - 调度器:装配(`configureAppScheduler`)、取用口,用户定时任务的初始化,以及登记任务、
 *   运行记录、任务快照这些形状;
 * - 几只日志口的形状(调度器、agent 任务、用户任务、运行历史、调试面板)。
 * 依赖 agent、session、event、storage、logging 与包根的当前实例槽。
 */

// cron 表达式。
export { cronMatches, currentCronRunAt, isValidTimezone, nextCronRunAt, parseCronExpression } from './scheduler-cron.js'

// 调度器与用户定时任务。
export { configureAppScheduler, getScheduler } from './scheduler-bound.js'
export { initializeUserSchedulerTasks } from './scheduler-user-task-service.js'
export type {
  SchedulerLogger,
  SchedulerRunOptions,
  SchedulerRunRecord,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
} from './scheduler-cron-runner.js'

// 日志口的形状。
export type { OnethingSchedulerAgentTaskLogger } from './scheduler-agent-task-runner.js'
export type { OnethingSchedulerUserTaskLogger } from './scheduler-user-tasks.js'
export type { SchedulerRunHistoryLogger } from './scheduler-run-history.js'
export type { OnethingSchedulerIpcLogger } from './scheduler-ipc-operations.js'
