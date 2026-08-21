/**
 * 会话消息读门面 —— docs/design/session-commands-p0-2026-08.md §3。
 *
 * 与 `commands.ts` 并列的另一半:命令面之外,**只有这里**允许持有
 * `session.messages`。13 个方法,返回值一律 `readonly`;开发期(见 `freeze.ts`)
 * 深冻结,漏网的就地改当场炸。
 *
 * P0.1 是薄的:每个方法就是把今天散在各处的读法搬到一个名字下面,语义**一字不改**
 * —— 尤其是 `scanSessionsForSearch` 明确保留 `getSessionRaw` 语义(不进 LRU、不
 * sanitize、不回写),它与 `getSession` 的差别是真实的,不合并。
 * P0.2 才把 C1–C7 的调用点迁过来。
 */

import type {
  ChatMessage,
  ChatSession,
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  UserMessageMarker,
} from '@shared/ipc.js'
import fs from 'node:fs'
import path from 'node:path'
import { deepFreeze } from '@onething/core/session'
import { sanitizeOnethingMessagesForRendererResult } from '@onething/runtime/sessions'
import {
  getSession,
  getSessionMessages,
  getSessionMessagesPage,
  getSessionRaw,
  getSessionUserMessageMarkers,
  getSessions,
  readSessionTranscriptFile,
} from '../stores/sessions.js'
import {
  getOnethingSessionsDir,
} from '@onething/runtime/storage'
import {
  eventsCountMessages,
  eventsGetMessage,
  eventsGetMessageIndex,
  eventsLastMessageOfRole,
  eventsListMessages,
  eventsListUserMarkers,
  eventsPageMessages,
} from './events-reads.js'
import { isSessionFreezeEnabled } from './freeze.js'
import { isSessionEventsReadMode } from './read-mode.js'
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('sessions')


export interface ListMessagesOptions {
  /** 去掉 provider-data part(交给 renderer 的那一份) */
  sanitize?: boolean
}

export interface ListMessagesResult {
  messages: readonly ChatMessage[]
  /** sanitize 是否真的动过东西(取代今天靠 `===` 比引用的判断,F9) */
  changed: boolean
}

function guard<T>(value: T): T {
  return isSessionFreezeEnabled() ? deepFreeze(value) : value
}

/**
 * `events` 模式的取数(S2a,§11.1)。
 *
 * 七个方法各有一行这样的岔口:开关在 `events` 上、且这条会话的事件里真的有
 * 历史时,答案从投影来;否则(默认 / 老会话)一字不改地走原来那条路。
 * **岔口只在这一层**:再往下的仓库、驱动、pager 都不知道有第二种读法。
 */
function fromEvents<T>(read: () => T | undefined): T | undefined {
  if (!isSessionEventsReadMode()) return undefined
  try {
    return read()
  } catch (error) {
    log.warn('events-mode read failed, falling back to messages', {}, error)
    return undefined
  }
}

/**
 * 会话列表的预览文本 —— **全仓唯一口径**(P0.4,用户 2026-08-19 拍板统一到桌面端):
 * 第一条 user 消息,`trim()` 后取前 `maxLength` 字,超长补 `…`,空串给 undefined。
 *
 * 纯函数是必需的:server 有两只互不相识的仓库(app 那只 / echo 自己那只),
 * 按 sessionId 的 `firstUserPreview` 只认得前者。
 */
