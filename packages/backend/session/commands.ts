/**
 * 会话消息命令面(装配层)—— docs/design/session-commands-p0-2026-08.md §2。
 *
 * 12 条消息命令,一个方法一条:`sessionCommands.<cmd>(sessionId, payload)`;
 * P0.4 另加第 13 个 `patchSession`(会话级字段,`saveSessionSnapshot` 后门的替代)。
 * 每条的执行序是固定的,而且**只在这里**写一次:
 *
 *   取 session → `applySessionCommand`(纯函数,算 COW / 写计划 / lazy 档)
 *   → 写回缓存 → `saveSessionToFile(plan, lazy)` → sqlite → index meta
 *
 * 前三步住在 `OnethingSessionMessageRuntime`(sqlite 的流式节流同步也在那里),
 * 这里负责的是"命令之外"的那点东西:
 *   - `appendMessage{stampCollab}` 的协作署名(返回新对象,不改调用方的那条);
 *   - `replaceAll{reason:'clear'}` 的强刷 + 索引计数归零(留档那一步批 6b 已退役)。
 *
 * P0.1 只建面,不迁调用点(strangler);P0.2/P0.3 把 78 处业务调用点与 server 迁过来;
 * P0.4 删旧路(`insertMessageAfter` 一族、store-helpers 的消息原语家族、
 * `saveSessionSnapshot`)并把 `session:check` 收到白名单外 0。
 * `app/stores/sessions.ts` 上还留着的那批 `updateMessage*` **不是**死路径:
 * 它们是 core 引擎注入的 store 端口的实现,接口形状 P0 不许动(§6)。
 *
 * **F2 已走完:十三条命令的事件产地全部翻转**(§16.2 的 F2 行 / §16.7 / §16.8 /
 * §16.9)。F2-a 三条(`appendMessage` / `deleteMessage` / `patchMessage`)、
 * F2-b 两条(`upsertMessage` / `truncateFrom`)、F2-c 两条(`replaceAll` /
 * `patchSession`),执行序一律是 **事件 append(同步可见)→ reducer 应用到 store**;
 * 事件构造住在 `command-events.ts`(`sessionCommandEvents`),是命令的第一手表达。
 * 老 reducer 降级为 F0 的影子验证器(§16.5),独立推导同一件事供恒等门对账。
 * 于是"命令内读得到自己刚写的"对这十三条都成立(F1 的同步可见,§16.6)。
 * `event-translator.ts` 随之整体退役;两个**非命令**采集点搬去了
 * `lifecycle-events.ts`(`session/created` / `session/compacted`)。
 *
 * **"改没改成"由命令面自己问一次**(§16.7 第三节的纪律):问的是与 reducer
 * **同一份 store**,判据一字未变。两类:那条**消息**不在(patch / delete /
 * truncate / upsert 的分支判据),或者整条**会话**不在(append / upsert 的
 * reducer 唯一的 no-op 理由 —— F2-c 补上,见 `hasSessionInStore`)。
 *
 * **事件写侧取材纪律 —— F3 已整体翻面**(§16.10;原纪律见 §13.18 发现 B)。
 *
 * 从前这里写的是"命令面取材**一律**走 `*FromTranscript`,永不走 `getMessage` /
 * `findMessage`",理由是**活投影滞后**:events 读模式下投影还没看到"正要由这条
 * 命令写出的那条事件",走 `fromEvents` 会自引用旧投影,把旧正文 / 误判的类别 /
 * 丢失的删除焊进账本。**这条理由已经死了** —— F1(§16.6)让事件在 `append` 返回
 * 前就折进活投影,"命令内读得到自己刚写的"成立;`ONETHING_SESSION_READ` 那个岔口
 * 本身也早在批 6b 烧掉了。
 *
 * 今天的纪律是**具名例外**,不是一刀切:**写侧默认可以读活投影**,只剩**一类**
 * 仍然读 store,理由 F1 修不了(逐口写在 `reads.ts` 上):
 *
 *   1. **判据同源** —— 本文件这几处。它们回答的是"这次命令**改不改得成**",
 *      而"改成"的那一侧是 reducer、reducer 问的是 store。两侧同判据,写事件与
 *      改 store 才不会一边发生一边不发生。F4-b3 reducer 退役时一起翻,**但
 *      `hasSessionInStore` 除外 —— 它是永久例外**(§16.11 拍板 4)。
 *
 * **F3 的第二类"只在 store 的运行时形状",F4-b2(§16.17)已改判并搬走。** 那一类
 * 指的是收尾链那三处(`steps[]` 结局 / `data-steps` 渲染锚点)。改判的内容:自报
 * 标题与自报结局在 F2-c 之后**事件侧有产地了**,所以"投影不产出"这条理由不准;
 * 真正的理由是那三处跑在**活 run 窗口内**,读的是**引擎写手视图**而非"store 这份
 * 缓存"——锚点由写手产出且按 G4 只走推送路,收场结局那条 `tool/result` 更是这条链
 * 自己的产物。它们从此挂在 `reads.ts` 的 `getLiveRunWriterMessage` 上,不再是本文件
 * 这张写侧取材表的条目。
 *
 * **F3 曾有第三类"事件产地缺口",F4-a(§16.12)已摘除。** 那一类指的是
 * `stream-executor.ts` / `agent-loop-executor.ts` 的两处孪生取材点(流中 assistant
 * 占位在账本上没有那一格)。缺口的事实仍然成立,但那两处是 `run/start` 的
 * **生产者**而非消费者 —— 要的值就在它们刚写进去的那条消息上,回读只是绕路
 * (还带一个可以不存在的时序窗口)。F4-a 让本文件的 `appendMessage` /
 * `store.addMessage` **把入库的那一条交回调用方**,两处回读整体删除。缺口本身
 * 的解法是**补产地**(§16.11 拍板 3,F4 的硬前置),不是回读 store。
 *
 * 名字也跟着说实话了:`*FromTranscript` / `*InTranscript` → `*FromStore` /
 * `*InStore`(抄本停写之后它们读的是**内存 store**,不是 `messages.jsonl`)。
 */

