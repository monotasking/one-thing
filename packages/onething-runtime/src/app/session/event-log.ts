/**
 * 会话事件日志的写入口与读取器(主线 E0)。
 *
 * 落在既有的 per-session 目录里:`sessions/<id>/events.jsonl`,与 `meta.json`、
 * `messages.jsonl` 并排。纯增量,永不改写,**不动 messages.jsonl 的任何读路径**。
 *
 * 三条实现约束:
 * - **保序**:seq 在调用的那一刻同步分配,落盘走每会话一条 promise 链。
 *   IO 再怎么被调度,文件里的顺序恒等于调用顺序。
 * - **不阻塞热路径**:append 是 fire-and-forget,调用方拿到 seq 就走。
 * - **自吞异常**:记账失败绝不能影响聊天。任何错误在这里被吃掉,每会话最多
 *   warn 一次。
 *
 * 类型与纯编解码在产品层(`@onething/runtime/sessions/session-events`);
 * 这里只负责路径、文件、计数器与队列。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  encodeSessionEventLine,
  findLastSessionEventInLog,
  parseSessionEventLog,
  scanSessionEventLogCounters,
  type SessionEventDataFor,
  type SessionEventRecord,
  type SessionEventType,
} from '@onething/runtime/sessions/session-events'
import { getSessionsDir } from '../stores/paths.js'

export const SESSION_EVENTS_LOG_FILENAME = 'events.jsonl'

interface SessionEventLogState {
  /** false = 这个会话不记事件(legacy 整文件格式),见 resolveEnabled。 */
  enabled: boolean
  lastSeq: number
  lastRequestIndex: number
  /** 每会话一条写入链:保证落盘顺序 == 调用顺序。 */
  queue: Promise<void>
  warned: boolean
}

const states = new Map<string, SessionEventLogState>()

function sessionDirPath(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId)
}

export function getSessionEventsLogPath(sessionId: string): string {
  return path.join(sessionDirPath(sessionId), SESSION_EVENTS_LOG_FILENAME)
}

/**
 * **事件日志只往已经存在的会话目录里追加,自己从不创建会话目录。**
 *
 * 这一条同时挡住三件事:
 * - legacy 整文件格式的会话(`sessions/<id>.json` 还没惰性迁移)天然没有目录,
 *   于是本期自动跳过 —— 而且绝不会凭空给它建一个 `sessions/<id>/`。那会让
 *   storage-driver 的 `jsonlExists()` 误判成"已经是 jsonl 会话",整份历史当场
 *   消失。
 * - 任何一个还没被会话存储写下来的 id(测试里的假会话、串错的 id)都打不穿
 *   store,不会在 `~/.onething/sessions/` 里凿出一个只有 events.jsonl 的孤儿
 *   目录。
 * - 记账因此永远是"会话目录里的一份附加账本",而不是一条能自己造会话的旁路。
 *
 * 代价说清楚:一个刚创建、meta.json 还没落盘的新会话,若在那 300ms 节流窗口内
 * 就发出了第一次请求,窗口内的这几条事件会丢。目录一出现,后续 append 自动
 * 接上;丢掉的不补记 —— 补记就是伪造时刻。
 *
 * stat 成本:已 enabled 的会话之后零 stat;还没 enabled 的会话每次 append 重查
 * 一次目录(一次 existsSync),换来"目录出现即接上"——协作/调度这类创建即发言的
 * 程序化会话,以及运行期才被惰性迁移成 jsonl 的老会话,都不用等下次启动。
 */
function resolveEnabled(sessionId: string): boolean {
  return fs.existsSync(sessionDirPath(sessionId))
}

/** 若目录已出现则就地启用:恢复计数器,从此零 stat。失败保持 disabled。 */
function tryEnable(state: SessionEventLogState, sessionId: string): void {
  try {
    if (!resolveEnabled(sessionId)) return
    // 启用时从既有文件恢复计数器:同一会话跨重启继续单调递增。
    const logPath = getSessionEventsLogPath(sessionId)
    if (fs.existsSync(logPath)) {
      const counters = scanSessionEventLogCounters(fs.readFileSync(logPath, 'utf8'))
      if (counters.lastSeq > state.lastSeq) state.lastSeq = counters.lastSeq
      if (counters.lastRequestIndex > state.lastRequestIndex) {
        state.lastRequestIndex = counters.lastRequestIndex
      }
    }
    state.enabled = true
  } catch {
    // 保持 disabled,下次 append 再试。
  }
}

