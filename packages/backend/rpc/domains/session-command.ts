/**
 * session-command(会话命令总线的入口)域 —— 结构债 P4c 第四批。
 *
 * 这是全仓最后一条主干「Proxy 属性 + 手写通道」。搬家之前一条命令要过:
 * `platformApi.emitCommand`(`ElectronAPI` 上的一个接口声明,F12 到此为止)
 * → 桌面 `ipcRenderer.invoke('session:command')` / web `POST /api/sessions/:id/commands`
 * → `@main/ipc/handlers.ts` 的 `ipcMain.handle` 或 server 的 `runtime.commands.emit`
 * —— 两条实现、两处清洗、零跳转。搬完之后只剩一条:
 *
 *   `sessionCommands.emit`(renderer/platform/session-command-client.ts)
 *     → `sessionCommandRouter`(@shared/ipc/session-command.ts)
 *     → **本文件的 `emit`**
 *     → `emitCoreSessionCommandForIpc`(core/events/ipc-operations.ts)
 *     → `CoreStreamEngine.buildCommandHandlers()` 的常量键派发表
 *     → `handleSendMessage` / …
 *
 * 替换掉的四处镜像:
 *  - `apps/electron/src/ipc/session-command.ts` 的手写 IPC 工厂(29 行)与
 *    `@main/ipc/handlers.ts` 里 `registerCommandHandler` 那段壳适配;
 *  - `preload/bridge.ts` 的 `emitCommand` 包装(mention 拍平随之挪到调用点,
 *    与 collab 迁移时「结构化克隆防线从桥挪到调用点」同一判例);
 *  - `platform/web.ts` 的 `POST /api/sessions/:id/commands` 镜像;
 *  - `server/http.ts` 那条 REST 路由与 `server/runtime.ts` 的 `commands` adapter。
 *
 * ## 两条传输面上刻意保留的差别
 *
 * 命令总线不是一个普通的读写域:同一条命令从桌面渲染层来、从浏览器来、从
 * `curl` 来,语义并不相同。所以这里**按 `context.transport` 分叉**,而不是
 * 把两边强行抹平:
 *
 *  1. **`ipc`(桌面渲染层)** 走 `sanitizeRendererCommand`:给 send/edit/steering/
 *     followup 盖 `origin`(桌面 or 语音),并在 retry / edit-and-resend 上补写
 *     一次评估事故包。这两件都是**「发起者是本机那个人」**才成立的判断。
 *  2. **`http`** 保留 server 壳原来的两条本地语义:`command:abort` 就地中止
 *     并清掉该会话的权限询问(不进总线);`command:permission-respond` 在**没有
 *     显式 channel** 时认领待批那条的 `targetChannel`(通道亲和 —— HTTP 边界
 *     已经认过身份了,core 的亲和检查防的是总线上的跨通道冒批,不是所有者
 *     自己从浏览器批)。`scripts/shadow-battery.mjs` 的两个权限场景就是靠这条
 *     认领跑绿的,它是**行为契约**,不是实现细节。
 *
 * 认领的来源从 server 自己那本 `pendingPermissions` 镜像换成了 core 的
 * `Permission.getPendingPrompts` —— 同一件事的**真事实**(CLAUDE.md 早就写着
 * 它是两侧待批询问的唯一真相),顺带让这条语义在桌面内嵌的 HTTP 面上也成立。
 *
 * ## 迁后 web 行为的两处变化(与 permission / skills / media 三批同一判例:
 * 桌面的形状赢)
 *  1. 被删掉的 adapter 有一道桌面没有的「会话不存在 → `{success:false,
 *     error:'Session not found'}`」前置检查。现在一条打不中的 sessionId 会像
 *     桌面一样进总线,由订阅者自己决定要不要理。
 *  2. `command:abort` 以外的命令过去在 server 上**完全不清洗**;现在也不清洗
 *     (`sanitize` 只在 `ipc` 上跑),所以这一条是「保持不变」,写在这里是因为
 *     它看起来像个疏漏 —— 不是:给一条来自网络的命令盖上「桌面来源」的 origin
 *     才是说谎。
 */
import { emitCoreSessionCommandForIpc } from '@onething/core/events'
import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import type { SessionCommand } from '@shared/events/index.js'
import type { SessionCommandEmitResult, SessionCommandRoutes } from '@shared/ipc/session-command.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { sanitizeRendererOrigin } from '../../channel/index.js'
import { getEventBus } from '../../events/index.js'
import { getStreamEngine } from '../../wiring/engine/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { Permission } from '../../wiring/permission/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import { requestSessionOwner, sessionAccess, SessionAccessError } from '../../session/access.js'

const log = getLogger('rpc.session-command')
/** 旧线传的是裸 `console`;结构化 logger 的鸭子端口替身(area ① 统一后删)。 */
const consoleLog = consolePort(log)

/**
 * 渲染层来的命令的清洗 —— 从 `@main/ipc/handlers.ts` 逐字搬过来。
 *
 * 两件事,顺序无关:
 *  - **retry / edit-and-resend 的迟到负信号**:先落盘后补写。`turnId` 必须是
 *    `turn-evaluation.ts` 记的那个 assistant 消息 id,不是 sessionId —— 用后者
 *    会把一个会话里每一轮都塌到同一条记录上。fire-and-forget:补写失败不许
 *    影响命令本身。
 *  - **origin 盖章**:send / edit / steering / followup 四条带正文的命令,身份
 *    由装配层决定,不认渲染层自己写的 `origin`。
 */
