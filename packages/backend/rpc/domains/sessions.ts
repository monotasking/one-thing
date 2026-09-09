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
import { v4 as uuidv4 } from 'uuid'
import {
  activateOnethingSessionForIpc,
  addOnethingSystemMessageForIpc,
  createOnethingBranchSessionForIpc,
  createOnethingSessionForIpc,
  deleteOnethingSessionForIpc,
  describeInvalidOnethingCreateSessionRequestForIpc,
  ONETHING_SESSION_NOT_FOUND,
  removeOnethingSystemMarkerMessageForIpc,
  switchOnethingSessionForIpc,
  updateOnethingSessionPermissionMode,
} from '@onething/runtime/sessions'
import { isValidSpaceId } from '@onething/runtime/spaces/types'
import { collectSessionCascadeDeleteIds } from '@onething/core/session'
import { SESSION_RESOURCE_SCHEME } from '@onething/runtime/sessions/resource-spec'
import type {
  ChatMessage,
  ChatSession,
  GetSessionMessagesPageResponse,
  PermissionMode,
  UserMessageMarker,
} from '@shared/ipc.js'
import type { SessionSegment } from '@shared/ipc/toc.js'
import type { SessionTokenUsageReadout } from '@shared/ipc/sessions.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { SessionMutationResponse, SessionsRoutes } from '@shared/ipc/sessions.js'
import * as store from '../../store.js'
import { listSessions } from '../../session/index.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionDeletion } from '../../session/deletion.js'
import { requestSessionOwner, sessionAccess, SessionAccessError, type SessionOwnershipRecord } from '../../session/access.js'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import {
  ensureCollabGroupRoom,
  isCollabV3RuntimeRunning,
  type CollabGroupRoomInput,
} from '../../wiring/collab/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { Permission } from '../../wiring/permission/index.js'
import { deleteSessionAiTodo, notifyTodoPlanActiveSessionChanged } from '../../wiring/todo-plan/store.js'
import { resolveInsideSandbox, resolveRpcSandbox } from '../sandbox.js'
import { foldOutcomeToEnvelope, foldReadOutcomeToEnvelope } from '../resource-envelope.js'
import { principalOf } from '../principal.js'
import { BackendNotAssembledError, getCurrentBackendInstance } from '../../current.js'
import { SessionNotFoundError } from '../../wiring/resource/session-provider.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { CreateOnethingBranchSessionAdapters } from '@onething/runtime/sessions/branching'
import type { ReadOutcome } from '@onething/core/resource'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingSessionsIpcLogger } from '@onething/runtime/sessions/ipc-operations'

const log = getLogger('rpc.sessions')
/** 投影层收的是鸭子 logger;与迁移前 `@main` 适配里那个 `console` 同一个位置。 */
const consoleLog: ConsoleLikePort & OnethingSessionsIpcLogger = consolePort(log)

function publicCreatedSession(session: ChatSession): ChatSession {
  const { ownerUserId: _user, ownerWorkspaceId: _workspace, userId: _legacy, storageGeneration: _generation, ...publicSession } = session as ChatSession & SessionOwnershipRecord & { storageGeneration?: string }
  return publicSession
}

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
  // Cancellation and its settled result precede physical deletion in SessionDeletion.
  Permission.clearSession(sessionId)
  getEventBus().destroySession(sessionId)
  getStreamChannel().destroySession(sessionId)
}

/**
 * ## 七条写面已经退成资源投影(原子 K2c-1)
 *
 * `rename` / `updateWorkingDirectory` / `updatePin` / `updateArchived` /
 * `updateModel` / `updateAgent` / `removeMessage` 这七条处理器里**不再有实现**:
 * 它们拼参数、交给 `backend.resources.do`、把 `Outcome` 折回原来那个信封
 * (`rpc/resource-envelope.ts`)。规则书、端口、事件全都搬进了
 * `wiring/resource/session-provider.ts` —— 与 AI 走的是同一台 `ToolRunner`,
 * 于是授权、审计、取消、预算四样第一次真的同源(`docs/design/atom-2026-09.md`
 * §2 不变量 2:「没有第二条路,界面点按钮也走它」)。
 *
 * **对外契约一个字没变**:入参、回执、发不发事件、失败文案逐字照旧 ——
 * `__tests__/sessions-domain.test.ts` 那 25 例是这句话的门,
 * `__tests__/sessions-projection.test.ts` 证的是「域这一路与直调资源面产出同一个
 * 结果、同一条 `tool/audit`」(也就是它真的退成了投影,不是双写)。
 *
 * **没退的那些**,理由各自写在自述里(`runtime/sessions/resource-spec.ts` 文件头):
 * 五条读面被管线的输出预算、`Outcome` 只装得下文本、以及「每读一次落一条审计」
 * 三件事挡住(留账 K2c-2);`addSystemMessage` 一退就会多出一张权限卡;
 * `list` / `create` / `delete` / `activate` / `switch` / `createBranch` /
 * `updatePermissionMode` / 缓存那两条 / 两条标记消息归 K2c-2。
 */

