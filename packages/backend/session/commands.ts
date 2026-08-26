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
 *   - `replaceAll{reason:'clear'}` 的留档 + 前后两次强刷 + 索引计数归零。
 *
 * P0.1 只建面,不迁调用点(strangler);P0.2/P0.3 把 78 处业务调用点与 server 迁过来;
 * P0.4 删旧路(`insertMessageAfter` 一族、store-helpers 的消息原语家族、
 * `saveSessionSnapshot`)并把 `session:check` 收到白名单外 0。
 * `app/stores/sessions.ts` 上还留着的那批 `updateMessage*` **不是**死路径:
 * 它们是 core 引擎注入的 store 端口的实现,接口形状 P0 不许动(§6)。
 *
 * **F2-a:三条命令的事件产地已经翻转**(§16.2 的 F2 行 / §16.7)。
 * `appendMessage` / `deleteMessage` / `patchMessage` 现在的执行序是
 * **事件 append(同步可见)→ reducer 应用到 store**,事件构造住在
 * `command-events.ts`(`sessionCommandEvents`),是命令的第一手表达;老 reducer
 * 降级为 F0 的影子验证器(§16.5),独立推导同一件事供恒等门对账。
 * 于是"命令内读得到自己刚写的"对这三条成立(F1 的同步可见,§16.6)。
 * 其余命令(upsert / truncateFrom / replaceAll / patchSession)仍是老口径 ——
 * reducer 先跑,`event-translator.ts` 从 mutation 反推,F2-b/c 再翻。
 *
 * **事件写侧取材纪律(§13.18 发现 B)**:命令面在写完端口后给翻译器递数,一律走
 * `sessionReads.*FromTranscript`(恒读 `messages.jsonl` 真相面),**永不**走
 * `getMessage` / `findMessage` 这类随 `ONETHING_SESSION_READ` 分岔的门面 ——
 * events 读模式下活投影还没看到"正要由这次翻译写出的那条事件",走 fromEvents
 * 会自引用旧投影,把旧正文 / 误判的类别 / 丢失的删除焊进账本(写坏账本,不只是读错)。
 * `fromEvents` 岔口只属于产品读路。`event-translator.ts` 的兜底同此纪律。
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
import { sessionEventTranslator } from './event-translator.js'
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
    options?: { contentParts?: ChatMessage['contentParts'] | null },
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
  appendMessage(sessionId: string, payload: AppendMessagePayload): void
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
   * S1a 的影子写(§10.2 第一行采集点):reducer 落定之后把这次命令翻成事件。
   * **F2 之后这里只剩没翻转的那几条**(upsert / truncateFrom / replaceAll /
   * patchSession);翻转过的走上面的 `events`。
   *
   * 是**选项**而不是硬接线,因为命令面的单元测试要的是"命令做对了什么",
   * 不该顺带把一份事件日志写到某个临时目录里去。生产实例默认接上。
   */
  translator?: typeof sessionEventTranslator | null
}

