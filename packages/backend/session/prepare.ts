/**
 * 冷加载收尾合成(S2a,§11.1;§3.1 采纳的 `prepare` 阶段)。
 *
 * 进程被杀掉的那一刻,日志里留下的是一条**没有 `run/end` 的 `run/start`**,
 * 可能还带着几个没有 `tool/result` 的 `tool/call`。投影照实读的结果是"那条
 * 助手消息永远在生成中、那个工具永远在跑" —— 事实确实如此,只是没人再来收尾。
 * `prepare` 就是那个来收尾的人:打开会话时把未闭合的 run 合成掉。
 *
 * ## 三条纪律
 *
 * 1. **只提交一次**。合成的 `run/end` 落盘之后,第二次 prepare 看到的是一条
 *    已闭合的 run —— 幂等不是靠标记位,是靠事件本身(账本的自然性质)。
 * 2. **两种读模式都跑**。`messages` 模式下它只补事件账本、不动消息
 *    (那边仍由 `sanitizeSessionOnStartup` 管),所以默认行为一字不变。
 * 3. **不碰活着的 run**。靠的不是运行时判断,而是**调用点**:三个入口
 *    (`appendSurfaceAwareEvent` 的开头、`beginSessionRun` 的开头、活投影第一次
 *    建起来之前)都排在这条会话的任何一次执行**之前**,而
 *    `prepareSessionEventsOnce` 每进程每会话只真的跑一次。
 *    等到有 run 活着的时候,这条会话早已 prepare 过了。这样 prepare 就不必反过来
 *    依赖 run 登记处 —— 那条依赖会把它拖进 `runs → shadow → reads` 那个环里。
 *
 *    §13.10 M6:第一个入口是本期补的,而且它才是那条硬口径 ——
 *    **这个进程往这份账本写第一个字之前**。从前只有后两个,于是崩溃重开之后
 *    用户说的第一句话(`handleSendMessage` 先 `store.addMessage` 才
 *    `beginSessionRun`)排在合成的收尾**前面**:真机读到
 *    `tool/call | user/message | tool/result(interrupted) | run/end`。
 *    内容一直是对的(结局按 callId / runId 归位,与物理位置无关),错的是次序,
 *    而次序正是历史按回合切段时要看的东西。
 *
 * ## 为什么是**尾部**扫描而不是全量
 *
 * 一次进程死亡只会留下**它最后那条** run 未闭合,而 prepare 在每次打开会话时
 * 都跑,所以窗口只需覆盖近期历史。全量扫描等于每次开会话都读一遍整份日志
 * (48MB 级会话上这正是 §3.2 拒绝的那件事)。倒读因此在**第一条完整闭合的
 * run**(先遇 `run/end`、后遇它自己的 `run/start`,且此刻没有开着的 run)处收手,
 * 另有一道 4MB 的硬窗口兜底。窗口之外万一真有更老的未闭合 run,
 * `bun run sessions:verify` 会**全量**扫出来并报告 —— 不会静默丢掉。
 *
 * 关闸:`ONETHING_SESSION_PREPARE=0`。
 */

import fs from 'node:fs'
import {
  CORE_INTERRUPTED_TOOL_ERROR,
  scanEventsBackward,
  type SessionEventByteReader,
  type SessionLogEventRecord,
} from '@onething/core/session'
import { appendSurfaceAwareEvent } from './event-surface.js'
import { getSessionEventsLogPath, isSessionEventLogEnabled } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.events')


/** 尾部扫描窗口(见文件头的理由)。 */
const PREPARE_TAIL_BYTES = 4 * 1024 * 1024

/**
 * 合成的中断结果给模型看的那句话。
 *
 * R-a(§13.6):它现在是**三处共用**的那一个常量(`core/session/interrupted.ts`)——
 * 消息侧的崩溃修复(`computeInterruptedStepRepair`)与投影的
 * `lingeringToolError` 说的是同一句话,不再各写各的。
 */
const INTERRUPTED_RESULT_TEXT = CORE_INTERRUPTED_TOOL_ERROR

