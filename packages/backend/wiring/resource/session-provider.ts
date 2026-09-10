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
 * ── K2c-2:读面也退了,而且读走的是**读自己那条路** ─────────────────────────
 * `ResourceKernel.read` 不再经 `ToolRunner`(理由在 `core/resource/read-outcome.ts`
 * 的文件头),于是域那六条读面(`get` / `getMessages` / `getMessagesPage` /
 * `getUserMarkers` / `getSegments` / `getTokenUsage`)也能退成这只 provider 的投影。
 *
 * 纪律与做法那一批逐字相同:**采用域今天那一只端口**,不另写一份。所以
 * `markers` 问的是 `store.getSessionUserMessageMarkers`(不是读门面的
 * `listUserMarkers` —— 域今天问的是仓那一口,换一口就是改行为)、`segments` 问的是
 * `wiring/toc` 的 `readSessionSegments`、`tokenUsage` 问的是
 * `store.getSessionTokenUsage` + 运行时那只归一化函数;`messages` 的两支各自对应
 * `sessionReads.listMessages` / `sessionReads.pageMessages`。
 *
 * 失败的说法也照抄:查无此会话抛 `SessionNotFoundError`(域折成那句
 * `Session not found`),pager 说不抛 `SessionPageError` 带着它自己那句话。
 *
 * ── 露面规则 ────────────────────────────────────────────────────────────────
 * 资源工具进不进工具目录、在哪种场子露面归 K3,本单不注册。
 *
 * ── K3-a':模型也拿得到这只工具了,于是这只文件多了一个维度:**谁在调** ────────
 * K3-a 把资源工具放进工具目录,`session` 从此不再只有界面调。两处因此按主体分档,
 * 而两处的分档都住在这里(自述只说上界,权限核不读主体 —— 理由各写在那两段注释上):
 *
 *   · `plan('removeMessage')` —— `user` 零效果(人刚按下的那一次不再问一遍人),
 *     其余顶格 `session_destructive`(policy `ask`);
 *   · `read('messages')` —— 非 `user` 的翻页夹在 100 条以内、缺省 20;界面那 200
 *     条一格不动。
 *
 * 这两处是这只文件里**仅有**的两句「如果是谁调的就……」。内核里一句都不许有
 * (`core/resource/kernel.ts` 的文件头写着那条),而在这里它们不是绕过管线的暗门:
 * 分出来的档是一份**更诚实的 `Intent`**,照样交给同一位授权者去判。
 */

import fs from 'node:fs/promises'
import type {
  ResourceProvider,
  ResourceReadContext,
  ResourceEventHub,
} from '@onething/core/resource'
import { planFromSpec } from '@onething/core/resource'
import type { ResourceRef } from '@onething/core/resource'
import type { PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { Intent, textResult } from '@onething/core/toolkit'
import type { Principal } from '@onething/core/permission'
import { SESSION_EVENT_TYPES, emitCoreSessionEventSafely } from '@onething/core/events'
import { sessionResourceSpec } from '@onething/runtime/sessions/resource-spec'
import {
  normalizeOnethingSessionTokenUsage,
  renameOnethingSessionForIpc,
  removeOnethingMessageForIpc,
  sanitizeOnethingMessagesForRenderer,
  sanitizeOnethingSessionForRenderer,
  updateOnethingSessionAgent,
  updateOnethingSessionArchivedForIpc,
  updateOnethingSessionModel,
  updateOnethingSessionPinForIpc,
} from '@onething/runtime/sessions'
import { updateOnethingSessionWorkingDirectory } from '@onething/runtime/sessions/working-directory'
import type { ChatMessage, GetSessionMessagesPageRequest } from '@shared/ipc.js'
import * as store from '../../store.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'
import { getEventBus } from '../../events/index.js'
import { DEFAULT_AGENT_ID, agentExists } from '../agents/index.js'
import { consolePort, getLogger } from '../logging/index.js'
import { workdirGateway } from '../variables/gateways.js'
import { readSessionSegments } from '../toc/index.js'

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

/**
 * 分页那本册子说不(游标解不开、锚点不在那条会话里)。
 *
 * 具名的理由与 `SessionOpRefusedError` 逐字相同:判定读类名,而它带的那句话是
 * pager 自己写的 —— 域折回信封时原样用它,所以「退成投影」不改一个字。
 */
export class SessionPageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionPageError'
  }
}

/**
 * 这次读消息说的是「一页」还是「整份」(K2c-2)。
 *
 * 判据是**说没说分页的话**:四格一个都没给 = 整份(回 `undefined`);给了任意一格
 * = 一页。域那一侧的 `getMessagesPage` 总是至少带一个 `anchor`(缺省 `'tail'`,
 * 与 pager 对 `anchor` 缺席时走的分支逐字同一支),所以两条入口分得开。
 */
