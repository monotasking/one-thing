import { describe, expectTypeOf, it } from 'vitest'
import type { SessionToolCallInspection as CoreToolInspection } from '@onething/core/session'
import type {
  SessionToolCallInspection as WireToolInspection,
  SessionEventRecord as WireSessionEvent,
} from '@shared/ipc/session-events.js'
import type { TurnEvalRecord as WireEvalRecord } from '@shared/ipc/evals.js'
import type {
  PracticeConfig,
  PracticeSnapshot,
  PracticeLedgerRecord,
  PracticeSummaryResult,
} from '@shared/ipc/practice.js'
import type { GetUsageSummaryResponse } from '@shared/ipc/usage.js'
import type { TurnEvalRecord } from '../evals/turn-evaluator.js'
import type {
  OnethingPracticeConfig,
  OnethingPracticeEngineSnapshot,
  OnethingPracticeLedgerRecord,
  OnethingPracticeSummaryResult,
} from '../practice/index.js'
import type { OnethingUsageSummaryResult } from '../usage/summary.js'
import type { SessionEventRecord, SessionToolCallInspection } from '../sessions/session-events.js'

describe('runtime and wire contract compatibility', () => {
  it('keeps practice state and reports identical across the transport boundary', () => {
    expectTypeOf<OnethingPracticeConfig>().toEqualTypeOf<PracticeConfig>()
    expectTypeOf<OnethingPracticeEngineSnapshot>().toEqualTypeOf<PracticeSnapshot>()
    expectTypeOf<OnethingPracticeLedgerRecord>().toEqualTypeOf<PracticeLedgerRecord>()
    expectTypeOf<OnethingPracticeSummaryResult>().toEqualTypeOf<PracticeSummaryResult>()
  })

  it('keeps usage and evaluation persisted views compatible with RPC responses', () => {
    expectTypeOf<OnethingUsageSummaryResult>().toEqualTypeOf<GetUsageSummaryResponse>()
    expectTypeOf<TurnEvalRecord>().toEqualTypeOf<WireEvalRecord>()
  })

  it('uses core authority for session event and tool inspection views', () => {
    expectTypeOf<SessionEventRecord>().toEqualTypeOf<WireSessionEvent>()
    expectTypeOf<SessionToolCallInspection>().toEqualTypeOf<WireToolInspection>()
    expectTypeOf<WireToolInspection>().toEqualTypeOf<CoreToolInspection>()
  })
})
