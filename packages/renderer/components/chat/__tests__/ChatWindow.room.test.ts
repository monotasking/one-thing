// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatWindow from '../ChatWindow.vue'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * 去复用重构 R1 的分流门(docs/design/im-workbench-layout.md §8 铁律 2/3)。
 *
 * 这一组钉三件事:
 *  1. 房 / 私聊 → 新面(房头 + RoomSurface),**没有会话头**;
 *  2. 直聊 → 旧壳(SessionHeader + ChatPanel);
 *  3. 两套聊天面**永不同时挂载**。
 *
 * 判据只剩 `kind === 'room'`:外壳形态那道门(classic 下房也走旧壳)已于
 * 2026-08-05 退役,见 docs/design/product-two-forms-chatgpt-shell.md D2。
 */
const mocks = vi.hoisted(() => ({
  sessions: [
    { id: 'room-1', name: '浏览器重构', kind: 'room', workingDirectory: '/repo' },
    { id: 'chat-1', name: '直聊', workingDirectory: '/repo' },
  ] as any[],
}))

vi.mock('@/stores/sessions', () => ({
  useSessionsStore: () => ({
    currentSessionId: 'room-1',
    isLoading: false,
    sessions: mocks.sessions,
    switchSession: vi.fn(),
    isNewChatDraftId: (id: string) => id.startsWith('draft:'),
    discardNewChatDraft: vi.fn(),
    renameSession: vi.fn(),
    getSessionItem: (id: string) => mocks.sessions.find(item => item.id === id),
  }),
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({
    settings: { general: {}, chat: {} },
  }),
}))

vi.mock('../SessionHeader.vue', () => ({
  default: { name: 'SessionHeader', template: '<div class="mock-session-header" />' },
}))

vi.mock('../ChatPanel.vue', () => ({
  default: { name: 'ChatPanel', props: ['sessionId'], template: '<div class="mock-chat-panel" />' },
}))

vi.mock('../room/RoomHeader.vue', () => ({
  default: {
    name: 'RoomHeader',
    props: ['sessionId', 'showSidebarToggle', 'isInspectorOpen'],
    template: '<div class="mock-room-header" :data-session="sessionId" />',
  },
}))

vi.mock('../room/RoomSurface.vue', () => ({
  default: {
    name: 'RoomSurface',
    props: ['sessionId'],
    template: '<div class="mock-room-surface" :data-session="sessionId" />',
  },
}))

vi.mock('../PracticeStrip.vue', () => ({
  default: { name: 'PracticeStrip', template: '<div class="mock-practice-strip" />' },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function installElectronAPI() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      // P4c 第五批:会话域走通用 RPC 通道,LRU 那两条因此不再是 electronAPI 上的方法。
      rpcInvoke: vi.fn(async (request: { domain: string; method: string }) => {
        if (request.domain === 'sessions' && request.method === 'getCacheStats') {
          return { ok: true, data: { size: 0, maxSize: 10, cachedSessionIds: [] } }
        }
        if (request.domain === 'sessions' && request.method === 'evictCache') {
          return { ok: true, data: { success: true } }
        }
        return { ok: false, error: { message: `unstubbed RPC ${request.domain}.${request.method}` } }
      }),
      closeWindow: vi.fn().mockResolvedValue({ success: true }),
    },
  })
}

function seat(sessionId: string) {
  setActivePinia(createPinia())
  useWorkspaceStore().openSession(sessionId)
}

describe('ChatWindow 房/私聊分流', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
    installElectronAPI()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('房:房头取代会话头,中栏是新面', async () => {
    seat('room-1')
    const wrapper = mount(ChatWindow, { props: { showPracticeStrip: true } })
    await settle()

    expect(wrapper.find('.mock-room-header').exists()).toBe(true)
    expect(wrapper.find('.mock-room-surface').attributes('data-session')).toBe('room-1')
    // 旧壳的三件在这一面上一个都没有。
    expect(wrapper.find('.mock-session-header').exists()).toBe(false)
    expect(wrapper.find('.mock-chat-panel').exists()).toBe(false)
    expect(wrapper.find('.chat-footer').exists()).toBe(false)
    // 练习条是直聊的东西,不进房。
    expect(wrapper.find('.mock-practice-strip').exists()).toBe(false)
  })

  it('直聊:旧壳原样,房面一行都不挂', async () => {
    seat('chat-1')
    const wrapper = mount(ChatWindow, { props: { showPracticeStrip: true } })
    await settle()

    expect(wrapper.find('.mock-session-header').exists()).toBe(true)
    expect(wrapper.find('.mock-chat-panel').exists()).toBe(true)
    expect(wrapper.find('.chat-footer').exists()).toBe(true)
    expect(wrapper.find('.mock-practice-strip').exists()).toBe(true)
    expect(wrapper.find('.mock-room-header').exists()).toBe(false)
    expect(wrapper.find('.mock-room-surface').exists()).toBe(false)
  })

  /**
   * 分流判据只剩 `kind === 'room'` 这一条 —— 外壳形态那道门(classic 下房也走
   * 旧壳)随 shellMode 于 2026-08-05 一起退役,房自此**只有一套**渲染。
   * 见 docs/design/product-two-forms-chatgpt-shell.md D2。
   */
  it('两套聊天面永不同时挂载', async () => {
    for (const sessionId of ['room-1', 'chat-1'] as const) {
      seat(sessionId)
      const wrapper = mount(ChatWindow)
      await settle()
      const mounted = [
        wrapper.find('.mock-room-surface').exists(),
        wrapper.find('.mock-chat-panel').exists(),
      ].filter(Boolean)
      expect(mounted).toHaveLength(1)
      wrapper.unmount()
    }
  })
})
