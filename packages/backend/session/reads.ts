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
import {
  deepFreeze,
  materializeModelHistory,
  type ProjectModelHistoryMeta,
  type ProjectModelHistoryOptions,
} from '@onething/core/session'
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
import { countSessionReadFallback } from './event-stats.js'
import { isSessionFreezeEnabled } from './freeze.js'
import { isSessionEventsReadMode } from './read-mode.js'
import { getLiveSessionProjection } from './projection-cache.js'
import { sessionProjectionOptions } from './projection-blobs.js'
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
 * 兜底半边的**命中遥测**(S3w-1,§15.4)。零行为变化,只记一个数。
 *
 * 每个 routed 方法的 `?? getSessionMessages(...)` 都裹一层这个:`events` 模式
 * 下走到右边 = 事件里折不出这条会话的历史(未迁移 / legacy 整文件 / 物化出错),
 * 于是产品线的这一次读仍然走在抄本上。S3w-3 要删掉这批兜底,而**删之前必须先
 * 量到 0** —— 今天它是完全静默的。
 *
 * 两条不计的:
 *  - `messages` 模式 —— 那时每一次读都从这里过,数它没有意义;
 *  - **抄本也是空的** —— 刚建的会话、还没说第一句话的会话,两侧都没有历史。
 *    那不是"兜底救了一次",那是"这条会话还什么都没有"。把它算进去,这个数
 *    永远到不了 0,门也就永远没有判据(battery 实测:不加这一条会计出 820 次,
 *    全部是空会话的例行读)。
 *
 * **曾经的结构性地板,已归位**(§15.9 诊断 1 → §15.18 → §15.19):写 `run/start`
 * **之前**读助手占位消息的那类取材点 —— 那条 assistant 此刻在事件账本里还没有产地
 * (翻译器故意不翻 `isStreaming` 的 assistant,`run/start` 才是它的那一格),于是
 * `fromEvents` 恒折不出、每次必然掉进兜底。它们本来就是 §14.1 表里的"写侧读抄本",
 * 按批 7 的纪律该走 `getMessageFromTranscript`(那口不经过 `fromEvents`,也就不算兜底)。
 *  - `stream-executor.ts:194`(run 开张前读占位)—— 批 6 前置已改(§15.18):
 *    battery 321 → 16。
 *  - `agent-loop-executor.ts` 的 `rotateAssistantWriterIdentity`(steer 换锚点,
 *    刚 `addMessage` 就读回来喂自己那一格 `run/start`)是它的孪生 —— 批 6a 已改
 *    (§15.19),余下的 16 出自这里,改完 battery `fallbackHits` 落到 0。
 *
 * 于是 S3w-3 删兜底的判据("命中率量成 0")现在是干净的:再有非零读数,就真的是
 * "事件里折不出这段历史"了。
 */
function fallbackCarriesHistory(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return value > 0
  if (typeof value === 'object') {
    const messages = (value as { messages?: unknown }).messages
    return Array.isArray(messages) ? messages.length > 0 : true
  }
  return true
}

function transcriptFallback<T>(value: T): T {
  if (isSessionEventsReadMode() && fallbackCarriesHistory(value)) countSessionReadFallback()
  return value
}

/**
 * `sliceForHistory` 的模型历史构造由宿主注入(S2b step C)。
 *
 * 为什么是注入而不是直接 import:`sliceForHistory` 的两条路都要走真机那份历史
 * 构造 —— 消息侧是 `buildHistoryMessages`,事件侧是 `projectModelHistory` 的宿主
 * 配方(`historyProjectionRecipe`)。这两样都住在 `wiring/engine/stream/
 * message-helpers.ts`,身后是整棵 provider/collab/agents 树。而 `reads.ts` 被
 * ~30 个轻量会话层模块(`commands.ts` / `validation.ts` / permission / usage /
 * tasks …)与它们的单测静态引用 —— 一旦这里 `import` 了 message-helpers,那些
 * "只 mock 了 stores/paths"的单测会当场把整棵树拉起来炸掉(与 history-shadow.ts
 * 用回调避开 recorder→message-helpers 是同一条纪律)。所以宿主在
 * `configureAppRuntimeAdapters()` 里把这两个函数装进来,`reads.ts` 只留一个端口。
 */
