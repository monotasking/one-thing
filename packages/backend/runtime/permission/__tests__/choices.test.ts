/**
 * `Info.choices`(A3-a,方案 §3.5 / §11.3):发问方自带的选项表原样上卡,人答了哪一种原样
 * 回到等待方。缺席 = 今天那几只钮,本地工具零回归。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Permission,
  type PermissionBusEvent,
  type PermissionCommandEnvelope,
  type PermissionEventBusLike,
} from '../permission-asks.js'
import { listWorkspaceGrants, resetPermissionGrantsForTests } from '../permission-grants.js'
import { enforcePermissionPolicy } from '../permission-policy.js'

const WORKDIR = '/tmp/choices-project'
const CHOICES: Permission.Choice[] = [
  { id: 'opt-once', kind: 'once', label: 'Allow once' },
  { id: 'opt-always', kind: 'always', label: 'Always allow' },
  { id: 'opt-reject', kind: 'reject', label: 'Reject' },
  { id: 'opt-reject-always', kind: 'reject-always', label: 'Always reject' },
]

let counter = 0

describe('Permission choices', () => {
  const emitted: Array<{ sessionId: string; event: PermissionBusEvent }> = []
  let sessionId = ''

  beforeEach(() => {
    emitted.length = 0
    resetPermissionGrantsForTests()
    sessionId = `choices-${++counter}`
    const handlers = new Map<string, (envelope: PermissionCommandEnvelope) => void>()
    const bus: PermissionEventBusLike = {
      onAnySession: (type, handler) => { handlers.set(type, handler); return () => handlers.delete(type) },
      emit: async (sid, event) => { emitted.push({ sessionId: sid, event }) },
    }
    Permission.initialize(bus, () => 'ipc')
  })

  afterEach(() => {
    Permission.clearSession(sessionId)
    Permission.shutdown()
    resetPermissionGrantsForTests()
  })

  function enforce(choices?: Permission.Choice[], kind = 'bash', resources = ['rm *']) {
    return enforcePermissionPolicy({
      sessionId,
      messageId: 'm-1',
      toolCallId: 'tc-1',
      toolName: 'execute',
      effects: [{ kind, resources, barrier: true }],
      workspaceRoot: WORKDIR,
      ...(choices ? { preview: { title: 'Run rm', choices } } : {}),
    })
  }

  function pendingId(): string {
    const prompt = Permission.getPendingPrompts(sessionId)[0]
    if (!prompt) throw new Error('no pending prompt')
    return prompt.id
  }

  it('choices 从 preview 进 Info,原样到 permission:request 事件与 getPendingPrompts', async () => {
    const pending = enforce(CHOICES)
    await Promise.resolve()
    const request = emitted.find(item => item.event.type === 'permission:request')?.event as { choices?: unknown }
    expect(request?.choices).toEqual(CHOICES)
    expect(Permission.getPendingPrompts(sessionId)[0]?.choices).toEqual(CHOICES)
    Permission.respond({ sessionId, permissionId: pendingId(), response: 'once' })
    await expect(pending).resolves.toEqual(['once'])
  })

  it('不给 choices = 今天的形状:事件与 pending 里都没有这一格', async () => {
    const pending = enforce()
    await Promise.resolve()
    const request = emitted.find(item => item.event.type === 'permission:request')?.event
    expect(request && 'choices' in request).toBe(false)
    expect('choices' in (Permission.getPendingPrompts(sessionId)[0] ?? {})).toBe(false)
    Permission.respond({ sessionId, permissionId: pendingId(), response: 'session' })
    await expect(pending).resolves.toEqual(['session'])
  })

  it('choices 带 always 时,没有 alwaysScope 的 always 也合法:按本次 pattern 落项目级 grant', async () => {
    const pending = enforce(CHOICES)
    await Promise.resolve()
    expect(Permission.respond({ sessionId, permissionId: pendingId(), response: 'always' })).toBe(true)
    await expect(pending).resolves.toEqual(['always'])
    expect(listWorkspaceGrants(WORKDIR)).toEqual([
      expect.objectContaining({ type: 'bash', pattern: ['rm *'] }),
    ])
  })

  it('没有 choices、也没有 alwaysScope 时 always 照旧结构化拒绝(本地工具零变化)', async () => {
    const pending = enforce()
    await Promise.resolve()
    expect(Permission.respond({ sessionId, permissionId: pendingId(), response: 'always' })).toBe(false)
    Permission.respond({ sessionId, permissionId: pendingId(), response: 'reject' })
    await expect(pending).rejects.toMatchObject({ always: false })
  })

  it('reject-always 只在 choices 带那一格时合法,答了等待方读到 always 位', async () => {
    const without = enforce([{ id: 'opt-reject', kind: 'reject', label: 'Reject' }])
    await Promise.resolve()
    expect(Permission.respond({ sessionId, permissionId: pendingId(), response: 'reject-always' })).toBe(false)
    Permission.respond({ sessionId, permissionId: pendingId(), response: 'reject' })
    await expect(without).rejects.toBeInstanceOf(Permission.RejectedError)

    const withChoice = enforce(CHOICES)
    await Promise.resolve()
    expect(Permission.respond({ sessionId, permissionId: pendingId(), response: 'reject-always' })).toBe(true)
    await expect(withChoice).rejects.toMatchObject({ name: 'PermissionRejectedError', always: true })
  })
})
