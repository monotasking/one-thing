/**
 * **这只用例跑的是「旧路」**(U2-a,§17.8.7):它驱动的是手写拼装管道
 * (`handleStreamChunk` 等)并对着 `sessionMessages` 断言,而新路上那棵树由账本
 * 折叠产出、手写侧的写在 `setSessionMessages` 那道闸上被忽略(休眠)。
 *
 * 休眠不是删除 —— 开关一翻整条回来,所以它必须**继续有用例守着**。这里显式把
 * 开关按到旧路,断言一个字未改;新路的等价覆盖在 `fold-tree.test.ts`
 * (新旧路 canonical 对拍)。
 */
// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setFoldTreeEnabled } from '@/stores/fold-tree'
import ChatPanel from '../ChatPanel.vue'
import { useChatStore } from '@/stores/chat'
import type { ChatMessage } from '@/types'

/**
 * 审批账页到底挂不挂得上 —— 真机 2026-08-11 的现场是:store 里
 * `requiresConfirmation && canRespond` 都成立、日志也确认写进去了,而 DOM 里
 * 查不到 `.session-permission-panel`(composer 容器在,账页不在)。
 *
 * 这条把真正的 ChatPanel 挂起来断言。composer 块外面套着 Teleport + v-show +
 * v-memo(七项依赖),账页长在里面 —— 三层里任何一层把子树拦下,这条就红。
 */

const mocks = vi.hoisted(() => ({
  sessionsStore: {
    currentSessionId: 's1',
    sessions: [{ id: 's1', name: 'chat', workingDirectory: '/repo' }],
    getSessionItem: vi.fn(() => ({ id: 's1', name: 'chat', workingDirectory: '/repo' })),
    isUserDmRoomSession: () => false,
  },
  settingsStore: {
    settings: { ui: {}, general: {}, chat: {}, tools: {} } as Record<string, unknown>,
  },
}))

vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))
/**
 * 两个子组件的假体都要**带方法**:ChatPanel 在挂载/切换/卸载时会通过 ref 去存取
 * 滚动快照与输入框草稿(getDistanceToBottom / restoreTail / getMessageInput …),
 * 而 `shallow` 生成的空桩上没有这些方法,异步收尾会抛未捕获的 rejection —— 单跑
 * 看着是绿的,全量跑却把这个文件记成失败。用 `global.stubs` 显式盖过默认桩。
 */
function methodStub(name: string, cls: string, methods: Record<string, unknown>) {
  return defineComponent({
    name,
    setup(_props, { expose }) {
      expose(methods)
      return () => h('div', { class: cls })
    },
  })
}

const MessageListStub = methodStub('MessageList', 'mock-message-list', {
  getDistanceToBottom: () => 0,
  getAnchorMessageId: () => null,
  getAnchorOffset: () => 0,
  getHasNavigated: () => false,
  getNavMessageId: () => null,
  restoreTail: () => {},
  restoreAnchor: () => false,
  prepareForSwitch: () => {},
  notifyLayoutChange: () => {},
  scrollToMessage: () => true,
  confirmTool: () => {},
  rejectTool: () => {},
})

const InputBoxStub = methodStub('InputBox', 'mock-input-box', {
  getMessageInput: () => '',
  getQuotedText: () => '',
  getAttachments: () => [],
  setMessageInput: () => {},
  setQuotedText: () => {},
  clearInput: () => {},
  focus: () => {},
  insertPromptReference: () => {},
  restoreSnapshot: () => {},
})

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    isStreaming: true,
    toolCalls: [],
    steps: [],
    contentParts: [],
    ...overrides,
  }
}

describe('ChatPanel 的审批账页', () => {
  beforeEach(() => {
    // 旧路用例(见文件头):把 U2-a 的开关按回手写拼装。
    setFoldTreeEnabled(false)
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  it('store 里有可应答的审批时,账页必须出现在 DOM 里', async () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })
    store.handleStreamChunk({
      type: 'tool_call',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCall: {
        id: 'tc1',
        toolId: 'read',
        toolName: 'read',
        arguments: { path: '/outside/a.lua' },
        status: 'executing',
        timestamp: 0,
      },
    })

    const wrapper = mount(ChatPanel, {
      props: { sessionId: 's1', active: true },
      shallow: true,
      attachTo: document.body,
      // `shallow` 连 Teleport 一起打桩,而 composer 块(账页就在里面)整个长在
      // Teleport 下 —— 不放它真身,这条测试恒红,且红得像产品坏了。排障时我就
      // 在这上面误判过一次。
      global: { stubs: { teleport: false, MessageList: MessageListStub, InputBox: InputBoxStub } },
    })
    await nextTick()
    // `shallow` 下子组件是桩,断言认渲染产物而不是 findComponent(桩名带 -stub,
    // 用 findComponent({name}) 匹配不到 —— 排障时我在这上面误判过两次)。
    expect(wrapper.html()).not.toContain('permission-ledger-stub')

    // 审批到达 —— 账页的两个条件同时成立。
    store.handlePermissionRequest({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      callId: 'tc1',
      permissionType: 'external_directory',
      title: 'Access directory outside project: /outside/*',
      metadata: { toolName: 'read' },
      canRespond: true,
    })
    await nextTick()

    const message = store.sessionMessages.get('s1')![0]
    // 先钉住 store 侧的事实,免得组件红了却怪错人。
    expect(message.toolCalls![0].requiresConfirmation && message.toolCalls![0].canRespond).toBe(true)

    expect(wrapper.html()).toContain('permission-ledger-stub')
    wrapper.unmount()
  })
})
