/**
 * Chat IPC Handlers
 * Main entry point for chat-related IPC handlers
 */

import { emitCoreSessionEventSafely } from '@onething/core/events'
import {
  registerElectronChatIpcHandlers,
  type ElectronAbortStreamRequest,
  type ElectronChatSessionRequest,
  type ElectronGenerateTitleRequest,
  type ElectronResumeAfterToolConfirmRequest,
  type ElectronUpdateMessageThinkingTimeRequest,
} from '@onething/electron-host/ipc/chat'
import * as store from '@onething/backend/store.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import {
  generateChatTitle,
  isProviderSupported,
} from '@onething/backend/providers/index.js'
import { Permission } from '@onething/backend/wiring/permission/index.js'
import {
  resolveProviderAuth,
  getProviderApiType,
} from '@onething/backend/engine/stream/provider-helpers.js'
import { getStreamEngine } from '@onething/backend/engine/index.js'
import { abortCollabRoomTurnForStop } from '@onething/backend/collab/index.js'
import {
  abortOnethingStreamsForIpc,
  getOnethingChatHistoryForIpc,
  listOnethingActiveStreamsForIpc,
  resumeOnethingAfterToolConfirmationForIpc,
  updateOnethingMessageThinkingTimeForIpc,
} from '@onething/runtime/sessions'
import {
  extractOnethingCaughtErrorDetails,
  generateOnethingChatTitleForIpc,
  getOnethingCaughtErrorMessage,
} from '@onething/runtime/providers'
import { buildOnethingSystemPromptSnapshotForIpc } from '@onething/runtime/prompts'
import { buildSystemPromptSnapshot } from '@onething/backend/engine/prompt/system-prompt-snapshot.js'
import { getEventBus } from '@onething/backend/events/index.js'
import { billTitleUsage } from '@onething/backend/wiring/usage/bill-side-line.js'

import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'

// ============================================
// IPC Handlers
// ============================================

async function emitSessionEvent(sessionId: string, event: Parameters<ReturnType<typeof getEventBus>['emit']>[1]): Promise<void> {
  await emitCoreSessionEventSafely({
    sessionId,
    event,
    eventBus: getEventBus(),
    logger: console,
    errorLabel: '[ChatIPC] EventBus emit failed:',
  })
}

