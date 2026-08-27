/**
 * F4-b1 合同用例:**step 身份在引擎写手与投影物化两侧是同一个东西**
 * (`docs/design/session-event-sourcing-2026-08.md` §16.16;硬阻塞① = §16.13 第二节)。
 *
 * 病根是机械的,不是审美的:`sendStepUpdated(stepId, updates)`
 * (`core/engine/event-only-emitter.ts:343`)同时做两件事 —— 往 store 打
 * `updateMessageStep(…, stepId, …)`(reducer 的 `patchStep` **按 id 认**:
 * `steps.findIndex(step => step.id === command.stepId)`),以及往渲染层推一条
 * `STEP_UPDATED`(不经过 store)。从前引擎那一侧的 id 是 `createCoreId()` 现生的
 * uuid,而投影物化(`materializeStep`)是 `step-${callId}` —— 一旦 store 换成
 * 物化视图(F4-b3 的终局),每一次 `patchStep` 当场 `findIndex === -1` **静默
 * no-op**,渲染层却照收更新:内存与屏幕分家,而 canonical 明文丢掉 step `id`
 * (G1),恒等门看不见这件事。
 *
 * 所以这条护栏必须**跨两条路**取值,不能两边都问同一个函数:
 *  - 引擎侧的 id:真的把 `createCoreStreamProcessor` 跑一遍,读它自己记的
 *    `getStepIdForToolCall(callId)` —— 那正是 `handleToolInputStart` 写进
 *    `toolInputBuffers` 的那一格,也正是 agent-loop 的 `stepIdsByToolCallId`
 *    与 `existingStepId` 一路传下去、最后交给 `sendStepUpdated` 的那一个;
 *  - 投影侧的 step:真的把一份事件账本喂给 `projectChatMessages`。
 *
 * 断言 = 把投影物化出来的消息**当作 store**,replay 引擎会发的每一次
 * `patchStep(stepId)`,每一次都必须命中。
 *
 * 反证在下面第二个用例里:换回旧语义(现生一个 uuid)当场全部落空,而
 * `applySessionCommand` 一声不吭 —— 那就是这道门要挡的那件事。
 *
 * 场景是**多工具多轮 + steer**:一条 run 里两次工具调用(其中一次参数是流式的),
 * steering 把执行劈成第二条助手消息,里面还有第三次调用。
 */
import { describe, expect, it } from 'vitest'

import { createCoreId } from '../../engine/ids.js'
import { createCoreStreamProcessor } from '../../engine/stream-processor.js'
import { applySessionCommand } from '../commands.js'
import type { CoreSessionCommandMessage } from '../commands.js'
import type { SessionLogEventRecord } from '../events/index.js'
import { projectChatMessages } from '../projection/index.js'

// ---------------------------------------------------------------------------
// 场景:多工具多轮 + steer(两条助手消息,三次工具调用)
// ---------------------------------------------------------------------------

interface ToolFixture {
  callId: string
  name: string
  args: Record<string, unknown>
  /** 参数是流式来的(多一段 tool-input chunks + part-end)。 */
  streamedArgs?: boolean
}

const RUN1_TOOLS: ToolFixture[] = [
  { callId: 'call_bash_1', name: 'bash', args: { command: 'echo one' }, streamedArgs: true },
  { callId: 'call_read_1', name: 'read', args: { path: '/tmp/a.txt' } },
]
const RUN2_TOOLS: ToolFixture[] = [
  { callId: 'call_bash_2', name: 'bash', args: { command: 'echo two' } },
]

function toolEvents(
  runId: string,
  messageId: string,
  tools: readonly ToolFixture[],
  start: { seq: number; time: number; partIndex: number },
): Record<string, unknown>[] {
  const line: Record<string, unknown>[] = []
  let { seq, time, partIndex } = start
  for (const tool of tools) {
    if (tool.streamedArgs) {
      const text = JSON.stringify(tool.args)
      const at = partIndex++
      line.push({
        seq: seq++, time: time++, type: 'assistant/chunks',
        data: {
          runId, requestIndex: 1, messageId, partIndex: at,
          kind: 'tool-input', toolCallId: tool.callId, toolName: tool.name,
          time0: time, dt: [0], text: [text],
        },
      })
      line.push({
        seq: seq++, time: time++, type: 'assistant/part-end',
        data: {
          runId, requestIndex: 1, messageId, partIndex: at,
          kind: 'tool-input', toolCallId: tool.callId, toolName: tool.name, len: text.length,
        },
      })
    }
    line.push({
      seq: seq++, time: time++, type: 'tool/call',
      data: { runId, callId: tool.callId, name: tool.name, arguments: { text: JSON.stringify(tool.args) } },
    })
    line.push({
      seq: seq++, time: time++, type: 'tool/result',
      data: {
        runId, callId: tool.callId, isError: false,
        resultPreview: `${tool.name} done`, result: { text: `${tool.name} done` },
      },
    })
  }
  return line
}

