/**
 * **refold 自洽环**(S3w-2,`docs/design/session-event-sourcing-2026-08.md`
 * §14.3-B / §14.6 裁定 6)。
 *
 * ## 它替的是哪一道门
 *
 * 停写 `messages.jsonl` 之前,对账有两层:
 *
 *  1. **语义层**(`shadow.ts`):内存 store(reducer 推导)vs 活投影(事件推导)
 *     —— 两条**独立推导**。它读的是内存 store,所以停写之后照跑不误。
 *  2. **耐久层**(`sessions:verify` #6 与 §13.16 那类真机对账):`messages.jsonl`
 *     文件 vs 投影 —— 它守的是**落盘本身**(append 丢没丢、行坏没坏、seq 乱没乱)。
 *     停写之后这一层的**新增量**没有了对象,这才是真正消失的第二来源。
 *
 * 这个模块就是第 2 层的替身:两侧同源(同一份事件)但**路径独立** ——
 * `events.jsonl` 的**文件字节**重读 + 全量 fold,对上**内存活投影**(写入口那条
 * 尾巴的增量 fold)。它恰好盖住耐久层守的那几类:append 静默丢、坏行、seq 错乱、
 * fsync 缺口、G12 外写者写进来的那一段。
 *
 * ## 四条纪律(前三条与影子同款,理由也同款)
 *
 * 1. **永不抛进引擎**。出口 try/catch 自吞:一道对账门算错了最坏是账记歪,
 *    绝不能是聊天挂掉。
 * 2. **采样,不是每次**。全量 fold 是 O(整份文件),run/end 每次都跑等于把
 *    收尾路径钉在 IO 上。每会话每 `ONETHING_SESSION_REFOLD_EVERY` 个 run 采一次
 *    (默认 5),**首个 run 必采** —— 一条只跑了一轮的会话也该被看一眼。
 * 3. **单法官,不开豁免**。判据是 `canonicalChatMessage`(与影子、与 S0 合同
 *    测试同一把尺)。这里不再额外豁免字段:真的不等就是真的不等。
 * 4. **不许攥着主进程不放**(§15.14)。`await` 之后那一整块(parse / fold /
 *    重折侧物化 / 深比)在真机 16.2MB 账本上是一口气 ≈142ms 的同步代码,主进程
 *    那一刻什么都干不了 —— 用户感知就是"答完顿一下"。现在它走**协作式分片**
 *    (`refold-slices.ts`):每跑够半帧让出一次事件环,总耗时略增,最长一次
 *    连续阻塞压回一帧以内。唯一不分片的是活投影侧的定格(见下)。
 *
 * 记账:不等记 `<store>/log/session-shadow.jsonl` 一行 `kind:'refold'`,计数进
 * `session-shadow-stats.json` 的 `refoldChecks` / `refoldMismatches`;
 * `sessions:shadow-report` 打印两者并把 **`refoldMismatches = 0` 纳入门判据**。
 *
 * 方向(F0,§16.2):摘要的 `a` 列是**文件字节重折**(真相 —— 账本是唯一持久化),
 * `b` 列是内存活投影。这条从一开始就是这个次序,F0 没有动它;写入口盖的
 * `truth:'events'` 标记对这一类同样成立(两侧都由事件推导,真相在文件那一侧)。
 */

import fs from 'node:fs'
import {
  canonicalChatMessage,
  materializeNode,
  type ProjectionNode,
  type SessionProjectionState,
} from '@onething/core/session'
import {
  canonicalProjectionMessagesSliced,
  createRefoldSliceGate,
  deepEqualPairsSliced,
  foldSessionProjectionSliced,
  parseSessionLogEventLogSliced,
} from './refold-slices.js'
import { bumpSessionShadowStats } from './event-stats.js'
import {
  getSessionEventsLogPath,
  sessionEventTailEnabled,
} from './event-log.js'
import {
  getLiveSessionProjection,
  liveSessionProjectionAheadDeltas,
  liveSessionProjectionCursor,
} from './projection-cache.js'
import { sessionProjectionOptions } from './projection-blobs.js'
import { appendSessionShadowLine, deepEqual, summarizeShadowDiff } from './shadow.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.refold')