export interface PrepareSessionEventsResult {
  status: 'disabled' | 'no-events' | 'clean' | 'repaired'
  /** 合成了收尾的 run 数。 */
  runs: number
  /** 合成的 aborted `tool/result` 数。 */
  toolResults: number
  /** 扫描停在哪:读到头 / 一条完整闭合的 run / 4MB 硬窗口。 */
  stoppedAt: 'head' | 'closed-run' | 'window'
  /** 硬窗口截断了扫描 = 更老的历史没看过(`sessions:verify` 会全量看)。 */
  truncatedScan: boolean
}

const prepared = new Set<string>()

/**
 * 本进程已经由 prepare 收掉的 run。
 *
 * 为什么不能只靠"再读一遍文件":合成出来的 `run/end` 是**排队异步**落盘的
 * (写入口保序但不同步),所以紧接着的第二次扫描很可能仍然看到那条 run 开着,
 * 于是又合成一遍 —— 同一个 runId 两条 `run/end`。账本的幂等由事件本身保证,
 * 但那是**跨进程**的口径;进程内还得记得自己刚做过什么。
 */
const closedRuns = new Map<string, Set<string>>()

export function isSessionPrepareEnabled(): boolean {
  return process.env.ONETHING_SESSION_PREPARE !== '0'
}

/** 会话删除 / 测试:忘掉"这条会话已经 prepare 过了"。 */
export function resetSessionPrepareCache(sessionId?: string): void {
  if (sessionId) {
    prepared.delete(sessionId)
    closedRuns.delete(sessionId)
    return
  }
  prepared.clear()
  closedRuns.clear()
}

/**
 * 每进程每会话最多真的跑一次(打开会话的那一次)。热路径上第二次起是一次
 * `Set.has`。
 */
export function prepareSessionEventsOnce(sessionId: string): void {
  if (prepared.has(sessionId)) return
  prepared.add(sessionId)
  try {
    prepareSessionEvents(sessionId)
  } catch (error) {
    log.warn('session events prepare failed', { sessionId }, error)
  }
}

interface OpenRunState {
  runId: string
  startSeq: number
  calls: Array<{ callId: string; seq: number }>
  results: Set<string>
}

export function prepareSessionEvents(sessionId: string): PrepareSessionEventsResult {
  const empty: PrepareSessionEventsResult = { status: 'no-events', runs: 0, toolResults: 0, stoppedAt: 'head', truncatedScan: false }
  if (!isSessionPrepareEnabled()) return { ...empty, status: 'disabled' }
  if (!isSessionEventLogEnabled(sessionId)) return empty

  let fd: number | undefined
  let scan: ReturnType<typeof scanUnclosedRuns>
  try {
    const logPath = getSessionEventsLogPath(sessionId)
    const size = fs.statSync(logPath).size
    if (size === 0) return empty
    fd = fs.openSync(logPath, 'r')
    scan = scanUnclosedRuns(byteReader(fd, size), size)
  } catch {
    return empty
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }

  const alreadyClosed = closedRuns.get(sessionId)
  const open = alreadyClosed ? scan.open.filter(run => !alreadyClosed.has(run.runId)) : scan.open
  if (open.length === 0) {
    return { status: 'clean', runs: 0, toolResults: 0, stoppedAt: scan.stoppedAt, truncatedScan: scan.stoppedAt === 'window' }
  }

  let toolResults = 0
  // 老的先收 —— 事件是一条时间线,合成出来的收尾也该按它原来的先后落账。
  for (const run of [...open].sort((a, b) => a.startSeq - b.startSeq)) {
    for (const call of run.calls) {
      if (run.results.has(call.callId)) continue
      appendSurfaceAwareEvent(sessionId, 'tool/result', {
        callId: call.callId,
        isError: true,
        resultPreview: INTERRUPTED_RESULT_TEXT,
        result: { text: INTERRUPTED_RESULT_TEXT },
        sourceSeq: call.seq,
        runId: run.runId,
      })
      toolResults += 1
    }
    appendSurfaceAwareEvent(sessionId, 'run/end', { runId: run.runId, outcome: 'interrupted' })
    const closed = closedRuns.get(sessionId) ?? new Set<string>()
    closed.add(run.runId)
    closedRuns.set(sessionId, closed)
  }

  // 合成的事件已经进了写入口那条尾巴(`drainSessionLogEventTail`),活投影
  // 第一次建起来时会连同文件里的那份一起折进去(按 seq 去重);跳转索引按
  // 文件长度自失效。所以这里什么缓存都不必碰。

  return {
    status: 'repaired',
    runs: open.length,
    toolResults,
    stoppedAt: scan.stoppedAt,
    truncatedScan: scan.stoppedAt === 'window',
  }
}

