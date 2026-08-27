import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { ChatMessage } from '@shared/ipc.js'
import { completeAgentLoopStream, type AgentLoopExecutorState } from '../agent-loop-executor.js'

/**
 * 反向门:正常收尾发射的 settled 快照(`MESSAGE_UPDATED.updates.contentParts`)
 * 必须带 `data-steps` 渲染锚点 —— 否则 renderer 的 `updateSessionMessage`
 * **整体覆盖**上去(那一步不跑 `rebuildContentParts`、不补合成)之后 work group
 * 头与整段工具渲染在收尾那一刻消失(§15.16「正文看不见」那一课的引信)。
 *
 * **F4-c c4-b 把这道门的判据翻了面,断言的产品事实一字未动。**
 *
 * 从前(F4-b2 / §16.17):锚点由**活 run 的写手对象**(内存 store 上那一条)保管,
 * 于是这道门断言的是"收尾必须读 `getLiveRunWriterMessage`,不许读投影" ——
 * 用 spy 让两条读法分岔,写手侧带锚点、投影侧不带。那条口径把 18 个热写端口整体
 * 钉死(§16.24 第五节证据一)。
 *
 * 今天(§16.25 钥匙①):收尾**只读折叠产物**,锚点由共享纯件
 * `@onething/core/session/render-anchors` 从 steps 的 turnIndex **现算** ——
 * 与 renderer 加载路径逐字同源。于是本门的判据变成:**读投影,而快照里锚点还在**。
 *
 * 三条断言,后两条是反证:
 *   ① 收尾读的是投影口(`getMessage`),写手视图那一口一次都不碰;
 *   ② 投影侧 contentParts **不带**任何锚点,而发出去的快照带 `data-steps` ——
 *      只可能来自现算;
 *   ③ 正文逐字不丢(§15.16 定性:丢的是分界不是数据)。
 */

// events 活投影:只有正文 part,**没有** data-steps / tool-call(G4 裁定)。
const projectionContentParts = [
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
  getLiveRunWriterMessage: vi.fn(),
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
      getLiveRunWriterMessage: hoisted.getLiveRunWriterMessage,
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

function settledUpdates(): { contentParts?: Array<{ type: string; content?: string }> } {
  const updatedCall = hoisted.emit.mock.calls.find(
    (call) =>
      (call[1] as { type?: unknown } | undefined)?.type === SESSION_EVENT_TYPES.MESSAGE_UPDATED,
  )
  expect(updatedCall).toBeDefined()
  return (updatedCall![1] as { updates: { contentParts?: Array<{ type: string; content?: string }> } }).updates
}

describe('settle emit reads the projection and synthesizes the render anchors', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('ships the data-steps render anchor even though the projection carries none', async () => {
    hoisted.getMessage.mockReturnValue(messageWith(projectionContentParts))

    await completeAgentLoopStream(settleState(), 'Session')

    // ① 取材口翻面:读投影,写手视图那一口退休了。
    expect(hoisted.getMessage).toHaveBeenCalledWith('s1', 'm1')
    expect(hoisted.getLiveRunWriterMessage).not.toHaveBeenCalled()

    const updates = settledUpdates()
    const types = (updates.contentParts ?? []).map(part => part.type)
    // ② 反证:投影那一份一个锚点都没有(见 projectionContentParts),快照里却有 ——
    //    它只可能来自现算。
    expect((projectionContentParts ?? []).some(part => part.type === 'data-steps')).toBe(false)
    expect(types).toContain('data-steps')
    // 锚点按轮次就位:turn 1 的工具锚点排在 turn 2 的正文**之前**(§15.16 修 A)。
    expect(types).toEqual(['text', 'data-steps', 'text'])
  })

  it('never drops a byte of the body while inserting anchors', async () => {
    hoisted.getMessage.mockReturnValue(messageWith(projectionContentParts))

    await completeAgentLoopStream(settleState(), 'Session')

    const updates = settledUpdates()
    // ③ §15.16 定性:丢的是分界不是数据 —— 正文 part 逐字与投影侧相同。
    const bodies = (updates.contentParts ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.content)
    expect(bodies).toEqual(['让我看一下', '看完了'])
  })
})
