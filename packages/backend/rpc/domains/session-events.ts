/**
 * 会话事件日志读取域(主线 E1)—— 轨迹面板的后端半。
 *
 * 只包两件既有的东西:`readSessionEvents`(E0 的读取器)与
 * `resolveToolCallInspection`(E0 的纯投影)。这里**不新建任何投影语义**:
 * 分组、配对、耗时都是消费者的事,事件日志这一侧只交付事实。
 *
 * `inspectCall` 先读整份日志再 resolve —— 而不是在写侧维护一份索引:
 * 事件日志是 append-only 的纯文件,一份索引就是第二份可能说谎的事实。
 */
import type { RpcRouteHandlers } from '../registry.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionAccess } from '../../session/access.js'
import type { SessionEventsRoutes } from '@shared/ipc/session-events.js'
import { resolveToolCallInspection } from '@onething/runtime/sessions/session-events'
import { readSessionEvents, readSessionLogEvents } from '../../session/event-log.js'
import { readSessionBlob } from '../../session/blob-store.js'
// 路径消毒的那道门与轨迹读实现同住一处:S3 之前它是本文件的私有函数,而 S3 把
// 调用点从 2 个变成 4 个 —— 一道安全门有两份拷贝,迟早只改其中一份。
import { isSafeSessionId, readSessionTrace, readSessionTraceResponseText } from '../../session/trace.js'

export const sessionEventsRpcHandlers: RpcRouteHandlers<SessionEventsRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return { events: [] }
    sessionAccess.resolve(context, request.sessionId, 'read')
    return { events: await readSessionEvents(request.sessionId) }
  },
  /**
   * 全集原词汇。`list` 那条在出口按**老七类**再筛一道(`parseSessionEventLog`),
   * 那是轨迹面板的词汇;投影消费者(ui-refold / 未来的 B 期 renderer fold)要的是
   * 账本上真正写着的每一条 —— 折叠器的开张事件(`session/created` / `user/message` /
   * `run/start`)全在七类之外,喂 `list` 折出来必然是空树。
   *
   * 两条读法**共用同一份文件**,分叉只在解码器:这里走 `readSessionLogEvents`
   * (`event-log.ts` 的 v2 全集读法),`list` 一字不动。
   */
  async listRaw(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return { events: [] }
    sessionAccess.resolve(context, request.sessionId, 'read')
    return { events: await readSessionLogEvents(request.sessionId) }
  },
  /**
   * 一段 blob 正文(U2-a0)。**读口本身就是自校验的**(`readSessionBlob` 重算
   * sha256,对不上当读不到),所以这里只做入参消毒:会话 id 走与别的方法同一道门,
   * hash 卡死十六进制 —— 它是路径片段,`../` 之类必须在门口就没了。
   *
   * 读不到不是错误(账本引用的正文可能被清过 / 从别的机器同步过来只有账没有 blob),
   * 交回空对象,调用方照实留占位。
   */
  async readBlob(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return {}
    sessionAccess.resolve(context, request.sessionId, 'read')
    const hash = typeof request?.hash === 'string' ? request.hash : ''
    if (!/^[0-9a-f]{8,128}$/.test(hash)) return {}
    const buffer = readSessionBlob(request.sessionId, hash)
    if (!buffer) return {}
    return { base64: buffer.toString('base64'), bytes: buffer.byteLength }
  },
  async inspectCall(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return { inspection: null }
    sessionAccess.resolve(context, request.sessionId, 'read')
    const callId = typeof request?.callId === 'string' ? request.callId : ''
    if (!callId) return { inspection: null }
    const events = await readSessionEvents(request.sessionId)
    // 找不到就是 null:没有账就是没有账,不抛错、不编。
    return { inspection: resolveToolCallInspection(events, callId) ?? null }
  },
  /**
   * S3 查询面。装配在 core 的纯函数里,这里只做入参消毒 —— 与 `list` 一样,
   * 这个域**不新建任何投影语义**。
   */
  async getTrace(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return { trace: null }
    sessionAccess.resolve(context, request.sessionId, 'read')
    return {
      trace: await readSessionTrace(request.sessionId, {
        ...(typeof request.run === 'string' && request.run ? { run: request.run } : {}),
        ...(request.last !== undefined ? { last: request.last } : {}),
      }),
    }
  },
  async getResponseText(request, context = DESKTOP_RPC_CONTEXT) {
    if (!isSafeSessionId(request?.sessionId)) return { response: null }
    sessionAccess.resolve(context, request.sessionId, 'read')
    const runId = typeof request?.run === 'string' ? request.run : ''
    if (!runId) return { response: null }
    const requestIndex = typeof request?.request === 'number' && Number.isFinite(request.request)
      ? request.request
      : undefined
    return { response: await readSessionTraceResponseText(request.sessionId, runId, requestIndex) }
  },
}
