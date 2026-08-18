/**
 * 会话事件日志 —— 主线 E0 的类型与纯编解码
 * (docs/design/dsh-architecture-adoption-2026-08.md §1.1 / §3 主线 E)。
 *
 * 四条设计铁律,读这个文件时请一直带着:
 *
 * 1. **只记事实,不记结论**。这里只有时刻(`time`),没有 duration、没有
 *    status。"这次工具跑了多久" = 消费者拿 `tool/result.time` 减
 *    `tool/call.time`;"还在执行中" = 有 `tool/call` 而没有配对的
 *    `tool/result`。任何 duration/status 字段都是把结论腌进事实里,禁止新增。
 * 2. **执行前先记账**。`tool/call` 在工具真正执行之前落盘,`argumentsRaw`
 *    存模型给出的原始 JSON 串(不是解析后再序列化的版本)。崩溃时留下的是
 *    "开了头没收尾",而不是什么都没有。
 * 3. **记录"当时模型看到的世界"**。`request/header` 快照那一次请求的
 *    provider/model/system 指纹 + 工具目录指纹,`request/tools` 单独快照工具
 *    schema 目录正文;两者**各自独立去重**,只在自己变了的时候追加。历史调用
 *    因此永远解析到它当时那份 schema,而不是今天的那份。
 *
 *    为什么拆成两条:工具目录序列化 ~40KB 且一次装配内恒定,而 system prompt
 *    会话内会变(变量/上下文注入)。合在一条里,每次 system 一变就陪葬一份没变
 *    的 40KB —— 坏情况一个会话 2MB。拆开后 system 变只写 ~200B 的 header,
 *    目录变才写那 40KB。
 * 4. **追加,永不截断**。这个文件只 append。读侧遇到不认识的 type 就跳过那一
 *    行,绝不回写"清理"文件;遇到崩溃截断的半行就丢弃那半行,前面的照常读出。
 *
 * 本文件是纯逻辑(无 fs、无路径、无会话状态),写入口与路径解析在装配层
 * (`packages/onething-runtime/src/app/session/event-log.ts`)。
 */

import { createHash } from 'node:crypto'
import type { JsonObject } from '@onething/core'

/** 本期(E0)定义的全部事件类型。扩大这个集合需要单独拍板。 */
export const SESSION_EVENT_TYPES = [
  'request/tools',
  'request/header',
  'request/start',
  'assistant/first-token',
  'tool/call',
  'tool/result',
  /**
   * R2b(工具系统重建):一次工具调用的**审计证词**。
   *
   * 它不是第八种"回合事件",而是 `AuditProjector`(`app/toolkit/audit-observer.ts`)
   * 那条投影的落盘口 —— 三条生命周期证词(planned / decided / finished)攒成扁平
   * 的一行:计划里报了哪些效果类、授权结论、人被问过没有、最终结局、拦截器动没
   * 动手。**只在 `ONETHING_TOOLKIT=1` 时出现**;开关关时这个类型一行都不写。
   */
  'tool/audit',
  'request/end',
] as const

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

/** 一次请求里模型看到的单个工具条目(name + description + parameters 三件套)。 */
export interface SessionEventToolSchema {
  name: string
  description?: string
  parameters?: JsonObject
}

/**
 * 那一次请求模型看到的**工具目录正文**。
 *
 * 单独成一条事件,因为它大(~40KB)且几乎不变;`header` 只引用它的指纹。
 * `toolsHash` 冗余存在这里:恢复 recorder 的 `lastToolsHash` 时直接读这个字段,
 * 不用把整个大数组读回来重算一遍。
 */
export interface SessionRequestToolsEventData {
  requestIndex: number
  toolsHash: string
  tools: SessionEventToolSchema[]
}

export interface SessionRequestHeaderEventData {
  requestIndex: number
  provider: string
  model: string
  /** system prompt 的 sha256 前 16 位。存指纹不存正文:正文属于别的账本。 */
  systemPromptHash: string
  /**
   * 工具目录的指纹,指向 seq 更小的那条 `request/tools`(同一 turn-start 里
   * tools 先写、header 后写,所以引用的目录在日志里一定已经有了)。
   */
  toolsHash: string
  /** 会话内首条恒为 initial;之后只有信封变了才追加,reason 记 change。 */
  reason: 'initial' | 'change'
}

export interface SessionRequestStartEventData {
  requestIndex: number
  messageId: string
}

export interface SessionAssistantFirstTokenEventData {
  requestIndex: number
  messageId: string
}

export interface SessionToolCallEventData {
  callId: string
  /** 模型给的原始 arguments JSON 串 —— 原样存,包括它写坏的时候。 */
  argumentsRaw: string
  name: string
  messageId: string
}

export interface SessionToolResultEventData {
  callId: string
  isError: boolean
  resultPreview: string
  /** 对应 `tool/call` 事件的 seq。因果显式引用,不靠"就近配对"猜。 */
  sourceSeq?: number
}