function pageRequestOf(sessionId: string, query: unknown): GetSessionMessagesPageRequest | undefined {
  const raw = (query ?? {}) as Record<string, unknown>
  const cursor = typeof raw.cursor === 'string' ? raw.cursor : undefined
  const limit = typeof raw.limit === 'number' ? raw.limit : undefined
  const direction = raw.direction === 'older' || raw.direction === 'newer' ? raw.direction : undefined
  const anchor = raw.anchor as GetSessionMessagesPageRequest['anchor'] | undefined
  if (cursor === undefined && limit === undefined && direction === undefined && anchor === undefined) {
    return undefined
  }
  return {
    sessionId,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
  }
}

/** 模型一次翻多少条(自述 `messages` 的 `limit` 那一格上写着同样两个数)。 */
const MODEL_PAGE_LIMIT_DEFAULT = 20
const MODEL_PAGE_LIMIT_MAX = 100

/**
 * 模型翻页的上限(K3-a')。**只夹非 `user` 的主体**。
 *
 * 为什么不无条件夹:壳一次要 200 条是它的正常工作量(那正是 K2c-2 证明「整页
 * 原样到达、没有 `<truncation>`」的那一例),无条件夹等于把界面的分页从 200 砍成
 * 100 —— 一次没人裁定过的、用户可感知的变化,而本单要堵的洞与界面无关。
 *
 * 为什么要夹:资源工具自 K3-a 起在工具目录里,模型可以自己写 `limit`。它一次翻
 * 一千条不会失败,只会把这一回合的预算烧在一段被截断的抄本上 —— 与 `get` 那一格
 * 的推翻理由是同一句话。
 *
 * 整份那一支(`page === undefined`)不动:那是「说没说分页的话」这条判据的另一半,
 * 模型走它拿到的是整份抄本过 `OutputBudget`,由预算说了算。
 */
function clampPageForPrincipal(
  page: GetSessionMessagesPageRequest | undefined,
  principal: Principal,
): GetSessionMessagesPageRequest | undefined {
  if (!page || principal.kind === 'user') return page
  const asked = page.limit ?? MODEL_PAGE_LIMIT_DEFAULT
  return { ...page, limit: Math.max(1, Math.min(MODEL_PAGE_LIMIT_MAX, Math.floor(asked))) }
}

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

export class SessionResourceProvider implements ResourceProvider<SessionOpPayload> {
  readonly spec = sessionResourceSpec

