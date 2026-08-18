/**
 * R3a 移植 —— `goal`。§4 的 `SessionTool` 一族。
 *
 * 描述、参数、输出文案、metadata 逐字沿用旧 `tools/builtin/goal.ts`。
 *
 * **无效果**(`Intent.none`):它读写的是这条会话自己的目标记录,旧实现没有
 * `analyze`,权限层今天看到的就是空的。归到 `SessionTool` 是因为它动的是"会话"
 * 这个对象,不是因为它有副作用。
 *
 * 场景面:只在会话有 `active` 目标的回合出现(旧 `scene-surface.ts` 规则 2)。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, Scene, ToolSpec } from '@onething/core/toolkit'
import type { SessionGoal } from '../../goals/types.js'
import { defineInput } from '../contract.js'
import { SessionTool } from '../families/session.js'

export interface GoalToolAdapters {
  /** Current goal including pending accounting, if any. */
  getGoal(sessionId: string): SessionGoal | undefined
  /** Single-writer transition; only 'complete' | 'paused' pass validation. */
  updateGoalFromModel(sessionId: string, status: string, reason?: string): SessionGoal
  /** Remaining tokens against the effective budget; undefined when uncapped. */
  remainingTokens(goal: SessionGoal): number | undefined
}

export const GoalInputSchema = z.object({
  action: z
    .enum(['continue', 'complete', 'pause', 'get'])
    .describe(
      'Your disposition for the active goal: continue (keep working), complete (objective fully satisfied), pause (you need the user), get (read current state).',
    ),
  note: z
    .string()
    .optional()
    .describe('For continue: your next concrete step, one short sentence.'),
  reason: z
    .string()
    .optional()
    .describe(
      'Required for complete and pause. complete: what was delivered and what evidence verifies it. pause: exactly what you need from the user (a decision, missing input, an external blocker).',
    ),
  evidence: z
    .string()
    .optional()
    .describe(
      'Required for complete: itemized verification evidence, one entry per requirement of the objective, each backed by a tool observation (test run, file read, command output).',
    ),
})

export const GOAL_DESCRIPTION = `Declare how your work toward the session's active goal proceeds. While a goal is active, end every reply with one call:
- continue: keep working; "note" = your next concrete step.
- complete: the objective is fully satisfied; "reason" (delivery summary) and "evidence" (itemized verification per requirement) are required. The first complete call per goal triggers a mandatory self-check instead of completing — verify each requirement with tools, then call complete again.
- pause: you need the user; "reason" must state exactly what (a decision, missing input, an external blocker). Never pause because the work is hard, slow or long.
- get: read the objective, status and remaining budget.
Creating, resuming and re-budgeting goals belong to the user (/goal).`

/** 旧 `scene-surface.ts` 的 `GOAL_TOOL_ID`。 */
export const GOAL_TOOL_ID = 'goal'

const GoalContract = defineInput(GoalInputSchema)

export type GoalInput = z.infer<typeof GoalInputSchema>

function describeGoal(goal: SessionGoal, remaining: number | undefined): string {
  return [
    `objective: ${goal.objective}`,
    `status: ${goal.status}${goal.statusReason ? ` (${goal.statusReason})` : ''}`,
    `tokens_used: ${goal.tokensUsed}`,
    `token_budget: ${goal.tokenBudget ?? 'unlimited'}`,
    `remaining_tokens: ${remaining ?? 'unlimited'}`,
    `time_used_seconds: ${Math.round(goal.timeUsedSeconds)}`,
    `auto_continuations: ${goal.continuationCount}`,
  ].join('\n')
}

export class GoalTool extends SessionTool<GoalInput> {
  private readonly adapters: GoalToolAdapters
  /**
   * One mandatory self-check per goal before `complete` is accepted. Process
   * memory is enough: after a restart the model simply re-runs the self-check.
   *
   * 实例字段而不是模块级:旧实现把它建在 `createGoalTool` 的闭包里,同一件事。
   */
  private readonly completeSelfCheckPassed = new Set<string>()

  readonly spec: ToolSpec = {
    id: GOAL_TOOL_ID,
    title: 'Goal',
    description: GOAL_DESCRIPTION,
    input: GoalContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: GoalToolAdapters) {
    super()
    this.adapters = adapters
  }

  /** 没有 active 目标的回合带着它只会引来一次误调(旧场景表规则 2)。 */
  visibleIn(scene: Scene): boolean {
    return scene.goalActive === true
  }

  protected async perform(input: GoalInput, ctx: RunContext): Promise<Result> {
    const sessionId = ctx.invocation.sessionId

    if (input.action === 'continue') {
      const goal = this.adapters.getGoal(sessionId)
      if (!goal) {
        return this.done(ctx, 'No goal', 'No goal is set for this session.', { action: input.action })
      }
      if (goal.status !== 'active') {
        return this.done(
          ctx,
          `Goal ${goal.status}`,
          `The goal is ${goal.status}, not active — do not keep working toward it.\n${describeGoal(goal, this.adapters.remainingTokens(goal))}`,
          { action: input.action, status: goal.status },
        )
      }
      return this.done(
        ctx,
        'Goal — continuing',
        `Continue.${input.note ? ` Next step: ${input.note}` : ''}`,
        { action: input.action, status: goal.status },
      )
    }

    if (input.action === 'complete' || input.action === 'pause') {
      const reason = input.reason?.trim()
      if (!reason) {
        throw new Error(
          input.action === 'complete'
            ? 'complete requires "reason": what was delivered and what evidence verifies it'
            : 'pause requires "reason": exactly what you need from the user',
        )
      }
      if (input.action === 'complete') {
        if (!input.evidence?.trim()) {
          throw new Error(
            'complete requires "evidence": itemized verification evidence, one entry per requirement of the objective',
          )
        }
        const goal = this.adapters.getGoal(sessionId)
        if (goal) {
          const selfCheckKey = `${sessionId}:${goal.id}`
          if (!this.completeSelfCheckPassed.has(selfCheckKey)) {
            this.completeSelfCheckPassed.add(selfCheckKey)
            return this.done(
              ctx,
              'Goal — self-check required',
              'Not completed yet. Before completion is accepted: re-check the objective requirement by requirement against your evidence, and verify with tools where possible (run it, read it, query it). If everything genuinely holds, call complete again to confirm; if anything is unverified, keep working instead.',
              { action: input.action, status: goal.status },
            )
          }
        }
      }
      const updated = this.adapters.updateGoalFromModel(
        sessionId,
        input.action === 'complete' ? 'complete' : 'paused',
        reason,
      )
      return this.done(
        ctx,
        `Goal ${updated.status}`,
        `Goal marked ${updated.status}.\n${describeGoal(updated, this.adapters.remainingTokens(updated))}`,
        { action: input.action, status: updated.status },
      )
    }

    const goal = this.adapters.getGoal(sessionId)
    const output = goal
      ? describeGoal(goal, this.adapters.remainingTokens(goal))
      : 'No goal is set for this session.'
    return this.done(
      ctx,
      goal ? `Goal ${goal.status}` : 'No goal',
      output,
      { action: input.action, status: goal?.status },
    )
  }

  /** 旧 `ToolResult.title` 的等价出口:一条 annotate。 */
  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createGoalTool(adapters: GoalToolAdapters): GoalTool {
  return new GoalTool(adapters)
}