/**
 * 一次工具调用的审计行(R2b)。形状 = `ToolAuditRecord` 去掉 `at`(时刻由记录
 * 外层的 `time` 给,不存两份)。
 */
export interface SessionToolAuditEventData {
  callId: string
  toolId: string
  /** 计划里报的效果类(去重)。资源级细节不进索引 —— 它们在权限卡的 preview 里。 */
  effects: string[]
  /** 效果条数(与 `effects` 不同:同一类可以有多条,资源不同)。 */
  effectCount: number
  previewTitle?: string
  decision?: 'allow' | 'deny'
  /** 人被问过没有。 */
  asked?: boolean
  outcome: 'ok' | 'invalid' | 'denied' | 'aborted' | 'failed'
  intercepted?: { action: 'rewrite' | 'block'; by?: string[] }
  messageId?: string
}

export interface SessionRequestEndUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SessionRequestEndEventData {
  requestIndex: number
  stopReason?: string
  usage?: SessionRequestEndUsage
}

interface SessionEventRecordShape<TType extends SessionEventType, TData> {
  /** 会话内单调递增,从 1 起。 */
  seq: number
  /** Date.now()。只有时刻,没有时长。 */
  time: number
  type: TType
  data: TData
}

export type SessionRequestToolsEvent = SessionEventRecordShape<'request/tools', SessionRequestToolsEventData>
export type SessionRequestHeaderEvent = SessionEventRecordShape<'request/header', SessionRequestHeaderEventData>
export type SessionRequestStartEvent = SessionEventRecordShape<'request/start', SessionRequestStartEventData>
export type SessionAssistantFirstTokenEvent = SessionEventRecordShape<'assistant/first-token', SessionAssistantFirstTokenEventData>
export type SessionToolCallEvent = SessionEventRecordShape<'tool/call', SessionToolCallEventData>
export type SessionToolResultEvent = SessionEventRecordShape<'tool/result', SessionToolResultEventData>
export type SessionToolAuditEvent = SessionEventRecordShape<'tool/audit', SessionToolAuditEventData>
export type SessionRequestEndEvent = SessionEventRecordShape<'request/end', SessionRequestEndEventData>

export type SessionEventRecord =
  | SessionRequestToolsEvent
  | SessionRequestHeaderEvent
  | SessionRequestStartEvent
  | SessionAssistantFirstTokenEvent
  | SessionToolCallEvent
  | SessionToolResultEvent
  | SessionToolAuditEvent
  | SessionRequestEndEvent

export type SessionEventDataFor<TType extends SessionEventType> =
  Extract<SessionEventRecord, { type: TType }>['data']

/** 工具结果预览的截断长度。预览是给人看的锚点,不是结果本身。 */
export const SESSION_EVENT_RESULT_PREVIEW_LIMIT = 500

export function truncateSessionEventPreview(
  text: string,
  limit: number = SESSION_EVENT_RESULT_PREVIEW_LIMIT,
): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

/**
 * system prompt 的指纹:sha256 前 16 位。
 * 存指纹不存正文 —— 事件日志要回答的是"信封变了没有",不是"提示词长什么样"
 * (正文有 provider-requests dump 与 last-system-prompt.txt 两个既有账本)。
 */
export function hashSessionEventSystemPrompt(systemPrompt: string): string {
  return createHash('sha256').update(systemPrompt).digest('hex').slice(0, 16)
}

/**
 * 工具目录的指纹:对数组直接 `JSON.stringify` 后取 sha256 前 16 位。
 *
 * **不做键排序,前提写在这里**:目录是从注册表按注册顺序生成的,一次装配内
 * 顺序稳定;每个条目也是同一个 `toToolSchemas` 按固定字段序造出来的。所以逐字
 * 序列化就是稳定序列化。顺序真变了(装配变了/工具增删了)也确实**该**记一条新
 * 目录 —— 那正是"模型看到的世界变了"。
 *
 * 若哪天目录改成从 Map/Set 之类无序结构生成,这个前提就没了,那时必须在这里
 * 补排序,而不是在调用方补。
 */
export function hashSessionEventTools(tools: readonly SessionEventToolSchema[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16)
}

/** 一行一条,永远以 \n 结尾 —— 半行只可能出现在崩溃截断处。 */
export function encodeSessionEventLine(record: SessionEventRecord): string {
  return `${JSON.stringify(record)}\n`
}

function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
}

/**
 * 解析一行。返回 null 表示"这一行不是本期认识的事件":可能是崩溃截断的半行、
 * 可能是未来版本追加的新类型。两种都跳过,都不导致读取失败。
 */
export function decodeSessionEventLine(line: string): SessionEventRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null
  if (typeof record.time !== 'number' || !Number.isFinite(record.time)) return null
  if (!isSessionEventType(record.type)) return null
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return null
  return record as unknown as SessionEventRecord
}

/**
 * 解析整份日志。容忍尾部半行(进程崩在写一半时),容忍未知类型。
 * 结果按 seq 升序 —— 追加顺序即 seq 顺序,这里只做兜底排序。
 */
