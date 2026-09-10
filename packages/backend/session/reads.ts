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
import type * as SessionStore from '../stores/sessions.js'
import type { SessionEventReads, SessionTailPageSnapshot } from './events-reads.js'
import type { SessionPageResultSlot } from './page-results.js'
import type { SessionProjectionCache } from './projection-cache.js'
import { getCurrentBackend } from '../current.js'
import { isSessionFreezeEnabled } from './freeze.js'
import type { sessionProjectionOptions } from './projection-blobs.js'
import { getLogger } from '../wiring/logging/index.js'
import { readLegacySessionMessages } from './legacy-reads.js'

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
 * **今天仍然剩下的那一格**(工单 4 A4):`messagesForRead` 右边还留着一条旧抄本
 * 读法,但它**只在投影折出来是空的时候**才轮得到 —— 那是「这条会话还没有
 * `events.jsonl`」这一种情形(`readLegacySessionMessages` 见到账本就自己交白卷)。
 * 顺序不能反:抄本排在投影前面,等于让一份只读化石去盖住今天的唯一账本。
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
  /** 消息侧(store 切片 → 真机历史):`buildHistoryMessages(messages, session)`。 */
  fromMessages(
    messages: readonly ChatMessage[],
    session: Readonly<ChatSession> | undefined,
  ): readonly unknown[]
  /** 事件侧的宿主配方(`historyProjectionRecipe`):喂给 `projectModelHistory`。 */
  recipe(session: Readonly<ChatSession> | undefined): ProjectModelHistoryOptions<unknown>
}

/** Compatibility setter; the history recipe is owned by the active layer. */
export function configureSessionHistoryBuilder(builder: SessionHistoryBuilder | undefined): void {
  getCurrentBackend('sessionLayer').sessionLayer.reads.configureHistoryBuilder(builder)
}

