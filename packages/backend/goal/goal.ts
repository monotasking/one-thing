/**
 * goal —— 会话目标:一个会话可以有一个持续推进的目标(objective + token 预算 + 续推上限),
 * 引擎在每回合结束时按它决定是否自动续推。
 *
 * 对外交出几类东西:目标的形状与常量、目标记录的读写纯函数、状态转移(暂停、阻塞、结算、计数)、
 * 给模型看的提示词渲染、本回合文件改动的汇总;以及运行期的一组(取目标、按模型的话改目标、
 * 续推触发器、引擎钩子与熔断、释放会话状态)。
 * 依赖 session、event、settings、storage、logging 与包根的当前实例槽。
 */
export {
  DEFAULT_GOAL_CONTINUATION_LIMIT,
  DEFAULT_GOAL_ERROR_RETRY_LIMIT,
  GOAL_MODEL_SETTABLE_STATUSES,
  TERMINAL_GOAL_STATUSES,
} from './goal-types.js'
export {
  GOAL_HISTORY_FILE_CHANGE_LIMIT,
  currentGoalOf,
  isGoalTerminal,
  mergeGoalRecord,
  normalizeGoalRecords,
  pruneGoalHistory,
} from './goal-records.js'
export type {
  GoalModelSettableStatus,
  SessionGoal,
  SessionGoalLimits,
  SessionGoalStatus,
} from './goal-types.js'
export {
  GoalStateError,
  abandonGoal,
  applyGoalSettlement,
  applyGoalUsage,
  applyModelGoalStatus,
  applyUserGoalUpdate,
  blockGoalAfterError,
  canAutoContinueGoal,
  clearGoalErrorStreak,
  createSessionGoal,
  effectiveGoalTokenBudget,
  goalContinuationLimit,
  goalErrorRetryLimit,
  isGoalUnfinished,
  recordGoalRunError,
  pauseGoalAfterAbort,
  pauseGoalAtContinuationLimit,
  recordGoalContinuation,
  remainingGoalTokens,
  validateGoalObjective,
  validateGoalTokenBudget,
} from './goal-state.js'
export {
  escapeGoalXmlText,
  renderGoalBudgetLimitPrompt,
  renderGoalContinuationNudge,
  renderGoalContinuationPrompt,
  renderGoalTurnVariableValue,
} from './goal-render.js'
export {
  collectGoalFileSpans,
  countSpanLines,
  summarizeGoalFileChanges,
} from './goal-file-changes.js'
export type {
  GoalFileChange,
  GoalFileMutationRecordLike,
  GoalFileSpan,
} from './goal-file-changes.js'

// 运行期:取目标、按模型的话改目标、续推触发器、引擎钩子与熔断、本回合文件改动的收集。
export {
  disposeGoalRuntimeState,
  flushGoalRuntimeUsage,
  getGoal,
  goalLimits,
  updateGoalFromModel,
} from './goal-manager.js'
export { createGoalContinuationTrigger } from './goal-continuation-trigger.js'
export { bootstrapGoalStreamBreakers, goalRuntimeHooks } from './goal-runtime-hooks.js'
export { collectGoalFileChanges } from './goal-file-change-collector.js'
