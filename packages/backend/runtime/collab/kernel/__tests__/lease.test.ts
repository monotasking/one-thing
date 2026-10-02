import { describe, expect, it } from 'vitest'

import {
  activeFloorLeases,
  bumpFloorEpoch,
  canIssueFloorLease,
  createFloorLeaseLedger,
  floorLeaseExpiresAt,
  isFloorLeaseExpired,
  issueFloorLease,
  pruneFloorLeases,
  revokeFloorLease,
  validateFloorLease,
  validateFloorLeaseId,
} from '../lease.js'

describe('FloorLease', () => {
  it('发牌带上房间当前代数,且不涨代数', () => {
    const ledger = createFloorLeaseLedger('r1')
    const first = issueFloorLease(ledger, { agentId: 'a1', now: 1000, leaseId: 'L1' })
    const second = issueFloorLease(first.ledger, { agentId: 'a2', now: 1001, leaseId: 'L2' })

    expect(first.lease).toEqual({ leaseId: 'L1', epoch: 1, roomId: 'r1', agentId: 'a1', issuedAt: 1000 })
    expect(second.ledger.epoch).toBe(1)
    expect(second.ledger.active.map(l => l.leaseId)).toEqual(['L1', 'L2'])
  })

  it('是纯函数:不动输入的账', () => {
    const ledger = createFloorLeaseLedger('r1')
    const { ledger: next } = issueFloorLease(ledger, { agentId: 'a1', now: 0, leaseId: 'L1' })
    expect(ledger.active).toEqual([])
    expect(next.active).toHaveLength(1)
    expect(revokeFloorLease(next, 'L1').active).toEqual([])
    expect(next.active).toHaveLength(1)
  })

  it('有效牌验得过', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 1000,
      ttlMs: 500,
      leaseId: 'L1',
    })
    expect(validateFloorLease(ledger, lease, 1200)).toEqual({ valid: true, lease })
    expect(validateFloorLeaseId(ledger, 'L1', 1200).valid).toBe(true)
  })

  it('过期:到点即失效(ttl 是闭区间的右端)', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 1000,
      ttlMs: 500,
      leaseId: 'L1',
    })
    expect(floorLeaseExpiresAt(lease)).toBe(1500)
    expect(isFloorLeaseExpired(lease, 1499)).toBe(false)
    expect(isFloorLeaseExpired(lease, 1500)).toBe(true)
    expect(validateFloorLease(ledger, lease, 1500)).toEqual({ valid: false, reason: 'expired' })
  })

  it('无 ttl 的牌永不自动过期', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 0,
      leaseId: 'L1',
    })
    expect(floorLeaseExpiresAt(lease)).toBeNull()
    expect(validateFloorLease(ledger, lease, Number.MAX_SAFE_INTEGER).valid).toBe(true)
  })

  it('换代:代数单调涨,旧牌报 stale-epoch 而不是 unknown', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 0,
      leaseId: 'L1',
    })
    const bumped = bumpFloorEpoch(ledger)
    expect(bumped.epoch).toBe(2)
    expect(bumpFloorEpoch(bumped).epoch).toBe(3)
    // 「换过代了」和「这牌根本不存在」是两个排障方向,不能糊成一个
    expect(validateFloorLease(bumped, lease, 100)).toEqual({ valid: false, reason: 'stale-epoch' })
  })

  it('换代之后新发的牌立刻有效', () => {
    const base = bumpFloorEpoch(createFloorLeaseLedger('r1'))
    const { ledger, lease } = issueFloorLease(base, { agentId: 'a1', now: 0, leaseId: 'L2' })
    expect(lease.epoch).toBe(2)
    expect(validateFloorLease(ledger, lease, 1).valid).toBe(true)
  })

  it('撤销:让位与强制收回走同一条,理由归事件不归账', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 0,
      leaseId: 'L1',
    })
    const revoked = revokeFloorLease(ledger, 'L1')
    expect(validateFloorLease(revoked, lease, 1)).toEqual({ valid: false, reason: 'revoked' })
    expect(validateFloorLeaseId(revoked, 'L1', 1)).toEqual({ valid: false, reason: 'revoked' })
    // 重复撤销是幂等的
    expect(revokeFloorLease(revoked, 'L1').revoked).toEqual(['L1'])
  })

  it('账上没有的牌号 = unknown', () => {
    const ledger = createFloorLeaseLedger('r1')
    expect(validateFloorLeaseId(ledger, 'nope', 1)).toEqual({ valid: false, reason: 'unknown' })
  })

  it('牌号对得上但内容被改过 = mismatch', () => {
    const { ledger, lease } = issueFloorLease(createFloorLeaseLedger('r1'), {
      agentId: 'a1',
      now: 0,
      leaseId: 'L1',
    })
    expect(validateFloorLease(ledger, { ...lease, agentId: 'a2' }, 1)).toEqual({ valid: false, reason: 'mismatch' })
    expect(validateFloorLease(ledger, { ...lease, epoch: 99 }, 1)).toEqual({ valid: false, reason: 'mismatch' })
  })

  it('并发闸按同时在外的有效牌数;limit<=0 = 不限', () => {
    let ledger = createFloorLeaseLedger('r1')
    ledger = issueFloorLease(ledger, { agentId: 'a1', now: 0, ttlMs: 100, leaseId: 'L1' }).ledger
    ledger = issueFloorLease(ledger, { agentId: 'a2', now: 0, leaseId: 'L2' }).ledger

    expect(activeFloorLeases(ledger, 0)).toHaveLength(2)
    expect(canIssueFloorLease(ledger, 0, 2)).toBe(false)
    expect(canIssueFloorLease(ledger, 0, 3)).toBe(true)
    expect(canIssueFloorLease(ledger, 0, 0)).toBe(true)

    // L1 过期后名额自动腾出来
    expect(activeFloorLeases(ledger, 100).map(l => l.leaseId)).toEqual(['L2'])
    expect(canIssueFloorLease(ledger, 100, 2)).toBe(true)
  })

  it('prune 清掉过期与旧代的牌,没得清时返回同一个引用', () => {
    let ledger = createFloorLeaseLedger('r1')
    ledger = issueFloorLease(ledger, { agentId: 'a1', now: 0, ttlMs: 100, leaseId: 'L1' }).ledger
    ledger = issueFloorLease(ledger, { agentId: 'a2', now: 0, leaseId: 'L2' }).ledger

    expect(pruneFloorLeases(ledger, 0)).toBe(ledger)
    expect(pruneFloorLeases(ledger, 100).active.map(l => l.leaseId)).toEqual(['L2'])
    expect(pruneFloorLeases(bumpFloorEpoch(ledger), 0).active).toEqual([])
  })
})
