/**
 * 房间费用闸 (§6.2 第三道闸) — R2 split out of the coordinator.
 *
 * A room's daily spend, summed from the usage ledger over a SESSION SET (the
 * room, every work session its board ever spawned, and — since W18 — every
 * member's execution session). Deliberately not the W13.3 usageSource labels:
 * the set already covers turns that predate the labels and turns nobody
 * labelled (retries, compaction, titles).
 */
import {
  COLLAB_DEFAULT_DAILY_COST_USD,
  collabAgentSessionIdsForScan,
} from '@onething/runtime/collab'
import * as store from '../store.js'
import { getUsageLedger } from '../usage/index.js'
import { loadCollabBoard } from './board-store.js'
import { postSystemLine } from './room-runtime.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.budget')


/** 费用闸(§6.2 第三道闸): 房间日预算,按会话集合(房间+其 work 会话)从
 *  usage 账本累计 costUSD。60s 缓存,超限时激活与新 worker 都被拒。
 *
 *  默认值本身搬去了纯层(`collab/types.ts`,理由见那儿),这里原样再导出一次 ——
 *  已有的导入点不必跟着搬家,而"闸的默认额度"读起来仍然在闸这个文件里。 */
export { COLLAB_DEFAULT_DAILY_COST_USD } from '@onething/runtime/collab'
const BUDGET_CACHE_MS = 60_000

/**
 * 这道闸自己的缓存(D6-b:从 v2 的 `RoomRuntime` 字段搬进来)。
 *
 * 从前这四格挂在房间运行时上,理由是"协调器已经握着一张按房的表,不必再开一张"。
 * v2 调度链删掉之后那张表只剩这四格还有人读 —— 让一道闸把自己的缓存寄存在一个
 * 为别的目的存在的对象上,是那种一删就断的耦合。**行为一格没改**:同一个 60s
 * 窗口、同一份在飞读取去重、同一条"今天只说一遍"的日闩。
 */
interface BudgetCell {
  checkedAt: number
  spentUSD: number
  /** 正在进行的账本读取(并行去重,见下面 `isRoomOverBudget` 里那段注释)。 */
  read?: Promise<number>
  noticeDay: string
}

const cells = new Map<string, BudgetCell>()

function cell(roomSessionId: string): BudgetCell {
  let entry = cells.get(roomSessionId)
  if (!entry) {
    entry = { checkedAt: 0, spentUSD: 0, noticeDay: '' }
    cells.set(roomSessionId, entry)
  }
  return entry
}

/**
 * 让这间房的读数立刻过期 —— 改预算、清历史、删房都调它。
 *
 * 不调的话一个刚被抬高的上限还要等最多 60s 才拦不住人,而那正是用户拨完开关
 * 之后立刻要验证的那一分钟。
 */
export function forgetCollabRoomBudgetCache(roomSessionId: string): void {
  cells.delete(roomSessionId)
}

/**
 * Which day the budget is counting, in the USER's timezone (R7 / P3).
 *
 * It used to be UTC, so 「今天这个房间已花费…」 and 「明天自动恢复」 meant a day
 * that starts at 08:00 for a user in UTC+8: an evening's spend counted against
 * the next calendar day, and the reset landed mid-morning. A cost brake the
 * user reads in words has to use the day the user is living in.
 */