export function sanitizeRendererCommand(command: unknown): unknown {
  if (!command || typeof command !== 'object') return command
  const record = command as Record<string, unknown>
  if (typeof record.type !== 'string') return command
  if (!record.type.startsWith('command:')) return command

  if (record.type === SESSION_COMMAND_TYPES.RETRY_MESSAGE) {
    const sessionId = record.sessionId as string | undefined
    // messageId here is the assistant message being retried, which is
    // exactly the turnId recorded for that turn.
    const turnId = record.messageId as string | undefined
    if (sessionId && turnId) {
      // A retry is a late negative signal: materialize the incident
      // bundle now (scene from LRU + trace from persisted messages).
      amendTurnSignal({ sessionId, turnId, kind: 'retry' })
    }
  }
  if (record.type === SESSION_COMMAND_TYPES.EDIT_AND_RESEND) {
    const sessionId = record.sessionId as string | undefined
    // messageId here is the user message being edited, not the assistant
    // turnId — best-effort amend key until callers can pass the
    // responding assistant message id. The prompt-capture LRU is keyed by
    // assistant message id, so this path usually creates no incident.
    const turnId = record.messageId as string | undefined
    if (sessionId && turnId) {
      amendTurnSignal({ sessionId, turnId, kind: 'edit-resend' })
    }
  }

  if (
    record.type === SESSION_COMMAND_TYPES.SEND_MESSAGE
    || record.type === SESSION_COMMAND_TYPES.EDIT_AND_RESEND
    || record.type === SESSION_COMMAND_TYPES.INJECT_STEERING
    || record.type === SESSION_COMMAND_TYPES.INJECT_FOLLOWUP
  ) {
    return {
      ...record,
      origin: sanitizeRendererOrigin(record),
    }
  }

  return command
}

/**
 * 两条迟到负信号共用的补写。动态 import 保持原样:评估那一摊(runtime 的
 * incident builder + 装配层的现场保真)只在真的有人重试时才需要被拽起来。
 */
function amendTurnSignal(input: {
  sessionId: string
  turnId: string
  kind: 'retry' | 'edit-resend'
}): void {
  Promise.all([
    import('@onething/runtime'),
    import('../../wiring/evals/incident.js'),
  ])
    .then(async ([runtime, { createIncidentForTurn }]) => {
      const incident = await createIncidentForTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        origin: 'auto',
        signals: input.kind === 'retry' ? { retried: true } : { editResent: true },
      })
      const amend = input.kind === 'retry'
        ? runtime.amendTurnRetry
        : runtime.amendTurnEditResend
      amend({
        turnId: input.turnId,
        sessionId: input.sessionId,
        incidentRef: incident?.incidentId ?? null,
      })
    })
    .catch(() => {})
}

/**
 * HTTP 上没带 channel 的权限应答:认领待批那条的 `targetChannel`。
 * 事实源是 core 的 `Permission.getPendingPrompts`(桌面 / server 同一份),
 * 匹配顺序与被删掉的 server adapter 逐字一致:先 requestId,再 toolCallId。
 */
function adoptPendingPermissionChannel(
  sessionId: string,
  command: Record<string, unknown>,
): string {
  const explicit = command.channel
  if (typeof explicit === 'string' && explicit) return explicit
  const requestId = typeof command.requestId === 'string' ? command.requestId : undefined
  const toolCallId = typeof command.toolCallId === 'string' ? command.toolCallId : undefined
  const prompts = Permission.getPendingPrompts(sessionId)
  const pending = (requestId ? prompts.find(prompt => prompt.id === requestId) : undefined)
    ?? (toolCallId ? prompts.find(prompt => prompt.callId === toolCallId) : undefined)
  return pending?.targetChannel ?? 'api'
}

function emitToBus(sessionId: string, command: unknown, context: RpcDispatchContext): Promise<SessionCommandEmitResult> {
  return emitCoreSessionCommandForIpc({
    sessionId,
    // 命令面的形状是 `SessionCommand`(11 条 `SESSION_COMMAND_TYPES` 之一),
    // 不是总线的事件 ∪ 命令并集 —— `emitCoreSessionCommandForIpc` 也这么要求。
    command: command as SessionCommand,
    eventBus: getEventBus(),
    logger: consoleLog,
    executionContext: requestSessionOwner(context),
  })
}

export const sessionCommandRpcHandlers: RpcRouteHandlers<SessionCommandRoutes> = {
  async emit(request, context: RpcDispatchContext = DESKTOP_RPC_CONTEXT) {
    const sessionId = request?.sessionId
    const command = request?.command as unknown
    sessionAccess.resolve(context, sessionId, 'write')
    if (command && typeof command === 'object' && 'sessionId' in command
      && command.sessionId !== undefined && command.sessionId !== sessionId) {
      throw new SessionAccessError()
    }

    if (context.transport === 'http') {
      const record = (command && typeof command === 'object'
        ? command
        : {}) as Record<string, unknown>
      if (record.type === SESSION_COMMAND_TYPES.ABORT) {
        getStreamEngine().abort(sessionId, 'HTTP abort')
        Permission.clearSession(sessionId)
        return { success: true }
      }
      if (record.type === SESSION_COMMAND_TYPES.PERMISSION_RESPOND) {
        return emitToBus(sessionId, {
          ...record,
          channel: adoptPendingPermissionChannel(sessionId, record),
        }, context)
      }
      return emitToBus(sessionId, command, context)
    }

    return emitToBus(sessionId, sanitizeRendererCommand(command), context)
  },
}
