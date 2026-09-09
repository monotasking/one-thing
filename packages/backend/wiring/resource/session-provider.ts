/**
 * K1 —— 会话这一 scheme 的实现(`docs/design/atom-2026-09.md` §3 那张表的
 * `session:` 三行)。
 *
 * 自述在产品层(`@onething/runtime/sessions/resource-spec`),实现在这里 —— 因为
 * 只有装配层够得着脊柱:读走 `sessionReads`(返回 readonly 的唯一读面),做走
 * 会话写面那几扇既有的门。
 *
 * ── K2c-1:做法的实现改成「域今天调的那一只端口」,不是第二份写法 ────────────
 * K1 的第一版里 `rename` / `setWorkingDirectory` 走的是
 * `sessionCommands.patchSession`,理由写的是「命令面是会话写面那扇门,绕过它就是
 * 开第二个洞」。K2c-1 要让 `sessions` 域退成这只 provider 的投影,于是这句话被
 * 施工现场证伪了一半:域今天走的根本不是 `patchSession`,而是
 * `store.renameSession` / `workdirGateway.write` —— 而后者做的事**更多**
 * (`workdirGateway.write` 顺带更新工作目录缓存、把目录登记进这条会话所属空间的
 * 项目名册、同步派生 roots)。也就是说 K1 之后同一件事在仓库里有**两条**写法,
 * 而 provider 那条是缺斤少两的那条:AI 经资源面改工作目录,项目名册不会跟着动。
 *
 * 所以这一批把两条并成一条,方向是**provider 采用域今天那一只端口**,不是反过来:
 *   · 反过来(域改走 `patchSession`)会当场丢掉上面那三件副作用 —— 那是回归,
 *     不是收敛;
 *   · 这个方向之后,「没有第二条路」第一次真的成立:AI 与界面按同一只端口写,
 *     副作用一样多,审计一样有。
 * 代价说清楚:`patchSession` 会往账本写一条 `session/patched`,而
 * `store.renameSession` 那一路是否写由仓库自己决定 —— 这一批**照抄域的行为**
 * (契约一字不改是本单的硬约束),两条写面要不要统一到命令面上,是会话写面自己的
 * 一次拍板,留账。
 *
 * ── 规则书只有一本 ──────────────────────────────────────────────────────────
 * 五条做法的判定(改不到 = 查无此会话、room 会话不许直接绑 agent、未知 agent、
 * 目录不存在 / 不是目录)全都住在 `@onething/runtime/sessions` 的那几只投影函数
 * 里 —— provider 只递形状,不留规则,与域从前那几行逐字同义。它们回
 * `{ success:false, error }`;这里把那一格**抛**出去(`SessionOpRefusedError`),
 * 因为管线的答案是 `Outcome` 而不是信封,而 `Outcome.failed` 原样带着这句话 ——
 * 域那一侧再折回同一个信封(`rpc/resource-envelope.ts`)。
 *
 * ── 露面规则 ────────────────────────────────────────────────────────────────
 * 资源工具进不进工具目录、在哪种场子露面归 K3,本单不注册。
 */

import fs from 'node:fs/promises'
import type {
  ResourceProvider,
  ResourceReadContext,
  ResourceEventHub,
} from '@onething/core/resource'
import { planFromSpec } from '@onething/core/resource'
import type { ResourceRef } from '@onething/core/resource'
import type { Intent, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { textResult } from '@onething/core/toolkit'
import { SESSION_EVENT_TYPES, emitCoreSessionEventSafely } from '@onething/core/events'
import { sessionResourceSpec } from '@onething/runtime/sessions/resource-spec'
import {
  renameOnethingSessionForIpc,
  removeOnethingMessageForIpc,
  updateOnethingSessionAgent,
  updateOnethingSessionArchivedForIpc,
  updateOnethingSessionModel,
  updateOnethingSessionPinForIpc,
} from '@onething/runtime/sessions'
import { updateOnethingSessionWorkingDirectory } from '@onething/runtime/sessions/working-directory'
import * as store from '../../store.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'
import { getEventBus } from '../../events/index.js'
import { DEFAULT_AGENT_ID, agentExists } from '../agents/index.js'
import { consolePort, getLogger } from '../logging/index.js'
import { workdirGateway } from '../variables/gateways.js'

const log = getLogger('resource.session')
/** 投影层收的是鸭子 logger —— 与域里那一只同一个位置、同一个形状。 */
const consoleLog = consolePort(log)

/** 这条会话不在。读与做都用它 —— 「不存在」是一句事实,不是一次降级。 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`No such session: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/**
 * 规则书说不。
 *
 * 具名而不是一句裸 `Error`:判定读类名(`core/tools/abort.ts` 那条判例)。它带的
 * `reason` 是**投影函数原样交出来的那句话**,不是这里发明的文案 —— 域折回信封时
 * 用的就是它,所以「退成投影」不改一个字。
 */
export class SessionOpRefusedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'SessionOpRefusedError'
    this.reason = reason
  }
}