export function parseSessionEventLog(text: string): SessionEventRecord[] {
  const records: SessionEventRecord[] = []
  for (const line of text.split('\n')) {
    const record = decodeSessionEventLine(line)
    if (record) records.push(record)
  }
  records.sort((a, b) => a.seq - b.seq)
  return records
}

/**
 * 从日志正文里取某个类型的**最后一条**记录。
 *
 * 先用字符串筛掉不含该 type 的行,只对候选行做 JSON.parse —— header 这类事件
 * 一份日志里通常只有几条,反向扫到第一条就停。
 */
export function findLastSessionEventInLog<TType extends SessionEventType>(
  text: string,
  type: TType,
): Extract<SessionEventRecord, { type: TType }> | undefined {
  const marker = `"type":"${type}"`
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line || !line.includes(marker)) continue
    const record = decodeSessionEventLine(line)
    if (record?.type === type) {
      return record as Extract<SessionEventRecord, { type: TType }>
    }
  }
  return undefined
}

export interface SessionEventLogCounters {
  lastSeq: number
  lastRequestIndex: number
}

/**
 * 从既有文件内容恢复会话内计数器(seq / requestIndex)。
 *
 * 不做 JSON.parse:整份日志可能几 MB,而恢复只需要两个数。正则扫字段够用,
 * 且对半行天然免疫(半行里能扫到的数只会更小,不会更大)。
 */
export function scanSessionEventLogCounters(text: string): SessionEventLogCounters {
  let lastSeq = 0
  let lastRequestIndex = 0
  for (const match of text.matchAll(/"seq":(\d+)/g)) {
    const value = Number(match[1])
    if (value > lastSeq) lastSeq = value
  }
  for (const match of text.matchAll(/"requestIndex":(\d+)/g)) {
    const value = Number(match[1])
    if (value > lastRequestIndex) lastRequestIndex = value
  }
  return { lastSeq, lastRequestIndex }
}

/**
 * 请求信封是否与上一条 header 相同 —— 相同则不写。
 *
 * 比的是 provider / model / systemPromptHash / toolsHash(四个短字符串,
 * 不再逐字比 40KB 的目录正文),不比 requestIndex 与 reason(那两个字段本来
 * 就每次不同)。
 */
export function isSameRequestHeaderEnvelope(
  a: SessionRequestHeaderEventData | undefined,
  b: SessionRequestHeaderEventData,
): boolean {
  if (!a) return false
  if (a.provider !== b.provider) return false
  if (a.model !== b.model) return false
  if (a.systemPromptHash !== b.systemPromptHash) return false
  return a.toolsHash === b.toolsHash
}

export interface SessionToolCallInspection {
  callId: string
  name: string
  argumentsRaw: string
  callTime: number
  callSeq: number
  resultPreview?: string
  isError?: boolean
  resultTime?: number
  /**
   * 该调用发生时,模型看到的这个工具的 schema。取的是 seq 不大于本次调用的
   * 最后一条 `request/tools` —— 工具后来改了 schema,历史调用照旧解析到
   * 当时那一份。拿不到就是 undefined,由 UI 显示 unavailable,绝不回填。
   */
  schema?: SessionEventToolSchema
}

/**
 * 配对某次工具调用的 (参数, 结果, 当时 schema, 起止时刻)。
 * 找不到该 callId 的 `tool/call` 时返回 undefined —— 没有账就是没有账。
 */
export function resolveToolCallInspection(
  events: readonly SessionEventRecord[],
  callId: string,
): SessionToolCallInspection | undefined {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  let call: SessionToolCallEvent | undefined
  for (const event of ordered) {
    if (event.type === 'tool/call' && event.data.callId === callId) {
      call = event
      break
    }
  }
  if (!call) return undefined

  let result: SessionToolResultEvent | undefined
  for (const event of ordered) {
    if (event.type !== 'tool/result') continue
    if (event.data.callId !== callId) continue
    // sourceSeq 是显式因果引用;没带的老记录退回按 callId + 顺序配对。
    if (event.data.sourceSeq !== undefined && event.data.sourceSeq !== call.seq) continue
    if (event.seq < call.seq) continue
    result = event
    break
  }

  // 目录事件按同一条"往回找"的口径:seq 不大于本次调用的最后一条 request/tools。
  let catalog: SessionRequestToolsEvent | undefined
  for (const event of ordered) {
    if (event.type !== 'request/tools') continue
    if (event.seq > call.seq) break
    catalog = event
  }
  const schema = catalog?.data.tools.find(tool => tool.name === call.data.name)

  return {
    callId,
    name: call.data.name,
    argumentsRaw: call.data.argumentsRaw,
    callTime: call.time,
    callSeq: call.seq,
    ...(result
      ? {
          resultPreview: result.data.resultPreview,
          isError: result.data.isError,
          resultTime: result.time,
        }
      : {}),
    ...(schema ? { schema } : {}),
  }
}
