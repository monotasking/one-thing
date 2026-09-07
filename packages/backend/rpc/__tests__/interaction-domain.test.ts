/**
 * interaction 域,端到端穿过 dispatcher(结构债 P4c 第九批)。
 *
 * 接的是被删掉的两处转发的测试位:`apps/electron/src/ipc/interaction.ts` 的工厂
 * (连同 `__tests__/interaction.test.ts`)与 `@main/ipc/interaction.ts` 的壳适配。
 * 值得钉的是:
 *  - 两条方法穿过 dispatcher 到内核,`getPending` 收的是**单 id 包对象**;
 *  - **通道亲和的 channel 由宿主盖章**:桌面恒 `'ipc'`;
 *  - http 上**认领那次提问自己的 targetChannel**(找不到就退回 `'ipc'`,让内核
 *    自己按「没有待答项」如实拒绝);
 *  - 已结算 / 不存在的提问回的是结构化失败,不是抛错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '@onething/core/events'
import { Interaction } from '@onething/core/interaction'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'
import { interactionRouter } from '@shared/ipc/interaction.js'

const IPC: RpcDispatchContext = { transport: 'ipc' }
const HTTP: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'local-user',
  workspaceId: 'default',
  sandboxRoot: '/sandbox/alice/w1',
}

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

describe('interaction RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    const [registry, domain] = await Promise.all([
      import('../registry.js'),
      import('../domains/interaction.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = registry.registerRouterHandlers(interactionRouter, domain.interactionRpcHandlers)
    Interaction.initialize(new EventBus(), () => 'ipc')
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
    Interaction.shutdown()
    vi.restoreAllMocks()
  })

  const call = (method: string, payload: unknown, context: RpcDispatchContext) =>
    dispatchRpc({ domain: 'interaction', method, payload }, context)

  function ask(sessionId: string, toolCallId?: string) {
    return Interaction.ask({
      sessionId,
      ...(toolCallId ? { toolCallId } : {}),
      origin: 'host-tool',
      questions: [{ id: 'q1', question: '继续?', options: [{ label: '好' }, { label: '不' }] }],
      timeoutMs: 60_000,
    })
  }

  it('reads the pending table through a single-id envelope', async () => {
    const settled = ask('s1', 't1')
    const data = unwrap(await call('getPending', { sessionId: 's1' }, IPC))
    expect(data.success).toBe(true)
    expect((data.pending as Array<{ toolCallId?: string }>).map(item => item.toolCallId))
      .toEqual(['t1'])

    unwrap(await call('respond', { sessionId: 's1', toolCallId: 't1', decline: true }, IPC))
    await settled
  })

  it('stamps the desktop channel itself and settles the ask', async () => {
    const settled = ask('s2', 't2')
    const data = unwrap(
      await call(
        'respond',
        { sessionId: 's2', toolCallId: 't2', answers: { q1: { selected: ['好'] } } },
        IPC,
      ),
    )
    expect(data).toEqual({ success: true })
    const answer = await settled
    expect(answer.outcome).toBe('answered')
  })

  it('adopts the ask targetChannel over http instead of trusting the request', async () => {
    // 引擎把这个会话钉在 'gateway' 上 —— 桌面那句写死的 'ipc' 会被内核以
    // 「通道不对」拒收,而 http 分叉认领提问自己的通道,所以答得进去。
    Interaction.shutdown()
    Interaction.initialize(new EventBus(), () => 'gateway')
    const settled = ask('s3', 't3')

    const wrongChannel = unwrap(
      await call('respond', { sessionId: 's3', toolCallId: 't3', decline: true }, IPC),
    )
    expect(wrongChannel).toEqual({
      success: false,
      error: 'No pending interaction for this response',
    })

    const adopted = unwrap(
      await call('respond', { sessionId: 's3', toolCallId: 't3', decline: true }, HTTP),
    )
    expect(adopted).toEqual({ success: true })
    expect((await settled).outcome).toBe('declined')
  })

  it('answers a stale click structurally rather than throwing', async () => {
    const data = unwrap(
      await call('respond', { sessionId: 'ghost', interactionId: 'nope', decline: true }, IPC),
    )
    expect(data).toEqual({
      success: false,
      error: 'No pending interaction for this response',
    })
  })

  it('keeps only the two router methods on the allowlist', async () => {
    const response = await dispatchRpc(
      { domain: 'interaction', method: 'cancelEverything', payload: {} },
      IPC,
    )
    expect(response.ok).toBe(false)
  })
})
// Adapter fixtures explicitly belong to the local operator on both transports.
vi.mock('../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({ findMeta: () => ({}) }) }
})