export function budgetDayKey(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local midnight that opened the current budget day. */
function budgetDayStart(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * How long until the budget day rolls over (P2-4). The over-budget notice
 * promises 「明天自动恢复」 and nothing used to make that true — the parked
 * activations sat until the next human message. One kick per room, armed when
 * the gate closes, turns the sentence into a fact.
 *
 * Derived from the same local midnight the spend query uses: a kick that fired
 * against a different day boundary than the one being counted would wake the
 * queue into the same closed gate.
 */
export function msUntilNextBudgetDay(now: number = Date.now()): number {
  const next = new Date(budgetDayStart(now))
  // setDate handles month/year ends and — unlike +86400000 — DST transitions.
  next.setDate(next.getDate() + 1)
  return Math.max(0, next.getTime() - now)
}

/**
 * Today's ledger cost for a room: the room session plus every work session its
 * board ever spawned. Session-set attribution, deliberately NOT the W13.3
 * usageSource labels — the set already covers turns that predate the labels and
 * turns nobody labelled (retries, compaction, titles).
 *
 * Uncached on purpose: the gate below wraps it in its own 60s cache, and the
 * settings panel wants a fresh number the moment it opens.
 */
export async function readCollabRoomSpentTodayUSD(roomSessionId: string): Promise<number> {
  const records = await getUsageLedger().readRecordsInRange(
    budgetDayStart(Date.now()),
    Date.now() + 60_000,
  )
  const ids = new Set<string>([roomSessionId])
  for (const task of loadCollabBoard(roomSessionId).tasks) {
    for (const workId of task.workSessionIds) ids.add(workId)
  }
  // W18: room turns bill to the speaking agent's EXECUTION session, not to the
  // room — so the set has to follow them there, or the gate would stop seeing
  // the room's main expense.
  //
  // collab-team-v2 §1.3 顺手修好了这里的口径:执行会话按群隔离之后,一条执行
  // 会话只属于一个房间,此前"一个 agent 在两个群里共用一条会话、于是它的花销
  // 被两个房间各记一遍"的重复计消失了。旧注释把这笔账开脱为"只会让闸更早关",
  // 现在不需要开脱——它就是准的。旧的全局会话也算进来,因为迁移前的花销确实
  // 发生过,只是不再增长。
  for (const agentId of store.getSession(roomSessionId)?.room?.memberAgentIds ?? []) {
    for (const agentSessionId of collabAgentSessionIdsForScan(agentId, roomSessionId)) {
      ids.add(agentSessionId)
    }
  }
  let spent = 0
  for (const record of records) {
    if (record.sessionId && ids.has(record.sessionId) && record.costUSD != null) {
      spent += record.costUSD
    }
  }
  return spent
}

/**
 * Read-only spend view for the room settings panel (W13.5). The limit rides
 * along so the caller never has to re-derive the default.
 */
export async function getCollabRoomSpend(roomSessionId: string): Promise<{
  success: boolean
  error?: string
  spentTodayUSD?: number
  dailyCostUSD?: number
}> {
  const session = store.getSession(roomSessionId)
  if (session?.kind !== 'room') return { success: false, error: 'Not a room session' }
  try {
    return {
      success: true,
      spentTodayUSD: await readCollabRoomSpentTodayUSD(roomSessionId),
      dailyCostUSD: session.room?.budgets?.dailyCostUSD ?? COLLAB_DEFAULT_DAILY_COST_USD,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Exported for the say executor (W14b): the 预算闸 is now enforced at the
 *  moment an agent actually tries to speak, so the refusal reaches the agent
 *  instead of silently eating an activation. Same 60s cache, same notice line. */
export async function isRoomOverBudget(roomSessionId: string): Promise<boolean> {
  const session = store.getSession(roomSessionId)
  if (session?.kind !== 'room') return false
  const limit = session.room?.budgets?.dailyCostUSD ?? COLLAB_DEFAULT_DAILY_COST_USD
  if (limit <= 0) return false
  const entry = cell(roomSessionId)
  if (Date.now() - entry.checkedAt > BUDGET_CACHE_MS) {
    // 缓存的是**这次读取本身**,不是一个先落下的时间戳(并行化 2026-08-01)。
    //
    // 原先第一行就把 `budgetCheckedAt` 写成 now,然后才 await 账本 —— 串行时代
    // 没人看得见这中间的窗口,并行之后第二条回合恰好落在里面:它看到一个"刚查过"
    // 的时间戳,于是跳过读取、拿 `budgetSpentUSD` 的**初始值 0** 去比,预算闸对
    // 它整个不存在。同时起跑的 N 条只有第一条被拦住。
    //
    // 现在同一时刻只有一次真实读取,后到的等同一个 promise;时间戳在读**成功之后**
    // 才落,所以一次失败的读取不会顺手把接下来 30 秒也变成"查过了"。
    if (!entry.read) {
      entry.read = readCollabRoomSpentTodayUSD(roomSessionId)
        .then(value => {
          entry.spentUSD = value
          entry.checkedAt = Date.now()
          return value
        })
        .finally(() => {
          entry.read = undefined
        })
    }
    try {
      await entry.read
    } catch (error) {
      log.error('budget read failed', {}, error)
      return false // 账本读不了不误杀
    }
  }
  const over = entry.spentUSD >= limit
  if (over && entry.noticeDay !== budgetDayKey()) {
    entry.noticeDay = budgetDayKey()
    postSystemLine(
      roomSessionId,
      `今天这个房间已花费 $${entry.spentUSD.toFixed(2)},达到日预算 $${limit}——明天自动恢复,或调整房间预算`,
    )
  }
  return over
}