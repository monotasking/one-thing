export const DEFAULT_SKILL_REVIEW_INTERVAL = 10

export interface CoreSkillReviewSettings {
  skills?: {
    creationNudgeInterval?: unknown
  }
}

export interface CoreSkillReviewSessionState {
  iterationsSinceSkillManage: number
  running: boolean
}

export interface CoreSkillReviewCounterInput {
  sessionId: string
  settings?: CoreSkillReviewSettings
  toolIterations: number
  /**
   * 这个会话里技能能不能被写出来。skill_manage 工具已移除，技能改由 write/edit
   * 直接落文件，所以判据从「有没有那个工具」换成「有没有写文件的工具」——
   * 只读档(server readonly)因此仍然不会被提示去创建技能。
   */
  skillAuthoringAvailable: boolean
  skillManageCalled: boolean
}

const states = new Map<string, CoreSkillReviewSessionState>()

function getState(sessionId: string): CoreSkillReviewSessionState {
  let state = states.get(sessionId)
  if (!state) {
    state = { iterationsSinceSkillManage: 0, running: false }
    states.set(sessionId, state)
  }
  return state
}

export function getSkillReviewInterval(settings?: CoreSkillReviewSettings): number {
  const raw = settings?.skills?.creationNudgeInterval
  if (raw === undefined || raw === null) return DEFAULT_SKILL_REVIEW_INTERVAL
  const interval = Number(raw)
  return Number.isFinite(interval) ? Math.floor(interval) : DEFAULT_SKILL_REVIEW_INTERVAL
}

export function resetSkillReviewCounter(sessionId: string): void {
  getState(sessionId).iterationsSinceSkillManage = 0
}

export function getSkillReviewCounter(sessionId: string): number {
  return getState(sessionId).iterationsSinceSkillManage
}

export function clearSkillReviewState(): void {
  states.clear()
}

export function isSkillReviewRunning(sessionId: string): boolean {
  return getState(sessionId).running
}

export function markSkillReviewRunning(sessionId: string, running: boolean): void {
  getState(sessionId).running = running
}

export function recordSkillReviewCounter(input: CoreSkillReviewCounterInput): boolean {
  const interval = getSkillReviewInterval(input.settings)
  const state = getState(input.sessionId)

  if (input.skillManageCalled) {
    state.iterationsSinceSkillManage = 0
    return false
  }

  if (interval <= 0 || !input.skillAuthoringAvailable || input.toolIterations <= 0) {
    return false
  }

  state.iterationsSinceSkillManage += input.toolIterations
  if (state.iterationsSinceSkillManage < interval) {
    return false
  }

  state.iterationsSinceSkillManage = 0
  return true
}
