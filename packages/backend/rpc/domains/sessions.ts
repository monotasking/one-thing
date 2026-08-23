/**
 * sessions(会话)域 —— 结构债 P4c 第五批,全仓最大的一域:**二十六条**方法从
 * 手写 IPC 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉四处镜像:
 *  - `apps/electron/src/ipc/sessions.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/sessions.ts`
 *    那层壳适配。旧线上除了 22 条 `IPC_CHANNELS.*` 常量,还有**四条写死的字面量
 *    通道**(`add-system-message` / `remove-files-changed-message` /
 *    `remove-git-status-message` / `remove-message`)—— 它们根本不在契约表里,
 *    transport 门连数都数不到。搬完之后这四条不再存在。
 *  - `preload/bridge.ts` 的二十六条包装与 `platform/web.ts` 的二十六条 REST 镜像;
 *  - `server/http.ts` 上对应的 REST 路由与 `server/runtime.ts` 那套 per-owner 的
 *    第二份会话实现(sessions / messages / chat 三个 adapter 里对应的方法)。
 *
 * 逻辑一行没搬:二十六条**逐条**转调 `@onething/runtime/sessions` 的投影
 * (`*OnethingSession*` / `*ForIpc`),仓本体照旧是 `@onething/backend/store` 那一份
 * —— 与迁移前 `@main` 那份适配逐字同义,连 `logger: console` 都只是换成了同一个
 * 鸭子 logger 端口。
 *
 * **`create` 是本域唯一带规则的一条**,而规则一条也不在这里:
 *  - `workspaceId` 进 `workspaces/<id>/` 的路径片段,字符集卡死,非法值直接当没带
 *    (缺席 = default),不给它拖垮建会话这条路;
 *  - 「自带 id 的格式 / 不认领已存在的会话 / kind 只认 'room'」三条连同失败文案在
 *    `describeInvalidOnethingCreateSessionRequestForIpc`(运行时)里;
 *  - 建房的规则书只有一本,在 `wiring/collab/room-create.ts` —— 成员过滤、查无此人、
 *    退休拒收、PM 在册、budgets 归一、dm 字面 true,连文案都与「改房」那条路对齐。
 * 这三段是逐字搬过来的:抄错一个分支就是改行为。
 *
 * **不在本域的会话面**:命令总线入口是 `session-command` 域(第四批);
 * `session:event` / `session:stream` / `sessions:messages-changed` /
 * `sessions:context-size-updated` 是**推送**,router 没有推送面,留在原地。
 *
 * ## 三处按 `context.transport` 分叉(与 session-command 域同一判例)
 *
 * 会话不是一个纯粹的读写域:同一条请求从桌面渲染层来、从浏览器来,能碰到的
 * 东西并不一样。被删掉的 server 实现上有三道桌面没有的门,它们**不是**实现
 * 细节而是行为契约,所以这里逐条补回 `http` 分支,`ipc` 形状一格不动:
 *
 *  1. **`updateWorkingDirectory`**:`http` 把路径夹进本次请求的 `sandboxRoot`
 *     (`rpc/sandbox.ts` 的同一套判定,project-dirs 已经在用),越界回旧的
 *     `Working directory must stay inside the workspace sandbox root.`;
 *     `ipc` 照旧只 `fs.stat`。
 *  2. **`delete`**:`http` 先做旧路由那三件收尾(中止活流、清权限询问、拆事件/
 *     流通道),再走仓的删除与级联;`ipc` 保持桌面原样(它本来就没有这一段)。
 *  3. **`create`**:`http` 上带 `kind` 的请求要看**协调器在不在场**(P4 终态批 B,
 *     拍板 #12)。在场(桌面的内嵌 HTTP 面 —— 它挂的就是桌面那只 `collab: true`
 *     的 backend)走与 `ipc` 完全同一条 `ensureCollabGroupRoom`;不在场(独立
 *     `server:start` 不装配 collab)照旧拒,文案逐字沿用旧 REST。判据与
 *     `/api/capabilities` 下发的 `collabRooms` 同源,UI 与后端不会半开。
 */
