import { expect, it, vi } from 'vitest'

vi.mock('../../../store.js', () => ({ getSession: () => ({ kind: 'room', room: { memberAgentIds: [] } }) }))
vi.mock('../../usage/index.js', () => ({ getUsageLedger: () => ({ readRecordsInRange: async () => [
  { sessionId: 'alice-room', costUSD: 1 }, { sessionId: 'alice-work', costUSD: 2 },
  { sessionId: 'bob-work', costUSD: 100 }, { sessionId: 'deleted-unknown-owner', costUSD: 1000 },
] }) }))
vi.mock('../board-store.js', () => ({ loadCollabBoard: () => ({ tasks: [{
  workSessionIds: ['alice-work', 'bob-work', 'deleted-unknown-owner'],
}] }) }))
vi.mock('../room-runtime.js', () => ({ postSystemLine: vi.fn() }))

it('does not disclose foreign or ownerless historical costs through a visible room board', async () => {
  const { getCollabRoomSpend } = await import('../budget.js')
  const result = await getCollabRoomSpend('alice-room', { canReadSession: id => id.startsWith('alice-') })
  expect(result).toMatchObject({ success: true, spentTodayUSD: 3 })
})
