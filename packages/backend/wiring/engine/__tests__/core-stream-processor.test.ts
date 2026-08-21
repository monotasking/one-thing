import { describe, expect, it } from 'vitest'
import {
  applyCoreToolCallChunk,
  createCoreStreamProcessor,
  createCoreToolInputStartArtifacts,
  CoreStreamingToolInputBuffer,
  resolveToolIdentity,
  type CoreStreamStepLike,
  type CoreStreamToolCallLike,
} from '@onething/core/engine'

describe('core stream processor helpers', () => {
  it('resolves regular, MCP router, and short MCP tool identities through host adapters', () => {
    expect(resolveToolIdentity('read_file', {}, {
      normalizeToolName: name => name === 'read_file' ? 'read' : name,
    })).toEqual({
      toolId: 'read',
      displayName: 'read',
      isMcp: false,
    })

    expect(resolveToolIdentity('tool_function', {}, {
      isMCPTool: id => id === 'tool_function',
    })).toEqual({
      toolId: 'tool_function',
      displayName: 'tool_function',
      isMcp: true,
    })

    expect(resolveToolIdentity('search-docs', { query: 'vue' }, {
      findMCPToolIdByShortName: (shortName, args) => (
        shortName === 'search-docs' && args?.query === 'vue' ? 'mcp_context7_search-docs' : null
      ),
      parseMCPToolId: id => id === 'mcp_context7_search-docs'
        ? { serverId: 'context7', toolName: 'search-docs' }
        : null,
      getMCPServerName: serverId => serverId === 'context7' ? 'Context7' : undefined,
    })).toEqual({
      toolId: 'mcp_context7_search-docs',
      displayName: 'Context7',
      isMcp: true,
    })
  })

  it('accumulates streaming tool input JSON without host state', () => {
    const buffer = new CoreStreamingToolInputBuffer()
    buffer.start('call-1', 'write', { stepId: 'step-1', visible: true })

    expect(buffer.getStepId('call-1')).toBe('step-1')
    expect(buffer.append('call-1', '{"path":')).toMatchObject({ argsText: '{"path":' })
    expect(buffer.append('call-1', '"/tmp/a.txt"}')).toMatchObject({ argsText: '{"path":"/tmp/a.txt"}' })

    expect(buffer.finish('call-1')).toEqual({
      ok: true,
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: '/tmp/a.txt' },
      visible: true,
    })
    expect(buffer.getStepId('call-1')).toBeUndefined()
  })

  it('returns parse failures and clears malformed tool input buffers', () => {
    const buffer = new CoreStreamingToolInputBuffer()
    buffer.start('call-1', 'write')
    buffer.append('call-1', '{"path":')

    const result = buffer.finish('call-1')
    expect(result).toMatchObject({
      ok: false,
      toolCallId: 'call-1',
      rawArgsText: '{"path":',
    })
    expect(buffer.finish('call-1')).toBeNull()
  })

  it('creates streaming tool placeholders and completes them in core', () => {
    const toolCalls: CoreStreamToolCallLike[] = []

    const placeholder = createCoreToolInputStartArtifacts({
      toolCallId: 'call-1',
      resolved: { toolId: 'bash', displayName: 'bash' },
      stepId: 'step-1',
      rawToolName: 'bash',
      turnIndex: 2,
      timestamp: 100,
    })

    expect(placeholder.stepType).toBe('command')
    expect(placeholder.placeholderToolCall).toMatchObject({
      id: 'call-1',
      toolId: 'bash',
      toolName: 'bash',
      arguments: {},
      status: 'input-streaming',
      streamingArgs: '',
      timestamp: 100,
    })
    expect(placeholder.placeholderStep).toMatchObject({
      id: 'step-1',
      type: 'command',
      title: '调用工具: bash',
      status: 'running',
      toolCallId: 'call-1',
      turnIndex: 2,
    })

    toolCalls.push(placeholder.placeholderToolCall)
    const completed = applyCoreToolCallChunk(toolCalls, {
      toolCallId: 'call-1',
      resolved: { toolId: 'bash', displayName: 'bash' },
      args: { command: 'pwd' },
    })

    expect(completed).toEqual({
      id: 'call-1',
      toolId: 'bash',
      toolName: 'bash',
      arguments: { command: 'pwd' },
      status: 'pending',
      timestamp: 100,
    })
    expect(toolCalls).toHaveLength(1)

    const hidden = applyCoreToolCallChunk(toolCalls, {
      toolCallId: 'call-hidden',
      resolved: { toolId: 'read', displayName: 'read' },
      args: { path: '/tmp/a.txt' },
      publish: false,
      timestamp: 200,
    })
    expect(hidden).toMatchObject({
      id: 'call-hidden',
      status: 'pending',
      timestamp: 200,
    })
    expect(toolCalls).toHaveLength(1)
  })

  it('runs the headless stream processor through store and emitter adapters', async () => {
    const storeWrites: string[] = []
    const events: string[] = []
    const emitter = {
      sendTextChunk(text: string, turnIndex?: number) {
        events.push(`text:${turnIndex}:${text}`)
      },
      sendReasoningChunk(reasoning: string, turnIndex?: number, placement?: string) {
        events.push(`reasoning:${turnIndex}:${placement}:${reasoning}`)
      },
      sendToolCall(toolCall: CoreStreamToolCallLike) {
        events.push(`tool:${toolCall.id}:${toolCall.toolName}:${JSON.stringify(toolCall.arguments)}`)
      },
      sendStepAdded(step: CoreStreamStepLike) {
        events.push(`step:${step.id}:${step.type}:${step.toolCallId}`)
      },
      sendToolInputStart(toolCallId: string, displayName: string, toolCall: CoreStreamToolCallLike) {
        events.push(`tool-start:${toolCallId}:${displayName}:${toolCall.status}`)
      },
      sendToolInputDelta(toolCallId: string, argsTextDelta: string) {
        events.push(`tool-delta:${toolCallId}:${argsTextDelta}`)
      },
    }
    const processor = createCoreStreamProcessor({
      ctx: {
        sessionId: 's1',
        assistantMessageId: 'a1',
      },
      createStepId: () => 'step-1',
      resolveToolIdentity: (toolName) => ({
        toolId: toolName === 'read_file' ? 'read' : toolName,
        displayName: toolName === 'read_file' ? 'read' : toolName,
        isMcp: false,
      }),
      store: {
        updateMessageContent(sessionId, messageId, content) {
          storeWrites.push(`content:${sessionId}:${messageId}:${content}`)
        },
        updateMessageReasoning(sessionId, messageId, reasoning) {
          storeWrites.push(`reasoning:${sessionId}:${messageId}:${reasoning}`)
        },
        updateMessageToolCalls(sessionId, messageId, toolCalls) {
          storeWrites.push(`tools:${sessionId}:${messageId}:${toolCalls.length}:${toolCalls.at(-1)?.status}`)
        },
        updateMessageStreaming(sessionId, messageId, streaming) {
          storeWrites.push(`streaming:${sessionId}:${messageId}:${streaming}`)
        },
        flushSessionSave(sessionId) {
          storeWrites.push(`flush:${sessionId}`)
        },
      },
      emitter,
    })

    const turnContent = { value: '' }
    const turnReasoning = { value: '' }
    expect(processor.handleTextChunk('hello', turnContent, 0)).toBe('hello')
    processor.handleReasoningChunk('thinking', turnReasoning, 0)
    processor.handleToolInputStart('call-1', 'read_file', 0)
    processor.handleToolInputDelta('call-1', '{"path":')
    processor.handleToolInputDelta('call-1', '"/tmp/a.txt"}')
    const toolCall = processor.handleToolInputEnd('call-1')
    await processor.finalize()

    expect(processor.accumulatedContent).toBe('hello')
    expect(processor.accumulatedReasoning).toBe('thinking')
    expect(turnContent.value).toBe('hello')
    expect(turnReasoning.value).toBe('thinking')
    expect(toolCall).toMatchObject({
      id: 'call-1',
      toolId: 'read',
      toolName: 'read',
      arguments: { path: '/tmp/a.txt' },
      status: 'received',
      argsFinalizedBy: 'parse',
    })
    expect(toolCall?.receivedAt).toBeTypeOf('number')
    expect(processor.toolCalls).toHaveLength(1)
    expect(storeWrites).toEqual([
      'content:s1:a1:hello',
      'reasoning:s1:a1:thinking',
      'tools:s1:a1:1:input-streaming',
      'tools:s1:a1:1:received',
      'tools:s1:a1:1:received',
      'streaming:s1:a1:false',
      'flush:s1',
    ])
    expect(events).toEqual([
      'text:0:hello',
      'reasoning:0:top:thinking',
      'step:step-1:tool-call:call-1',
      'tool-start:call-1:read:input-streaming',
      'tool-delta:call-1:{"path":',
      'tool-delta:call-1:"/tmp/a.txt"}',
      'tool:call-1:read:{"path":"/tmp/a.txt"}',
    ])
  })
})
