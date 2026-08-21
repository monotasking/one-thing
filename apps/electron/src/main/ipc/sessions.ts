import { registerElectronSessionIpcHandlers } from '@onething/electron-host/ipc/sessions'
import { v4 as uuidv4 } from 'uuid'
import fs from 'node:fs/promises'
import {
  activateOnethingSessionForIpc,
  addOnethingSystemMessageForIpc,
  createOnethingBranchSessionForIpc,
  createOnethingSessionForIpc,
  deleteOnethingSessionForIpc,
  describeInvalidOnethingCreateSessionRequestForIpc,
  getOnethingSessionForIpc,
  getOnethingSessionMessagesForIpc,
  getOnethingSessionMessagesPageForIpc,
  getOnethingSessionTokenUsageForIpc,
  listOnethingSessionsForIpc,
  listOnethingSessionUserMarkersForIpc,
  removeOnethingMessageForIpc,
  removeOnethingSystemMarkerMessageForIpc,
  renameOnethingSessionForIpc,
  switchOnethingSessionForIpc,
  updateOnethingSessionAgent,
  updateOnethingSessionArchivedForIpc,
  updateOnethingSessionModel,
  updateOnethingSessionPinForIpc,
  updateOnethingSessionPermissionMode,
  updateOnethingSessionWorkingDirectory,
} from '@onething/runtime/sessions'
import { isValidSpaceId } from '@onething/runtime/spaces/types'
import { deleteSessionAiTodo, notifyTodoPlanActiveSessionChanged } from '@onething/app/todo-plan/store.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { ChatMessage, ChatSession, GetSessionMessagesPageRequest } from '@shared/ipc.js'
import * as store from '@onething/app/store.js'
import { DEFAULT_AGENT_ID, agentExists } from '@onething/app/agents/index.js'
import { ensureCollabGroupRoom, type CollabGroupRoomInput } from '@onething/app/collab/index.js'
import type { PermissionMode } from '@shared/ipc.js'
import { workdirGateway } from '@onething/app/variables/gateways.js'
import { readSessionSegments } from '@onething/app/toc/index.js'
import {
  clearSessionUsage,
  getSessionUsage,
  updateSessionUsage,
} from '@onething/app/session/usage.js'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('ipc.sessions')

export { clearSessionUsage, getSessionUsage, updateSessionUsage } from '@onething/app/session/usage.js'

