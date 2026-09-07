import { beforeEach, expect, it, vi } from 'vitest'
import type { CorePluginCommandContext } from '@onething/core/plugins'

const state = vi.hoisted(() => ({ owner: 'alice', retarget: false, handler: vi.fn(), emit: vi.fn(async (_id: string, _event: unknown, _options?: unknown) => {}), read: vi.fn() }))
vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: id => id === 'session'
    ? { ownerUserId: state.owner, ownerWorkspaceId: 'tenant' } : undefined }) }
})
vi.mock('../../../store.js', () => ({ getSession: state.read }))
vi.mock('../../../events/index.js', () => ({ getEventBus: () => ({ emit: state.emit, emitGlobal: vi.fn() }) }))
vi.mock('../host-ports.js', () => ({ execPluginCommandOnHost: vi.fn() }))
vi.mock('../manager.js', () => ({ getPluginManager: () => ({ getCommandHandler: () => ({
  handler: async (_args: string, context: CorePluginCommandContext) => {
    state.handler()
    if (state.retarget) state.owner = 'bob'
    context.followUp('continue')
  },
}) }) }))

beforeEach(() => {
  vi.clearAllMocks()
  state.owner = 'alice'
  state.retarget = false
  state.read.mockReturnValue({ id: 'session' })
})

it('retains the authorized non-default owner outside the plugin payload', async () => {
  const { executePluginCommandOnHost } = await import('../commands.js')
  await expect(executePluginCommandOnHost({ sessionId: 'session', commandName: '/demo' }, {
    executionContext: { userId: 'alice', workspaceId: 'tenant' },
  })).resolves.toMatchObject({ success: true })
  expect(state.emit).toHaveBeenCalledWith('session', expect.objectContaining({ content: 'continue' }), {
    executionContext: { userId: 'alice', workspaceId: 'tenant' },
  })
  expect(state.emit.mock.calls[0]?.[1]).not.toHaveProperty('executionContext')
})

it('rejects another owner before reading or executing the plugin', async () => {
  const { executePluginCommandOnHost } = await import('../commands.js')
  expect(() => executePluginCommandOnHost({ sessionId: 'session', commandName: '/demo' }, {
    executionContext: { userId: 'bob', workspaceId: 'tenant' },
  })).toThrow('Session not found')
  expect(state.read).not.toHaveBeenCalled()
  expect(state.handler).not.toHaveBeenCalled()
  expect(state.emit).not.toHaveBeenCalled()
})

it('rechecks the actual session at the delayed command emission', async () => {
  const { executePluginCommandOnHost } = await import('../commands.js')
  state.retarget = true
  await executePluginCommandOnHost({ sessionId: 'session', commandName: '/demo' }, {
    executionContext: { userId: 'alice', workspaceId: 'tenant' },
  })
  expect(state.handler).toHaveBeenCalledOnce()
  expect(state.emit).not.toHaveBeenCalled()
})
