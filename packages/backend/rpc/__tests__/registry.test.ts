/**
 * The dispatch contract for the generic RPC channel (主线 T0).
 *
 * Every host adapter is one line over `dispatchRpc`, so this file is where the
 * whole error taxonomy is pinned: what a missing domain / method / throwing
 * handler produces, and that nothing ever rejects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineRouter } from '@onething/core/ipc'
import { RPC_ERROR_CODES } from '@shared/ipc/rpc.js'
import {
  dispatchRpc,
  hasRpcDomain,
  registerRouterHandlers,
  resetRpcRegistryForTests,
} from '../registry.js'

type ProbeRoutes = {
  echo: { input: { value: string }; output: { value: string } }
  boom: { input: void; output: void }
}

const probeRouter = defineRouter<ProbeRoutes>('probe', ['echo', 'boom'])

function registerProbe(): () => void {
  return registerRouterHandlers(probeRouter, {
    async echo(input) {
      return { value: input.value.toUpperCase() }
    },
    async boom() {
      throw new Error('handler exploded')
    },
  })
}

describe('rpc registry', () => {
  beforeEach(() => {
    resetRpcRegistryForTests()
  })

  it('dispatches to the registered handler and returns ok:true', async () => {
    registerProbe()

    await expect(dispatchRpc({ domain: 'probe', method: 'echo', payload: { value: 'hi' } }))
      .resolves.toEqual({ ok: true, data: { value: 'HI' } })
  })

  it('normalizes an undefined handler result to null so JSON survives it', async () => {
    registerRouterHandlers(defineRouter<{ noop: { input: void; output: void } }>('void-domain', ['noop']), {
      async noop() {},
    })

    await expect(dispatchRpc({ domain: 'void-domain', method: 'noop', payload: undefined }))
      .resolves.toEqual({ ok: true, data: null })
  })

  it('reports an unregistered domain as UNKNOWN_DOMAIN', async () => {
    const response = await dispatchRpc({ domain: 'nope', method: 'echo', payload: {} })

    expect(response).toEqual({
      ok: false,
      error: { message: 'Unknown RPC domain "nope"', code: RPC_ERROR_CODES.UNKNOWN_DOMAIN },
    })
  })

  it('reports a method outside router.methods as UNKNOWN_METHOD', async () => {
    registerProbe()

    const response = await dispatchRpc({ domain: 'probe', method: 'notAMethod', payload: {} })

    expect(response).toEqual({
      ok: false,
      error: { message: 'Unknown RPC method "probe.notAMethod"', code: RPC_ERROR_CODES.UNKNOWN_METHOD },
    })
  })

  it('rejects a malformed envelope without touching any handler', async () => {
    registerProbe()

    await expect(dispatchRpc({ domain: '', method: 'echo', payload: {} })).resolves.toEqual({
      ok: false,
      error: {
        message: 'RPC request must carry a domain and a method',
        code: RPC_ERROR_CODES.BAD_REQUEST,
      },
    })
  })

  it('turns a throwing handler into ok:false with the message only (no stack)', async () => {
    registerProbe()

    const response = await dispatchRpc({ domain: 'probe', method: 'boom', payload: undefined })

    expect(response).toEqual({ ok: false, error: { message: 'handler exploded' } })
    expect(JSON.stringify(response)).not.toContain('registry.test')
  })

  it('throws when a domain is registered twice', () => {
    registerProbe()

    expect(() => registerProbe()).toThrow(/already registered/)
  })

  it('lets a domain be re-registered after its disposer runs', () => {
    const dispose = registerProbe()
    dispose()

    expect(hasRpcDomain('probe')).toBe(false)
    expect(() => registerProbe()).not.toThrow()
  })

  it('stops dispatching after unregister', async () => {
    const dispose = registerProbe()
    dispose()

    await expect(dispatchRpc({ domain: 'probe', method: 'echo', payload: { value: 'hi' } }))
      .resolves.toEqual({
        ok: false,
        error: { message: 'Unknown RPC domain "probe"', code: RPC_ERROR_CODES.UNKNOWN_DOMAIN },
      })
  })

  it('a stale disposer does not evict a later registration of the same domain', async () => {
    const stale = registerProbe()
    stale()
    const handler = vi.fn(async () => ({ value: 'second' }))
    registerRouterHandlers(probeRouter, { echo: handler, boom: async () => {} })

    stale()

    await expect(dispatchRpc({ domain: 'probe', method: 'echo', payload: { value: 'x' } }))
      .resolves.toEqual({ ok: true, data: { value: 'second' } })
  })
})
