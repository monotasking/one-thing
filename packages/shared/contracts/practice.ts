/** Serializable practice contracts shared by runtime and transport adapters. */
export type OnethingPracticeKind = 'kegel' | 'pomodoro' | 'exercise'

/** Who wrote the entry: the rhythm timer, the strip's quick-log form, or the agent tool. */
export type OnethingPracticeSource = 'timer' | 'manual' | 'agent'

export interface OnethingPracticeKegelDetail {
  holdSec: number
  relaxSec: number
  /** Total reps completed across the whole session (all sets). */
  repsDone: number
  /** Reps per set. */
  repsTarget: number
  setsDone: number
  setsTarget: number
}

export interface OnethingPracticePomodoroDetail {
  minutes: number
  elapsedMin: number
  completed: boolean
  /** Optional free-form name given at start, on top of the category in `name`. */
  label?: string
}

export interface OnethingPracticeExerciseDetail {
  sets?: number
  repsPerSet?: number
  durationMin?: number
}

export interface OnethingPracticeLedgerRecord {
  id: string
  /** Epoch ms of when the entry was recorded (session end for timer entries). */
  ts: number
  kind: OnethingPracticeKind
  source: OnethingPracticeSource
  /** kegel: '凯格尔'; pomodoro: the category; exercise: the activity name (俯卧撑…). */
  name: string
  note?: string
  kegel?: OnethingPracticeKegelDetail
  pomodoro?: OnethingPracticePomodoroDetail
  exercise?: OnethingPracticeExerciseDetail
}

export interface OnethingPracticeKegelConfig {
  holdSec: number
  relaxSec: number
  /** Reps per set. */
  reps: number
  sets: number
  setRestSec: number
  sound: boolean
}

export interface OnethingPracticePomodoroConfig {
  minutes: number
  categories: string[]
  /** Category used by the menu's one-click start; set on every pomodoro start. */
  lastCategory?: string
}

export interface OnethingPracticeConfig {
  kegel: OnethingPracticeKegelConfig
  pomodoro: OnethingPracticePomodoroConfig
}

export type OnethingPracticeSessionKind = 'kegel' | 'pomodoro'

export type OnethingPracticePhase = 'hold' | 'relax' | 'setRest' | 'focus'

/** Phase-entry edges. The renderer keys its sound cues off these. */
export type OnethingPracticePhaseEdge =
  | 'hold-start'
  | 'relax-start'
  | 'set-rest-start'
  | 'focus-start'
  | 'finished'

export interface OnethingPracticeEngineSnapshot {
  status: 'idle' | 'running' | 'paused'
  kind?: OnethingPracticeSessionKind
  name?: string
  phase?: OnethingPracticePhase
  /** Whole seconds left in the current phase (ceil). */
  phaseSecLeft?: number
  elapsedSec?: number
  totalSec?: number
  /** Kegel: 1-based rep within the current set / reps per set. */
  rep?: number
  reps?: number
  set?: number
  sets?: number
  startedAt?: number
}

export type OnethingPracticeSummaryGranularity = 'day' | 'week' | 'month'

export interface OnethingPracticeCategoryStat {
  key: string
  sessions: number
  minutes: number
}

export interface OnethingPracticeExerciseStat {
  key: string
  entries: number
  sets: number
  reps: number
  durationMin: number
}

export interface OnethingPracticeBucket {
  bucketKey: string
  startTs: number
  endTs: number
  records: number
  kegel: { sessions: number; completedSessions: number; reps: number }
  pomodoro: { sessions: number; completedSessions: number; minutes: number; byCategory: OnethingPracticeCategoryStat[] }
  exercise: { entries: number; byName: OnethingPracticeExerciseStat[] }
}

export interface OnethingPracticeSummaryResult {
  granularity: OnethingPracticeSummaryGranularity
  buckets: OnethingPracticeBucket[]
}

/*
 * 请求/事件形状(工单 5 §5)。
 *
 * 它们从 `@shared/ipc/practice.ts` 搬到这里,理由与这个文件里其余形状一样:
 * **产品层要用它们**。`PracticeService` 是练习域的产品实现(节奏引擎 + 账本 +
 * 配置读写),它从前被困在 `service.wiring.ts` 里,唯一的原因就是这五个类型住在
 * `@shared/ipc` —— 一个产品层不许 import 的地方。形状本身是纯可序列化数据,不带
 * 任何路由/通道词汇,住在契约层才是它们本来的位置。`@shared/ipc/practice.ts`
 * 原样再导出,传输面的名字一个都没变。
 */

export type OnethingPracticeStartRequest =
  | { kind: 'kegel' }
  | { kind: 'pomodoro'; category: string; label?: string }

/** Manual/agent quick-log: either sets×reps or a duration (or both). */
export interface OnethingPracticeLogRequest {
  name: string
  source: 'manual' | 'agent'
  exercise: OnethingPracticeExerciseDetail
  note?: string
  ts?: number
}

export interface OnethingPracticeSummaryRequest {
  granularity: OnethingPracticeSummaryGranularity
  count?: number
}

export interface OnethingPracticeSetConfigRequest {
  config: {
    kegel?: Partial<OnethingPracticeConfig['kegel']>
    pomodoro?: Partial<OnethingPracticeConfig['pomodoro']>
  }
}

/** Pushed to the renderer on every engine transition and ~1 Hz while running. */
export interface OnethingPracticeEventPayload {
  snapshot: OnethingPracticeEngineSnapshot
  edges: OnethingPracticePhaseEdge[]
  settled?: OnethingPracticeLedgerRecord
}
