import type {
  OnethingPracticeKind,
  OnethingPracticeSource,
  OnethingPracticeKegelDetail,
  OnethingPracticePomodoroDetail,
  OnethingPracticeExerciseDetail,
  OnethingPracticeLedgerRecord,
  OnethingPracticeKegelConfig,
  OnethingPracticePomodoroConfig,
  OnethingPracticeConfig,
} from '@shared/contracts/practice.js'
export type {
  OnethingPracticeKind,
  OnethingPracticeSource,
  OnethingPracticeKegelDetail,
  OnethingPracticePomodoroDetail,
  OnethingPracticeExerciseDetail,
  OnethingPracticeLedgerRecord,
  OnethingPracticeKegelConfig,
  OnethingPracticePomodoroConfig,
  OnethingPracticeConfig,
} from '@shared/contracts/practice.js'

export interface OnethingPracticeRecordInput {
  ts?: number
  kind: OnethingPracticeKind
  source: OnethingPracticeSource
  name: string
  note?: string
  kegel?: OnethingPracticeKegelDetail
  pomodoro?: OnethingPracticePomodoroDetail
  exercise?: OnethingPracticeExerciseDetail
}

export const ONETHING_PRACTICE_DEFAULT_CONFIG: OnethingPracticeConfig = {
  kegel: { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true },
  pomodoro: { minutes: 25, categories: ['学习', '看视频', '写作', '其他'] },
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, num))
}

/** Merges a possibly-partial/garbage persisted config onto defaults, clamping to sane ranges. */
export function normalizeOnethingPracticeConfig(raw: unknown): OnethingPracticeConfig {
  const source = (raw ?? {}) as { kegel?: Partial<OnethingPracticeKegelConfig>; pomodoro?: Partial<OnethingPracticePomodoroConfig> }
  const defaults = ONETHING_PRACTICE_DEFAULT_CONFIG
  const categories = Array.isArray(source.pomodoro?.categories)
    ? source.pomodoro.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : []
  return {
    kegel: {
      holdSec: clampInt(source.kegel?.holdSec, defaults.kegel.holdSec, 1, 600),
      relaxSec: clampInt(source.kegel?.relaxSec, defaults.kegel.relaxSec, 1, 600),
      reps: clampInt(source.kegel?.reps, defaults.kegel.reps, 1, 500),
      sets: clampInt(source.kegel?.sets, defaults.kegel.sets, 1, 20),
      setRestSec: clampInt(source.kegel?.setRestSec, defaults.kegel.setRestSec, 0, 3600),
      sound: typeof source.kegel?.sound === 'boolean' ? source.kegel.sound : defaults.kegel.sound,
    },
    pomodoro: normalizePomodoro(source.pomodoro, categories, defaults.pomodoro),
  }
}

function normalizePomodoro(
  source: Partial<OnethingPracticePomodoroConfig> | undefined,
  categories: string[],
  defaults: OnethingPracticePomodoroConfig,
): OnethingPracticePomodoroConfig {
  const finalCategories = categories.length > 0 ? categories : [...defaults.categories]
  const normalized: OnethingPracticePomodoroConfig = {
    minutes: clampInt(source?.minutes, defaults.minutes, 1, 240),
    categories: finalCategories,
  }
  if (typeof source?.lastCategory === 'string' && finalCategories.includes(source.lastCategory)) {
    normalized.lastCategory = source.lastCategory
  }
  return normalized
}
