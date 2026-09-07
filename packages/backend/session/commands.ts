/**
 * 会话消息命令面(装配层)—— docs/design/session-commands-p0-2026-08.md §2。
 *
 * 六条消息命令 + 一条会话级补丁,一个方法一条:`sessionCommands.<cmd>(sessionId, payload)`。
 *
 * ## 今天的执行序(§17.7.1 批 3:老 reducer 已经退役)
 *
 *   判据(问投影)→ 事件 append(F1 同步可见)→ 会话账落格 → 落盘调度 → 索引元数据
 *
 * 每一步都住在这个文件里,而且**只有这一份**。三件事因此收成了一句话:
 *
 * 1. **消息**由折叠产物维护(`refreshMessagesFromProjection` 是全仓唯一换装点,
 *    §16.27);
 * 2. **会话账**(`updatedAt` / `lastProvider` / `lastModel` / 截断的用量结算与
 *    timeline 修复)由**事件折叠**产出(`core/session/account.ts`),这里只把它
 *    落到会话容器那几格;
 * 3. **落盘档**(lazy)与**索引元数据**由这里按命令种类自算 —— 从前那张表是
 *    `applySessionCommand` 的返回值,而那个归约器批 3 已经删了。
 *
 * ### 老 reducer 去哪儿了(§17.5 #2 / §17.7.1 批 3)
 *
 * `core/session/commands.ts` 的 `applySessionCommand` 与它的 7 条分支、
 * `SessionCommand` 联合、`adoptSessionCommandResult`、`withSessionCommandPin`、
 * 三口 `get/has/findMessageFromStore`、`OnethingSessionMessageRuntime` 的 9 个
 * 命令口 —— **全部删除**。它最后的身份("会话级派生的算法")随批 2 的折叠器上线
 * 而消失:同一本账现在只有一个产地,就是事件流。
 *
 * `pin` 也跟着走了:它防的是"归约器在自己刚写的那条事件之后再应用一次同一条命令"
 * (§16.27 二 / 纪律 3),归约器不在了,那一幕不可能再发生。
 *
 * ### 判据改问投影(三口退役)
 *
 * "这次命令改不改得成"从前问的是 store 上那份消息数组(与归约器同源)。归约器
 * 没了,同源的对象也就没了 —— 判据改问**投影节点表**(`eventsHasMessage`,O(1)、
 * 不物化),底稿改取投影物化的那一条。**`hasSessionInStore` 是永久例外**
 * (§16.11 拍板 4 / 纪律 7):"这条会话的外壳在不在"是 `meta.json` 那一层的事实,
 * 消息事件里永远没有它的产地。
 *
 * ### 事件写侧取材纪律(F3 §16.10 的今天版)
 *
 * 写侧默认读活投影 —— F1(§16.6)让事件在 `append` 返回前就折进活投影,
 * "命令内读得到自己刚写的"成立。批 3 之后连"判据同源"那条具名例外也没有了:
 * 两侧本来就是同一份折叠。
 */

import type {
  ChatMessage,
  ChatSession,
  SessionMeta,
} from '@shared/ipc.js'
import {
  applySessionListProjectionToMeta,
  applySessionMessageAppendToMeta,
  applySessionUpdatedAtToMeta,
  findLastPreviewableMessage,
  type SessionAccountState,
  type SessionAccountTruncationEffect,
} from '@onething/core/session'
import type { sessionCommandEvents } from './command-events.js'
import type { sessionReads } from './reads.js'
import { getCurrentBackend } from '../current.js'

/**
 * `patchMessage` 的落盘档提示(从 `core/session/commands.ts` 搬过来 —— 批 3 之后
 * 写档是**写门**的事,不再是归约器的返回值)。
 *
 * `'stream'` = 逐 token 的高频路径,走 5s 的 lazy 档;`'settle'` = 收尾/元数据,
 * 走 300ms 常规档。
 */
export type SessionCommandWriteHint = 'stream' | 'settle'

/**
 * 不给 hint 时按 patch 的键推断:键集合完全落在这四格里就算 stream 档。
 *
 * **逐字复刻**归约器退役前的 `resolveLazy`(`core/session/commands.ts`)——
 * 这一格是可感知的(写盘节流窗口 5s vs 300ms),搬家不许顺手改口径。
 */
const LEGACY_LAZY_PATCH_KEYS = new Set(['content', 'reasoning', 'contentParts', 'thinkingTime'])

