/**
 * 耐久门(refold)的**记录面** —— 差异摘要 + `session-shadow.jsonl` 的写入口。
 *
 * ## 恒等门已经退役(F4-c c4,§16.24)
 *
 * 这个文件从 S1b 起是**恒等门**:每个 run 收尾比一次消息(`kind: 'messages'`)、
 * 每次请求发出前比一次模型历史(`kind: 'history'`),两侧是「事件投影(真相 a)」
 * 与「内存 store(reducer 推导,验证器 b)」两条**独立推导**。它为 F0–F4-c 的整条
 * 写模型翻转全程护航。
 *
 * c4 把它按 §16.2 / §16.19 映射表的原定归宿退役了:
 *
 *  - **产品读路早已只走投影**(S2b + S3w-3 批 6b:`listMessages` / `getMessage` /
 *    `pageMessages` … 全部 `fromEvents`),store 不再是任何一条产品读的真相来源;
 *  - 因此验证器侧那一口(`sessionReads.listMessagesFromStore`)**没有了消费者**,
 *    留着它只会让门"自己跟自己比"—— 以错误的理由变绿(F11 判据污染的反面)。
 *  - 告别对账的读数记在 §16.24:退役**之前**最后一次全量 battery 是
 *    runs 321 / historyChecks 433 / mismatches 0,真机只读 verify 无新增条目。
 *
 * 退役掉的是**比对**,不是记账:`refold`(耐久层,§14.3-B / S3w-2)是唯一常驻的
 * 门,它比的是「`events.jsonl` 的文件字节重折」vs「内存活投影」—— 两条与 store
 * 无关的独立路径,与恒等门问的从来不是同一件事。它写的那一行仍然走这里的
 * `summarizeShadowDiff` / `appendSessionShadowLine`,统计仍然进
 * `session-shadow-stats.json` 的 `refoldChecks` / `refoldMismatches`。
 *
 * ## 两条纪律(留下来的那半边照旧)
 *
 * 1. **永不抛进引擎**。所有出口 try/catch 自吞:门算错了最坏的结果是账记歪,
 *    绝不能是聊天挂掉。
 * 2. **不许调绿**。`canonicalChatMessage` 是唯一判据(它把"不等但不算数"的那
 *    部分一次性写死);这里不再额外豁免字段。
 *
 * ## 关闸
 *
 * `ONETHING_SESSION_SHADOW=0` 关掉记账(事件照旧落盘)。缺省开。
 * refold 自己另有一道 `ONETHING_SESSION_REFOLD=0`(两道门问的不是同一件事)。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  getOnethingLogDir,
} from '@onething/runtime/storage'
import {
  peekSessionProjection,
  resetSessionProjectionCache,
} from './projection-cache.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions.shadow')


export const SESSION_SHADOW_LOG_FILENAME = 'session-shadow.jsonl'

/** 一行摘要的硬上限(§10.4)。超了就砍字段,不砍成半个 JSON。 */
/**
 * 缺省 2KB(§10.4 的硬上限)。`ONETHING_SHADOW_DIFF_BYTES` / `_DIFF_MAX` 只在
 * **查一次不等**的时候临时放宽 —— 12 条摘要够定位类别,不够定位细节。
 */
const DIFF_BUDGET_BYTES = Number(process.env.ONETHING_SHADOW_DIFF_BYTES) || 2048
/** 一行最多列几处不同 —— 前 N 处足够定位类别,列全只会把日志变成第二份数据。 */
const DIFF_MAX_ENTRIES = Number(process.env.ONETHING_SHADOW_DIFF_MAX) || 12
/** 单个值的展示长度。 */
const DIFF_VALUE_CHARS = 120

/**
 * 一行记录属于哪一类断言。
 *
 * - `refold` —— 耐久层(§14.3-B,S3w-2):`events.jsonl` 的**文件字节**重折
 *   (**真相 a**)vs 内存活投影(**b**),两条**独立路径**。
 * - `port` —— 端口事实断言(c4,`port-fact-assert.ts`):某个
 *   `sessionMessageRuntime` 端口的入参(**b**)vs 活投影上同一格的折叠值
 *   (**a**)。它是恒等门退役之后"A 类端口的事实已经在流上"那句话的逐格替身。
 *
 * - `account` —— **会话账对拍**(§17.7.1 批 2 / #8b-i)。**批 3 起不再产生**:
 *   切换之后老 reducer 没有了,"两条独立推导"的另一侧随之消失。会话账的耐久
 *   判据改由 `refold` 那一栏承担(文件字节重折的会话账 ≡ 内存活账),取值留着
 *   是为了读得懂批 3 之前的老日志。
 *
 * **老日志里仍然读得到 `'messages'` / `'history'` 两个取值** —— 那是 c4 之前记的
 * 行,读日志的脚本按字符串认,不靠这个联合类型。
 */
export type SessionShadowKind = 'refold' | 'port' | 'account'

/**
 * 方向标记(F0,§16.2):`a` 侧代表谁。
 *
 * 今天只有一个取值 —— 事件账本。**老记录没有这个字段**,那是转向前的方向
 * (a = store 真相 / b = 投影影子)。留成联合类型的形状是给读日志的脚本一个
 * 显式判据,而不是让它靠时间戳猜。
 */
