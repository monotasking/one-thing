/**
 * 角色后缀 `.wiring`(I2,P3'e-A2b):同目录 `skill-review-state.ts` 的
 * `@shared/ipc` 具体化 —— 把泛型的 `TSettings` 钉成 `AppSettings`,别的什么都不做。
 */
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
} from './skill-review-state.js'
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
