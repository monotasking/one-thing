// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission } from '@onething/core/permission'
import ChatPanel from '../ChatPanel.vue'
import { useChatStore } from '@/stores/chat'
import type { ChatMessage } from '@/types'

/**
 * **后台子代理的审批卡到底上不上屏** —— SDK 线冻结前的收口自证(2026-08-11)。
 *
 * 现场就是 b8472769 修通的那一个:后台子代理的工具调用带 `parent_tool_use_id`,
 * 连接器按既有约定**不为它另起工具卡**(`external-agents/claude-code-connector.ts:725`),
 * 于是 ask 携带的嵌套 `toolCallId` 在消息上**不存在**;而会话里此刻可能连一条
 * assistant 消息都还没有,`messageId` 那一截也没有现成的锚。
 *
 * 这一条走**真的 core Permission**(`Permission.ask` → `getPendingPrompts`),把 core
 * 自己吐出来的快照**原样**交给 `applyPendingPermissionSnapshot`(生产上
 * `collabBoard.reconcilePending` 走的正是这一条),再挂**真的 ChatPanel**,断言账页
 * 出现在 DOM 里、点得动、并且真的把后端那次 ask 收了场。
 *
 * ## 与后端那一半的接缝
 *
 * 装配层(`@onething/backend`)对渲染侧是**不可见**的 —— `tsconfig.web.json` 故意不给
 * `@onething/backend` 路径,渲染侧不许看见主进程装配。所以这条测试只负责后半程,
 * 前半程(`askExternalAgentPermission` 在"没有 assistant 消息"时交出的锚必须是会话里
 * 真的有的那条消息)由
 * `packages/backend/wiring/external-agents/__tests__/permission-and-interaction.test.ts`
 * 用真的策略门验。
 *
 * 接缝上传递的就是下面这一个对象:core 的 `PermissionInfo`。两半都对**同一个不变式**
 * 下断言 —— *callId 是消息上不存在的嵌套 id,messageId 是会话里真的有的那条消息* ——
 * 所以两半合起来是一条完整的链,而不是各说各话。
 *
 * 两截锚各有各的兜底,缺一条卡都不出:
 *   - `callId` 那截 → 渲染侧领养(`chat.ts:adoptToolCallForPermission`);
 *   - `messageId` 那截 → 源头保证(`app/permission/message-anchor.ts`)。
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

// —— 渲染侧的邻居 ——
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => mocks.sessionsStore }))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => mocks.settingsStore }))

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

function userMessage(): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    content: '把 build 目录清掉',
    timestamp: 0,
    toolCalls: [],
    steps: [],
    contentParts: [],
  }
}

describe('后台子代理的审批卡(真 core 快照 → 真 ChatPanel DOM)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    Permission.clearSession('s1')
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })

  it('嵌套 toolCallId + 锚落在 user 消息上 —— 账页仍然出现在 DOM 里', async () => {
    // 1) 真 core:后端那次 ask 的形状 —— 嵌套 callId(消息上没有这张工具卡),
    //    锚是会话里真的有的那条 user 消息(assistant 消息还没落库,这正是
    //    `resolvePermissionMessageAnchor` 在源头挑出来的那一条)。
    const decision = Permission.ask({
      type: 'external-agent',
      title: 'Claude Code: Bash',
      pattern: 'Bash',
      sessionId: 's1',
      messageId: 'u1',
      callId: 'toolu_nested_bg_01',
      metadata: { connectorId: 'claude-code-agent', toolName: 'Bash', command: 'rm -rf ./build' },
    })

    await vi.waitFor(() => {
      expect(Permission.getPendingPrompts('s1')).toHaveLength(1)
    })
    const pending = Permission.getPendingPrompts('s1')

    // 接缝上的不变式,与后端那一半逐字同一条。
    expect(pending[0].messageId).toBe('u1')
    expect(pending[0].callId).toBe('toolu_nested_bg_01')

    // 2) 真前端:core 吐出来的快照原样进 store(生产上 reconcilePending 走这条)。
    const store = useChatStore()
    store.handleMessageCreated({ sessionId: 's1', message: userMessage() })

    const wrapper = mount(ChatPanel, {
      props: { sessionId: 's1', active: true },
      shallow: true,
      attachTo: document.body,
      global: { stubs: { teleport: false, MessageList: MessageListStub, InputBox: InputBoxStub } },
    })
    await nextTick()
    expect(wrapper.html()).not.toContain('permission-ledger-stub')

    store.applyPendingPermissionSnapshot('s1', pending)
    await nextTick()

    // 3) 卡片确实立起来了,而且是可应答的那种。
    const adopted = (store.sessionMessages.get('s1') ?? [])
      .flatMap(message => message.toolCalls ?? [])
      .find(toolCall => toolCall.id === 'toolu_nested_bg_01')
    expect(adopted).toBeDefined()
    expect(adopted!.requiresConfirmation && adopted!.canRespond).toBe(true)
    expect(adopted!.permissionId).toBe(pending[0].id)

    // 4) DOM 自证:账页真的画出来了。
    expect(wrapper.html()).toContain('permission-ledger-stub')

    // 5) 用户点得动:从卡上的 permissionId 回答,那次 ask 真的收场。
    Permission.respond({
      sessionId: 's1',
      permissionId: adopted!.permissionId!,
      response: 'once',
    })
    await expect(decision).resolves.toBeUndefined()
    expect(Permission.getPendingPrompts('s1')).toHaveLength(0)

    wrapper.unmount()
  })
})
