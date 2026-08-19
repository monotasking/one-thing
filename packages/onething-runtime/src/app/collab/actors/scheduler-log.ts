/**
 * 调度时间轴的**落盘面**(docs/design/collab-v3-observability.md §3.3)。
 *
 * ```
 * <store>/collab/<roomId>/actors/
 *   room.json                       # 真账(同步原子写)
 *   scheduler-log-2026-08-03.jsonl  # 诊断账(普通追加,按日切,保留 14 天)
 * ```
 *
 * ## 两种耐久,刻意不同
 *
 * 房账走 `writeJsonFile`(writeFileSync + renameSync):它必须在下一步动作之前就在
 * 盘上,一次 `kill` 不该在「决定发牌」和「记下发过牌」之间开出窗口。时间轴**不是账**
 * ——它是诊断。掉最后几行的代价是回查少看见几步,而为它每行 fsync 的代价是把一次
 * 磁盘抖动接进调度的关键路径上。所以这里是普通 `appendFileSync`,与转录同级。
 *
 * ## 写失败绝不上抛
 *
 * 观测不能变成第二个故障源:一个写不进去的诊断账让房间停止调度,是把「看不见」
 * 升级成「跑不动」。写失败吞掉 + 每间房 warn 一次(首错闩锁,防刷屏)。
 *
 * ## 轮转
 *
 * 按日切文件、启动时清 14 天前的 —— 与 usage 账本同款做法,不引 DB(仓库纪律:
 * Electron 主进程无 DB)。日期键在纯层派生(`collabSchedulerLogDayKey`),这里只
 * 负责 fs。
 */
import fs from 'node:fs'
import path from 'node:path'

import type { ActorDeadLetter, ActorEvent } from '@onething/core/actors'
import {
  collabSchedulerDeadLetter,
  collabSchedulerErrorLine,
  collabSchedulerLogFileDayKey,
  collabSchedulerLogFileName,
  COLLAB_SCHEDULER_LOG_RETENTION_DAYS,
  formatCollabSchedulerLogLine,
  isCollabSchedulerLogExpired,
  parseCollabSchedulerLogLine,
  type CollabActorVerb,
  type CollabSchedulerLogRow,
  type CollabSchedulerLogSink,
  type CollabSchedulerLogType,
} from '@onething/runtime/collab/actors'

import { getStorePath } from '../../stores/paths.js'
import { collabRoomActorsDir } from './room-account.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.scheduler')


/** 尾读的缺省条数。UI 的「调度」页与 CLI 的 `--tail` 都从它起步。 */
export const COLLAB_SCHEDULER_LOG_TAIL_DEFAULT = 50

/** `<store>/collab/<roomId>/actors/scheduler-log-YYYY-MM-DD.jsonl`。 */
export function collabSchedulerLogPath(roomId: string, ts: number): string {
  return path.join(collabRoomActorsDir(roomId), collabSchedulerLogFileName(ts))
}

export interface CollabSchedulerLogTailOptions {
  limit?: number
  /** 只要这几类。缺席 = 全要。 */
  types?: readonly CollabSchedulerLogType[]
}

/**
 * 时间轴的存取面。
 *
 * 之所以是接口而不是直接调 fs:与房账、agent 账同一个理由 —— 测试与金重放要在
 * **没有磁盘**的前提下跑同一条接线,否则「写入点接对了没有」这件事只能靠真机看。
 */
export interface CollabSchedulerLogStore extends CollabSchedulerLogSink {
  /** 尾读,**新在前**(回查从最近一步往回看,不是从开天辟地往下翻)。 */
  readTail(roomId: string, options?: CollabSchedulerLogTailOptions): CollabSchedulerLogRow[]
}

/* ── 真机:落盘 ───────────────────────────────────────────────────────────── */

/** 写失败的首错闩锁 —— 每间房只喊一次(crash-log 的同款做法)。 */
const warned = new Set<string>()
/** 死信告警的首错闩锁,键是 `<actorId>::<eventType>`(见 `createCollabDeadLetterSink`)。 */
const deadLetterWarned = new Set<string>()

function warnOnce(key: string, message: string, error: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  log.warn('scheduler log write failed', { detail: message }, error)
}

/** 测试收摊用:把两把首错闩锁清空。 */
export function resetCollabSchedulerLogWarnings(): void {
  warned.clear()
  deadLetterWarned.clear()
}