/** 这个进程当前那台资源内核。与 `rpc/domains/resources.ts` 同一条读法、同一句「还没装配」。 */
function resources() {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new BackendNotAssembledError()
  return backend.resources
}

/**
 * 一次调用的坐标。
 *
 * **不带 `sessionId`**:那一格是「从哪条会话里发起的」,不是操作对象。界面上改一条
 * 会话的名字与那条会话正在跑的回合无关,拿它顶上去,审计就读成「A 自己改了自己」
 * (K1 留账,K2a 的答案是保留坐标 + `<store>/audit/resource.jsonl`)。
 */
function callOptions(context: RpcDispatchContext) {
  return {
    principal: principalOf(context),
    ...(context.signal ? { signal: context.signal } : {}),
  }
}

/**
 * 「这次失败在本域的契约里叫什么」。**只有一条**:二十六条方法共用的那句
 * `Session not found`(`ONETHING_SESSION_NOT_FOUND`)。其余原样交出管线那句话 ——
 * 域不发明文案。判据是类不是消息串。
 */
function describeSessionError(error: Error): string | undefined {
  return error instanceof SessionNotFoundError ? ONETHING_SESSION_NOT_FOUND : undefined
}

/**
 * 拼参数 → **读那条路** → 折回信封。六条读面共用的那三句话(K2c-2)。
 *
 * `backend.resources.read` 不经 `ToolRunner`:读不落审计、不吃输出预算、`ok` 带的是
 * **值**而不是一段文本(理由在 `core/resource/read-outcome.ts` 的文件头)。所以这一
 * 条与下面 `doSessionOp` 那一条形状相同、路径不同 —— 那正是本单的整句话。
 *
 * 日志:原文那批投影函数(`*ForIpc`)对**意料之外**的失败会记一行再把消息交出去;
 * 「查无此会话」不在其中 —— 它是一条正常分支,从来不进日志,这里逐字照旧。
 */
async function readSession(
  context: RpcDispatchContext,
  sessionId: string,
  name: string,
  query: Record<string, unknown> = {},
): Promise<ReadOutcome> {
  const outcome = await resources().read(
    `${SESSION_RESOURCE_SCHEME}:${sessionId}`,
    name,
    query,
    callOptions(context),
  )
  if (outcome.kind === 'failed' && !(outcome.error instanceof SessionNotFoundError)) {
    log.error('read session resource failed', { sessionId, read: name }, outcome.error)
  }
  return outcome
}

/** 拼参数 → 管线 → 折回信封。七条写面共用的那三句话。 */
async function doSessionOp(
  context: RpcDispatchContext,
  sessionId: string,
  op: string,
  params: Record<string, unknown>,
): Promise<SessionMutationResponse> {
  const outcome = await resources().do(
    `${SESSION_RESOURCE_SCHEME}:${sessionId}`,
    op,
    params,
    callOptions(context),
  )
  return foldOutcomeToEnvelope(outcome, { describeError: describeSessionError })
}

