/**
 * 宿主壳路由派发表 —— 结构债 P4 终态批 A1-a。
 *
 * 钉的是这张表**作为一条通道**的语义,和装配层那张(`packages/backend/rpc/registry.ts`)
 * 逐条对称:方法白名单、never-reject、三个结构化错误码、可逆注册、以及
 * **context 由宿主盖章**这一条(`callerId` 原样透传给处理者)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineRouter } from '@onething/core/ipc'
import { RPC_ERROR_CODES } from '@shared/ipc/rpc.js'
import {
  dispatchShell,
  hasShellDomain,
  registerShellDomain,
  resetShellRegistryForTests,
  type ShellDispatchContext,
} from '../shell-registry.js'

type ProbeRoutes = {
  echo: { input: { value: string }; output: { value: string } }
  whoAsked: { input: Record<string, never>; output: { callerId?: number } }
  boom: { input: Record<string, never>; output: never }
}

const probeRouter = defineRouter<ProbeRoutes>('probe', ['echo', 'whoAsked', 'boom'])

function registerProbe() {
  return registerShellDomain(probeRouter, {
    echo: async input => ({ value: input.value }),
    whoAsked: async (_input, context?: ShellDispatchContext) => ({ callerId: context?.callerId }),
    boom: async () => {
      throw new Error('handler exploded')
    },
  })
}

afterEach(() => {
  resetShellRegistryForTests()
})

describe('shell registry', () => {
  it('registers nothing on import — the table starts empty', () => {
    expect(hasShellDomain('probe')).toBe(false)
  })

  it('dispatches to a registered handler and wraps the result', async () => {
    registerProbe()
    expect(hasShellDomain('probe')).toBe(true)
    await expect(dispatchShell({ domain: 'probe', method: 'echo', payload: { value: 'hi' } }))
      .resolves.toEqual({ ok: true, data: { value: 'hi' } })
  })

  it('hands the host-minted callerId to the handler, and never reads it off the envelope', async () => {
    registerProbe()
    await expect(dispatchShell(
      { domain: 'probe', method: 'whoAsked', payload: {} },
      { callerId: 42 },
    )).resolves.toEqual({ ok: true, data: { callerId: 42 } })

    // 信封里塞 callerId 一点用也没有 —— `RpcRequest` 上根本没有这个字段。
    await expect(dispatchShell({
      domain: 'probe',
      method: 'whoAsked',
      payload: {},
      // @ts-expect-error 故意越过契约:这正是这条断言要证明的事
      callerId: 99,
    })).resolves.toEqual({ ok: true, data: { callerId: undefined } })
  })

  it('answers an unknown domain / method with a structured code instead of throwing', async () => {
    registerProbe()
    await expect(dispatchShell({ domain: 'nope', method: 'echo', payload: {} })).resolves.toEqual({
      ok: false,
      error: { code: RPC_ERROR_CODES.UNKNOWN_DOMAIN, message: 'Unknown shell domain "nope"' },
    })
    await expect(dispatchShell({ domain: 'probe', method: 'nope', payload: {} })).resolves.toEqual({
      ok: false,
      error: { code: RPC_ERROR_CODES.UNKNOWN_METHOD, message: 'Unknown shell method "probe.nope"' },
    })
  })

  it('rejects a malformed envelope with BAD_REQUEST', async () => {
    await expect(dispatchShell({ domain: '', method: '', payload: null })).resolves.toEqual({
      ok: false,
      error: {
        code: RPC_ERROR_CODES.BAD_REQUEST,
        message: 'Shell request must carry a domain and a method',
      },
    })
  })

  it('never rejects: a throwing handler becomes { ok:false } carrying only the message', async () => {
    registerProbe()
    const response = await dispatchShell({ domain: 'probe', method: 'boom', payload: {} })
    expect(response).toEqual({ ok: false, error: { message: 'handler exploded' } })
    // 没有 code:带 code 只在"请求压根没到处理者"时出现。
    expect((response as { error: { code?: string } }).error.code).toBeUndefined()
  })

  it('normalizes an undefined handler result to null (structured clone / JSON safe)', async () => {
    type VoidRoutes = { fire: { input: Record<string, never>; output: void } }
    const voidRouter = defineRouter<VoidRoutes>('void-probe', ['fire'])
    registerShellDomain(voidRouter, { fire: async () => undefined })
    await expect(dispatchShell({ domain: 'void-probe', method: 'fire', payload: {} }))
      .resolves.toEqual({ ok: true, data: null })
  })

  it('refuses a duplicate registration rather than silently keeping one of two implementations', () => {
    registerProbe()
    expect(() => registerProbe()).toThrow(/already registered/)
  })

  it('unregisters reversibly, and a stale disposer does not evict the new owner', () => {
    const disposeFirst = registerProbe()
    disposeFirst()
    expect(hasShellDomain('probe')).toBe(false)

    registerProbe()
    disposeFirst()
    expect(hasShellDomain('probe')).toBe(true)
  })

  it('only exposes the router\'s own methods — an unlisted handler key never runs', async () => {
    registerShellDomain(probeRouter, {
      echo: async input => ({ value: input.value }),
      whoAsked: async () => ({}),
      boom: async () => {
        throw new Error('x')
      },
      // @ts-expect-error 契约外的方法:注册表按 router.methods 绑,它进不去表
      sneak: vi.fn(),
    })
    await expect(dispatchShell({ domain: 'probe', method: 'sneak', payload: {} })).resolves.toEqual({
      ok: false,
      error: { code: RPC_ERROR_CODES.UNKNOWN_METHOD, message: 'Unknown shell method "probe.sneak"' },
    })
  })
})
