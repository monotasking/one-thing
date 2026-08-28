/**
 * **旧路用例**(U2-a §17.8.7):驱动手写拼装管道并对着 `sessionMessages` 断言。
 * 新路上那棵树由账本折叠产出、手写侧的写在写入口那道闸上被忽略(休眠可回滚),
 * 新路的等价覆盖在 `stores/__tests__/fold-tree.test.ts`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setFoldTreeEnabled } from '@/stores/fold-tree'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '../chat'
import { getToolRenderStatus } from '../helpers/tool-status'
import type { ChatMessage } from '@/types'

/**
 * 审批卡在「流的绑定丢了」之后还立不立得住。
 *
 * 真机现场(2026-08-11,会话 8b12ebcc):窗口在一轮跑到一半时重载,渲染侧的
 * `activeStreams` 随之清空;而工具与步骤事件当时不带消息号,`resolveMessageId`
 * 只能退回那个已经不存在的绑定 —— 于是主进程接连发出的三条 tool:call 全被泊死,
 * 消息永远长不出那条调用。随后带着真号来的 `permission:request` 消息找得到、调用
 * 找不到,进缓存空等,而唤醒缓存的正是那批丢掉的事件。后端一直挂着等审批,前端
 * 一张卡都不出,用户只能按停止。
 *
 * 两道闸各测一条:事件带号(根因)、审批自领养(兜底)。
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

describe('绑定丢失后的审批卡', () => {
  beforeEach(() => {
  // 旧路用例(见文件头):把 U2-a 的开关按回手写拼装。
  setFoldTreeEnabled(false)
    setActivePinia(createPinia())
    vi.stubGlobal('window', { electronAPI: {} })
  })

  it('工具事件自带消息号时,不靠 activeStreams 也能落到正确的消息上', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })
    // 窗口中途重载:绑定没了,而这一轮还在跑。
    store.activeStreams.delete('s1')

    store.handleStepAdded({
      sessionId: 's1',
      messageId: 'm1',
      step: {
        id: 'step1',
        type: 'tool-call',
        title: '调用工具: read',
        status: 'running',
        timestamp: 0,
        toolCallId: 'tc1',
      },
    })
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

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls?.map(tc => tc.id)).toEqual(['tc1'])
    expect(message.steps![0].toolCall).toBe(message.toolCalls![0])
  })

  it('工具调用整个丢了,审批仍要立起一张可应答的卡', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })
    store.activeStreams.delete('s1')
    // tool:call / step:added 全部丢失 —— 消息上什么都没有。

    store.handlePermissionRequest({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      callId: 'tc-lost',
      permissionType: 'file_edit',
      title: 'Edit file: /notes/a.md',
      metadata: { toolName: 'edit', path: '/notes/a.md' },
      canRespond: true,
    })

    const message = store.sessionMessages.get('s1')![0]
    const adopted = message.toolCalls!.find(tc => tc.id === 'tc-lost')!
    // 账页(PermissionLedger)的显示条件
    expect(adopted.requiresConfirmation && adopted.canRespond).toBe(true)
    expect(adopted.permissionId).toBe('p1')
    // 栏位要说得出是谁在动什么,不能是空壳
    expect(adopted.toolName).toBe('edit')
    expect(adopted.arguments).toMatchObject({ path: '/notes/a.md' })
    expect(getToolRenderStatus(adopted)).toBe('awaiting-confirmation')
  })

  it('真的 tool:call 后到时并进同一条,不留第二张卡', () => {
    const store = useChatStore()
    store.handleAssistantCreated({ sessionId: 's1', message: assistantMessage() })
    store.handlePermissionRequest({
      sessionId: 's1',
      requestId: 'p1',
      messageId: 'm1',
      callId: 'tc-late',
      permissionType: 'bash',
      title: 'Run command',
      metadata: { toolName: 'bash', command: 'sed -i s/a/b/ f.txt' },
      canRespond: true,
    })

    store.handleStreamChunk({
      type: 'tool_call',
      sessionId: 's1',
      messageId: 'm1',
      content: '',
      toolCall: {
        id: 'tc-late',
        toolId: 'bash',
        toolName: 'bash',
        arguments: { command: 'sed -i s/a/b/ f.txt' },
        status: 'executing',
        timestamp: 0,
      },
    })

    const message = store.sessionMessages.get('s1')![0]
    expect(message.toolCalls!.filter(tc => tc.id === 'tc-late')).toHaveLength(1)
    // 后到的真调用不许把待审批的卡冲掉
    const toolCall = message.toolCalls!.find(tc => tc.id === 'tc-late')!
    expect(toolCall.requiresConfirmation && toolCall.canRespond).toBe(true)
  })
})
