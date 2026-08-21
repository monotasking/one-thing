/**
 * Regression: goal-driven re-drives must carry the session's real transport
 * channel. Permission requests remember the channel active when asked
 * (packages/core/permission/index.ts) and reject responses from any other
 * channel. Two traps guarded here:
 * - stamping a synthetic 'goal' channel broke desktop approvals outright;
 * - the engine's in-memory channel entry is deleted whenever a run ends and
 *   kicks fire exactly when idle, so the live lookup alone always degrades
 *   to 'ipc' — gateway sessions must fall back to the persisted
 *   session.lastConnector.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emit: vi.fn(async (_sessionId: string, _command: { channel?: string; source?: string }) => {}),
  getController: vi.fn(() => undefined as unknown),
  getChannel: vi.fn((_sessionId: string) => 'ipc'),
  getGoal: vi.fn(),
  getSession: vi.fn((_sessionId: string) => undefined as { lastConnector?: string } | undefined),
}))

vi.mock('@onething/runtime/goals', () => ({
  renderGoalContinuationPrompt: () => 'continue',
}))

vi.mock('../../../engine/index.js', () => ({
  getStreamEngineSafe: () => ({
    getController: mocks.getController,
    getChannel: mocks.getChannel,
  }),
}))

vi.mock('../../../events/index.js', () => ({
  getEventBus: () => ({ emit: mocks.emit }),
}))

vi.mock('../../../store.js', () => ({
  getSession: (sessionId: string) => mocks.getSession(sessionId),
}))

vi.mock('../index.js', () => ({
  getGoal: mocks.getGoal,
  goalLimits: () => ({}),
}))

const { kickGoalRunIfIdle } = await import('../kick.js')

const activeGoal = { id: 'g1', status: 'active' } as never

describe('kickGoalRunIfIdle', () => {
  beforeEach(() => {
    mocks.emit.mockClear()
    mocks.getController.mockReturnValue(undefined)
    mocks.getChannel.mockReturnValue('ipc')
    mocks.getSession.mockReturnValue(undefined)
  })

  it('uses the live channel when the engine still holds a real connector', async () => {
    mocks.getChannel.mockReturnValue('wechat')
    kickGoalRunIfIdle('s1', activeGoal)
    await Promise.resolve()

    const [, command] = mocks.emit.mock.calls[0]
    expect(command.channel).toBe('wechat')
    expect(command.source).toBe('goal')
  })

  it('falls back to the persisted connector when the live entry is gone (idle)', async () => {
    // getChannel's no-entry fallback is 'ipc' — indistinguishable from a real
    // desktop channel, so the persisted connector must win for gateway goals.
    mocks.getChannel.mockReturnValue('ipc')
    mocks.getSession.mockReturnValue({ lastConnector: 'wechat' })

    kickGoalRunIfIdle('s1', activeGoal)
    await Promise.resolve()

    const [, command] = mocks.emit.mock.calls[0]
    expect(command.channel).toBe('wechat')
  })

  it('keeps ipc for desktop sessions with no persisted connector', async () => {
    kickGoalRunIfIdle('s1', activeGoal)
    await Promise.resolve()

    const [, command] = mocks.emit.mock.calls[0]
    expect(command.channel).toBe('ipc')
    expect(command.channel).not.toBe('goal')
  })

  it('does not kick when a stream is already active for the session', () => {
    mocks.getController.mockReturnValue({} as never)
    kickGoalRunIfIdle('s1', activeGoal)
    expect(mocks.emit).not.toHaveBeenCalled()
  })

  it('does not kick a non-active goal', () => {
    kickGoalRunIfIdle('s1', { id: 'g1', status: 'paused' } as never)
    expect(mocks.emit).not.toHaveBeenCalled()
  })
})