export function sessionPreviewText(
  messages: readonly ChatMessage[],
  maxLength = 120,
): string | undefined {
  const first = messages.find(message => message.role === 'user')
  if (!first) return undefined
  const text = typeof first.content === 'string' ? first.content.trim() : ''
  if (!text) return undefined
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

export const sessionReads = {
  /** 一条会话的全部消息。`sanitize` 打开时同时告诉调用方"到底动没动"。 */
  listMessages(sessionId: string, options: ListMessagesOptions = {}): ListMessagesResult {
    const messages = fromEvents(() => eventsListMessages(sessionId)) ?? getSessionMessages(sessionId)
    if (!messages) return { messages: [], changed: false }
    if (!options.sanitize) return { messages: guard(messages), changed: false }
    // F9:`changed` 由 sanitizer 自己带回来,不再靠 `===` 比引用。
    const sanitized = sanitizeOnethingMessagesForRendererResult(messages)
    return { messages: guard(sanitized.value ?? messages), changed: sanitized.changed }
  },

  /**
   * **抄本侧**的那一份消息 —— 永远来自 `messages.jsonl`,与读模式无关(F11)。
   *
   * 这不是 `listMessages` 的一个便利别名,而是影子断言唯一合法的**真相侧**取数。
   * `listMessages` 自 S2a 起带着 `ONETHING_SESSION_READ=events` 的岔口:开关一开,
   * 它返回的就是事件投影本身 —— 影子拿它当"事实"去比"投影",两侧同源,门以
   * 错误的理由变绿(F11:判据污染)。所以这里**故意不经过 `fromEvents`**。
   *
   * 改动这个方法的人请先回答一个问题:影子的两侧还是两个来源吗?一旦这里也接上
   * 事件读法,`sessions:shadow-battery` 会在 `shadow-read-mode.test.ts` 上当场红
   * —— 那条用例把读模式钉在 `events` 上,故意让抄本与事件分岔,断言影子**必须**
   * 报出来。
   */
  listMessagesFromTranscript(sessionId: string): readonly ChatMessage[] {
    return guard(getSessionMessages(sessionId) ?? [])
  },

  /** 不加载整会话的分页(pager 走存储驱动)。 */
  pageMessages(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse {
    return fromEvents(() => eventsPageMessages(request)) ?? getSessionMessagesPage(request)
  },

  /** 用户消息锚点(会话目录 / 跳转用)。 */
  listUserMarkers(sessionId: string): readonly UserMessageMarker[] | undefined {
    return fromEvents(() => eventsListUserMarkers(sessionId)) ?? getSessionUserMessageMarkers(sessionId);
  },

  getMessage(sessionId: string, messageId: string): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsGetMessage(sessionId, messageId))
    if (fromEventLog) return guard(fromEventLog)
    const message = getSessionMessages(sessionId)?.find(item => item.id === messageId)
    return message ? guard(message) : undefined
  },

  findMessage(
    sessionId: string,
    predicate: (message: ChatMessage, index: number) => boolean,
    options: { from?: 'start' | 'end' } = {},
  ): Readonly<ChatMessage> | undefined {
    const messages = getSessionMessages(sessionId)
    if (!messages) return undefined
    if (options.from === 'end') {
      for (let index = messages.length - 1; index >= 0; index--) {
        if (predicate(messages[index], index)) return guard(messages[index])
      }
      return undefined
    }
    const found = messages.find(predicate)
    return found ? guard(found) : undefined
  },

  getMessageIndex(sessionId: string, messageId: string): number {
    const fromEventLog = fromEvents(() => eventsGetMessageIndex(sessionId, messageId))
    if (fromEventLog !== undefined) return fromEventLog
    return getSessionMessages(sessionId)?.findIndex(item => item.id === messageId) ?? -1
  },

  countMessages(sessionId: string): number {
    const fromEventLog = fromEvents(() => eventsCountMessages(sessionId))
    if (fromEventLog !== undefined) return fromEventLog
    return getSessionMessages(sessionId)?.length ?? 0
  },

  lastMessageOfRole(sessionId: string, role: ChatMessage['role']): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsLastMessageOfRole(sessionId, role))
    if (fromEventLog) return guard(fromEventLog)
    const messages = getSessionMessages(sessionId)
    if (!messages) return undefined
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === role) return guard(messages[index])
    }
    return undefined
  },

  /** 第一条用户消息的预览文本(标题回退 / 列表预览;server 那三份实现的归口)。 */
  firstUserPreview(sessionId: string, maxLength = 120): string | undefined {
    return sessionPreviewText(getSessionMessages(sessionId) ?? [], maxLength)
  },

  /**
   * 送进模型历史构建的那一份切片。P0.1 只是把 6 处
   * `history.buildMessages(session.messages, session)` 的取数收到一个名字下面;
   * S 线的 `projectModelHistory` 落点就是这里。
   */
  sliceForHistory(
    sessionId: string,
    options: { upToMessageId?: string; includeUpTo?: boolean } = {},
  ): readonly ChatMessage[] {
    const messages = getSessionMessages(sessionId)
    if (!messages) return []
    if (!options.upToMessageId) return guard(messages)
    const index = messages.findIndex(message => message.id === options.upToMessageId)
    if (index === -1) return guard(messages)
    return guard(messages.slice(0, options.includeUpTo === false ? index : index + 1))
  },

  /** 不物化整份数组的遍历(搜索 / 媒体 / 权限扫描)。 */
  *iterateMessages(sessionId: string): Generator<Readonly<ChatMessage>> {
    const messages = getSessionMessages(sessionId)
    if (!messages) return
    for (const message of messages) yield guard(message)
  },

  /**
   * 跨会话扫描时**按会话取消息**(区 ② 补):与 `scanSessionsForSearch` 同族的
   * raw 语义(不进 LRU、不 sanitize、不回写)。全库消息搜索一次会翻 N 间会话,
   * 用 `iterateMessages`(走 `getSession` → LRU + sanitize + 可能回写)会把整个
   * 会话库灌进 LRU —— 差别是真实的,所以给它自己的名字。
   */
  *iterateMessagesRaw(sessionId: string): Generator<Readonly<ChatMessage>> {
    const session = getSessionRaw(sessionId)
    if (!session?.messages) return
    for (const message of session.messages) yield guard(message)
  },

  /**
   * 跨会话扫描(全局搜索 / 索引)。**明确是 raw 语义**:不进 LRU、不 sanitize、
   * 不回写 —— 与 `getSession` 的差别是真实的(见 §7 的竞态注释),不合并。
   */
  *scanSessionsForSearch(sessionIds?: readonly string[]): Generator<Readonly<ChatSession>> {
    if (!sessionIds) {
      for (const session of getSessions()) yield session
      return
    }
    for (const sessionId of sessionIds) {
      const session = getSessionRaw(sessionId)
      if (session) yield session
    }
  },

  /** 原始 jsonl 抄本(collab 的两处绕驱动直读的归口)。 */
  readTranscriptFile(sessionId: string): string | undefined {
    return readSessionTranscriptFile(sessionId)
  },

  /**
   * 同一份抄本的**字节形态**(P0.2 ③ 补):`history` 工具要把它喂给
   * `scanJsonlLog`(收 `Uint8Array`)并按**盘上真实字节数**记账单房的读入上限。
   * 走 `readTranscriptFile` 再 `Buffer.from` 等于对每间房多解码/编码一遍
   * (一次跨房检索 5–20 间 × 200–350KB),而字节数还会因为非法 utf-8 的替换字符
   * 与盘上对不齐 —— 所以读门面直接给字节。
   */
  readTranscriptBuffer(sessionId: string): Uint8Array | undefined {
    try {
      return fs.readFileSync(path.join(getOnethingSessionsDir(), sessionId, 'messages.jsonl'))
    } catch {
      return undefined
    }
  },

  /** 整会话(命令面之外唯一允许拿到会话体的地方)。 */
  getSession(sessionId: string): Readonly<ChatSession> | undefined {
    return getSession(sessionId)
  },
}

export type SessionReads = typeof sessionReads