export interface SessionReadPorts {
  store: Pick<typeof SessionStore, 'getSession' | 'getSessionMessages' | 'getSessionMessagesPage' | 'getSessionRaw' | 'getSessionUserMessageMarkers' | 'getSessions' | 'readSessionTranscriptFile'>
  events: Pick<SessionEventReads, 'eventsToolResult' | 'eventsCountMessages' | 'eventsGetMessage' | 'eventsGetMessageIndex' | 'eventsLastMessageOfRole' | 'eventsListMessages' | 'eventsListUserMarkers' | 'eventsPageMessages' | 'eventsPageMessagesAtWatermark'>
  getProjection: SessionProjectionCache['getLiveSessionProjection']
  materializeOptions: typeof sessionProjectionOptions
  getSessionsDir(): string
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

export function createSessionReads(ports: SessionReadPorts, initialHistoryBuilder?: SessionHistoryBuilder) {
  let historyBuilder = initialHistoryBuilder
  let disposed = false
  const assertActive = (): void => {
    if (disposed) throw new Error('Session read layer has been disposed')
  }
  /**
   * 「这条会话没有旧抄本可读」——**只缓存这一种答案**(工单 4 A4)。
   *
   * `readLegacySessionMessages` 每问一次要拍 1–3 次 `existsSync`,而它对今天的会话
   * 恒答 undefined:每一次列消息都在白交这几次系统调用。缓存只记否定答案,所以
   * 不会有「迁移完了还端出化石」那种陈旧:账本一旦出现,答案本来就变成 undefined。
   * 会话删除时由 `createSessionLayer` 清掉这一格。
   */
  const legacySourceAbsent = new Set<string>()
  const legacyMessages = (id: string) => {
    if (legacySourceAbsent.has(id)) return undefined
    const messages = fromEvents(() => readLegacySessionMessages(ports.getSessionsDir(), id))
    if (messages === undefined) legacySourceAbsent.add(id)
    return messages
  }
  /**
   * **投影优先,抄本只兜空**(工单 4 A4)。倒过来写(抄本 `??` 投影)的后果是:
   * 一条既有 `messages.jsonl` 化石又有 `events.jsonl` 账本的老会话,读到的是化石 ——
   * 今天的账本才是唯一真相。`readLegacySessionMessages` 自己也守着同一条线(见到
   * `events.jsonl` 就交白卷),这里是第二道。
   */
  const messagesForRead = (id: string) => {
    const projected = fromEvents(() => ports.events.eventsListMessages(id))
    if (projected && projected.length > 0) return projected
    return legacyMessages(id) ?? projected
  }
  const sessionReads = {
  /** 一条会话的全部消息。`sanitize` 打开时同时告诉调用方"到底动没动"。 */
  listMessages(sessionId: string, options: ListMessagesOptions = {}): ListMessagesResult {
    const messages = messagesForRead(sessionId)
    if (!messages) return { messages: [], changed: false }
    if (!options.sanitize) return { messages: guard(messages), changed: false }
    // F9:`changed` 由 sanitizer 自己带回来,不再靠 `===` 比引用。
    const sanitized = sanitizeOnethingMessagesForRendererResult(messages)
    return { messages: guard(sanitized.value ?? messages), changed: sanitized.changed }
  },

  /*
   * `listMessagesFromStore` —— **已删除**(F4-c c4,§16.24)。
   *
   * 它是恒等门(`session/shadow.ts`)唯一合法的**验证器侧**取数:故意不经过
   * `fromEvents`,好让门的两侧始终是两条独立推导(F11:判据污染)。恒等门 c4
   * 退役之后它零消费者 —— 而"一条故意绕开投影的整会话读法"留在读门面上只会
   * 变成下一个人的第二份真相。要 store 侧的整份消息,今天没有正当理由;
   * 要**这条会话在不在**问 `hasSessionInStore`,其余一律 `listMessages`(投影)。
   */

  /*
   * `getMessageFromStore` / `hasMessageInStore` / `findMessageFromStore` ——
   * **已删除**(§17.7.1 批 3)。
   *
   * 三口从 F2 起是**写侧判据**:命令面要问"这次命令改不改得成",而"改成"的
   * 那一侧是老 reducer、reducer 问的是内存 store 上那份消息数组。两侧同判据,
   * 写事件与改 store 才不会一边发生一边不发生(§16.10 第三条理由:判据同源)。
   *
   * 批 3 把 reducer 删了 —— 同源的那个对象没有了,三口的**唯一理由**随之消失。
   * 判据改问投影:存在性走 `eventsHasMessage`(节点表 O(1),不物化),底稿与
   * 谓词查走 `getMessage` / `listMessages`(投影物化)。c4-d 之后 store 的消息
   * 数组本来就是折叠产物的物化,所以这不是换真相,是把门牌摘掉。
   *
   * **`hasSessionInStore` 留任,而且是永久例外**(下面那一口,§16.11 拍板 4 /
   * 纪律 7)。
   */

  /**
   * **store 侧**问一句"这条会话在不在" —— F2-c 补的那道判据(§16.9 的洞)。
   *
   * **投影答不出这个问题**:事件侧对"一条事件都没有的会话"与"根本不存在的
   * 会话"给的是同一个答案(`nodes.length === 0`)—— 而这道判据要分的正是这两者
   * (刚建的空会话必须能追加第一条消息)。会话在不在是 `meta.json` / 仓库那一层
   * 的事实,不是消息事件折得出来的。
   *
   * **这一口是永久例外**(§16.11 拍板 4,用户 2026-08-27 裁定 A):它不随 reducer
   * 退役 —— 哪怕 store 退化成物化缓存,"这条会话存不存在"仍然是目录 / `meta.json`
   * 那一层的事实。要改口径只有一条路 —— 给"会话存在性"另找一个产地,那是一次
   * 单独的拍板,不是顺手翻面。
   *
   * 命令面唯一改不成的情形就是**整条会话不在**:F2-a/F2-b 翻转时这一格漏了,
   * 于是"往一条不存在的会话追加消息"会在账本上留下一条 `user/message`,而 store
   * 上什么都没有 —— 事件账本记的是事实,不是意图。
   */
  hasSessionInStore(sessionId: string): boolean {
    return ports.store.getSessionMessages(sessionId) !== undefined
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
    return fromEvents(() => ports.events.eventsPageMessages(request))
      ?? ports.store.getSessionMessagesPage(request)
  },

  /**
   * **尾页 + 账本水位**(工单 4 A)—— 首屏那条读法。
   *
   * 与 `pageMessages` 的差别只有两样,而两样都不在"折法"上:
   *  ① 多一格 `watermark`(这一页对应到账本第几条),与页**同一个快照**取;
   *  ② 这一页里的 blob 带引用不带正文(见 `eventsPageMessagesAtWatermark`)。
   *
   * 折法一个字没变 —— 页仍然是 `pageEventMessages` / `pageFromMemory` 那两条
   * 既有的路折出来的,`canonical.ts` 那位判官管的还是它们。这里**故意没有**
   * `?? store.getSessionMessagesPage(...)` 那条右边:仓那口给不出水位,给一个
   * 编出来的水位比不给更坏(壳会按它跳过真实事件)。折不出来就交回 `undefined`,
   * 调用方走自己的空会话语义。
   */
  pageMessagesAtWatermark(
    request: GetSessionMessagesPageRequest,
  ): SessionTailPageSnapshot | undefined {
    return fromEvents(() => ports.events.eventsPageMessagesAtWatermark(request))
  },

  /**
   * 一次调用的一格结果正文(工单 5 ②)。
   *
   * **只有事件那条路**:带引用的大结果是页这一层的形状,而页只有事件路折得出来
   * —— 仓那口(`messages.jsonl` 化石)压根没有这条读法要的那张调用表。
   */
  toolResult(
    sessionId: string,
    toolCallId: string,
    slot: SessionPageResultSlot,
  ): { value: unknown } | undefined {
    return ports.events.eventsToolResult(sessionId, toolCallId, slot)
  },

  /** 用户消息锚点(会话目录 / 跳转用)。右边同 `pageMessages`:空会话的形状口。 */
  listUserMarkers(sessionId: string): readonly UserMessageMarker[] | undefined {
    return fromEvents(() => ports.events.eventsListUserMarkers(sessionId))
      ?? ports.store.getSessionUserMessageMarkers(sessionId);
  },

  getMessage(sessionId: string, messageId: string): Readonly<ChatMessage> | undefined {
    const fromEventLog = legacyMessages(sessionId)?.find(message => message.id === messageId)
      ?? fromEvents(() => ports.events.eventsGetMessage(sessionId, messageId))
    return fromEventLog ? guard(fromEventLog) : undefined
  },

  findMessage(
    sessionId: string,
    predicate: (message: ChatMessage, index: number) => boolean,
    options: { from?: 'start' | 'end' } = {},
  ): Readonly<ChatMessage> | undefined {
    const messages = messagesForRead(sessionId)
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
    return legacyMessages(sessionId)?.findIndex(message => message.id === messageId)
      ?? fromEvents(() => ports.events.eventsGetMessageIndex(sessionId, messageId)) ?? -1
  },

  countMessages(sessionId: string): number {
    return legacyMessages(sessionId)?.length ?? fromEvents(() => ports.events.eventsCountMessages(sessionId)) ?? 0
  },

  lastMessageOfRole(sessionId: string, role: ChatMessage['role']): Readonly<ChatMessage> | undefined {
    const fromEventLog = legacyMessages(sessionId)?.reverse().find(message => message.role === role)
      ?? fromEvents(() => ports.events.eventsLastMessageOfRole(sessionId, role))
    return fromEventLog ? guard(fromEventLog) : undefined
  },

  /** 第一条用户消息的预览文本(标题回退 / 列表预览;server 那三份实现的归口)。 */
  firstUserPreview(sessionId: string, maxLength = 120): string | undefined {
    const messages = messagesForRead(sessionId)
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
    const session = ports.store.getSession(sessionId)
    const fromEventLog = fromEvents(() => {
      if (!historyBuilder) return undefined
      // upToMessageId 的事件版要按 seq 折(无调用点),退回消息模式。
      if (options.upToMessageId) return undefined
      const state = ports.getProjection(sessionId)
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
        ...ports.materializeOptions(sessionId),
      };
      return materializeModelHistory(state, meta, projectModelHistoryOptions)
    })
    if (fromEventLog !== undefined) return fromEventLog

    const messages = ports.store.getSessionMessages(sessionId)
    if (!messages) return []
    const slice = !options.upToMessageId
      ? messages
      : (() => {
          const index = messages.findIndex(message => message.id === options.upToMessageId)
          if (index === -1) return messages
          return messages.slice(0, options.includeUpTo === false ? index : index + 1)
        })()
    // 装了构造器 = 归一到真机历史形状;没装则保住 store 切片(老形状)。
    return historyBuilder ? historyBuilder.fromMessages(slice, session) : guard(slice)
  },

  /** 不物化整份数组的遍历(搜索 / 媒体 / 权限扫描)。 */
  *iterateMessages(sessionId: string): Generator<Readonly<ChatMessage>> {
    const messages = messagesForRead(sessionId)
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
    const session = ports.store.getSessionRaw(sessionId)
    if (!session?.messages) return
    for (const message of session.messages) yield guard(message)
  },

  /**
   * 跨会话扫描(全局搜索 / 索引)。**明确是 raw 语义**:不进 LRU、不 sanitize、
   * 不回写 —— 与 `getSession` 的差别是真实的(见 §7 的竞态注释),不合并。
   */
  *scanSessionsForSearch(sessionIds?: readonly string[]): Generator<Readonly<ChatSession>> {
    if (!sessionIds) {
      for (const session of ports.store.getSessions()) yield session
      return
    }
    for (const sessionId of sessionIds) {
      const session = ports.store.getSessionRaw(sessionId)
      if (session) yield session
    }
  },

  /** 原始 jsonl 抄本(collab 的两处绕驱动直读的归口)。 */
  readTranscriptFile(sessionId: string): string | undefined {
    return ports.store.readSessionTranscriptFile(sessionId)
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
      return fs.readFileSync(path.join(ports.getSessionsDir(), sessionId, 'messages.jsonl'))
    } catch {
      return undefined
    }
  },