import fs from 'node:fs/promises'
import { v4 as uuidv4 } from 'uuid'
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
import type { ChatMessage, ChatSession, GetSessionMessagesPageRequest, PermissionMode } from '@shared/ipc.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { sessionsRouter, type SessionsRoutes } from '@shared/ipc/sessions.js'
import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import { DEFAULT_AGENT_ID, agentExists } from '../../wiring/agents/index.js'
import {
  ensureCollabGroupRoom,
  isCollabV3RuntimeRunning,
  type CollabGroupRoomInput,
} from '../../wiring/collab/index.js'
import { getStreamEngine } from '../../wiring/engine/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { Permission } from '../../wiring/permission/index.js'
import { readSessionSegments } from '../../wiring/toc/index.js'
import { deleteSessionAiTodo, notifyTodoPlanActiveSessionChanged } from '../../wiring/todo-plan/store.js'
import { workdirGateway } from '../../wiring/variables/gateways.js'
import { resolveInsideSandbox, resolveRpcSandbox } from '../sandbox.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.sessions')
/** 投影层收的是鸭子 logger;与迁移前 `@main` 适配里那个 `console` 同一个位置。 */
const consoleLog = consolePort(log)

/** 会话切换时把「当前会话」写进 app-state,并叫醒那扇独立的 todo 窗。 */
function setCurrentSession(sessionId: string): void {
  store.setCurrentSessionId(sessionId)
  // The detached todo window renders whichever session is active.
  notifyTodoPlanActiveSessionChanged()
}

/** 夹不住时的答案。**逐字**沿用被删掉的 server 路由那份文案。 */
const WORKDIR_SANDBOX_ERROR = {
  success: false as const,
  error: 'Working directory must stay inside the workspace sandbox root.',
}

/**
 * 删会话时,联网宿主要做的那三件收尾 —— 从被删掉的 server adapter 逐字搬:
 * 中止活流、清权限询问、拆掉这条会话的事件/流通道。
 *
 * 「中止排在拆通道之前」是原文的顺序,理由也写在原文里:通道一拆,那条终结
 * 事件可能就再也发不出来了。`getController` 是原文 `activeStreamSessions.has`
 * 的等价问法 —— 没有活流就不去碰引擎(`abort` 顺带清的 steering / follow-up
 * 队列对一条正在被删的会话无所谓,但不惊动 `onSessionCleared` 更接近原文)。
 *
 * 桌面(ipc)不走这里:迁移前 `@main` 那条路本来就没有这一段,本批不改桌面。
 */
function releaseServedSession(sessionId: string): void {
  if (getStreamEngine().getController(sessionId)) {
    getStreamEngine().abort(sessionId, 'session deleted')
  }
  Permission.clearSession(sessionId)
  getEventBus().destroySession(sessionId)
  getStreamChannel().destroySession(sessionId)
}

