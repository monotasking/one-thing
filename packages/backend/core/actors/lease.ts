/**
 * 发言权租约(docs/design/collab-actor-v3.md §1.4)。
 *
 * v2 的 `drive-guard` + `floorEpoch` 在 v3 泛化成一张牌:房间发牌,agent 拿着牌
 * 才能开口,牌上写着**代数**。为什么必须是代数而不是布尔「谁在说」:重启、换相、
 * 人类插话都会让在飞的那一轮作废,而作废的信号必须能**跨重启**判定 —— agent
 * 重启后手里还攥着一张旧牌,它得能自己看出这张牌过期了。代数一涨,旧牌全废,
 * 不需要任何一方去逐一通知。
 *
 * 本文件是**纯函数**:不碰时钟(`now` 一律传入)、不改输入(每个操作返回新账)。
 * 房间的账怎么落盘是 RoomActor(D1)的事,这里只定规则。
 */
import { createCoreId } from '../engine/ids.js'

export interface FloorLease {
  leaseId: string
  /** 发牌时的房间代数。与房间当前代数不符 = 这张牌已被换代作废。 */
  epoch: number
  roomId: string
  agentId: string
  issuedAt: number
  /** 墙钟上限(ms)。缺省 = 不自动过期,只能被撤销或换代作废。 */
  ttlMs?: number
}

/** 房间的发言权账。`active` 是在外的牌,`revoked` 是点名作废过的牌号。 */
export interface FloorLeaseLedger {
  roomId: string
  epoch: number
  active: readonly FloorLease[]
  revoked: readonly string[]
}

export type FloorLeaseInvalidReason =
  /** 账上没这张牌(伪造,或已经被 prune 掉)。 */
  | 'unknown'
  /** 点名撤销过。 */
  | 'revoked'
  /** 换过代了 —— 重启/换相/人类插话之后手里的旧牌。 */
  | 'stale-epoch'
  /** 超过 ttl。 */
  | 'expired'
  /** 牌号对得上,但内容对不上(房/人/代数被改过)。 */
  | 'mismatch'

export type FloorLeaseCheck =
  | { valid: true; lease: FloorLease }
  | { valid: false; reason: FloorLeaseInvalidReason }

export const FLOOR_LEASE_INITIAL_EPOCH = 1

/** 撤销记录的保留条数。作废是一次性信号,留一小段够挡住迟到的 speak 就行。 */
export const FLOOR_LEASE_REVOKED_HISTORY = 64

export function createFloorLeaseLedger(roomId: string, epoch: number = FLOOR_LEASE_INITIAL_EPOCH): FloorLeaseLedger {
  return { roomId, epoch, active: [], revoked: [] }
}

export interface IssueFloorLeaseRequest {
  agentId: string
  now: number
  ttlMs?: number
  /** 显式牌号。迁移与重放要确定性,不能靠随机。 */
  leaseId?: string
}

export interface IssueFloorLeaseResult {
  ledger: FloorLeaseLedger
  lease: FloorLease
}

/**
 * 发一张牌。**不涨代数** —— 发牌是常态,换代是事故/换相,两件事不能共用一个计数器
 * (共用的话每发一张牌就把在外的其它牌全废了,并发上限当场退化成 1)。
 */
export function issueFloorLease(ledger: FloorLeaseLedger, request: IssueFloorLeaseRequest): IssueFloorLeaseResult {
  const lease: FloorLease = {
    leaseId: request.leaseId ?? `lease-${createCoreId()}`,
    epoch: ledger.epoch,
    roomId: ledger.roomId,
    agentId: request.agentId,
    issuedAt: request.now,
    ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
  }
  return {
    ledger: { ...ledger, active: [...ledger.active, lease] },
    lease,
  }
}

/** 牌的过期时刻;无 ttl 返回 null(= 永不自动过期)。 */
export function floorLeaseExpiresAt(lease: FloorLease): number | null {
  return lease.ttlMs === undefined ? null : lease.issuedAt + lease.ttlMs
}

