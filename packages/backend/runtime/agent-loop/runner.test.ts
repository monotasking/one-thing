import { describe, expect, it } from 'vitest'
import { AgentLoopPauseForConfirmationError } from './errors.js'
import { runAgentLoop } from './runner.js'
import { clearRetiredAgentToolNames, registerRetiredAgentToolName } from './tool-names.js'
import type {
  AgentLoopOptions,
  AgentProvider,
  AgentStreamEvent,
  AgentTool,
  AgentTurnStreamEvent,
} from './types.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function baseProvider(streamTurn: AgentProvider['streamTurn']): AgentProvider {
  return {
    id: 'test-provider',
    capabilities: {
      capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsStreaming: true,
      supportsTools: true,
    },
    streamTurn,
  }
}

function toolCallEvents(turn: number): AgentTurnStreamEvent[] {
  return [
    { type: 'tool-call-start', turn, toolCallId: 'call_1', toolName: 'read' },
    { type: 'tool-call-delta', turn, toolCallId: 'call_1', toolName: 'read', argumentsDelta: '{"path":"a"}' },
    { type: 'tool-call-done', turn, toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'tool-call-start', turn, toolCallId: 'call_2', toolName: 'read' },
    { type: 'tool-call-delta', turn, toolCallId: 'call_2', toolName: 'read', argumentsDelta: '{"path":"b"}' },
    { type: 'tool-call-done', turn, toolCall: { id: 'call_2', name: 'read', arguments: '{"path":"b"}' } },
    { type: 'finish', turn, finishReason: 'tool_calls' },
  ]
}

function eventLabel(event: AgentStreamEvent): string | null {
  switch (event.type) {
    case 'tool-call-start':
      return `start:${event.toolCallId}`
    case 'tool-call-delta':
      return `delta:${event.toolCallId}`
    case 'tool-call-done':
      return `done:${event.toolCall.id}`
    case 'tool-result':
      return `result:${event.toolCall.id}`
    default:
      return null
  }
}

function baseOptions(provider: AgentProvider, tool: AgentTool, events: string[]): AgentLoopOptions {
  return {
    provider,
    model: 'test-model',
    messages: [{ role: 'user', content: 'read two files' }],
    tools: [tool],
    sessionId: 'session-1',
    messageId: 'message-1',
    maxTurns: 2,
    onEvent(event) {
      const label = eventLabel(event)
      if (label) events.push(label)
    },
  }
}

