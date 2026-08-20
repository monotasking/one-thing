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
  archiveSessionMessages,
  flushSessionSave,
  getSession,
  getSessionMessageCommandRuntime,
  patchSessionFields,
  stampCollabAgentId,
  updateSessionsIndexMetaForCommands,
} from '../stores/sessions.js'
import { assertContentPartIsCarriable } from './content-part-guard.js'
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
  /** 清空前把当前日志原样留档,返回留档路径(无消息可留时 undefined) */
  archiveMessages(sessionId: string): string | undefined
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
  archivePath?: string
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
   * S1a 的影子写(§10.2 第一行采集点):reducer 落定之后把这次命令翻成事件。
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

  return {
    appendMessage(sessionId, payload) {
      const message = payload.stampCollab && ports.stampCollabAgentId
        ? ports.stampCollabAgentId(sessionId, payload.message)
        : payload.message
      ports.messages.addMessage(sessionId, message)
      translator?.appendMessage(sessionId, message)
    },

    upsertMessage(sessionId, payload) {
      // 翻译要分清"新增"与"就地换掉",所以先问一次在不在(读门面,不碰数组)。
      const existed = sessionReads.getMessage(sessionId, payload.message.id) !== undefined
      const changed = ports.messages.upsertMessage(sessionId, payload.message)
      if (changed) translator?.upsertMessage(sessionId, payload.message, existed)
      return changed
    },

    patchMessage(sessionId, payload) {
      const changed = ports.messages.patchMessageFields(
        sessionId,
        payload.messageId,
        payload.patch,
        payload.hint,
      )
      if (changed) translator?.patchMessage(sessionId, payload.messageId, payload.patch)
      return changed
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
            : (sessionReads.getMessage(sessionId, payload.messageId) as ChatMessage | undefined),
        )
      }
      return changed
    },

    deleteMessage(sessionId, payload) {
      if ('messageId' in payload) {
        const changed = ports.messages.deleteMessage(sessionId, payload.messageId)
        if (changed) translator?.deleteMessage(sessionId, payload.messageId)
        return changed
      }
      // 按 marker 删:命令面不知道删掉的是哪一条,所以先找出来再删
      // (`deleteMessageWhere` 内部会再找一次 —— 两次 find 换一条能翻译的事件)。
      const target = sessionReads.findMessage(sessionId, payload.matchMarker)
      const changed = ports.messages.deleteMessageWhere(sessionId, payload.matchMarker)
      if (changed && target) translator?.deleteMessage(sessionId, target.id)
      return changed
    },

    /**
     * 整份日志换掉。`reason:'clear'` 保留今天 `clearSessionMessages` 的全部行为:
     * 先排空在途节流写入 → 留档 → 换 → 索引计数归零 → 再强刷一次。
     * 留档必须在 flush 之后:否则留档少的正是最后那几条。
     */
    async replaceAll(sessionId, payload) {
      const session = ports.getSession(sessionId)
      if (!session) return { replaced: false, previousCount: 0 }
      const previousCount = session.messages.length
      const isClear = payload.reason === 'clear'

      let archivePath: string | undefined
      if (isClear) {
        await ports.flushSessionSave(sessionId)
        if (previousCount > 0) archivePath = ports.archiveMessages(sessionId)
      }

      ports.messages.replaceAllMessages(sessionId, payload.messages, payload.reason)
      translator?.replaceAll(sessionId, payload.messages, payload.reason)

      ports.updateSessionsIndexMeta(sessionId, meta => {
        meta.updatedAt = session.updatedAt
        meta.messageCount = payload.messages.length
        if (payload.messages.length === 0) delete meta.previewText
      })

      if (isClear) await ports.flushSessionSave(sessionId)

      return {
        replaced: true,
        previousCount,
        ...(archivePath ? { archivePath } : {}),
      }
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
      archiveMessages: archiveSessionMessages,
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
