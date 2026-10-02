import { renderGoalTurnVariableValue } from '../../goals/render.js'
import type { SessionGoal, SessionGoalLimits } from '../../goals/types.js'
import type { ContextVariable, VariableContext, VariableProvider } from '../types.js'

const NAME = 'goal'

export interface GoalVariableGateway {
  /** Current goal for the session (pending accounting included), if any. */
  read(sessionId: string): SessionGoal | undefined
  limits?(): SessionGoalLimits
}

/**
 * Read-only state provider exposing the active session goal. It rides the
 * <context-update> tail block, so the objective never enters the prompt-cache
 * prefix. Emits nothing when no goal is set or the goal is
 * finished — a paused/blocked goal still renders so the model knows why it
 * should not press on. Mutations go through the goal tool / GoalManager,
 * never through the variable tool.
 */
export class GoalProvider implements VariableProvider {
  readonly id = 'goal'
  readonly priority = 22

  constructor(private readonly gateway: GoalVariableGateway) {}

  list(ctx: VariableContext): ContextVariable[] {
    const goal = this.gateway.read(ctx.sessionId)
    if (!goal || goal.status === 'complete') return []
    return [{
      name: NAME,
      value: renderGoalTurnVariableValue(goal, this.gateway.limits?.()),
      readonly: true,
      state: true,
      description: 'Persistent session goal the agent keeps working toward (manage via the goal tool)',
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }
}