/** 一份真的能被 `projectChatMessages` 折出两条助手消息的账本。 */
function steeredMultiToolEvents(): SessionLogEventRecord[] {
  const events: Record<string, unknown>[] = [
    { seq: 1, time: 1, type: 'user/message', data: { message: { id: 'u1', role: 'user', content: '跑两个工具', timestamp: 1 } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'run/start', data: { runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2 }, surfaceOp: 'append' },
  ]
  events.push(...toolEvents('r1', 'a1', RUN1_TOOLS, { seq: 3, time: 3, partIndex: 0 }))
  const afterRun1 = 3 + RUN1_TOOLS.length * 2 + 2
  events.push({ seq: afterRun1, time: afterRun1, type: 'run/end', data: { runId: 'r1', outcome: 'ok' } })
  // steering:用户在执行途中插话,下一轮开在**新的**助手消息上。
  events.push({
    seq: afterRun1 + 1, time: afterRun1 + 1, type: 'user/message',
    data: { message: { id: 'u2', role: 'user', content: '换个方向', timestamp: afterRun1 + 1 } },
    surfaceOp: 'append',
  })
  events.push({
    seq: afterRun1 + 2, time: afterRun1 + 2, type: 'run/start',
    data: { runId: 'r2', kind: 'send', assistantMessageId: 'a2', timestamp: afterRun1 + 2, continuesRunId: 'r1' },
    surfaceOp: 'append',
  })
  events.push(...toolEvents('r2', 'a2', RUN2_TOOLS, { seq: afterRun1 + 3, time: afterRun1 + 3, partIndex: 0 }))
  const afterRun2 = afterRun1 + 3 + RUN2_TOOLS.length * 2
  events.push({ seq: afterRun2, time: afterRun2, type: 'run/end', data: { runId: 'r2', outcome: 'ok' } })
  return events as unknown as SessionLogEventRecord[]
}

// ---------------------------------------------------------------------------
// 引擎那一侧:真的跑一遍流式处理器,问它自己记的 step id
// ---------------------------------------------------------------------------

const noopStore = {
  updateMessageContent() {},
  updateMessageReasoning() {},
  updateMessageToolCalls() {},
  updateMessageStreaming() {},
  flushSessionSave() {},
}

const noopEmitter = {
  sendTextChunk() {},
  sendReasoningChunk() {},
  sendToolCall() {},
  sendStepAdded() {},
  sendToolInputStart() {},
  sendToolInputDelta() {},
  sendToolInputEnd() {},
}

/**
 * 引擎会拿哪一个 id 去打 `patchStep`。
 *
 * 不是"照 `coreStepIdForToolCall` 再算一遍"(那样这条门就恒真了),而是把
 * `handleToolInputStart` 真跑一遍,读它写进缓冲表的那一格 —— 生产里
 * `sendToolInputEnd` / `existingStepId` / `stepIdsByToolCallId` 拿的都是它。
 */
function engineStepIdsFor(sessionId: string, messageId: string, tools: readonly ToolFixture[]): Map<string, string> {
  const processor = createCoreStreamProcessor({
    ctx: { sessionId, assistantMessageId: messageId },
    store: noopStore,
    emitter: noopEmitter,
    resolveToolIdentity: (toolName: string) => ({ toolId: toolName, displayName: toolName, isMcp: false }),
  })
  const ids = new Map<string, string>()
  for (const tool of tools) {
    processor.handleToolInputStart(tool.callId, tool.name, 0)
    const stepId = processor.getStepIdForToolCall(tool.callId)
    expect(stepId, `engine kept no step id for ${tool.callId}`).toBeTypeOf('string')
    ids.set(tool.callId, stepId!)
  }
  return ids
}

// ---------------------------------------------------------------------------

function projectedSession(): { messages: CoreSessionCommandMessage[]; updatedAt: number } {
  const { messages } = projectChatMessages(steeredMultiToolEvents())
  return { messages: messages as unknown as CoreSessionCommandMessage[], updatedAt: 0 }
}

describe('F4-b1:step 身份在引擎写手与投影物化两侧是同一个东西', () => {
  it('投影物化出来的 step,引擎发的每一次 patchStep 都命中', () => {
    let session = projectedSession()
    const assistants = session.messages.filter(message => message.role === 'assistant')
    expect(assistants.map(message => message.id)).toEqual(['a1', 'a2'])

    const plan: Array<{ messageId: string; callId: string; stepId: string }> = []
    for (const [messageId, tools] of [['a1', RUN1_TOOLS], ['a2', RUN2_TOOLS]] as const) {
      for (const [callId, stepId] of engineStepIdsFor('s1', messageId, tools)) {
        plan.push({ messageId, callId, stepId })
      }
    }
    expect(plan).toHaveLength(3)

    for (const entry of plan) {
      // 投影确实为这次调用物化了一条 step,而且 id 就是引擎手上那一个。
      const before = session.messages.find(message => message.id === entry.messageId)?.steps
      expect(
        before?.find(step => step.toolCallId === entry.callId)?.id,
        `projection/engine step id split for ${entry.callId}`,
      ).toBe(entry.stepId)

      const result = applySessionCommand(session, {
        type: 'patchStep',
        messageId: entry.messageId,
        stepId: entry.stepId,
        updates: { status: 'cancelled' },
      })
      expect(result.changed, `patchStep(${entry.stepId}) fell through`).toBe(true)
      session = result.session
    }

    // 三条 step 全都真的被改到了 —— 命中不是"返回值说命中"。
    const patched = session.messages
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.steps ?? [])
      .filter(step => step.status === 'cancelled')
    expect(patched).toHaveLength(3)
  })

  it('反证:换回旧语义(引擎现生 uuid)每一次 patchStep 都静默落空', () => {
    const session = projectedSession()
    for (const [messageId, tools] of [['a1', RUN1_TOOLS], ['a2', RUN2_TOOLS]] as const) {
      for (const tool of tools) {
        const legacyStepId = createCoreId()
        const result = applySessionCommand(session, {
          type: 'patchStep',
          messageId,
          stepId: legacyStepId,
          updates: { status: 'cancelled' },
        })
        // 没抛、没红、什么都没发生 —— 这正是它当初躲过所有门的原因。
        expect(result.changed).toBe(false)
        expect(result.session).toBe(session)
      }
    }
  })
})