import type {
  ChatMessage,
  ChatSession,
  ContentPart,
  SessionMeta,
  Step,
  ToolCall,
} from '@shared/ipc.js'
import type { SessionCommandWriteHint } from '@onething/core/session'
import {
  flushSessionSave,
  getSession,
  getSessionMessageCommandRuntime,
  patchSessionFields,
  stampCollabAgentId,
  updateSessionsIndexMetaForCommands,
} from '../stores/sessions.js'
import { assertContentPartIsCarriable } from './content-part-guard.js'
import { sessionCommandEvents } from './command-events.js'
import { sessionReads } from './reads.js'

/** 逐消息命令的执行体(生产实现 = `OnethingSessionMessageRuntime`)。 */
export interface SessionMessageCommandRuntime {
  addMessage(sessionId: string, message: ChatMessage): void
  upsertMessage(sessionId: string, message: ChatMessage): boolean
  patchMessageFields(
    sessionId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
    hint?: SessionCommandWriteHint,
  ): boolean
  addMessageContentPart(sessionId: string, messageId: string, part: ContentPart): boolean
  addMessageStep(sessionId: string, messageId: string, step: Step): boolean
  updateMessageStep(sessionId: string, messageId: string, stepId: string, updates: Partial<Step>): boolean
  updateStepsUsageByTurn(
    sessionId: string,
    messageId: string,
    turnIndex: number,
    usage: NonNullable<ChatMessage['usage']>,
  ): string[]
  updateMessageToolCalls(sessionId: string, messageId: string, toolCalls: ToolCall[]): boolean
  deleteMessage(sessionId: string, messageId: string): boolean
  deleteMessageWhere(sessionId: string, matchMarker: (message: ChatMessage) => boolean): boolean
  deleteMessageAndTruncate(sessionId: string, messageId: string): boolean
  updateMessageAndTruncate(
    sessionId: string,
    messageId: string,
    newContent: string,
    /**
     * `now` 是 F2-b 加的一格(§16.8):`truncateFrom{inclusive:false}` 是唯一一条
     * **由 reducer 合成消息字段**的命令(它给被改写的那条盖新 `timestamp`)。
     * 翻转之后事件写在 reducer 之前,两条推导要盖同一个数,否则恒等门比的是两个
     * 时钟读数。所以时刻由命令决定一次,顺着这一格递进来;不传则实现自取
     * (老调用点一字未变)。
     */
    options?: { contentParts?: ChatMessage['contentParts'] | null; now?: number },
  ): boolean
  replaceAllMessages(
    sessionId: string,
    messages: ChatMessage[],
    reason: 'clear' | 'replaced' | 'normalize',
  ): boolean
  repairOnLoad(sessionId: string, policy?: 'startup' | 'loaded'): boolean
}

