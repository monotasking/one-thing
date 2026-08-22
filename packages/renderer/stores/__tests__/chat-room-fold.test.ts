// @vitest-environment happy-dom
/**
 * Room utterance folding state (P1-2, todo #6).
 *
 * The ledger stores what the user COLLAPSED, never what is open. That polarity
 * is the whole design: a room opens expanded, so an absent entry has to read as
 * "expanded" — which is also what lets a burst grow while folded (a new message
 * joins a group whose key never changed) without any bookkeeping. The inner Set
 * is not reactive on its own, so every write has to replace the Map, or a
 * template reading through `isRoomGroupCollapsed` would never repaint.
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getSessions: vi.fn(async () => ({ success: true, sessions: [] })),
  getSettings: vi.fn(async () => ({ success: true, settings: {} })),
}))

vi.mock('@/platform', () => ({ platformApi: api }))

vi.mock('../sessions', () => ({
  useSessionsStore: () => ({
    isNewChatDraftId: () => false,
    getSessionItem: () => undefined,
  }),
}))

vi.mock('../settings', () => ({
  useSettingsStore: () => ({ settings: {} }),
}))

import { useChatStore } from '../chat'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('chatStore — collapsed room groups', () => {
  it('defaults to expanded for every group', () => {
    const store = useChatStore()
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(false)
    expect(store.sessionCollapsedRoomGroups.size).toBe(0)
  })

  it('toggles one group without touching its neighbours', () => {
    const store = useChatStore()
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(true)
    expect(store.isRoomGroupCollapsed('room-1', 'm2')).toBe(false)

    store.toggleRoomGroupCollapsed('room-1', 'm1')
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(false)
  })

  it('keeps sessions apart — the same head key in two rooms is two folds', () => {
    const store = useChatStore()
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    expect(store.isRoomGroupCollapsed('room-2', 'm1')).toBe(false)
    store.toggleRoomGroupCollapsed('room-2', 'm1')
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(true)
    expect(store.isRoomGroupCollapsed('room-2', 'm1')).toBe(true)
  })

  it('survives a session switch — the fold belongs to the room, not the view', () => {
    const store = useChatStore()
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    store.toggleRoomGroupCollapsed('room-2', 'm9')
    // Nothing here clears on switch; both ledgers still answer.
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(true)
    expect(store.isRoomGroupCollapsed('room-2', 'm9')).toBe(true)
  })

  it('replaces the Map on every write so watchers fire', () => {
    const store = useChatStore()
    const before = store.sessionCollapsedRoomGroups
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    const afterCollapse = store.sessionCollapsedRoomGroups
    expect(afterCollapse).not.toBe(before)
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    expect(store.sessionCollapsedRoomGroups).not.toBe(afterCollapse)
  })

  it('expandRoomGroup unfolds explicitly and no-ops when already open', () => {
    const store = useChatStore()
    store.toggleRoomGroupCollapsed('room-1', 'm1')
    store.expandRoomGroup('room-1', 'm1')
    expect(store.isRoomGroupCollapsed('room-1', 'm1')).toBe(false)

    // A no-op must not churn the Map (the reveal path calls it on every jump).
    const stable = store.sessionCollapsedRoomGroups
    store.expandRoomGroup('room-1', 'm1')
    store.expandRoomGroup('room-nope', 'm1')
    expect(store.sessionCollapsedRoomGroups).toBe(stable)
  })
})