describe('runAgentLoop concurrent tool execution', () => {
  it('streams later tool calls and executes them while an earlier tool is still running', async () => {
    const events: string[] = []
    const releaseFirst = deferred()
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield* toolCallEvents(request.turn)
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute(args) {
        const path = String(args.path)
        events.push(`execute:${path}:start`)
        if (path === 'a') await releaseFirst.promise
        events.push(`execute:${path}:end`)
        return { content: `read ${path}` }
      },
    }

    const run = runAgentLoop(baseOptions(provider, tool, events))

    // While call_1 is blocked, call_2 must still stream, execute, and settle.
    await waitFor(() => events.includes('result:call_2'))
    expect(events).toContain('start:call_2')
    expect(events).toContain('execute:b:end')
    expect(events).not.toContain('execute:a:end')

    releaseFirst.resolve()
    const result = await run

    expect(events.indexOf('result:call_1')).toBeGreaterThan(events.indexOf('execute:a:end'))
    // Completion order: call_2 settled first…
    expect(events.indexOf('result:call_2')).toBeLessThan(events.indexOf('result:call_1'))
    // …but tool messages follow the assistant's declaration order.
    const toolMessages = result.messages.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => message.toolCallId)).toEqual(['call_1', 'call_2'])
    expect(result.toolResults.map(item => item.toolCall.id)).toEqual(['call_1', 'call_2'])
  })

  it('orders a later read behind an in-flight mutation (barrier semantics)', async () => {
    const events: string[] = []
    const releaseEdit = deferred()
    let fileContent = 'old'
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_edit', name: 'edit', arguments: '{"path":"a"}' } }
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_read', name: 'read', arguments: '{"path":"a"}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    // No executionMode declaration → barrier.
    const editTool: AgentTool = {
      name: 'edit',
      parameters: { type: 'object' },
      async execute() {
        events.push('execute:edit:start')
        await releaseEdit.promise
        fileContent = 'new'
        events.push('execute:edit:end')
        return { content: 'edited' }
      },
    }
    const readTool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute() {
        events.push(`execute:read:${fileContent}`)
        return { content: fileContent }
      },
    }

    const run = runAgentLoop({
      ...baseOptions(provider, editTool, events),
      tools: [editTool, readTool],
    })

    // The read streamed in while the edit is still running; it must stay queued.
    await waitFor(() => events.includes('done:call_read'))
    expect(events).toContain('execute:edit:start')
    expect(events.some(event => event.startsWith('execute:read:'))).toBe(false)

    releaseEdit.resolve()
    const result = await run

    // The read only ran after the edit completed, observing post-edit state.
    expect(events).toContain('execute:read:new')
    expect(events).not.toContain('execute:read:old')
    expect(events.indexOf('execute:read:new')).toBeGreaterThan(events.indexOf('execute:edit:end'))
    const toolMessages = result.messages.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => message.toolCallId)).toEqual(['call_edit', 'call_read'])
  })

  it('serializes a tool declared executionMode "sequential" against parallel siblings (N3)', async () => {
    // pi 的判例:一个抢共享游标的工具,即便夹在两个可并发的只读兄弟中间,
    // 也不能与任何一个重叠。声明 'sequential' 就是在说这句话 —— 语义上
    // 等同于不声明,但写出来表示这是作者的判断而不是遗漏。
    const events: string[] = []
    const releaseFirstRead = deferred()
    let inFlight = 0
    let maxOverlapDuringCursor = 0
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_read_a', name: 'read', arguments: '{"path":"a"}' } }
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_cursor', name: 'cursor', arguments: '{}' } }
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_read_b', name: 'read', arguments: '{"path":"b"}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const readTool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute(args) {
        const path = String(args.path)
        inFlight += 1
        events.push(`execute:read-${path}:start`)
        if (path === 'a') await releaseFirstRead.promise
        events.push(`execute:read-${path}:end`)
        inFlight -= 1
        return { content: `read ${path}` }
      },
    }
    const cursorTool: AgentTool = {
      name: 'cursor',
      parameters: { type: 'object' },
      executionMode: 'sequential',
      async execute() {
        inFlight += 1
        maxOverlapDuringCursor = Math.max(maxOverlapDuringCursor, inFlight)
        events.push('execute:cursor:start')
        await new Promise(resolve => setTimeout(resolve, 5))
        events.push('execute:cursor:end')
        inFlight -= 1
        return { content: 'cursor' }
      },
    }

    const run = runAgentLoop({
      ...baseOptions(provider, readTool, events),
      tools: [readTool, cursorTool],
    })

    // The declared-sequential tool streamed in while read(a) is still running:
    // it must stay queued, and so must the parallel sibling behind it.
    await waitFor(() => events.includes('execute:read-a:start'))
    expect(events).not.toContain('execute:cursor:start')
    expect(events).not.toContain('execute:read-b:start')

    releaseFirstRead.resolve()
    await run

    // Nothing ever overlapped the cursor — in either direction.
    expect(maxOverlapDuringCursor).toBe(1)
    expect(events.indexOf('execute:cursor:start'))
      .toBeGreaterThan(events.indexOf('execute:read-a:end'))
    expect(events.indexOf('execute:read-b:start'))
      .toBeGreaterThan(events.indexOf('execute:cursor:end'))
  })

  it('lets sibling tools settle before pausing for confirmation, and pauses on the first declared', async () => {
    const events: string[] = []
    const provider = baseProvider(async function* (request) {
      yield* toolCallEvents(request.turn)
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute(args) {
        const path = String(args.path)
        // call_1 settles after call_2 so the declaration-order tie-break is exercised.
        if (path === 'a') await new Promise(resolve => setTimeout(resolve, 10))
        events.push(`execute:${path}`)
        return {
          content: '',
          error: 'confirm',
          requiresConfirmation: true,
        }
      },
    }

    const run = runAgentLoop(baseOptions(provider, tool, events))
    const error = await run.then(
      () => {
        throw new Error('Expected the loop to pause for confirmation')
      },
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(AgentLoopPauseForConfirmationError)
    expect((error as AgentLoopPauseForConfirmationError).toolCall.id).toBe('call_1')
    // Siblings are not stranded: both executed and reported before the pause.
    expect(events).toContain('execute:a')
    expect(events).toContain('execute:b')
    expect(events).toContain('result:call_1')
    expect(events).toContain('result:call_2')
  })

  it('caps concurrent executions at maxConcurrentTools', async () => {
    const events: string[] = []
    const releaseFirst = deferred()
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield* toolCallEvents(request.turn)
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute(args) {
        const path = String(args.path)
        events.push(`execute:${path}:start`)
        if (path === 'a') await releaseFirst.promise
        events.push(`execute:${path}:end`)
        return { content: `read ${path}` }
      },
    }

    const run = runAgentLoop({
      ...baseOptions(provider, tool, events),
      maxConcurrentTools: 1,
    })

    // Both tool calls stream in, but with a cap of 1 the second execution
    // must wait for the first slot to free up.
    await waitFor(() => events.includes('done:call_2'))
    expect(events).toContain('execute:a:start')
    expect(events).not.toContain('execute:b:start')

    releaseFirst.resolve()
    await run

    expect(events.indexOf('execute:b:start')).toBeGreaterThan(events.indexOf('execute:a:end'))
  })

  it('blocks the 4th consecutive identical failing call (doom loop guard)', async () => {
    const events: string[] = []
    const repeatedCall = (id: string): AgentTurnStreamEvent[] => [
      { type: 'tool-call-start', turn: 1, toolCallId: id, toolName: 'read' },
      { type: 'tool-call-done', turn: 1, toolCall: { id, name: 'read', arguments: '{"path":"same"}' } },
    ]
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield* ['call_1', 'call_2', 'call_3', 'call_4'].flatMap(repeatedCall)
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    let executions = 0
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute() {
        executions += 1
        return { content: '', error: 'not found' }
      },
    }

    const result = await runAgentLoop(baseOptions(provider, tool, events))

    expect(executions).toBe(3)
    const fourth = result.toolResults.find(item => item.toolCall.id === 'call_4')
    expect(fourth?.result.error).toMatch(/Repeated identical tool call/)
  })

  it('never blocks repeated identical successful calls (legitimate polling)', async () => {
    const events: string[] = []
    const repeatedCall = (id: string): AgentTurnStreamEvent[] => [
      { type: 'tool-call-start', turn: 1, toolCallId: id, toolName: 'read' },
      { type: 'tool-call-done', turn: 1, toolCall: { id, name: 'read', arguments: '{"job_id":"bg-1"}' } },
    ]
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield* ['call_1', 'call_2', 'call_3', 'call_4', 'call_5'].flatMap(repeatedCall)
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    let executions = 0
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute() {
        executions += 1
        return { content: 'still starting' }
      },
    }

    const result = await runAgentLoop(baseOptions(provider, tool, events))

    expect(executions).toBe(5)
    expect(result.toolResults.every(item => !item.result.error)).toBe(true)
  })

  it('prefers abort over pause when converging a turn with mixed failures', async () => {
    const events: string[] = []
    const provider = baseProvider(async function* (request) {
      yield* toolCallEvents(request.turn)
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute(args) {
        const path = String(args.path)
        events.push(`execute:${path}`)
        if (path === 'a') {
          return { content: '', error: 'confirm', requiresConfirmation: true }
        }
        return { content: '', aborted: true }
      },
    }

    await expect(runAgentLoop(baseOptions(provider, tool, events)))
      .rejects.toMatchObject({ name: 'AbortError' })

    expect(events).toContain('execute:a')
    expect(events).toContain('execute:b')
  })
})