export interface SessionCommandsPorts {
  messages: SessionMessageCommandRuntime
  getSession(sessionId: string): ChatSession | undefined
  updateSessionsIndexMeta(sessionId: string, update: (meta: { [key: string]: unknown }) => void): boolean
  flushSessionSave(sessionId: string): Promise<void>
  /** 协作署名(room/work/agent 会话的 assistant 消息);返回新对象 */
  stampCollabAgentId?(sessionId: string, message: ChatMessage): ChatMessage
  /** 会话级字段补丁(`meta` 写计划;消息一行不动) */
  patchSession(
    sessionId: string,
    patch: PatchSessionFields,
    mutateIndexMeta?: (meta: SessionMeta, session: ChatSession) => void,
  ): boolean
}

/**
 * 会话级字段补丁:`messages` 之外的一切。消息只能走前面 12 条命令,所以这里
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
   */
  appendMessage(sessionId: string, payload: AppendMessagePayload): ChatMessage
  upsertMessage(sessionId: string, payload: { message: ChatMessage }): boolean
  patchMessage(
    sessionId: string,
    payload: { messageId: string; patch: Partial<ChatMessage>; hint?: SessionCommandWriteHint },
  ): boolean
  appendContentPart(sessionId: string, payload: { messageId: string; part: ContentPart }): boolean
  upsertStep(sessionId: string, payload: { messageId: string; step: Step }): boolean
  patchStep(
    sessionId: string,
    payload: { messageId: string; stepId: string; updates: Partial<Step> },
  ): boolean
  patchStepsUsageByTurn(
    sessionId: string,
    payload: { messageId: string; turnIndex: number; usage: NonNullable<ChatMessage['usage']> },
  ): string[]
  setToolCalls(sessionId: string, payload: { messageId: string; toolCalls: ToolCall[] }): boolean
  truncateFrom(sessionId: string, payload: TruncateFromPayload): boolean
  deleteMessage(sessionId: string, payload: DeleteMessagePayload): boolean
  replaceAll(sessionId: string, payload: ReplaceAllPayload): Promise<ReplaceAllResult>
  repairOnLoad(sessionId: string, payload?: { policy?: 'startup' | 'loaded' }): boolean
  /**
   * 会话级字段(name / isPinned / isArchived / workingDirectory(Roots) /
   * variables / maxTokens / owner 盖章 …)。P0.4 收掉 `saveSessionSnapshot`
   * 后门:同一扇门进出,而且按 `meta` 写计划落盘 —— 会话级字段住 `meta.json`,
   * 改它们不该重写整份 `messages.jsonl`。
   */
  patchSession(sessionId: string, payload: PatchSessionPayload): boolean
}

export interface CreateSessionCommandsOptions {
  /**
   * **已翻转命令的事件产地**(F2,§16.2 的 F2 行)。命令先在这里把事件构造出来
   * 并 append,reducer 随后才把同一条命令应用到 store。
   *
   * 是**选项**而不是硬接线,理由与 `translator` 同:命令面的单元测试要的是
   * "命令做对了什么",不该顺带把一份事件日志写到某个临时目录里去。生产默认接上。
   */
  events?: typeof sessionCommandEvents | null
  /**
   * 命令自己的时钟(F2-b,§16.8)。今天只有 `truncateFrom{inclusive:false}` 用得上:
   * 它是唯一一条由 reducer 合成消息字段的命令,翻转之后"盖哪个 timestamp"必须由
   * 命令决定一次、同时喂给事件与 reducer。可注入是为了**字节回归**能在两棵树上
   * 跑出同一个数(与 `OnethingSessionMessageRuntime` 的 `options.now` 同款做法)。
   */
  now?: () => number
}

