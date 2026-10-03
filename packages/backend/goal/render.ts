/**
 * Rendering for session goals: the per-turn <context-update> variable value
 * and the continuation / budget-limit prompts. The objective is untrusted
 * user data — always escaped and wrapped in <untrusted_objective>.
 */
import goalContinuationRaw from './content/goal-continuation.md?raw'
import goalContinuationNudgeRaw from './content/goal-continuation-nudge.md?raw'
import goalBudgetLimitRaw from './content/goal-budget-limit.md?raw'
import { effectiveGoalTokenBudget, goalContinuationLimit, remainingGoalTokens } from './state.js'
import type { SessionGoal, SessionGoalLimits } from './types.js'

export function escapeGoalXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fillGoalTemplate(template: string, goal: SessionGoal, limits?: SessionGoalLimits): string {
  const budget = effectiveGoalTokenBudget(goal, limits)
  const remaining = remainingGoalTokens(goal, limits)
  const values: Record<string, string> = {
    objective: escapeGoalXmlText(goal.objective),
    tokens_used: String(goal.tokensUsed),
    token_budget: budget === undefined ? 'unlimited' : String(budget),
    remaining_tokens: remaining === undefined ? 'unlimited' : String(remaining),
    time_used_seconds: String(Math.round(goal.timeUsedSeconds)),
    continuation_count: String(goal.continuationCount),
    continuation_limit: String(goalContinuationLimit(limits)),
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match).trim()
}

export function renderGoalContinuationPrompt(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): string {
  return fillGoalTemplate(goalContinuationRaw, goal, limits)
}

/**
 * Short in-run continuation. The full prompt restates the objective and the
 * completion/blocked rules — repeating it verbatim on every in-run
 * continuation made models read the transcript as "the user keeps repeating
 * the same message". Within a run the model has already seen the full rules
 * (run-opening drive or the user's own message) and the objective rides the
 * <goal> context block every turn, so later pushes only need a nudge.
 */
export function renderGoalContinuationNudge(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): string {
  return fillGoalTemplate(goalContinuationNudgeRaw, goal, limits)
}

export function renderGoalBudgetLimitPrompt(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): string {
  return fillGoalTemplate(goalBudgetLimitRaw, goal, limits)
}

/**
 * Value of the `goal` turn variable. Usage is rounded down to the nearest
 * thousand so the bytes stay quiet across turns instead of churning on every
 * token tick.
 */
export function renderGoalTurnVariableValue(
  goal: SessionGoal,
  limits?: SessionGoalLimits,
): string {
  const roundedUsed = Math.floor(goal.tokensUsed / 1000) * 1000
  const budget = effectiveGoalTokenBudget(goal, limits) ?? 'unlimited'
  // The protocol line rides the variable so even the very first run (driven
  // by the user's own goal-set message, which carries no template) sees the
  // declaration rule. Static bytes — cache-quiet across turns.
  const protocolLine = goal.status === 'active'
    ? 'While this goal is active, end every reply by calling the goal tool: continue (note = next step), complete (reason = delivery summary), or pause (reason = what you need from the user).'
    : null
  return [
    `<goal status="${goal.status}" tokens_used="~${roundedUsed}" token_budget="${budget}">`,
    `<untrusted_objective>${escapeGoalXmlText(goal.objective)}</untrusted_objective>`,
    ...(protocolLine ? [protocolLine] : []),
    '</goal>',
  ].join('\n')
}