export function registerChatHandlers() {
  type ChatResumeSender = Parameters<ReturnType<typeof getStreamEngine>['handleResumeAfterConfirm']>[2]

  registerElectronChatIpcHandlers({
    channels: {
      getHistory: IPC_CHANNELS.GET_CHAT_HISTORY,
      generateTitle: IPC_CHANNELS.GENERATE_TITLE,
      getSystemPromptSnapshot: IPC_CHANNELS.GET_SYSTEM_PROMPT_SNAPSHOT,
      updateMessageThinkingTime: IPC_CHANNELS.UPDATE_MESSAGE_THINKING_TIME,
      abortStream: IPC_CHANNELS.ABORT_STREAM,
      getActiveStreams: IPC_CHANNELS.GET_ACTIVE_STREAMS,
      resumeAfterToolConfirm: IPC_CHANNELS.RESUME_AFTER_TOOL_CONFIRM,
    },
    getHistory: async ({ sessionId }: ElectronChatSessionRequest) => {
      return getOnethingChatHistoryForIpc({
        sessionId,
        getSession: id => store.getSession(id),
        logger: console,
      })
    },
    generateTitle: async ({ message }: ElectronGenerateTitleRequest) => {
      return handleGenerateTitle(message)
    },
    getSystemPromptSnapshot: async ({ sessionId }: ElectronChatSessionRequest) => {
      return buildOnethingSystemPromptSnapshotForIpc({
        sessionId,
        buildSnapshot: buildSystemPromptSnapshot,
        errorMessage: (error, fallback) =>
          getOnethingCaughtErrorMessage(error, fallback),
        logger: console,
      })
    },
    updateMessageThinkingTime: async ({
      sessionId,
      messageId,
      thinkingTime,
    }: ElectronUpdateMessageThinkingTimeRequest) => {
      return updateOnethingMessageThinkingTimeForIpc({
        sessionId,
        messageId,
        thinkingTime,
        updateMessageThinkingTime: (sid, mid, nextThinkingTime) =>
          store.updateMessageThinkingTime(sid, mid, nextThinkingTime),
        logger: console,
      })
    },
    abortStream: async ({ sessionId }: ElectronAbortStreamRequest = {}) => {
      return abortOnethingStreamsForIpc({
        sessionId,
        // 群聊房间的停止按钮(collab-team-v2 §5.1 入口①):房间会话上没有流,
        // 真正要停的是本轮发言人的执行会话。装配层在这里注入,产品层不 import app。
        abortCollabRoomTurn: sid => {
          try {
            return abortCollabRoomTurnForStop(sid)
          } catch {
            return false
          }
        },
        abortEngineStream: sid => {
          try {
            return getStreamEngine().abort(sid)
          } catch {
            // StreamEngine may not be initialized in legacy/bootstrap contexts.
            return false
          }
        },
        abortAllEngineStreams: () => {
          try {
            getStreamEngine().abortAll()
            return true
          } catch {
            // StreamEngine may not be initialized in legacy/bootstrap contexts.
            return false
          }
        },
        clearPermission: sid => Permission.clearSession(sid),
        getSession: sid => store.getSession(sid),
        updateMessageStep: (sid, messageId, stepId, updates) =>
          store.updateMessageStep(
            sid,
            messageId,
            stepId,
            updates as Parameters<typeof store.updateMessageStep>[3],
          ),
        updateMessageStreaming: (sid, messageId, streaming) =>
          store.updateMessageStreaming(sid, messageId, streaming),
        flushSessionSave: sid => store.flushSessionSave(sid),
        emitEvent: (sid, event) =>
          emitSessionEvent(sid, event as Parameters<typeof emitSessionEvent>[1]),
        logger: console,
      })
    },
    getActiveStreams: async () => {
      return listOnethingActiveStreamsForIpc({
        getEngineActiveSessionIds: () => getStreamEngine().getActiveSessionIds(),
      })
    },
    resumeAfterToolConfirm: async (
      { sessionId, messageId }: ElectronResumeAfterToolConfirmRequest,
      sender: unknown,
    ) => {
      return resumeOnethingAfterToolConfirmationForIpc({
        sessionId,
        messageId,
        getSession: sid => store.getSession(sid),
        emitEvent: (sid, nextEvent) =>
          emitSessionEvent(sid, nextEvent as Parameters<typeof emitSessionEvent>[1]),
        resume: () =>
          getStreamEngine().handleResumeAfterConfirm(
            sessionId,
            { type: SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM, messageId },
            sender as ChatResumeSender,
          ),
        errorMessage: (error, fallback) =>
          getOnethingCaughtErrorMessage(error, fallback),
        errorDetails: extractOnethingCaughtErrorDetails,
        logger: console,
      })
    },
  })
}

// ============================================
// Handler Implementations
// ============================================

// Generate chat title
async function handleGenerateTitle(userMessage: string) {
  return generateOnethingChatTitleForIpc({
    userMessage,
    settings: store.getSettings(),
    adapters: {
      isProviderSupported,
      resolveAuth: resolveProviderAuth,
      getProviderApiType,
      generateTitle: (providerId, providerConfig, message, options) =>
        generateChatTitle(
          providerId,
          {
            apiKey: providerConfig.apiKey,
            authContext: providerConfig.authContext,
            oauthToken: providerConfig.oauthToken as Parameters<typeof generateChatTitle>[1]['oauthToken'],
            baseUrl: providerConfig.baseUrl,
            model: providerConfig.model || '',
            apiType: providerConfig.apiType,
          },
          message,
          {
            ...(options as Parameters<typeof generateChatTitle>[3]),
            onUsage: billTitleUsage(providerId, providerConfig.model || ''),
          },
        ),
      logger: console,
    },
  })
}
