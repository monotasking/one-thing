import { describe, expect, it, vi } from 'vitest'
import { createSessionAccess, SessionAccessError } from '../access.js'

const alice = { userId: 'alice', workspaceId: 'tenant-one' }
const bob = { userId: 'bob', workspaceId: 'tenant-one' }
const local = { transport: 'ipc' as const }

describe('SessionAccess', () => {
  const rows = {
    alice: { ownerUserId: 'alice', ownerWorkspaceId: 'tenant-one', workspaceId: 'product-two' },
    bob: { ownerUserId: 'bob', ownerWorkspaceId: 'tenant-one' },
    legacy: { workspaceId: 'product-two' },
    oldAlice: { userId: 'alice' },
  }
  const access = createSessionAccess({ findMeta: id => rows[id as keyof typeof rows] as import('../access.js').SessionOwnershipRecord | undefined })

  it('checks both owner and tenant while preserving product workspaces', () => {
    expect(access.resolve(alice, 'alice', 'read')).toBe(rows.alice)
    expect(() => access.resolve(bob, 'alice', 'write')).toThrow(SessionAccessError)
    expect(() => access.resolve({ ...alice, workspaceId: 'product-two' }, 'alice', 'read')).toThrow(SessionAccessError)
    expect(access.filterIds(alice, ['bob', 'alice', 'missing'])).toEqual(['alice'])
  })

  it('treats an ownerless historical session as unowned — everyone reads it', () => {
    // 两格都空 = 无主 = 谁都读得到(HEAD 语义,工单 4 A3 修回)。补默认值再比会
    // 让这条老会话变成 local-user 的私产,对任何带真实租户身份的调用者隐身。
    expect(access.resolve(local, 'legacy', 'read')).toBe(rows.legacy)
    expect(access.resolve(alice, 'legacy', 'read')).toBe(rows.legacy)
    // 缺席的那一格(这里是租户作用域)不参与比较。
    expect(access.resolve(alice, 'oldAlice', 'read')).toBe(rows.oldAlice)
    // 有值的那一格照比:主体对不上就是看不见。
    expect(() => access.resolve(bob, 'oldAlice', 'read')).toThrow('Session not found')
  })

  it('returns the same error for missing and inaccessible resources', () => {
    const failure = (id: string) => { try { access.resolve(bob, id, 'abort') } catch (e) { return (e as Error).message } }
    expect(failure('alice')).toBe(failure('missing'))
  })

  it('requires every target before the operation can start', () => {
    const effect = vi.fn()
    const run = () => { access.resolveAll(bob, ['bob', 'alice'], 'delete'); effect() }
    expect(run).toThrow(SessionAccessError)
    expect(effect).not.toHaveBeenCalled()
    expect(access.resolveAll(bob, ['bob', 'bob'], 'delete')).toEqual(['bob'])
  })

  it('keeps unmaterialized local scratchpads usable without granting ordinary session access', () => {
    expect(access.resolve(local, 'new-draft', 'draft')).toEqual({})
    expect(() => access.resolve(local, 'new-draft', 'write')).toThrow(SessionAccessError)
    expect(() => access.resolve(bob, 'new-draft', 'draft')).toThrow(SessionAccessError)
    expect(() => access.resolve(local, 'alice', 'draft')).toThrow(SessionAccessError)
  })

  it('checks ownership before admission and keeps diagnostic reads available while closing', () => {
    const assertAccepting = vi.fn(() => { throw new Error('closing') })
    const guarded = createSessionAccess({ findMeta: () => rows.alice, assertAccepting })
    expect(() => guarded.resolve(bob, 'alice', 'write')).toThrow(SessionAccessError)
    expect(assertAccepting).not.toHaveBeenCalled()
    expect(() => guarded.resolve(alice, 'alice', 'write')).toThrow('closing')
    expect(guarded.resolve(alice, 'alice', 'read')).toBe(rows.alice)
  })
})
