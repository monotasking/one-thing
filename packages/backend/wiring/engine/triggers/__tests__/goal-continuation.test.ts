/**
 * The cross-run goal continuation must drive the next run through the shared
 * emitGoalDrive helper (src/main/goals/kick.ts) — the envelope invariants
 * (real transport channel, system-internal source, folding origin) live
 * there, and a second hand-built copy here is how the wrong-channel
 * permission bug originally shipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emitGoalDrive: vi.fn(async (_sessionId: string, _goal: unknown) => {}),
  getGoal: vi.fn(),
  tryBeginContinuation: vi.fn(),
}))

vi.mock('@onething/runtime/goals', () => ({
  canAutoContinueGoal: () => true,
}))

vi.mock('../../../goals/kick.js', () => ({
  emitGoalDrive: mocks.emitGoalDrive,
}))

vi.mock('../../../goals/index.js', () => ({
  getGoal: mocks.getGoal,
  goalLimits: () => ({}),
  tryBeginContinuation: mocks.tryBeginContinuation,
}))

const { createGoalContinuationTrigger } = await import('../goal-continuation.js')

describe('goal-continuation trigger', () => {
  beforeEach(() => {
    mocks.emitGoalDrive.mockClear()
    mocks.tryBeginContinuation.mockReturnValue({ id: 'g1', status: 'active' })
  })

  it('re-drives through the shared emitGoalDrive helper', async () => {
    const trigger = createGoalContinuationTrigger()

    await trigger.execute({ sessionId: 's1' } as never)

    expect(mocks.emitGoalDrive).toHaveBeenCalledTimes(1)
    expect(mocks.emitGoalDrive).toHaveBeenCalledWith('s1', { id: 'g1', status: 'active' })
  })

  it('does not re-drive when continuation could not begin', async () => {
    mocks.tryBeginContinuation.mockReturnValue(undefined)
    const trigger = createGoalContinuationTrigger()

    await trigger.execute({ sessionId: 's1' } as never)

    expect(mocks.emitGoalDrive).not.toHaveBeenCalled()
  })
})