export const sessionsRpcHandlers: RpcRouteHandlers<SessionsRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    return listSessions(request, context)
  },
  async listMeta(request, context = DESKTOP_RPC_CONTEXT) {
    return sessionsRpcHandlers.list(request, context)
  },
  async activate(request) {
    return activateOnethingSessionForIpc({
      sessionId: request.sessionId,
      getSessionDetails: id => store.getSessionDetails(id),
      setCurrentSessionId: setCurrentSession,
      logger: consoleLog,
    })
  },
  async getMessages(request, context = DESKTOP_RPC_CONTEXT) {
    // 整份抄本 = `messages` **不带分页那四格**(自述 `messages` 那一格的判据)。
    // 「查无此会话折成 NOT_FOUND、投影折不出消息但会话在册折成空数组」那条 S2b 的
    // 形状差没有消失,它搬进了 provider —— 判据与端口逐字未变。
    return foldReadOutcomeToEnvelope(await readSession(context, request.sessionId, 'messages'), {
      project: value => ({ messages: (value as { messages?: ChatMessage[] }).messages }),
      describeError: describeSessionError,
    })
  },
  async getMessagesPage(request, context = DESKTOP_RPC_CONTEXT) {
    const start = performance.now()
    const response = foldReadOutcomeToEnvelope(
      await readSession(context, request.sessionId, 'messages', {
        // **总是带一个 anchor**:它是「给我一页」与「给我整份」的判别(同一条读法,
        // 判据是说没说分页的话)。`'tail'` 与 anchor 缺席在 pager 里走的是同一支
        // (`core/session/storage/jsonl/pager.ts`),所以这一行不改任何行为。
        anchor: request.anchor ?? 'tail',
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.direction !== undefined ? { direction: request.direction } : {}),
      }),
      {
        // 页信封原样上抬:`messages` / 两只游标 / `hasMoreBefore` / `hasMoreAfter` /
        // `totalCount` 都是 pager 给的,域一格都不重算。
        project: value => value as Omit<GetSessionMessagesPageResponse, 'success'>,
        describeError: describeSessionError,
      },
    )
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
  async getUserMarkers(request, context = DESKTOP_RPC_CONTEXT) {
    return foldReadOutcomeToEnvelope(await readSession(context, request.sessionId, 'markers'), {
      project: value => ({ markers: value as UserMessageMarker[] }),
      describeError: describeSessionError,
    })
  },
  async getSegments(request, context = DESKTOP_RPC_CONTEXT) {
    const outcome = await readSession(context, request.sessionId, 'segments')
    if (outcome.kind === 'ok') return { success: true, segments: outcome.value as SessionSegment[] }
    // 这一条的契约里**没有 error 那一格**(`GetSessionSegmentsResponse` 只有
    // `success` + `segments`),所以失败折成一份空目录 —— 与原文逐字相同,那句话
    // `readSession` 已经记进日志了。
    return { success: false, segments: [] }
  },
  async create(request, context = DESKTOP_RPC_CONTEXT) {
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
    if (sessionId) sessionAccess.resolveOptional(context, sessionId, 'write')
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
      const result = await ensureCollabGroupRoom(name || 'New Chat', room as CollabGroupRoomInput | undefined, {
        sessionId: sessionId ?? uuidv4(),
        initialOwner: requestSessionOwner(context),
      })
      if (result.session) result.session = publicCreatedSession(result.session)
      return result
    }
    const result = await createOnethingSessionForIpc({
      sessionId: sessionId ?? uuidv4(),
      name,
      createSession: (id, nextName) => publicCreatedSession(
        store.createSession(id, nextName, { workspaceId: resolvedWorkspaceId, initialOwner: requestSessionOwner(context) })),
      logger: consoleLog,
    })
    return result
  },
  async switch(request) {
    return switchOnethingSessionForIpc({
      sessionId: request.sessionId,
      getSession: id => store.getSession(id),
      setCurrentSessionId: setCurrentSession,
      logger: consoleLog,
    })
  },
  async get(request, context = DESKTOP_RPC_CONTEXT) {
    // K3-a':读的是 `record`,不是 `get`。这一条的契约要的是 `ChatSession` 本人
    // (带抄本),而 `get` 自 K3-a' 起是不带抄本的摘要 —— 两条读法是两件事,理由
    // 写在 `runtime/sessions/resource-spec.ts` 的 `get` 那一格上。信封一个字不变。
    return foldReadOutcomeToEnvelope(await readSession(context, request.sessionId, 'record'), {
      project: value => ({ session: value as ChatSession }),
      describeError: describeSessionError,
    })
  },
  async delete(request, context = DESKTOP_RPC_CONTEXT) {
    const authorizedIds = sessionAccess.resolveAll(context,
      collectSessionCascadeDeleteIds(store.getSessionsList(), request.sessionId), 'delete')
    return deleteOnethingSessionForIpc({
      sessionId: request.sessionId,
      deleteSession: async (id) => {
        const result = await sessionDeletion.delete(id, authorizedIds,
          ids => { sessionAccess.resolveAll(context, ids, 'delete') })
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
  async rename(request, context = DESKTOP_RPC_CONTEXT) {
    // 那一发 `session:renamed` 现在由 provider 在 apply 里发(成功才发)—— 搬上去
    // 的理由是 AI 经资源面改名与界面改名是同一件事,而从前只有界面那一路推。
    return doSessionOp(context, request.sessionId, 'rename', { title: request.newName })
  },
  async updatePin(request, context = DESKTOP_RPC_CONTEXT) {
    return doSessionOp(context, request.sessionId, 'setPinned', { pinned: request.isPinned })
  },
  async updateArchived(request, context = DESKTOP_RPC_CONTEXT) {
    // 契约里 `archivedAt` 是 `number | null`,而自述那一格只收 `number`:
    // 「清掉这个时刻」与「没说」在仓那一层是同一件事,`null` 在这里折成缺席
    // (与从前 `request.archivedAt ?? undefined` 逐字同义)。
    const archivedAt = request.archivedAt ?? undefined
    return doSessionOp(context, request.sessionId, 'setArchived', {
      archived: request.isArchived,
      ...(archivedAt !== undefined ? { archivedAt } : {}),
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
    // 目录存不存在、是不是目录、清空怎么算,全在 provider 那一路的规则书里
    // (`updateOnethingSessionWorkingDirectory`)—— AI 走资源面时判据一模一样。
    // 清空(null / '')在自述里就是空串:它是一条合法的值,不是缺席。
    return doSessionOp(context, request.sessionId, 'setWorkingDirectory', {
      path: workingDirectory ?? '',
    })
  },
  async updateModel(request, context = DESKTOP_RPC_CONTEXT) {
    return doSessionOp(context, request.sessionId, 'setModel', {
      provider: request.provider,
      model: request.model,
    })
  },
  async updateAgent(request, context = DESKTOP_RPC_CONTEXT) {
    // 三条守卫(room 会话不许直接绑、未知 agent、缺席即默认)一条也没搬到这里:
    // 它们在 `updateOnethingSessionAgent` 那本规则书上,由 provider 递形状。
    return doSessionOp(context, request.sessionId, 'setAgent', {
      ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
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
  async createBranch(request, context = DESKTOP_RPC_CONTEXT) {
    const adaptersPort: CreateOnethingBranchSessionAdapters<ChatSession, ChatMessage, ChatSession> = {
      createId: uuidv4,
      getSession: id => store.getSession(id),
      createBranchSession: input => publicCreatedSession(store.createBranchSession(
        input.branchId,
        input.branchName,
        input.parentSessionId,
        input.branchFromMessageId,
        input.inheritedMessages,
        { initialOwner: requestSessionOwner(context) },
      )),
    };
    return createOnethingBranchSessionForIpc<ChatSession, ChatMessage, ChatSession>({
      parentSessionId: request.parentSessionId,
      branchFromMessageId: request.branchFromMessageId,
      adapters: adaptersPort,
      logger: consoleLog,
    })
  },
  async getCacheStats(_request, context = DESKTOP_RPC_CONTEXT) {
    const stats = store.getSessionCacheStats()
    const cachedSessionIds = stats.cachedSessionIds.filter(id => {
      try { sessionAccess.resolve(context, id, 'read'); return true }
      catch (error) { if (error instanceof SessionAccessError) return false; throw error }
    })
    return { ...stats, size: cachedSessionIds.length, cachedSessionIds }
  },
  async evictCache(request) {
    store.invalidateSessionCache(request.sessionId)
    return { success: true }
  },
  async getTokenUsage(request, context = DESKTOP_RPC_CONTEXT) {
    return foldReadOutcomeToEnvelope(await readSession(context, request.sessionId, 'tokenUsage'), {
      project: value => ({ usage: value as SessionTokenUsageReadout }),
      describeError: describeSessionError,
    })
  },
  async addSystemMessage(request) {
    return addOnethingSystemMessageForIpc({
      sessionId: request.sessionId,
      message: request.message,
      addMessage: (id, message) => sessionCommands.appendMessage(id, { message, stampCollab: true }),
      logger: consoleLog,
    })
  },
  async removeFilesChangedMessage(request) {
    return removeOnethingSystemMarkerMessageForIpc({
      sessionId: request.sessionId,
      markerType: 'files-changed',
      getSession: id => store.getSession(id),
      deleteMessage: (id, messageId) => sessionCommands.deleteMessage(id, { messageId }),
      logger: consoleLog,
    })
  },
  async removeGitStatusMessage(request) {
    return removeOnethingSystemMarkerMessageForIpc({
      sessionId: request.sessionId,
      markerType: 'git-status',
      getSession: id => store.getSession(id),
      deleteMessage: (id, messageId) => sessionCommands.deleteMessage(id, { messageId }),
      logger: consoleLog,
    })
  },
  async removeMessage(request, context = DESKTOP_RPC_CONTEXT) {
    return doSessionOp(context, request.sessionId, 'removeMessage', { messageId: request.messageId })
  },
}
