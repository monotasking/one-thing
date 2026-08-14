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
import {
  sessionEventsRouter,
  type SessionEventsRoutes,
} from '@shared/ipc/session-events.js'
import { resolveToolCallInspection } from '@onething/runtime/sessions/session-events'
import { readSessionEvents } from '../../session/event-log.js'
import { registerRouterHandlers } from '../registry.js'

/**
 * sessionId 直接进了 `path.join(getSessionsDir(), sessionId)`。
 *
 * 信封里的这个字符串在 server 上来自开放网络,`../../` 能把读取器指到会话库
 * 之外的任意 `events.jsonl`。会话 id 本来就是 uuid 形态,这里只放行"不含路径
 * 分隔符、不是 `.`/`..`"的名字 —— 与 `media://` 协议对文件名的处理同一条纪律。
 */
function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (value === '.' || value === '..') return false
  return !/[/\\]/.test(value) && !value.includes('\0')
}

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
}

export function registerSessionEventsRpcDomain(): () => void {
  return registerRouterHandlers(sessionEventsRouter, sessionEventsRpcHandlers)
}
