/**
 * **什么时候写投影检查点**(工单 4 B 的调度那一半)。
 *
 * 格式与四道判据在 `checkpoint-file.ts`,冷载时怎么用在 `projection-cache.ts`;
 * 这只文件只回答一个问题:*这一刻值得写一份吗*。
 *
 * ## 两个挂点,一条写入口
 *
 *  1. **refold 对上账之后**(`refold.ts` 的 `match` 分支)—— 那一份 state 刚从
 *     账本的**文件字节**重折出来,而且刚被证明与内存活投影逐字相同。它是白捡的
 *     一份、还带证明,零额外成本;
 *  2. **run 收尾的兜底**(下面那只 `scheduleSessionProjectionCheckpoint`)——
 *     refold 每会话每 5 个 run 才采一次,`ONETHING_SESSION_REFOLD=0` /
 *     `ONETHING_SESSION_SHADOW=0` 时一次都不跑。**检查点是性能设施,不是对账门**
 *     ,它的存亡不该系在一道对账门的开关上;所以这条路照写不误,用的是内存活
 *     投影(它同样是这份账本折出来的,只是没有第二条独立路径给它作证)。
 *
 * 两条路都**不多折一遍账本**:一条复用重折结果,一条复用内存里那一份。
 *
 * ## 节流的判据是「这一份能省掉多少字节的重折」
 *
 * 不是"每 N 个 run"也不是"每 N 秒"——那两种数法都与检查点真正的价值无关。
 * 检查点省下的正是「上次写到现在」这一段账本的重折,所以判据直接就是那一段有
 * 多长:`账本此刻大小 − 上次检查点覆盖到的字节 >= CHECKPOINT_MIN_GROWTH_BYTES`。
 *
 * 这条判据顺带把小会话整个排除在外:一条 200KB 的账本从头折本来就只要几毫秒,
 * 给它写一份检查点是净亏(多一次编码 + 多一个文件 + 多一份要维护的派生物)。
 * 真店 53MB 那条会话则会在每次 run 收尾附近落一份,冷载从此只折尾巴。
 */

import {
  getLiveSessionProjection,
  liveSessionProjectionAheadDeltas,
  liveSessionProjectionCursor,
  peekSessionAccount,
} from './projection-cache.js'
import {
  peekSessionProjectionCheckpointMeta,
  writeSessionProjectionCheckpoint,
  type SessionCheckpointWriteOutcome,
} from './checkpoint-file.js'
import { getSessionEventsLogPath } from './event-log.js'
import { getLogger } from '../wiring/logging/index.js'
import fs from 'node:fs'

const log = getLogger('sessions.checkpoint')

/**
 * 上一份检查点之后账本至少长这么多,才值得再写一份。
 *
 * 1MB:真店的账本约 130KB/条消息量级,1MB 大致是"再折一次要几十毫秒"的门槛;
 * 低于它,写检查点省下的时间还不如写它花掉的多。`ONETHING_SESSION_CHECKPOINT_MIN_BYTES`
 * 只在量测时临时调小(`0` 与非法值走缺省;度量脚本把它设成 1 好让每次都落一份)。
 */
const DEFAULT_MIN_GROWTH_BYTES = 1024 * 1024

function minGrowthBytes(): number {
  const raw = Number(process.env.ONETHING_SESSION_CHECKPOINT_MIN_BYTES)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MIN_GROWTH_BYTES
  return Math.floor(raw)
}

/** `ONETHING_SESSION_CHECKPOINT=0` 关掉写(读那一侧照旧:已有的检查点仍然作数)。 */
export function isSessionProjectionCheckpointEnabled(): boolean {
  return process.env.ONETHING_SESSION_CHECKPOINT !== '0'
}

/** 账本此刻多大。读不到(会话没有账本)→ 0。 */
function ledgerSize(sessionId: string): number {
  try {
    return fs.statSync(getSessionEventsLogPath(sessionId)).size
  } catch {
    return 0
  }
}

/** 这一刻该不该再写一份(见文件头「节流」那一节)。 */
function shouldWrite(sessionId: string): boolean {
  const size = ledgerSize(sessionId)
  if (size <= 0) return false
  const covered = peekSessionProjectionCheckpointMeta(sessionId)?.ledgerBytes ?? 0
  return size - covered >= minGrowthBytes()
}

/**
 * refold 刚刚证明「文件字节重折 ≡ 内存活投影」——把那一份重折结果留成检查点。
 *
 * 它拿到的 `state` 是重折出来的那一份,`cursor` 是那次比对定格的游标。判据仍由
 * 写入口自己再验一遍(账本末行的 seq 必须等于 `cursor`),所以采样与写之间即便
 * 又落了一条事件,结果也只是 `'behind'` —— 不写,不是写错。
 *
 * 节流对它同样生效:refold 每 5 个 run 才跑一次,但一条冷清的会话跑 5 个 run
 * 也可能只长了几十 KB,那一份检查点省不下什么。
 */
export function recordRefoldedProjectionCheckpoint(
  sessionId: string,
  state: Parameters<typeof writeSessionProjectionCheckpoint>[1],
  account: Parameters<typeof writeSessionProjectionCheckpoint>[2],
  cursor: number,
): SessionCheckpointWriteOutcome {
  if (!isSessionProjectionCheckpointEnabled()) return 'skipped'
  if (!shouldWrite(sessionId)) return 'skipped'
  return writeSessionProjectionCheckpoint(sessionId, state, account, cursor)
}

/**
 * run 收尾的兜底挂点。**同步判定、同步写**,但只在真的该写的时候才走到写。
 *
 * 为什么不丢进宏任务(refold 那样):那一份要写的东西是**内存活投影**,而它是
 * 就地改的(移动语义)—— 让出一次事件环,拿到的就可能是一份已经被推进过、
 * 与刚量出来的字节数对不上的投影。refold 没有这个问题是因为它比的两侧早就
 * 定格成了朴素对象。所以这里的次序是:先问该不该写(两次 `stat` 级的读),
 * 该写就在**同一个同步段**里取投影、取游标、编码、落盘。
 *
 * 代价是真机 53MB 那条会话上一次 ≈ 编码 5.8MB JSON 的时间,挂在 run 收尾
 * 之后、每长 1MB 才一次。这一格明账收着,真要压下去的做法是把编码搬进
 * worker —— 那是一次单独的拍板,不在本单。
 *
 * 永不抛(与影子 / refold 同一条纪律):检查点写不成最坏是下一次冷载慢一点。
 */
export function scheduleSessionProjectionCheckpoint(sessionId: string): void {
  if (!isSessionProjectionCheckpointEnabled()) return
  try {
    if (!shouldWrite(sessionId)) return
    const state = getLiveSessionProjection(sessionId)
    if (state.nodes.length === 0) return
    const cursor = liveSessionProjectionCursor(sessionId)
    if (cursor === undefined || cursor <= 0) return
    // 活投影领先磁盘几条 delta = 它比账本多知道一些事,此刻写下去的备忘会让
    // 冷载折出一份「比账本还新」的历史。判据与 refold 那道守卫逐字同源。
    if (liveSessionProjectionAheadDeltas(sessionId) > 0) return
    const account = peekSessionAccount(sessionId)
    if (!account) return
    writeSessionProjectionCheckpoint(sessionId, state, account, cursor)
  } catch (error) {
    log.debug('projection checkpoint scheduling failed', { sessionId }, error)
  }
}
