import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { ChatMessage } from '@shared/ipc.js'
import { completeAgentLoopStream, type AgentLoopExecutorState } from '../agent-loop-executor.js'

/**
 * 反向门:正常收尾发射的 settled 快照(`MESSAGE_UPDATED.updates.contentParts`)
 * 必须来自 **抄本真相**(`messages.jsonl`,带 `data-steps` 渲染锚点),不来自
 * events 活投影(§13.18 发现 B)。
 *
 * 病根:切读默认翻到 `events`(bad54a31)后,`completeAgentLoopStream` 的收尾读若
 * 走随读模式分岔的 `sessionReads.getMessage`,events 模式下拿到的投影 contentParts
 * **故意不含** `data-steps` / `tool-call`(它们是渲染锚点,canonical G4 丢弃、
 * `materializeContentParts` 不合成)。这份缺锚点的快照被 renderer 的
 * `updateSessionMessage` 整体覆盖上去,`rebuildContentParts` 见非空(有 text)不再
 * 合成锚点 → work group 头与整段工具渲染在收尾那一刻消失。修复:收尾读走
 * `getMessageFromTranscript`(与 abort 收尾 :449 同治法)。
 *
 * 用 spy 让两条读法**分岔**:抄本侧带 `data-steps`,events 侧不带。断言收尾发射的
 * 快照仍带 `data-steps` —— 只有读抄本才可能带,读投影必红。
 */

const transcriptContentParts = [
  { type: 'text', content: '让我看一下', turnIndex: 1 },
  {
    type: 'tool-call',
    turnIndex: 1,
    toolCalls: [{ id: 'call_1', toolName: 'read', arguments: {}, status: 'completed', timestamp: 1 }],
  },
  { type: 'data-steps', turnIndex: 1 },
  { type: 'text', content: '看完了', turnIndex: 2 },
] as unknown as ChatMessage['contentParts']

// events 活投影:同一条消息,但 contentParts 里**没有** data-steps / tool-call
// (只有正文),复刻 §13.18 发现 B 的分岔。
const eventsProjectionContentParts = [
  { type: 'text', content: '让我看一下', turnIndex: 1 },
  { type: 'text', content: '看完了', turnIndex: 2 },
] as unknown as ChatMessage['contentParts']

const completedToolCall = { id: 'call_1', toolName: 'read', arguments: {}, status: 'completed', endTime: 10, timestamp: 1 }
const completedStep = { id: 'step-call_1', status: 'completed', toolCallId: 'call_1', turnIndex: 1, toolCall: completedToolCall }

function messageWith(contentParts: ChatMessage['contentParts']): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '看完了',
    contentParts,
    toolCalls: [completedToolCall],
    steps: [completedStep],
    timestamp: 1,
  } as unknown as ChatMessage
}

const hoisted = vi.hoisted(() => ({
  getMessageFromTranscript: vi.fn(),
  getMessage: vi.fn(),
  emit: vi.fn(async (_sessionId: string, _event: unknown) => undefined),
  patchMessage: vi.fn(),
}))

vi.mock('../../../../store.js', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getSession: vi.fn(() => ({ name: 'Session', messages: [] })),
}))

vi.mock('../../../../session/reads.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    sessionReads: {
      ...(actual.sessionReads as Record<string, unknown>),
      getMessageFromTranscript: hoisted.getMessageFromTranscript,
      getMessage: hoisted.getMessage,
    },
  }
})

vi.mock('../../../../session/commands.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    sessionCommands: {
      ...(actual.sessionCommands as Record<string, unknown>),
      patchMessage: hoisted.patchMessage,
    },
  }
})

vi.mock('../../../../events/index.js', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getEventBus: () => ({ emit: hoisted.emit }),
}))

vi.mock('../../triggers/index.js', () => ({
  triggerManager: { runPostResponse: vi.fn(() => Promise.resolve()) },
}))

vi.mock('@onething/runtime/plugins/lifecycle.wiring', () => ({
  runAfterAssistantResponseHooks: vi.fn(() => Promise.resolve()),
}))

vi.mock('@onething/runtime/media/save-image', () => ({
  saveMediaImage: vi.fn(),
}))

function settleState(): AgentLoopExecutorState {
  return {
    ctx: { sessionId: 's1', assistantMessageId: 'm1' },
    accumulatedUsage: undefined,
    lastTurnUsage: undefined,
    processor: { finalize: vi.fn() },
    emitter: { sendStreamComplete: vi.fn() },
  } as unknown as AgentLoopExecutorState
}

describe('settle emit reads the transcript, not the events projection', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('ships the data-steps render anchor in the settled snapshot (events read mode)', async () => {
    // 抄本带锚点,投影不带 —— 两条读法分岔。
    hoisted.getMessageFromTranscript.mockReturnValue(messageWith(transcriptContentParts))
    hoisted.getMessage.mockReturnValue(messageWith(eventsProjectionContentParts))

    await completeAgentLoopStream(settleState(), 'Session')

    // 收尾读必须走抄本侧;走随读模式分岔的 getMessage 就是本 bug。
    expect(hoisted.getMessageFromTranscript).toHaveBeenCalledWith('s1', 'm1')
    expect(hoisted.getMessage).not.toHaveBeenCalled()

    const updatedCall = hoisted.emit.mock.calls.find(
      (call) =>
        (call[1] as { type?: unknown } | undefined)?.type === SESSION_EVENT_TYPES.MESSAGE_UPDATED,
    )
    expect(updatedCall).toBeDefined()
    const updates = (updatedCall![1] as { updates: { contentParts?: Array<{ type: string }> } }).updates
    const types = (updates.contentParts ?? []).map(part => part.type)
    // 反向判据:快照 contentParts 仍带渲染锚点与工具格 —— 读投影时它们都会消失,
    // work group 与工具渲染当场没了(切读引入的产品 bug)。
    expect(types).toContain('data-steps')
    expect(types).toContain('tool-call')
  })
})
