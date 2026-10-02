export {
  DEFAULT_GOAL_CONTINUATION_LIMIT,
  DEFAULT_GOAL_ERROR_RETRY_LIMIT,
  GOAL_MODEL_SETTABLE_STATUSES,
  TERMINAL_GOAL_STATUSES,
} from './types.js'
export {
  GOAL_HISTORY_FILE_CHANGE_LIMIT,
  currentGoalOf,
  isGoalTerminal,
  mergeGoalRecord,
  normalizeGoalRecords,
  pruneGoalHistory,
} from './records.js'
export type {
  GoalModelSettableStatus,
  SessionGoal,
  SessionGoalLimits,
  SessionGoalStatus,
} from './types.js'
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
} from './state.js'
export {
  escapeGoalXmlText,
  renderGoalBudgetLimitPrompt,
  renderGoalContinuationNudge,
  renderGoalContinuationPrompt,
  renderGoalTurnVariableValue,
} from './render.js'
export {
  collectGoalFileSpans,
  countSpanLines,
  summarizeGoalFileChanges,
} from './file-changes.js'
export type {
  GoalFileChange,
  GoalFileMutationRecordLike,
  GoalFileSpan,
} from './file-changes.js'
