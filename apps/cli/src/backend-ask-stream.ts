/**
 * 一轮对话在 CLI 这一侧怎么跑:发一条会话命令,再从 `GET /api/events` 那条 SSE 上把这条会话的事件折成
 * `onething ask` 的输出事件(第④步批 3)。
 *
 * 从前这件事在守护进程里做(`HeadlessBackend.ask` 直接订进程内的事件总线与流通道);后端变成另一个进程之后,
 * 同样的事实从 SSE 上来:`session:stream` 带正文 / 推理的增量,`session:event` 带工具调用、权限询问与收场。
 * 折法与从前逐字相同(文本 → `text_delta`、推理 → `reasoning_delta`、`tool:call` → `tool_use`、`tool:result` →
 * `tool_result`、发给 `cli` 通道的 `permission:request` → `permission`、三种收场 → `done` / `error`),所以
 * `--json` 那条管道看见的东西不变。
 *
 * 次序:**先接上事件流,再发命令** —— 反过来的话,一轮很快的回答可能在订阅之前就说完了。HTTP 传输接上那一刻
 * 会报 `open`(读第一条之前);没有这一格的传输(测试里的内存替身)视同已接上。
 */
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '@shared/ipc/channels.js'
import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import type { SessionEventEnvelope, SessionStreamPayload } from '@shared/events/index.js'
import type { Transport } from '@onething/backend-client'
import type { AskOutputEvent, AskResult, AskStreamEvent } from './cli-protocol.js'

/** 回答事件的出口。返回值不等:提示人答卡时它会挂一会儿,而事件流不能跟着停。 */
export type AskEventSink = (event: AskStreamEvent) => void | Promise<void>

export interface RunTurnOptions {
  /**
   * 这一轮**专用**的传输(收场时关掉)。不与发命令的那只共用:HTTP 传输的 `open` 只在连接状态**变了**时报,
   * 第二轮复用同一只就再也等不到它。
   */
  transport: Transport
  sessionId: string
  /** 发这一轮的那条命令(事件流接上之后才调);答 `{ success:false }` 就当场收场。 */
  send: () => Promise<{ success: boolean; error?: string }>
  onEvent?: AskEventSink
  /** 接上事件流最多等多久(缺省 5 秒;等不到也照发,只是可能漏掉最早的几片)。 */
  openTimeoutMs?: number
}

/** 跑一轮:接流 → 发命令 → 折事件 → 收场。 */
export async function runSessionTurn(options: RunTurnOptions): Promise<AskResult> {
  const { transport, sessionId } = options
  const streamId = randomUUID()
  const controller = new AbortController()
  const emit = (event: AskOutputEvent): void => {
    void options.onEvent?.({ streamId, sessionId, event })
  }

  let settle!: (result: AskResult) => void
  let fail!: (error: Error) => void
  const finished = new Promise<AskResult>((resolve, reject) => { settle = resolve; fail = reject })
  const finish = (stopReason: AskResult['stopReason']): void => settle({ streamId, sessionId, stopReason })

  const opened = waitForOpen(transport, options.openTimeoutMs ?? 5_000)
  const pump = (async () => {
    for await (const message of transport.events({ signal: controller.signal })) {
      if (message.name === IPC_CHANNELS.SESSION_STREAM) {
        const payload = message.data as SessionStreamPayload
        if (payload?.sessionId !== sessionId) continue
        const chunk = payload.chunk as { type?: string; text?: string; reasoning?: string }
        if (chunk?.type === 'text-delta') emit({ type: 'text_delta', text: chunk.text ?? '' })
        else if (chunk?.type === 'reasoning-delta') emit({ type: 'reasoning_delta', text: chunk.reasoning ?? '' })
        continue
      }
      if (message.name !== IPC_CHANNELS.SESSION_EVENT) continue
      const envelope = message.data as SessionEventEnvelope
      if (envelope?.sessionId !== sessionId) continue
      if (foldSessionEvent(envelope.event as unknown as Record<string, unknown>, emit, finish)) return
    }
  })()
  void pump.catch(error => {
    if (!controller.signal.aborted) fail(error instanceof Error ? error : new Error(String(error)))
  })

  try {
    await opened.catch(() => undefined)
    const sent = await options.send()
    if (!sent.success) {
      const message = sent.error || 'The backend refused the message'
      emit({ type: 'error', code: 'STREAM_START_FAILED', message })
      throw new Error(message)
    }
    return await finished
  } finally {
    controller.abort()
    transport.close()
    await pump.catch(() => undefined)
  }
}

/**
 * 一条会话事件 → 零或一条输出事件。返回 `true` = 这一轮收场了。
 * 判法与从前 `HeadlessBackend.ask` 那张 `switch` 逐支相同。
 */
function foldSessionEvent(
  event: Record<string, unknown>,
  emit: (event: AskOutputEvent) => void,
  finish: (stopReason: AskResult['stopReason']) => void,
): boolean {
  switch (event.type) {
    case SESSION_EVENT_TYPES.TOOL_CALL: {
      const call = (event.toolCall ?? {}) as { id?: string; toolName?: string; arguments?: unknown }
      emit({ type: 'tool_use', id: String(call.id ?? ''), name: String(call.toolName ?? ''), input: call.arguments })
      return false
    }
    case SESSION_EVENT_TYPES.TOOL_RESULT: {
      const call = (event.toolCall ?? {}) as { id?: string; result?: unknown; error?: unknown; status?: string }
      emit({
        type: 'tool_result',
        id: String(call.id ?? ''),
        content: call.result ?? call.error ?? null,
        isError: call.status === 'failed' || Boolean(call.error),
      })
      return false
    }
    case SESSION_EVENT_TYPES.PERMISSION_REQUEST:
      // 只认发给 CLI 这条通道的卡(CLI 发命令时带 `channel: 'cli'`,引擎据此给卡盖 `targetChannel`)。
      if (event.targetChannel !== 'cli') return false
      emit({
        type: 'permission',
        id: String(event.requestId ?? ''),
        description: String(event.title ?? ''),
        options: ['once', 'session', 'workdir', 'reject'],
      })
      return false
    case SESSION_EVENT_TYPES.STREAM_COMPLETE: {
      const data = (event.data ?? {}) as { aborted?: boolean; error?: unknown; usage?: unknown }
      const stopReason = data.aborted ? 'aborted' : data.error ? 'error' : 'end_turn'
      emit({ type: 'done', stopReason, usage: data.usage })
      finish(stopReason)
      return true
    }
    case SESSION_EVENT_TYPES.STREAM_ERROR: {
      const data = (event.data ?? {}) as { error?: unknown }
      emit({ type: 'error', code: 'STREAM_ERROR', message: String(data.error ?? 'stream error') })
      finish('error')
      return true
    }
    case SESSION_EVENT_TYPES.STREAM_ABORTED:
      emit({ type: 'done', stopReason: 'aborted' })
      finish('aborted')
      return true
    default:
      return false
  }
}

/** 等传输报 `open`;没有这一格的传输视同已接上。 */
function waitForOpen(transport: Transport, timeoutMs: number): Promise<void> {
  if (!transport.onConnectionChange) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('event stream did not open')) }, timeoutMs)
    const off = transport.onConnectionChange!(state => {
      if (state !== 'open') return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}
