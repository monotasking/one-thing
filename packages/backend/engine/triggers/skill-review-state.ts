import {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  clearSkillReviewState,
  getSkillReviewCounter,
  getOnethingSkillReviewInterval,
  isSkillReviewRunning,
  markSkillReviewRunning,
  recordOnethingSkillReviewCounter,
  resetSkillReviewCounter,
  type OnethingSkillReviewCounterInput,
} from '@onething/runtime/triggers'
import type { AppSettings } from '@shared/ipc.js'

export {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  clearSkillReviewState,
  getSkillReviewCounter,
  isSkillReviewRunning,
  markSkillReviewRunning,
  resetSkillReviewCounter,
}

export interface SkillReviewCounterInput extends OnethingSkillReviewCounterInput<AppSettings> {
  settings?: AppSettings
}

export function getSkillReviewInterval(settings?: AppSettings): number {
  return getOnethingSkillReviewInterval(settings)
}

export function recordSkillReviewCounter(input: SkillReviewCounterInput): boolean {
  return recordOnethingSkillReviewCounter(input)
}
