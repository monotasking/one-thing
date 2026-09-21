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
 *
 * ── K2c-3:域剩下的那批也退了,于是「按主体分档」从一条长到四条 ─────────────────
 * 本单退的七条里有四条带效果(`delete` / `setPermissionMode` / `appendSystemMessage`,
 * 以及 `removeMessage` 的 `marker` 那一支),四条走的是 K3-a' 立好的同一个形:自述说
 * 上界,`plan` 按主体定这一次真发出去的那一份。于是这只文件里那句「如果是谁调的」
 * 从两处变成六处 —— 但它仍然是**同一句话**,所以它被收成了一只
 * `planByPrincipal(...)`:界面/人 = 零效果,其余 = 顶格。多一条做法就是多一行调用,
 * 不是多一段判断。
 *
 * 本单还搬进来两件从前住在域里的东西,理由都是「AI 走这条路也要有」:
 *   · **删的那一串副作用** —— 级联名单、三相位删除、AI todo 跟着走、把这条会话在这个
 *     进程里的活收干净(`releaseServedSession`)。它们从前住在 `rpc/domains/sessions.ts`
 *     的 `delete` 处理器里,于是「删会话」在仓库里只有界面那一条路。
 *   · **一张自述自己的表**:哪几种权限档位合法(`SESSION_PERMISSION_MODES`)。域从前
 *     把那三个字面量抄在自己的处理器里。
 *
 * **本单没搬的那一格,写清楚**:`sessionDeletion.delete` 的第三个参数是「删到一半再
 * 验一次归属」的回调,而归属是**调用方身份**(`ownerUid` / `workspaceId`),资源面的
 * `Invocation` 上没有这一格 —— 与 `updateWorkingDirectory` 的沙箱夹持留在域适配器是
 * 同一条过渡理由。所以这里递的是一只不作声的回调,归属校验由 RPC 边界**前置**做掉;
 * 目标集合有没有中途变过那一半(`ports.targets` 比对)一个字没动,它不依赖调用方。
 */

import fs from 'node:fs/promises'
import { resolve } from 'node:path'
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
import { collectSessionCascadeDeleteIds } from '@onething/core/session'
import {
  SESSION_COLLECTION_PATH,
  SESSION_PERMISSION_MODES,
  sessionResourceSpec,
} from '@onething/runtime/sessions/resource-spec'
import {
  addOnethingSystemMessageForIpc,
  deleteOnethingSessionForIpc,
  normalizeOnethingSessionTokenUsage,
  renameOnethingSessionForIpc,
  removeOnethingMessageForIpc,
  removeOnethingSystemMarkerMessageForIpc,
  sanitizeOnethingMessagesForRenderer,
  sanitizeOnethingSessionForRenderer,
  updateOnethingSessionAgent,
  updateOnethingSessionArchivedForIpc,
  updateOnethingSessionModel,
  updateOnethingSessionPermissionMode,
  updateOnethingSessionPinForIpc,
} from '@onething/runtime/sessions'
import { updateOnethingSessionWorkingDirectory } from '@onething/runtime/sessions/working-directory'
import { expandOnethingToolSandboxPath } from '@onething/runtime/tools/sandbox-runtime'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import type { ChatMessage, GetSessionMessagesPageRequest } from '@shared/ipc.js'
import * as store from '../../store.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionDeletion } from '../../session/deletion.js'
import { sessionReads } from '../../session/reads.js'
import {
  extractSessionPageResults,
  type SessionPageResultSlot,
} from '../../session/page-results.js'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import { DEFAULT_AGENT_ID, agentExists } from '../agents/index.js'
import { consolePort, getLogger } from '../logging/index.js'
import { Permission } from '../permission/index.js'
import { deleteSessionAiTodo } from '../todo-plan/store.js'
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

/**
 * 拿一条会话的地址去问集合级的那条读法(或反过来)。
 *
 * 具名而不是复用上面那只:两句话说的不是同一件事,而调用方(壳 / 模型 / CLI)看到
 * 「需要一个会话地址」与「需要那个集合坐标」时该改的东西完全不同。
 */
