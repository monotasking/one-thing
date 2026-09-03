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
 * ## 三道门(B2 之前它们都挂在 `context.transport === 'http'` 上)
 *
 * 会话不是一个纯粹的读写域:被删掉的 server 实现上有三道桌面没有的门,它们
 * **不是**实现细节而是行为契约。B2(`docs/design/backend-transport-forks-2026-09.md`
 * §2.2)把每一道各自问回它真正在问的那件事,`transport` 一处不读:
 *
 *  1. **`updateWorkingDirectory`**:**不可信**宿主把路径夹进本次请求的
 *     `sandboxRoot`(`rpc/sandbox.ts` 的同一套判定,project-dirs 已经在用),
 *     越界回旧的 `Working directory must stay inside the workspace sandbox root.`;
 *     本机可信(桌面 / 内嵌面 / 回环 server)只 `fs.stat`。判据
 *     `isHostLocallyTrusted()` 08-31 就在了,B2 只去掉了它前面那个 `http &&`。
 *  2. **`delete`**:两条传输都做那三件收尾(中止活流、清权限询问、拆事件/流
 *     通道)。它们各自带守卫,没有进程内活计时整段是 no-op —— 从来不是「联网
 *     宿主专属」,只是当初没给桌面接(桌面因此多一个修正:删一条还在生成的会话
 *     会中止那条流)。
 *  3. **`create`**:带 `kind` 的请求看**协调器在不在场**(P4 终态批 B,拍板 #12)。
 *     在场(桌面 / 壳的 backend 带 `collab: true`)走 `ensureCollabGroupRoom`;
 *     不在场(独立 `server:start` 不装配 collab)拒,文案逐字沿用旧 REST。判据与
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
import { SESSION_EVENT_TYPES, emitCoreSessionEventSafely } from '@onething/core/events'
import type { ChatMessage, ChatSession, GetSessionMessagesPageRequest, PermissionMode } from '@shared/ipc.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { SessionsRoutes } from '@shared/ipc/sessions.js'
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
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { UpdateOnethingSessionWorkingDirectoryOptions } from '@onething/runtime/sessions/working-directory'
import type { UpdateOnethingSessionAgentOptions } from '@onething/runtime/sessions/session-updates'
import type { CreateOnethingBranchSessionAdapters } from '@onething/runtime/sessions/branching'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingSessionsIpcLogger } from '@onething/runtime/sessions/ipc-operations'

