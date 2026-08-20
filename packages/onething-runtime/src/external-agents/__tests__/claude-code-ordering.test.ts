import { describe, expect, it } from 'vitest'
import { agentEventsToProviderStreamChunks } from '@onething/core/agent-loop'
import type { AgentStreamEvent } from '@onething/core/agent-loop'
import {
  applyAgentLoopStreamChunkWithAdapters,
  createAgentLoopExecutorTurnState,
  createCoreStreamProcessor,
  persistAgentLoopTurnContentPartsWithAdapters,
  type CoreAgentLoopExecutorTurnState,
  type CoreOrderedPartLike,
  type CoreStreamToolCallLike,
} from '@onething/core/engine'
import { createClaudeCodeConnector, type ClaudeCodeSdkMessage } from '../claude-code-connector.js'
import type { ExternalAgentEvent } from '../types.js'

/**
 * 外部通路的**次序**(F4)。
 *
 * 本地 provider 一次 provider 请求 = 一个 turn,turn 之间由 finish 分界:
 * `data-steps` 锚点(工具卡在正文里的落点)因此一个 turn 只种一次,而一个 turn 里
 * 正文永远在工具调用之前 —— 次序天然对。
 *
 * Claude Code 的一整段会话(正文 → 工具 → 正文 → 工具 → 正文)全在**一个** turn 里,
 * 所以这条测试把连接器的真实事件流原样喂进真实的执行器,断言正文与工具卡在
 * contentParts 上仍然交错、而不是所有工具卡塌到第一个锚点上。
 */

function streamEvent(event: Record<string, unknown>): ClaudeCodeSdkMessage {
  return {
    type: 'stream_event',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    event: event as ClaudeCodeSdkMessage['event'],
  }
}

function toolResultMessage(toolUseId: string, content: string): ClaudeCodeSdkMessage {
  return {
    type: 'user',
    session_id: 'claude-session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  }
}

/** 三轮:说一句 → Bash → 再说一句 → Edit → 收尾一句。 */
const interleavedFixture: ClaudeCodeSdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'claude-session-1' },

  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listing files. ' } }),
  streamEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' },
  }),
  streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }),
  streamEvent({ type: 'content_block_stop', index: 1 }),
  toolResultMessage('toolu_1', 'a.ts\nb.ts'),

  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Now editing. ' } }),
  streamEvent({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_2', name: 'Read' },
  }),
  streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } }),
  streamEvent({ type: 'content_block_stop', index: 1 }),
  toolResultMessage('toolu_2', 'const a = 1'),

  streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
  {
    type: 'result',
    subtype: 'success',
    session_id: 'claude-session-1',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
]

type TestPart = CoreOrderedPartLike & { type: string; turnIndex?: number; content?: string }

interface RunResult {
  /** 落库的 contentParts —— 会话重开之后 UI 读的就是它。 */
  persisted: TestPart[]
  /** 直播时推给 renderer 的 contentParts。 */
  sent: TestPart[]
  /** 每个工具步骤登记的 turnIndex(工具卡按它归到某个 data-steps 锚点下)。 */
  stepTurnIndexByToolCallId: Map<string, number>
}

