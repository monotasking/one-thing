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
import {
  decodeSessionLogEventLine,
  encodeSessionLogEventLine,
  SESSION_LEGACY_EVENT_TYPES,
} from '@onething/core/session'
import type {
  SessionAssistantFirstTokenEvent,
  SessionAssistantFirstTokenEventData,
  SessionEventToolSchema,
  SessionLegacyEventRecord,
  SessionLogEventRecord,
  SessionRequestEndEvent,
  SessionRequestEndEventData,
  SessionRequestEndUsage,
  SessionRequestHeaderEvent,
  SessionRequestHeaderEventData,
  SessionRequestStartEvent,
  SessionRequestStartEventData,
  SessionRequestToolsEvent,
  SessionRequestToolsEventData,
  SessionToolAuditEvent,
  SessionToolAuditEventData,
  SessionToolCallEvent,
  SessionToolCallEventData,
  SessionToolResultEvent,
  SessionToolResultEventData,
} from '@onething/core/session'

/**
 * ── S0 之后的分工(docs/design/session-event-sourcing-2026-08.md §9)────────
 *
 * **类型与行编解码已上移到 `packages/core/session/events/`**(core 零依赖,
 * renderer 也能直接引)。本文件保留的是:
 *  - 既有名字的**再导出**(盘上格式与全部消费者逐字不变);
 *  - 需要 `node:crypto` 的指纹函数(core 里不许有 node 依赖);
 *  - 轨迹面板的检视工具(`resolveToolCallInspection`)。
 *
 * `SessionEventRecord` 在这里**仍然只是 E0 的七类**。v2 的全集叫
 * `SessionLogEventRecord`,从 `@onething/core/session` 取 —— 这样轨迹面板、
 * shared 层那个契约面与 rpc 域的类型面一动不动,而 S1 接新事件时
 * 是显式换类型,不是被联合悄悄放大。
 */

/** E0 定义的七类。v2 全集见 `SESSION_LOG_EVENT_TYPES`(core)。 */
export const SESSION_EVENT_TYPES = SESSION_LEGACY_EVENT_TYPES

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

export type {
  SessionEventToolSchema,
  SessionRequestToolsEventData,
  SessionRequestHeaderEventData,
  SessionRequestStartEventData,
  SessionAssistantFirstTokenEventData,
  SessionToolCallEventData,
  SessionToolResultEventData,
  SessionToolAuditEventData,
  SessionRequestEndUsage,
  SessionRequestEndEventData,
  SessionRequestToolsEvent,
  SessionRequestHeaderEvent,
  SessionRequestStartEvent,
  SessionAssistantFirstTokenEvent,
  SessionToolCallEvent,
  SessionToolResultEvent,
  SessionToolAuditEvent,
  SessionRequestEndEvent,
}

export type SessionEventRecord = SessionLegacyEventRecord

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
 * 任意正文的指纹:sha256 前 16 位。
 *
 * 与 `hashSessionEventSystemPrompt` 同一条算法 —— 分成两个名字是因为它们回答
 * 的是不同的问题(信封变了没有 / 这段正文是哪一段),而调用点看名字就该知道
 * 自己在问哪一个。
 */
export function hashSessionEventContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
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
  return encodeSessionLogEventLine(record as SessionLogEventRecord)
}

function isSessionEventType(value: unknown): value is SessionEventType {
  return typeof value === 'string' && (SESSION_EVENT_TYPES as readonly string[]).includes(value)
}

/**
 * 解析一行。返回 null 表示"这一行不是**七类**":崩溃截断的半行、形状不对的行,
 * 以及 v2 新增的类型 —— 后者对这条读路径而言就是"未来版本的新类型",按铁律 4
 * 跳过。要读全集用 `decodeSessionLogEventLine`(core)。
 *
 * 解析本身走 core 的那一份,这里只在出口按七类再筛一道:两个解码器分叉的话,
 * 同一行在两条路上会得到不同结论,那正是最难查的一类 bug。
 */
export function decodeSessionEventLine(line: string): SessionEventRecord | null {
  const record = decodeSessionLogEventLine(line)
  if (!record) return null
  return isSessionEventType(record.type) ? (record as SessionEventRecord) : null
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
