/**
 * 预览的**共用件**(S4a)。
 *
 * 设计:docs/design/search-index-2026-09.md §4.5(媒介开放 / 基数开放 / 零副作用)。
 *
 * 这个文件里**没有任何一种能力的名字** —— 它只有三样东西:
 *
 *  1. 各 `kind` 的载荷形(`message-context` / `session-overview` / `note-excerpt` /
 *     `file-excerpt`)。载荷是**跨进程**的(要过 JSON 到壳里去),所以一律纯数据:
 *     没有类实例、没有函数、没有 `undefined` 以外的空。
 *  2. 从候选身上把目标载荷取出来的那一句(`targetPayloadOf`)—— `Candidate.target`
 *     的形是**开放**的(`{ kind: string; payload: unknown }`),取的时候必须验一遍,
 *     不能 `as` 一下就用:候选可能来自插件能力。
 *  3. 「算不出」的原话(`PreviewUnavailableError`)。§4.5 ⑤ 要的是「error(原话)」,
 *     所以这里抛一个**带人话的错**,由 `SearchService.preview` 捞成
 *     `{ success:false, error }` —— 不吞成空预览(空预览会被画成「这条什么都没有」,
 *     那是在撒谎)。
 *
 * ## 零副作用是这一层的硬规矩
 *
 * §4.5 ④ 的原话:预览不改已读、不改会话打开态、不写最近、不改播放队列、不触发
 * 文件 mtime。落到代码上就是三条禁令,每一条在各能力的 `preview` 实现处都再写一遍
 * 判据:**消息**只走 `adapters.iterateSessionMessages`(raw 语义:不进 LRU、不
 * sanitize、不回写);**笔记**只 `readFile`(读不改 mtime,atime 归文件系统的挂载
 * 选项,不是我们能控制的一格,也不是产品可感知的状态);**文件**这一类干脆连读都
 * 不读 —— 后端只给路径,壳按查看器的 peek 态画(§4.5 ②那张表最后一行)。
 */

import type { Candidate } from '@onething/core/search'

/** 预览算不出时的原话。壳把它照抄到 error 态那一行上(§4.5 ⑤)。 */
export class PreviewUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewUnavailableError'
  }
}

/* ── 载荷形 ────────────────────────────────────────────────────────────── */

/**
 * 预览里的一条消息。**它不是 `ChatMessage`** —— 预览要过 JSON,而且只画正文,
 * 所以这里是一次刻意的收窄:四格,一格都不多驮。
 */
export interface PreviewMessage {
  id: string
  /** 'user' / 'assistant' / …;产地怎么说就怎么带,这一层不翻译。 */
  role: string
  /** 正文。非字符串的 `content`(多模态那些)在这一层是空串 —— 与旧扫描路同一刀。 */
  text: string
  timestamp?: number
}

/** `kind: 'message-context'` 的载荷:命中那条 ± N 条。 */
export interface MessageContextPreview {
  sessionId: string
  messageId: string
  hit: PreviewMessage
  /** 命中之前的最多 N 条,**按时间正序**(离命中最近的排在最后)。 */
  before: PreviewMessage[]
  /** 命中之后的最多 N 条,按时间正序。 */
  after: PreviewMessage[]
}

/** `kind: 'session-overview'` 的载荷:一间会话的概览(便宜,随候选带)。 */
export interface SessionOverviewPreview {
  sessionId: string
  title: string
  messageCount: number
  updatedAt: number
  /** 首条用户消息的截断(`SessionMeta.previewText`);没有就是空串。 */
  preview: string
}

/** `kind: 'note-excerpt'` 的载荷:一篇笔记里命中行的上下文。 */
export interface NoteExcerptPreview {
  path: string
  title: string
  /** 命中行 ±N 行拼成的一段;判不出命中行时是文件开头那几行。 */
  excerpt: string
}

/**
 * `kind: 'file-excerpt'` 的载荷:**只有路径**。
 *
 * 后端不读文件正文,理由不是省事:文件这一类的预览就是查看器的 peek 态
 * (§4.5 ②「文件类的预览一律复用查看器注册表」),而查看器已经会按类型分发到
 * 文本 / 代码 / 图片 / 媒体 / PDF —— 后端再读一遍正文,等于在查看器旁边立第二个
 * 「文件长什么样」的产地,而且对图片 / 视频这些根本是错的(不该把字节搬过来)。
 */
export interface FileExcerptPreview {
  path: string
}

/* ── 从候选身上取目标载荷 ──────────────────────────────────────────────── */

/**
 * 这条候选的 `target` 是不是那个 kind,是的话把 payload 交出来。
 *
 * **验而不信**:`target` 的形是开放的,插件能力也在同一张注册表上,所以这里不许
 * `as` 一下就用。不是那个 kind、或 payload 不是对象 → `undefined`,由调用方决定
 * 是跳过还是抛原话。
 */
export function targetPayloadOf(candidate: Candidate, kind: string): Record<string, unknown> | undefined {
  const target = candidate.target
  if (target.kind !== kind) return undefined
  const payload = target.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  return payload as Record<string, unknown>
}

/** payload 上那一格必须是非空字符串,否则这条候选画不出预览。 */
export function requireStringField(
  payload: Record<string, unknown> | undefined,
  field: string,
  what: string,
): string {
  const value = payload?.[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PreviewUnavailableError(`${what} 上没有 ${field},画不出预览`)
  }
  return value
}

/** `candidates[0]`;一条都没有时抛原话(基数由请求说,能力这一层只管有没有)。 */
export function firstCandidate(candidates: Candidate[]): Candidate {
  const first = candidates[0]
  if (first === undefined) throw new PreviewUnavailableError('没有指定要预览哪一条')
  return first
}