describe('runAgentLoop externally-executed tool calls', () => {
  const externalCall = { id: 'ext_1', name: 'bash', arguments: '{"command":"ls"}', externallyExecuted: true as const }

  function externalProvider(): AgentProvider {
    return baseProvider(async function* (request) {
      const turn = request.turn
      yield { type: 'text-delta', turn, delta: 'working…' }
      yield { type: 'tool-call-start', turn, toolCallId: 'ext_1', toolName: 'bash' }
      yield { type: 'tool-call-done', turn, toolCall: externalCall }
      yield {
        type: 'tool-partial-result',
        turn,
        toolCall: externalCall,
        update: { content: [{ type: 'text', text: 'partial output' }] },
      }
      yield {
        type: 'tool-result',
        turn,
        toolCall: externalCall,
        result: { content: 'file-a\nfile-b' },
      }
      yield { type: 'text-delta', turn, delta: ' done' }
      yield { type: 'finish', turn, finishReason: 'stop' }
    })
  }

  it('never executes an externally-executed call locally, even when a same-named tool exists', async () => {
    let executions = 0
    const tool: AgentTool = {
      name: 'bash',
      parameters: { type: 'object' },
      async execute() {
        executions += 1
        return { content: 'LOCAL SIDE EFFECT' }
      },
    }
    const seen: AgentStreamEvent[] = []
    const result = await runAgentLoop({
      provider: externalProvider(),
      model: 'external-agent',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [tool],
      sessionId: 'session-1',
      messageId: 'message-1',
      onEvent(event) {
        seen.push(event)
      },
    })

    expect(executions).toBe(0)
    // Single turn: the external call must not trigger another round.
    expect(result.turns).toBe(1)
    expect(result.finishReason).toBe('stop')
    expect(result.text).toBe('working… done')
    // The provider's own result is recorded for observability…
    expect(result.toolResults).toEqual([
      { toolCall: externalCall, result: { content: 'file-a\nfile-b' } },
    ])
    // …but no tool message is synthesized into the transcript.
    expect(result.messages.filter(message => message.role === 'tool')).toEqual([])
    const assistant = result.messages.at(-1)
    expect(assistant?.toolCalls).toEqual([externalCall])
    // Events pass through to the observer, including the tool result.
    expect(seen.filter(event => event.type === 'tool-partial-result')).toHaveLength(1)
    expect(seen.filter(event => event.type === 'tool-result')).toHaveLength(1)
  })

  it('forwards a mid-stream finish(tool_calls) in place when every call is externally executed', async () => {
    // 外部执行器把多轮会话装进一次 streamTurn,用 finish(tool_calls) 当轮分界。
    // 分界必须当场转发:扣到流末就排到了下一轮正文之后,下游从不换锚点。
    const provider = baseProvider(async function* (request) {
      const turn = request.turn
      yield { type: 'text-delta', turn, delta: 'round one' }
      yield { type: 'tool-call-start', turn, toolCallId: 'ext_1', toolName: 'bash' }
      yield { type: 'tool-call-done', turn, toolCall: externalCall }
      yield {
        type: 'tool-result',
        turn,
        toolCall: externalCall,
        result: { content: 'file-a' },
      }
      yield { type: 'finish', turn, finishReason: 'tool_calls' }
      yield { type: 'text-delta', turn, delta: 'round two' }
      yield { type: 'finish', turn, finishReason: 'stop' }
    })
    const seen: AgentStreamEvent[] = []
    const result = await runAgentLoop({
      provider,
      model: 'external-agent',
      messages: [{ role: 'user', content: 'go' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      onEvent(event) {
        seen.push(event)
      },
    })

    // 分界落在工具结果与下一轮正文之间,而不是流末。
    const kinds = seen.map(event =>
      event.type === 'finish' ? `finish:${event.finishReason}` : event.type,
    )
    const boundaryAt = kinds.indexOf('finish:tool_calls')
    expect(boundaryAt).toBeGreaterThan(kinds.indexOf('tool-result'))
    expect(boundaryAt).toBeLessThan(kinds.lastIndexOf('text-delta'))
    // 终结 finish 仍然只有一条、仍在末轮正文之后(其后只剩 runner 的 turn-end)。
    expect(kinds.indexOf('finish:stop')).toBeGreaterThan(kinds.lastIndexOf('text-delta'))
    expect(kinds.filter(kind => kind === 'finish:stop')).toHaveLength(1)
    // 中途分界不得让 runner 再起一轮(整段会话本来就在一个 streamTurn 里)。
    expect(result.turns).toBe(1)
    expect(result.finishReason).toBe('stop')
    expect(result.text).toBe('round oneround two')
  })

  it('drops provider-emitted tool observation events for calls it did not mark externally executed', async () => {
    const spoofedCall = { id: 'call_local', name: 'read', arguments: '{}' }
    const provider = baseProvider(async function* (request) {
      const turn = request.turn
      yield {
        type: 'tool-result',
        turn,
        toolCall: spoofedCall,
        result: { content: 'spoofed' },
      }
      yield { type: 'text-delta', turn, delta: 'ok' }
      yield { type: 'finish', turn, finishReason: 'stop' }
    })
    const seen: AgentStreamEvent[] = []
    const result = await runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      onEvent(event) {
        seen.push(event)
      },
    })

    expect(result.toolResults).toEqual([])
    expect(seen.filter(event => event.type === 'tool-result')).toEqual([])
    expect(result.text).toBe('ok')
  })
})

