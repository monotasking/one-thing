/**
 * ACP 权限桥(A3-a,方案 §3.5 / §11.3):效果按 `describeAcpToolPermission` 算、agent 的
 * options 作为 `choices` 上卡、人答的那一种映射回 agent 的 optionId、「始终拒绝」在我们这边
 * 记会话级拒绝。授权者注入成桩 —— 权限核本身的判据有它自己的测试,这里只钉「进什么、出什么」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Decision } from '@onething/backend/toolkit/tool-protocol'
import type { Authorizer, Intent, Invocation } from '@onething/backend/toolkit/tool-protocol'
import { ACPManager } from '@onething/backend/acp'
import type {
  ACPPermissionBridge,
  ACPPermissionOptionInfo,
  ACPPermissionRequestContext,
} from '@onething/backend/acp'

vi.mock('@onething/backend/permission/message-anchor', () => ({
  resolvePermissionMessageAnchor: (_sessionId: string, preferred?: string) => preferred ?? '',
}))

const { acpDecisionFor, choicesFromAcpOptions, registerACPPermissionBridge } = await import('../permission-bridge.js')

const ALL_OPTIONS: ACPPermissionOptionInfo[] = [
  { optionId: 'o-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'o-always', name: 'Always', kind: 'allow_always' },
  { optionId: 'o-reject', name: 'No', kind: 'reject_once' },
  { optionId: 'o-reject-always', name: 'Never', kind: 'reject_always' },
]

function context(overrides: Partial<ACPPermissionRequestContext> = {}): ACPPermissionRequestContext {
  return {
    agentId: 'kimi',
    agentName: 'Kimi',
    localSessionId: 'session-1',
    messageId: 'msg-7',
    cwd: '/tmp/acp-project',
    toolCall: { toolCallId: 'tc-1', title: 'rm build', kind: 'execute', rawInput: { command: 'rm -rf ./build' } },
    options: ALL_OPTIONS,
    ...overrides,
  }
}

describe('acpDecisionFor: 我们的答案 → agent 的 optionId', () => {
  const allow = (answers?: Array<'once' | 'session' | 'workdir' | 'always'>) =>
    acpDecisionFor(Decision.allow(answers ? { asked: true, answers } : {}), ALL_OPTIONS)

  it.each([
    ['once', 'o-once'],
    ['session', 'o-once'],
    ['workdir', 'o-once'],
    ['always', 'o-always'],
  ] as const)('%s → %s', (answer, optionId) => {
    expect(allow([answer])).toEqual({ behavior: 'select', optionId })
  })

  it('没问人(grant 命中 / 白名单)→ allow_once', () => {
    expect(allow()).toEqual({ behavior: 'select', optionId: 'o-once' })
  })

  it('多条效果里只要有一条不是 always,就只答 allow_once', () => {
    expect(allow(['always', 'once'])).toEqual({ behavior: 'select', optionId: 'o-once' })
    expect(allow(['always', 'always'])).toEqual({ behavior: 'select', optionId: 'o-always' })
  })

  it('reject → reject_once;reject-always → reject_always', () => {
    expect(acpDecisionFor(Decision.deny('no', { byUser: true }), ALL_OPTIONS))
      .toEqual({ behavior: 'select', optionId: 'o-reject' })
    expect(acpDecisionFor(Decision.deny('no', { byUser: true, rejectAlways: true }), ALL_OPTIONS))
      .toEqual({ behavior: 'select', optionId: 'o-reject-always' })
  })

  it('缺格:always 没有 allow_always 退 allow_once;没有 allow_once 答 cancel,绝不拿 always 顶', () => {
    const noAlways = ALL_OPTIONS.filter(option => option.kind !== 'allow_always')
    expect(acpDecisionFor(Decision.allow({ answers: ['always'] }), noAlways))
      .toEqual({ behavior: 'select', optionId: 'o-once' })
    const onlyAlways = ALL_OPTIONS.filter(option => option.kind !== 'allow_once')
    expect(acpDecisionFor(Decision.allow({ answers: ['once'] }), onlyAlways)).toEqual({ behavior: 'cancel' })
  })

  it('缺格:reject-always 没有 reject_always 退 reject_once;一个拒绝格都没有交回客户端缺省拒', () => {
    const noRejectAlways = ALL_OPTIONS.filter(option => option.kind !== 'reject_always')
    expect(acpDecisionFor(Decision.deny('no', { rejectAlways: true }), noRejectAlways))
      .toEqual({ behavior: 'select', optionId: 'o-reject' })
    const noReject = ALL_OPTIONS.filter(option => !option.kind.startsWith('reject'))
    expect(acpDecisionFor(Decision.deny('no'), noReject)).toEqual({ behavior: 'reject' })
  })
})

describe('choicesFromAcpOptions', () => {
  it('四种 kind 原样上卡,label 用 agent 的原话,认不出的不画', () => {
    expect(choicesFromAcpOptions([...ALL_OPTIONS, { optionId: 'x', name: '?', kind: 'something_else' }])).toEqual([
      { id: 'o-once', kind: 'once', label: 'Yes' },
      { id: 'o-always', kind: 'always', label: 'Always' },
      { id: 'o-reject', kind: 'reject', label: 'No' },
      { id: 'o-reject-always', kind: 'reject-always', label: 'Never' },
    ])
  })
})

describe('registerACPPermissionBridge', () => {
  let decide: ReturnType<typeof vi.fn<(intent: Intent, invocation: Invocation) => Promise<Decision>>>
  let dispose: () => void
  let bridge: ACPPermissionBridge

  beforeEach(() => {
    decide = vi.fn(async () => Decision.allow())
    const authorizer: Authorizer = { decide: (intent, invocation) => decide(intent, invocation) }
    dispose = registerACPPermissionBridge({ authorizer: () => authorizer })
    const registered = ACPManager.getPermissionBridge()
    if (!registered) throw new Error('bridge not registered')
    bridge = registered
  })

  afterEach(() => dispose())

  it('execute rm -rf → bash 效果;choices = agent 的 options;messageId / cwd 透传', async () => {
    decide.mockResolvedValueOnce(Decision.allow({ asked: true, answers: ['once'] }))
    await expect(bridge(context())).resolves.toEqual({ behavior: 'select', optionId: 'o-once' })

    const [intent, invocation] = decide.mock.calls[0]!
    expect(intent.effects).toEqual([expect.objectContaining({ kind: 'bash', resources: ['rm *'] })])
    expect(intent.preview?.title).toBe('Kimi: rm build')
    expect(intent.preview?.choices).toEqual(choicesFromAcpOptions(ALL_OPTIONS))
    expect(intent.preview?.metadata).toMatchObject({ agentId: 'kimi', agentName: 'Kimi', toolKind: 'execute' })
    expect(invocation).toMatchObject({ callId: 'tc-1', sessionId: 'session-1', messageId: 'msg-7', cwd: '/tmp/acp-project' })
  })

  it('agent 没给 options 时不带 choices(卡回到今天的五钮)', async () => {
    await bridge(context({ options: [] }))
    expect(decide.mock.calls[0]![0].preview?.choices).toBeUndefined()
  })

  it('always → allow_always;授权者拒 → reject_once', async () => {
    decide.mockResolvedValueOnce(Decision.allow({ asked: true, answers: ['always'] }))
    await expect(bridge(context())).resolves.toEqual({ behavior: 'select', optionId: 'o-always' })
    decide.mockResolvedValueOnce(Decision.deny('no', { asked: true, byUser: true }))
    await expect(bridge(context())).resolves.toEqual({ behavior: 'select', optionId: 'o-reject' })
  })

  it('reject-always → reject_always,且同会话同一件事下次不再上卡、直接拒;别的会话照问', async () => {
    decide.mockResolvedValueOnce(Decision.deny('no', { asked: true, byUser: true, rejectAlways: true }))
    await expect(bridge(context())).resolves.toEqual({ behavior: 'select', optionId: 'o-reject-always' })

    await expect(bridge(context())).resolves.toEqual({ behavior: 'select', optionId: 'o-reject' })
    expect(decide).toHaveBeenCalledTimes(1)

    await bridge(context({ localSessionId: 'session-2' }))
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it('没有归属会话 → reject;授权者炸了 → reject', async () => {
    await expect(bridge(context({ localSessionId: undefined }))).resolves.toEqual({ behavior: 'reject' })
    decide.mockRejectedValueOnce(new Error('hard deny'))
    await expect(bridge(context())).resolves.toEqual({ behavior: 'reject' })
  })

  it("A3-b:unattended: 'allow' 的 agent 在桥里前置放行,不进 ask", async () => {
    await expect(bridge(context({ unattended: 'allow' }))).resolves.toEqual({ behavior: 'allow' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('A3-b:文件桥与终端桥同批挂上、同批摘掉(只摘自己挂的那几只)', () => {
    expect(ACPManager.getFsBridge()).toBeDefined()
    expect(ACPManager.getTerminalBridge()).toBeDefined()
    dispose()
    expect(ACPManager.getPermissionBridge()).toBeUndefined()
    expect(ACPManager.getFsBridge()).toBeUndefined()
    expect(ACPManager.getTerminalBridge()).toBeUndefined()
    dispose = () => {}
  })
})