export const sessionsRpcHandlers: RpcRouteHandlers<SessionsRoutes> = {
  async list() {
    return listOnethingSessionsForIpc({
      listSessions: () => store.getSessionsList(),
      logger: consoleLog,
    })
  },
  async listMeta() {
    return listOnethingSessionsForIpc({
      listSessions: () => store.getSessionsList(),
      logger: consoleLog,
    })
  },
  async activate(request) {
    return activateOnethingSessionForIpc({
      sessionId: request.sessionId,
      getSessionDetails: id => store.getSessionDetails(id),
      setCurrentSessionId: setCurrentSession,
      logger: consoleLog,
    })
  },
  async getMessages(request) {
    return getOnethingSessionMessagesForIpc({
      sessionId: request.sessionId,
      // S2b:主读路径收口到读门面,`ONETHING_SESSION_READ=events` 因此能到 UI
      // (`listMessages` 自己按读模式在 `fromEvents()` 上分叉;messages 模式逐字
      // 走 `getSessionMessages`,与旧路同一个函数)。唯一要补的形状差:读门面把
      // “查无此会话”折成 `[]`,而本域的契约是回 NOT_FOUND —— 空结果时用仓库那句
      // `undefined` 信号把它还原,messages 模式下与 S2b 前逐字相同。
      getSessionMessages: (id): ChatMessage[] | undefined => {
        // 读门面交出的是 `readonly` 视图;投影只读它再产出新数组(不改原数组),
        // 这里回到可变签名是安全的。
        const messages = sessionReads.listMessages(id).messages as ChatMessage[]
        if (messages.length > 0) return messages
        return store.getSessionMessages(id) === undefined ? undefined : messages
      },
      logger: consoleLog,
    })
  },
  async getMessagesPage(request) {
    const start = performance.now()
    const response = await getOnethingSessionMessagesPageForIpc({
      request,
      // S2b:同 getMessages,分页也收口到读门面(`pageMessages` 按读模式在
      // `fromEvents()` 上分叉;messages 模式逐字走 `getSessionMessagesPage`,同一份
      // 页信封 hasMoreBefore/After / totalCount / cursor,与旧路同一个函数)。
      getSessionMessagesPage: nextRequest =>
        sessionReads.pageMessages(nextRequest as GetSessionMessagesPageRequest),
      logger: consoleLog,
    })
    if (response.success) {
      log.debug('session messages page served', {
        sessionId: request.sessionId,
        totalMs: Math.round(performance.now() - start),
        messages: response.messages?.length ?? 0,
        success: true,
      })
    } else {
      log.debug('session messages page served', {
        sessionId: request.sessionId,
        totalMs: Math.round(performance.now() - start),
        success: false,
      })
    }
    return response
  },
  async getUserMarkers(request) {
    return listOnethingSessionUserMarkersForIpc({
      sessionId: request.sessionId,
      getSessionUserMessageMarkers: id => store.getSessionUserMessageMarkers(id),
      logger: consoleLog,
    })
  },
  async getSegments(request) {
    try {
      return { success: true, segments: await readSessionSegments(request.sessionId) }
    } catch (error) {
      log.error('read session segments failed', { sessionId: request.sessionId }, error)
      return { success: false, segments: [] }
    }
  },
  async create(request, context: RpcDispatchContext = DESKTOP_RPC_CONTEXT) {
    const { name, sessionId, workspaceId, kind, room } = request
    // **传输面分叉(与 session-command 同一判例)**:建房要 in-process 的 collab
    // v3 actor 运行时。P4 终态批 B(拍板 #12)之前这里对 `http` 上任何 `kind` 一律
    // 拒;放开 `collabRooms` 能力位之后,拒的判据从「哪条传输」换成**协调器在不
    // 在场**:
    //
    //  - 桌面的内嵌 HTTP 面挂在自己那只 `collab: true` 的 backend 上,actor 就在
    //    这个进程里 —— 浏览器建的房与桌面自己建的是同一间,所以放行,走下面与
    //    `ipc` 完全同一条 `ensureCollabGroupRoom`。
    //  - 独立 `server:start` 不装配 collab —— 房建得出来也没有 actor 驱动,那是
    //    一间死房,所以照旧拒,文案与被删掉的 `POST /api/sessions` 路由逐字相同
    //    (它回 400 + 这只 body;通用信封没有 HTTP 状态码这一格,body 原样)。
    //
    // 同一个判据也是 `/api/capabilities` 里 `collabRooms` 的货源
    // (`server/runtime.ts` 的 `currentServerCapabilities`),所以「UI 让不让建」
    // 与「后端收不收」永远同进同退,不会出现界面开着而请求被拒的半开状态。
    // 排在最前,与旧路由的顺序一致:带 kind 的请求在碰 id 校验之前就被挡掉。
    if (context.transport === 'http' && kind !== undefined && !isCollabV3RuntimeRunning()) {
      return {
        success: false,
        error: `Session kind '${kind}' is not supported on the server host`,
      }
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
      // 建房的规则书只有一本,在装配层(wiring/collab/room-create.ts)—— 成员过滤、
      // 查无此人、退休拒收、PM 在册、budgets 归一、dm 字面 true,连文案都与
      // 「改房」那条路(setCollabRoomConfig)对齐。这里只递形状,不留规则。
      return ensureCollabGroupRoom(name || 'New Chat', room as CollabGroupRoomInput | undefined, {
        sessionId: sessionId ?? uuidv4(),
      })
    }
    return await createOnethingSessionForIpc({
      sessionId: sessionId ?? uuidv4(),
      name,
      createSession: (id, nextName) =>
        store.createSession(id, nextName, { workspaceId: resolvedWorkspaceId }),
      logger: consoleLog,
    })
  },
  async switch(request) {
    return switchOnethingSessionForIpc({
      sessionId: request.sessionId,
      getSession: id => store.getSession(id),
      setCurrentSessionId: setCurrentSession,
      logger: consoleLog,
    })
  },
  async get(request) {
    return getOnethingSessionForIpc({
      sessionId: request.sessionId,
      getSession: id => store.getSession(id),
      logger: consoleLog,
    })
  },
  async delete(request, context: RpcDispatchContext = DESKTOP_RPC_CONTEXT) {
    return deleteOnethingSessionForIpc({
      sessionId: request.sessionId,
      deleteSession: (id) => {
        const result = store.deleteSession(id)
        // The AI todo is keyed by session id, so it goes with the session
        // — including any children the delete cascaded to.
        for (const deletedId of result.deletedIds) {
          deleteSessionAiTodo(deletedId).catch(error => {
            log.error('delete session AI todo failed', { sessionId: deletedId }, error)
          })
        }
        // **传输面分叉**:联网宿主还要把这条会话在进程里的“活”收干净 ——
        // 中止活流、清权限询问、拆事件/流通道。名单用的是原文那份
        // (`deletedIds` 空时退回请求里那一个),不是上面 AI todo 的那份。
        if (context.transport === 'http') {
          const teardownIds = result.deletedIds.length ? result.deletedIds : [id]
          for (const deletedId of teardownIds) releaseServedSession(deletedId)
          // 原文在循环之后又清了一次请求里那条 —— 逐字保留(级联名单里没有它时才有意义)。
          Permission.clearSession(id)
        }
        return result
      },
      logger: consoleLog,
    })
  },
  async rename(request) {
    return renameOnethingSessionForIpc({
      sessionId: request.sessionId,
      newName: request.newName,
      renameSession: (id, nextName) => store.renameSession(id, nextName),
      logger: consoleLog,
    })
  },
  async updatePin(request) {
    return updateOnethingSessionPinForIpc({
      sessionId: request.sessionId,
      isPinned: request.isPinned,
      updateSessionPin: (id, nextPinned) => store.updateSessionPin(id, nextPinned),
      logger: consoleLog,
    })
  },
  async updateArchived(request) {
    return updateOnethingSessionArchivedForIpc({
      sessionId: request.sessionId,
      isArchived: request.isArchived,
      archivedAt: request.archivedAt ?? undefined,
      updateSessionArchived: (id, nextArchived, nextArchivedAt) =>
        store.updateSessionArchived(id, nextArchived, nextArchivedAt),
      logger: consoleLog,
    })
  },
  async updateWorkingDirectory(request, context: RpcDispatchContext = DESKTOP_RPC_CONTEXT) {
    // **传输面分叉**:`http` 把路径夹进本次请求的沙箱根(与 project-dirs 同一
    // 套判定 —— `rpc/sandbox.ts`,fail-closed),越界回被删掉的 server 路由那句
    // **逐字相同**的话;`ipc` 是用户自己的机器,照旧只 `fs.stat` 判是不是目录。
    // 清空(null / '')两边都直接放行:它不是一条路径。
    let workingDirectory = request.workingDirectory
    if (
      context.transport === 'http'
      && typeof workingDirectory === 'string'
      && workingDirectory !== ''
    ) {
      const inside = resolveInsideSandbox(resolveRpcSandbox(context), workingDirectory)
      if (!inside) return WORKDIR_SANDBOX_ERROR
      workingDirectory = inside
    }
    return updateOnethingSessionWorkingDirectory({
      sessionId: request.sessionId,
      workingDirectory,
      isDirectory: async path => (await fs.stat(path)).isDirectory(),
      writeWorkingDirectory: (id, nextWorkingDirectory) =>
        workdirGateway.write(id, nextWorkingDirectory),
    })
  },
  async updateModel(request) {
    return updateOnethingSessionModel({
      sessionId: request.sessionId,
      provider: request.provider,
      model: request.model,
      updateSessionModel: (id, nextProvider, nextModel) =>
        store.updateSessionModel(id, nextProvider, nextModel),
    })
  },
  async updateAgent(request) {
    return updateOnethingSessionAgent({
      sessionId: request.sessionId,
      agentId: request.agentId,
      defaultAgentId: DEFAULT_AGENT_ID,
      agentExists,
      getSessionKind: (id) => store.getSession(id)?.kind,
      updateSessionAgent: (id, nextAgentId) => store.updateSessionAgent(id, nextAgentId),
    })
  },
  async updatePermissionMode(request) {
    return updateOnethingSessionPermissionMode<PermissionMode>({
      sessionId: request.sessionId,
      permissionMode: request.permissionMode,
      allowedPermissionModes: ['normal', 'auto-accept-edits', 'dangerously-allow-all'],
      updateSessionPermissionMode: (id, nextPermissionMode) =>
        store.updateSessionPermissionMode(id, nextPermissionMode),
    })
  },
  async createBranch(request) {
    return createOnethingBranchSessionForIpc<ChatSession, ChatMessage, ChatSession>({
      parentSessionId: request.parentSessionId,
      branchFromMessageId: request.branchFromMessageId,
      adapters: {
        createId: uuidv4,
        getSession: id => store.getSession(id),
        createBranchSession: input => store.createBranchSession(
          input.branchId,
          input.branchName,
          input.parentSessionId,
          input.branchFromMessageId,
          input.inheritedMessages,
        ),
      },
      logger: consoleLog,
    })
  },
  async getCacheStats() {
    return store.getSessionCacheStats()
  },
  async evictCache(request) {
    store.invalidateSessionCache(request.sessionId)
    return { success: true }
  },
  async getTokenUsage(request) {
    return getOnethingSessionTokenUsageForIpc({
      sessionId: request.sessionId,
      getSessionTokenUsage: id => store.getSessionTokenUsage(id),
      logger: consoleLog,
    })
  },
  async addSystemMessage(request) {
    return addOnethingSystemMessageForIpc({
      sessionId: request.sessionId,
      message: request.message,
      addMessage: (id, nextMessage) => store.addMessage(id, nextMessage),
      logger: consoleLog,
    })
  },
  async removeFilesChangedMessage(request) {
    return removeOnethingSystemMarkerMessageForIpc({
      sessionId: request.sessionId,
      markerType: 'files-changed',
      getSession: id => store.getSession(id),
      deleteMessage: (id, messageId) => store.deleteMessage(id, messageId),
      logger: consoleLog,
    })
  },
  async removeGitStatusMessage(request) {
    return removeOnethingSystemMarkerMessageForIpc({
      sessionId: request.sessionId,
      markerType: 'git-status',
      getSession: id => store.getSession(id),
      deleteMessage: (id, messageId) => store.deleteMessage(id, messageId),
      logger: consoleLog,
    })
  },
  async removeMessage(request) {
    return removeOnethingMessageForIpc({
      sessionId: request.sessionId,
      messageId: request.messageId,
      deleteMessage: (id, nextMessageId) => store.deleteMessage(id, nextMessageId),
      logger: consoleLog,
    })
  },
}

export function registerSessionsRpcDomain(): () => void {
  return registerRouterHandlers(sessionsRouter, sessionsRpcHandlers)
}
