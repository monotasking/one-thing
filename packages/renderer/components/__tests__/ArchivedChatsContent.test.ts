// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ArchivedChatsContent from '../ArchivedChatsContent.vue'

// 固定的是"月份",不是年份:月分组头对当年只写「8 月」,跨年才补年份,
// 所以夹具必须活在**运行时的当年**,否则这组断言会在明年元旦自己坏掉。
const THIS_YEAR = new Date().getFullYear()
const AUG_6 = new Date(THIS_YEAR, 7, 6, 10, 0).getTime()
const AUG_2 = new Date(THIS_YEAR, 7, 2, 9, 0).getTime()
const JUL_20 = new Date(THIS_YEAR, 6, 20, 9, 0).getTime()

const sessionsStore = vi.hoisted(() => ({
  isLoading: false,
  currentSessionId: '',
  sessions: [] as Array<Record<string, unknown>>,
  archivedSessions: [] as Array<Record<string, unknown>>,
  switchSession: vi.fn(),
  restoreSession: vi.fn(),
  permanentlyDeleteSession: vi.fn(),
}))

const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => sessionsStore,
}))

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}))

function archived(id: string, name: string, archivedAt: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    archivedAt,
    updatedAt: archivedAt,
    isArchived: true,
    messages: [{ id: 'm1' }, { id: 'm2' }],
    lastModel: 'Sonnet 4.5',
    ...extra,
  }
}

describe('ArchivedChatsContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmMock.mockResolvedValue(true)
    sessionsStore.isLoading = false
    sessionsStore.currentSessionId = ''
    sessionsStore.archivedSessions = [
      archived('a', '八月一号会话', AUG_6),
      archived('b', '八月二号会话', AUG_2),
      archived('c', '七月会话', JUL_20),
    ]
    sessionsStore.sessions = [...sessionsStore.archivedSessions]
  })

  it('groups archived chats by month with a mono count in the ledger header', () => {
    const wrapper = mount(ArchivedChatsContent)

    const headers = wrapper.findAll('.ledger-group-header')
    expect(headers).toHaveLength(2)
    expect(headers[0].find('.lgh-label').text()).toBe('8 月')
    expect(headers[0].find('.lgh-count').text()).toBe('2')
    expect(headers[1].find('.lgh-label').text()).toBe('7 月')
    expect(headers[1].find('.lgh-count').text()).toBe('1')
  })

  it('puts date · message count · model on the mono sub-line of a 44px row', () => {
    const wrapper = mount(ArchivedChatsContent)

    const rows = wrapper.findAll('.chat-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].find('.plr-title').text()).toBe('八月一号会话')
    expect(rows[0].find('.plr-meta').text()).toBe('8 月 6 日 · 2 条消息 · Sonnet 4.5')
  })

  it('keeps restore and delete on the row, and only asks before deleting', async () => {
    const wrapper = mount(ArchivedChatsContent)
    const row = wrapper.findAll('.chat-row')[0]

    await row.find('.row-action.is-restore').trigger('click')
    expect(sessionsStore.restoreSession).toHaveBeenCalledWith('a')
    expect(confirmMock).not.toHaveBeenCalled()

    await row.find('.row-action.is-delete').trigger('click')
    await vi.waitFor(() => {
      expect(sessionsStore.permanentlyDeleteSession).toHaveBeenCalledWith('a')
    })
    expect(confirmMock).toHaveBeenCalledTimes(1)
    // 行动作不能顺带把会话切过去
    expect(sessionsStore.switchSession).not.toHaveBeenCalled()
  })

  it('reports the total and the grouping mode in the status bar', async () => {
    const wrapper = mount(ArchivedChatsContent)
    expect(wrapper.find('.panel-shell-status').text()).toBe('共 3 个会话 · 按月份分组')

    await wrapper.find('.filter-search-input').setValue('七月')
    expect(wrapper.find('.panel-shell-status').text()).toBe('筛出 1 / 共 3 个会话 · 按月份分组')
  })

  it('offers a clear-filters screen when the filter empties the list', async () => {
    const wrapper = mount(ArchivedChatsContent)
    await wrapper.find('.filter-search-input').setValue('没有这个会话')

    expect(wrapper.findAll('.chat-row')).toHaveLength(0)
    expect(wrapper.find('.empty-title').text()).toBe('没有匹配的会话')

    await wrapper.find('.empty-state .text-action').trigger('click')
    expect(wrapper.findAll('.chat-row')).toHaveLength(3)
  })

  it('shows the library-empty screen, not the filter one, when nothing is archived', () => {
    sessionsStore.archivedSessions = []
    sessionsStore.sessions = []
    const wrapper = mount(ArchivedChatsContent)

    expect(wrapper.find('.empty-title').text()).toBe('还没有归档的会话')
    expect(wrapper.find('.panel-shell-status').text()).toBe('归档为空')
  })

  it('switches to branch grouping through the segmented pill', async () => {
    sessionsStore.archivedSessions = [
      archived('parent', '主线', AUG_6),
      archived('child', '分支', AUG_2, { parentSessionId: 'parent' }),
    ]
    sessionsStore.sessions = [...sessionsStore.archivedSessions]
    const wrapper = mount(ArchivedChatsContent)

    const pills = wrapper.findAll('.segmented-pill-item')
    await pills[1].trigger('click')

    expect(wrapper.find('.ledger-group-header .lgh-label').text()).toBe('主线')
    expect(wrapper.find('.panel-shell-status').text()).toContain('按分支分组')
  })
})