export function createSessionCommands(
  ports: SessionCommandsPorts,
  options: CreateSessionCommandsOptions = {},
): SessionCommands {
  const events = options.events === undefined
    ? sessionCommandEvents
    : options.events
  const now = options.now ?? Date.now

  return {
    /**
     * F2-a:**事件先,store 后**。
     *
     * reducer 的 `applyAppend` 恒为"改得成",所以这里唯一要问的不是消息、是
     * **整条会话在不在** —— `OnethingSessionMessageRuntime.run` 取不到 session 就
     * 整条 no-op(F2-c 补上这道判据,§16.9;F2-a/F2-b 留的那个洞)。F1 保证
     * `appendSurfaceAwareEvent` 返回时活投影与活 surface 已经前进(§16.6),于是
     * **命令内读得到自己刚写的**;随后的 `addMessage` 是 F0 的影子验证器
     * (§16.5)在独立推导同一件事。
     */
    appendMessage(sessionId, payload) {
      const message = payload.stampCollab && ports.stampCollabAgentId
        ? ports.stampCollabAgentId(sessionId, payload.message)
        : payload.message
      if (sessionReads.hasSessionInStore(sessionId)) {
        events?.appendMessage(sessionId, message)
      }
      ports.messages.addMessage(sessionId, message)
      // F4-a(§16.12):**把入库的那一条交回去**。盖章是 COW 的(不改调用方手里
      // 那条),所以"我刚写进去的是什么"以前只能事后回读一次 —— 而那次回读是一个
      // 可以不存在的时序窗口。现在由这扇门直接答。
      return message
    },

    /**
     * F2-b:**事件先,store 后**。
     *
     * 一个判据同时回答两个问题 —— "这条消息在不在":reducer 用它分 insert / replace
     * 两支(`findIndex === -1`),事件用它分 append / `fullBody` patch 两档。所以
     * 只问一次,而且问的是与 reducer **同一份 store**。
     *
     * F3(§16.10)复核过这一处:**留在 store**,理由是上面那句「同一份 store」
     * (判据同源),不再是原来那句"投影滞后"(§13.18 发现 B —— F1 之后已不成立)。
     * (F2-a 用的是 `getMessageFromStore(...) !== undefined`;换成
     * `hasMessageInStore` 是同一口同一义,只是不把消息交出去、也就不必冻。)
     *
     * `if (changed)` 没了,不是丢了判据:reducer 的 `changed` 对 upsert **恒为 true**
     * (两支都 `changed: true`),端口那个布尔只在"整条会话不在"时才是 false ——
     * F2-c 把这道判据补上(与 `appendMessage` 同一口、同一条裁定,§16.9)。
     */
    upsertMessage(sessionId, payload) {
      if (sessionReads.hasSessionInStore(sessionId)) {
        const existed = sessionReads.hasMessageInStore(sessionId, payload.message.id)
        events?.upsertMessage(sessionId, payload.message, existed)
      }
      return ports.messages.upsertMessage(sessionId, payload.message)
    },

    /**
     * F2-a:**事件先,store 后**。
     *
     * reducer 的 `changed` 只有一个 false 的理由 —— 那条消息不在(`index === -1`)。
     * 翻转之后不能再等它的回执(等回执就是又把事件排到了 store 后面),所以命令面
     * 自己先问同一个问题,问的是**同一份 store**(`hasMessageInStore` 与 reducer
     * 的 `findIndex` 同源),于是"写不写这条事件"的判据一字未变。
     *
     * (F3 复核结论:**不翻**。判据同源之外还有一笔账 —— 这是逐 token 的热路径,
     * 而投影侧最便宜的存在性口 `eventsGetMessage` 每次都物化整条会话。§16.10)
     */
    patchMessage(sessionId, payload) {
      if (sessionReads.hasMessageInStore(sessionId, payload.messageId)) {
        events?.patchMessage(sessionId, payload.messageId, payload.patch)
      }
      return ports.messages.patchMessageFields(
        sessionId,
        payload.messageId,
        payload.patch,
        payload.hint,
      )
    },

    appendContentPart(sessionId, payload) {
      assertContentPartIsCarriable(sessionId, payload.part)
      return ports.messages.addMessageContentPart(sessionId, payload.messageId, payload.part)
    },

    upsertStep(sessionId, payload) {
      return ports.messages.addMessageStep(sessionId, payload.messageId, payload.step)
    },

    patchStep(sessionId, payload) {
      return ports.messages.updateMessageStep(sessionId, payload.messageId, payload.stepId, payload.updates)
    },

    patchStepsUsageByTurn(sessionId, payload) {
      return ports.messages.updateStepsUsageByTurn(
        sessionId,
        payload.messageId,
        payload.turnIndex,
        payload.usage,
      )
    },

    setToolCalls(sessionId, payload) {
      return ports.messages.updateMessageToolCalls(sessionId, payload.messageId, payload.toolCalls)
    },

    /**
     * F2-b:**事件先,store 后**。三件事按这个顺序:
     *
     * 1. **取材**。编辑重发那一支要编辑**前**的那条做底稿(翻转之前是 reducer 先
     *    写完、翻译器再把改好的那条读回来;现在改由命令自己合成)。走 **store 侧**
     *    的 `getMessageFromStore` —— F3(§16.10)复核过:原来那条理由("`getMessage`
     *    会回读到滞后投影",§13.18 发现 B)F1 之后已不成立,今天的理由是**底稿同源**:
     *    reducer 的 `applyTruncate` 就是拿 store 上那一条改的,事件里那条
     *    `user/message-edited.data.message` 必须与它逐字同源,否则恒等门比的是两份
     *    形状不同的底稿。它与下面第 3 条(时刻由命令决定一次)是同一条纪律的两半。
     * 2. **判据**。reducer 的 `changed` 只有一个 false 的理由 —— 那条消息不在
     *    (`applyTruncate` 的 `index === -1`)。删除那一支不需要底稿,所以单问一句
     *    存在性;编辑那一支的底稿在不在就是同一个答案,不再多问一次。
     * 3. **时刻**。`truncateFrom{inclusive:false}` 是唯一一条由 reducer **合成消息
     *    字段**的命令(给被改写的那条盖新 `timestamp`)。事件排到 reducer 前面之后,
     *    这个数必须由命令决定一次,**同时**递给事件与 reducer —— 否则事件上是命令
     *    的时钟、store 上是 reducer 的时钟,恒等门(§16.5)比的就是两次读表。
     *
     * surface range 照旧在截断之前取(截断之后那些节点还在 surface 上,但"从哪条起"
     * 要按当时的位置算)—— 事件产地本来就排在 reducer 之前,这一条自然成立。
     */
    truncateFrom(sessionId, payload) {
      const before = payload.inclusive
        ? undefined
        : (sessionReads.getMessageFromStore(sessionId, payload.messageId) as ChatMessage | undefined)
      const present = payload.inclusive
        ? sessionReads.hasMessageInStore(sessionId, payload.messageId)
        : before !== undefined
      const at = now()
      if (present) events?.truncateFrom(sessionId, payload, { before, now: at })

      return payload.inclusive
        ? ports.messages.deleteMessageAndTruncate(sessionId, payload.messageId)
        : ports.messages.updateMessageAndTruncate(
            sessionId,
            payload.messageId,
            payload.newContent ?? '',
            {
              // 只有显式带了 contentParts 键才动它(与老 mutator 的 hasContentParts 同义)
              ...(Object.prototype.hasOwnProperty.call(payload, 'contentParts')
                ? { contentParts: payload.contentParts }
                : {}),
              now: at,
            },
          )
    },

    /**
     * F2-a:**事件先,store 后**。判据同 `patchMessage` —— reducer 只在"那条消息
     * 不在"时不改任何东西,所以命令面先在同一份 store 上问一次存在性。
     *
     * 按 marker 删的那一支**本来就是**先找后删(命令面不知道删掉的是哪一条,
     * 而事件要写 id),F2-a 只是把事件从"删完之后"提到了"删之前"。
     */
    deleteMessage(sessionId, payload) {
      if ('messageId' in payload) {
        if (sessionReads.hasMessageInStore(sessionId, payload.messageId)) {
          events?.deleteMessage(sessionId, payload.messageId)
        }
        return ports.messages.deleteMessage(sessionId, payload.messageId)
      }
      // F3(§16.10)复核:**留在 store**。理由不再是"投影滞后"(§13.18 发现 B,
      // F1 之后不成立),而是**判据同源** —— 下一行 `deleteMessageWhere` 的 reducer
      // 在同一份 store 上跑同一个谓词,两边找到的必须是同一条。
      const target = sessionReads.findMessageFromStore(sessionId, payload.matchMarker)
      if (target) events?.deleteMessage(sessionId, target.id)
      return ports.messages.deleteMessageWhere(sessionId, payload.matchMarker)
    },

    /**
     * 整份日志换掉。`reason:'clear'` 是群聊「清空聊天记录」的**唯一**落点:
     * 换 → 索引计数归零 → 强刷一次。(那套行为原先住在
     * `stores/clearSessionMessages` 里;P0.2 迁过来之后它零调用点,已随 F4-a
     * 删除,§16.12。)
     *
     * **留档那一步已退役**(S3w-3 批 6b,裁定 10):清空在账本上是
     * `session/cleared` —— 只遮蔽、不删除,被遮的消息事件原样躺在
     * `events.jsonl` 里,事件本身就是档。连带"留档必须在 flush 之后"那条
     * 纪律与它的前置 flush 一起消失。
     *
     * **F2-c:事件先,store 后**。判据本来就在第一句 —— 那条会话不在就一条事件
     * 都不写(与 `appendMessage` / `upsertMessage` 新补的那道口径一致);
     * `normalize` 不翻译是判例,住在事件构造里。`wholeRange()` 取的是活 surface,
     * 与 store 无关,所以翻转前后取到的范围逐字相同。
     */
    async replaceAll(sessionId, payload) {
      const session = ports.getSession(sessionId)
      if (!session) return { replaced: false, previousCount: 0 }
      const previousCount = session.messages.length
      const isClear = payload.reason === 'clear'

      events?.replaceAll(sessionId, payload.messages, payload.reason)
      ports.messages.replaceAllMessages(sessionId, payload.messages, payload.reason)

      ports.updateSessionsIndexMeta(sessionId, meta => {
        meta.updatedAt = session.updatedAt
        meta.messageCount = payload.messages.length
        if (payload.messages.length === 0) delete meta.previewText
      })

      if (isClear) await ports.flushSessionSave(sessionId)

      return { replaced: true, previousCount }
    },

    repairOnLoad(sessionId, payload) {
      return ports.messages.repairOnLoad(sessionId, payload?.policy ?? 'startup')
    },

    /**
     * F2-c:**事件先,store 后**。
     *
     * reducer(`applyMetadataMutation`)只有一个 false 的理由 —— 那条会话不在
     * (`getSession` 取不到就整条 no-op)。而命令面本来就要取 `before` 算快照,
     * 所以这道判据是**同一次取材的副产品**:取到了 = 改得成,一次读、两个用途。
     *
     * 另外两个 `session/*-changed` 的产地(`stores/sessions.ts` 的
     * `updateSessionAgent`、server 的 `sessions.update`,§13.10 M7)**绕开命令面**,
     * 而且必须留在写成功之后 —— 它们的 `to` 取的是落库之后那一格。事件构造对
     * 顺序中立,三处共用同一份(见 `sessionCommandEvents.patchSession`)。
     */
    patchSession(sessionId, payload) {
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

// ============ 生产接线 ============

let singleton: SessionCommands | undefined

/**
 * 生产实例(懒建):导入本模块**不做任何装配动作**
 * (`app/__tests__/import-side-effect-free.test.ts` 守着这条)。
 */
export function getSessionCommands(): SessionCommands {
  if (!singleton) {
    singleton = createSessionCommands({
      messages: getSessionMessageCommandRuntime(),
      getSession,
      updateSessionsIndexMeta: updateSessionsIndexMetaForCommands,
      flushSessionSave,
      stampCollabAgentId,
      patchSession: patchSessionFields,
    })
  }
  return singleton
}

/** 命令面的门牌:P0.2/P0.3 的调用点全部改成 `sessionCommands.<cmd>(...)`。 */
export const sessionCommands: SessionCommands = {
  appendMessage: (sessionId, payload) => getSessionCommands().appendMessage(sessionId, payload),
  upsertMessage: (sessionId, payload) => getSessionCommands().upsertMessage(sessionId, payload),
  patchMessage: (sessionId, payload) => getSessionCommands().patchMessage(sessionId, payload),
  appendContentPart: (sessionId, payload) => getSessionCommands().appendContentPart(sessionId, payload),
  upsertStep: (sessionId, payload) => getSessionCommands().upsertStep(sessionId, payload),
  patchStep: (sessionId, payload) => getSessionCommands().patchStep(sessionId, payload),
  patchStepsUsageByTurn: (sessionId, payload) => getSessionCommands().patchStepsUsageByTurn(sessionId, payload),
  setToolCalls: (sessionId, payload) => getSessionCommands().setToolCalls(sessionId, payload),
  truncateFrom: (sessionId, payload) => getSessionCommands().truncateFrom(sessionId, payload),
  deleteMessage: (sessionId, payload) => getSessionCommands().deleteMessage(sessionId, payload),
  replaceAll: (sessionId, payload) => getSessionCommands().replaceAll(sessionId, payload),
  repairOnLoad: (sessionId, payload) => getSessionCommands().repairOnLoad(sessionId, payload),
  patchSession: (sessionId, payload) => getSessionCommands().patchSession(sessionId, payload),
}
