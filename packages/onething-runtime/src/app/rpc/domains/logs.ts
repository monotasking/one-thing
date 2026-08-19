/**
 * 渲染进程日志上行(logging L3,docs/design/logging-system-2026-08.md §2.5)。
 *
 * 收到的每一条都直接喂**同一个根 logger** —— 不另开文件、不另起格式:
 * 渲染侧的记录与主进程的记录在 `app.jsonl` / `server.jsonl` 里长得一模一样,
 * 差别只有三处盖章:`ns` 前缀 `renderer.`、`src='renderer'`、
 * `fields.transport`(以及 http 面上的 owner/workspace)。
 *
 * 为什么盖章由收方做而不是发方声明:`src` 与身份是**信任级**的字段,
 * 而信封是跨进程来的、在 server 面上更是跨网络来的。发方说自己是谁不算数。
 */
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import {
  MAX_LOG_MSG_LENGTH,
  MAX_LOG_RECORDS_PER_APPEND,
  type AppendLogRecord,
  type AppendLogsRequest,
  type AppendLogsResponse,
  type LogConfigResponse,
  type LogsRoutes,
} from '@shared/ipc/logs.js'
import { isLogLevel, type LogRecord } from '@onething/core/logging'
import { getLogLevelSpec, getRootLogger } from '../../logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'

const RENDERER_NS_PREFIX = 'renderer.'

/** 命名空间只留点分标识符 —— 它进的是过滤器的键,不该是任意字符串。 */
function normalizeNs(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '')
  if (!cleaned) return 'renderer'
  return cleaned.startsWith(RENDERER_NS_PREFIX) || cleaned === 'renderer'
    ? cleaned
    : `${RENDERER_NS_PREFIX}${cleaned}`
}

function normalizeMsg(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : String(raw ?? '')
  return value.length > MAX_LOG_MSG_LENGTH
    ? `${value.slice(0, MAX_LOG_MSG_LENGTH)}… [truncated]`
    : value
}

function normalizeFields(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw as Record<string, unknown>)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeErr(raw: AppendLogRecord['err']): LogRecord['err'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const name = typeof raw.name === 'string' ? raw.name : 'Error'
  const message = typeof raw.message === 'string' ? raw.message : ''
  if (!message && !raw.stack) return undefined
  return {
    name,
    message,
    ...(typeof raw.stack === 'string' ? { stack: raw.stack } : {}),
  }
}

/** 谁在说话 —— 由**宿主适配器**给的 context 推,不读信封里的任何字段。 */
function callerFields(context: RpcDispatchContext): Record<string, unknown> {
  return {
    transport: context.transport,
    ...(context.ownerUid ? { ownerUid: context.ownerUid } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
  }
}

export const logsRpcHandlers: RpcRouteHandlers<LogsRoutes> = {
  async append(
    request: AppendLogsRequest,
    context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
  ): Promise<AppendLogsResponse> {
    const root = getRootLogger()
    const incoming = Array.isArray(request?.records) ? request.records : []
    const accepted: AppendLogRecord[] = incoming.slice(0, MAX_LOG_RECORDS_PER_APPEND)
    let rejected = incoming.length - accepted.length
    const caller = callerFields(context)
    const now = Date.now()

    let written = 0
    for (const record of accepted) {
      if (!record || typeof record !== 'object' || !isLogLevel(record.level)) {
        rejected += 1
        continue
      }
      const fields = normalizeFields(record.fields)
      const err = normalizeErr(record.err)
      root.emit({
        time: typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : now,
        level: record.level,
        ns: normalizeNs(record.ns),
        msg: normalizeMsg(record.msg),
        src: 'renderer',
        fields: { ...fields, ...caller },
        ...(err ? { err } : {}),
      })
      written += 1
    }

    // 渲染侧丢过东西就得留痕 —— 静悄悄的背压等于没有背压。
    const dropped = typeof request?.dropped === 'number' && request.dropped > 0 ? request.dropped : 0
    if (dropped > 0) {
      root.emit({
        time: now,
        level: 'warn',
        ns: 'renderer.log',
        msg: 'renderer log records dropped by backpressure',
        src: 'renderer',
        fields: { dropped, ...caller },
      })
    }

    return { accepted: written, rejected }
  },

  /**
   * 单向下发:主进程生效的等级 spec。渲染侧的 hub 装好之后拉一次,把它当默认,
   * localStorage(`onething:log`)仍然是本地覆写。
   *
   * 为什么是**拉**而不是推:渲染进程可能比 `configureLogging()` 晚起、也可能重载,
   * 推一次要处理"推的时候没人听"的窗口;拉一次没有这个窗口。
   */
  async config(): Promise<LogConfigResponse> {
    return { levelSpec: getLogLevelSpec() }
  },
}
