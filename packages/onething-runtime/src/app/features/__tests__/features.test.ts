/**
 * 可逆注册基座的契约（内核收缩 K0，
 * docs/design/kernel-shrink-builtin-plugins-2026-08.md §1 D2）。
 *
 * 这一层的全部价值就是「注册可撤销」，所以这份测试钉的不是「注册成功」，而是
 * **撤销面**：逆序、幂等、mount 抛错时的回滚、以及重复 id 的硬拒。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineRouter } from '@onething/core/ipc'
import { dispatchRpc, hasRpcDomain, resetRpcRegistryForTests } from '../../rpc/registry.js'
import {
  dumpFeatures,
  hasFeature,
  mountFeature,
  resetFeaturesForTests,
} from '../index.js'

type ProbeRoutes = {
  echo: { input: { value: string }; output: { value: string } }
}

const probeRouter = defineRouter<ProbeRoutes>('feature-probe', ['echo'])
const probeHandlers = {
  async echo(input: { value: string }) {
    return { value: input.value.toUpperCase() }
  },
}

describe('feature registry', () => {
  beforeEach(() => {
    resetFeaturesForTests()
    resetRpcRegistryForTests()
  })

  it('mounts a feature and unmounts every registration it made', async () => {
    const unmount = await mountFeature({
      id: 'probe',
      mount: ctx => { ctx.registerRpcDomain(probeRouter, probeHandlers) },
    })

    expect(hasFeature('probe')).toBe(true)
    expect(hasRpcDomain('feature-probe')).toBe(true)
    await expect(dispatchRpc({ domain: 'feature-probe', method: 'echo', payload: { value: 'hi' } }))
      .resolves.toEqual({ ok: true, data: { value: 'HI' } })

    await unmount()

    expect(hasFeature('probe')).toBe(false)
    expect(hasRpcDomain('feature-probe')).toBe(false)
  })

  it('rejects a duplicate feature id instead of last-writer-wins', async () => {
    await mountFeature({ id: 'probe', mount: () => {} })

    await expect(mountFeature({ id: 'probe', mount: () => {} }))
      .rejects.toThrow(/already mounted/)
  })

  it('lets an id be mounted again after its unmount', async () => {
    const unmount = await mountFeature({ id: 'probe', mount: () => {} })
    await unmount()

    await expect(mountFeature({ id: 'probe', mount: () => {} })).resolves.toBeTypeOf('function')
  })

  it('unwinds registrations in reverse order (last registered disposes first)', async () => {
    const order: string[] = []
    const unmount = await mountFeature({
      id: 'probe',
      mount: ctx => {
        ctx.registerDisposer(() => { order.push('first') })
        ctx.registerDisposer(() => { order.push('second') })
        ctx.registerDisposer(() => { order.push('third') })
      },
    })

    await unmount()

    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('registerDisposer is the escape hatch for an already-reversible side effect', async () => {
    const stopTimer = vi.fn()
    const unmount = await mountFeature({
      id: 'probe',
      mount: ctx => {
        const dispose = ctx.registerDisposer(stopTimer)
        expect(dispose).toBeTypeOf('function')
      },
    })

    expect(stopTimer).not.toHaveBeenCalled()
    await unmount()
    expect(stopTimer).toHaveBeenCalledTimes(1)
  })

  it('a per-registration disposer is idempotent — unmount does not run it twice', async () => {
    const dispose = vi.fn()
    let early: (() => void | Promise<void>) | undefined
    const unmount = await mountFeature({
      id: 'probe',
      mount: ctx => { early = ctx.registerDisposer(dispose) },
    })

    await early?.()
    expect(dispose).toHaveBeenCalledTimes(1)

    await unmount()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('unmount is idempotent and a stale unmount never evicts a later mount', async () => {
    const stale = await mountFeature({ id: 'probe', mount: () => {} })
    await stale()

    const live = vi.fn()
    await mountFeature({ id: 'probe', mount: ctx => { ctx.registerDisposer(live) } })

    await stale()

    expect(hasFeature('probe')).toBe(true)
    expect(live).not.toHaveBeenCalled()
  })

  it('a failing mount rolls back its partial registrations and leaves the table clean', async () => {
    const rollback = vi.fn()

    await expect(mountFeature({
      id: 'probe',
      mount: ctx => {
        ctx.registerRpcDomain(probeRouter, probeHandlers)
        ctx.registerDisposer(rollback)
        throw new Error('mount exploded')
      },
    })).rejects.toThrow('mount exploded')

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(hasFeature('probe')).toBe(false)
    expect(hasRpcDomain('feature-probe')).toBe(false)
  })

  it('one throwing disposer does not strand the rest, and the error is not swallowed', async () => {
    const after = vi.fn()
    const unmount = await mountFeature({
      id: 'probe',
      mount: ctx => {
        ctx.registerDisposer(after)
        ctx.registerDisposer(() => { throw new Error('dispose exploded') })
      },
    })

    await expect(unmount()).rejects.toThrow(AggregateError)
    // 逆序:抛错的那一项先跑,后面的仍然跑到了。
    expect(after).toHaveBeenCalledTimes(1)
    expect(hasFeature('probe')).toBe(false)
  })

  it('dumpFeatures reports mounted features, their counts and their rpc domains', async () => {
    await mountFeature({
      id: 'probe',
      mount: ctx => {
        ctx.registerRpcDomain(probeRouter, probeHandlers)
        ctx.registerDisposer(() => {})
      },
    })
    await mountFeature({ id: 'plain', mount: () => {} })

    expect(dumpFeatures()).toEqual([
      { id: 'probe', registrations: { rpcDomain: 1, disposer: 1 }, rpcDomains: ['feature-probe'] },
      { id: 'plain', registrations: { rpcDomain: 0, disposer: 0 }, rpcDomains: [] },
    ])
  })

  it('dumpFeatures drops a registration that was disposed individually', async () => {
    let dropRpc: (() => void | Promise<void>) | undefined
    await mountFeature({
      id: 'probe',
      mount: ctx => {
        dropRpc = ctx.registerRpcDomain(probeRouter, probeHandlers)
        ctx.registerDisposer(() => {})
      },
    })

    await dropRpc?.()

    expect(dumpFeatures()).toEqual([
      { id: 'probe', registrations: { rpcDomain: 0, disposer: 1 }, rpcDomains: [] },
    ])
  })
})
