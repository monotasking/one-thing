/**
 * F3/F4 的冻结回归 —— docs/design/session-commands-p0-2026-08.md §5(P0.2 area ①)。
 *
 * 病根:引擎从前把**工作数组本体**交给 `updateMessageToolCalls`,命令面又把入参
 * 数组直接挂到消息上;于是「先就地改 toolCall、再整表写回」实际是在改会话里的
 * 那一份。生产期的 store 会在读出时深冻结(`app/session/freeze.ts`),这类就地改
 * 在冻结下会**当场抛 TypeError**。
 *
 * 引擎自己的单测拿的都是 mock store,冻不到 —— 这个文件补的就是那一层:store 端口
 * 收到什么就深冻结什么(与生产 `getSession`/`getSessionMessages` 的冻结同口径),
 * 然后把 F3 涉及的四条真实路径各跑一遍。任何一处退回就地改,这里立刻红。
 */
import { describe, expect, it } from 'vitest'
import { deepFreeze } from '../../freeze.js'
import { createCoreStreamProcessor } from '../stream-processor.js'
import { executeCoreToolAndUpdate } from '../tool-orchestration.js'
import {
  finalizeLingeringAgentLoopToolWork,
  settleAgentLoopToolResultWithAdapters,
  startAgentLoopToolExecution,
} from '../agent-loop-executor.js'
import { sanitizeSessionOnStartup } from '../../session/commands.js'

/** 与生产同口径:交出去的消息/工具调用一律深冻结。 */
function freezingToolCallStore() {
  const writes: unknown[][] = []
  return {
    writes,
    updateMessageToolCalls(_sessionId: string, _messageId: string, toolCalls: unknown[]) {
      writes.push(deepFreeze(toolCalls) as unknown[])
    },
    updateMessageContent() {},
    updateMessageReasoning() {},
    updateMessageStreaming() {},
    flushSessionSave() {},
  }
}

const noopEmitter = {
  sendTextChunk() {},
  sendReasoningChunk() {},
  sendToolCall() {},
  sendStepAdded() {},
  sendToolInputStart() {},
  sendToolInputDelta() {},
  sendToolInputEnd() {},
  sendToolResult() {},
  sendSkillActivated() {},
  sendStepUpdated() {},
  sendToolExecutionStart() {},
  sendToolExecutionUpdate() {},
  sendToolExecutionEnd() {},
}

