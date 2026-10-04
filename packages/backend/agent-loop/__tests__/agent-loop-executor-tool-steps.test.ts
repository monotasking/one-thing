import { describe, expect, it } from 'vitest'
import { createAgentLoopExecutorTurnState } from '@onething/backend/agent-loop'
import { applyAgentLoopToolCallFallbackWithAdapters, applyAgentLoopToolInputDeltaWithAdapters, applyAgentLoopToolInputEndWithAdapters, applyAgentLoopToolInputStartWithAdapters, applyAgentLoopToolMetadata, applyAgentLoopToolMetadataWithAdapters, applyAgentLoopToolPartialResultWithAdapters, applyAgentLoopToolResultWithAdapters, buildAgentLoopToolPartialStepUpdate, buildAgentLoopToolResultPresentation, buildAgentLoopToolStartStepUpdate, changesFromMetadata, resultText, settleAgentLoopToolCallResult, settleAgentLoopToolResultWithAdapters, startAgentLoopToolExecution, structuredToolResult, textFromPartialResult } from '../agent-loop-executor-tool-steps.js'
import type { JsonValue } from '@shared/json'

describe('core agent-loop executor helpers', () => {
  it('formats tool results for display and structured IPC updates', () => {
    expect(resultText({ content: 'ok', data: { ignored: true } })).toBe('ok')
    expect(resultText({ data: { output: 'ok' } })).toBe('{"output":"ok"}')
    expect(resultText({ error: 'boom' })).toBe('boom')

    expect(structuredToolResult({ data: { output: 'ok' } })).toEqual({
      content: [{ type: 'text', text: '{"output":"ok"}' }],
      details: { output: 'ok' },
    })
    // S3.1(§10.11):开跑那一刻按**最终参数**重算 type —— 占位那条建在
    // `tool_input_start`,参数还是 `{}`,bash 只能算出 `command`。
    expect(buildAgentLoopToolStartStepUpdate({
      id: 'call_1',
      toolName: 'bash',
      arguments: { command: 'cat skills/lenovo-scripts/SKILL.md' },
      status: 'executing',
    })).toEqual({
      status: 'running',
      type: 'skill-read',
      toolCall: {
        id: 'call_1',
        toolName: 'bash',
        arguments: { command: 'cat skills/lenovo-scripts/SKILL.md' },
        status: 'executing',
      },
    })
    expect(buildAgentLoopToolStartStepUpdate({
      id: 'call_2',
      toolName: 'bash',
      arguments: { command: 'mkdir tmp' },
    }).type).toBe('file-write')
    expect(buildAgentLoopToolStartStepUpdate({
      id: 'call_3',
      toolName: 'read',
      arguments: { path: 'README.md' },
    }).type).toBe('tool-call')
  })

  it('settles agent-loop tool calls without store or emitter access', () => {
    const completed = {
      id: 'call_1',
      toolId: 'read',
      toolName: 'read',
      status: 'executing',
    }
    // COW(P0.2 area ①,F3):结算返回**新** toolCall,入参那条一个字段都不动。
    const settlement = settleAgentLoopToolCallResult(completed, {
      content: 'ok',
      data: { output: 'ok' },
    }, 1234)
    expect(settlement).toMatchObject({
      awaitingConfirmation: false,
      skillManageCalled: false,
    })
    expect(settlement.toolCall).not.toBe(completed)
    expect(settlement.toolCall).toMatchObject({
      status: 'completed',
      result: { output: 'ok' },
      endTime: 1234,
      requiresConfirmation: false,
    })
    expect(completed.status).toBe('executing')
    expect(buildAgentLoopToolResultPresentation(settlement.toolCall, {
      content: 'ok',
      data: { output: 'ok' },
    })).toEqual({
      executionEnd: {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          details: { output: 'ok' },
        },
        isError: false,
        error: undefined,
      },
      stepUpdate: {
        status: 'completed',
        toolCall: { ...settlement.toolCall },
        partialResult: {
          content: [{ type: 'text', text: 'ok' }],
          details: { output: 'ok' },
        },
        partialResultIsPartial: false,
        result: 'ok',
        error: undefined,
        rejected: undefined,
        rejectionReason: undefined,
      },
    })

    const rejected = {
      id: 'call_2',
      toolId: 'edit',
      toolName: 'edit',
      status: 'executing',
    }
    const rejectedSettlement = settleAgentLoopToolCallResult(rejected, {
      error: 'Denied',
      data: { rejected: true, rejectionReason: 'No edits' },
    }, 2345)
    expect(rejectedSettlement.toolCall).toMatchObject({
      status: 'failed',
      rejected: true,
      rejectionReason: 'No edits',
      error: 'Denied',
      endTime: 2345,
    })
    expect(buildAgentLoopToolResultPresentation(rejectedSettlement.toolCall, {
      error: 'Denied',
      data: { rejected: true, rejectionReason: 'No edits' },
    })).toMatchObject({
      executionEnd: {
        result: undefined,
        isError: true,
        error: 'Denied',
      },
      stepUpdate: {
        status: 'failed',
        result: 'Denied',
        error: 'Denied',
        rejected: true,
        rejectionReason: 'No edits',
      },
    })

    const pending = {
      id: 'call_3',
      toolId: 'skill_manage',
      toolName: 'skill_manage',
      status: 'executing',
    }
    const pendingSettlement = settleAgentLoopToolCallResult(pending, {
      requiresConfirmation: true,
      error: 'Confirm skill update',
      data: { commandType: 'dangerous' },
    }, 3456)
    expect(pendingSettlement).toMatchObject({
      awaitingConfirmation: true,
      // skill_manage 工具已移除,没有可识别的专用调用了。
      skillManageCalled: false,
    })
    expect(pendingSettlement.toolCall).toMatchObject({
      status: 'pending',
      requiresConfirmation: true,
      commandType: 'dangerous',
      error: 'Confirm skill update',
      endTime: 3456,
    })
    expect(buildAgentLoopToolResultPresentation(pendingSettlement.toolCall, {
      requiresConfirmation: true,
      error: 'Confirm skill update',
      data: { commandType: 'dangerous' },
    }, true)).toEqual({
      stepUpdate: {
        status: 'awaiting-confirmation',
        toolCall: { ...pendingSettlement.toolCall },
        error: 'Confirm skill update',
      },
    })
  })

  it('runs agent-loop tool lifecycle through headless store and emitter adapters', () => {
    interface TestToolCall {
      id: string
      toolId?: string
      toolName: string
      arguments?: { path?: string }
      status?: string
      startTime?: number
      endTime?: number
      result?: JsonValue
      error?: string
      rejected?: boolean
      rejectionReason?: string
      requiresConfirmation?: boolean
      commandType?: string
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    }

    const toolCall: TestToolCall = {
      id: 'call_1',
      toolId: 'read',
      toolName: 'read',
      arguments: { path: 'a.txt' },
      status: 'pending',
    }
    const toolCalls = [toolCall]
    const stepIds = new Map([['call_1', 'step_1']])
    const events: string[] = []
    const store = {
      updateMessageToolCalls: (_sessionId: string, _messageId: string, calls: TestToolCall[]) => {
        events.push(`store:${calls[0].status}`)
      },
    }
    const emitter = {
      sendToolCall: (call: TestToolCall) => events.push(`tool-call:${call.status}`),
      sendToolResult: (call: TestToolCall) => events.push(`tool-result:${call.status}`),
      sendToolExecutionStart: (toolCallId: string, stepId: string, toolName: string, args: unknown) => {
        events.push(`start:${toolCallId}:${stepId}:${toolName}:${JSON.stringify(args)}`)
      },
      sendToolExecutionUpdate: (toolCallId: string, stepId: string, partial: { content: Array<{ text?: string }> }) => {
        events.push(`partial:${toolCallId}:${stepId}:${partial.content[0]?.text}`)
      },
      sendToolExecutionEnd: (toolCallId: string, stepId: string, result?: unknown, isError?: boolean, error?: string) => {
        events.push(`end:${toolCallId}:${stepId}:${isError}:${error ?? ''}:${JSON.stringify(result)}`)
      },
      sendStepUpdated: (stepId: string, updates: { status?: string; title?: string; result?: string }) => {
        events.push(`step:${stepId}:${updates.status ?? updates.title ?? updates.result}`)
      },
      sendSkillActivated: (skillName: string) => {
        events.push(`skill:${skillName}`)
      },
    }

    // COW(F3):开跑返回新对象并换进工作表;手里那条不动。
    const started = startAgentLoopToolExecution({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCall,
      toolCalls,
      stepId: 'step_1',
      store,
      emitter,
      now: () => 100,
    })
    expect(started).toMatchObject({ status: 'executing', startTime: 100 })
    expect(toolCalls[0]).toBe(started)

    expect(applyAgentLoopToolPartialResultWithAdapters({
      toolCallId: 'call_1',
      update: { content: [{ type: 'text', text: 'partial' }] },
      stepIdsByToolCallId: stepIds,
      emitter,
    })).toBe(true)

    expect(applyAgentLoopToolMetadataWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      update: {
        title: 'Read a.txt',
        metadata: {
          output: 'preview',
          path: 'a.txt',
          diff: '+hello',
          additions: 1,
          deletions: 0,
        },
      },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      store,
      emitter,
    })).toBe(true)
    // 发现 A(§13.18):COW —— 入参那条(旧引用)不动,但带 changes 的新对象已换进工作表
    // 并整表快照落盘,settle 从工作表重取时自然继承。
    expect(toolCall.changes).toBeUndefined()
    expect(toolCalls[0].changes).toMatchObject({ diff: '+hello', filePath: 'a.txt' })
    expect(events.some(event => event.includes('step:step_1:Read a.txt'))).toBe(true)

    const settlement = settleAgentLoopToolResultWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      result: { content: 'done', data: { output: 'done' } },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      store,
      emitter,
      now: () => 200,
    })

    expect(settlement).toMatchObject({
      found: true,
      toolIterationsDelta: 1,
      awaitingConfirmation: false,
    })
    // COW(F3):结算后的那一版在工作表里,`toolCall` 是旧引用。
    expect(settlement.toolCall).toMatchObject({
      status: 'completed',
      result: { output: 'done' },
      endTime: 200,
    })
    expect(toolCalls[0]).toBe(settlement.toolCall)
    expect(events).toEqual([
      'store:executing',
      'tool-call:executing',
      'start:call_1:step_1:read:{"path":"a.txt"}',
      'step:step_1:running',
      'partial:call_1:step_1:partial',
      'step:step_1:running',
      // 发现 A(§13.18):metadata 时刻多一次整表快照落盘(带 changes)。
      'store:executing',
      'step:step_1:Read a.txt',
      'store:completed',
      'tool-result:completed',
      'end:call_1:step_1:false::{"content":[{"type":"text","text":"done"}],"details":{"output":"done"}}',
      'step:step_1:completed',
    ])
  })

  it('carries edit changes from tool-metadata into both the store snapshot and the settle step update (§13.18 发现 A)', () => {
    interface TestToolCall {
      id: string
      toolId?: string
      toolName: string
      arguments?: { path?: string }
      status?: string
      startTime?: number
      endTime?: number
      result?: JsonValue
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    }

    const toolCall: TestToolCall = {
      id: 'call_edit',
      toolId: 'edit',
      toolName: 'edit',
      arguments: { path: 'src/a.ts' },
      status: 'pending',
    }
    const toolCalls = [toolCall]
    const stepIds = new Map([['call_edit', 'step_edit']])

    // 落盘快照:store 每次收到的整表(取第一条,深拷 changes 以免后续 COW 覆盖引用)。
    const storeSnapshots: Array<TestToolCall['changes']> = []
    const store = {
      updateMessageToolCalls: (_s: string, _m: string, calls: TestToolCall[]) => {
        storeSnapshots.push(calls[0]?.changes ? { ...calls[0].changes } : undefined)
      },
    }
    let lastStepToolCall: TestToolCall | undefined
    const emitter = {
      sendToolCall: () => {},
      sendToolResult: () => {},
      sendToolExecutionStart: () => {},
      sendToolExecutionUpdate: () => {},
      sendToolExecutionEnd: () => {},
      sendStepUpdated: (_stepId: string, updates: { toolCall?: TestToolCall }) => {
        if (updates.toolCall) lastStepToolCall = updates.toolCall
      },
      sendSkillActivated: () => {},
    }

    startAgentLoopToolExecution({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCall,
      toolCalls,
      stepId: 'step_edit',
      store,
      emitter,
      now: () => 100,
    })

    applyAgentLoopToolMetadataWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_edit',
      update: {
        metadata: {
          output: 'edited',
          path: 'src/a.ts',
          diff: '@@ -1 +1 @@\n-old\n+new',
          diffHunks: [],
          additions: 1,
          deletions: 1,
        },
      },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      store,
      emitter,
    })

    // metadata 时刻:工作表已带 changes,并已整表快照落盘。
    expect(toolCalls[0].changes).toMatchObject({ filePath: 'src/a.ts', additions: 1, deletions: 1 })
    expect(storeSnapshots.at(-1)).toMatchObject({ filePath: 'src/a.ts' })

    const settlement = settleAgentLoopToolResultWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_edit',
      result: { content: 'done', data: { output: 'done' } },
      toolCalls,
      stepIdsByToolCallId: stepIds,
      store,
      emitter,
      now: () => 200,
    })

    // settle 后:顶层快照(store 最后一次收到的)与 stepUpdate.toolCall **都带** changes。
    expect(settlement.toolCall?.changes).toMatchObject({ filePath: 'src/a.ts' })
    expect(storeSnapshots.at(-1)).toMatchObject({ filePath: 'src/a.ts' })
    expect(lastStepToolCall?.changes).toMatchObject({ filePath: 'src/a.ts' })
  })

  it('extracts text from partial results and diff metadata', () => {
    expect(textFromPartialResult({
      content: [
        { type: 'text', text: 'half' },
        { type: 'text', text: 'way' },
      ],
    })).toBe('halfway')
    expect(buildAgentLoopToolPartialStepUpdate({
      content: [
        { type: 'text', text: 'half' },
        { type: 'text', text: 'way' },
      ],
    })).toEqual({
      status: 'running',
      partialResult: {
        content: [
          { type: 'text', text: 'half' },
          { type: 'text', text: 'way' },
        ],
      },
      partialResultIsPartial: true,
      result: 'halfway',
    })

    expect(changesFromMetadata({
      path: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
      originalContentHash: 'before',
    })).toEqual({
      filePath: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
      originalContent: undefined,
      originalContentHash: 'before',
      afterContentHash: undefined,
      auditId: undefined,
      auditPath: undefined,
    })
  })

  it('builds tool metadata step updates without emitter access', () => {
    const toolCall: {
      id: string
      toolName: string
      status: string
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    } = {
      id: 'call_1',
      toolName: 'edit',
      status: 'executing',
    }

    expect(applyAgentLoopToolMetadata(toolCall, {
      title: 'Edited file',
      metadata: {
        output: 'updated',
        path: '/tmp/a.txt',
        diff: '-old\n+new',
        additions: 1,
        deletions: 1,
      },
    })).toEqual({
      title: 'Edited file',
      result: 'updated',
      toolCall: {
        ...toolCall,
        changes: {
          filePath: '/tmp/a.txt',
          diff: '-old\n+new',
          additions: 1,
          deletions: 1,
          originalContent: undefined,
          originalContentHash: undefined,
          afterContentHash: undefined,
          auditId: undefined,
          auditPath: undefined,
        },
      },
    })
    // COW(F3):`changes` 落在返回的新对象上,入参那条不动。
    expect(toolCall.changes).toBeUndefined()

    expect(applyAgentLoopToolMetadata(undefined, {
      metadata: { count: 2 },
    })).toEqual({ result: '{"count":2}' })
  })

  it('applies agent-loop tool input/call/result chunks through core adapters', () => {
    interface TestToolCall {
      id: string
      toolId?: string
      toolName: string
      arguments?: { path?: string }
      status?: string
      startTime?: number
      endTime?: number
      result?: JsonValue
      error?: string
      rejected?: boolean
      rejectionReason?: string
      requiresConfirmation?: boolean
    }

    const toolCalls: TestToolCall[] = []
    const events: string[] = []
    const processor = {
      toolCalls,
      getStepIdForToolCall: (toolCallId: string) => `step_${toolCallId}`,
      handleToolInputStart(toolCallId: string, toolName: string, turnIndex: number) {
        events.push(`input-start:${toolCallId}:${toolName}:${turnIndex}`)
      },
      handleToolInputDelta(toolCallId: string, argsTextDelta: string) {
        events.push(`input-delta:${toolCallId}:${argsTextDelta}`)
      },
      handleToolInputEnd(toolCallId: string): TestToolCall {
        events.push(`input-end:${toolCallId}`)
        const call = { id: toolCallId, toolId: 'read', toolName: 'read', arguments: { path: 'a.txt' } }
        toolCalls.push(call)
        return call
      },
      handleToolCallChunk(chunk: { toolCallId: string; toolName: string; args: { path?: string } }): TestToolCall {
        events.push(`tool-chunk:${chunk.toolCallId}:${chunk.toolName}`)
        const call = {
          id: chunk.toolCallId,
          toolId: chunk.toolName,
          toolName: chunk.toolName,
          arguments: chunk.args,
        }
        toolCalls.push(call)
        return call
      },
    }
    const store = {
      updateMessageToolCalls: (_sessionId: string, _messageId: string, calls: TestToolCall[]) => {
        events.push(`store:${calls.map(call => `${call.id}:${call.status}`).join(',')}`)
      },
    }
    const emitter = {
      sendContentPart: (part: { type: string; content?: string; turnIndex?: number }) => {
        events.push(`part:${part.type}:${part.content ?? part.turnIndex}`)
      },
      sendToolCall: (call: TestToolCall) => events.push(`tool-call:${call.id}:${call.status}`),
      sendToolResult: (call: TestToolCall) => events.push(`tool-result:${call.id}:${call.status}`),
      sendToolExecutionStart: (toolCallId: string, stepId: string, toolName: string) => {
        events.push(`exec-start:${toolCallId}:${stepId}:${toolName}`)
      },
      sendToolExecutionUpdate: () => {},
      sendToolExecutionEnd: (toolCallId: string, stepId: string, result?: unknown, isError?: boolean) => {
        events.push(`exec-end:${toolCallId}:${stepId}:${isError}:${JSON.stringify(result)}`)
      },
      sendStepUpdated: (stepId: string, update: { status?: string }) => {
        events.push(`step:${stepId}:${update.status}`)
      },
      sendSkillActivated: (skillName: string) => {
        events.push(`skill:${skillName}`)
      },
    }
    const stepIdsByToolCallId = new Map<string, string>()
    const turn = createAgentLoopExecutorTurnState<TestToolCall, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push({ type: 'text', content: 'before tool', turnIndex: 1 })

    expect(applyAgentLoopToolInputStartWithAdapters({
      turn,
      turnIndex: 1,
      toolCallId: 'call_1',
      toolName: 'read',
      processor,
      stepIdsByToolCallId,
      emitter,
    })).toBe('step_call_1')
    expect(stepIdsByToolCallId.get('call_1')).toBe('step_call_1')
    expect(turn.hasSentToolParts).toBe(true)

    applyAgentLoopToolInputDeltaWithAdapters(processor, 'call_1', '{"path"')

    expect(applyAgentLoopToolInputEndWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      turn,
      processor,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 100,
    })).toMatchObject({ found: true, toolCall: { id: 'call_1', status: 'executing' } })

    const fallbackTurn = createAgentLoopExecutorTurnState<TestToolCall, { type: string; content?: string; turnIndex?: number }>()
    applyAgentLoopToolCallFallbackWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      turn: fallbackTurn,
      turnIndex: 2,
      toolCall: {
        toolCallId: 'call_2',
        toolName: 'write',
        args: { path: 'b.txt' },
      },
      processor,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 200,
    })

    const state = { toolIterations: 0, skillManageCalled: false }
    expect(applyAgentLoopToolResultWithAdapters({
      state,
      sessionId: 's1',
      assistantMessageId: 'm1',
      toolCallId: 'call_1',
      result: { content: 'done', data: { output: 'done' } },
      toolCalls,
      stepIdsByToolCallId,
      store,
      emitter,
      now: () => 300,
    })).toMatchObject({
      found: true,
      toolIterationsDelta: 1,
      awaitingConfirmation: false,
    })
    expect(state).toEqual({ toolIterations: 1, skillManageCalled: false })
    expect(events).toEqual(expect.arrayContaining([
      'part:text:before tool',
      'part:data-steps:1',
      'input-start:call_1:read:1',
      'input-delta:call_1:{"path"',
      'input-end:call_1',
      'tool-call:call_1:executing',
      'exec-start:call_1:step_call_1:read',
      'tool-chunk:call_2:write',
      'tool-result:call_1:completed',
      'exec-end:call_1:step_call_1:false:{"content":[{"type":"text","text":"done"}],"details":{"output":"done"}}',
    ]))
  })
})
