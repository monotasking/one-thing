import type { RuntimeRequestContext } from '@onething/core'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { SessionAccessOperation } from '@shared/contracts/session-access.js'
import { getCurrentBackend } from '../current.js'

/** Historical sessions have one stable owner, independent of the current caller. */
export const DEFAULT_SESSION_OWNER = Object.freeze({ userId: 'local-user', workspaceId: 'default' })

export interface SessionOwner {
  userId?: string
  /** Tenant scope. This is never ChatSession.workspaceId (a product space). */
  workspaceId?: string
}

export interface SessionOwnershipRecord {
  /** Legacy owner field; new writes use ownerUserId. */
  userId?: string
  ownerUserId?: string
  ownerWorkspaceId?: string
}

export type SessionAccessContext = RuntimeRequestContext | RpcDispatchContext
/* 动词表住在契约层(工单 5 §6):router 契约要能自述它;这里原样再导出。 */
export type { SessionAccessOperation } from '@shared/contracts/session-access.js'

export function requestSessionOwner(context: SessionAccessContext): RuntimeRequestContext {
  return {
    userId: ('transport' in context ? context.ownerUid : context.userId) ?? DEFAULT_SESSION_OWNER.userId,
    workspaceId: context.workspaceId ?? DEFAULT_SESSION_OWNER.workspaceId,
  }
}

/**
 * 归属**取材** —— 这条会话的主体身份,缺席回落到那个固定的历史本机主体。
 *
 * 存量兼容只认 `userId` 那一格:老盘上的 `workspaceId` 存的是**产品空间**,把它读成
 * 租户正是要修的那个 bug,所以这里**故意不回落**到它。
 *
 * 这是「它归谁」的答案(执行上下文、`session:removed` 的归属凭据用它),**不是**
 * 「谁能读它」的答案 —— 后者见 `ownerMatchesContext`,两件事故意分开。
 */
export function sessionOwnerOf(record: SessionOwnershipRecord): SessionOwner {
  return {
    userId: record.ownerUserId ?? record.userId ?? DEFAULT_SESSION_OWNER.userId,
    workspaceId: record.ownerWorkspaceId ?? DEFAULT_SESSION_OWNER.workspaceId,
  }
}

/**
 * 归属**判定**:**两格都空 = 无主,谁都读得到**(单用户宿主的常态);有值的那格才比。
 * 缺席的一格不参与比较 —— 老会话只盖过 `userId` 的那种,不该因为「没有租户作用域」
 * 就对所有人隐身。
 *
 * (工单 4 A3:2026-09-06/07 那轮把这条规则换成了「先补默认值再逐格比」。差别不是
 * 学术的 —— 补完默认值,一条两格皆空的老会话就变成「归 local-user / default 所有」,
 * 于是任何带真实租户身份的调用者都读不到它,而这条规则本来的用意恰恰相反。)
 */
export function ownerMatchesContext(owner: SessionOwner, context: SessionAccessContext): boolean {
  const caller = requestSessionOwner(context)
  if (!owner.userId && !owner.workspaceId) return true
  return (owner.userId ?? caller.userId) === caller.userId
    && (owner.workspaceId ?? caller.workspaceId) === caller.workspaceId
}

/**
 * 一步到位的归属判定 —— `ownsSession` / `ownsSessionMeta` / 受众过滤共用的那一句。
 *
 * 读的是**记录原样**,不是 `sessionOwnerOf` 补过默认值的身份:补完再比就没有「缺席」
 * 这回事了,上面那条规则会整条失效。
 */
export function ownsSessionRecord(record: SessionOwnershipRecord, context: SessionAccessContext): boolean {
  return ownerMatchesContext(
    { userId: record.ownerUserId ?? record.userId, workspaceId: record.ownerWorkspaceId },
    context,
  )
}

/**
 * 「这个调用者就是那个固定的历史本机操作员吗」——桌面外设(麦克风 / 音乐 / 终端 /
 * 评估 / 后台任务)那一类**没有会话可挂**的能力用它作闸。
 *
 * 从前这一句写作 `ownsSessionRecord({}, context)`,读起来像「他拥有一条空记录吗」,
 * 而在「两格都空 = 无主谁都可读」这条规则下那个写法恒真(工单 4 A3)。它问的从来
 * 就是另一个问题,所以给它自己的名字与自己的判据。
 */
