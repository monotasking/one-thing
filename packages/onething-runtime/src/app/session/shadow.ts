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
  createSessionProjectionState,
  materializeModelHistory,
  materializeNode,
  reduceSessionProjection,
  resolveHistoryBlobRefs,
  type ProjectionNode,
  type ProjectModelHistoryMeta,
  type ProjectModelHistoryOptions,
  type SessionProjectionState,
} from '@onething/core/session'
import { getLogDir } from '../stores/paths.js'
import { drainSessionLogEventTail, readSessionLogEventsSync } from './event-log.js'
import { bumpSessionShadowStats, isSessionShadowEnabled } from './event-stats.js'
import { readSessionBlobText } from './blob-store.js'
import { sessionReads } from './reads.js'

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
  return path.join(getLogDir(), SESSION_SHADOW_LOG_FILENAME)
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
    fs.mkdirSync(getLogDir(), { recursive: true })
    fs.appendFileSync(getSessionShadowLogPath(), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 影子日志写不进去不该再制造第二条错误路径(计数仍然进了 stats)。
  }
}

function recordMismatch(
  sessionId: string,
  kind: SessionShadowKind,
  runId: string | undefined,
  a: unknown,
  b: unknown,
): void {
  const { diff, truncated } = summarizeShadowDiff(a, b)
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

interface LiveProjection {
  state: SessionProjectionState
  /** 已经折进 state 的最后一条 seq。 */
  lastSeq: number
}

const projections = new Map<string, LiveProjection>()

/**
 * 这条会话的活投影,**推进到此刻**。
 *
 * 第一次用的时候从文件同步折一遍(冷加载 / 进程重启后的会话);之后每次只
 * 取走写入口挂着的那一小段。尾巴溢出过(见 `event-log.ts`)就重折一次 ——
 * 宁可付一次全量,也不能拿一份缺了一段的投影去比对。
 */
function liveProjection(sessionId: string): SessionProjectionState {
  let live = projections.get(sessionId)
  if (!live) {
    live = { state: createSessionProjectionState(), lastSeq: 0 }
    for (const event of readSessionLogEventsSync(sessionId)) {
      live.state = reduceSessionProjection(live.state, event)
      live.lastSeq = Math.max(live.lastSeq, event.seq)
    }
    projections.set(sessionId, live)
    // 首次是从文件折的,写入口那条尾巴里的记录已经在文件里(或即将写进去),
    // 丢掉它以免同一条被折两次。
    const drained = drainSessionLogEventTail(sessionId)
    for (const event of drained.records) {
      if (event.seq <= live.lastSeq) continue
      live.state = reduceSessionProjection(live.state, event)
      live.lastSeq = event.seq
    }
    return live.state
  }

  const { records, overflowed } = drainSessionLogEventTail(sessionId)
  if (overflowed) {
    projections.delete(sessionId)
    return liveProjection(sessionId)
  }
  for (const event of records) {
    if (event.seq <= live.lastSeq) continue
    live.state = reduceSessionProjection(live.state, event)
    live.lastSeq = event.seq
  }
  return live.state
}

/** 会话删除 / 测试:丢掉活投影。 */
export function resetSessionShadowCache(sessionId?: string): void {
  if (sessionId) {
    projections.delete(sessionId)
    return
  }
  projections.clear()
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

/** 把投影出的消息里的 `BlobRef` 换回正文 —— 落点与回放同一函数(G8)。 */
function resolveBlobs(sessionId: string, message: Record<string, unknown>): Record<string, unknown> {
  return resolveHistoryBlobRefs(
    message as never,
    ref => readSessionBlobText(sessionId, ref.hash),
  ) as unknown as Record<string, unknown>
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
    const state = liveProjection(sessionId)
    // 这条会话一条事件都没有(legacy 整文件会话)= 没有可比的东西。
    if (state.nodes.length === 0) return 'skipped'

    const selected = new Set<string>([input.assistantMessageId])
    if (input.triggerMessageId) selected.add(input.triggerMessageId)

    const actual = sessionReads.listMessages(sessionId).messages.filter(
      message => selected.has(message.id) || message.runId === input.runId,
    )
    for (const message of actual) selected.add(message.id)

    const projected = state.nodes.filter(node => {
      if (node.hidden) return false
      if (node.kind === 'assistant' && node.runId === input.runId) return true
      return selected.has(nodeMessageId(node))
    })

    // 两侧都空 = 这个 run 在两份账里都不存在(图片流之外不该发生),不算数。
    if (actual.length === 0 && projected.length === 0) return 'skipped'

    const a = actual.map(message => canonicalChatMessage(message as unknown as Record<string, unknown>))
    const b = projected.map(node =>
      canonicalChatMessage(resolveBlobs(sessionId, materializeNode(node) as unknown as Record<string, unknown>)),
    )

    if (deepEqual(a, b)) {
      bumpSessionShadowStats({ runs: 1 })
      return 'match'
    }
    recordMismatch(sessionId, 'messages', input.runId, a, b)
    return 'mismatch'
  } catch (error) {
    console.warn(`[SessionShadow] run assertion failed for ${sessionId}:`, error)
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
  /** 今天真正发出去的那一份(recipe 的输入过 `buildHistoryMessages`)。 */
  actual: readonly unknown[]
  /** 老会话的摘要锚点(没有 `session/compacted` 事件时投影才读它)。 */
  meta?: ProjectModelHistoryMeta
  /**
   * 宿主注入的三件套 —— 必须与真实请求走**同一个函数**(G8 的"落点与回放同一
   * 函数")。传别的进来,这道断言就只是在比两份不同的构造法。
   */
  build?: Pick<
    ProjectModelHistoryOptions<unknown>,
    'buildMessageContent' | 'getAIToolName' | 'failureResultForAI'
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
    const state = liveProjection(sessionId)
    if (state.nodes.length === 0) return 'skipped'

    const projected = materializeModelHistory(state, input.meta ?? {}, {
      ...(input.build ?? {}),
      resolveBlob: ref => readSessionBlobText(sessionId, ref.hash),
    })

    const a = canonicalHistory(input.actual)
    const b = canonicalHistory(projected as readonly unknown[])
    if (a === b) return 'match'

    recordMismatch(sessionId, 'history', input.runId, JSON.parse(a), JSON.parse(b))
    return 'mismatch'
  } catch (error) {
    console.warn(`[SessionShadow] history assertion failed for ${sessionId}:`, error)
    return 'skipped'
  }
}

/**
 * 判据住在 core(`canonicalHistoryMessages`,与 `canonicalChatMessage` 并排)——
 * S0 的合同测试与这里的影子断言必须用**同一把尺**,各写一份迟早分叉。
 */
export const canonicalHistory = canonicalHistoryMessages

/** 仅测试:直接看某条会话的活投影(不推进)。 */
export function peekSessionShadowProjection(sessionId: string): SessionProjectionState | undefined {
  return projections.get(sessionId)?.state
}
