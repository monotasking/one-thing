import { describe, expectTypeOf, it } from 'vitest'
import type {
  SessionToolCallInspection as CoreToolInspection,
} from '@shared/session/tool-call-inspection'
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
import type { TurnEvalRecord } from '@shared/contracts/eval-record.js'
import type {
  OnethingPracticeConfig,
  OnethingPracticeEngineSnapshot,
  OnethingPracticeLedgerRecord,
  OnethingPracticeSummaryResult,
} from '@shared/contracts/practice.js'
import type { OnethingUsageSummaryResult } from '@shared/contracts/usage.js'
import type { SessionEventRecord } from '../sessions/index.js'
import type { SessionToolCallInspection } from '@shared/session/tool-call-inspection.js'

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