describe('runAgentLoop no-valid-tool-call nudge', () => {
  it('nudges the model once when a turn claims tool_calls with zero calls, then continues', async () => {
    const turnsSeen: number[] = []
    const provider = baseProvider(async function* (request) {
      turnsSeen.push(request.turn)
      if (request.turn === 1) {
        // Provider-side loss: finish claims tool_calls but no call was emitted.
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'recovered' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })

    const result = await runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'do the thing' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 5,
    })

    expect(turnsSeen).toEqual([1, 2])
    expect(result.text).toBe('recovered')
    expect(result.finishReason).toBe('stop')
    const nudges = result.messages.filter(
      message => message.role === 'user'
        && typeof message.content === 'string'
        && message.content.includes('no valid tool call was received'),
    )
    expect(nudges).toHaveLength(1)
  })

  it('stops nudging after two attempts and lets the run end', async () => {
    let calls = 0
    const provider = baseProvider(async function* (request) {
      calls++
      yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
    })

    const result = await runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'do the thing' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 10,
    })

    // 1 original turn + 2 nudged retries, then the run ends normally.
    expect(calls).toBe(3)
    expect(result.turns).toBe(3)
  })
})

describe('runAgentLoop turn-level auto-retry', () => {
  it('retries transient provider errors in the same turn and emits auto-retry events', async () => {
    let calls = 0
    const provider = baseProvider(async function* (request) {
      calls++
      if (calls <= 2) {
        throw Object.assign(new Error('fetch failed'), {})
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'recovered' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })

    const seen: AgentStreamEvent[] = []
    const result = await runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      turnRetryDelaysMs: [0, 0, 0],
      onEvent(event) {
        seen.push(event)
      },
    })

    expect(calls).toBe(3)
    expect(result.text).toBe('recovered')
    expect(result.turns).toBe(1)
    const retries = seen.filter(event => event.type === 'auto-retry')
    expect(retries).toHaveLength(2)
    expect(retries.map(event => event.type === 'auto-retry' && event.attempt)).toEqual([1, 2])
  })

  it('gives up after exhausting the backoff schedule', async () => {
    let calls = 0
    const provider = baseProvider(async function* () {
      calls++
      throw Object.assign(new Error('request failed'), { statusCode: 503 })
    })

    await expect(runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      turnRetryDelaysMs: [0, 0, 0],
    })).rejects.toThrow('request failed')
    expect(calls).toBe(4)
  })

  it('does not retry fatal errors (quota/billing)', async () => {
    let calls = 0
    const provider = baseProvider(async function* () {
      calls++
      throw Object.assign(new Error('insufficient_quota: billing hard limit reached'), { statusCode: 429 })
    })

    await expect(runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'session-1',
      messageId: 'message-1',
      turnRetryDelaysMs: [0, 0, 0],
    })).rejects.toThrow('insufficient_quota')
    expect(calls).toBe(1)
  })

  it('does not retry once a tool has executed in the failed attempt', async () => {
    let calls = 0
    const provider = baseProvider(async function* (request) {
      calls++
      yield { type: 'tool-call-start', turn: request.turn, toolCallId: 'call_1', toolName: 'read' }
      yield { type: 'tool-call-delta', turn: request.turn, toolCallId: 'call_1', toolName: 'read', argumentsDelta: '{"path":"a"}' }
      yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"a"}' } }
      throw new Error('socket hang up mid-stream')
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'file contents' }
      },
    }

    await expect(runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      sessionId: 'session-1',
      messageId: 'message-1',
      turnRetryDelaysMs: [0, 0, 0],
    })).rejects.toThrow('socket hang up')
    expect(calls).toBe(1)
  })
})