describe('工具调用表的 COW(F3):store 深冻结之后引擎照样跑得动', () => {
  it('流式处理器:占位 → 参数收全 → 解析失败改判,三次写回都不改已交出去的对象', () => {
    const store = freezingToolCallStore()
    const processor = createCoreStreamProcessor({
      ctx: { sessionId: 's1', assistantMessageId: 'm1' },
      store,
      emitter: noopEmitter,
      resolveToolIdentity: (toolName: string) => ({
        toolId: toolName,
        displayName: toolName,
        isMcp: false,
      }),
    })

    processor.handleToolInputStart('call-1', 'read')
    processor.handleToolInputDelta('call-1', '{"path":"a.txt"}')
    const settled = processor.handleToolInputEnd('call-1')

    expect(settled).toMatchObject({ id: 'call-1', status: 'received' })
    // 每次写回都是**新数组**:老快照不会被后来的改动追改。
    expect(store.writes.length).toBeGreaterThanOrEqual(2)
    expect(store.writes[0]).not.toBe(store.writes[store.writes.length - 1])
    expect((store.writes[0] as Array<{ status: string }>)[0].status).toBe('input-streaming')
    expect(
      (store.writes[store.writes.length - 1] as Array<{ status: string }>)[0].status,
    ).toBe('received')

    // 解析失败的那条路径:占位改判 failed,同样不许改冻结对象。
    processor.handleToolInputStart('call-2', 'read')
    processor.handleToolInputDelta('call-2', '{not json')
    expect(processor.handleToolInputEnd('call-2')).toBeNull()
    const last = store.writes[store.writes.length - 1] as Array<{ id: string; status: string }>
    expect(last.find(toolCall => toolCall.id === 'call-2')?.status).toBe('failed')
  })

  it('工具执行:开跑 → 结算,写回的是快照,工作表里换成新对象', async () => {
    const store = freezingToolCallStore()
    const toolCall = { id: 'call-1', toolName: 'read', status: 'pending' }
    const allToolCalls = [toolCall]
    const frozenSession = deepFreeze({
      workingDirectory: '/tmp',
      messages: [{ id: 'm1', steps: [] }],
    })

    await executeCoreToolAndUpdate({
      ctx: { sessionId: 's1', assistantMessageId: 'm1' },
      toolCall,
      toolCallData: { toolName: 'read', args: { path: 'a.txt' } },
      allToolCalls,
      store: {
        getSession: () => frozenSession,
        getMessage: () => frozenSession.messages[0],
        updateMessageToolCalls: store.updateMessageToolCalls,
      },
      emitter: noopEmitter,
      executeToolDirectly: async () => ({ success: true, data: 'done' }),
      createStep: () => ({ id: 'step-1', title: 'read', status: 'running', toolCallId: 'call-1' }),
      toJsonValue: value => value as never,
      toStructured: value => value,
      formatFailure: failure => failure.error || 'failed',
      now: () => 100,
      logger: { info() {}, error() {} },
    })

    // 手里那条原样不动;结算态在工作表里。
    expect(toolCall.status).toBe('pending')
    expect(allToolCalls[0]).not.toBe(toolCall)
    expect(allToolCalls[0]).toMatchObject({ status: 'completed', result: 'done' })
  })

  it('agent-loop:开跑与结算都返回新对象,冻结的旧快照不被追改', () => {
    const store = freezingToolCallStore()
    const toolCall = { id: 'call-1', toolId: 'read', toolName: 'read', status: 'received' }
    const toolCalls = [toolCall]

    const started = startAgentLoopToolExecution({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCall,
      toolCalls,
      stepId: 'step-1',
      store,
      emitter: noopEmitter,
      now: () => 100,
    })
    expect(started).toMatchObject({ status: 'executing', startTime: 100 })
    expect(toolCall.status).toBe('received')

    const settlement = settleAgentLoopToolResultWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call-1',
      result: { content: 'ok', data: { output: 'ok' } },
      toolCalls,
      stepIdsByToolCallId: new Map([['call-1', 'step-1']]),
      store,
      emitter: noopEmitter,
      now: () => 200,
    })
    expect(settlement.toolCall).toMatchObject({ status: 'completed', endTime: 200 })
    expect(toolCalls[0]).toBe(settlement.toolCall)
    // 第一次写回的快照仍然停在 executing —— 说明它没有被后来的结算就地追改。
    expect((store.writes[0] as Array<{ status: string }>)[0].status).toBe('executing')
  })

  it('流末收尾(F3):对深冻结的消息算出 patch,不就地改', () => {
    const message = deepFreeze({
      id: 'm1',
      role: 'assistant',
      toolCalls: [{ id: 'call-1', status: 'executing' }],
      steps: [{ id: 'step-1', title: 'read', status: 'running' }],
    })

    const repair = finalizeLingeringAgentLoopToolWork(message, 500)

    expect(repair?.toolCalls?.[0]).toMatchObject({ status: 'cancelled', endTime: 500 })
    expect(repair?.steps?.[0]).toMatchObject({ status: 'cancelled' })
    expect(message.toolCalls[0].status).toBe('executing')
  })

  it('冷启动修复(F4):对深冻结的会话返回新会话,入参一个字段都不动', () => {
    const session = deepFreeze({
      id: 's1',
      updatedAt: 0,
      messages: [{
        id: 'm1',
        role: 'assistant',
        isStreaming: true,
        toolCalls: [{ id: 'call-1', status: 'executing' }],
        steps: [{ id: 'step-1', title: 'Running: bash', status: 'running' }],
      }],
    })

    const repaired = sanitizeSessionOnStartup(session)

    expect(repaired).toBeDefined()
    expect(repaired).not.toBe(session)
    expect(repaired!.messages[0]).toMatchObject({ isStreaming: false })
    expect(session.messages[0].isStreaming).toBe(true)
    expect(session.messages[0].toolCalls[0].status).toBe('executing')
  })
})
