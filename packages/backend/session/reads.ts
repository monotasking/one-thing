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
import { isSessionFreezeEnabled } from './freeze.js'
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
 * 事件投影的取数(S2a,§11.1;S3w-3 批 6b 收成唯一路)。
 *
 * 从前这里是个岔口:`ONETHING_SESSION_READ` 在 `events` 上才走投影,否则退回
 * `messages.jsonl`,而每个 routed 方法右边都挂着一个 `?? getSessionMessages(...)`
 * 兜底。**两样都已删**(§15.22):开关烧了(§15.8 批 6 的唯一确认点),兜底的
 * 命中率在批 6a 之后量成 0 —— 结构性地板(写侧读占位)两处已归位,剩下的非零
 * 读数才真的是"事件里折不出这段历史",而那种会话在真机上是零(400 间已
 * `message/imported`、33 间原生覆盖、10 间空壳)。legacy 整文件会话按裁定 9b
 * 在冷加载那一刻就被迁进事件账本,不再需要读路兜。
 *
 * **出错仍然吞**:一次物化异常不该把整个会话面炸掉,调用方拿到 `undefined` 走
 * 各自的空值语义(从前那句 "falling back to messages" 已经不成立 —— 没有第二侧
 * 可退了,所以 warn 的措辞也改了)。
 */
function fromEvents<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch (error) {
    log.warn('events projection read failed', {}, error)
    return undefined
  }
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
   * `listMessages` 自 S2a 起从事件投影取数(批 6b 之后是唯一路)—— 影子拿它当
   * "事实"去比"投影",两侧同源,门以错误的理由变绿(F11:判据污染)。所以这里
   * **故意不经过 `fromEvents`**。
   *
   * 改动这个方法的人请先回答一个问题:影子的两侧还是两个来源吗?一旦这里也接上
   * 事件读法,`sessions:shadow-battery` 会在 `shadow-read-mode.test.ts` 上当场红
   * —— 那条用例故意让抄本与事件分岔,断言影子**必须**报出来。
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

  /**
   * 不加载整会话的分页(pager 走事件账本的 pager)。
   *
   * 右边那条**不是抄本兜底**(S3w-3 批 6b 删的是那种):这个方法的返回值不可空,
   * 而事件侧对"还没有任何消息事件的会话"(刚建的、空壳的)返回 `undefined` ——
   * 一个**空页的形状**总得有人给出来,仓库的 pager 就是它。它取的是同一份内存
   * store(自 S3w-1 起由投影补水),不是第二份真相。
   */
  pageMessages(request: GetSessionMessagesPageRequest): GetSessionMessagesPageResponse {
    return fromEvents(() => eventsPageMessages(request))
      ?? getSessionMessagesPage(request)
  },

  /** 用户消息锚点(会话目录 / 跳转用)。右边同 `pageMessages`:空会话的形状口。 */
  listUserMarkers(sessionId: string): readonly UserMessageMarker[] | undefined {
    return fromEvents(() => eventsListUserMarkers(sessionId))
      ?? getSessionUserMessageMarkers(sessionId);
  },

  getMessage(sessionId: string, messageId: string): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsGetMessage(sessionId, messageId))
    return fromEventLog ? guard(fromEventLog) : undefined
  },

  findMessage(
    sessionId: string,
    predicate: (message: ChatMessage, index: number) => boolean,
    options: { from?: 'start' | 'end' } = {},
  ): Readonly<ChatMessage> | undefined {
    const messages = fromEvents(() => eventsListMessages(sessionId))
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
    return fromEvents(() => eventsGetMessageIndex(sessionId, messageId)) ?? -1
  },

  countMessages(sessionId: string): number {
    return fromEvents(() => eventsCountMessages(sessionId)) ?? 0
  },

  lastMessageOfRole(sessionId: string, role: ChatMessage['role']): Readonly<ChatMessage> | undefined {
    const fromEventLog = fromEvents(() => eventsLastMessageOfRole(sessionId, role))
    return fromEventLog ? guard(fromEventLog) : undefined
  },

  /** 第一条用户消息的预览文本(标题回退 / 列表预览;server 那三份实现的归口)。 */
  firstUserPreview(sessionId: string, maxLength = 120): string | undefined {
    const messages = fromEvents(() => eventsListMessages(sessionId))
    return sessionPreviewText(messages ?? [], maxLength)
  },

  /**
   * 下一次请求发出去的那份**模型历史**(S2b step C)。
   *
   * 主路走 `projectModelHistory`(这里 = 活投影上的 `materializeModelHistory`)+
   * 宿主配方。§S2b #5 的裁定:事件版的落点是 `projectModelHistory`,**不是"再抄
   * 一遍投影"**(那是可见消息投影,压缩会话上与模型历史不同)。
   *
   * **下面那条 store 切片路不是"读抄本的兜底"**(S3w-3 批 6b 删的是那种),它是
   * **能力缺口**的退路,两个成因都与"事实在哪一侧"无关:
   *  - `historyBuilder` 未装 —— 纯轻量单测没跑装配,退回 `ChatMessage` 切片保住
   *    P0.1 的老形状;
   *  - 给了 `upToMessageId` —— 事件版要按 seq 折,至今没有调用点,没写。
   * 而 `getSessionMessages` 取的是**内存 store**(自 S3w-1 起由投影补水),不是
   * `messages.jsonl` —— 它和主路同源,不是第二份真相。
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

    const messages = getSessionMessages(sessionId)
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
