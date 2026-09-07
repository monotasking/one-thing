/**
 * 会话目标（主线 T1 第一批）。
 *
 * 取代 `apps/electron/src/main/ipc/goal.ts`（已删）与 web.ts 里那三个写死
 * "not available in the web build" 的桩：目标系统本来就整个住在装配层
 * （`@onething/backend/wiring/goals`，每个宿主的 `createOnethingBackend` 都装配了它），
 * 之前只是没有一条能到达它的传输面。通用通道一接，web/server 拿到的就是同一份
 * 实现——**这条不是等价搬迁，是顺带补齐**。
 *
 * 只搬 RPC 面。目标的实时变化仍走 `session:goal-updated`（SESSION_EVENT），
 * 事件下行的收敛是主线 T2 的事。
 */
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionAccess } from '../../session/access.js'
import type { GoalRoutes } from '@shared/ipc/goal.js'
import type { SessionGoal } from '@shared/ipc/goal.js'
import { collectGoalFileDiffs } from '../../wiring/goals/file-changes.js'
import {
  clearGoal,
  createGoal,
  getGoal,
  getGoals,
  updateGoalFromUser,
} from '../../wiring/goals/index.js'
import { kickGoalRunIfIdle } from '../../wiring/goals/kick.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const goalRpcHandlers: RpcRouteHandlers<GoalRoutes> = {
  async get(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'read')
    try {
      return {
        success: true,
        goal: (getGoal(request.sessionId) as SessionGoal | undefined) ?? null,
        goals: getGoals(request.sessionId) as SessionGoal[],
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async set(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'write')
    try {
      switch (request.action) {
        case 'create': {
          const goal = createGoal(request.sessionId, {
            objective: request.objective ?? '',
            tokenBudget: request.tokenBudget ?? undefined,
          })
          // No kick on create: the renderer sends the goal declaration as a
          // visible 'goal-set' user message, which is itself the first drive.
          return { success: true, goal: goal as SessionGoal }
        }
        case 'update': {
          const goal = updateGoalFromUser(request.sessionId, {
            status: request.status,
            objective: request.objective,
            tokenBudget: request.tokenBudget,
          })
          // Only an explicit resume restarts work; budget or objective edits
          // must not fire runs on their own.
          if (request.status === 'active') {
            kickGoalRunIfIdle(request.sessionId, goal)
          }
          return { success: true, goal: goal as SessionGoal }
        }
        case 'clear': {
          // Archives as 'abandoned' rather than deleting — the record is the
          // only trace this stretch happened.
          clearGoal(request.sessionId, request.reason)
          return { success: true, goal: null }
        }
        default:
          return {
            success: false,
            error: `Unknown goal action: ${String(request.action)}`,
          }
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async diffs(request, context = DESKTOP_RPC_CONTEXT) {
    sessionAccess.resolve(context, request.sessionId, 'read')
    try {
      // Review a specific goal when asked (history holds several now), else
      // the current one.
      const goals = getGoals(request.sessionId) as SessionGoal[]
      const goal = request.goalId
        ? goals.find(entry => entry.id === request.goalId)
        : ((getGoal(request.sessionId) as SessionGoal | undefined)
          ?? goals[goals.length - 1])
      if (!goal) {
        return { success: false, error: 'No goal is set for this session' }
      }
      // The goal's own lifetime is the review window — the same one the
      // numstat summary on the goal was built from.
      const diffs = await collectGoalFileDiffs(request.sessionId, goal.createdAt)
      return { success: true, goal, diffs }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
}
