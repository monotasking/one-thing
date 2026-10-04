/**
 * `goal` 工具的适配器工厂(D191,从 `toolkit/toolkit-adapters.ts` 搬回 goal)。
 *
 * 它绑的是 goal 自己的 store 与额度,所以住在 goal、经 goal 入口交出;`backend.ts` 在造工具目录那一步
 * 调它,把结果递进 `buildToolkitCatalog`。工具目录从此不认识 goal。内容与旧路**逐字相同**。
 * 本文件只引兄弟文件,不引 goal 入口;对 toolkit 只有类型引用。
 */
import type { GoalToolAdapters } from '@onething/backend/toolkit'
import { getGoal, goalLimits, updateGoalFromModel } from './goal-manager.js'
import { remainingGoalTokens } from './goal-state.js'

export function goalToolAdapters(): GoalToolAdapters {
  return {
    getGoal,
    updateGoalFromModel,
    remainingTokens: goal => remainingGoalTokens(goal, goalLimits()),
  }
}