export interface SessionHistoryBuilder {
  /** 消息侧(抄本切片 → 真机历史):`buildHistoryMessages(messages, session)`。 */
  fromMessages(
    messages: readonly ChatMessage[],
    session: Readonly<ChatSession> | undefined,
  ): readonly unknown[]
  /** 事件侧的宿主配方(`historyProjectionRecipe`):喂给 `projectModelHistory`。 */
  recipe(session: Readonly<ChatSession> | undefined): ProjectModelHistoryOptions<unknown>
}

let historyBuilder: SessionHistoryBuilder | undefined

/** 装上模型历史构造器(宿主在 `configureAppRuntimeAdapters()` 里调,幂等)。 */
export function configureSessionHistoryBuilder(builder: SessionHistoryBuilder | undefined): void {
  historyBuilder = builder
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
    const messages = fromEvents(() => eventsListMessages(sessionId))
      ?? transcriptFallback(getSessionMessages(sessionId))
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

  /**
   * **抄本侧**按 id 取一条 —— 永远来自 `messages.jsonl`,**故意不经过 `fromEvents`**
   * (F11,与 `listMessagesFromTranscript` 同款纪律)。
   *
   * 这是事件写侧(命令面 + 翻译器)取材的**唯一合法读法**:`user/message-edited` 等
   * 事件正要由这次翻译写出,此刻活投影(§13.18 发现 B)还停在编辑前,走 `getMessage`
   * 的 `fromEvents` 岔口会回读到旧正文并把它焊进账本。写侧读真相面,永不随读模式分岔。
   */
  getMessageFromTranscript(
    sessionId: string,
    messageId: string,
  ): Readonly<ChatMessage> | undefined {
    const message = getSessionMessages(sessionId)?.find(item => item.id === messageId)
    return message ? guard(message) : undefined
  },

  /** **抄本侧**按谓词查一条(F11:同 `getMessageFromTranscript`,事件写侧取材用)。 */
  findMessageFromTranscript(
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

  /** 不加载整会话的分页(pager 走存储驱动)。 */
  pageMessages(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse {
    return fromEvents(() => eventsPageMessages(request))
      ?? transcriptFallback(getSessionMessagesPage(request))
  },

  /** 用户消息锚点(会话目录 / 跳转用)。 */
  listUserMarkers(sessionId: string): readonly UserMessageMarker[] | undefined {
    return fromEvents(() => eventsListUserMarkers(sessionId))
      ?? transcriptFallback(getSessionUserMessageMarkers(sessionId));
  },

  getMessage(sessionId: string, messageId: string): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsGetMessage(sessionId, messageId))
    if (fromEventLog) return guard(fromEventLog)
    const message = transcriptFallback(getSessionMessages(sessionId))?.find(item => item.id === messageId)
    return message ? guard(message) : undefined
  },

  findMessage(
    sessionId: string,
    predicate: (message: ChatMessage, index: number) => boolean,
    options: { from?: 'start' | 'end' } = {},
  ): Readonly<ChatMessage> | undefined {
    const messages = fromEvents(() => eventsListMessages(sessionId))
      ?? transcriptFallback(getSessionMessages(sessionId))
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
    return transcriptFallback(getSessionMessages(sessionId))?.findIndex(item => item.id === messageId) ?? -1
  },

  countMessages(sessionId: string): number {
    const fromEventLog = fromEvents(() => eventsCountMessages(sessionId))
    if (fromEventLog !== undefined) return fromEventLog
    return transcriptFallback(getSessionMessages(sessionId))?.length ?? 0
  },

  lastMessageOfRole(sessionId: string, role: ChatMessage['role']): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsLastMessageOfRole(sessionId, role))
    if (fromEventLog) return guard(fromEventLog)
    const messages = transcriptFallback(getSessionMessages(sessionId))
    if (!messages) return undefined
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === role) return guard(messages[index])
    }
    return undefined
  },

  /** 第一条用户消息的预览文本(标题回退 / 列表预览;server 那三份实现的归口)。 */
  firstUserPreview(sessionId: string, maxLength = 120): string | undefined {
    const messages = fromEvents(() => eventsListMessages(sessionId))
      ?? transcriptFallback(getSessionMessages(sessionId))
    return sessionPreviewText(messages ?? [], maxLength)
  },

  /**
   * 下一次请求发出去的那份**模型历史**(S2b step C)。
   *
   * 两条路都产出**真机形状的历史**(provider 消息),而不是 `ChatMessage` 切片:
   *  - `messages` 模式:抄本切片过宿主的 `buildHistoryMessages`(注入的
   *    `historyBuilder.fromMessages`)—— 与今天真机发出去的那一份逐字节相同;
   *  - `events` 模式:走 `projectModelHistory`(这里 = 活投影上的
   *    `materializeModelHistory`)+ **同一份**宿主配方。§S2b #5 的裁定:事件版的
   *    落点是 `projectModelHistory`,**不是"再抄一遍投影"**(那是可见消息投影,
   *    压缩会话上与模型历史不同)。两侧因此逐字节相同 —— 这正是切读的安全前提,
   *    也是历史影子(`checkSessionHistoryShadow`)比的那两份。
   *
   * `historyBuilder` 未装(纯轻量单测,没跑装配)时退回抄本 `ChatMessage` 切片,
   * 保住 P0.1 的老形状;`upToMessageId` 落在 `events` 路上暂不支持(要按 seq 折,
   * 无调用点),退回消息模式。
   */
  sliceForHistory(
    sessionId: string,
    options: { upToMessageId?: string; includeUpTo?: boolean } = {},
  ): readonly unknown[] {
    const session = getSession(sessionId)
    const fromEventLog = fromEvents(() => {
      if (!historyBuilder) return undefined
      // upToMessageId 的事件版要按 seq 折(无调用点),退回消息模式。
      if (options.upToMessageId) return undefined
      const state = getLiveSessionProjection(sessionId)
      if (state.nodes.length === 0) return undefined
      const meta: ProjectModelHistoryMeta = session
        ? {
            id: session.id,
            ...(session.summary ? { summary: session.summary } : {}),
            ...(session.summaryUpToMessageId
              ? { summaryUpToMessageId: session.summaryUpToMessageId }
              : {}),
          }
        : {}
      const projectModelHistoryOptions: ProjectModelHistoryOptions<unknown> = {
        ...historyBuilder.recipe(session),
        ...sessionProjectionOptions(sessionId),
      };
      return materializeModelHistory(state, meta, projectModelHistoryOptions)
    })
    if (fromEventLog !== undefined) return fromEventLog

    const messages = transcriptFallback(getSessionMessages(sessionId))
    if (!messages) return []
    const slice = !options.upToMessageId
      ? messages
      : (() => {
          const index = messages.findIndex(message => message.id === options.upToMessageId)
          if (index === -1) return messages
          return messages.slice(0, options.includeUpTo === false ? index : index + 1)
        })()
    // 装了构造器 = 归一到真机历史形状;没装则保住抄本切片(老形状)。
    return historyBuilder ? historyBuilder.fromMessages(slice, session) : guard(slice)
  },

  /** 不物化整份数组的遍历(搜索 / 媒体 / 权限扫描)。 */
  *iterateMessages(sessionId: string): Generator<Readonly<ChatMessage>> {
    const messages = fromEvents(() => eventsListMessages(sessionId))
      ?? transcriptFallback(getSessionMessages(sessionId))
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
