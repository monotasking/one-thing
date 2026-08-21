import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolEffect } from '@onething/core/tools'
import { decidePermission } from '../permission-policy'

vi.mock('../../../permission/permission-grants.js', () => ({
  matchGrant: vi.fn(),
}))

const readEffect: ToolEffect = { kind: 'read', resources: ['/repo/a.ts'], barrier: false }
const editEffect: ToolEffect = { kind: 'file_edit', resources: ['/repo/a.ts'], barrier: true }
const bashEffect: ToolEffect = { kind: 'bash', resources: ['rm *'], barrier: true }

beforeEach(async () => {
  const grants = await import('../../../permission/permission-grants.js')
  ;(grants.matchGrant as any).mockReset()
})

describe('permission-policy', () => {
  it('allows read-only effects in normal mode', () => {
    expect(decidePermission({ sessionId: 's1', mode: 'normal', effects: [readEffect] })).toEqual({ decision: 'allow' })
  })

  it('asks for edit/write/bash effects in normal mode', () => {
    expect(decidePermission({ sessionId: 's1', mode: 'normal', effects: [editEffect] })).toMatchObject({ decision: 'ask' })
    expect(decidePermission({ sessionId: 's1', mode: 'normal', effects: [bashEffect] })).toMatchObject({ decision: 'ask' })
  })

  it('auto-allows edits in auto accept edits mode but not bash', () => {
    expect(decidePermission({ sessionId: 's1', mode: 'auto-accept-edits', effects: [editEffect] })).toEqual({ decision: 'allow' })
    expect(decidePermission({ sessionId: 's1', mode: 'auto-accept-edits', effects: [bashEffect] })).toMatchObject({ decision: 'ask' })
  })

  /**
   * 止血 3(2026-08-11):`auto-accept-edits` 是一句关于**这个项目**的授权,不是
   * 「随便往哪个绝对路径写盘」。越界的写(effect 上的 `external: true`,由
   * write/edit 的 analyze 按 workingDirectoryRoots 判出)必须回落 ask。
   */
  describe('auto-accept-edits 与越界写', () => {
    const externalWrite: ToolEffect = {
      kind: 'file_write',
      resources: ['/Users/me/.ssh/config'],
      barrier: true,
      external: true,
      metadata: { path: '/Users/me/.ssh/config', isExternal: true },
    }
    const externalEdit: ToolEffect = { ...externalWrite, kind: 'file_edit' }
    const externalDestructive: ToolEffect = { ...externalWrite, kind: 'file_destructive_edit' }
    const inRootWrite: ToolEffect = {
      kind: 'file_write',
      resources: ['/repo/a.ts'],
      barrier: true,
      external: false,
      metadata: { path: '/repo/a.ts', isExternal: false },
    }

    it.each([
      ['file_write', externalWrite],
      ['file_edit', externalEdit],
      ['file_destructive_edit', externalDestructive],
    ])('asks for an out-of-root %s even in auto-accept-edits mode', (_kind, effect) => {
      expect(decidePermission({ sessionId: 's1', mode: 'auto-accept-edits', effects: [effect] }))
        .toMatchObject({ decision: 'ask', effect })
    })

    /** 回归证据:界内的写没有被变卡 —— 判据只有 `external` 这一位。 */
    it.each([
      ['external: false', inRootWrite],
      ['external 缺席', { ...inRootWrite, external: undefined } as ToolEffect],
      ['无 metadata 的裸 edit', editEffect],
    ])('keeps in-root writes auto-accepted (%s)', (_label, effect) => {
      expect(decidePermission({ sessionId: 's1', mode: 'auto-accept-edits', effects: [effect] }))
        .toEqual({ decision: 'allow' })
    })

    it('still asks for an out-of-root write in normal mode (unchanged)', () => {
      expect(decidePermission({ sessionId: 's1', mode: 'normal', effects: [externalWrite] }))
        .toMatchObject({ decision: 'ask' })
    })

    it('dangerously-allow-all still wins — this gate is about auto-accept only', () => {
      expect(decidePermission({ sessionId: 's1', mode: 'dangerously-allow-all', effects: [externalWrite] }))
        .toEqual({ decision: 'allow' })
    })

    it('an existing grant for that path still allows it without a card', async () => {
      const grants = await import('../../../permission/permission-grants.js')
      ;(grants.matchGrant as any).mockReturnValue({ id: 'g-ssh' } as any)
      expect(decidePermission({ sessionId: 's1', mode: 'auto-accept-edits', effects: [externalWrite] }))
        .toMatchObject({ decision: 'allow', grantId: 'g-ssh' })
    })
  })

  it('allows by scoped grant', async () => {
    const grants = await import('../../../permission/permission-grants.js')
    ;(grants.matchGrant as any).mockReturnValue({ id: 'g1' } as any)

    expect(decidePermission({
      sessionId: 's1',
      mode: 'normal',
      effects: [bashEffect],
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
    })).toMatchObject({
      decision: 'allow',
      grantId: 'g1',
    })
    expect(grants.matchGrant).toHaveBeenCalledWith({
      type: 'bash',
      pattern: ['rm *'],
      sessionId: 's1',
      workspaceRoot: '/repo',
      userId: 'alice',
      workspaceId: 'workspace-a',
    })
  })

  it('does not let danger mode override hard deny effects', () => {
    const hardDeny: ToolEffect = {
      kind: 'bash',
      resources: ['sudo *'],
      barrier: true,
      metadata: { hardDeny: true, reason: 'sudo is forbidden' },
    }

    expect(decidePermission({ sessionId: 's1', mode: 'dangerously-allow-all', effects: [hardDeny] })).toMatchObject({
      decision: 'deny',
      reason: 'sudo is forbidden',
    })
  })
})