/** 地址缺席时的那句话。会话的每一条读法与做法都作用在**一条**会话上。 */
export class SessionRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs a session address, e.g. "session:<id>"`)
    this.name = 'SessionRefRequiredError'
  }
}

/** `plan` 交给 `apply` 的载荷:已经解析好的目标与参数。 */
export type SessionOpPayload =
  | { readonly op: 'rename'; readonly sessionId: string; readonly title: string }
  | { readonly op: 'setWorkingDirectory'; readonly sessionId: string; readonly path: string }
  | { readonly op: 'setPinned'; readonly sessionId: string; readonly pinned: boolean }
  | {
      readonly op: 'setArchived'
      readonly sessionId: string
      readonly archived: boolean
      readonly archivedAt?: number
    }
  | { readonly op: 'setModel'; readonly sessionId: string; readonly provider: string; readonly model: string }
  | { readonly op: 'setAgent'; readonly sessionId: string; readonly agentId?: string }
  | { readonly op: 'removeMessage'; readonly sessionId: string; readonly messageId: string }

const DEFAULT_MESSAGE_PAGE = 20
const PREVIEW_LIMIT = 120

function requireSessionId(ref: ResourceRef | null, member: string): string {
  if (!ref || !ref.path) throw new SessionRefRequiredError(member)
  return ref.path
}

function stringParam(params: unknown, key: string, member: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${member} needs a non-empty ${key}`)
  }
  return value
}

/** 允许空串的那一格(工作目录:`''` = 清空,是一条合法的值不是缺席)。 */
function textParam(params: unknown, key: string, member: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string') throw new TypeError(`${member} needs a string ${key}`)
  return value
}

function booleanParam(params: unknown, key: string, member: string): boolean {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'boolean') throw new TypeError(`${member} needs a boolean ${key}`)
  return value
}

function optionalStringParam(params: unknown, key: string): string | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : undefined
}

function optionalNumberParam(params: unknown, key: string): number | undefined {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' ? value : undefined
}

/** 投影函数说不 → 抛。成功就什么都不做。 */
function settle(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) throw new SessionOpRefusedError(result.error ?? fallback)
}