export function createCollabSchedulerLogFileStore(
  options: { now?: () => number } = {},
): CollabSchedulerLogStore {
  const now = options.now ?? Date.now
  return {
    append(roomId: string, row: CollabSchedulerLogRow): void {
      const dir = collabRoomActorsDir(roomId)
      const file = path.join(dir, collabSchedulerLogFileName(row.at || now()))
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(file, `${formatCollabSchedulerLogLine(row)}\n`, 'utf-8')
      } catch (error) {
        warnOnce(`log-write:${roomId}`, `房间 ${roomId} 的调度时间轴写不进去(诊断降级,调度照跑):`, error)
      }
    },
    readTail(roomId: string, tail: CollabSchedulerLogTailOptions = {}): CollabSchedulerLogRow[] {
      const limit = Math.max(0, tail.limit ?? COLLAB_SCHEDULER_LOG_TAIL_DEFAULT)
      if (limit === 0) return []
      const wanted = tail.types && tail.types.length > 0 ? new Set<string>(tail.types) : null
      const dir = collabRoomActorsDir(roomId)
      const rows: CollabSchedulerLogRow[] = []
      // 新的一天在前:攒够 limit 条就不再打开更老的文件(尾读的全部意义)。
      for (const file of listCollabSchedulerLogFiles(dir).reverse()) {
        let text = ''
        try {
          text = fs.readFileSync(path.join(dir, file), 'utf-8')
        } catch {
          continue
        }
        const lines = text.split(/\r?\n/)
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const row = parseCollabSchedulerLogLine(lines[index] ?? '')
          if (!row) continue
          if (wanted && !wanted.has(row.type)) continue
          rows.push(row)
          if (rows.length >= limit) return rows
        }
      }
      return rows
    },
  }
}

/** 目录里的时间轴文件,**按日期升序**。不是时间轴的文件(room.json、信箱)不入列。 */
export function listCollabSchedulerLogFiles(dir: string): string[] {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter(name => collabSchedulerLogFileDayKey(name) !== null)
    .sort()
}

/**
 * 清老:每间房删掉 14 天前的时间轴文件。启动时跑一次。
 *
 * 走**会话目录列表**而不是某本索引:一间被删掉的房连目录一起没了,而一本索引
 * 会留下指向空气的条目 —— 那正是「启动时清老」这件事最不该引入的东西。
 * 返回删掉的文件数(排障与测试读它)。
 */
export function sweepCollabSchedulerLogs(
  options: { now?: number; retentionDays?: number } = {},
): number {
  const now = options.now ?? Date.now()
  const retentionDays = options.retentionDays ?? COLLAB_SCHEDULER_LOG_RETENTION_DAYS
  const collabDir = path.join(getStorePath(), 'collab')
  let removed = 0
  let roomIds: string[] = []
  try {
    roomIds = fs.readdirSync(collabDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return 0
  }
  for (const roomId of roomIds) {
    const dir = collabRoomActorsDir(roomId)
    for (const file of listCollabSchedulerLogFiles(dir)) {
      if (!isCollabSchedulerLogExpired(file, now, retentionDays)) continue
      try {
        fs.rmSync(path.join(dir, file), { force: true })
        removed += 1
      } catch (error) {
        warnOnce(`log-sweep:${roomId}`, `房间 ${roomId} 的旧时间轴清不掉:`, error)
      }
    }
  }
  return removed
}

/* ── 测试与重放:内存 ─────────────────────────────────────────────────────── */

export interface CollabSchedulerLogMemoryStore extends CollabSchedulerLogStore {
  /** 这间房记下的全部行,**旧在前**(写入序)。断言读它。 */
  rows(roomId: string): CollabSchedulerLogRow[]
  clear(): void
}

/** 语义与落盘那一个相同,只是重启之后一切归零(与 room-account 同款模式)。 */
export function createCollabSchedulerLogMemoryStore(): CollabSchedulerLogMemoryStore {
  const byRoom = new Map<string, CollabSchedulerLogRow[]>()
  return {
    append(roomId: string, row: CollabSchedulerLogRow): void {
      const bucket = byRoom.get(roomId) ?? []
      // 走一趟渲染 + 解析:内存 store 与落盘 store 的可见行为因此完全一致 ——
      // 一个只在盘上才丢的字段(undefined、不可序列化)不该在测试里活下来。
      const round = parseCollabSchedulerLogLine(formatCollabSchedulerLogLine(row))
      if (round) bucket.push(round)
      byRoom.set(roomId, bucket)
    },
    readTail(roomId: string, tail: CollabSchedulerLogTailOptions = {}): CollabSchedulerLogRow[] {
      const limit = Math.max(0, tail.limit ?? COLLAB_SCHEDULER_LOG_TAIL_DEFAULT)
      const wanted = tail.types && tail.types.length > 0 ? new Set<string>(tail.types) : null
      const rows = byRoom.get(roomId) ?? []
      const out: CollabSchedulerLogRow[] = []
      for (let index = rows.length - 1; index >= 0 && out.length < limit; index -= 1) {
        const row = rows[index]
        if (!row) continue
        if (wanted && !wanted.has(row.type)) continue
        out.push(row)
      }
      return out
    },
    rows(roomId: string): CollabSchedulerLogRow[] {
      return [...(byRoom.get(roomId) ?? [])]
    },
    clear(): void {
      byRoom.clear()
    },
  }
}

/* ── 死信:从环到闭环(D8 §3.4)──────────────────────────────────────────── */

/**
 * 一封信寻址到哪间房 —— 时间轴是按房落盘的,没有房就没有归档处。
 *
 * `agent:note` 这一类信身上没有 roomId,它们只留计数与告警:硬塞进某间房的账,
 * 回查时会看见一条根本不属于那间房的失败,那比看不见更糟。
 */
export function collabDeadLetterRoomId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const roomId = (payload as { roomId?: unknown }).roomId
  return typeof roomId === 'string' && roomId.length > 0 ? roomId : undefined
}