function ensureState(sessionId: string): SessionEventLogState {
  const existing = states.get(sessionId)
  if (existing) {
    if (!existing.enabled) tryEnable(existing, sessionId)
    return existing
  }

  const state: SessionEventLogState = {
    enabled: false,
    lastSeq: 0,
    lastRequestIndex: 0,
    queue: Promise.resolve(),
    warned: false,
  }
  tryEnable(state, sessionId)
  states.set(sessionId, state)
  return state
}

function warnOnce(state: SessionEventLogState, sessionId: string, error: unknown): void {
  if (state.warned) return
  state.warned = true
  console.warn(`[SessionEvents] event log write failed for ${sessionId}:`, error)
}

/**
 * 追加一条事件。返回分配到的 seq(会话不记账时返回 undefined)。
 * 调用方拿 seq 做因果引用(`tool/result.sourceSeq`)。
 */
export function appendSessionEvent<TType extends SessionEventType>(
  sessionId: string,
  type: TType,
  data: SessionEventDataFor<TType>,
): number | undefined {
  let state: SessionEventLogState
  try {
    state = ensureState(sessionId)
  } catch {
    return undefined
  }
  if (!state.enabled) return undefined

  const seq = state.lastSeq + 1
  state.lastSeq = seq
  const record = { seq, time: Date.now(), type, data } as SessionEventRecord
  const line = encodeSessionEventLine(record)

  state.queue = state.queue
    .then(async () => {
      // 目录必然已经存在(resolveEnabled 是这么判的);这里只 append,
      // 刻意不 mkdir —— 少一条能造目录的路,就少一种打穿 store 的方式。
      await fs.promises.appendFile(getSessionEventsLogPath(sessionId), line, 'utf8')
    })
    .catch(error => {
      warnOnce(state, sessionId, error)
    })

  return seq
}

/** 分配下一个 requestIndex(会话内单调递增,跨重启从文件恢复)。 */
export function nextSessionRequestIndex(sessionId: string): number | undefined {
  let state: SessionEventLogState
  try {
    state = ensureState(sessionId)
  } catch {
    return undefined
  }
  if (!state.enabled) return undefined
  state.lastRequestIndex += 1
  return state.lastRequestIndex
}

/**
 * 同步取回该会话日志里某类型的最后一条记录。
 *
 * 给"要不要写"这类必须**同步**作答的判定用(seq 是同步分配的,一旦让判定
 * 走异步,事件顺序就会乱)。调用方自己缓存结果 —— 这里每次都真读文件。
 */
export function findLastSessionEventSync<TType extends SessionEventType>(
  sessionId: string,
  type: TType,
): Extract<SessionEventRecord, { type: TType }> | undefined {
  try {
    const logPath = getSessionEventsLogPath(sessionId)
    if (!fs.existsSync(logPath)) return undefined
    return findLastSessionEventInLog(fs.readFileSync(logPath, 'utf8'), type)
  } catch {
    return undefined
  }
}

/** 等待该会话(或全部会话)的在途写入落盘。测试与关停用。 */
export async function flushSessionEventLog(sessionId?: string): Promise<void> {
  if (sessionId) {
    await states.get(sessionId)?.queue
    return
  }
  await Promise.all([...states.values()].map(state => state.queue))
}

/**
 * 读回整份事件日志。容忍崩溃截断的尾部半行(丢弃那一行,前面照常读出)。
 * 文件不存在 = 这个会话没有事件,返回空数组,不是错误。
 */
export async function readSessionEvents(sessionId: string): Promise<SessionEventRecord[]> {
  try {
    const text = await fs.promises.readFile(getSessionEventsLogPath(sessionId), 'utf8')
    return parseSessionEventLog(text)
  } catch {
    return []
  }
}

/** 清空进程内缓存(计数器 / 队列)。仅测试用。 */
export function resetSessionEventLogCache(): void {
  states.clear()
}
