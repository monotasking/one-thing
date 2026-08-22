/**
 * Chat IPC Handlers
 *
 * 结构债 P4c 第五批之后这里只剩**一条** —— `RESUME_AFTER_TOOL_CONFIRM`
 * (拍板 #21)。六条数据面(history / title / system-prompt-snapshot /
 * thinking-time / abort / active-streams)已整只迁到通用 RPC 通道
 * (`chatRouter` + `packages/backend/rpc/domains/chat.ts`),那里对两个宿主是同
 * 一条实现。
 *
 * 留下的这一条要的是 `event.sender`:恢复流要往哪个 `webContents` 上推。
 * router 的信封里没有这一格,而 web 侧同名方法从来就不是一次 invoke ——
 * 它打的是命令总线上的 `command:resume-after-confirm`。
 */

import { emitCoreSessionEventSafely } from '@onething/core/events'
import {
  registerElectronChatIpcHandlers,
  type ElectronResumeAfterToolConfirmRequest,
} from '@onething/electron-host/ipc/chat'
import * as store from '@onething/backend/store.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { getStreamEngine } from '@onething/backend/wiring/engine/index.js'
import { resumeOnethingAfterToolConfirmationForIpc } from '@onething/runtime/sessions'
import {
  extractOnethingCaughtErrorDetails,
  getOnethingCaughtErrorMessage,
} from '@onething/runtime/providers'
import { getEventBus } from '@onething/backend/events/index.js'

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
      resumeAfterToolConfirm: IPC_CHANNELS.RESUME_AFTER_TOOL_CONFIRM,
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