export class SessionCollectionRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs the collection address "${sessionResourceSpec.scheme}:${SESSION_COLLECTION_PATH}"`)
    this.name = 'SessionCollectionRefRequiredError'
  }
}

/** 这次删的是哪一条:一个消息 id,还是「那种标记的那一条」。 */
export type SessionMessageTarget =
  | { readonly kind: 'message'; readonly messageId: string }
  | { readonly kind: 'marker'; readonly marker: string }

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
  | { readonly op: 'removeMessage'; readonly sessionId: string; readonly target: SessionMessageTarget }
  | { readonly op: 'delete'; readonly sessionId: string }
  | { readonly op: 'setPermissionMode'; readonly sessionId: string; readonly permissionMode: string }
  | { readonly op: 'appendSystemMessage'; readonly sessionId: string; readonly message: ChatMessage }

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
 * 首屏那一页缺省几条(自述 `page` 的 `limit` 那一格上写着同一个数)。
 *
 * 24 而不是 20:20 是**模型**一次读多少的数(它按预算算),24 是**一屏**的数
 * —— 两个数各有各的产地,凑成一个只会让下一个人改错那一头。
 */
const TAIL_PAGE_LIMIT_DEFAULT = 24

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

function objectParam(params: unknown, key: string, member: string): Record<string, unknown> {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${member} needs an object ${key}`)
  }
  return value as Record<string, unknown>
}

/**
 * `removeMessage` 的两格二选一(K2c-3)。
 *
 * 判据写在这里而不是在 schema 里:JSON Schema 表达得出 `oneOf`,但那份 schema 同时是
 * 模型看到的工具入参契约,而 `oneOf` 嵌在一条做法的 `params` 里会让整只 `session` 工具
 * 的入参从「一层可辨识联合」变成两层 —— 换来的只是把这四行挪个地方。
 */