function resolveLazy(hint: SessionCommandWriteHint | undefined, patch: Record<string, unknown>): boolean {
  if (hint === 'stream') return true
  if (hint === 'settle') return false
  const keys = Object.keys(patch)
  return keys.length > 0 && keys.every(key => LEGACY_LAZY_PATCH_KEYS.has(key))
}

/**
 * 截断要从会话总账扣回去的用量。三格与 `ChatMessage['usage']` 的前三格同形。
 *
 * 批 3 之后它由**折叠**算(`SessionAccountTruncationEffect.subtracted`);这里
 * 留着形状是因为事件构造与日志还按它说话。
 */
export interface SessionTruncateUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface SessionCommandsPorts {
  reads: Pick<typeof sessionReads, 'countMessages' | 'getMessage' | 'findMessage' | 'listMessages'>
  hasMessage(sessionId: string, messageId: string): boolean
  getSession(sessionId: string): ChatSession | undefined
  /**
   * 落盘调度。**只有 `lazy` 这一格**:写计划(`SessionWritePlan`)自 S3w-3 批 6b
   * 起在存储驱动里就没有读者了(`storage-driver.ts`:「`plan` 保留在签名里但不再
   * 被读」),归约器一死它连产地都没了 —— 与其在热路径上为一个没人读的字段做
   * 下标查找,不如不算。仓库那一侧的缺省(structural)与从前逐字等效。
   */
  saveSession(sessionId: string, session: ChatSession, options?: { lazy?: boolean }): void
  updateSessionsIndexMeta(sessionId: string, update: (meta: { [key: string]: unknown }) => void): boolean
  flushSessionSave(sessionId: string): Promise<void>
  /** 协作署名(room/work/agent 会话的 assistant 消息);返回新对象 */
  stampCollabAgentId?(sessionId: string, message: ChatMessage): ChatMessage
  /** 会话级字段补丁(`meta` 档;消息一行不动) */
  patchSession(
    sessionId: string,
    patch: PatchSessionFields,
    mutateIndexMeta?: (meta: SessionMeta, session: ChatSession) => void,
  ): boolean
}

/**
 * 会话级字段补丁:`messages` 之外的一切。消息只能走前面那几条命令,所以这里
 * 类型上就把它摘掉(而不是靠运行时丢弃兜底)。
 */
export type PatchSessionFields = Omit<Partial<ChatSession>, 'messages'>

export interface PatchSessionPayload {
  patch: PatchSessionFields
  /** 会话列表只读 index,盖章漏了列表就与会话体不一致 */
  mutateIndexMeta?: (meta: SessionMeta, session: ChatSession) => void
}

export interface AppendMessagePayload {
  message: ChatMessage
  /** 走协作署名(engine 的四个创建点用 true;server / 导入路径用 false) */
  stampCollab?: boolean
}

export interface TruncateFromPayload {
  messageId: string
  /** true = 连这条一起删(regenerate);false = 保留并按 newContent 改写(edit) */
  inclusive: boolean
  newContent?: string
  contentParts?: ChatMessage['contentParts'] | null
}

export type DeleteMessagePayload =
  | { messageId: string }
  | { matchMarker: (message: ChatMessage) => boolean }

export interface ReplaceAllPayload {
  messages: ChatMessage[]
  reason: 'clear' | 'replaced' | 'normalize'
}

export interface ReplaceAllResult {
  replaced: boolean
  previousCount: number
}