  private hub: ResourceEventHub | undefined

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    const sessionId = requireSessionId(ref, name)
    switch (name) {
      case 'get':
        return this.summary(sessionId)
      case 'record':
        return this.record(sessionId)
      case 'messages':
        return this.messages(sessionId, query, ctx.principal)
      case 'markers':
        return this.markers(sessionId)
      case 'segments':
        return readSessionSegments(sessionId)
      case 'tokenUsage':
        // **不判会话在不在**:域那一侧对查无此会的会话答的是一份全零读数,而本单
        // 的硬约束是契约一个字不改(理由写在自述那一格上)。
        return normalizeOnethingSessionTokenUsage(store.getSessionTokenUsage(sessionId))
      default:
        // 走不到:两条路(`ResourceTool` / `ResourceKernel.read`)都先查过读法名在不在
        // 自述里(`describeUnknownResourceReadProblem`,K2c-2 起是同一只函数)。留一句
        // 诚实的错,而不是返回 `undefined` 让调用方去猜「这条会话是空的还是这条读法
        // 不存在」。
        throw new TypeError(`Session resource has no read named ${JSON.stringify(name)}`)
    }
  }

  async plan(
    op: string,
    ref: ResourceRef | null,
    params: unknown,
    ctx: PlanContext,
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
      /**
       * **同一条做法,效果按主体分档**(K3-a')。
       *
       * 自述里 `removeMessage.effects` 是 `['session_destructive']` —— 那是**上界**,
       * 「这条做法最多会做到什么」。真发给授权者的这一条按谁在做分档:
       *
       *   · `user` —— 界面上那个删除按钮。主体本来就拥有这条会话与这条消息,人刚
       *     按下的那一次不该再问一遍人;弹卡在这里是噪音,不是保护(08-18
       *     「弹卡是噪音」判例)。零效果**不等于
       *     不留痕迹**:照样落 `tool/audit`、照样发 `messageRemoved`。
       *   · 其余(`agent` / `system`,以及经它们进来的插件)—— 顶格,`ask`。K3-a 把
       *     资源工具放进了工具目录,模型从此拿得到这只 `session` 工具;不分这一档,
       *     它可以不问一声删掉一条消息。
       *
       * ## 为什么分档在 provider 的 `plan` 里,而不是动权限核
       *
       * 因为「按主体分叉」在权限核里是另一片地:`decidePermission` 至今不读主体,
       * 而让它开始读主体 = 凭证级主体那一片(09-03 用户搁置,`docs/audit/
       * backend-architecture-review-2026-09-02.md`),不是一次接线单能拍的。
       * 而在这里它不是一条新规则:`plan` 的整个职责就是「说清楚这一次将要做什么」,
       * 而这一次将要做什么本来就取决于谁在做 —— 与「读一个越界路径要报
       * `external_directory` 而不是 `read`」是同一种按现场分档,`planFromSpec` 的
       * 注释写着它自己不做这种判断。
       */
      case 'removeMessage': {
        const messageId = stringParam(params, 'messageId', op)
        const payload = { op, sessionId, messageId } as const
        const preview = { title: `Remove message ${messageId}` }
        if (ctx.principal.kind === 'user') return Intent.of({ effects: [], payload, preview })
        return plan(payload, preview.title)
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

  /**
   * 摘要 —— 「这条会话是谁」,一格抄本都没有(自述 `get` 那一格说的就是这件事)。
   *
   * 问的是 `sessionReads.getSession`(读面)而不是 `store.getSession`:摘要的每一格
   * 都是会话自己的元数据,读面是它们的正门。`messageCount` 问 `countMessages` ——
   * 数一遍比拉回整份再取 `.length` 便宜,而且它本来就是读面的一条方法。
   *
   * 缺席的格子**不出现**,不写成 `null` / `''`:一份「没绑 agent」的摘要与一份
   * 「绑了空字符串」的摘要在读者眼里不该是同一件事。
   */
  private summary(sessionId: string): unknown {
    const session = sessionReads.getSession(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    return {
      id: session.id,
      title: session.name,
      ...(session.workingDirectory ? { workingDirectory: session.workingDirectory } : {}),
      createdAt: session.createdAt,
      messageCount: sessionReads.countMessages(sessionId),
      pinned: session.isPinned === true,
      archived: session.isArchived === true,
      // `provider/model` 一整串:与 `setModel` 那条做法自己的 `describe` 同形。
      ...(session.lastModel ? { model: `${session.lastProvider ?? ''}/${session.lastModel}` } : {}),
      ...(session.agentId ? { agent: session.agentId } : {}),
    }
  }

  /**
   * 一条会话的记录 —— 域的 `get` 一直交出去的那一份(`store.getSession` +
   * renderer 脱敏),**带抄本**。自述里它叫 `record`,与摘要那一条为什么是两条读法
   * 而不是一条读法的两种详略,写在自述 `get` 那一格上。
   */
  private record(sessionId: string): unknown {
    const session = store.getSession(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)
    return sanitizeOnethingSessionForRenderer(session)
  }

  /**
   * 消息:整份或一页,**判据是「这次说了分页的话没有」**(自述 `messages` 那一格)。
   *
   * 两支各自对应域今天那一只端口,逐字不换:
   *   · 整份 = `sessionReads.listMessages`(投影),存在性问 `store.getSessionMessages`
   *     —— 「投影折不出消息」与「查无此会话」是两件事,后者才是 NOT_FOUND;
   *   · 一页 = `sessionReads.pageMessages`(分页在事件账本的 pager 上),页信封原样
   *     带出来,只把 `success` 那一格摘掉(它在资源这一层由 `ReadOutcome` 说)。
   */
  private messages(sessionId: string, query: unknown, principal: Principal): unknown {
    const page = clampPageForPrincipal(pageRequestOf(sessionId, query), principal)
    if (!page) {
      const messages = sessionReads.listMessages(sessionId).messages as ChatMessage[]
      if (messages.length === 0 && store.getSessionMessages(sessionId) === undefined) {
        throw new SessionNotFoundError(sessionId)
      }
      return { messages: sanitizeOnethingMessagesForRenderer(messages) }
    }

    const response = sessionReads.pageMessages(page)
    // pager 说不(游标解不开、锚点不在)—— 那句话原样抛出去,域折回信封时用的就是
    // 它(`rpc/resource-envelope.ts`),所以这条路上一个字都没被改写。
    if (!response.success) throw new SessionPageError(response.error ?? 'Failed to get message page')
    const { success: _success, messages, ...rest } = response
    return { ...rest, messages: sanitizeOnethingMessagesForRenderer(messages) }
  }

  private markers(sessionId: string): unknown {
    const markers = store.getSessionUserMessageMarkers(sessionId)
    if (!markers) throw new SessionNotFoundError(sessionId)
    return markers
  }
}
