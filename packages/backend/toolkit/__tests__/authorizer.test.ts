/**
 * R2a —— `PermissionAuthorizer` 的钉子。
 *
 * 判据只有一条:**权限核看到的输入,与旧管线交给 `enforcePermissionPolicy` 的那一坨
 * 逐字相同**。所以这里把 `enforce` 注入成一个记录器,比的是它收到了什么,而不是权限
 * 核内部怎么判 —— 那份判据在 `app/tools/core/__tests__/permission-policy.test.ts`,
 * 这次一个字没动。
 */

import { describe, expect, it, vi } from 'vitest'
import { AbortScope, Intent, makeEffect } from '@onething/core/toolkit'
import type { Invocation } from '@onething/core/toolkit'
import type { EnforcePermissionPolicyInput } from '../../wiring/tools/core/permission-policy.js'
import { PermissionAuthorizer } from '../authorizer.js'

function invocationFor(overrides: Partial<Invocation> = {}): Invocation {
  return {
    callId: 'call-1',
    toolId: 'write',
    input: {},
    sessionId: 'session-1',
    messageId: 'message-1',
    principal: { kind: 'user', userId: 'local' },
    cwd: '/repo',
    ...overrides,
  }
}

function scope(): AbortScope {
  return new AbortScope()
}

function recorder() {
  const calls: EnforcePermissionPolicyInput[] = []
  return {
    calls,
    enforce: async (input: EnforcePermissionPolicyInput) => {
      calls.push(input)
    },
  }
}

const WRITE_INTENT = Intent.of({
  effects: [makeEffect('file_write', ['/repo/*'], { barrier: true, metadata: { path: '/repo/a.ts' } })],
  preview: { title: 'Create a.ts', path: '/repo/a.ts', diff: '+1', additions: 1, deletions: 0 },
  payload: null,
})

describe('PermissionAuthorizer', () => {
  it('把 Intent 摆成 enforcePermissionPolicy 的输入,字段一一对应', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'normal' })
    const decision = await authorizer.decide(WRITE_INTENT, invocationFor(), scope())

    expect(decision.kind).toBe('allow')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      toolCallId: 'call-1',
      toolName: 'write',
      workspaceRoot: '/repo',
      principal: { kind: 'user', userId: 'local' },
    })
    expect(calls[0]?.effects).toEqual([
      { kind: 'file_write', resources: ['/repo/*'], barrier: true, external: undefined, sensitive: undefined, metadata: { path: '/repo/a.ts' } },
    ])
    expect(calls[0]?.preview).toEqual({
      title: 'Create a.ts', path: '/repo/a.ts', diff: '+1', additions: 1, deletions: 0, metadata: undefined,
    })
  })

  it('零效果的计划不惊动权限核', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'normal' })
    const decision = await authorizer.decide(Intent.none(null), invocationFor({ toolId: 'time' }), scope())
    expect(decision).toEqual({ kind: 'allow' })
    expect(calls).toHaveLength(0)
  })

  it('PermissionRejectedError → deny,文案来自 formatPermissionRejectedMessage', async () => {
    const rejected = new Error('The user rejected permission for this tool. Reason: not now') as Error & { reason?: string }
    rejected.name = 'PermissionRejectedError'
    rejected.reason = 'not now'

    const authorizer = new PermissionAuthorizer({
      enforce: async () => { throw rejected },
      getMode: () => 'normal',
    })
    const decision = await authorizer.decide(WRITE_INTENT, invocationFor(), scope())
    expect(decision).toEqual({
      kind: 'deny',
      reason: 'The user rejected permission for this tool. Reason: not now',
      asked: true,
      byUser: true,
      rejectionReason: 'not now',
    })
  })

  it('reason 只出现一次(旧 tools/registry.ts 那句把它拼了两遍)', async () => {
    const rejected = new Error('The user rejected permission for this tool. Reason: no') as Error & { reason?: string }
    rejected.name = 'PermissionRejectedError'
    rejected.reason = 'no'
    const authorizer = new PermissionAuthorizer({ enforce: async () => { throw rejected }, getMode: () => 'normal' })
    const decision = await authorizer.decide(WRITE_INTENT, invocationFor(), scope())
    expect(decision.kind === 'deny' && decision.reason.match(/Reason:/g)).toHaveLength(1)
  })

  it('硬拒绝与权限核自身的故障往上抛(它们是失败,不是"用户没同意")', async () => {
    const authorizer = new PermissionAuthorizer({
      enforce: async () => { throw new Error('Hard-denied tool effect') },
      getMode: () => 'normal',
    })
    await expect(authorizer.decide(WRITE_INTENT, invocationFor(), scope())).rejects.toThrow('Hard-denied tool effect')
  })

  it('alwaysAsk:零效果的计划也必须过一次人 —— 补一条一次性的不可静默效果', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'normal' })
    const decision = await authorizer.decide(
      Intent.none(null).forceAsk(),
      invocationFor({ toolId: 'time', callId: 'call-9' }),
      scope(),
    )

    expect(decision).toEqual({ kind: 'allow', asked: true })
    expect(calls[0]?.effects).toEqual([
      {
        kind: 'tool_manual_approval',
        resources: ['time#call-9'],
        barrier: true,
        metadata: {
          toolName: 'time',
          reason: 'This tool is configured to ask every time (autoExecute is off).',
        },
      },
    ])
  })

  it('alwaysAsk 的资源每次调用都不一样 —— 一次"总是允许"记下的 grant 下次匹配不上', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'normal' })
    await authorizer.decide(Intent.none(null).forceAsk(), invocationFor({ toolId: 'time', callId: 'a' }), scope())
    await authorizer.decide(Intent.none(null).forceAsk(), invocationFor({ toolId: 'time', callId: 'b' }), scope())
    expect(calls.map(call => call.effects[0]?.resources[0])).toEqual(['time#a', 'time#b'])
  })

  it('alwaysAsk 但效果本来就要问 → 不补那条效果(否则一次调用弹两张卡)', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'normal' })
    await authorizer.decide(WRITE_INTENT.forceAsk(), invocationFor(), scope())
    expect(calls[0]?.effects.map(effect => effect.kind)).toEqual(['file_write'])
  })

  it('dangerously-allow-all 下"本来就要问"的预判为假,于是 alwaysAsk 仍然补效果', async () => {
    // 这一档是"别问我任何事"的总开关。补上的那条效果照样被这一档放行 ——
    // 用户的两句话不冲突时,更宽的那句赢,与旧行为一致。
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({ enforce, getMode: () => 'dangerously-allow-all' })
    await authorizer.decide(WRITE_INTENT.forceAsk(), invocationFor(), scope())
    expect(calls[0]?.effects.map(effect => effect.kind)).toEqual(['file_write', 'tool_manual_approval'])
  })

  it('预判炸了不改变结局 —— 真正的判定仍然由 enforce 给出', async () => {
    const { calls, enforce } = recorder()
    const authorizer = new PermissionAuthorizer({
      enforce,
      getMode: vi.fn(() => { throw new Error('store is gone') }),
    })
    const decision = await authorizer.decide(WRITE_INTENT, invocationFor(), scope())
    expect(decision.kind).toBe('allow')
    expect(calls).toHaveLength(1)
  })
})
