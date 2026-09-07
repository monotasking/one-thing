import { createHash, randomUUID } from 'node:crypto'
import { awaitAgentExecutionCheckpoint, isAgentExecutionCheckpointError } from '@onething/core/agent-loop'
import { ensureSessionWritable } from '../../session/index.js'
import { writeSessionEvent } from '../../session/event-writer.js'
import { flushSessionEventLog } from '../../session/event-log.js'
import { textOrBlobForEvent } from '../../session/blob-store.js'

/** One intent and one outcome per utility call; never replay an unknown external outcome. */
export interface AuxiliaryModelInput {
  sessionId: string
  purpose: 'title' | 'compact-chunk' | 'compact-merge' | 'toc'
  provider: string
  model: string
  messages: readonly { role: string; content: string }[]
  params?: Record<string, unknown>
}

/**
 * 辅助模型(标题 / 压缩 / 大纲)的**意图与结果账**:一次调用一条意图、一条结果。
 *
 * **落盘在这里是 `await`,不是 `void`** —— 与 `session-event-recorder` 那三处
 * 「每回合 / 每工具各一次」的语义检查点**不同类**(工单 4 F1 复核过并保留):
 *
 *  - 那三处在**流的中途**,一次执行发生 N 次,等下去就是把一次盘等待摊进每一轮;
 *  - 这里是**一次辅助模型调用一次**,而这次调用本身就是一趟网络往返(几百毫秒)。
 *    一次 fsync 在它旁边是可忽略的,换来的是那条硬性质:**模型调用绝不先于它自己
 *    的意图落盘**。崩在中间时账本上有「发起过、结果未知」,而不是什么都没有 ——
 *    这正是 §15.12(c) 里 `run/end` 那一处被留成可 await 的同一条理由。
 *
 * `wiring/toc/__tests__/record-turn.test.ts` 三条用例把它钉着(意图落盘失败 →
 * provider 一次都不许被调到;每次重试各记一份意图,且都在到达 provider 之前)。
 *
 * 记账**失败上抛**(`writeSessionEvent` 返回 undefined = 这条会话记不了账):
 * 账本坏了不许假装还好着。
 *
 * 分开两道屏障,是因为调用方(toc 的 runner)自己管重试与流式输出。
 */
export async function beginAuxiliaryModelRequest(input: AuxiliaryModelInput) {
  const actionId = randomUUID()
  const { sessionId, purpose, provider, model, messages, params } = input
  await awaitAgentExecutionCheckpoint(`${purpose} intent`, async () => {
    await ensureSessionWritable(sessionId)
    const seq = writeSessionEvent(sessionId, 'auxiliary-model/intent', {
      actionId, purpose, provider, model,
      input: textOrBlobForEvent(sessionId, JSON.stringify(messages)),
      ...(params ? { params } : {}),
    })
    if (seq === undefined) throw new Error(`Cannot record utility model intent for session: ${sessionId}`)
    await flushSessionEventLog(sessionId)
  })
  return {
    async failed(error: unknown): Promise<void> {
      await awaitAgentExecutionCheckpoint(`${purpose} error`, async () => {
        const seq = writeSessionEvent(sessionId, 'auxiliary-model/result', {
          actionId, outcome: 'error', error: error instanceof Error
            ? { name: error.name, message: error.message } : { message: String(error) },
        })
        if (seq === undefined) throw new Error(`Cannot record utility model outcome for session: ${sessionId}`)
        await flushSessionEventLog(sessionId)
      })
    },
    async completed(response: string): Promise<void> {
      await awaitAgentExecutionCheckpoint(`${purpose} result`, async () => {
        const seq = writeSessionEvent(sessionId, 'auxiliary-model/result', {
          actionId, outcome: 'completed', outputHash: createHash('sha256').update(response).digest('hex'),
          outputBytes: Buffer.byteLength(response),
        })
        if (seq === undefined) throw new Error(`Cannot record utility model outcome for session: ${sessionId}`)
        await flushSessionEventLog(sessionId)
      })
    },
  }
}

export async function runAuxiliaryModelRequest(input: AuxiliaryModelInput, request: () => Promise<string>): Promise<string> {
  const checkpoint = await beginAuxiliaryModelRequest(input)
  let response: string
  try { response = await request() } catch (error) {
    if (isAgentExecutionCheckpointError(error)) throw error
    await checkpoint.failed(error)
    throw error
  }
  await checkpoint.completed(response)
  return response
}
