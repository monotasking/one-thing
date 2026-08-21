/**
 * 影子断言(S1b,`docs/design/session-event-sourcing-2026-08.md` §10.4)。
 *
 * S1 的整个赌注是一句话:**从事件投影出来的东西,与今天 messages.jsonl 那份
 * 事实,是同一件事**。这个模块就是那句话的自证 —— 每个 run 收尾比一次消息,
 * 每次请求发出前比一次模型历史,不等就往 `<store>/log/session-shadow.jsonl`
 * 记一行字段级摘要,并把计数加进 `session-shadow-stats.json`。S2 切读路径的
 * 前提是这张表连续 200 个 run 干净。
 *
 * ## 三条纪律
 *
 * 1. **永不抛进引擎**。所有出口 try/catch 自吞:影子算错了最坏的结果是账记歪,
 *    绝不能是聊天挂掉。
 * 2. **便宜**。活投影按会话缓存,每次只折**新事件**(写入口把刚分配 seq 的记录
 *    挂在尾巴上,见 `event-log.ts` 的 `drainSessionLogEventTail`);消息侧只取
 *    这一个 run 的那几条,不整份重算。
 * 3. **不许调绿**。`canonicalChatMessage` 是唯一判据(它把"不等但不算数"的那
 *    部分一次性写死);这里不再额外豁免字段。真的不等就是真的不等 —— 那正是
 *    这道门存在的理由。
 * 4. **真相侧永远是抄本**(F11,§13.2)。取数只走
 *    `sessionReads.listMessagesFromTranscript` —— 它无视 `ONETHING_SESSION_READ`。
 *    走 `listMessages` 的话,读模式一切到 `events`,两侧就都是投影:自己跟自己
 *    比,永远相等,门以**错误的理由**变绿。切了读模式之后这道比对**照跑不误**
 *    (它比的始终是"抄本 vs 投影",与谁在给产品供数无关)——S2b 之后它就是
 *    那道回头看的迁移账。
 *
 * ## 关闸
 *
 * `ONETHING_SESSION_SHADOW=0` 关掉比对与记账(事件照旧落盘)。缺省开。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalChatMessage,
  canonicalHistoryMessages,
  materializeModelHistory,
  materializeNode,
  type ProjectionNode,
  type ProjectModelHistoryMeta,
  type ProjectModelHistoryOptions,
} from '@onething/core/session'
import {
  getOnethingLogDir,
} from '@onething/runtime/storage'
import {
  getLiveSessionProjection,
  peekSessionProjection,
  resetSessionProjectionCache,
} from './projection-cache.js'
import { bumpSessionShadowStats, isSessionShadowEnabled } from './event-stats.js'
import { sessionProjectionOptions } from './projection-blobs.js'
import { sessionReads } from './reads.js'
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

export type SessionShadowKind = 'messages' | 'history'

export interface SessionShadowDiffEntry {
  /** 字段路径,如 `1.contentParts.0.content`。 */
  path: string
  /** messages.jsonl 那一侧(事实)。 */
  a?: string
  /** 事件投影那一侧。 */
  b?: string
}

