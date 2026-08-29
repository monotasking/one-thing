/**
 * 会话列表投影的**存量回填**(E2)。
 *
 * E 批(f569aaf7)把 `messageCount` / `lastMessagePreview` 两格挂上了**写侧**:
 * 与 `updatedAt` 同刻落进索引元数据,于是列表读仍然只是一次元数据读。那一批的
 * 裁定是"不回填、下次写自愈" —— 对一个还在长的库成立,对**存量库**等于功能
 * 不存在:真机 439 条会话里 0 条带摘要格,一条会话不再被写就永远不会有。
 *
 * 这一批补的就是那一次:**启动后跑一趟后台回填**,读面纪律一格不动
 * (`listMeta` 仍然是纯元数据读,回填只是把写侧本该留下的那两格补上)。
 *
 * ## 四条纪律
 *
 * 1. **判据 = 那两格缺席**,不另立标记位。`messageCount` 缺席是主判据 —— 空会话
 *    回填后落 `messageCount: 0`(0 是真值,E 批已钉),下一次启动就不再被扫;
 *    拿 `lastMessagePreview` 缺席单独当判据会**永扫**空会话(空会话合法地没有
 *    预览)。但只看 `messageCount` 又会漏掉真机上那 39 条**老写者留下的孤零零
 *    计数**(有 count、从来没有过预览),所以判据是两格的并:缺计数,**或者**
 *    有话却没预览(`messageCount > 0 && lastMessagePreview === undefined`)。
 *
 * 2. **产地同一把尺**。计数 = 折叠产物里的可见节点数(与 `eventsCountMessages`
 *    同口径),预览 = `deriveSessionLastMessagePreview`(E 批那把纯函数)。回填
 *    **从后往前找第一条能出预览的消息** —— 不是"最后一条消息的预览"。这不是
 *    额外发明:写侧是增量的,而 `deriveSessionLastMessagePreview` 规则 5 规定
 *    "出不了预览就不覆盖上一格",所以一条一条写下来的最终态**就是**最后一句
 *    有正文的话。回填要与增量写侧同结果,就必须回头找。
 *
 * 3. **不抬 `updatedAt`**。回填不是内容变更 —— 抬了会把 439 条会话整体顶到列表
 *    顶端,把用户的时序打乱。落格走 `updateSessionsIndexMeta`,回调只碰那两格,
 *    索引里其余字段(含 `updatedAt`)一个字节不动;也**不发任何 `session:event`**,
 *    已开的界面下次自然重拉即见。
 *
 * 4. **只补,不改口径**。事件账本不在(`events.jsonl` 缺席)的会话直接跳过:
 *    它可能是一条还没迁移过的 legacy 抄本,写 `messageCount: 0` 是替一份我们
 *    没读过的账说话。首次打开触发迁移之后,写侧自己会把格补上。
 *
 * ## 成本(真机 439 条 / 475MB 事件账本实测,见批次汇报)
 *
 * 单条 = 读文件 + 分片 parse + 分片 fold + 尾部物化。中位数会话(94KB)< 1ms,
 * p90(2MB)≈ 5ms,最大那两本(27MB / 49MB)≈ 150ms / 100ms —— 而它们走的是
 * `refold-slices` 那套**协作式分片**(每半帧让出一次事件环),所以最长一次连续
 * 阻塞是一帧,不是 150ms。全库折完 ≈ 2-3s CPU;节流之后 ≈ 25s 跑完。
 *
 * 没有更便宜的"尾读":`messageCount` 要的是全量可见节点数,而事件账本没有索引,
 * 任何计数都得把整份日志折一遍。**尾部只读最后几 KB** 只能回答预览、回答不了
 * 计数,而分家两条判据就是分家两份真相。折叠本身也不是瓶颈(parse 才是,≈3ms/MB)。
 *
 * 走**文件重折**而不是 `sessionReads`(活投影)有两个硬理由:
 *  - 活投影是进程级 `Map` 且**没有淘汰**,为 439 条会话建表 = 把整个账本常驻内存;
 *  - `getLiveSessionProjection` 首次建表会调 `prepareSessionEventsOnce`,那会**写**
 *    合成的 run 收尾事件 —— 一次后台回填不该顺手改 439 本账。
 * 已经有活投影的会话反过来直接用它(免费、且与内存里那份事实同源)。
 */