export const SESSION_SHADOW_TRUTH = 'events' as const
export type SessionShadowTruth = typeof SESSION_SHADOW_TRUTH

export interface SessionShadowDiffEntry {
  /** 字段路径,如 `1.contentParts.0.content`。 */
  path: string
  /** **真相侧**:事件投影(`refold` 类里是 `events.jsonl` 的文件重折)。 */
  a?: string
  /** **验证器侧**:内存 store / reducer(`refold` 类里是内存活投影)。 */
  b?: string
}

export interface SessionShadowRecord {
  time: number
  sessionId: string
  runId?: string
  kind: SessionShadowKind
  /**
   * `a` 侧代表谁(F0)。写入口统一盖章,不由各采集点自己填;**缺这个字段的行 =
   * F0 转向之前记的**,两列的语义正好相反。
   */
  truth?: SessionShadowTruth
  diff: SessionShadowDiffEntry[]
  /** 摘要被预算截断时的剩余处数。 */
  truncated?: number
}

export function getSessionShadowLogPath(): string {
  return path.join(getOnethingLogDir(), SESSION_SHADOW_LOG_FILENAME)
}

// ============ 差异摘要 ============

function short(value: unknown): string {
  if (value === undefined) return '(absent)'
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) return '(absent)'
  return text.length > DIFF_VALUE_CHARS ? `${text.slice(0, DIFF_VALUE_CHARS)}…(${text.length})` : text
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 字段级深比较。**先比再记**:相等就一处都不产出(这是热路径上最常见的结局),
 * 不等就把路径与两侧的短值记下来,攒够 `DIFF_MAX_ENTRIES` 就停 —— 一次不等
 * 常常是几百处同源的不等,列全对定位毫无帮助。
 */
function collectDiff(
  a: unknown,
  b: unknown,
  at: string,
  out: SessionShadowDiffEntry[],
  overflow: { count: number },
): void {
  if (out.length >= DIFF_MAX_ENTRIES) {
    if (!deepEqual(a, b)) overflow.count += 1
    return
  }
  if (a === b) return

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: `${at}.length`, a: String(a.length), b: String(b.length) })
    }
    const max = Math.max(a.length, b.length)
    for (let index = 0; index < max; index++) {
      collectDiff(a[index], b[index], at ? `${at}.${index}` : String(index), out, overflow)
    }
    return
  }

  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const key of keys) {
      collectDiff(a[key], b[key], at ? `${at}.${key}` : key, out, overflow)
    }
    return
  }

  if (deepEqual(a, b)) return
  out.push({ path: at || '(root)', a: short(a), b: short(b) })
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every(key => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * 两侧(canonical 之后)的字段级摘要,**≤ 2KB**。
 *
 * 入参次序即列次序:`a` = 真相侧(事件 / 文件重折),`b` = 验证器侧(store /
 * 内存活投影)。F0 之后所有调用点都按这个次序传。
 *
 * 预算是按序列化后的字节算的:一条日志行要能被人一眼读完,也要能被脚本
 * `JSON.parse` —— 所以砍的是"少列几处",不是"把最后一处截一半"。
 */
export function summarizeShadowDiff(
  a: unknown,
  b: unknown,
): { diff: SessionShadowDiffEntry[]; truncated: number } {
  const out: SessionShadowDiffEntry[] = []
  const overflow = { count: 0 }
  collectDiff(a, b, '', out, overflow)

  let diff = out
  let truncated = overflow.count
  while (diff.length > 0 && Buffer.byteLength(JSON.stringify(diff), 'utf8') > DIFF_BUDGET_BYTES) {
    diff = diff.slice(0, diff.length - 1)
    truncated += 1
  }
  return { diff, truncated }
}

/**
 * 往 `<store>/log/session-shadow.jsonl` 记一行。
 *
 * 导出是给 `refold.ts` 用的:refold 是**另一道门**(耐久层),但它记的还是
 * "两侧对不上"这同一件事,应该落在同一份文件里让人一眼看全 —— 各写一份
 * append 逻辑迟早在路径/容错上分叉。
 */
export function appendSessionShadowLine(record: SessionShadowRecord): void {
  // F0:方向标记在**唯一**的写入口盖章 —— 各采集点自己填迟早漏一处,而漏掉的
  // 那一行会被读日志的人当成转向前的老记录。
  const line: SessionShadowRecord = { ...record, truth: record.truth ?? SESSION_SHADOW_TRUTH }
  try {
    fs.mkdirSync(getOnethingLogDir(), { recursive: true })
    fs.appendFileSync(getSessionShadowLogPath(), `${JSON.stringify(line)}\n`, 'utf8')
  } catch {
    // 影子日志写不进去不该再制造第二条错误路径(计数仍然进了 stats)。
  }
}

// ============ 活投影 ============

/**
 * 活投影搬去了 `projection-cache.ts`(S2a)。
 *
 * 理由是写入口那条尾巴是**取走式**的:S2a 的读路径也要同一份投影,两份缓存
 * 会互相偷走对方的记录。这里只留两个转发名字,断言的写法一字未动。
 */
export const resetSessionShadowCache = resetSessionProjectionCache

/** 仅测试:直接看某条会话的活投影(不推进)。 */
export const peekSessionShadowProjection = peekSessionProjection