describe('runAgentLoop final-turn notice', () => {
  it('injects a wrap-up notice before the last turn when the limit will cut the run', async () => {
    const noticesSeenAtTurn: Array<{ turn: number; hasNotice: boolean }> = []
    const provider = baseProvider(async function* (request) {
      noticesSeenAtTurn.push({
        turn: request.turn,
        hasNotice: request.messages.some(
          message => message.role === 'user'
            && typeof message.content === 'string'
            && message.content.includes('final turn of this run'),
        ),
      })
      yield { type: 'tool-call-start', turn: request.turn, toolCallId: `call_${request.turn}`, toolName: 'read' }
      yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: `call_${request.turn}`, name: 'read', arguments: '{}' } }
      yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'ok' }
      },
    }

    const result = await runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 3,
    })

    expect(result.finishReason).toBe('max_turns')
    expect(noticesSeenAtTurn).toEqual([
      { turn: 1, hasNotice: false },
      { turn: 2, hasNotice: false },
      { turn: 3, hasNotice: true },
    ])
  })
})

describe('runAgentLoop steering interrupt (response boundary)', () => {
  function toolCallTurnProvider(requests: { turn: number; messages: unknown[] }[]): AgentProvider {
    return baseProvider(async function* (request) {
      requests.push({ turn: request.turn, messages: request.messages.map(message => ({ ...message })) })
      if (request.turn === 1) {
        yield { type: 'tool-call-start', turn: request.turn, toolCallId: 'call_1', toolName: 'read' }
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_1', name: 'read', arguments: '{}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'answered steer' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
  }

  const readTool: AgentTool = {
    name: 'read',
    parameters: { type: 'object' },
    async execute() {
      return { content: 'ok' }
    },
  }

  it('emits response-boundary before turn-start when beforeTurn injects a steering message', async () => {
    const requests: { turn: number; messages: unknown[] }[] = []
    const orderedEvents: string[] = []

    const result = await runAgentLoop({
      provider: toolCallTurnProvider(requests),
      model: 'test-model',
      messages: [{ role: 'user', content: 'original ask' }],
      tools: [readTool],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 3,
      beforeTurn({ turn, messages }) {
        if (turn !== 2) return undefined
        return {
          messages: [...messages, { role: 'user', content: 'STEER: do this instead' }],
          startNewResponse: true,
        }
      },
      onEvent(event) {
        if (event.type === 'turn-start' || event.type === 'response-boundary') {
          orderedEvents.push(`${event.type}:${event.turn}`)
        }
      },
    })

    expect(result.text).toBe('answered steer')
    // Boundary lands between turn 1 completing and turn 2 starting.
    expect(orderedEvents).toEqual(['turn-start:1', 'response-boundary:2', 'turn-start:2'])
    // The steer message reaches the model as the request tail of turn 2.
    const lastTurnMessages = requests[1].messages as { role: string; content: string }[]
    expect(lastTurnMessages[lastTurnMessages.length - 1]).toEqual({
      role: 'user',
      content: 'STEER: do this instead',
    })
  })

  it('keeps plain-array hook returns silent (no response boundary)', async () => {
    const requests: { turn: number; messages: unknown[] }[] = []
    const boundaryEvents: unknown[] = []

    await runAgentLoop({
      provider: toolCallTurnProvider(requests),
      model: 'test-model',
      messages: [{ role: 'user', content: 'original ask' }],
      tools: [readTool],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 3,
      beforeTurn({ messages }) {
        return [...messages]
      },
      onEvent(event) {
        if (event.type === 'response-boundary') boundaryEvents.push(event)
      },
    })

    expect(boundaryEvents).toEqual([])
  })
})

/**
 * W18b 结构性强制:第一次模型调用可以被要求必须以工具调用收尾。
 *
 * 变异锁的重点是「只作用于第一迭代」。把它挂在每一次调用上,循环就永远拿不到
 * 一个无工具调用的回合来正常收尾——只能被 maxTurns 砍断。所以下面每个用例都
 * 断言第二次请求已经回到 auto。
 */
describe('runAgentLoop initialToolChoice (forced opening call)', () => {
  interface Recorded {
    turn: number
    toolChoice: unknown
    thinking: unknown
    reasoningEffort: unknown
  }

  function recordingProvider(
    recorded: Recorded[],
    capabilities?: AgentProvider['capabilities'],
  ): AgentProvider {
    const provider = baseProvider(async function* (request) {
      recorded.push({
        turn: request.turn,
        toolChoice: request.toolChoice,
        thinking: request.thinking,
        reasoningEffort: request.reasoningEffort,
      })
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_1', name: 'read', arguments: '{}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    return capabilities ? { ...provider, capabilities } : provider
  }

  const forcedCapableProvider = (recorded: Recorded[]): AgentProvider =>
    recordingProvider(recorded, {
      capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsForcedToolUse: true,
    })

  const readTool: AgentTool = {
    name: 'read',
    parameters: { type: 'object' },
    async execute() {
      return { content: 'ok' }
    },
  }

  function options(provider: AgentProvider, extra: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
    return {
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [readTool],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 3,
      ...extra,
    }
  }

  it('forces the first call and only the first call', async () => {
    const recorded: Recorded[] = []
    await runAgentLoop(options(forcedCapableProvider(recorded), { initialToolChoice: 'required' }))

    expect(recorded.map(entry => ({ turn: entry.turn, toolChoice: entry.toolChoice }))).toEqual([
      { turn: 1, toolChoice: 'required' },
      { turn: 2, toolChoice: 'auto' },
    ])
  })

  it('falls back to the ordinary choice on turn 2, not to the forced one', async () => {
    // Mutation lock: an implementation that applied initialToolChoice whenever
    // it is set (rather than on turn 1) would leave turn 2 forced too.
    const recorded: Recorded[] = []
    await runAgentLoop(options(forcedCapableProvider(recorded), {
      initialToolChoice: 'required',
      toolChoice: 'none',
    }))

    expect(recorded.map(entry => entry.toolChoice)).toEqual(['required', 'none'])
  })

  it('silently ignores the forced choice when the model does not advertise it', async () => {
    // baseProvider declares tools but NOT supportsForcedToolUse — an endpoint
    // that never learned the parameter must keep behaving exactly as before
    // instead of collecting a 400.
    const recorded: Recorded[] = []
    await runAgentLoop(options(recordingProvider(recorded), { initialToolChoice: 'required' }))

    expect(recorded.map(entry => entry.toolChoice)).toEqual(['auto', 'auto'])
  })

  it('never sends a forced choice when the run has no tools at all', async () => {
    const recorded: Recorded[] = []
    await runAgentLoop(options(forcedCapableProvider(recorded), {
      initialToolChoice: 'required',
      tools: [],
    }))

    expect(recorded[0]?.toolChoice).toBe('none')
  })

  it('reports the same choice to the turn trace as it sent on the wire', async () => {
    const recorded: Recorded[] = []
    const traced: unknown[] = []
    await runAgentLoop(options(forcedCapableProvider(recorded), {
      initialToolChoice: 'required',
      onTurnTrace(event) {
        traced.push(event.request.toolChoice)
      },
    }))

    expect(traced).toEqual(['required', 'auto'])
  })
})

/**
 * 强制工具调用 ⇄ 思考 的配对规则 (W18b 真机 400 续修).
 *
 * DeepSeek: `Thinking mode does not support this tool_choice` — a hard 400, not
 * a degradation. Anthropic says the same about extended thinking with a forced
 * choice. So the loop never sends the two together: the forced round runs with
 * thinking off (it is a reflex — 说 / 不说), and the rounds that actually
 * compose an answer get the turn's own thinking back, because only iteration 1
 * is ever forced.
 */
describe('runAgentLoop forced tool choice ⇄ thinking pairing', () => {
  interface Sent {
    turn: number
    toolChoice: unknown
    thinking: unknown
    reasoningEffort: unknown
  }

  function sendingProvider(sent: Sent[], forcedCapable = true): AgentProvider {
    const provider = baseProvider(async function* (request) {
      sent.push({
        turn: request.turn,
        toolChoice: request.toolChoice,
        thinking: request.thinking,
        reasoningEffort: request.reasoningEffort,
      })
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'c1', name: 'read', arguments: '{}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    return {
      ...provider,
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls', 'reasoning'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsReasoning: true,
        ...(forcedCapable ? { supportsForcedToolUse: true } : {}),
      },
    }
  }

  const readTool: AgentTool = {
    name: 'read',
    parameters: { type: 'object' },
    async execute() {
      return { content: 'ok' }
    },
  }

  function thinkingRun(provider: AgentProvider, extra: Partial<AgentLoopOptions> = {}) {
    return runAgentLoop({
      provider,
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [readTool],
      sessionId: 'session-1',
      messageId: 'message-1',
      maxTurns: 3,
      thinking: 'enabled',
      reasoningEffort: 'high',
      ...extra,
    })
  }

  it('keeps thinking off for the WHOLE run once any round is forced', async () => {
    const sent: Sent[] = []
    await thinkingRun(sendingProvider(sent), { initialToolChoice: 'required' })

    expect(sent).toEqual([
      // The reflex round: forced, and therefore un-thinking. reasoningEffort
      // goes with it — `reasoningStyle: 'thinking-type'` emits reasoning_effort
      // regardless of the thinking flag, which would walk into the first 400.
      { turn: 1, toolChoice: 'required', thinking: 'disabled', reasoningEffort: undefined },
      // …and round 2 stays un-thinking even though it is no longer forced.
      // MUTATION LOCK on the SCOPE: restoring thinking here is the natural
      // (and wrong) implementation — it earns a second, later 400,
      // `The reasoning_content in the thinking mode must be passed back to the
      // API.` Round 1 produced its tool-call message with reasoning off, so
      // there is no reasoning_content to replay; the mode belongs to the shared
      // history, not to one request.
      { turn: 2, toolChoice: 'auto', thinking: 'disabled', reasoningEffort: undefined },
    ])
  })

  it('leaves thinking alone when nothing is forced', async () => {
    const sent: Sent[] = []
    await thinkingRun(sendingProvider(sent))

    expect(sent.map(entry => entry.thinking)).toEqual(['enabled', 'enabled'])
    expect(sent.map(entry => entry.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('keeps thinking when the forced choice was dropped by the capability gate', async () => {
    // Mutation lock on the ORDER of the two rules: suppressing reasoning off
    // the caller's *request* rather than off the *resolved* choice would strip
    // it from a run that is never actually forced.
    const sent: Sent[] = []
    await thinkingRun(sendingProvider(sent, false), { initialToolChoice: 'required' })

    expect(sent).toEqual([
      { turn: 1, toolChoice: 'auto', thinking: 'enabled', reasoningEffort: 'high' },
      { turn: 2, toolChoice: 'auto', thinking: 'enabled', reasoningEffort: 'high' },
    ])
  })

  it('pairs the rule to FORCED-ness, not to initialToolChoice (universal constraint)', async () => {
    // A standing specific-tool choice is forced too, and Anthropic/DeepSeek
    // reject it under thinking for the same reason. The rule reads the choice,
    // not the field it came from.
    const sent: Sent[] = []
    await thinkingRun(sendingProvider(sent), {
      toolChoice: { type: 'function', function: { name: 'read' } },
    })

    expect(sent.map(entry => entry.thinking)).toEqual(['disabled', 'disabled'])
    // …and 'none' is NOT forced: nothing is being demanded of the model.
    const noneSent: Sent[] = []
    await thinkingRun(sendingProvider(noneSent), { toolChoice: 'none' })
    expect(noneSent.map(entry => entry.thinking)).toEqual(['enabled', 'enabled'])
  })

  it('reports the paired shape to the turn trace as well', async () => {
    const sent: Sent[] = []
    const traced: Array<{ toolChoice: unknown; thinking: unknown }> = []
    await thinkingRun(sendingProvider(sent), {
      initialToolChoice: 'required',
      onTurnTrace(event) {
        traced.push({ toolChoice: event.request.toolChoice, thinking: event.request.thinking })
      },
    })

    expect(traced).toEqual([
      { toolChoice: 'required', thinking: 'disabled' },
      { toolChoice: 'auto', thinking: 'disabled' },
    ])
  })
})

/**
 * 退役工具名(tool-names.ts)。改名一个模型每天都在调的工具时,历史里的旧调用
 * 范例不会跟着改 —— provider 是生成器,模仿旧范例吐一个旧名是必然会发生的事,
 * 而「Tool not available」丢的是一条本该送达的消息。
 */
describe('runAgentLoop retired tool names', () => {
  it('routes a retired name to the current tool, without listing it in the request', async () => {
    registerRetiredAgentToolName('say', 'send_message')
    const seenRequestTools: string[][] = []
    const provider = baseProvider(async function* (request) {
      seenRequestTools.push((request.tools ?? []).map(tool => tool.name))
      if (request.turn === 1) {
        yield {
          type: 'tool-call-done',
          turn: request.turn,
          toolCall: { id: 'call_1', name: 'say', arguments: '{"content":"hi"}' },
        }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const executed: string[] = []
    const tool: AgentTool = {
      name: 'send_message',
      parameters: { type: 'object' },
      async execute(args) {
        executed.push(String(args.content))
        return { content: 'sent' }
      },
    }

    const result = await runAgentLoop(baseOptions(provider, tool, []))

    expect(executed).toEqual(['hi'])
    expect(result.toolResults[0]?.result.error).toBeUndefined()
    // 别名只在派发时生效:请求的 tools 参数里只有现名。
    for (const names of seenRequestTools) expect(names).toEqual(['send_message'])
    clearRetiredAgentToolNames()
  })

  it('still reports an unknown tool when nothing is registered under that name', async () => {
    clearRetiredAgentToolNames()
    const provider = baseProvider(async function* (request) {
      if (request.turn === 1) {
        yield {
          type: 'tool-call-done',
          turn: request.turn,
          toolCall: { id: 'call_1', name: 'say', arguments: '{}' },
        }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const tool: AgentTool = {
      name: 'send_message',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'sent' }
      },
    }

    const result = await runAgentLoop(baseOptions(provider, tool, []))
    expect(result.toolResults[0]?.result.error).toContain('Tool not available: say')
  })
})

describe('runAgentLoop tool-result terminate (N6)', () => {
  it('ends the run after a tool returns terminate:true — no second provider turn', async () => {
    let providerTurns = 0
    const provider = baseProvider(async function* (request) {
      providerTurns += 1
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_answer', name: 'final_answer', arguments: '{"answer":"42"}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      // A second turn would be a regression: terminate must stop the loop.
      yield { type: 'text-delta', turn: request.turn, delta: 'should not run' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const tool: AgentTool = {
      name: 'final_answer',
      parameters: { type: 'object' },
      async execute(args) {
        return { content: String(args.answer), terminate: true }
      },
    }

    const result = await runAgentLoop({ ...baseOptions(provider, tool, []), maxTurns: 4 })

    expect(providerTurns).toBe(1)
    expect(result.turns).toBe(1)
    // The tool result is still appended for the caller.
    expect(result.toolResults.map(item => item.toolCall.id)).toEqual(['call_answer'])
    const toolMessages = result.messages.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => message.toolCallId)).toEqual(['call_answer'])
  })

  it('runs every sibling in the terminating turn to completion before stopping', async () => {
    const events: string[] = []
    let providerTurns = 0
    const provider = baseProvider(async function* (request) {
      providerTurns += 1
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_a', name: 'work', arguments: '{"id":"a"}' } }
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_b', name: 'work', arguments: '{"id":"b"}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    // Both siblings run in parallel; call_a asks to terminate. call_b must still finish.
    const tool: AgentTool = {
      name: 'work',
      parameters: { type: 'object' },
      executionMode: 'parallel',
      async execute(args) {
        const id = String(args.id)
        events.push(`start:${id}`)
        await new Promise(resolve => setTimeout(resolve, id === 'b' ? 10 : 0))
        events.push(`end:${id}`)
        return id === 'a' ? { content: 'a', terminate: true } : { content: 'b' }
      },
    }

    const result = await runAgentLoop({
      ...baseOptions(provider, tool, []),
      tools: [tool],
      maxTurns: 4,
    })

    expect(providerTurns).toBe(1)
    // Both siblings completed — terminate is a graceful wrap-up, not a hard cut.
    expect(events).toContain('end:a')
    expect(events).toContain('end:b')
    expect(result.toolResults.map(item => item.toolCall.id)).toEqual(['call_a', 'call_b'])
  })

  it('keeps looping when the tool result omits terminate (default behavior)', async () => {
    let providerTurns = 0
    const provider = baseProvider(async function* (request) {
      providerTurns += 1
      if (request.turn === 1) {
        yield { type: 'tool-call-done', turn: request.turn, toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"a"}' } }
        yield { type: 'finish', turn: request.turn, finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text-delta', turn: request.turn, delta: 'done' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })
    const tool: AgentTool = {
      name: 'read',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'read a' } // no terminate
      },
    }

    const result = await runAgentLoop({ ...baseOptions(provider, tool, []), maxTurns: 4 })

    // A normal tool result continues to the next provider turn.
    expect(providerTurns).toBe(2)
    expect(result.text).toBe('done')
  })
})