export interface CollabDeadLetterSinkOptions {
  /** `room:<id>` / `agent:<id>`。进账、进告警的署名。 */
  actorId: string
  /** 房间自己的信全归它;agent 的信按 payload 里的 roomId 归档。 */
  roomId?: string
  log: CollabSchedulerLogSink
  /** 首错闩锁。缺省用模块级那一把(进程内全局,与 crash-log 同款)。 */
  warned?: Set<string>
  /** 告警出口。缺省 `collab.scheduler` 的 `log.warn`。 */
  warn?: (message: string) => void
}

/**
 * 死信的**三路出口**(蓝图 §3.4)。
 *
 * 死信在 D8 之前是一个**没有消费者**的内存环:一封信炸了,循环继续跑(那是对的
 * ——一封坏信不该让这个 agent 从此聋掉),而系统静默地变哑。用户看到的是「它没
 * 回应」,真相是「它试过但炸了」,两者在界面上完全无法区分 —— 这是「抓瞎」最大
 * 的一处来源。
 *
 * 三路各管一件事,谁都不兼职:
 *  1. **计数** —— ActorBase 自己的环长(`actor.deadLetterCount`),快照读它。这个
 *     函数**一个字都不记** —— 另立一本计数表就是第二本会漂的账。环有容量上限,
 *     所以那个数是「此刻还翻得出来的坏信数」,而诊断要的恰恰是它。
 *  2. **详情** —— 进调度时间轴,带 actor / 事件类型 / 错误首行。落盘,重启还在。
 *  3. **告警** —— `console.warn` 一次(每 actor × 每类事件),给的是「有这么回事、
 *     去看时间轴」,不是全部信息。一封坏信通常不是一次意外:同类会一封接一封地
 *     炸,而一条刷屏的 warn 把真正的第一现场推出滚动窗口。
 *
 * **不自动重放**:重放语义由各 actor 的幂等层兜,人工诊断后重启自愈。
 */
export function createCollabDeadLetterSink(
  options: CollabDeadLetterSinkOptions,
): (deadLetter: ActorDeadLetter<ActorEvent<CollabActorVerb>>) => void {
  const latch = options.warned ?? deadLetterWarned
  const warn = options.warn ?? ((message: string) => { log.warn('collab dead letter', { detail: message }) })
  return deadLetter => {
    const eventType = deadLetter.event.type
    const roomId = options.roomId ?? collabDeadLetterRoomId(deadLetter.event.payload)
    const line = collabSchedulerErrorLine(deadLetter.error)
    if (roomId) {
      options.log.append(roomId, collabSchedulerDeadLetter({
        at: deadLetter.at,
        actor: options.actorId,
        eventType,
        error: line,
        triggeredBy: deadLetter.event.id,
      }))
    }
    const key = `${options.actorId}::${eventType}`
    if (latch.has(key)) return
    latch.add(key)
    warn(
      `[collab-v3] ${options.actorId} 处理 ${eventType} 失败(已进死信,循环继续;同类只报这一次):${line}`,
    )
  }
}

/* ── 默认实例(UI / CLI 的读口)────────────────────────────────────────────── */

let defaultStore: CollabSchedulerLogStore | null = null

function sharedStore(): CollabSchedulerLogStore {
  defaultStore ??= createCollabSchedulerLogFileStore()
  return defaultStore
}

/**
 * 尾读一间房的调度时间轴,**新在前**。
 *
 * 读账文件、不经运行时 —— app 挂了也能查,而抓瞎最惨的时刻恰恰是进程不对劲的时刻。
 */
export function readCollabSchedulerLogTail(
  roomId: string,
  options: CollabSchedulerLogTailOptions = {},
): CollabSchedulerLogRow[] {
  return sharedStore().readTail(roomId, options)
}