export function registerSessionHandlers() {
  registerElectronSessionIpcHandlers({
    handlers: [
      {
        channel: IPC_CHANNELS.GET_SESSIONS,
        handle: async () => listOnethingSessionsForIpc({
          listSessions: () => store.getSessionsList(),
          logger: console,
        }),
      },
      {
        channel: IPC_CHANNELS.GET_SESSIONS_LIST,
        handle: async () => listOnethingSessionsForIpc({
          listSessions: () => store.getSessionsList(),
          logger: console,
        }),
      },
      {
        channel: IPC_CHANNELS.ACTIVATE_SESSION,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return activateOnethingSessionForIpc({
            sessionId,
            getSessionDetails: id => store.getSessionDetails(id),
            setCurrentSessionId: (id) => {
              store.setCurrentSessionId(id)
              // The detached todo window renders whichever session is active.
              notifyTodoPlanActiveSessionChanged()
            },
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_MESSAGES,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return getOnethingSessionMessagesForIpc({
            sessionId,
            getSessionMessages: id => store.getSessionMessages(id),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_MESSAGES_PAGE,
        handle: async (request) => {
          const typedRequest = request as GetSessionMessagesPageRequest
          const start = performance.now()
          const response = await getOnethingSessionMessagesPageForIpc({
            request: typedRequest,
            getSessionMessagesPage: nextRequest =>
              store.getSessionMessagesPage(nextRequest as GetSessionMessagesPageRequest),
            logger: console,
          })
          if (response.success) {
            log.debug('session messages page served', {
              sessionId: typedRequest.sessionId,
              totalMs: Math.round(performance.now() - start),
              messages: response.messages?.length ?? 0,
              success: true,
            })
          } else {
            log.debug('session messages page served', {
              sessionId: typedRequest.sessionId,
              totalMs: Math.round(performance.now() - start),
              success: false,
            })
          }
          return response
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_USER_MARKERS,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return listOnethingSessionUserMarkersForIpc({
            sessionId,
            getSessionUserMessageMarkers: id => store.getSessionUserMessageMarkers(id),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_SEGMENTS,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          try {
            return { success: true, segments: await readSessionSegments(sessionId) }
          } catch (error) {
            log.error('read session segments failed', { sessionId }, error)
            return { success: false, segments: [] }
          }
        },
      },
      {
        channel: IPC_CHANNELS.CREATE_SESSION,
        handle: async (request) => {
          const { name, sessionId, workspaceId, kind, room } = request as {
            name?: string
            sessionId?: string
            workspaceId?: string
            kind?: string
            room?: CollabGroupRoomInput
          }
          // workspaceId 进 `workspaces/<id>/` 的路径片段,字符集卡死;非法值
          // 不报错、直接当没带(缺席 = default),不给它拖垮建会话这条路。
          const resolvedWorkspaceId = isValidSpaceId(workspaceId) ? workspaceId : undefined
          // 建会话请求的三条规矩(自带 id 的格式、不认领已存在的会话、kind 只认
          // 'room')连同失败文案都在运行时里;这里只把请求递过去、把判定原样递回。
          const invalidRequest = await describeInvalidOnethingCreateSessionRequestForIpc({
            sessionId,
            kind,
            getSession: id => store.getSession(id),
          })
          if (invalidRequest) return invalidRequest
          if (kind === 'room') {
            // 建房的规则书只有一本,在 app 层(collab/room-create.ts)—— 成员过滤、
            // 查无此人、退休拒收、PM 在册、budgets 归一、dm 字面 true,连文案都与
            // 「改房」那条路(setCollabRoomConfig)对齐。这里只递形状,不留规则。
            return ensureCollabGroupRoom(name || 'New Chat', room, {
              sessionId: sessionId ?? uuidv4(),
            })
          }
          return await createOnethingSessionForIpc({
            sessionId: sessionId ?? uuidv4(),
            name,
            createSession: (id, nextName) =>
              store.createSession(id, nextName, { workspaceId: resolvedWorkspaceId }),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.SWITCH_SESSION,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return switchOnethingSessionForIpc({
            sessionId,
            getSession: id => store.getSession(id),
            setCurrentSessionId: (id) => {
              store.setCurrentSessionId(id)
              // The detached todo window renders whichever session is active.
              notifyTodoPlanActiveSessionChanged()
            },
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return getOnethingSessionForIpc({
            sessionId,
            getSession: id => store.getSession(id),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.DELETE_SESSION,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return deleteOnethingSessionForIpc({
            sessionId,
            deleteSession: (id) => {
              const result = store.deleteSession(id)
              // The AI todo is keyed by session id, so it goes with the session
              // — including any children the delete cascaded to.
              for (const deletedId of result.deletedIds) {
                deleteSessionAiTodo(deletedId).catch(error => {
                  log.error('delete session AI todo failed', { sessionId: deletedId }, error)
                })
              }
              return result
            },
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.RENAME_SESSION,
        handle: async (request) => {
          const { sessionId, newName } = request as { sessionId: string; newName: string }
          return renameOnethingSessionForIpc({
            sessionId,
            newName,
            renameSession: (id, nextName) => store.renameSession(id, nextName),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_PIN,
        handle: async (request) => {
          const { sessionId, isPinned } = request as { sessionId: string; isPinned: boolean }
          return updateOnethingSessionPinForIpc({
            sessionId,
            isPinned,
            updateSessionPin: (id, nextPinned) => store.updateSessionPin(id, nextPinned),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_ARCHIVED,
        handle: async (request) => {
          const { sessionId, isArchived, archivedAt } = request as {
            sessionId: string
            isArchived: boolean
            archivedAt?: number
          }
          return updateOnethingSessionArchivedForIpc({
            sessionId,
            isArchived,
            archivedAt,
            updateSessionArchived: (id, nextArchived, nextArchivedAt) =>
              store.updateSessionArchived(id, nextArchived, nextArchivedAt),
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_WORKING_DIRECTORY,
        handle: async (request) => {
          const { sessionId, workingDirectory } = request as { sessionId: string; workingDirectory: string | null }
          return updateOnethingSessionWorkingDirectory({
            sessionId,
            workingDirectory,
            isDirectory: async path => (await fs.stat(path)).isDirectory(),
            writeWorkingDirectory: (id, nextWorkingDirectory) =>
              workdirGateway.write(id, nextWorkingDirectory),
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_MODEL,
        handle: async (request) => {
          const { sessionId, provider, model } = request as { sessionId: string; provider: string; model: string }
          return updateOnethingSessionModel({
            sessionId,
            provider,
            model,
            updateSessionModel: (id, nextProvider, nextModel) =>
              store.updateSessionModel(id, nextProvider, nextModel),
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_AGENT,
        handle: async (request) => {
          const { sessionId, agentId } = request as { sessionId: string; agentId?: string }
          return updateOnethingSessionAgent({
            sessionId,
            agentId,
            defaultAgentId: DEFAULT_AGENT_ID,
            agentExists,
            getSessionKind: (id) => store.getSession(id)?.kind,
            updateSessionAgent: (id, nextAgentId) =>
              store.updateSessionAgent(id, nextAgentId),
          })
        },
      },
      {
        channel: IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE,
        handle: async (request) => {
          const { sessionId, permissionMode } = request as { sessionId: string; permissionMode: PermissionMode }
          return updateOnethingSessionPermissionMode<PermissionMode>({
            sessionId,
            permissionMode,
            allowedPermissionModes: ['normal', 'auto-accept-edits', 'dangerously-allow-all'],
            updateSessionPermissionMode: (id, nextPermissionMode) =>
              store.updateSessionPermissionMode(id, nextPermissionMode),
          })
        },
      },
      {
        channel: IPC_CHANNELS.CREATE_BRANCH,
        handle: async (request) => {
          const { parentSessionId, branchFromMessageId } = request as {
            parentSessionId: string
            branchFromMessageId: string
          }
          return createOnethingBranchSessionForIpc<ChatSession, ChatMessage, ChatSession>({
            parentSessionId,
            branchFromMessageId,
            adapters: {
              createId: uuidv4,
              getSession: id => store.getSession(id),
              createBranchSession: input => store.createBranchSession(
                input.branchId,
                input.branchName,
                input.parentSessionId,
                input.branchFromMessageId,
                input.inheritedMessages
              ),
            },
            logger: console,
          })
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_CACHE_STATS,
        handle: async () => store.getSessionCacheStats(),
      },
      {
        channel: IPC_CHANNELS.EVICT_SESSION_CACHE,
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          store.invalidateSessionCache(sessionId)
          return { success: true }
        },
      },
      {
        channel: IPC_CHANNELS.GET_SESSION_TOKEN_USAGE,
        handle: async (sessionId) => getOnethingSessionTokenUsageForIpc({
          sessionId: sessionId as string,
          getSessionTokenUsage: id => store.getSessionTokenUsage(id),
          logger: console,
        }),
      },
      {
        channel: 'add-system-message',
        handle: async (request) => {
          const { sessionId, message } = request as { sessionId: string; message: ChatMessage }
          return addOnethingSystemMessageForIpc({
            sessionId,
            message,
            addMessage: (id, nextMessage) => store.addMessage(id, nextMessage),
            logger: console,
          })
        },
      },
      {
        channel: 'remove-files-changed-message',
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return removeOnethingSystemMarkerMessageForIpc({
            sessionId,
            markerType: 'files-changed',
            getSession: id => store.getSession(id),
            deleteMessage: (id, messageId) => store.deleteMessage(id, messageId),
            logger: console,
          })
        },
      },
      {
        channel: 'remove-git-status-message',
        handle: async (request) => {
          const { sessionId } = request as { sessionId: string }
          return removeOnethingSystemMarkerMessageForIpc({
            sessionId,
            markerType: 'git-status',
            getSession: id => store.getSession(id),
            deleteMessage: (id, messageId) => store.deleteMessage(id, messageId),
            logger: console,
          })
        },
      },
      {
        channel: 'remove-message',
        handle: async (request) => {
          const { sessionId, messageId } = request as { sessionId: string; messageId: string }
          return removeOnethingMessageForIpc({
            sessionId,
            messageId,
            deleteMessage: (id, nextMessageId) => store.deleteMessage(id, nextMessageId),
            logger: console,
          })
        },
      },
    ],
  })
}