export function createSessionCommands(
  ports: SessionCommandsPorts,
  options: CreateSessionCommandsOptions = {},
): SessionCommands {
  const translator = options.translator === undefined
    ? sessionEventTranslator
    : options.translator
  const events = options.events === undefined
    ? sessionCommandEvents
    : options.events

  return {
    /**
     * F2-a:**事件先,store 后**。
     *
     * append 是无条件成功的(reducer 的 `changed` 恒为 true),所以这里没有"改没改成"
     * 要问 —— 直接产出事件。F1 保证 `appendSurfaceAwareEvent` 返回时活投影与活 surface
     * 已经前进(§16.6),于是**命令内读得到自己刚写的**;随后的 `addMessage` 是 F0 的
     * 影子验证器(§16.5)在独立推导同一件事。
     */
    appendMessage(sessionId, payload) {
      const message = payload.stampCollab && ports.stampCollabAgentId
        ? ports.stampCollabAgentId(sessionId, payload.message)
        : payload.message
      events?.appendMessage(sessionId, message)
      ports.messages.addMessage(sessionId, message)
    },

    upsertMessage(sessionId, payload) {
      // 翻译要分清"新增"与"就地换掉",所以先问一次在不在。
      // §13.18 发现 B:走抄本真相面 —— events 读模式下活投影还没看到这条流中
      // assistant 消息,`getMessage` 的 fromEvents 岔口会误判成"新增",翻译错类。
      const existed = sessionReads.getMessageFromTranscript(sessionId, payload.message.id) !== undefined
      const changed = ports.messages.upsertMessage(sessionId, payload.message)
      if (changed) translator?.upsertMessage(sessionId, payload.message, existed)
      return changed
    },

    /**
     * F2-a:**事件先,store 后**。
     *
     * reducer 的 `changed` 只有一个 false 的理由 —— 那条消息不在(`index === -1`)。
     * 翻转之后不能再等它的回执(等回执就是又把事件排到了 store 后面),所以命令面
     * 自己先问同一个问题,问的是**同一份 store**(`hasMessageInTranscript` 与 reducer
     * 的 `findIndex` 同源),于是"写不写这条事件"的判据一字未变。
     *
     * (F3 才把这一侧的取材整体翻成读投影;F2-a 照 §13.18 的纪律仍走抄本面。)
     */
    patchMessage(sessionId, payload) {
      if (sessionReads.hasMessageInTranscript(sessionId, payload.messageId)) {
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

    truncateFrom(sessionId, payload) {
      // 翻译要在**截断之前**取 surface range(截断之后那些节点还在 surface 上,
      // 但"从哪条起"要按当时的位置算)—— 所以先算,后写。
      const changed = payload.inclusive
        ? ports.messages.deleteMessageAndTruncate(sessionId, payload.messageId)
        : ports.messages.updateMessageAndTruncate(
            sessionId,
            payload.messageId,
            payload.newContent ?? '',
            // 只有显式带了 contentParts 键才动它(与老 mutator 的 hasContentParts 同义)
            Object.prototype.hasOwnProperty.call(payload, 'contentParts')
              ? { contentParts: payload.contentParts }
              : undefined,
          )
      if (changed) {
        translator?.truncateFrom(
          sessionId,
          payload,
          payload.inclusive
            ? undefined
            // §13.18 发现 B:抄本真相面 —— reducer 刚把新正文+新 timestamp 落进内存
            // store,而 `user/message-edited` 事件正要由这次翻译写出;走 fromEvents
            // 会回读到编辑前的旧正文,把它永久焊进账本。
            : (sessionReads.getMessageFromTranscript(sessionId, payload.messageId) as ChatMessage | undefined),
        )
      }
      return changed
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
        if (sessionReads.hasMessageInTranscript(sessionId, payload.messageId)) {
          events?.deleteMessage(sessionId, payload.messageId)
        }
        return ports.messages.deleteMessage(sessionId, payload.messageId)
      }
      // §13.18 发现 B:抄本真相面 —— events 读模式下活投影滞后会找不到,
      // 该产出的 `message/deleted` 整条丢失。
      const target = sessionReads.findMessageFromTranscript(sessionId, payload.matchMarker)
      if (target) events?.deleteMessage(sessionId, target.id)
      return ports.messages.deleteMessageWhere(sessionId, payload.matchMarker)
    },

    /**
     * 整份日志换掉。`reason:'clear'` 保留 `clearSessionMessages` 的其余行为:
     * 换 → 索引计数归零 → 强刷一次。
     *
     * **留档那一步已退役**(S3w-3 批 6b,裁定 10):清空在账本上是
     * `session/cleared` —— 只遮蔽、不删除,被遮的消息事件原样躺在
     * `events.jsonl` 里,事件本身就是档。连带"留档必须在 flush 之后"那条
     * 纪律与它的前置 flush 一起消失。
     */
    async replaceAll(sessionId, payload) {
      const session = ports.getSession(sessionId)
      if (!session) return { replaced: false, previousCount: 0 }
      const previousCount = session.messages.length
      const isClear = payload.reason === 'clear'

      ports.messages.replaceAllMessages(sessionId, payload.messages, payload.reason)
      translator?.replaceAll(sessionId, payload.messages, payload.reason)

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

    patchSession(sessionId, payload) {
      const before = ports.getSession(sessionId)
      const snapshot = before
        ? {
            agentId: before.agentId,
            lastModel: before.lastModel,
            lastProvider: before.lastProvider,
            workingDirectory: before.workingDirectory,
          }
        : undefined
      const changed = ports.patchSession(sessionId, payload.patch, payload.mutateIndexMeta)
      if (changed) translator?.patchSession(sessionId, payload.patch, snapshot)
      return changed
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