const log = getLogger('rpc.sessions')
/** 投影层收的是鸭子 logger;与迁移前 `@main` 适配里那个 `console` 同一个位置。 */
const consoleLog: ConsoleLikePort & OnethingSessionsIpcLogger = consolePort(log)

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
 * B2(方案 §2.2「面」)起**两条传输都走这里**:这四步各自带守卫(没有活流就不
 * 碰引擎,没有 pending 就不清,通道不在就不拆),一条没有任何进程内活计的会话上
 * 整段是 no-op —— 所以它从来就不是「联网宿主专属」,只是当初没给桌面接。桌面因此
 * 多出一个**修正**:删掉一条还在生成的会话时,那条流会被中止(从前它会继续跑到
 * 底,往一个已经不存在的会话上写)。
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
      // S2b:主读路径收口到读门面,事件投影因此能到 UI(`listMessages` 自己在
      // `fromEvents()` 上取投影;批 6b 之后那是唯一路)。唯一要补的形状差:读门面把
      // “查无此会话”折成 `[]`,而本域的契约是回 NOT_FOUND —— 空结果时用仓库那句
      // `undefined` 信号把它还原,与 S2b 前逐字相同。
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
  async create(request) {
    const { name, sessionId, workspaceId, kind, room } = request
    // **建房要 in-process 的 collab v3 actor 运行时**。P4 终态批 B(拍板 #12)
    // 之前这里对 `http` 上任何 `kind` 一律拒;放开 `collabRooms` 能力位之后,拒的
    // 判据从「哪条传输」换成**协调器在不在场**:
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
    //
    // B2(方案 §2.2「面」)去掉了 `transport === 'http' &&`:actor 在不在场是
    // **进程事实**,与调用方走哪条总线无关。Vue 桌面从前不查这一条是遗留 ——
    // 它的 backend 带 `collab: true`,判据在那里恒真,所以这一步逐字不变;真正
    // 变的是「装配里没有 collab 的进程从 ipc 也建不出死房」。
    if (kind !== undefined && !isCollabV3RuntimeRunning()) {
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
  async delete(request) {
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
        // 把这条会话在**这个进程里**的“活”收干净 —— 中止活流、清权限询问、
        // 拆事件/流通道。名单用的是原文那份(`deletedIds` 空时退回请求里那一个),
        // 不是上面 AI todo 的那份。B2 起无条件跑(见 `releaseServedSession` 的注释)。
        const teardownIds = result.deletedIds.length ? result.deletedIds : [id]
        for (const deletedId of teardownIds) releaseServedSession(deletedId)
        // 原文在循环之后又清了一次请求里那条 —— 逐字保留(级联名单里没有它时才有意义)。
        Permission.clearSession(id)
        return result
      },
      logger: consoleLog,
    })
  },
  async rename(request) {
    const result = await renameOnethingSessionForIpc({
      sessionId: request.sessionId,
      newName: request.newName,
      renameSession: (id, nextName) => store.renameSession(id, nextName),
      logger: consoleLog,
    })
    // **显式改名也要有推送**。从前这条路改完盘就结束了:别的客户端(浏览器那一份、
    // 另一扇窗)对着旧名字,只能等下一次整表重拉才看得见 —— 而列表这一层根本没有
    // 定时重拉。
    //
    // 载荷与**自动起题**那一发逐字同形(`packages/core/engine/core-stream-engine.ts`
    // 的 `generateAndApplySessionTitle`:`eventBus.emit(sessionId, { type:
    // SESSION_RENAMED, name })`)。两处产地形状相同不是巧合也不是抄写:说的是同一
    // 件事(这条会话现在叫什么),走的也是**同一条总线** —— 引擎手里那只 `eventBus`
    // 就是 `wiring/engine/index.ts` 注进去的 `getEventBus()`,而扇出是通用的
    // (IPCBridge 的 `onAnySessionAny` → `session:event`,SSE 同名),一发同时到桌面
    // 与浏览器。引擎那一发在 core 的私有方法里,RPC 域拿不到那个句柄,所以这里用
    // 装配层现成的出口 `getEventBus()` 发同一形状的第二个产地,而**不是**第二份载荷
    // 语义:`{ type, name }` 两格,消费方(`apps/desktop-react` 的 sessions-source
    // 判据 b、renderer 的 chat store)只认这两格。
    //
    // `name` 原样带出请求里那个字符串:仓的改名没有归一化(core 的 `applySessionName`
    // 就是一句赋值),所以事件里的名字与盘上的名字是同一个字符串。
    //
    // **失败不发**:`success: false` = 仓抛了 = 盘上没变,这时候推一条改名出去就是
    // 让别的客户端显示一个不存在的名字。
    if (result.success) {
      await emitCoreSessionEventSafely({
        sessionId: request.sessionId,
        event: { type: SESSION_EVENT_TYPES.SESSION_RENAMED, name: request.newName },
        eventBus: getEventBus(),
        logger: consoleLog,
        errorLabel: '[SessionsRPC] EventBus emit failed:',
      })
    }
    return result
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
    //
    // 08-31 追补:**本机可信宿主的 HTTP 面与 IPC 同权**(files 域方案 1 的第二个
    // 消费者,`server/host-trust.ts` 的 `isHostLocallyTrusted`)。React 壳走 http
    // 面,从项目建会话的第二步(落目录)曾被这道夹持逐次拒掉 —— 真机账单:会话
    // 71886081 落成空目录,claude-code-agent 因此拒启。声明过可信(桌面/壳内嵌面、
    // 回环 server)走 `ipc` 那一列;独立部署与 `ONETHING_SERVER_FILES_SANDBOX=1`
    // 强制收紧时,夹持逐字原样。
    //
    // B2 去掉了 `transport === 'http' &&`:可信是面级事实,不是传输属性。没声明
    // 可信的进程里,`ipc` 的路径也会过一遍 `resolveInsideSandbox` 的**未夹紧**
    // 分支(那一支只做 `resolve()` + `~` 展开,不拒任何路径),所以桌面语义没变。
    let workingDirectory = request.workingDirectory
    if (
      !isHostLocallyTrusted()
      && typeof workingDirectory === 'string'
      && workingDirectory !== ''
    ) {
      const inside = resolveInsideSandbox(resolveRpcSandbox(context), workingDirectory)
      if (!inside) return WORKDIR_SANDBOX_ERROR
      workingDirectory = inside
    }
    const updateOnethingSessionWorkingDirectoryOptions: UpdateOnethingSessionWorkingDirectoryOptions = {
      sessionId: request.sessionId,
      workingDirectory,
      isDirectory: async path => (await fs.stat(path)).isDirectory(),
      writeWorkingDirectory: (id, nextWorkingDirectory) =>
        workdirGateway.write(id, nextWorkingDirectory),
    };
    return updateOnethingSessionWorkingDirectory(updateOnethingSessionWorkingDirectoryOptions)
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
    const updateOnethingSessionAgentOptions: UpdateOnethingSessionAgentOptions = {
      sessionId: request.sessionId,
      agentId: request.agentId,
      defaultAgentId: DEFAULT_AGENT_ID,
      agentExists,
      getSessionKind: (id) => store.getSession(id)?.kind,
      updateSessionAgent: (id, nextAgentId) => store.updateSessionAgent(id, nextAgentId),
    };
    return updateOnethingSessionAgent(updateOnethingSessionAgentOptions)
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
    const adaptersPort: CreateOnethingBranchSessionAdapters<ChatSession, ChatMessage, ChatSession> = {
      createId: uuidv4,
      getSession: id => store.getSession(id),
      createBranchSession: input => store.createBranchSession(
        input.branchId,
        input.branchName,
        input.parentSessionId,
        input.branchFromMessageId,
        input.inheritedMessages,
      ),
    };
    return createOnethingBranchSessionForIpc<ChatSession, ChatMessage, ChatSession>({
      parentSessionId: request.parentSessionId,
      branchFromMessageId: request.branchFromMessageId,
      adapters: adaptersPort,
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

