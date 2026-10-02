import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VariableRegistry } from '../registry.js'
import {
  VariableError,
  type ContextVariable,
  type SetInput,
  type VariableContext,
  type VariableProvider,
} from '../types.js'

const ctx: VariableContext = { sessionId: 'sess-a' }

function provider(options: {
  id: string
  priority?: number
  vars?: ContextVariable[]
  claims?: (name: string) => boolean
  set?: VariableProvider['set'] | null
  delete?: VariableProvider['delete'] | null
  onExternalChange?: VariableProvider['onExternalChange']
}): VariableProvider {
  const store = new Map<string, ContextVariable>()
  for (const variable of options.vars ?? []) store.set(variable.name, variable)

  const result: VariableProvider = {
    id: options.id,
    priority: options.priority,
    list: () => [...store.values()],
    claims: options.claims ?? (() => true),
  }
  if (options.set !== undefined) {
    if (options.set) result.set = options.set
  } else {
    result.set = (_ctx: VariableContext, input: SetInput) => {
      const next: ContextVariable = {
        name: input.name,
        value: input.value,
        description: input.description,
      }
      store.set(input.name, next)
      return next
    }
  }
  if (options.delete !== undefined) {
    if (options.delete) result.delete = options.delete
  } else {
    result.delete = (_ctx: VariableContext, name: string) => {
      store.delete(name)
    }
  }
  if (options.onExternalChange) result.onExternalChange = options.onExternalChange
  return result
}

let registry: VariableRegistry

beforeEach(() => {
  registry = new VariableRegistry()
})

describe('VariableRegistry', () => {
  it('orders providers by priority and rejects duplicate ids', async () => {
    const order: string[] = []
    registry.register(provider({
      id: 'low',
      priority: 200,
      set: (_ctx, input) => {
        order.push('low')
        return { name: input.name, value: input.value }
      },
    }))
    registry.register(provider({
      id: 'high',
      priority: 50,
      set: (_ctx, input) => {
        order.push('high')
        return { name: input.name, value: input.value }
      },
    }))

    await registry.set(ctx, { name: 'topic', value: 'runtime' })

    expect(order).toEqual(['high'])
    expect(() => registry.register(provider({ id: 'high' }))).toThrowError(VariableError)
  })

  it('aggregates lists and rejects duplicate variable names', async () => {
    registry.register(provider({ id: 'a', vars: [{ name: 'a', value: '1' }] }))
    registry.register(provider({ id: 'b', vars: [{ name: 'b', value: '2' }] }))

    await expect(registry.list(ctx)).resolves.toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ])

    const conflict = new VariableRegistry()
    conflict.register(provider({ id: 'a', vars: [{ name: 'dup', value: '1' }] }))
    conflict.register(provider({ id: 'b', vars: [{ name: 'dup', value: '2' }] }))
    await expect(conflict.list(ctx)).rejects.toMatchObject({ code: 'PROVIDER_CONFLICT' })
  })

  it('validates writes before dispatch and reports missing or readonly providers', async () => {
    const setSpy = vi.fn()
    registry.register(provider({
      id: 'readonly',
      claims: name => name === 'locked',
      vars: [{ name: 'locked', value: '1', readonly: true }],
      set: null,
    }))
    registry.register(provider({
      id: 'writer',
      claims: name => name === 'topic',
      set: setSpy as unknown as VariableProvider['set'],
    }))

    await expect(registry.set(ctx, { name: '1bad', value: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_NAME' })
    expect(setSpy).not.toHaveBeenCalled()
    await expect(registry.set(ctx, { name: 'unknown', value: 'x' }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(registry.set(ctx, { name: 'locked', value: 'x' }))
      .rejects.toMatchObject({ code: 'READONLY' })
  })

  it('serializes writes per session and recovers after failures', async () => {
    let calls = 0
    let inFlight = 0
    let maxConcurrent = 0
    registry.register(provider({
      id: 'writer',
      set: async (_ctx, input) => {
        calls += 1
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        if (input.value === 'fail') throw new Error('boom')
        return { name: input.name, value: input.value }
      },
    }))

    await Promise.all([
      registry.set(ctx, { name: 'a', value: '1' }),
      registry.set(ctx, { name: 'b', value: '2' }),
    ])
    await expect(registry.set(ctx, { name: 'a', value: 'fail' })).rejects.toThrow('boom')
    await expect(registry.set(ctx, { name: 'a', value: 'ok' })).resolves.toEqual({ name: 'a', value: 'ok' })

    expect(calls).toBe(4)
    expect(maxConcurrent).toBe(1)
  })

  it('forwards external changes and unsubscribes on reset', async () => {
    const listeners = new Set<(ctx?: VariableContext) => void>()
    registry.register(provider({
      id: 'store',
      vars: [{ name: 'topic', value: 'one' }],
      onExternalChange: emit => {
        listeners.add(emit)
        return () => listeners.delete(emit)
      },
    }))

    const events: string[] = []
    registry.subscribe((eventCtx, snapshot) => {
      events.push(`${eventCtx.sessionId}:${snapshot.map(variable => variable.name).join(',')}`)
    })
    for (const listener of listeners) listener(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const listener of listeners) listener()

    expect(events).toEqual(['sess-a:topic', ':'])
    registry.reset()
    expect(listeners.size).toBe(0)
  })
})