export interface SessionCommands {
  /**
   * 追加一条消息,返回**真正入库的那一条**(F4-a,§16.12)——
   * `stampCollab` 打开且这条会话该盖章时,它与 `payload.message` 不是同一个对象
   * (盖章 COW)。不盖章就原样是入参那一条。
   *
   * **为什么不从折叠物化取回**(批 3 复核):流式 assistant 占位这一档在账本上
   * 那一格是 `run/start`,而它由创建点在这扇门**返回之后**的下一行才落账
   * (c4-d 同一同步段)—— 此刻折叠里根本没有这条消息。盖过章的那一份就是入库
   * 的那一份,交回它与从折叠取逐字同义,而且不必假装折叠已经看见它。
   */
  appendMessage(sessionId: string, payload: AppendMessagePayload): ChatMessage
  upsertMessage(sessionId: string, payload: { message: ChatMessage }): boolean
  patchMessage(
    sessionId: string,
    payload: { messageId: string; patch: Partial<ChatMessage>; hint?: SessionCommandWriteHint },
  ): boolean
  truncateFrom(sessionId: string, payload: TruncateFromPayload): boolean
  deleteMessage(sessionId: string, payload: DeleteMessagePayload): boolean
  replaceAll(sessionId: string, payload: ReplaceAllPayload): Promise<ReplaceAllResult>
  /*
   * `repairOnLoad` —— **已删除**(§17.7.1 批 3)。
   *
   * 它在命令面上**生产零调用点**:那条归约器分支真正的入口一直是冷加载的
   * `sanitizeSessionOnStartup`(`session-repository.repairOnFirstTouch`),整条
   * 绕开命令面与事件面。批 3 把那两个具名入口改成直调
   * `computeSessionRepairOnLoad`(纯派生,语义一字未改),命令面这层包装于是
   * 既没有调用者也没有被包装的动作 —— 按 #8a 的口径(先证零消费再删)纯减法删除。
   */
  /**
   * 会话级字段(name / isPinned / isArchived / workingDirectory(Roots) /
   * variables / maxTokens / owner 盖章 …)。P0.4 收掉 `saveSessionSnapshot`
   * 后门:同一扇门进出,而且按 `meta` 档落盘。
   */
  patchSession(sessionId: string, payload: PatchSessionPayload): boolean
}

export interface CreateSessionCommandsOptions {
  /** The owner rejects calls through retained command references after disposal. */
  assertActive?: () => void
  assertWritable?: (sessionId: string) => void
  /**
   * **命令的事件产地**(F2,§16.2 的 F2 行)。命令先在这里把事件构造出来并 append,
   * F1 保证 `append` 返回前活投影 / 活 surface / 会话账都已经前进。
   *
   * 是**选项**而不是硬接线:命令面的单元测试要的是"命令做对了什么",不该顺带把
   * 一份事件日志写到某个临时目录里去。生产由会话装配层显式接上。
   */
  events?: typeof sessionCommandEvents | null
  /**
   * 命令自己的时钟(F2-b §16.8;批 2 裁定 1 起是**六条盖章命令**共用的那一次读表)。
   * 可注入是为了字节回归能在两棵树上跑出同一个数。
   */
  now?: () => number
  /**
   * 会话账的取处。生产显式绑定本实例的活投影；未提供时没有会话账。
   */
  account?: (sessionId: string) => SessionAccountState | undefined
}

/**
 * 把会话账的**身份三格**落到会话容器。
 *
 * 产地是折叠(`core/session/account.ts`);这里只是搬运。三格的语义与归约器
 * 退役前逐字相同 —— 批 2 的影子对拍(682 次 0 失配)证的就是这一条。
 *
 * `at` 是这条命令取的那一次刻(时钟同源)。折叠对这几条命令给出的 `updatedAt`
 * **就是这个数**,所以账本没启用(`isSessionEventLogEnabled === false`,例如
 * 事件目录还没建起来的那一瞬)时按 `at` 盖章不是第二套算法,是同一个事实的
 * 两个取处 —— 缺了它,这类会话在列表上的排序会停在上一次写。
 */
function landAccountIdentity(
  session: ChatSession,
  account: SessionAccountState | undefined,
  at: number,
  appended?: ChatMessage,
): void {
  const target = session as unknown as Record<string, unknown>
  if (account?.updatedAt !== undefined) {
    target.updatedAt = account.updatedAt
    if (account.lastProvider !== undefined) target.lastProvider = account.lastProvider
    if (account.lastModel !== undefined) target.lastModel = account.lastModel
    return
  }
  target.updatedAt = at
  if (appended?.role === 'assistant') {
    if (appended.provider) target.lastProvider = appended.provider
    if (appended.model) target.lastModel = appended.model
  }
}

/**
 * 把一次截断的**会话级效果**落到容器:用量扣减 + timeline 修复(`contextSize` /
 * `lastInputTokens` 改写、summary 三件删除)。
 *
 * 两件事都由折叠算好(`SessionAccountTruncationEffect`),这里只搬运 —— 与
 * 归约器退役前的 `applyTruncate` 逐字同义(批 2 的增量对拍证的就是这一条)。
 */