async function runThroughExecutor(messages: ClaudeCodeSdkMessage[]): Promise<RunResult> {
  const connector = createClaudeCodeConnector({
    permissionHandler: async () => ({ behavior: 'allow' as const }),
    queryFn: () => (async function* () {
      for (const message of messages) yield message
    })(),
  })

  const events = (async function* (): AsyncGenerator<AgentStreamEvent, void, void> {
    for await (const event of connector.streamTurn({
      localSessionId: 'session-1',
      messageId: 'msg-1',
      prompt: 'go',
      cwd: '/tmp/project',
      turn: 1,
    }) as AsyncIterable<ExternalAgentEvent>) {
      if (event.type === 'session-established' || event.type === 'agent-status') continue
      yield event
    }
  })()

  const persisted: TestPart[] = []
  const sent: TestPart[] = []
  const stepTurnIndexByToolCallId = new Map<string, number>()

  const processor = createCoreStreamProcessor<CoreStreamToolCallLike, TestPart>({
    ctx: { sessionId: 's1', assistantMessageId: 'm1' },
    createStepId: (() => {
      let n = 0
      return () => `step-${++n}`
    })(),
    resolveToolIdentity: (toolName: string) => ({ toolId: toolName, displayName: toolName, isMcp: false }),
    store: {
      updateMessageContent: () => {},
      updateMessageReasoning: () => {},
      updateMessageToolCalls: () => {},
      updateMessageStreaming: () => {},
      flushSessionSave: () => {},
    },
    emitter: {
      sendTextChunk: () => {},
      sendReasoningChunk: () => {},
      sendToolCall: () => {},
      sendStepAdded: (step) => {
        const typed = step as unknown as { toolCallId: string; turnIndex?: number }
        stepTurnIndexByToolCallId.set(typed.toolCallId, typed.turnIndex ?? -1)
      },
      sendToolInputStart: () => {},
      sendToolInputDelta: () => {},
      sendToolInputEnd: () => {},
    },
  })

  const state = {
    turnIndex: 1,
    turn: createAgentLoopExecutorTurnState<CoreStreamToolCallLike, TestPart>(),
    toolIterations: 0,
    skillManageCalled: false,
    stepIdsByToolCallId: new Map<string, string>(),
  }

  const emitter = {
    sendContentPart: (part: TestPart) => { sent.push(part) },
    sendToolCall: () => {},
    sendToolResult: () => {},
    sendToolExecutionStart: () => {},
    sendToolExecutionUpdate: () => {},
    sendToolExecutionEnd: () => {},
    sendStepUpdated: () => {},
    sendSkillActivated: () => {},
    sendContextSizeUpdate: () => {},
    sendContinuation: () => {},
  }

  const persistTurnContentParts = (): void => {
    persistAgentLoopTurnContentPartsWithAdapters<TestPart>({
      sessionId: 's1',
      assistantMessageId: 'm1',
      turn: state.turn as CoreAgentLoopExecutorTurnState<unknown, TestPart>,
      turnIndex: state.turnIndex,
      store: { addMessageContentPart: (_s, _m, part) => { persisted.push(part as TestPart) } },
      emitter,
    })
  }

  for await (const chunk of agentEventsToProviderStreamChunks(events)) {
    await applyAgentLoopStreamChunkWithAdapters<TestPart, CoreStreamToolCallLike, unknown, unknown>({
      state,
      chunk,
      sessionId: 's1',
      assistantMessageId: 'm1',
      model: 'claude-code-agent',
      accumulatedContent: processor.accumulatedContent,
      processor,
      store: { updateMessageToolCalls: () => {} },
      emitter,
      createNextAssistantWriter: () => {},
      handleTextChunk: (text, content, turnIndex) => processor.handleTextChunk(text, content, turnIndex),
      handleReasoningChunk: (reasoning, accumulator, turnIndex, placement) =>
        processor.handleReasoningChunk(reasoning, accumulator, turnIndex, placement),
      persistTurnContentParts,
      createTurnState: () => createAgentLoopExecutorTurnState<CoreStreamToolCallLike, TestPart>(),
    })
  }

  return { persisted, sent, stepTurnIndexByToolCallId }
}

function shape(parts: TestPart[]): string[] {
  return parts.map(part => (part.type === 'text' ? `text:${part.content}` : `${part.type}@${part.turnIndex}`))
}

describe('claude-code 外部通路的正文/工具卡次序(F4)', () => {
  it('正文与工具卡在 contentParts 上保持真实先后,不塌到第一个 data-steps 锚点', async () => {
    const { persisted, stepTurnIndexByToolCallId } = await runThroughExecutor(interleavedFixture)

    // 真实先后:说一句 → Bash → 再说一句 → Read → 收尾。
    // 塌成一个锚点的话,'Now editing. ' 会跑到两张工具卡的后面。
    expect(shape(persisted)).toEqual([
      'text:Listing files. ',
      'data-steps@1',
      'text:Now editing. ',
      'data-steps@2',
      'text:Done.',
    ])

    // 两次调用必须落在**不同**的锚点下,否则第二张卡会被画在第一段正文后面。
    expect(stepTurnIndexByToolCallId.get('toolu_1')).toBe(1)
    expect(stepTurnIndexByToolCallId.get('toolu_2')).toBe(2)
  })

  it('start 流过、stop 没到时,assistant 回填不再补第二条 tool-call-start', async () => {
    const connector = createClaudeCodeConnector({
      queryFn: () => (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' } as ClaudeCodeSdkMessage
        yield streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' },
        })
        yield streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
        })
        // content_block_stop 缺席(流被截断 / 回放),整块内容只从 assistant 消息回来。
        yield {
          type: 'assistant',
          session_id: 'claude-session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        } as ClaudeCodeSdkMessage
        yield { type: 'result', subtype: 'success', session_id: 'claude-session-1' } as ClaudeCodeSdkMessage
      })(),
    })

    const events: ExternalAgentEvent[] = []
    for await (const event of connector.streamTurn({
      localSessionId: 's', prompt: 'x', cwd: '/tmp', turn: 1,
    })) events.push(event)

    const starts = events.filter(event => event.type === 'tool-call-start')
    expect(starts).toHaveLength(1)
    const dones = events.filter(event => event.type === 'tool-call-done')
    expect(dones).toHaveLength(1)
  })

  it('直播推送的 contentParts 与落库的次序一致', async () => {
    const { sent, persisted } = await runThroughExecutor(interleavedFixture)
    // 直播只推「工具之前的正文 + 锚点」,收尾正文由落库那一路补上;
    // 两者拼起来必须仍是同一个次序,不能出现锚点在正文之后又跳回去。
    const sentSteps = sent.filter(part => part.type === 'data-steps').map(part => part.turnIndex)
    const persistedSteps = persisted.filter(part => part.type === 'data-steps').map(part => part.turnIndex)
    expect(sentSteps).toEqual(persistedSteps)
  })
})