export function isFloorLeaseExpired(lease: FloorLease, now: number): boolean {
  const expiresAt = floorLeaseExpiresAt(lease)
  return expiresAt !== null && now >= expiresAt
}

/**
 * 验一张牌。
 *
 * 判据次序是有意的:先看**点名撤销**(最强的否决),再看账上有没有,再看代数,
 * 最后才看墙钟。次序反过来的话,一张既被撤销又过期的牌会报「过期」—— 排障时
 * 「谁把我的牌收了」和「我说得太慢了」是两个完全不同的故事。
 */
export function validateFloorLease(ledger: FloorLeaseLedger, lease: FloorLease, now: number): FloorLeaseCheck {
  if (ledger.revoked.includes(lease.leaseId)) return { valid: false, reason: 'revoked' }

  const recorded = ledger.active.find(entry => entry.leaseId === lease.leaseId)
  if (!recorded) return { valid: false, reason: 'unknown' }

  if (
    recorded.roomId !== lease.roomId
    || recorded.agentId !== lease.agentId
    || recorded.epoch !== lease.epoch
  ) {
    return { valid: false, reason: 'mismatch' }
  }

  if (recorded.epoch !== ledger.epoch) return { valid: false, reason: 'stale-epoch' }
  if (isFloorLeaseExpired(recorded, now)) return { valid: false, reason: 'expired' }

  return { valid: true, lease: recorded }
}

/** 按牌号验(agent 只报 leaseId 的场合,比如 yield)。 */
export function validateFloorLeaseId(
  ledger: FloorLeaseLedger,
  leaseId: string,
  now: number,
): FloorLeaseCheck {
  const recorded = ledger.active.find(entry => entry.leaseId === leaseId)
  if (!recorded) {
    return { valid: false, reason: ledger.revoked.includes(leaseId) ? 'revoked' : 'unknown' }
  }
  return validateFloorLease(ledger, recorded, now)
}

/**
 * 作废一张牌。正常让位(yield)与强制收回(revoke)走同一条 —— 从房间的账看,
 * 「这张牌不再有效」是同一个事实,理由归事件的 payload,不归账。
 */
export function revokeFloorLease(ledger: FloorLeaseLedger, leaseId: string): FloorLeaseLedger {
  const active = ledger.active.filter(entry => entry.leaseId !== leaseId)
  const revoked = ledger.revoked.includes(leaseId)
    ? ledger.revoked
    : [...ledger.revoked, leaseId].slice(-FLOOR_LEASE_REVOKED_HISTORY)
  return { ...ledger, active, revoked }
}

/**
 * 换代:代数 +1,在外的牌**全部作废**。
 *
 * 注意 `active` 不清空 —— 留着,好让旧牌的验证结果是 `stale-epoch` 而不是
 * `unknown`。这两个理由指向完全不同的排障方向(「换过代了」vs「这牌根本不存在」),
 * 清空等于把信息扔了。真正的清理交给 `pruneFloorLeases`。
 */
export function bumpFloorEpoch(ledger: FloorLeaseLedger): FloorLeaseLedger {
  return { ...ledger, epoch: ledger.epoch + 1 }
}

/** 当前有效的牌(用于并发上限:同时在外的租约数 = maxConcurrentTurns)。 */
export function activeFloorLeases(ledger: FloorLeaseLedger, now: number): FloorLease[] {
  return ledger.active.filter(lease => lease.epoch === ledger.epoch && !isFloorLeaseExpired(lease, now))
}

/** 并发闸:还能不能再发一张。`limit <= 0` = 不限(与其它闸同一套约定)。 */
export function canIssueFloorLease(ledger: FloorLeaseLedger, now: number, limit: number): boolean {
  if (limit <= 0) return true
  return activeFloorLeases(ledger, now).length < limit
}

/** 清掉过期与旧代的牌。账的体积由它兜底,判定语义不受影响。 */
export function pruneFloorLeases(ledger: FloorLeaseLedger, now: number): FloorLeaseLedger {
  const active = activeFloorLeases(ledger, now)
  return active.length === ledger.active.length ? ledger : { ...ledger, active }
}