function byteReader(fd: number, size: number): SessionEventByteReader {
  return {
    size,
    read(position, length) {
      const start = Math.max(0, Math.min(position, size))
      const wanted = Math.max(0, Math.min(length, size - start))
      if (wanted === 0) return new Uint8Array(0)
      const buffer = Buffer.allocUnsafe(wanted)
      const read = fs.readSync(fd, buffer, 0, wanted, start)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
    },
  }
}

/**
 * 倒读尾部窗口,找出"有 `run/start` 没有 `run/end`"的那些 run 及其未结的调用。
 *
 * 倒读的顺序天然有利:`run/end` 一定晚于它的 `run/start`,`tool/result` 一定
 * 晚于它的 `tool/call` —— 所以倒着读时,收尾的那一条**先**到,遇到开头那条时
 * 已经知道它闭没闭。
 */
export function scanUnclosedRuns(
  reader: SessionEventByteReader,
  size: number,
  windowBytes = PREPARE_TAIL_BYTES,
): { open: OpenRunState[]; stoppedAt: 'head' | 'closed-run' | 'window' } {
  const endedRuns = new Set<string>()
  const openByRun = new Map<string, OpenRunState>()
  const resultsByRun = new Map<string, Set<string>>()
  const callsByRun = new Map<string, Array<{ callId: string; seq: number }>>()
  const floor = Math.max(0, size - windowBytes)
  let stoppedAt: 'head' | 'closed-run' | 'window' = 'head'

  const resultsOf = (runId: string): Set<string> => {
    const existing = resultsByRun.get(runId)
    if (existing) return existing
    const created = new Set<string>()
    resultsByRun.set(runId, created)
    return created
  }
  const callsOf = (runId: string): Array<{ callId: string; seq: number }> => {
    const existing = callsByRun.get(runId)
    if (existing) return existing
    const created: Array<{ callId: string; seq: number }> = []
    callsByRun.set(runId, created)
    return created
  }

  scanEventsBackward(reader, {}, ({ record, offset }) => {
    if (offset < floor) {
      stoppedAt = 'window'
      return true
    }
    apply(record)
    // 倒着走完一条**完整闭合**的 run(先遇它的 run/end、现在遇到它的 run/start)
    // 就收手:此刻手上那些开着的 run 已经各自扫全了(它们的 tool/call 都晚于
    // 自己的 run/start),而再往前是**上一次打开会话之前**的历史 —— 那时的
    // prepare 已经收过尾。更老的残留由 `sessions:verify` 全量扫出来。
    if (record.type === 'run/start' && endedRuns.has(record.data.runId)) {
      stoppedAt = 'closed-run'
      return true
    }
    return undefined
  })

  function apply(record: SessionLogEventRecord): void {
    switch (record.type) {
      case 'run/end':
        endedRuns.add(record.data.runId)
        return
      case 'run/start': {
        if (endedRuns.has(record.data.runId)) return
        openByRun.set(record.data.runId, {
          runId: record.data.runId,
          startSeq: record.seq,
          calls: callsOf(record.data.runId),
          results: resultsOf(record.data.runId),
        })
        return
      }
      case 'tool/result':
        if (record.data.runId) resultsOf(record.data.runId).add(record.data.callId)
        return
      case 'tool/call':
        if (record.data.runId) callsOf(record.data.runId).push({ callId: record.data.callId, seq: record.seq })
        return
      default:
    }
  }

  for (const run of openByRun.values()) {
    // 倒读时调用是倒着攒的,合成的结果要按调用的先后落账。
    run.calls.sort((a, b) => a.seq - b.seq)
  }
  return { open: [...openByRun.values()], stoppedAt }
}