/** 采样间隔的缺省值:每会话每 5 个 run 一次。首个 run 不受它管(必采)。 */
const DEFAULT_REFOLD_EVERY = 5

/**
 * 每会话已经收过几个 run(采样的分母)。
 *
 * 进程内计数即可:重启之后从 1 重新数,而"重启后的第一个 run 必采"正好是我们
 * 想要的 —— 冷启动那一份从文件折出来的投影恰恰最值得被看一眼。
 */
const runCounts = new Map<string, number>()

/** `ONETHING_SESSION_REFOLD_EVERY`:采样间隔。`0`/非法 = 缺省;`1` = 每个 run 都采。 */
function refoldEvery(): number {
  const raw = Number(process.env.ONETHING_SESSION_REFOLD_EVERY)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_REFOLD_EVERY
  return Math.floor(raw)
}

/** `ONETHING_SESSION_REFOLD=0` 关掉这道门(与影子的总闸分开:两道门问的不是同一件事)。 */
function isRefoldEnabled(): boolean {
  return process.env.ONETHING_SESSION_REFOLD !== '0'
}

/** 这次 run 收尾要采样吗(第 1、1+N、1+2N… 个)。 */
function shouldSample(sessionId: string): boolean {
  const seen = (runCounts.get(sessionId) ?? 0) + 1
  runCounts.set(sessionId, seen)
  return (seen - 1) % refoldEvery() === 0
}

function visibleNodes(state: SessionProjectionState): ProjectionNode[] {
  return state.nodes.filter(node => !node.hidden)
}

function canonicalMessages(sessionId: string, state: SessionProjectionState): unknown[] {
  // A8/A9(§13.6):blob 回放在物化里,两侧用**同一份**选项 —— 一侧能读回附件
  // 而另一侧读不回,那是"两种物化"的不等,不是账本的不等。
  const materialize = sessionProjectionOptions(sessionId)
  return visibleNodes(state).map(node =>
    canonicalChatMessage(materializeNode(node, materialize) as unknown as Record<string, unknown>),
  )
}

export type SessionRefoldOutcome = 'match' | 'mismatch' | 'skipped'

/**
 * 一次 refold 对账。**同步取活投影、异步读文件**;调用方负责把它挪出热路径。
 *
 * 跳过(不算数、不记账)的三种情形:
 *  - 这条会话根本没有活投影可比(尾巴没在攒 / 事件为空 / legacy 整文件会话);
 *  - **游标对不齐** —— 文件最后一条 seq ≠ 快照那一刻活投影折到的 seq。中间有人
 *    又写了一条(或有一条还没落盘),此刻比出来的"多一段/少一段"说明的是采样
 *    撞上了写,不是账本坏了。宁可少比一次,不许报一次假红。
 *  - 出错(读文件失败 / 物化失败)—— warn 一句,不进任何计数。
 *
 * ## 一条实测出来的纪律:活投影这一侧必须**在第一次 await 之前就取成快照**
 *
 * `reduceSessionProjection` 是**移动语义**的(S0 §9.7 判例 9):它就地改那份
 * state。而活投影只有一份、全进程共用 —— 读路径的 `eventsListMessages`、影子
 * 断言、下一次 refold 都会调 `getLiveSessionProjection` 把新事件折进去。所以
 * 只要这里先 `await` 读文件、回来再物化,拿到的就是一份**已经被别人推进过**的
 * 投影:它比游标说的多出一段,而文件那边没有,于是报一次假红。
 *
 * 批 4 第一版正是这么写的,battery 上 4 跑 1 红(`tool-args-truncated`:
 * A 那条助手消息 content 为空、B 有正文 —— 差的正是 await 期间新落的那批
 * chunks)。改法是把物化提到 await 之前:`canonicalChatMessage` 产出的是全新的
 * 朴素对象,快照一旦取出就不再受就地推进影响。
 *
 * **所以活投影侧这一段不分片**(§15.14):让出事件环 = 一次 `await`,与"第一次
 * await 之前取完快照"是同一件事的正反面。它在真机大账本上 ≈22ms,是这道门里
 * 唯一无法避免的连续阻塞 —— 正确性优先于流畅度,这一格明账收着。
 *
 * ## 分片之后为什么**不需要**新的游标机制
 *
 * 让出事件环期间账本可能又被写。但这次比对的两侧此刻**都已经与外界脱钩**:
 *  - 活投影侧 `b` 是定格出来的朴素对象(上一段);
 *  - 文件侧从 `readFile` 返回的那一刻起就只是一个字符串,后面追加的字节不会
 *    出现在它里面。
 * 所以守卫仍然只有原来那一道 —— **文件末条 seq == 定格游标**,在 parse 之后
 * 立刻问一次。分片完再问一遍没有意义:两个被比较的量一个都没变,重问也只会
 * 拿到同一个答案。要防的东西(快照过期)在定格那一步就已经防住了。
 */
