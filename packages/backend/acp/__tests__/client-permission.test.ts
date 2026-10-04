import { describe, expect, it, vi } from 'vitest'
import { ACPClient } from '../acp-client.js'
import type { ACPPermissionBridge, ACPPermissionRequestContext } from '../acp-types.js'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'

const config: ACPAgentConfig = {
  id: 'agent-1',
  name: 'Test Agent',
  enabled: true,
  command: '/bin/false',
}

const params = {
  sessionId: 'acp-session-1',
  toolCall: {
    toolCallId: 'tc-1',
    title: 'Run ls',
    kind: 'execute',
    rawInput: { command: 'ls' },
  },
  options: [
    { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
  ],
} as never

function requestPermission(client: ACPClient, request: unknown = params) {
  // 审批回调住在客户端的回调面上(`acp-client-app.ts`,2026-10-04 拆出)。
  return (client as unknown as {
    app: { requestPermission(input: unknown): Promise<{ outcome: { outcome: string; optionId?: string } }> }
  }).app.requestPermission(request)
}

describe('ACPClient permission bridge', () => {
  it('无桥缺省拒(A3-a,§8 拍点 2):不写 unattended 就答 reject_once', async () => {
    const client = new ACPClient(config)
    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    })
    const explicit = new ACPClient({ ...config, unattended: 'reject' })
    await expect(requestPermission(explicit)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    })
  })

  it('无桥且 agent 没给拒绝选项 → cancelled,绝不退到 options[0] 那格放行', async () => {
    const client = new ACPClient(config)
    await expect(requestPermission(client, {
      ...(params as object),
      options: [
        { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
      ],
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it("unattended: 'allow' 只答 allow_once —— allow_always 排在前面也不选它", async () => {
    const client = new ACPClient({ ...config, unattended: 'allow' })
    await expect(requestPermission(client, {
      ...(params as object),
      options: [
        { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
        { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
      ],
    })).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow' } })

    // 只给了 allow_always:宁可 cancelled,也不替用户在 agent 那边落一条长期规则。
    await expect(requestPermission(client, {
      ...(params as object),
      options: [{ optionId: 'opt-always', name: 'Always', kind: 'allow_always' }],
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('回合中止时还挂着的审批答 cancelled,不等桥的结局', async () => {
    const controller = new AbortController()
    const client = new ACPClient(config, {
      getPermissionBridge: () => () => new Promise<never>(() => {}),
    })
    const promptContexts = (client as unknown as {
      promptContexts: Map<string, { localSessionId: string; cwd: string; abortSignal?: AbortSignal }>
    }).promptContexts
    promptContexts.set('acp-session-1', { localSessionId: 'local-1', cwd: '/tmp/project', abortSignal: controller.signal })
    const pending = requestPermission(client)
    controller.abort()
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('把 toolCall.locations 递给桥(效果分析按路径判时先看它)', async () => {
    const contexts: ACPPermissionRequestContext[] = []
    const client = new ACPClient(config, {
      getPermissionBridge: () => async context => {
        contexts.push(context)
        return { behavior: 'cancel' }
      },
    })
    await requestPermission(client, {
      ...(params as object),
      toolCall: { toolCallId: 'tc-2', kind: 'edit', locations: [{ path: '/tmp/project/a.ts', line: 3 }] },
    })
    expect(contexts[0]?.toolCall?.locations).toEqual([{ path: '/tmp/project/a.ts', line: 3 }])
  })

  it('routes requests through the bridge and maps allow/reject/select/cancel decisions', async () => {
    const contexts: ACPPermissionRequestContext[] = []
    let decision: Awaited<ReturnType<ACPPermissionBridge>> = { behavior: 'allow' }
    const client = new ACPClient({ ...config, unattended: 'reject' }, {
      getPermissionBridge: () => async context => {
        contexts.push(context)
        return decision
      },
    })

    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow' },
    })
    expect(contexts[0]).toMatchObject({
      agentId: 'agent-1',
      agentName: 'Test Agent',
      toolCall: { toolCallId: 'tc-1', title: 'Run ls', kind: 'execute', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
      ],
    })

    decision = { behavior: 'reject' }
    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    })

    decision = { behavior: 'select', optionId: 'opt-reject' }
    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    })

    // Unknown optionId falls back to reject, never silent allow.
    decision = { behavior: 'select', optionId: 'missing' }
    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject' },
    })

    decision = { behavior: 'cancel' }
    await expect(requestPermission(client)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
  })

  it('rejects when the bridge throws, regardless of unattended allow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = new ACPClient({ ...config, unattended: 'allow' }, {
        getPermissionBridge: () => async () => {
          throw new Error('bridge exploded')
        },
      })
      await expect(requestPermission(client)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-reject' },
      })
    } finally {
      warn.mockRestore()
    }
  })

  it('attributes the request to the active prompt context when present', async () => {
    const contexts: ACPPermissionRequestContext[] = []
    const client = new ACPClient(config, {
      getPermissionBridge: () => async context => {
        contexts.push(context)
        return { behavior: 'allow' }
      },
    })
    const promptContexts = (client as unknown as {
      promptContexts: Map<string, { localSessionId: string; messageId?: string; cwd: string }>
    }).promptContexts
    promptContexts.set('acp-session-1', {
      localSessionId: 'local-1',
      messageId: 'msg-9',
      cwd: '/tmp/project',
    })

    await requestPermission(client)
    expect(contexts[0]).toMatchObject({
      localSessionId: 'local-1',
      messageId: 'msg-9',
      cwd: '/tmp/project',
    })
  })
})