import fs from 'node:fs'
import {
  applySessionListProjectionToMeta,
  deriveSessionLastMessagePreview,
  materializeNode,
  type CoreSessionPreviewMessageSource,
  type SessionProjectionState,
} from '@onething/core/session'
import type { SessionMeta } from '@shared/ipc.js'
import { getSessionsList, updateSessionsIndexMetaForCommands } from '../stores/sessions.js'
import { getLogger } from '../wiring/logging/index.js'
import { getSessionEventsLogPath } from './event-log.js'
import { sessionProjectionOptions } from './projection-blobs.js'
import { getLiveSessionProjection, hasLiveSessionProjection } from './projection-cache.js'
import {
  createRefoldSliceGate,
  foldSessionProjectionSliced,
  parseSessionLogEventLogSliced,
} from './refold-slices.js'

const log = getLogger('sessions.events')

/**
 * 两条会话之间歇多久。
 *
 * 落格那一步是**整份索引读改写**(`updateSessionsIndexMeta` 在锁内重新读盘),
 * 真机 439 条 ≈ 100KB —— 一次约 1ms,连着跑 439 次就是一段谁也插不进来的 IO。
 * 50ms 让位给交互、落盘队列与 SSE 心跳;全库实测折叠只有 2-3s CPU,节流之后
 * ≈ 25s 跑完,而这是一件**一辈子只跑一次**的事,不值得跟前台抢。
 */
export const SESSION_LIST_BACKFILL_THROTTLE_MS = 50

/**
 * 启动后延迟多久开跑。
 *
 * 比 blob GC 的 5 分钟短得多:那件事是治垃圾(越晚越好),这件事是补功能。
 * 15s 之后窗口、插件、MCP、调度器那一波启动风暴已经过去。
 */
export const SESSION_LIST_BACKFILL_START_DELAY_MS = 15_000

export interface SessionListProjectionBackfillOptions {
  /** 待扫名单(缺省 = 索引里的全部会话)。测试注入用。 */
  sessions?: readonly SessionMeta[]
  /** 这条会话此刻在流式中吗 —— 在的话本轮跳过,下次启动再说。 */
  isSessionBusy?(sessionId: string): boolean
  throttleMs?: number
  /** 打断闸:关停时置 `aborted`,当前这条跑完就停,下次启动接着扫。 */
  signal?: { aborted: boolean }
  /** 测试注入的等待实现(缺省 = `setTimeout`)。 */
  wait?(ms: number): Promise<void>
}

export interface SessionListProjectionBackfillReport {
  /** 索引里一共多少条。 */
  sessions: number
  /** 判据命中、这一轮要处理的条数。 */
  candidates: number
  /** 真的落了格的条数。 */
  filled: number
  /** 正在流式中,本轮跳过。 */
  skippedBusy: number
  /** 事件账本不在(可能是没迁移的 legacy 抄本),本轮跳过。 */
  skippedNoLedger: number
  /** 算完之后发现别人已经把格写上了(写侧抢先),不覆盖。 */
  skippedFresh: number
  /** 单条失败(记 warn,继续下一条)。 */
  failed: number
  /** 被打断了吗。 */
  aborted: boolean
  ms: number
}

/**
 * 这条会话要不要回填 —— 判据 1(见文件头)。
 *
 * 落格前会**再问一次**:算的时候让出过事件环,期间写侧可能已经把格写上了,
 * 那一份比我们这份新。
 */
export function sessionNeedsListProjectionBackfill(meta: {
  messageCount?: number
  lastMessagePreview?: string
}): boolean {
  if (typeof meta.messageCount !== 'number') return true
  return meta.messageCount > 0 && meta.lastMessagePreview === undefined
}

interface SessionListProjectionValue {
  messageCount: number
  lastMessage: CoreSessionPreviewMessageSource | undefined
}

/**
 * 折叠产物 → 那两格。
 *
 * 计数只数**可见**节点(与 `eventsCountMessages` 逐字同口径);预览从后往前
 * 物化,停在第一条能出预览的消息上(判据 2)。物化按节点逐个来,所以一条
 * 有正文的会话通常只物化最后一两个节点。
 */
function readListProjectionFromState(
  sessionId: string,
  state: SessionProjectionState,
): SessionListProjectionValue {
  const visible = state.nodes.filter(node => !node.hidden)
  if (visible.length === 0) return { messageCount: 0, lastMessage: undefined }

  const materialize = sessionProjectionOptions(sessionId)
  for (let index = visible.length - 1; index >= 0; index--) {
    const message = materializeNode(visible[index], materialize) as unknown as
      CoreSessionPreviewMessageSource
    if (deriveSessionLastMessagePreview(message) !== undefined) {
      return { messageCount: visible.length, lastMessage: message }
    }
  }
  // 一条正文都折不出来(纯工具 / 纯系统标记的会话):计数是真的,预览合法缺席。
  return { messageCount: visible.length, lastMessage: undefined }
}