export interface SessionShadowRecord {
  time: number
  sessionId: string
  runId?: string
  kind: SessionShadowKind
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

function appendShadowLine(record: SessionShadowRecord): void {
  try {
    fs.mkdirSync(getOnethingLogDir(), { recursive: true })
    fs.appendFileSync(getSessionShadowLogPath(), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 影子日志写不进去不该再制造第二条错误路径(计数仍然进了 stats)。
  }
}

/**
 * F9(§13.2):**同一个 run 里同一处不等只记一次。**
 *
 * 历史断言是**每次请求**跑的(那正是它的正确性所在:第 2 轮发出去的历史和第 1 轮
 * 不是同一份)。但一个真实的不等——比如某条老消息的附件没回填——在一个 12 轮的
 * run 里会被原样记 12 次:`mismatches` 通胀 12 倍,`shadow.jsonl` 里 12 行一模一样
 * 的摘要,报告的 top10 变成"谁的回合多"排行榜。
 *
 * 指纹 = `kind` + 摘要本身(摘要已经是 ≤2KB 的字段级差异)。**同一个 run 里出现
 * 另一处不等照记不误** —— 折叠的是重复,不是不等。
 */
const RUN_DEDUPE_MAX_RUNS = 200
const seenRunMismatches = new Map<string, Set<string>>()

function dedupeKey(sessionId: string, runId: string | undefined): string {
  return `${sessionId}|${runId ?? '-'}`
}

/** @returns 这条不等是不是**新的**(旧的只计 `duplicateMismatches`,不进门)。 */
function rememberMismatch(sessionId: string, runId: string | undefined, signature: string): boolean {
  const key = dedupeKey(sessionId, runId)
  let seen = seenRunMismatches.get(key)
  if (!seen) {
    seen = new Set()
    seenRunMismatches.set(key, seen)
    // Map 是插入序的:满了就丢最老的那个 run(它早就收尾了)。
    while (seenRunMismatches.size > RUN_DEDUPE_MAX_RUNS) {
      const oldest = seenRunMismatches.keys().next()
      if (oldest.done) break
      seenRunMismatches.delete(oldest.value)
    }
  }
  if (seen.has(signature)) return false
  seen.add(signature)
  return true
}

/** 会话删除 / 测试:忘掉"这个 run 记过什么"。 */
export function resetSessionShadowDedupe(): void {
  seenRunMismatches.clear()
}

function recordMismatch(
  sessionId: string,
  kind: SessionShadowKind,
  runId: string | undefined,
  a: unknown,
  b: unknown,
): void {
  const { diff, truncated } = summarizeShadowDiff(a, b)
  const signature = `${kind}|${JSON.stringify(diff)}|${truncated}`
  if (!rememberMismatch(sessionId, runId, signature)) {
    bumpSessionShadowStats({ duplicateMismatches: 1 })
    return
  }
  appendShadowLine({
    time: Date.now(),
    sessionId,
    ...(runId ? { runId } : {}),
    kind,
    diff,
    ...(truncated ? { truncated } : {}),
  })
  bumpSessionShadowStats({ mismatches: 1, byKind: { [kind]: 1 } })
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

// ============ 事件覆盖面(老会话的豁免) ============

/**
 * 这条会话的 `events.jsonl` **覆盖不全**吗?
 *
 * S1a 之前就存在的会话,事件日志是从升级那一刻才开始写的 —— 它只覆盖了历史的
 * 一段尾巴。对这种会话跑历史断言,比出来的永远是"事实 101 条 / 投影 1 条",
 * 那不是投影错了,是**没有可比的东西**(真机第一天 12 次不等里有 10 次是它,
 * 见 §10.9)。
 *
 * 判据是**消息侧有、事件侧不认识的 id**:messages.jsonl 里那些消息,投影的
 * `byMessageId` 一个都不该少。少了就说明前面那段历史没有对应的事件。
 * (比"第一条事件是不是 `session/created`"更直接:后者只认得出"从中间开始",
 * 认不出"中间掉了一段"。)
 *
 * 判定**每会话只做一次并缓存 `true`**:事件只增不减,一条会话一旦是"覆盖不全"
 * 就永远是。判成完整的则每次重算 —— 那正是这道断言要盯的东西,不能缓存掉。
 */
const legacyPartialSessions = new Set<string>()

export function sessionEventCoverageIsPartial(
  sessionId: string,
  state: { byMessageId: Map<string, unknown> },
): boolean {
  if (legacyPartialSessions.has(sessionId)) return true
  // F11:真相侧只认抄本。走 `listMessages` 的话,`ONETHING_SESSION_READ=events`
  // 一开这份"事实"就是投影自己 —— 每条 id 当然都认得,永远判成"覆盖完整"。
  const messages = sessionReads.listMessagesFromTranscript(sessionId)
  for (const message of messages) {
    if (!state.byMessageId.has(message.id)) {
      legacyPartialSessions.add(sessionId)
      return true
    }
  }
  return false
}

/** 会话删除 / 测试:忘掉"覆盖不全"的判定(顺带清掉这条会话的不等指纹)。 */
export function resetSessionShadowCoverageCache(sessionId?: string): void {
  if (sessionId) legacyPartialSessions.delete(sessionId)
  else legacyPartialSessions.clear()
  resetSessionShadowDedupe()
}

/** 一次跳过:只记账,不进 `mismatches`(门不受影响)。 */
function countSkip(reason: 'legacyPartial'): 'skipped' {
  bumpSessionShadowStats({ skipped: { [reason]: 1 } })
  return 'skipped'
}

// ============ run 断言(kind: 'messages') ============

export interface SessionRunShadowInput {
  runId: string
  assistantMessageId: string
  /** 触发这次执行的那条用户消息 —— 它与助手那条一起构成"这个 run 的消息"。 */
  triggerMessageId?: string
}

function nodeMessageId(node: ProjectionNode): string {
  return node.messageId
}

/**
 * 一个 run 收尾时的消息断言。**同步**执行(调用方负责把它挪出热路径)。
 *
 * @returns 'match' | 'mismatch' | 'skipped'(关闸 / 这条会话不记账 / 出错)
 */
export function checkSessionRunShadow(
  sessionId: string,
  input: SessionRunShadowInput,
): 'match' | 'mismatch' | 'skipped' {
  if (!isSessionShadowEnabled()) return 'skipped'
  try {
    const state = getLiveSessionProjection(sessionId)
    // 这条会话一条事件都没有(legacy 整文件会话)= 没有可比的东西。
    if (state.nodes.length === 0) return 'skipped'

    const selected = new Set<string>([input.assistantMessageId])
    if (input.triggerMessageId) selected.add(input.triggerMessageId)

    // F11:真相侧永远是 `messages.jsonl`(见 `listMessagesFromTranscript` 的注释)。
    const actual = sessionReads.listMessagesFromTranscript(sessionId).filter(
      message => selected.has(message.id) || message.runId === input.runId,
    )
    for (const message of actual) selected.add(message.id)

    // run 断言在老会话上照常跑 —— 这个 run 自己的消息**是**事件覆盖的。
    // 唯一的例外是触发消息比事件还老(对一条老消息 retry / edit-resend):
    // 事实侧有它、投影侧没有,比出来是"少一条"而不是"投影错了"。
    if (input.triggerMessageId
      && !state.byMessageId.has(input.triggerMessageId)
      && actual.some(message => message.id === input.triggerMessageId)) {
      return countSkip('legacyPartial')
    }

    const projected = state.nodes.filter(node => {
      if (node.hidden) return false
      if (node.kind === 'assistant' && node.runId === input.runId) return true
      return selected.has(nodeMessageId(node))
    })

    // 两侧都空 = 这个 run 在两份账里都不存在(图片流之外不该发生),不算数。
    if (actual.length === 0 && projected.length === 0) return 'skipped'

    const a = actual.map(message => canonicalChatMessage(message as unknown as Record<string, unknown>))
    // A8/A9(§13.6):blob 回放已经在物化里了(附件 base64、工具大结果、生图
    // 正文全走同一份选项),这里不再补第二刀。
    const materialize = sessionProjectionOptions(sessionId)
    const b = projected.map(node =>
      canonicalChatMessage(materializeNode(node, materialize) as unknown as Record<string, unknown>),
    )

    if (deepEqual(a, b)) {
      bumpSessionShadowStats({ runs: 1 })
      return 'match'
    }
    recordMismatch(sessionId, 'messages', input.runId, a, b)
    return 'mismatch'
  } catch (error) {
    log.warn('run assertion failed', { sessionId }, error)
    return 'skipped'
  }
}

/**
 * 把 run 断言挪到响应交付之后再跑(§10.4:"不在热路径上")。
 *
 * `setTimeout(0)` 而不是 `queueMicrotask`:微任务仍然在同一个宏任务里,它前面
 * 排着的正是把最后一批 chunk 发给渲染层的那些回调。
 */
export function scheduleSessionRunShadow(sessionId: string, input: SessionRunShadowInput): void {
  if (!isSessionShadowEnabled()) return
  const timer = setTimeout(() => {
    checkSessionRunShadow(sessionId, input)
  }, 0)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
}

// ============ 历史断言(kind: 'history') ============

export interface SessionHistoryShadowInput {
  runId?: string
  /**
   * **抄本侧**的那一份历史(`messages.jsonl` 的消息过 `buildHistoryMessages`)。
   *
   * 默认读模式下它就是"今天真正发出去的那一份";切到 `events` 读模式之后产品线
   * 发的是投影那一份,而这道断言的两侧口径**不变**(F11):始终是"抄本 vs 投影"。
   */
  actual: readonly unknown[]
  /** 老会话的摘要锚点(没有 `session/compacted` 事件时投影才读它)。 */
  meta?: ProjectModelHistoryMeta
  /**
   * 宿主注入的**整份配方** —— 必须与真实请求走**同一组函数**(G8 的"落点与
   * 回放同一函数")。传别的进来,这道断言就只是在比两份不同的构造法。
   *
   * F5(§13.2):这里原来只声明了三格(`buildMessageContent` / `getAIToolName` /
   * `failureResultForAI`),而宿主配方 `historyProjectionRecipe` 还带着
   * `prepareMessages`(房投影 / goal drive 折叠 / 用户消息上模型面)与
   * `providerDataFromContentPart`——它们只是**顺着 spread 活下来的**,类型上
   * 一格都没记着。哪天有人按类型重构一次这个入参,那两格会静默消失:两侧从此
   * 比的是两种构造法,而门照绿(不等的那一份被 `legacyPartial` 之外的任何理由
   * 掩盖不掉,但"两侧同时少了同一遍预处理"恰恰仍然相等)。所以类型必须把
   * 配方的**全集**写出来。
   */
  build?: Pick<
    ProjectModelHistoryOptions<unknown>,
    | 'buildMessageContent'
    | 'getAIToolName'
    | 'failureResultForAI'
    | 'prepareMessages'
    | 'providerDataFromContentPart'
  >
}

/**
 * 下一次请求发出前的历史断言。
 *
 * 比的是**序列化之后的字节**:两侧都是 provider 形状的历史数组,任何一处不同
 * 都意味着"投影切读之后模型会看到另一段历史"。投影侧走的是活投影(O(新事件)),
 * 物化仍是 `buildHistoryMessages` 本人 —— 不是抄一份。
 */
export function checkSessionHistoryShadow(
  sessionId: string,
  input: SessionHistoryShadowInput,
): 'match' | 'mismatch' | 'skipped' {
  if (!isSessionShadowEnabled()) return 'skipped'
  try {
    const state = getLiveSessionProjection(sessionId)
    if (state.nodes.length === 0) return 'skipped'
    // 老会话的事件只覆盖了历史的尾巴 —— 迁移之前这道断言对它没有意义。
    if (sessionEventCoverageIsPartial(sessionId, state)) return countSkip('legacyPartial')

    const projected = materializeModelHistory(state, input.meta ?? {}, {
      ...(input.build ?? {}),
      ...sessionProjectionOptions(sessionId),
    })

    const a = canonicalHistory(input.actual)
    const b = canonicalHistory(projected as readonly unknown[])
    // F9(b):历史断言**每次请求**跑一遍,它的次数与 `runs`(每个 run 一次)
    // 不是一回事 —— 分开记,报告里两个数都看得见,谁也别替谁说话。
    bumpSessionShadowStats({ historyChecks: 1 })
    if (a === b) return 'match'

    recordMismatch(sessionId, 'history', input.runId, JSON.parse(a), JSON.parse(b))
    return 'mismatch'
  } catch (error) {
    log.warn('history assertion failed', { sessionId }, error)
    return 'skipped'
  }
}

/**
 * 判据住在 core(`canonicalHistoryMessages`,与 `canonicalChatMessage` 并排)——
 * S0 的合同测试与这里的影子断言必须用**同一把尺**,各写一份迟早分叉。
 */
export const canonicalHistory = canonicalHistoryMessages