export async function checkSessionRefold(
  sessionId: string,
  runId?: string,
): Promise<SessionRefoldOutcome> {
  if (!isRefoldEnabled()) return 'skipped'
  // 活投影靠写入口那条尾巴增量推进;尾巴关着时它停在第一次折出来的那一刻,
  // 拿它去比只会比出"文件多了一段"的假不等。
  if (!sessionEventTailEnabled()) return 'skipped'
  try {
    // ---- 同步段:活投影这一侧连同它的游标一起定格(见上面那条纪律)。
    const live = getLiveSessionProjection(sessionId)
    if (live.nodes.length === 0) return 'skipped'
    const cursor = liveSessionProjectionCursor(sessionId)
    if (cursor === undefined) return 'skipped'
    // F4-c c3-a(§16.19「比对点 = 编码器刷新点」):活投影里有几条 delta 已经
    // 折进来了、而它那一行还压在编码器写缓冲里 —— 那几条字节文件上还没有,
    // 此刻两侧本来就不可比。与上面那条游标守卫同一个道理:宁可少比一次,
    // 不许报一次假红。收尾链的 `flushAll` 会把缓冲清空,run 收尾这一刻通常是 0。
    if (liveSessionProjectionAheadDeltas(sessionId) > 0) return 'skipped'
    const b = canonicalMessages(sessionId, live)

    // ---- 这之后可以 await:上面那份快照已经与活投影脱钩。
    // 剩下的四段都走分片闸:每跑够半帧让出一次事件环(§15.14)。
    const gate = createRefoldSliceGate()
    const text = await fs.promises.readFile(getSessionEventsLogPath(sessionId), 'utf8')
    const events = await parseSessionLogEventLogSliced(text, gate)
    if (events.length === 0) return 'skipped'
    if (events[events.length - 1].seq !== cursor) return 'skipped'

    const refolded = await foldSessionProjectionSliced(events, gate)

    const a = await canonicalProjectionMessagesSliced(
      refolded,
      sessionProjectionOptions(sessionId),
      gate,
    )
    bumpSessionShadowStats({ refoldChecks: 1 })
    if (await deepEqualPairsSliced(a, b, deepEqual, gate)) return 'match'

    const { diff, truncated } = summarizeShadowDiff(a, b)
    appendSessionShadowLine({
      time: Date.now(),
      sessionId,
      ...(runId ? { runId } : {}),
      kind: 'refold',
      diff,
      ...(truncated ? { truncated } : {}),
    })
    bumpSessionShadowStats({ refoldMismatches: 1 })
    return 'mismatch'
  } catch (error) {
    log.warn('refold assertion failed', { sessionId }, error)
    return 'skipped'
  }
}

/**
 * run 收尾处的挂点(`runs.ts` 的 `endSessionRun`,`flushSessionEventLog` **之后**)。
 *
 * 挂在这里而不是采集点上,理由和影子一样:run/end 那一刻账本刚过语义检查点
 * (队列排空 + fsync),文件字节是全的 —— 早一步比就是在比一份还没写完的文件。
 * 采样判定在这里做(同步、便宜),真比对丢进宏任务,不占收尾路径。
 */
export function scheduleSessionRefold(sessionId: string, runId?: string): void {
  if (!isRefoldEnabled()) return
  if (!shouldSample(sessionId)) return
  const timer = setTimeout(() => {
    void checkSessionRefold(sessionId, runId)
  }, 0)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
}

/** 会话删除 / 测试:忘掉采样计数(下一次 run 又是"首个 run",必采)。 */
export function resetSessionRefoldSampling(sessionId?: string): void {
  if (sessionId) runCounts.delete(sessionId)
  else runCounts.clear()
}