/**
 * 一条会话的那两格。`undefined` = 这条会话没有事件账本(判据 4,跳过)。
 *
 * 已经有活投影就直接用它(同步、免费、与内存里那份事实同源);否则读文件
 * 重折,用 refold 那套分片闸,不碰活投影缓存。
 */
export async function readSessionListProjection(
  sessionId: string,
): Promise<SessionListProjectionValue | undefined> {
  if (hasLiveSessionProjection(sessionId)) {
    return readListProjectionFromState(sessionId, getLiveSessionProjection(sessionId))
  }

  let text: string
  try {
    text = await fs.promises.readFile(getSessionEventsLogPath(sessionId), 'utf8')
  } catch {
    return undefined
  }

  const gate = createRefoldSliceGate()
  const events = await parseSessionLogEventLogSliced(text, gate)
  const state = await foldSessionProjectionSliced(events, gate)
  return readListProjectionFromState(sessionId, state)
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })

/** 跑一趟回填。幂等:判据本身就是"这一格还空着"。 */
export async function runSessionListProjectionBackfill(
  options: SessionListProjectionBackfillOptions = {},
): Promise<SessionListProjectionBackfillReport> {
  const startedAt = Date.now()
  const sessions = options.sessions ?? getSessionsList()
  const candidates = sessions.filter(sessionNeedsListProjectionBackfill)
  const throttleMs = options.throttleMs ?? SESSION_LIST_BACKFILL_THROTTLE_MS
  const wait = options.wait ?? defaultWait
  const report: SessionListProjectionBackfillReport = {
    sessions: sessions.length,
    candidates: candidates.length,
    filled: 0,
    skippedBusy: 0,
    skippedNoLedger: 0,
    skippedFresh: 0,
    failed: 0,
    aborted: false,
    ms: 0,
  }

  for (const meta of candidates) {
    if (options.signal?.aborted) {
      report.aborted = true
      break
    }
    if (options.isSessionBusy?.(meta.id)) {
      report.skippedBusy += 1
      continue
    }
    try {
      const value = await readSessionListProjection(meta.id)
      if (!value) {
        report.skippedNoLedger += 1
      } else {
        let stale = false
        updateSessionsIndexMetaForCommands(meta.id, indexMeta => {
          // 算的时候让出过事件环 —— 期间写侧可能已经落过一次更新的格。
          if (!sessionNeedsListProjectionBackfill(indexMeta as never)) {
            stale = true
            return
          }
          applySessionListProjectionToMeta(indexMeta as never, {
            messageCount: value.messageCount,
            lastMessage: value.lastMessage,
          })
        })
        if (stale) report.skippedFresh += 1
        else report.filled += 1
      }
    } catch (error) {
      report.failed += 1
      log.warn('session list projection backfill failed', { sessionId: meta.id }, error)
    }
    if (throttleMs > 0) await wait(throttleMs)
  }

  report.ms = Date.now() - startedAt
  return report
}

/**
 * 启动后延迟跑一趟 —— **默认开**(这一批就是为了让存量库有摘要格)。
 *
 * `ONETHING_SESSION_LIST_BACKFILL=0` 关掉。定时器 `unref`,所以它自己留不住
 * 进程;返回 disposer,关停时取消 —— 已经开跑的那一轮靠 `signal` 在下一条
 * 之前停手,没跑到的会话下次启动接着扫(判据天然幂等)。
 */
export function scheduleSessionListProjectionBackfillOnStartup(
  options: { delayMs?: number; isSessionBusy?(sessionId: string): boolean } = {},
): (() => void) | undefined {
  if (process.env.ONETHING_SESSION_LIST_BACKFILL === '0') return undefined
  const signal = { aborted: false }
  const timer = setTimeout(() => {
    void runSessionListProjectionBackfill({ signal, isSessionBusy: options.isSessionBusy })
      .then(report => {
        if (report.candidates === 0) return
        log.info('session list projection backfill finished', {
          sessions: report.sessions,
          candidates: report.candidates,
          filled: report.filled,
          skippedBusy: report.skippedBusy,
          skippedNoLedger: report.skippedNoLedger,
          skippedFresh: report.skippedFresh,
          failed: report.failed,
          aborted: report.aborted,
          ms: report.ms,
        })
      })
      .catch(error => log.warn('session list projection backfill crashed', {}, error))
  }, options.delayMs ?? SESSION_LIST_BACKFILL_START_DELAY_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => {
    signal.aborted = true
    clearTimeout(timer)
  }
}