export function isHistoricalLocalOperator(context: SessionAccessContext): boolean {
  return ownerMatchesContext(DEFAULT_SESSION_OWNER, context)
}

/**
 * 不受**停止收活**闸门管的操作 —— 一张表,两个读者(工单 4 C6)。
 *
 * 判据是「它会不会给这条会话新添工作」:读与订阅只是看;`draft-read` 是读的一种;
 * 删除恰恰是**关机路上必须还能做**的那件事,拿收活闸门去挡它就是自锁。
 * 从前这份名单在 `resolveOptional` 与 `resolve` 里各手抄一遍,改一处漏一处。
 */
const OPERATIONS_OUTSIDE_ADMISSION: ReadonlySet<SessionAccessOperation> =
  new Set<SessionAccessOperation>(['read', 'subscribe', 'draft-read', 'delete'])

export class SessionAccessError extends Error {
  readonly code = 'SESSION_NOT_FOUND'
  constructor() { super('Session not found'); this.name = 'SessionAccessError' }
}

export interface SessionAccess {
  resolveOptional(context: SessionAccessContext, sessionId: string, operation: SessionAccessOperation): SessionOwnershipRecord | undefined
  resolve(context: SessionAccessContext, sessionId: string, operation: SessionAccessOperation): SessionOwnershipRecord
  resolveAll(context: SessionAccessContext, sessionIds: readonly string[], operation: SessionAccessOperation): readonly string[]
  filter<T extends object>(context: SessionAccessContext, records: readonly T[]): T[]
  filterIds(context: SessionAccessContext, sessionIds: readonly string[]): string[]
}

/** One ownership policy for application entries and subscriptions; no internal bypass. */
export function createSessionAccess(ports: {
  findMeta(sessionId: string): SessionOwnershipRecord | undefined
  assertAccepting?(sessionId: string): void
}): SessionAccess {
  return {
    resolveOptional(context, sessionId, operation) {
      if (typeof sessionId !== 'string' || !sessionId) throw new SessionAccessError()
      const record = ports.findMeta(sessionId)
      if (record && !ownsSessionRecord(record, context)) throw new SessionAccessError()
      if (!OPERATIONS_OUTSIDE_ADMISSION.has(operation)) ports.assertAccepting?.(sessionId)
      return record
    },
    resolve(context, sessionId, operation) {
      const validId = typeof sessionId === 'string' && sessionId.length > 0
      const draftOperation = operation === 'draft' || operation === 'draft-read'
      const found = validId ? ports.findMeta(sessionId) : undefined
      const record = found ?? (validId && draftOperation ? {} : undefined)
      if (!record) throw new SessionAccessError()
      // Unmaterialized scratchpads belong to the same fixed historical local owner.
      // 它盘上没有归属记录可读,所以这里**明写**那个主体,而不是拿一条空记录去走
      // 「两格都空 = 无主谁都可读」那条路(工单 4 A3)—— 草稿不是无主的。
      if (!(found ? ownsSessionRecord(found, context) : ownerMatchesContext(DEFAULT_SESSION_OWNER, context))) {
        throw new SessionAccessError()
      }
      if (!OPERATIONS_OUTSIDE_ADMISSION.has(operation)) ports.assertAccepting?.(sessionId)
      return record
    },
    resolveAll(context, sessionIds, operation) {
      const targets = [...new Set(sessionIds)]
      for (const id of targets) this.resolve(context, id, operation)
      return Object.freeze(targets)
    },
    filter(context, records) { return records.filter(record => ownsSessionRecord(record, context)) },
    filterIds(context, sessionIds) {
      return sessionIds.filter(id => { const meta = ports.findMeta(id); return meta !== undefined && ownsSessionRecord(meta, context) })
    },
  }
}

/** Compatibility facade; the Backend owns the lookup port and its lifetime. */
export const sessionAccess: SessionAccess = {
  resolveOptional: (...args) => getCurrentBackend('sessionLayer').sessionLayer.access.resolveOptional(...args),
  resolve: (...args) => getCurrentBackend('sessionLayer').sessionLayer.access.resolve(...args),
  resolveAll: (...args) => getCurrentBackend('sessionLayer').sessionLayer.access.resolveAll(...args),
  filter: (...args) => getCurrentBackend('sessionLayer').sessionLayer.access.filter(...args),
  filterIds: (...args) => getCurrentBackend('sessionLayer').sessionLayer.access.filterIds(...args),
}