  /** 整会话(命令面之外唯一允许拿到会话体的地方)。 */
  getSession(sessionId: string): Readonly<ChatSession> | undefined {
    return ports.store.getSession(sessionId)
  },
}

  return {
    ...new Proxy(sessionReads, {
      get(target, key, receiver) {
        const read = Reflect.get(target, key, receiver)
        return typeof read === 'function'
          ? (...args: unknown[]) => { assertActive(); return Reflect.apply(read, target, args) }
          : read
      },
    }),
    configureHistoryBuilder(builder: SessionHistoryBuilder | undefined): void { assertActive(); historyBuilder = builder },
    /** 会话没了,连它那一格「没有旧抄本」的记忆一起丢掉(工单 4 A4)。 */
    forgetSession(sessionId: string): void { legacySourceAbsent.delete(sessionId) },
    dispose(): void { disposed = true; historyBuilder = undefined; legacySourceAbsent.clear() },
  }
}

export type SessionReads = ReturnType<typeof createSessionReads>
const currentReads = (): SessionReads => getCurrentBackend('sessionLayer').sessionLayer.reads
export const sessionReads: Omit<SessionReads, 'configureHistoryBuilder' | 'dispose' | 'forgetSession'> = {
  listMessages: (...args) => currentReads().listMessages(...args),
  hasSessionInStore: (...args) => currentReads().hasSessionInStore(...args),
  pageMessages: (...args) => currentReads().pageMessages(...args),
  pageMessagesAtWatermark: (...args) => currentReads().pageMessagesAtWatermark(...args),
  toolResult: (...args) => currentReads().toolResult(...args),
  listUserMarkers: (...args) => currentReads().listUserMarkers(...args),
  getMessage: (...args) => currentReads().getMessage(...args),
  findMessage: (...args) => currentReads().findMessage(...args),
  getMessageIndex: (...args) => currentReads().getMessageIndex(...args),
  countMessages: (...args) => currentReads().countMessages(...args),
  lastMessageOfRole: (...args) => currentReads().lastMessageOfRole(...args),
  firstUserPreview: (...args) => currentReads().firstUserPreview(...args),
  sliceForHistory: (...args) => currentReads().sliceForHistory(...args),
  iterateMessages: (...args) => currentReads().iterateMessages(...args),
  iterateMessagesRaw: (...args) => currentReads().iterateMessagesRaw(...args),
  scanSessionsForSearch: (...args) => currentReads().scanSessionsForSearch(...args),
  readTranscriptFile: (...args) => currentReads().readTranscriptFile(...args),
  readTranscriptBuffer: (...args) => currentReads().readTranscriptBuffer(...args),
  getSession: (...args) => currentReads().getSession(...args),
}
