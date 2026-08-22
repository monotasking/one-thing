/**
 * chat(聊天面)域 —— 结构债 P4c 第五批,**六条**方法从手写 IPC 通道搬到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉四处镜像:
 *  - `apps/electron/src/ipc/chat.ts` 的手写 IPC 工厂 + `@main/ipc/chat.ts` 那层
 *    壳适配(两个文件本批只缩不删,2026-08-22 的 #21 把余下那一条也删了,见下);
 *  - `preload/bridge.ts` 的六条包装与 `platform/web.ts` 的六条 REST 镜像;
 *  - `server/http.ts` 的五条路由(`/api/chat/history` / `/api/chat/title` /
 *    `/api/chat/update-thinking-time` / `/api/streams/abort` /
 *    `/api/streams/active`)与 `/api/sessions/:id/system-prompt-snapshot` 那一
 *    条正则分支,连同 `server/runtime.ts` 里 `chat` / `prompts` 两个 adapter 和
 *    `streams` 上的 `abort` / `active` 两只 —— 那是同一件事的**第二份实现**。
 *
 * 逻辑一行没搬:六条逐条转调 `@onething/runtime` 的投影
 * (`getOnethingChatHistoryForIpc` / `generateOnethingChatTitleForIpc` /
 * `buildOnethingSystemPromptSnapshotForIpc` /
 * `updateOnethingMessageThinkingTimeForIpc` / `abortOnethingStreamsForIpc` /
 * `listOnethingActiveStreamsForIpc`),仓本体照旧是 `@onething/backend/store`
 * 那一份 —— 与迁移前 `@main` 那份适配逐字同义,连 `logger: console` 都只是换成
 * 了同一个鸭子 logger 端口。
 *
 * ## 第七条「工具审批后恢复流」于 2026-08-22(#21)连同它的 invoke 通道整条
 * 删除:渲染层零调用者,且引擎侧 `result.requiresConfirmation === true` 早已
 * 无生产者(toolkit 重建后审批在工具内阻塞,runner 的 pause 抛不出来)。引擎的
 * `command:resume-after-confirm` 与 `handleResumeAfterConfirm` 仍在命令总线上。
 *
 * ## 一处 `transport` 分叉也没有
 *
 * 与 sessions 域不同,这六条在两个宿主上要碰的东西是同一套:引擎、会话仓、
 * 权限。被删掉的 server 实现比桌面多的那两道门都不是行为契约 ——
 * 「这条会话属不属于这个 owner」在单用户 server 上恒真(A 期:一个 store 一台
 * core,鉴权在 HTTP 的 Bearer 边界上),而「清 server 壳自己那本待决权限镜像」
 * 碰的是壳的私产,产品层看不见也不该看见(与 `sessions.delete` 同一处理)。
 *
 * 两处**行为确实变了**,都是往「一个 store 一台 core」的方向收(逐条记在报告里):
 *  1. `getActiveStreams` 从此读引擎自己的活会话表(`getActiveSessionIds()`),
 *     不再是 server 壳按 `stream:start` / 终结事件维护的那本影子账;字段名也
 *     从 `streams` 归一到 `sessionIds`。
 *  2. `abortStream` 从此走桌面那条完整收尾(取消挂起的调用、把消息落回非流式
 *     态、补一条带 aborted 标记的终结事件),而不是只 `engine.abort` 一下就回
 *     `{success:true}`。web 因此不再出现「停了但那条消息永远停在流式态」。
 */
import { buildOnethingSystemPromptSnapshotForIpc } from '@onething/runtime/prompts'
import {
  generateOnethingChatTitleForIpc,
  getOnethingCaughtErrorMessage,
} from '@onething/runtime/providers'
import {
  abortOnethingStreamsForIpc,
  getOnethingChatHistoryForIpc,
  listOnethingActiveStreamsForIpc,
  updateOnethingMessageThinkingTimeForIpc,
} from '@onething/runtime/sessions'
import { emitCoreSessionEventSafely } from '@onething/core/events'
import { chatRouter, type ChatRoutes } from '@shared/ipc/chat.js'
import * as store from '../../store.js'
import { getEventBus } from '../../events/index.js'
import { abortCollabRoomTurnForStop } from '../../wiring/collab/index.js'
import { getStreamEngine } from '../../wiring/engine/index.js'
import { buildSystemPromptSnapshot } from '../../wiring/engine/prompt/system-prompt-snapshot.js'
import {
  getProviderApiType,
  resolveProviderAuth,
} from '../../wiring/engine/stream/provider-helpers.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { Permission } from '../../wiring/permission/index.js'
import {
  generateChatTitle,
  isProviderSupported,
} from '../../wiring/providers/index.js'
import { billTitleUsage } from '../../wiring/usage/bill-side-line.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.chat')
/** 投影层收的是鸭子 logger;与迁移前 `@main` 适配里那个 `console` 同一个位置。 */
const consoleLog = consolePort(log)

async function emitSessionEvent(
  sessionId: string,
  event: Parameters<ReturnType<typeof getEventBus>['emit']>[1],
): Promise<void> {
  await emitCoreSessionEventSafely({
    sessionId,
    event,
    eventBus: getEventBus(),
    logger: consoleLog,
    errorLabel: '[ChatRPC] EventBus emit failed:',
  })
}

export const chatRpcHandlers: RpcRouteHandlers<ChatRoutes> = {
  async getHistory(request) {
    return getOnethingChatHistoryForIpc({
      sessionId: request.sessionId,
      getSession: id => store.getSession(id),
      logger: consoleLog,
    })
  },
  async generateTitle(request) {
    return generateOnethingChatTitleForIpc({
      userMessage: request.message,
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
        logger: consoleLog,
      },
    })
  },
  async getSystemPromptSnapshot(request) {
    return buildOnethingSystemPromptSnapshotForIpc({
      sessionId: request.sessionId,
      buildSnapshot: buildSystemPromptSnapshot,
      errorMessage: (error, fallback) => getOnethingCaughtErrorMessage(error, fallback),
      logger: consoleLog,
    })
  },
  async updateMessageThinkingTime(request) {
    return updateOnethingMessageThinkingTimeForIpc({
      sessionId: request.sessionId,
      messageId: request.messageId,
      thinkingTime: request.thinkingTime,
      updateMessageThinkingTime: (sid, mid, nextThinkingTime) =>
        store.updateMessageThinkingTime(sid, mid, nextThinkingTime),
      logger: consoleLog,
    })
  },
  async abortStream(request) {
    return abortOnethingStreamsForIpc({
      sessionId: request.sessionId,
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
      logger: consoleLog,
    })
  },
  async getActiveStreams() {
    return listOnethingActiveStreamsForIpc({
      getEngineActiveSessionIds: () => getStreamEngine().getActiveSessionIds(),
    })
  },
}

export function registerChatRpcDomain(): () => void {
  return registerRouterHandlers(chatRouter, chatRpcHandlers)
}