function messageTargetOf(params: unknown, member: string): SessionMessageTarget {
  const marker = optionalStringParam(params, 'marker')
  const messageId = optionalStringParam(params, 'messageId')
  if (marker && messageId) throw new TypeError(`${member} takes either a messageId or a marker, not both`)
  if (marker) return { kind: 'marker', marker }
  return { kind: 'message', messageId: stringParam(params, 'messageId', member) }
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

/**
 * 删会话时,把这条会话在**这个进程里**的「活」收干净 —— 清权限询问、拆掉它的事件
 * 与流通道。K2c-3 从 `rpc/domains/sessions.ts` 逐字搬上来(那三步连同它的判据都没改)。
 *
 * 它必须住在这里的理由与 `rename` 那一发广播逐字相同:AI / CLI / 调度删一条会话与
 * 界面删是同一件事,而从前只有界面那一条路会收尾 —— 留下的是一条对着已删会话还在
 * 派事件的通道。
 *
 * 三步各自带守卫(没有 pending 就不清,通道不在就不拆),所以一条没有任何进程内活计
 * 的会话上整段是 no-op。中止活流不在这里:它排在物理删除之前,由删除层自己的
 * `abortAndDrain` 端口做(`session/deletion.ts` 的三相位)。
 */
function releaseServedSession(sessionId: string): void {
  Permission.clearSession(sessionId)
  getEventBus().destroySession(sessionId)
  getStreamChannel().destroySession(sessionId)
}

/**
 * 「删到一半再验一次归属」那一格今天是空的。
 *
 * 具名的常量而不是一个匿名 `() => {}`:它是一处**留账**,不是一句省略。归属是调用方
 * 身份(`ownerUid` / `workspaceId`),而资源面的 `Invocation` 上只有 `Principal`;
 * 归属校验因此由 RPC 边界**前置**做掉(`rpc/domains/sessions.ts` 的 `delete`)。
 * 删除层自己那一半 —— 「目标集合中途变过没有」—— 一个字没动,它不依赖调用方。
 * per-caller 的归属进 `Invocation` 之后,这一格换成真的那一句。
 */
const CALLER_AUTHORIZATION_IS_PRE_CHECKED = (): void => {}

export class SessionResourceProvider implements ResourceProvider<SessionOpPayload> {
  readonly spec = sessionResourceSpec

  private hub: ResourceEventHub | undefined

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    // 集合级的那一条先分出去:它的地址是保留坐标,不是一条会话(K2c-3)。
    if (name === 'list') {
      if (!ref || ref.path !== SESSION_COLLECTION_PATH) throw new SessionCollectionRefRequiredError(name)
      return this.list(query)
    }
    const sessionId = requireSessionId(ref, name)
    switch (name) {
      case 'get':
        return this.summary(sessionId)
      case 'record':
        return this.record(sessionId)
      case 'messages':
        return this.messages(sessionId, query, ctx.principal)
      case 'page':
        return this.page(sessionId, query, ctx.principal)
      case 'toolResult':
        return this.toolResult(sessionId, query)
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
    //
    // **`delete` 例外,而且是有意的**:删一条已经不在的会话在域那条老路上是一次成功
    // 的空删(`deletedCount: 0`),不是一次失败 —— 删是幂等的,壳上连点两下删除、或者
    // 两扇窗同时删同一条,不该第二下报「查无此会话」。本单的硬约束是契约一字不改,
    // 所以这一条按老路的答案办。
    if (op !== 'delete' && !sessionReads.hasSessionInStore(sessionId)) throw new SessionNotFoundError(sessionId)

    const plan = (payload: SessionOpPayload, title: string): Intent<SessionOpPayload> =>
      planFromSpec<SessionOpPayload>(this.spec, op, ref, payload, { title })

    /**
     * **同一条做法,效果按主体分档**(K3-a' 立的形,K2c-3 起有四条做法用它)。
     *
     * 自述里那条 `effects` 是**上界**——「这条做法最多会做到什么」。真发给授权者的
     * 这一条按谁在做分档:
     *
     *   · `user` —— 界面上那个按钮。主体本来就拥有这条会话,人刚按下的那一次不该再问
     *     一遍人;弹卡在这里是噪音,不是保护(08-18「弹卡是噪音」判例)。零效果**不等于
     *     不留痕迹**:照样落 `tool/audit`、照样发事件。
     *   · 其余(`agent` / `system`,以及经它们进来的插件)—— 顶格,按策略表问。
     *
     * ## 为什么分档在 provider 的 `plan` 里,而不是动权限核
     *
     * 因为「按主体分叉」在权限核里是另一片地:`decidePermission` 至今不读主体,而让它
     * 开始读主体 = 凭证级主体那一片(09-03 用户搁置,`docs/audit/
     * backend-architecture-review-2026-09-02.md`),不是一次接线单能拍的。而在这里它
     * 不是一条新规则:`plan` 的整个职责就是「说清楚这一次将要做什么」,而这一次将要
     * 做什么本来就取决于谁在做 —— 与「读一个越界路径要报 `external_directory` 而不是
     * `read`」是同一种按现场分档,`planFromSpec` 的注释写着它自己不做这种判断。
     */
    const planByPrincipal = (payload: SessionOpPayload, title: string): Intent<SessionOpPayload> =>
      ctx.principal.kind === 'user'
        ? Intent.of({ effects: [], payload, preview: { title } })
        : plan(payload, title)

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
       * 删一条消息 —— **一条做法,两种指法**(K2c-3):一个消息 id,或者「那种标记
       * 的那一条」(`/files` / git 状态往会话里补的系统消息)。两格二选一,两格都给
       * 或都不给都是一次说不清楚的请求,当场拒。
       */
      case 'removeMessage': {
        const target = messageTargetOf(params, op)
        const payload = { op, sessionId, target } as const
        return planByPrincipal(
          payload,
          target.kind === 'message'
            ? `Remove message ${target.messageId}`
            : `Remove the ${target.marker} marker message`,
        )
      }
      /**
       * 删整条会话。级联到哪几条**不在 plan 期算** —— 那是删除层自己要在开工的那一刻
       * 重算并比对的东西(`session/deletion.ts` 的 `verify`:目标集合中途变过就拒),
       * 在这里先算一遍只会多出一份会过期的名单。
       */
      case 'delete':
        return planByPrincipal({ op, sessionId }, 'Delete the session and its branches')
      case 'setPermissionMode': {
        const permissionMode = stringParam(params, 'permissionMode', op)
        return planByPrincipal({ op, sessionId, permissionMode }, `Switch permission mode to ${permissionMode}`)
      }
      case 'appendSystemMessage': {
        const message = objectParam(params, 'message', op) as unknown as ChatMessage
        return planByPrincipal({ op, sessionId, message }, 'Append a system message')
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
        /*
         * `resolvePath` 就是变量域 `workdir` 那一条的同一口配方
         * (`variables/providers/core.ts`:`resolve(expandPath(...))`)—— 这条路
         * 从前没有它,于是人手敲进来的 `~/x` 被原样 `fs.stat`,回一句
         * 「Directory does not exist: ~/x」。壳侧那一行「绑定…」与 `/cd` 收的
         * 都是一条**人打的**路径,`~` 是它最常见的写法。
         *
         * 落盘用的是**归一之后**那条(规则书回的 `path`),`emit` 与回执也跟着它:
         * 工作目录这条串同时是项目分组的键,说一条、存另一条会分裂出两个项目。
         */
        const outcome = await updateOnethingSessionWorkingDirectory({
          sessionId: payload.sessionId,
          workingDirectory: payload.path,
          resolvePath: path => resolve(expandOnethingToolSandboxPath(path)),
          isDirectory: async path => (await fs.stat(path)).isDirectory(),
          writeWorkingDirectory: (id, next) => workdirGateway.write(id, next),
        })
        settle(outcome, 'Failed to update the working directory')
        const landed = outcome.path ?? ''
        this.emit(payload.sessionId, 'workingDirectoryChanged', { path: landed })
        return textResult(
          landed ? `Session now works in ${landed}` : 'Cleared the session working directory',
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
        if (payload.target.kind === 'message') {
          const { messageId } = payload.target
          settle(
            await removeOnethingMessageForIpc({
              sessionId: payload.sessionId,
              messageId,
              deleteMessage: (id, nextMessageId) => sessionCommands.deleteMessage(id, { messageId: nextMessageId }),
              logger: consoleLog,
            }),
            'Failed to remove message',
          )
          this.emit(payload.sessionId, 'messageRemoved', { messageId })
          // 回执里那一格是**删掉了哪一条** —— 两种指法交出同一种形状,于是域折信封时
          // 不必知道这次是按 id 还是按标记(`RemoveSystemMarkerMessageResponse.removedId`)。
          return textResult(`Removed message ${messageId}`, { removedId: messageId })
        }
        // 按标记删:规则书(找不到 = 成功且没删到)在 `removeOnethingSystemMarkerMessage`
        // 里,与域从前递的端口逐字相同 —— 存在性问的仍然是 `store.getSession`。
        const removed = await removeOnethingSystemMarkerMessageForIpc({
          sessionId: payload.sessionId,
          markerType: payload.target.marker,
          getSession: id => store.getSession(id),
          deleteMessage: (id, messageId) => sessionCommands.deleteMessage(id, { messageId }),
          logger: consoleLog,
        })
        settle(removed, 'Failed to remove message')
        const removedId = removed.success ? removed.removedId ?? null : null
        // 本来就没有那条标记 = 没删掉任何东西 = **不发事件**。
        if (removedId) this.emit(payload.sessionId, 'messageRemoved', { messageId: removedId })
        return textResult(
          removedId
            ? `Removed the ${payload.target.marker} marker message`
            : `No ${payload.target.marker} marker message to remove`,
          { removedId },
        )
      }
      /**
       * 删整条会话 —— **域从前那一串副作用逐字搬上来**(K2c-3),顺序一步没换:
       * 三相位删除(中止活流 → 落盘 flush → 封存 → 物理删)→ AI todo 跟着走 →
       * 把每一条在这个进程里的活收干净 → 请求里那一条再清一次询问。
       *
       * 最后那一次 `Permission.clearSession` 是原文里就有的:级联名单里没有请求那一条
       * 的时候(删除层交白卷)它才有意义,逐字保留。
       */
      case 'delete': {
        let cascadedSessionIds: string[] = []
        const done = await deleteOnethingSessionForIpc({
          sessionId: payload.sessionId,
          deleteSession: async (id) => {
            const result = await sessionDeletion.delete(
              id,
              collectSessionCascadeDeleteIds(store.getSessionsList(), id),
              CALLER_AUTHORIZATION_IS_PRE_CHECKED,
            )
            cascadedSessionIds = [...result.deletedIds]
            // AI todo 按会话 id 记账,所以它跟着会话走 —— 级联到的每一条都算。
            for (const deletedId of result.deletedIds) {
              deleteSessionAiTodo(deletedId).catch(error => {
                log.error('delete session AI todo failed', { sessionId: deletedId }, error)
              })
            }
            const teardownIds = result.deletedIds.length ? result.deletedIds : [id]
            for (const deletedId of teardownIds) releaseServedSession(deletedId)
            Permission.clearSession(id)
            return result
          },
          logger: consoleLog,
        })
        settle(done, 'Failed to delete session')
        this.emit(payload.sessionId, 'deleted', { cascadedSessionIds })
        return textResult(
          `Deleted ${cascadedSessionIds.length || 1} session(s)`,
          {
            deletedCount: done.success ? done.deletedCount : 0,
            ...(done.success && done.parentSessionId ? { parentSessionId: done.parentSessionId } : {}),
          },
        )
      }
      case 'setPermissionMode': {
        // 「哪几档合法」那张表在自述里(`SESSION_PERMISSION_MODES`),判定与文案
        // (`Invalid permission mode` / `Session not found`)在运行时那本规则书里 ——
        // 这里只递形状,与域从前那几行逐字同义。
        settle(
          await updateOnethingSessionPermissionMode({
            sessionId: payload.sessionId,
            permissionMode: payload.permissionMode,
            allowedPermissionModes: [...SESSION_PERMISSION_MODES],
            updateSessionPermissionMode: (id, next) => store.updateSessionPermissionMode(id, next as never),
          }),
          'Failed to update the session permission mode',
        )
        this.emit(payload.sessionId, 'permissionModeChanged', { permissionMode: payload.permissionMode })
        return textResult(`Session now asks in ${payload.permissionMode} mode`)
      }
      case 'appendSystemMessage': {
        // `stampCollab: true` 是域那一路带着的 —— 一条补进会话的系统消息在群房里也要
        // 有发言人。摘掉它就是改行为。
        settle(
          await addOnethingSystemMessageForIpc({
            sessionId: payload.sessionId,
            message: payload.message,
            addMessage: (id, message) => sessionCommands.appendMessage(id, { message, stampCollab: true }),
            logger: consoleLog,
          }),
          'Failed to add message',
        )
        this.emit(payload.sessionId, 'systemMessageAppended', { messageId: payload.message.id })
        return textResult('Appended a system message')
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
   * 有哪些会话(K2c-3)。
   *
   * 与别的读法同一条纪律:**采用域今天那一只端口**(`store.getSessionsList()`),
   * 索引里有什么就交出什么 —— 域那一层从来没有投影,在这里长出一层挑字段的投影就是
   * 让 `isPinned` / `kind` / `lastMessagePreview` 悄悄消失的那条路。
   *
   * 两格过滤各自的判据:
   *   · `workspaceId` —— 产品空间。它与调用方是谁无关,所以留在这里;缺席不过滤,
   *     空串是一次写错的请求(文案与 `session/queries.ts` 那句逐字相同,那是它今天
   *     的产地)。老会话没有这一格,按缺省空间算 —— 与域那一路同一条规矩。
   *   · `includeArchived` —— 缺席 = 不过滤。
   *
   * **不做归属过滤**:理由写在自述那一格上(资源面还没有 per-caller 的归属),
   * RPC 那条路仍然在域适配器里按调用方过滤。
   */
  private list(query: unknown): unknown {
    const raw = (query ?? {}) as Record<string, unknown>
    const workspaceId = raw.workspaceId
    if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !workspaceId)) {
      throw new TypeError('workspaceId must be a nonempty string')
    }
    let sessions: readonly Record<string, unknown>[] =
      store.getSessionsList() as unknown as Record<string, unknown>[]
    if (workspaceId !== undefined) {
      sessions = sessions.filter(meta => (meta.workspaceId ?? DEFAULT_SPACE_ID) === workspaceId)
    }
    if (raw.includeArchived === false) sessions = sessions.filter(meta => meta.isArchived !== true)
    return { sessions }
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

  /**
   * **首屏那一页 + 账本水位**(工单 4 A;自述 `page` 那一格上写着它为什么与
   * `messages` 是两条读法)。
   *
   * 这里一行折法都没有:请求折成 pager 认得的那个形状,交给
   * `sessionReads.pageMessagesAtWatermark`,回来的页原样带出去。两点判据:
   *
   *  · **`before` → 游标**:`before` 就是上一页交回来的 `nextBefore`,而
   *    `nextBefore` 就是 pager 的 `nextCursor` —— 同一个游标换了一个说得出口的
   *    名字,不是第二套游标语言。缺席 = `anchor:'tail'`(最后 `limit` 条),
   *    与 pager 对 `anchor` 缺席时走的分支是同一支;
   *  · **`direction` 只有一个取值**:`'older'`。屏幕只往上翻,所以这条读法根本
   *    不收方向 —— 要往下翻的读者去用 `messages`(它四格入参俱全)。
   *
   * 主体分档与 `messages` 那条逐字同源(非 `user` 夹 100),缺省不同:界面缺省
   * 24 条(一屏),模型缺省 20 条(它那条读法自己的数)。
   */
  private page(sessionId: string, query: unknown, principal: Principal): unknown {
    const raw = (query ?? {}) as Record<string, unknown>
    const before = typeof raw.before === 'string' && raw.before.length > 0 ? raw.before : undefined
    const asked = typeof raw.limit === 'number' ? raw.limit : TAIL_PAGE_LIMIT_DEFAULT
    const limit = principal.kind === 'user'
      ? Math.max(1, Math.floor(asked))
      : Math.max(1, Math.min(MODEL_PAGE_LIMIT_MAX, Math.floor(asked)))
    const request: GetSessionMessagesPageRequest = before
      ? { sessionId, limit, cursor: before, direction: 'older' }
      : { sessionId, limit, anchor: 'tail' }

    const snapshot = sessionReads.pageMessagesAtWatermark(request)
    if (!snapshot) {
      // 折不出这条会话的历史。与 `messages` 整份那一支同一条判据:「投影折不出
      // 消息」与「查无此会话」是两件事,后者才是 NOT_FOUND。
      if (store.getSessionMessages(sessionId) === undefined) throw new SessionNotFoundError(sessionId)
      // 这条会话在,但事件那条路答不了它(老会话:历史只在化石里)。水位 0 在
      // 这一支上**是真话** —— 没有账本就没有账本位置,壳据此走整份那条老路。
      // `results` 空表照给:它进了自述的 `required`,缺席就得让壳加一格判空。
      return { messages: [], results: {}, hasMoreBefore: false, watermark: 0 }
    }
    const { page, watermark, activeMessageId } = snapshot
    if (!page.success) throw new SessionPageError(page.error ?? 'Failed to get message page')
    /*
     * 工单 5 ①②:工具结果**只出现一次**。抽进侧表在这里而不是在折法里 ——
     * 折出来的那几只对象是投影 memo 缓存的本体,而侧表是**这条读法的形状**
     * (判据全文在 `session/page-results.ts` 的文件头)。`canonical.ts` 那位
     * 判官、`messages` / `record` / `listRaw` 三条老读法一格没动。
     */
    const { messages, results } = extractSessionPageResults(
      sanitizeOnethingMessagesForRenderer((page.messages ?? []) as ChatMessage[]) ?? [],
    )
    return {
      messages,
      results,
      hasMoreBefore: page.hasMoreBefore ?? false,
      // `nextCursor` 指着这一页**第一条**,往更旧的方向 —— 正是「上面那一页」。
      ...(page.hasMoreBefore && page.nextCursor ? { nextBefore: page.nextCursor } : {}),
      watermark,
      ...(activeMessageId ? { activeMessageId } : {}),
    }
  }

  /**
   * **一格大结果的正文**(工单 5 ②)。
   *
   * 页把超过 `SESSION_PAGE_INLINE_RESULT_BYTES` 的结果换成 `{bytes,hash}`;
   * 屏幕上那张卡被人点开的那一刻,按这条路取回正文。
   *
   * ## 为什么是一条新读法,而不是复用 blob 那条
   *
   * `readBlob(hash)` 只服务**账本里真有内容地址**的那些正文(超 64KB,落在
   * `sessions/<id>/blobs/`)。而页的阈值是 16KB —— 16–64KB 之间那一段结果就写在
   * 事件行里,**它没有 hash,没有 blob 文件**,拿什么去 `readBlob` 都不存在。
   * 两条线量的是两件事(一屏该带多少 / 账本行装得下多少),所以这一格的地址只能是
   * 调用自己的 id,不能是内容地址。
   *
   * (页里那格 `hash` 因此是**缓存键**不是地址:壳拿它认「这一份取过了」,
   * 不拿它去问任何人。)
   */
  private toolResult(sessionId: string, query: unknown): unknown {
    const raw = (query ?? {}) as Record<string, unknown>
    const toolCallId = stringParam(raw, 'toolCallId', 'session.toolResult')
    const asked = raw.slot
    const slot: SessionPageResultSlot =
      asked === 'text' || asked === 'partial' ? asked : 'result'
    const found = sessionReads.toolResult(sessionId, toolCallId, slot)
    if (!found) {
      if (store.getSessionMessages(sessionId) === undefined) throw new SessionNotFoundError(sessionId)
      // 「这条会话在,但这一格结果不在」——如实说,不编一个空串:壳据此画
      // 那句「读不到」,而不是画一段空白的结果。
      return { toolCallId, slot, found: false }
    }
    return { toolCallId, slot, found: true, value: found.value }
  }

  private markers(sessionId: string): unknown {
    const markers = store.getSessionUserMessageMarkers(sessionId)
    if (!markers) throw new SessionNotFoundError(sessionId)
    return markers
  }
}
