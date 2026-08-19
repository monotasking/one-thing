import { describe, expect, it, vi } from 'vitest'
import {
  buildMCPPartialResultUpdate,
  buildMCPPermissionPlan,
  buildToolExecutionFinalPresentation,
  buildToolExecutionPartialStepUpdate,
  buildToolMetadataStepUpdate,
  changesFromToolMetadata,
  CoreToolOrchestrator,
  executeCoreToolAndUpdate,
  executeCoreDirectTool,
  filterContentParts,
  filterSteps,
  isReadOnlyMCPRouterCall,
  markToolCallAbortedBeforeExecution,
  planToolCallArtifactRemoval,
  queuedTailToolCallIdsAfter,
  recordToolCallSignature,
  removeToolCallsById,
  resolveMCPPermissionResourceName,
  shouldStopAfterTool,
  stableStringify,
  streamableToolResult,
  textFromStructuredToolResult,
  toolResultObject,
  type CoreToolResultLike,
} from '@onething/core/engine'
import type { JsonValue } from '@onething/core'

describe('core tool orchestration helpers', () => {
  function coreToolCall(id: string): {
    id: string
    status?: string
    rejected?: boolean
    error?: string
    endTime?: number
  } {
    return { id, status: 'pending' }
  }

  it('marks a tool call aborted before execution without store or emitter access', () => {
    const toolCall = {
      id: 'call-1',
      status: 'pending',
    }

    // COW(P0.2 area ①,F3):返回新对象,入参不动。
    const aborted = markToolCallAbortedBeforeExecution(toolCall, {
      now: () => 1234,
    })
    expect(aborted).not.toBe(toolCall)
    expect(aborted).toEqual({
      id: 'call-1',
      status: 'failed',
      error: 'Execution cancelled by user',
      endTime: 1234,
    })
    expect(toolCall.status).toBe('pending')

    expect(markToolCallAbortedBeforeExecution(toolCall, {
      error: 'Stopped',
      now: () => 2345,
    })).toMatchObject({
      status: 'failed',
      error: 'Stopped',
      endTime: 2345,
    })
  })

  it('keeps never-published hidden calls from emitting stale removal updates', async () => {
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const visible = coreToolCall('visible')
    const hidden = coreToolCall('hidden')
    const toolCalls = [visible]
    const turnToolCalls: typeof toolCalls = []
    const emitToolCallRemovalUpdate = vi.fn()
    const executeTool = vi.fn(async (toolCall: typeof visible) => {
      if (toolCall.id === 'visible') {
        markFirstStarted()
        await new Promise<void>(resolve => {
          releaseFirst = resolve
        })
      }
      toolCall.status = 'completed'
    })

    const orchestrator = new CoreToolOrchestrator({
      toolCalls,
      turnToolCalls,
      beforeFirstTool: vi.fn(),
      executeTool,
      updateToolCalls: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      removeToolCallArtifacts: vi.fn(() => false),
      emitToolCallRemovalUpdate,
      logger: { error: vi.fn() },
    })

    orchestrator.start(visible, { toolName: 'bash', args: { command: 'npm run build' } })
    await firstStarted
    orchestrator.start(hidden, { toolName: 'read', args: { path: 'README.md' } })

    expect(emitToolCallRemovalUpdate).not.toHaveBeenCalled()

    releaseFirst()
    await orchestrator.waitForAll()

    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(toolCalls.map(toolCall => toolCall.id)).toEqual(['visible', 'hidden'])
    expect(turnToolCalls.map(toolCall => toolCall.id)).toEqual(['visible', 'hidden'])
  })

  it('discards queued tail calls after a rejected barrier tool', async () => {
    const edit = coreToolCall('edit')
    const read = coreToolCall('read')
    const toolCalls = [edit, read]
    const turnToolCalls: typeof toolCalls = []
    const removedArtifacts: string[][] = []
    const executeTool = vi.fn(async (toolCall: typeof edit) => {
      if (toolCall.id === 'edit') {
        toolCall.status = 'failed'
        toolCall.rejected = true
        return
      }
      throw new Error('tail tool should have been discarded')
    })

    const orchestrator = new CoreToolOrchestrator({
      toolCalls,
      turnToolCalls,
      beforeFirstTool: vi.fn(),
      executeTool,
      updateToolCalls: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      removeToolCallArtifacts: vi.fn((ids) => {
        removedArtifacts.push([...ids])
        return true
      }),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    orchestrator.start(edit, { toolName: 'edit', args: {} })
    orchestrator.start(read, { toolName: 'read', args: {} })

    await orchestrator.waitForAll()

    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(toolCalls.map(toolCall => toolCall.id)).toEqual(['edit'])
    expect(turnToolCalls.map(toolCall => toolCall.id)).toEqual(['edit'])
    expect(removedArtifacts.some(ids => ids.includes('read'))).toBe(true)
  })

  it('executes builtin direct tools through a core workflow with preview permission state', async () => {
    const metadataUpdates: unknown[] = []
    const permissionInputs: unknown[] = []
    let approvedEffects = 0

    const result = await executeCoreDirectTool({
      toolName: 'edit',
      args: { path: 'a.txt' },
      context: {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call-1',
        workingDirectory: '/tmp/project',
        onMetadata: update => metadataUpdates.push(update),
      },
      isMCPTool: () => false,
      executeMCPTool: vi.fn(),
      analyzeTool: vi.fn(async () => ({
        success: true,
        effects: [{ kind: 'file_edit', resources: ['a.txt'], barrier: true }],
        preview: {
          title: 'Edit file',
          path: 'a.txt',
          diff: '+hello',
          additions: 1,
          metadata: { output: 'preview' },
        },
      })),
      executeTool: vi.fn(async (_toolName, _args, execContext) => {
        approvedEffects = execContext.approvedAnalysis?.effects.length ?? 0
        return { success: true, data: { ok: true } }
      }),
      enforcePermission: vi.fn(async input => {
        permissionInputs.push(input)
      }),
      createExecutionContext: source => ({ ...source }),
      formatFailure: failure => failure.error || 'failed',
    })

    expect(result).toEqual({ success: true, data: { ok: true } })
    expect(metadataUpdates).toEqual([{
      title: 'Edit file',
      metadata: {
        output: 'preview',
        path: 'a.txt',
        diff: '+hello',
        additions: 1,
      },
    }])
    expect(permissionInputs).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        messageId: 'm1',
        toolName: 'edit',
        workspaceRoot: '/tmp/project',
      }),
    ])
    expect(approvedEffects).toBe(1)
  })

  it('executes MCP direct tools with core permission and partial-result plumbing', async () => {
    const partials: unknown[] = []
    const beforeSideEffect = vi.fn(async () => undefined)
    const enforcePermission = vi.fn(async () => undefined)

    const result = await executeCoreDirectTool({
      toolName: 'mcp_search',
      args: { action: 'call', function: 'fetch' },
      context: {
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call-1',
        onPartialResult: update => partials.push(update),
        beforeSideEffect,
      },
      isMCPTool: () => true,
      executeMCPTool: vi.fn(async (_toolName, _args, options) => {
        options.onPartialResult?.('ready', 'started')
        return { content: 'done' }
      }),
      analyzeTool: vi.fn(),
      executeTool: vi.fn(),
      enforcePermission,
      createExecutionContext: source => ({ ...source }),
      formatFailure: failure => failure.error || 'failed',
    })

    expect(result).toEqual({ success: true, data: { content: 'done' } })
    expect(enforcePermission).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'mcp_search',
      effects: [expect.objectContaining({ kind: 'mcp', resources: ['fetch'] })],
    }))
    expect(beforeSideEffect).toHaveBeenCalledTimes(1)
    expect(partials).toEqual([{
      content: [{ type: 'text', text: 'ready' }],
      details: { phase: 'started', toolName: 'mcp_search', functionName: 'fetch' },
    }])
  })

  it('updates tool execution lifecycle through headless store and emitter adapters', async () => {
    interface TestToolCall {
      id: string
      toolName: string
      status?: string
      result?: JsonValue
      error?: string
      rejected?: boolean
      rejectionReason?: string
      requiresConfirmation?: boolean
      commandType?: string
      endTime?: number
      startTime?: number
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    }

    interface TestStep {
      id: string
      title: string
      status?: string
      toolCallId?: string
      toolCall?: TestToolCall
      turnIndex?: number
      result?: unknown
      error?: string
    }

    const toolCall: TestToolCall = {
      id: 'call-1',
      toolName: 'edit',
      status: 'pending',
    }
    const allToolCalls = [toolCall]
    const existingStep: TestStep = {
      id: 'step-1',
      title: 'old',
      status: 'running',
      toolCallId: 'call-1',
      toolCall: { ...toolCall },
    }
    const events: string[] = []
    let now = 100

    await executeCoreToolAndUpdate({
      ctx: {
        sessionId: 's1',
        assistantMessageId: 'm1',
      },
      toolCall,
      toolCallData: {
        toolName: 'edit',
        args: { path: 'a.txt' },
      },
      allToolCalls,
      existingStepId: 'step-1',
      turnIndex: 3,
      store: {
        getSession: () => ({
          workingDirectory: '/tmp/project',
          workingDirectoryRoots: ['/tmp/project'],
          messages: [{ id: 'm1', steps: [existingStep] }],
        }),
        updateMessageToolCalls: (_sessionId, _messageId, toolCalls) => {
          events.push(`store:${toolCalls[0].status}`)
        },
      },
      emitter: {
        sendToolResult: updated => events.push(`tool-result:${updated.status}`),
        sendSkillActivated: skillName => events.push(`skill:${skillName}`),
        sendStepUpdated: (stepId, updates) => events.push(`step-update:${stepId}:${updates.status ?? updates.title ?? 'patch'}`),
        sendStepAdded: step => events.push(`step-add:${step.id}`),
        sendToolExecutionStart: (toolCallId, stepId, toolName) => events.push(`exec-start:${toolCallId}:${stepId}:${toolName}`),
        sendToolCall: updated => events.push(`tool-call:${updated.status}`),
        sendToolExecutionUpdate: (_toolCallId, _stepId, partial) => events.push(`partial:${partial.content[0]?.text}`),
        sendToolExecutionEnd: (_toolCallId, _stepId, result, isError) => {
          events.push(`exec-end:${isError}:${result?.content[0]?.text}`)
        },
      },
      executeToolDirectly: async (_toolName, _args, context) => {
        expect(context.workingDirectory).toBe('/tmp/project')
        context.onMetadata?.({
          title: 'Preview edit',
          metadata: {
            output: 'preview',
            path: 'a.txt',
            diff: '+hello',
            additions: 1,
            deletions: 0,
          },
        })
        context.onPartialResult?.({ content: [{ type: 'text', text: 'partial' }] })
        await context.beforeSideEffect?.()
        return { success: true, data: 'done' }
      },
      createStep: (): TestStep => {
        throw new Error('existing step should be reused')
      },
      toJsonValue: value => value as JsonValue,
      toStructured: value => typeof value === 'string'
        ? { content: [{ type: 'text', text: value }] }
        : value as CoreToolResultLike,
      formatFailure: failure => failure.error || 'failed',
      now: () => ++now,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // COW(P0.2 area ①,F3):结算态落在工作表的那一格上,手里的 `toolCall` 是旧引用;
    // 复用的 step 也不再被就地改(标题/changes 只随 step:updated 事件发出去)。
    expect(allToolCalls[0]).not.toBe(toolCall)
    expect(allToolCalls[0]).toMatchObject({
      status: 'completed',
      result: 'done',
      requiresConfirmation: false,
      startTime: 102,
      endTime: 103,
    })
    expect(toolCall.status).toBe('pending')
    expect(existingStep.title).toBe('old')
    expect(events).toEqual([
      'step-update:step-1:Tool: edit: a.txt',
      'exec-start:call-1:step-1:edit',
      'store:executing',
      'tool-call:executing',
      'step-update:step-1:Preview edit',
      'partial:partial',
      'step-update:step-1:running',
      'store:executing',
      'tool-call:executing',
      'step-update:step-1:running',
      'exec-end:false:done',
      'step-update:step-1:completed',
      'store:completed',
      'tool-result:completed',
    ])
  })

  it('normalizes permission rejection errors in the core direct tool workflow', async () => {
    const error = new Error('Denied')
    error.name = 'PermissionRejectedError'
    ;(error as { reason?: string }).reason = 'No edits'

    await expect(executeCoreDirectTool({
      toolName: 'write',
      args: { path: 'a.txt' },
      context: { sessionId: 's1', messageId: 'm1' },
      isMCPTool: () => false,
      executeMCPTool: vi.fn(),
      analyzeTool: vi.fn(async () => ({
        success: true,
        effects: [{ kind: 'file_write', resources: ['a.txt'], barrier: true }],
      })),
      executeTool: vi.fn(),
      enforcePermission: vi.fn(async () => {
        throw error
      }),
      createExecutionContext: source => ({ ...source }),
      formatFailure: failure => `rejected:${failure.rejectionReason}`,
    })).resolves.toEqual({
      success: false,
      error: 'rejected:No edits',
      rejected: true,
      rejectionReason: 'No edits',
    })
  })

  it('detects tool results that should stop queued tail execution', () => {
    expect(shouldStopAfterTool({ rejected: true, status: 'failed' })).toBe(true)
    expect(shouldStopAfterTool({ status: 'cancelled' })).toBe(true)
    expect(shouldStopAfterTool({ status: 'failed' })).toBe(false)
  })

  it('creates stable signatures independent of object key order', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(stableStringify({
      a: { c: 3, d: 4 },
      b: 2,
    }))

    const counts = new Map<string, number>()
    expect(recordToolCallSignature(counts, 'Read', { path: 'a', limit: 10 }, 3)).toMatchObject({
      count: 1,
      detected: false,
    })
    expect(recordToolCallSignature(counts, 'read', { limit: 10, path: 'a' }, 3)).toMatchObject({
      count: 2,
      detected: false,
    })
    expect(recordToolCallSignature(counts, 'read', { path: 'a', limit: 10 }, 3)).toMatchObject({
      count: 3,
      detected: true,
      message: 'Repeated identical tool call detected (read, 3 times). Stop and reassess instead of retrying the same arguments.',
    })
  })

  it('removes tool calls by id in place', () => {
    const calls = [
      { id: 'keep' },
      { id: 'drop-1' },
      { id: 'drop-2' },
    ]

    expect(removeToolCallsById(calls, new Set(['drop-1', 'drop-2']))).toBe(2)
    expect(calls).toEqual([{ id: 'keep' }])

    expect(queuedTailToolCallIdsAfter([
      { toolCall: { id: 'done' }, settled: true, published: true },
      { toolCall: { id: 'failed' }, settled: true, published: true },
      { toolCall: { id: 'queued-visible', status: 'queued' }, settled: false, published: true },
      { toolCall: { id: 'hidden' }, settled: false, published: false },
      { toolCall: { id: 'running', status: 'executing' }, settled: false, published: true },
      { toolCall: { id: 'settled-queued', status: 'queued' }, settled: true, published: true },
    ], 'failed')).toEqual(['queued-visible', 'hidden'])
  })

  it('filters steps and empty tool-call content parts', () => {
    expect(filterSteps([
      { id: 'step-1', toolCallId: 'keep' },
      { id: 'step-2', toolCallId: 'drop' },
      { id: 'step-3' },
    ], new Set(['drop']))).toEqual([
      { id: 'step-1', toolCallId: 'keep' },
      { id: 'step-3' },
    ])

    expect(filterContentParts([
      { type: 'text', content: 'hello' },
      {
        type: 'tool-call',
        toolCalls: [{ id: 'drop' }],
      },
      {
        type: 'tool-call',
        toolCalls: [{ id: 'keep' }, { id: 'drop' }],
      },
    ], new Set(['drop']))).toEqual([
      { type: 'text', content: 'hello' },
      {
        type: 'tool-call',
        toolCalls: [{ id: 'keep' }],
      },
    ])
  })

  it('plans tool-call artifact removal updates without store or EventBus access', () => {
    const toolCalls: Array<{ id: string; status?: string }> = [{ id: 'keep', status: 'pending' }]
    const message = {
      steps: [
        { id: 'step-1', toolCallId: 'keep' },
        { id: 'step-2', toolCallId: 'drop' },
      ],
      contentParts: [
        { type: 'text', content: 'hello' },
        { type: 'tool-call', toolCalls: [{ id: 'drop' }] },
        { type: 'tool-call', toolCalls: [{ id: 'keep' }, { id: 'drop' }] },
      ],
    }
    const plan = planToolCallArtifactRemoval({
      ids: new Set(['drop']),
      toolCalls,
      message,
    })

    expect(plan).toEqual({
      removed: true,
      hadSteps: true,
      hadContentParts: true,
      nextSteps: [{ id: 'step-1', toolCallId: 'keep' }],
      nextContentParts: [
        { type: 'text', content: 'hello' },
        { type: 'tool-call', toolCalls: [{ id: 'keep' }] },
      ],
      updates: {
        toolCalls: [{ id: 'keep', status: 'pending' }],
        steps: [{ id: 'step-1', toolCallId: 'keep' }],
        contentParts: [
          { type: 'text', content: 'hello' },
          { type: 'tool-call', toolCalls: [{ id: 'keep' }] },
        ],
      },
    })

    expect(planToolCallArtifactRemoval({
      ids: new Set(['missing']),
      toolCalls,
      message: { steps: [{ id: 'step-1', toolCallId: 'keep' }] },
    })).toEqual({
      removed: false,
      hadSteps: false,
      hadContentParts: false,
    })
  })

  it('plans MCP permission checks and partial result updates in core', () => {
    expect(isReadOnlyMCPRouterCall('mcp_search', { action: 'search' })).toBe(true)
    expect(buildMCPPermissionPlan('mcp_search', { action: 'search' })).toBeNull()
    expect(resolveMCPPermissionResourceName('mcp_search', {
      action: 'call',
      tool: 'fetch',
    })).toBe('fetch')

    const plan = buildMCPPermissionPlan('mcp_search', {
      action: 'call',
      function: 'fetch',
      arguments: { url: 'https://example.com' },
    })

    expect(plan).toMatchObject({
      resourceName: 'fetch',
      preview: { title: 'Call MCP tool: fetch' },
      effects: [{
        kind: 'mcp',
        resources: ['fetch'],
        barrier: true,
      }],
    })
    expect(buildMCPPartialResultUpdate('ok', 'ready', 'mcp_search', { function: 'fetch' })).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      details: { phase: 'ready', toolName: 'mcp_search', functionName: 'fetch' },
    })
  })

  it('formats generic tool result partial updates in core', () => {
    const objectResult = { title: 'Done', output: 'ok' }

    expect(toolResultObject(objectResult)).toBe(objectResult)
    expect(toolResultObject('plain')).toBeUndefined()
    expect(streamableToolResult('plain')).toBe('plain')
    expect(streamableToolResult(objectResult)).toBe(objectResult)
    expect(textFromStructuredToolResult({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'file', path: '/tmp/file.txt' },
        { type: 'image' },
      ],
    })).toBe('line 1\n[File: /tmp/file.txt]\n[Image]')
    expect(buildToolExecutionPartialStepUpdate({
      content: [{ type: 'text', text: 'halfway' }],
    })).toEqual({
      status: 'running',
      partialResult: { content: [{ type: 'text', text: 'halfway' }] },
      partialResultIsPartial: true,
      result: 'halfway',
    })
  })

  it('builds generic tool metadata step updates in core', () => {
    const toolCall: {
      id: string
      changes?: {
        diff: string
        filePath: string
        additions: number
        deletions: number
      }
    } = { id: 'call-1' }

    expect(changesFromToolMetadata({
      path: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
    })).toEqual({
      filePath: '/tmp/a.txt',
      diff: '-old\n+new',
      additions: 1,
      deletions: 2,
      originalContent: undefined,
      originalContentHash: undefined,
      afterContentHash: undefined,
      auditId: undefined,
      auditPath: undefined,
    })

    expect(buildToolMetadataStepUpdate(toolCall, {
      title: 'Edited file',
      metadata: {
        output: 'done',
        path: '/tmp/a.txt',
        diff: '-old\n+new',
      },
    })).toEqual({
      title: 'Edited file',
      result: 'done',
      toolCall: {
        id: 'call-1',
        changes: {
          filePath: '/tmp/a.txt',
          diff: '-old\n+new',
          additions: 0,
          deletions: 0,
          originalContent: undefined,
          originalContentHash: undefined,
          afterContentHash: undefined,
          auditId: undefined,
          auditPath: undefined,
        },
      },
    })
    // COW(F3):`changes` 只落在返回的新对象上。
    expect(toolCall.changes).toBeUndefined()
  })

  it('builds final tool execution presentation as a new tool call (COW)', () => {
    const toJsonValue = (value: unknown) => value
    const toStructured = (value: unknown) => ({ structured: value })
    const formatFailure = (failure: { error?: string; status?: string }) => failure.error || failure.status || 'failed'
    const changes = { diff: '+x', filePath: '/tmp/a.txt', additions: 1, deletions: 0 }

    const completed = { id: 'call-1', status: 'executing' }
    expect(buildToolExecutionFinalPresentation({
      toolCall: completed,
      result: { success: true, data: { title: 'Listed files', output: 'ok' } },
      currentTitle: 'Old title',
      changes,
      toJsonValue,
      toStructured,
      formatFailure,
    })).toEqual({
      executionEnd: {
        result: { structured: { title: 'Listed files', output: 'ok' } },
        isError: false,
        error: undefined,
      },
      stepUpdate: {
        status: 'completed',
        title: 'Listed files',
        toolCall: {
          id: 'call-1',
          status: 'completed',
          result: { title: 'Listed files', output: 'ok' },
          error: undefined,
          rejected: undefined,
          rejectionReason: undefined,
          requiresConfirmation: false,
          changes,
        },
        partialResult: { structured: { title: 'Listed files', output: 'ok' } },
        partialResultIsPartial: false,
        result: '{"title":"Listed files","output":"ok"}',
        error: undefined,
        rejected: undefined,
        rejectionReason: undefined,
      },
      toolCall: {
        id: 'call-1',
        status: 'completed',
        result: { title: 'Listed files', output: 'ok' },
        error: undefined,
        rejected: undefined,
        rejectionReason: undefined,
        requiresConfirmation: false,
      },
    })
    // COW(F3):入参那条不动。
    expect(completed.status).toBe('executing')

    const pending = { id: 'call-2', status: 'executing' }
    expect(buildToolExecutionFinalPresentation({
      toolCall: pending,
      result: { success: false, requiresConfirmation: true, commandType: 'dangerous', error: 'confirm' },
      changes,
      toJsonValue,
      toStructured,
      formatFailure,
    })).toEqual({
      stepUpdate: {
        status: 'awaiting-confirmation',
        toolCall: {
          id: 'call-2',
          status: 'pending',
          requiresConfirmation: true,
          commandType: 'dangerous',
          error: 'confirm',
          changes,
        },
      },
      toolCall: {
        id: 'call-2',
        status: 'pending',
        requiresConfirmation: true,
        commandType: 'dangerous',
        error: 'confirm',
      },
    })
    expect(pending.status).toBe('executing')

    const cancelled = { id: 'call-3', status: 'executing' }
    expect(buildToolExecutionFinalPresentation({
      toolCall: cancelled,
      result: { success: false, aborted: true },
      toJsonValue,
      toStructured,
      formatFailure,
    })).toMatchObject({
      executionEnd: {
        result: undefined,
        isError: true,
        error: 'cancelled',
      },
      stepUpdate: {
        status: 'cancelled',
        error: 'cancelled',
      },
      toolCall: { id: 'call-3', status: 'cancelled' },
    })
    expect(cancelled.status).toBe('executing')
  })
})