function landTruncationEffect(session: ChatSession, effect: SessionAccountTruncationEffect): void {
  const target = session as unknown as Record<string, unknown>
  const { subtracted } = effect
  if (subtracted.totalTokens > 0) {
    target.totalInputTokens = Math.max(0, ((target.totalInputTokens as number) || 0) - subtracted.inputTokens)
    target.totalOutputTokens = Math.max(0, ((target.totalOutputTokens as number) || 0) - subtracted.outputTokens)
    target.totalTokens = Math.max(0, ((target.totalTokens as number) || 0) - subtracted.totalTokens)
  }
  for (const [key, value] of Object.entries(effect.patch)) target[key] = value
  for (const key of effect.deletes) delete target[key]
}

/**
 * 编辑重发的**底稿**:投影物化的那一条,摘掉读路自己的往返坐标。
 *
 * `eventsGetMessage` 会给消息补两格**读路坐标**(`seq` / `eventSeq`:这条消息由
 * 哪条事件开头),物化成 store 视图时再摘掉(§17.7.1 批 1 第二问)。底稿是要
 * **写回事件体**的,坐标进了事件体就成了第二个真相(而且下一次重折会得到不同的
 * 数)。所以这一口只取消息本身 —— 与批 3 之前那份 store 侧底稿逐字相同。
 */
function editBaseline(message: Readonly<ChatMessage> | undefined): ChatMessage | undefined {
  if (!message) return undefined
  const { seq: _seq, eventSeq: _eventSeq, ...rest } = message as ChatMessage & {
    seq?: number
    eventSeq?: number
  }
  return rest as ChatMessage
}

