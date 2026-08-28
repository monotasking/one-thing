/**
 * **旧路用例**(U2-a §17.8.7):驱动手写拼装管道并对着 `sessionMessages` 断言。
 * 新路上那棵树由账本折叠产出、手写侧的写在写入口那道闸上被忽略(休眠可回滚),
 * 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setFoldTreeEnabled } from '@/stores/fold-tree'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../chat'
import type { PermissionInfo } from '@shared/ipc/permissions'
import type { ChatMessage } from '@/types'

/**
 * 外部会话(Claude Code SDK)的审批卡:**两截锚各自的兜底**。
 *
 * 现场:后台子代理的工具调用带 `parent_tool_use_id`,连接器按既有约定**不为它
 * 另起工具卡**(`external-agents/claude-code-connector.ts:725`),而审批 ask 携带的
 * `toolCallId` 正是那个嵌套调用的 id。于是卡片要落的那个锚,消息上根本不存在。
 *
 * 锚有两截,缺任何一截卡都出不来(`stores/chat.ts:applyPermissionRequest`):
 *
 *   1. `messageId` —— 先按它找消息,**找不到就进缓存空等**;
 *   2. `callId`   —— 再按它找 toolCall,找不到才轮到领养兜底。
 *
 * 这份文件钉的是**渲染侧这一半的真实分工**:第 2 截这里兜得住(下面前两条),
 * 第 1 截这里**兜不住**(第三条),所以它必须在源头保证 —— 那就是
 * `app/permission/message-anchor.ts` 存在的全部理由。两条外部通路(SDK 与 ACP)
 * 从前各写一份以 `?? ''` 收尾的解析器,而 `''` 是一个永远不会被创建的 messageId:
 * 缓存只由 `applyPendingPermissionRequests(sessionId, messageId)` 在**那条消息被创建
 * 时**唤醒,于是后端挂着等人答、前端一张卡都没有。
 *
 * 接起来跑的那一条(真后端 ask → 真 core 快照 → 真 ChatPanel DOM)在
 * `components/chat/__tests__/ChatPanel.external-permission.test.ts`。
 */

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

/** 后台子代理那条 ask:嵌套 toolCallId,消息上没有对应的工具卡。 */
function nestedAsk(overrides: Partial<PermissionInfo> = {}): PermissionInfo {
  return {
    id: 'perm-1',
    type: 'external-agent',
    pattern: 'Bash',
    sessionId: 's1',
    messageId: 'm1',
    callId: 'toolu_nested_bg_01',
    title: 'Claude Code: Bash',
    metadata: { toolName: 'Bash', command: 'rm -rf build' },
    createdAt: 0,
    targetChannel: 'ipc',
    promptState: 'actionable',
    ...overrides,
  }
}

/**
 * 「卡片可见」的判据:账页(PermissionLedger)与旧壳共用的那一条 —— 会话里存在
 * 一个举着手、可应答、且认得这次 requestId 的 toolCall。
 */
function visibleCardFor(sessionId: string, requestId: string) {
  const messages = useChatStore().sessionMessages.get(sessionId) ?? []
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (
        toolCall.requiresConfirmation &&
        toolCall.canRespond &&
        toolCall.permissionId === requestId
      ) {
        return toolCall
      }
    }
  }
  return undefined
}

describe('外部会话的审批卡:嵌套 / 未知锚', () => {
  beforeEach(() => {
  // 旧路用例(见文件头):把 U2-a 的开关按回手写拼装。
  setFoldTreeEnabled(false)
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: {} })
  })

  it('嵌套 toolCallId(消息上没有这张工具卡)—— 卡仍要画得出来', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })

    store.applyPendingPermissionSnapshot('s1', [nestedAsk()])

    const card = visibleCardFor('s1', 'perm-1')
    expect(card).toBeDefined()
    expect(card!.id).toBe('toolu_nested_bg_01')
    // 栏位要说得出是谁在动什么,不能是空壳。
    expect(card!.toolName).toBe('Bash')
    expect(card!.arguments).toMatchObject({ command: 'rm -rf build' })
  })

  it('真的 tool:call 后到时并进同一条,不留第二张卡', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })
    store.applyPendingPermissionSnapshot('s1', [nestedAsk()])

    store.handleStreamChunk({
      type: 'tool_call',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCall: {
        id: 'toolu_nested_bg_01',
        toolId: 'Bash',
        toolName: 'Bash',
        arguments: { command: 'rm -rf build' },
        status: 'executing',
        timestamp: 0,
      },
    })

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls!.filter(tc => tc.id === 'toolu_nested_bg_01')).toHaveLength(1)
    expect(visibleCardFor('s1', 'perm-1')).toBeDefined()
  })

  /**
   * **这一条是"病"本身,不是"药"** —— 它钉住渲染侧兜不住的那一截,好让
   * `app/permission/message-anchor.ts` 的存在理由留在代码里,而不是留在某个人的记忆里。
   *
   * 谁要是想把源头那个解析器改回 `?? ''`,先来看这条:锚一旦指向渲染侧没有的消息,
   * 卡就进缓存,而唤醒缓存的钥匙(那条消息的创建)永远不会来。
   */
  it('锚指向渲染侧没有的消息 —— 渲染侧兜不住,卡进缓存空等(所以锚必须在源头解析)', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })

    store.applyPendingPermissionSnapshot('s1', [nestedAsk({ messageId: '' })])
    expect(visibleCardFor('s1', 'perm-1')).toBeUndefined()

    store.applyPendingPermissionSnapshot('s1', [nestedAsk({ messageId: 'm-from-another-turn' })])
    expect(visibleCardFor('s1', 'perm-1')).toBeUndefined()

    // 而锚一旦是会话里真的有的那条消息,同一份 ask 立刻立得起来。
    store.applyPendingPermissionSnapshot('s1', [nestedAsk({ messageId: 'm1' })])
    expect(visibleCardFor('s1', 'perm-1')).toBeDefined()
  })
})