/** 一条消息的一行预览。与列表投影那一格同一个口径:折成一行、砍到 120 字。 */
function previewOf(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT)}…` : collapsed
}

export class SessionResourceProvider implements ResourceProvider<SessionOpPayload> {
  readonly spec = sessionResourceSpec

  private hub: ResourceEventHub | undefined

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, _ctx: ResourceReadContext): Promise<unknown> {
    const sessionId = requireSessionId(ref, name)
    switch (name) {
      case 'get':
        return this.summary(sessionId)
      case 'messages':
        return this.messages(sessionId, query)
      default:
        // 走不到:`ResourceTool` 只在自述里有这条读法时才调进来。留一句诚实的错,
        // 而不是返回 `undefined` 让调用方去猜「这条会话是空的还是这条读法不存在」。
        throw new TypeError(`Session resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(
    op: string,
    ref: ResourceRef | null,
    params: unknown,
    _ctx: PlanContext,
  ): Promise<Intent<SessionOpPayload>> {
    const sessionId = requireSessionId(ref, op)
    // 存在性在 plan 期就判:一次注定改不动的做法不该走到 apply 才发现目标不在。
    if (!sessionReads.hasSessionInStore(sessionId)) throw new SessionNotFoundError(sessionId)

    const plan = (payload: SessionOpPayload, title: string): Intent<SessionOpPayload> =>
      planFromSpec<SessionOpPayload>(this.spec, op, ref, payload, { title })

    switch (op) {
      case 'rename': {
        const title = stringParam(params, 'title', op)
        return plan({ op, sessionId, title }, `Rename session to ${title}`)
      }
      case 'setWorkingDirectory': {
        const path = textParam(params, 'path', op)
        return plan({ op, sessionId, path }, path ? `Point session at ${path}` : 'Clear the session working directory')
      }
      case 'setPinned': {
        const pinned = booleanParam(params, 'pinned', op)
        return plan({ op, sessionId, pinned }, pinned ? 'Pin the session' : 'Unpin the session')
      }
      case 'setArchived': {
        const archived = booleanParam(params, 'archived', op)
        const archivedAt = optionalNumberParam(params, 'archivedAt')
        return plan(
          { op, sessionId, archived, ...(archivedAt !== undefined ? { archivedAt } : {}) },
          archived ? 'Archive the session' : 'Restore the session',
        )
      }
      case 'setModel': {
        const provider = stringParam(params, 'provider', op)
        const model = stringParam(params, 'model', op)
        return plan({ op, sessionId, provider, model }, `Point session at ${provider}/${model}`)
      }
      case 'setAgent': {
        const agentId = optionalStringParam(params, 'agentId')
        return plan(
          { op, sessionId, ...(agentId !== undefined ? { agentId } : {}) },
          `Bind session to ${agentId || DEFAULT_AGENT_ID}`,
        )
      }
      case 'removeMessage': {
        const messageId = stringParam(params, 'messageId', op)
        return plan({ op, sessionId, messageId }, `Remove message ${messageId}`)
      }
      default:
        throw new TypeError(`Session resource has no op named ${JSON.stringify(op)}`)
    }
  }

  async apply(op: string, intent: Intent<SessionOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'rename': {
        settle(
          await renameOnethingSessionForIpc({
            sessionId: payload.sessionId,
            newName: payload.title,
            renameSession: (id, nextName) => store.renameSession(id, nextName),
            logger: consoleLog,
          }),
          'Failed to rename session',
        )
        /**
         * **显式改名也要有推送**(从域搬上来的那一发,K2c-1)。它必须住在这里而
         * 不是域里:AI 经资源面改名与界面改名是同一件事,而从前只有界面那一路推,
         * 于是模型改完标题,别的客户端对着旧名字。
         *
         * 载荷与自动起题那一发逐字同形(`core/engine/core-stream-engine.ts` 的
         * `generateAndApplySessionTitle`:`{ type, name }` 两格),走的也是同一条
         * 总线;`name` 原样带出参数里那个字符串(仓的改名不归一化)。
         * **失败不发** —— `settle` 已经在上面抛掉了那一支。
         */
        await emitCoreSessionEventSafely({
          sessionId: payload.sessionId,
          event: { type: SESSION_EVENT_TYPES.SESSION_RENAMED, name: payload.title },
          eventBus: getEventBus(),
          logger: consoleLog,
          errorLabel: '[SessionResource] EventBus emit failed:',
        })
        this.emit(payload.sessionId, 'renamed', { title: payload.title })
        return textResult(`Renamed session to ${payload.title}`)
      }
      case 'setWorkingDirectory': {
        settle(
          await updateOnethingSessionWorkingDirectory({
            sessionId: payload.sessionId,
            workingDirectory: payload.path,
            isDirectory: async path => (await fs.stat(path)).isDirectory(),
            writeWorkingDirectory: (id, next) => workdirGateway.write(id, next),
          }),
          'Failed to update the working directory',
        )
        this.emit(payload.sessionId, 'workingDirectoryChanged', { path: payload.path })
        return textResult(
          payload.path ? `Session now works in ${payload.path}` : 'Cleared the session working directory',
        )
      }
      case 'setPinned': {
        settle(
          await updateOnethingSessionPinForIpc({
            sessionId: payload.sessionId,
            isPinned: payload.pinned,
            updateSessionPin: (id, next) => store.updateSessionPin(id, next),
            logger: consoleLog,
          }),
          'Failed to update session pin',
        )
        this.emit(payload.sessionId, 'pinned', { pinned: payload.pinned })
        return textResult(payload.pinned ? 'Pinned the session' : 'Unpinned the session')
      }
      case 'setArchived': {
        settle(
          await updateOnethingSessionArchivedForIpc({
            sessionId: payload.sessionId,
            isArchived: payload.archived,
            ...(payload.archivedAt !== undefined ? { archivedAt: payload.archivedAt } : {}),
            updateSessionArchived: (id, next, at) => store.updateSessionArchived(id, next, at),
            logger: consoleLog,
          }),
          'Failed to update session archive state',
        )
        this.emit(payload.sessionId, 'archived', { archived: payload.archived })
        return textResult(payload.archived ? 'Archived the session' : 'Restored the session')
      }
      case 'setModel': {
        settle(
          await updateOnethingSessionModel({
            sessionId: payload.sessionId,
            provider: payload.provider,
            model: payload.model,
            updateSessionModel: (id, provider, model) => store.updateSessionModel(id, provider, model),
          }),
          'Failed to update the session model',
        )
        this.emit(payload.sessionId, 'modelChanged', { provider: payload.provider, model: payload.model })
        return textResult(`Session now uses ${payload.provider}/${payload.model}`)
      }
      case 'setAgent': {
        // 三条守卫(room 会话 / 未知 agent / 缺席即默认)一条也不在这里 —— 它们在
        // `updateOnethingSessionAgent` 那本规则书里,与域从前递的端口逐字相同。
        settle(
          await updateOnethingSessionAgent({
            sessionId: payload.sessionId,
            ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
            defaultAgentId: DEFAULT_AGENT_ID,
            agentExists,
            getSessionKind: id => store.getSession(id)?.kind,
            updateSessionAgent: (id, nextAgentId) => store.updateSessionAgent(id, nextAgentId),
          }),
          'Failed to update the session agent',
        )
        const bound = payload.agentId || DEFAULT_AGENT_ID
        this.emit(payload.sessionId, 'agentChanged', { agentId: bound })
        return textResult(`Session is now bound to ${bound}`)
      }
      case 'removeMessage': {
        settle(
          await removeOnethingMessageForIpc({
            sessionId: payload.sessionId,
            messageId: payload.messageId,
            deleteMessage: (id, messageId) => sessionCommands.deleteMessage(id, { messageId }),
            logger: consoleLog,
          }),
          'Failed to remove message',
        )
        this.emit(payload.sessionId, 'messageRemoved', { messageId: payload.messageId })
        return textResult(`Removed message ${payload.messageId}`)
      }
      default:
        // 类型上到不了(payload 是判别联合),运行时留一句 —— `apply` 是公开方法。
        throw new TypeError(`Session resource has no op named ${JSON.stringify(op)}`)
    }
  }

  private emit(sessionId: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path: sessionId }, event, payload)
  }

  private summary(sessionId: string): unknown {
    const session = sessionReads.getSession(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    return {
      id: session.id,
      title: session.name,
      ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
      createdAt: session.createdAt,
      messageCount: sessionReads.countMessages(sessionId),
    }
  }

  private messages(sessionId: string, query: unknown): unknown {
    if (!sessionReads.hasSessionInStore(sessionId)) throw new SessionNotFoundError(sessionId)
    const options = (query ?? {}) as { limit?: unknown; before?: unknown }
    const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_MESSAGE_PAGE
    const all = sessionReads.listMessages(sessionId).messages

    // `before` 是「这一页结束在那条消息之前」。找不到那条 id 时**不静默退回末页**:
    // 那会让翻页的人以为自己回到了开头。
    let end = all.length
    if (typeof options.before === 'string') {
      const at = all.findIndex(message => message.id === options.before)
      if (at < 0) throw new TypeError(`No such message in this session: ${options.before}`)
      end = at
    }

    return all.slice(Math.max(0, end - limit), end).map(message => ({
      id: message.id,
      role: message.role,
      preview: previewOf(message.content ?? ''),
      createdAt: message.timestamp,
    }))
  }
}