export function createSessionCommands(
  ports: SessionCommandsPorts,
  options: CreateSessionCommandsOptions = {},
): SessionCommands {
  const events = options.events ?? null
  const now = options.now ?? Date.now
  const readAccount = options.account ?? (() => undefined)
  const assertActive = (sessionId: string): void => {
    options.assertActive?.()
    options.assertWritable?.(sessionId)
  }

  /** 这条消息在不在 —— **投影节点表**,O(1),不物化(三口退役后的唯一判据)。 */
  const hasMessage = (sessionId: string, messageId: string): boolean =>
    ports.hasMessage(sessionId, messageId)

  /**
   * **会话列表投影**的两格(`messageCount` / `lastMessagePreview`)。
   *
   * 它挂在这批 `updateSessionsIndexMeta` 上,与 `updatedAt` 一起走,一格不多
   * 一格不少 —— 于是"列表读只读索引元数据"这条纪律不用为了一行预览破例。
   *
   * `lastMessage` 由调用点给:追加那两支手上就是那一条(O(1),不物化);
   * 截断 / 删除 / 整换那三支的最后一条变了,才去投影上倒着找一次。
   *
   * `countMessages` 走的是活投影的节点表(`eventsCountMessages`,过一遍 hidden
   * 标记),不物化消息体。
   */
  const applyListProjection = (
    sessionId: string,
    meta: { [key: string]: unknown },
    lastMessage: ChatMessage | Readonly<ChatMessage> | undefined,
  ): void => {
    applySessionListProjectionToMeta(meta as never, {
      messageCount: ports.reads.countMessages(sessionId),
      lastMessage,
    })
  }

  /** 截断 / 删除之后"最后一条说过的话"是谁 —— 只有这两支需要回头找。 */
  const lastPreviewableMessage = (sessionId: string): Readonly<ChatMessage> | undefined =>
    ports.reads.findMessage(
      sessionId,
      message => message.role === 'user' || message.role === 'assistant',
      { from: 'end' },
    )

  return {
    appendMessage(sessionId, payload) {
      assertActive(sessionId)
      const message = payload.stampCollab && ports.stampCollabAgentId
        ? ports.stampCollabAgentId(sessionId, payload.message)
        : payload.message
      // 时钟同源(批 2 裁定 1):一条命令**取一次刻**。流式助手占位是命令面唯一
      // 不写事件的一档,它的刻在**创建点**就取过一次了(同时是消息 `timestamp`
      // 与 `run/start.timestamp`),所以这里认那一个数。
      const streamingAssistant = message.role === 'assistant' && Boolean(message.isStreaming)
      const at = streamingAssistant && typeof message.timestamp === 'number'
        ? message.timestamp
        : now()
      // 唯一改不成的情形是**整条会话不在**(纪律 7 的永久例外)。
      const session = ports.getSession(sessionId)
      if (!session) return message

      events?.appendMessage(sessionId, message, at)
      landAccountIdentity(session, readAccount(sessionId), at, message)
      ports.saveSession(sessionId, session)
      ports.updateSessionsIndexMeta(sessionId, meta => {
        applySessionMessageAppendToMeta(meta as never, session as never, message as never)
        applyListProjection(sessionId, meta, message)
      })
      return message
    },

    /**
     * 一个判据同时回答两个问题 —— "这条消息在不在":事件用它分 append / `fullBody`
     * patch 两档,索引元数据用它分"要不要按追加盖章"。
     */
    upsertMessage(sessionId, payload) {
      assertActive(sessionId)
      const message = payload.message
      const streamingAssistant = message.role === 'assistant' && Boolean(message.isStreaming)
      const at = streamingAssistant && typeof message.timestamp === 'number'
        ? message.timestamp
        : now()
      const session = ports.getSession(sessionId)
      if (!session) return false

      const existed = hasMessage(sessionId, message.id)
      events?.upsertMessage(sessionId, message, existed, at)
      landAccountIdentity(session, readAccount(sessionId), at, existed ? undefined : message)
      ports.saveSession(sessionId, session)
      // 就地换掉那一支不动索引(归约器退役前 `indexMetaChanged: false`)。
      if (!existed) {
        ports.updateSessionsIndexMeta(sessionId, meta => {
          applySessionMessageAppendToMeta(meta as never, session as never, message as never)
          applyListProjection(sessionId, meta, message)
        })
      }
      return true
    },

    /**
     * `patchMessage` **不盖会话账**(归约器退役前那条分支同样一格都不盖:逐 token
     * 的补丁不该把会话顶到列表最前面)。它只落盘,而且按 hint / 键集合定写档。
     */
    patchMessage(sessionId, payload) {
      assertActive(sessionId)
      if (!hasMessage(sessionId, payload.messageId)) return false
      const session = ports.getSession(sessionId)
      if (!session) return false

      events?.patchMessage(sessionId, payload.messageId, payload.patch)
      ports.saveSession(sessionId, session, {
        lazy: resolveLazy(payload.hint, payload.patch as Record<string, unknown>),
      })
      return true
    },

    /**
     * 两种语义,两条事件:`inclusive`(regenerate)→ `message/deleted`;
     * 否则(edit-resend)→ `user/message-edited`。
     *
     * 三件事按这个顺序:
     * 1. **底稿**。编辑那一支要编辑**前**那条做底稿 —— 取投影物化的那一份
     *    (编辑的永远是**用户**消息,补水对它是恒等的,所以与从前那份 store 侧
     *    底稿逐字相同)。
     * 2. **判据**。改不成只有一个理由:那条消息不在。
     * 3. **时刻**。`inclusive:false` 会给被改写的那条盖新 `timestamp`,这个数由
     *    命令决定一次、同时递给事件与折叠(时钟同源)。
     * 4. **会话级效果**。用量扣减与 timeline 修复由折叠算(`lastTruncation`),
     *    这里只落格。折叠是否真为这次截断算过,靠**对象同一性**判(每次截断
     *    折叠都新建一个 effect 对象)—— 不然上一次的效果会被再扣一遍。
     */
    truncateFrom(sessionId, payload) {
      assertActive(sessionId)
      const before = payload.inclusive
        ? undefined
        : editBaseline(ports.reads.getMessage(sessionId, payload.messageId))
      const present = payload.inclusive
        ? hasMessage(sessionId, payload.messageId)
        : before !== undefined
      if (!present) return false
      const session = ports.getSession(sessionId)
      if (!session) return false

      const at = now()
      const effectBefore = readAccount(sessionId)?.lastTruncation
      events?.truncateFrom(sessionId, payload, { before, now: at })

      const account = readAccount(sessionId)
      landAccountIdentity(session, account, at)
      const effect = account?.lastTruncation
      if (effect && effect !== effectBefore) landTruncationEffect(session, effect)
      ports.saveSession(sessionId, session)
      ports.updateSessionsIndexMeta(sessionId, meta => {
        applySessionUpdatedAtToMeta(meta as never, session as never)
        applyListProjection(sessionId, meta, lastPreviewableMessage(sessionId))
      })
      return true
    },

    /**
     * 按 marker 删的那一支**本来就是**先找后删(命令面不知道删掉的是哪一条,
     * 而事件要写 id)—— 找的那一份现在来自投影物化。
     */
    deleteMessage(sessionId, payload) {
      assertActive(sessionId)
      const at = now()
      const messageId = 'messageId' in payload
        ? (hasMessage(sessionId, payload.messageId) ? payload.messageId : undefined)
        : ports.reads.listMessages(sessionId).messages.find(payload.matchMarker)?.id
      if (messageId === undefined) return false
      const session = ports.getSession(sessionId)
      if (!session) return false

      events?.deleteMessage(sessionId, messageId, at)
      landAccountIdentity(session, readAccount(sessionId), at)
      ports.saveSession(sessionId, session)
      // E4:老路径漏了这一步,列表里的 updatedAt 因此停在删除之前。
      ports.updateSessionsIndexMeta(sessionId, meta => {
        applySessionUpdatedAtToMeta(meta as never, session as never)
        applyListProjection(sessionId, meta, lastPreviewableMessage(sessionId))
      })
      return true
    },

    /**
     * 整份日志换掉。`reason:'clear'` 是群聊「清空聊天记录」的**唯一**落点:
     * 换 → 索引计数归零 → 强刷一次。
     *
     * `normalize` **已经没有生产调用点**(§17.7.1 批 3 勘察:全仓零命中),它在
     * 账本上照旧一条事件都不写(判例:一次"什么都没发生"不该在 surface 上变成
     * 一次全量遮蔽)。留着这一档是因为它是 `ReplaceAllPayload` 的合法取值,
     * 删它要连带改三处形状 —— 零流量的分支不值得一次形状变更(见批 3 报告)。
     */
    async replaceAll(sessionId, payload) {
      assertActive(sessionId)
      const session = ports.getSession(sessionId)
      if (!session) return { replaced: false, previousCount: 0 }
      const previousCount = ports.reads.countMessages(sessionId)
      const isClear = payload.reason === 'clear'
      const at = now()

      events?.replaceAll(sessionId, payload.messages, payload.reason, at)
      landAccountIdentity(session, readAccount(sessionId), at)
      ports.saveSession(sessionId, session)

      ports.updateSessionsIndexMeta(sessionId, meta => {
        meta.updatedAt = session.updatedAt
        if (payload.messages.length === 0) delete meta.previewText
        // 整换那一支手上就是新的全份消息 —— 计数与最后一条都从它取,不必回读投影。
        applySessionListProjectionToMeta(meta as never, {
          messageCount: payload.messages.length,
          lastMessage: findLastPreviewableMessage(payload.messages),
        })
      })

      if (isClear) await ports.flushSessionSave(sessionId)

      return { replaced: true, previousCount }
    },

    /**
     * **事件先,store 后**。
     *
     * 命令面本来就要取 `before` 算快照,所以"改得成"这道判据是**同一次取材的
     * 副产品**:取到了 = 改得成,一次读、两个用途。
     *
     * 另外两个 `session/*-changed` 的产地(`stores/sessions.ts` 的
     * `updateSessionAgent` / `updateSessionModel`、server 的 `sessions.update`)
     * **绕开命令面**,而且必须留在写成功之后 —— 它们的 `to` 取的是落库之后那一格。
     * 事件构造对顺序中立,四处共用同一份(见 `sessionCommandEvents.patchSession`)。
     */
    patchSession(sessionId, payload) {
      assertActive(sessionId)
      const before = ports.getSession(sessionId)
      if (before) {
        events?.patchSession(sessionId, payload.patch, {
          agentId: before.agentId,
          lastModel: before.lastModel,
          lastProvider: before.lastProvider,
          workingDirectory: before.workingDirectory,
        })
      }
      return ports.patchSession(sessionId, payload.patch, payload.mutateIndexMeta)
    },
  }
}

/** Compatibility edge; production bindings belong to createSessionLayer. */
export function getSessionCommands(): SessionCommands {
  return getCurrentBackend('sessionLayer').sessionLayer.commands
}

/** 命令面的门牌:P0.2/P0.3 的调用点全部改成 `sessionCommands.<cmd>(...)`。 */
export const sessionCommands: SessionCommands = {
  appendMessage: (sessionId, payload) => getSessionCommands().appendMessage(sessionId, payload),
  upsertMessage: (sessionId, payload) => getSessionCommands().upsertMessage(sessionId, payload),
  patchMessage: (sessionId, payload) => getSessionCommands().patchMessage(sessionId, payload),
  truncateFrom: (sessionId, payload) => getSessionCommands().truncateFrom(sessionId, payload),
  deleteMessage: (sessionId, payload) => getSessionCommands().deleteMessage(sessionId, payload),
  replaceAll: (sessionId, payload) => getSessionCommands().replaceAll(sessionId, payload),
  patchSession: (sessionId, payload) => getSessionCommands().patchSession(sessionId, payload),
}
