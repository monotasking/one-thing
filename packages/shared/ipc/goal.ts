/**
 * Goal subsystem IPC types.
 *
 * SessionGoal is a structural mirror of
 * `packages/onething-runtime/src/goals/types.ts` (same pattern as
 * ContextVariable, which is duplicated in chat.ts). The runtime package owns
 * the canonical definition and all state transitions; these types only cross
 * the IPC boundary.
 *
 * Three RPCs, all on the generic RPC channel (`goalRouter`, 主线 T1):
 *   - get   : pull the current goal for a session
 *   - set   : create / update (pause, resume, edit, budget) / clear
 *   - diffs : the goal's file changes with full patches, for review
 *
 * Live updates flow through the `session:goal-updated` event on
 * SESSION_EVENT, so renderer code only needs `get` for the initial fetch.
 * That event stays on its own channel — 主线 T2 收敛事件下行，不是这一批。
 */
import { defineRouter } from './router.js'

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'
  | 'abandoned'

export interface SessionGoal {
  id: string
  objective: string
  status: SessionGoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  continuationCount: number
  /** Consecutive failed runs being retried; cleared on success or resume. */
  errorRetryCount?: number
  budgetLimitReported?: boolean
  statusReason?: string
  /** Net file changes filled in at completion (numstat table). */
  fileChanges?: Array<{ path: string; added: number; removed: number }>
  createdAt: number
  updatedAt: number
  /** When the goal last left 'active'; cleared on resume. Anchor for the
   *  timeline — use this, never updatedAt, which keeps moving. */
  endedAt?: number
  startMessageId?: string
  endMessageId?: string
}

export interface GoalGetRequest {
  sessionId: string
}

export interface GoalGetResponse {
  success: boolean
  /** The current goal: the newest record that has not finished. */
  goal?: SessionGoal | null
  /** Full history, oldest first (see docs/design/goal-system-v3.md). */
  goals?: SessionGoal[]
  error?: string
}

export type GoalSetAction = 'create' | 'update' | 'clear'

export interface GoalSetRequest {
  sessionId: string
  action: GoalSetAction
  /** create: required. update: replaces the objective when present. */
  objective?: string
  /** update only — pause/resume. Other statuses belong to the model/system. */
  status?: 'active' | 'paused'
  /** null clears the per-goal budget back to the global default cap. */
  tokenBudget?: number | null
  /** clear only — why the goal was given up, kept on the archived record. */
  reason?: string
}

export interface GoalSetResponse {
  success: boolean
  goal?: SessionGoal | null
  error?: string
}

/**
 * One file's net change over the goal, with the patch to review it. Same file
 * set as `SessionGoal.fileChanges` — that is the numstat projection of this.
 */
export interface GoalFileDiff {
  /** Workspace-relative when it sits under the session's working directory. */
  path: string
  absolutePath: string
  added: number
  removed: number
  created: boolean
  deleted: boolean
  /** Unified patch of the goal's net effect on the file. */
  diff: string
  /** Full sides, omitted for large files — the patch still renders. */
  beforeContent?: string
  afterContent?: string
}

export interface GoalDiffsRequest {
  sessionId: string
  /** Which goal to review; defaults to the current (or newest) one. */
  goalId?: string
}

export interface GoalDiffsResponse {
  success: boolean
  /** The reviewed goal's objective/status, for the workbench header. */
  goal?: SessionGoal | null
  diffs?: GoalFileDiff[]
  error?: string
}

/**
 * 会话目标域（主线 T1 第一批）。
 *
 * 迁移前 goal 只有 desktop 一条腿：web.ts 里三个函数返回写死的
 * "Goals are not available in the web build"。目标系统本身住在装配层
 * （`@onething/app/goals`，每个宿主都装配了它），所以走通用通道之后 web/server
 * 拿到的是真实现——这一条不是等价搬迁，是顺带补齐的能力。
 */
export type GoalRoutes = {
  get: { input: GoalGetRequest; output: GoalGetResponse }
  set: { input: GoalSetRequest; output: GoalSetResponse }
  diffs: { input: GoalDiffsRequest; output: GoalDiffsResponse }
}

export const goalRouter = defineRouter<GoalRoutes>('goal', [
  'get',
  'set',
  'diffs',
])
