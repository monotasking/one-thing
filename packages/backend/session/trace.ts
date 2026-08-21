/**
 * 轨迹的**读**实现(S3,§12)。装配在 core(纯),这里只负责"从哪拿事件"。
 *
 * 两条取事件的路,判据只有一个:**这条会话的活投影已经在内存里了吗**。
 *
 *  - 在(引擎正跑着它 / 刚读过一页)→ 响应正文直接从活投影取:那份 state 已经
 *    把 chunks 折好了,再读一遍文件是白花的;
 *  - 不在 → 读文件。**绝不主动去建活投影**:`getLiveSessionProjection` 的第一
 *    步是 `prepareSessionEventsOnce`(它会为上次进程死亡留下的未闭合 run 补写
 *    `run/end`)—— 那是一次**写**。一个只读的查询面把它触发了,就等于"看一眼
 *    轨迹改了账本",而 CLI / HTTP 这两个出口随时可能在别的进程里跑。
 *
 * 永远不读 `session.messages`:轨迹的事实在 `events.jsonl` 里,消息是它的另一
 * 种投影。从消息倒推轨迹会得到一棵看上去很像、但少了重试与错误的树。
 */

import {
  assembleSessionTrace,
  materializeTraceResponseText,
  traceResponseTextFromProjection,
  type SessionTrace,
  type SessionTraceResponseText,
} from '@onething/core/session'
import { readSessionLogEvents } from './event-log.js'
import { getLiveSessionProjection, hasLiveSessionProjection } from './projection-cache.js'

export interface ReadSessionTraceOptions {
  /** 只要这一组(`SessionTraceRun.key`,真 runId 也认)。 */
  run?: string
  /** 只要最后 N 组。`true` = 1。与 `run` 同时给时 `run` 优先。 */
  last?: number | boolean
}

/**
 * 会话 id 直接进 `path.join(getSessionsDir(), sessionId)`。
 *
 * 信封里的这个字符串在 server 上来自开放网络,`../../` 能把读取器指到会话库
 * 之外的任意 `events.jsonl`。会话 id 本来就是 uuid 形态,这里只放行"不含路径
 * 分隔符、不是 `.`/`..`"的名字 —— 与 `media://` 协议对文件名的处理同一条纪律。
 *
 * 它从 `rpc/domains/session-events.ts` 搬到这里(S3):调用点从 2 个变成 4 个,
 * 而一道安全门有两份拷贝,迟早只改其中一份。
 */
export function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (value === '.' || value === '..') return false
  return !/[/\\]/.test(value) && !value.includes('\0')
}

function normalizeLast(last: number | boolean | undefined): number | undefined {
  if (last === undefined || last === false) return undefined
  if (last === true) return 1
  return Number.isFinite(last) && last > 0 ? Math.floor(last) : undefined
}

/** 一条会话的轨迹树。没有事件日志 = 一棵空树,不是错误。 */
export async function readSessionTrace(
  sessionId: string,
  options: ReadSessionTraceOptions = {},
): Promise<SessionTrace> {
  const events = await readSessionLogEvents(sessionId)
  const last = normalizeLast(options.last)
  return assembleSessionTrace(events, {
    sessionId,
    ...(options.run ? { run: options.run } : {}),
    ...(last !== undefined ? { last } : {}),
  })
}

/**
 * 一次请求的响应正文(按需 materialize —— 树上永远没有它)。
 *
 * `requestIndex` 缺席 = 整个 run 的正文。
 */
export async function readSessionTraceResponseText(
  sessionId: string,
  runId: string,
  requestIndex?: number,
): Promise<SessionTraceResponseText> {
  if (hasLiveSessionProjection(sessionId)) {
    return traceResponseTextFromProjection(
      getLiveSessionProjection(sessionId),
      runId,
      requestIndex,
    )
  }
  return materializeTraceResponseText(await readSessionLogEvents(sessionId), runId, requestIndex)
}
