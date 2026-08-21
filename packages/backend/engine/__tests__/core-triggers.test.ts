import { describe, expect, it, vi } from 'vitest'
import { CoreTriggerManager, type CoreTrigger } from '@onething/core/engine'

interface TestTriggerContext {
  sessionId: string
}

function trigger(input: {
  id: string
  priority: number
  shouldRun?: boolean
  execute?: () => void | Promise<void>
}): CoreTrigger<TestTriggerContext> {
  return {
    id: input.id,
    name: input.id,
    priority: input.priority,
    shouldTrigger: vi.fn(async () => input.shouldRun ?? true),
    execute: vi.fn(async () => input.execute?.()),
  }
}

describe('CoreTriggerManager', () => {
  it('runs matching triggers by priority and isolates trigger failures', async () => {
    const calls: string[] = []
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const manager = new CoreTriggerManager<TestTriggerContext>(logger)
    const late = trigger({ id: 'late', priority: 20, execute: () => { calls.push('late') } })
    const failing = trigger({ id: 'failing', priority: 10, execute: () => { throw new Error('boom') } })
    const early = trigger({ id: 'early', priority: 5, execute: () => { calls.push('early') } })
    const skipped = trigger({ id: 'skipped', priority: 1, shouldRun: false, execute: () => { calls.push('skipped') } })

    manager.register(late)
    manager.register(failing)
    manager.register(early)
    manager.register(skipped)

    await manager.runPostResponse({ sessionId: 'session-a' })

    expect(calls).toEqual(['early', 'late'])
    expect(logger.error).toHaveBeenCalledWith(
      '[TriggerManager] Trigger failing failed:',
      expect.any(Error),
    )
  })

  it('skips execution while disabled and avoids duplicate registrations', async () => {
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const manager = new CoreTriggerManager<TestTriggerContext>(logger)
    const item = trigger({ id: 'one', priority: 1 })

    manager.register(item)
    manager.register(item)
    manager.setEnabled(false)
    await manager.runPostResponse({ sessionId: 'session-a' })

    expect(item.execute).not.toHaveBeenCalled()
    expect(manager.getTriggers()).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith('[TriggerManager] Trigger one already registered, skipping')
  })
})
