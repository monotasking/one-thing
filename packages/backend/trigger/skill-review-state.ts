import {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  clearSkillReviewState,
  getSkillReviewCounter,
  getSkillReviewInterval as getCoreSkillReviewInterval,
  isSkillReviewRunning,
  markSkillReviewRunning,
  recordSkillReviewCounter as recordCoreSkillReviewCounter,
  resetSkillReviewCounter,
  type CoreSkillReviewCounterInput,
  type CoreSkillReviewSettings,
} from './skill-review-state-core.js'

export {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  clearSkillReviewState,
  getSkillReviewCounter,
  isSkillReviewRunning,
  markSkillReviewRunning,
  resetSkillReviewCounter,
}

export interface OnethingSkillReviewCounterInput<TSettings extends CoreSkillReviewSettings = CoreSkillReviewSettings>
  extends Omit<CoreSkillReviewCounterInput, 'settings'> {
  settings?: TSettings
}

export function getOnethingSkillReviewInterval<TSettings extends CoreSkillReviewSettings>(
  settings?: TSettings,
): number {
  return getCoreSkillReviewInterval(settings)
}

export function recordOnethingSkillReviewCounter<TSettings extends CoreSkillReviewSettings>(
  input: OnethingSkillReviewCounterInput<TSettings>,
): boolean {
  return recordCoreSkillReviewCounter(input)
}
