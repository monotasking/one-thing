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
import type { RouteHandlers } from '@onething/core/ipc'
import type { SessionEventsRoutes } from '@shared/ipc/session-events.js'
import { resolveToolCallInspection } from '@onething/runtime/sessions/session-events'
import { readSessionEvents } from '../../session/event-log.js'
// 路径消毒的那道门与轨迹读实现同住一处:S3 之前它是本文件的私有函数,而 S3 把
// 调用点从 2 个变成 4 个 —— 一道安全门有两份拷贝,迟早只改其中一份。
import { isSafeSessionId, readSessionTrace, readSessionTraceResponseText } from '../../session/trace.js'

export const sessionEventsRpcHandlers: RouteHandlers<SessionEventsRoutes> = {
  async list(request) {
    if (!isSafeSessionId(request?.sessionId)) return { events: [] }
    return { events: await readSessionEvents(request.sessionId) }
  },
  async inspectCall(request) {
    if (!isSafeSessionId(request?.sessionId)) return { inspection: null }
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
  async getTrace(request) {
    if (!isSafeSessionId(request?.sessionId)) return { trace: null }
    return {
      trace: await readSessionTrace(request.sessionId, {
        ...(typeof request.run === 'string' && request.run ? { run: request.run } : {}),
        ...(request.last !== undefined ? { last: request.last } : {}),
      }),
    }
  },
  async getResponseText(request) {
    if (!isSafeSessionId(request?.sessionId)) return { response: null }
    const runId = typeof request?.run === 'string' ? request.run : ''
    if (!runId) return { response: null }
    const requestIndex = typeof request?.request === 'number' && Number.isFinite(request.request)
      ? request.request
      : undefined
    return { response: await readSessionTraceResponseText(request.sessionId, runId, requestIndex) }
  },
}

