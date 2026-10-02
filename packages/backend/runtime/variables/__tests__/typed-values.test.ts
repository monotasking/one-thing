import { beforeEach, describe, expect, it } from 'vitest'
import { SessionStoreProvider } from '../providers/session-store.js'
import { VariableRegistry } from '../registry.js'
import {
  appendTypedValue,
  normalizeTypedValue,
  removeTypedValue,
  typedValueForAppend,
} from '../typed-values.js'
import { type ContextVariable, type VariableContext } from '../types.js'

describe('normalizeTypedValue', () => {
  it('string passes through unchanged', () => {
    expect(normalizeTypedValue('string', '  raw text ')).toBe('  raw text ')
  })

  it('number accepts decimals and normalizes', () => {
    expect(normalizeTypedValue('number', '1.50')).toBe('1.5')
    expect(normalizeTypedValue('number', ' -0.25 ')).toBe('-0.25')
    expect(normalizeTypedValue('number', '1e3')).toBe('1000')
  })

  it('number rejects non-finite and empty values', () => {
    for (const bad of ['abc', '', 'NaN', 'Infinity', '1/2']) {
      expect(() => normalizeTypedValue('number', bad)).toThrowError(/number|empty/i)
    }
  })

  it('bool normalizes case and rejects other words', () => {
    expect(normalizeTypedValue('bool', ' True ')).toBe('true')
    expect(normalizeTypedValue('bool', 'false')).toBe('false')
    expect(() => normalizeTypedValue('bool', 'yes')).toThrowError(/true.*false/)
  })

  it('list requires a JSON array and compacts it', () => {
    expect(normalizeTypedValue('list', ' [1, "a", {"k": 2}] ')).toBe('[1,"a",{"k":2}]')
    expect(() => normalizeTypedValue('list', '{"a":1}')).toThrowError(/array/)
    expect(() => normalizeTypedValue('list', 'not json')).toThrowError(/JSON/)
  })

  it('set dedupes elements preserving first occurrence', () => {
    expect(normalizeTypedValue('set', '[1, 2, 1, "1", 2]')).toBe('[1,2,"1"]')
  })

  it('map requires a JSON object', () => {
    expect(normalizeTypedValue('map', '{"b": 1, "a": 2}')).toBe('{"b":1,"a":2}')
    expect(() => normalizeTypedValue('map', '[1]')).toThrowError(/object/)
    expect(() => normalizeTypedValue('map', 'null')).toThrowError(/object/)
  })
})

describe('appendTypedValue / removeTypedValue', () => {
  it('list append pushes; plain words need no quoting', () => {
    expect(appendTypedValue('list', '["a"]', 'b')).toBe('["a","b"]')
    expect(appendTypedValue('list', '[]', '5')).toBe('[5]')
    expect(appendTypedValue('list', '[]', '{"k":1}')).toBe('[{"k":1}]')
  })

  it('set append is idempotent', () => {
    expect(appendTypedValue('set', '["a"]', 'a')).toBe('["a"]')
    expect(appendTypedValue('set', '["a"]', 'b')).toBe('["a","b"]')
  })

  it('map append merges an object and rejects non-objects', () => {
    expect(appendTypedValue('map', '{"a":1}', '{"b":2}')).toBe('{"a":1,"b":2}')
    expect(appendTypedValue('map', '{"a":1}', '{"a":9}')).toBe('{"a":9}')
    expect(() => appendTypedValue('map', '{}', 'plain')).toThrowError(/JSON object/)
  })

  it('scalar append is rejected with guidance', () => {
    expect(() => appendTypedValue('number', '1', '2')).toThrowError(/list, set and map/)
  })

  it('list remove drops all equal elements; missing element is NOT_FOUND', () => {
    expect(removeTypedValue('list', '[1,2,1]', '1')).toBe('[2]')
    expect(() => removeTypedValue('list', '[1]', '9')).toThrowError(/not found/i)
  })

  it('map remove deletes a key', () => {
    expect(removeTypedValue('map', '{"a":1,"b":2}', 'a')).toBe('{"b":2}')
    expect(() => removeTypedValue('map', '{"a":1}', 'z')).toThrowError(/Key not found/)
  })
})

describe('typed variables through a store provider', () => {
  const ctx: VariableContext = { sessionId: 'sess-a' }
  let stored: Map<string, ContextVariable[]>
  let registry: VariableRegistry

  beforeEach(() => {
    stored = new Map()
    registry = new VariableRegistry()
    registry.register(new SessionStoreProvider({
      read: sessionId => stored.get(sessionId) ?? [],
      write: (sessionId, variables) => {
        stored.set(sessionId, variables)
      },
    }))
  })

  it('set stamps the type and normalizes the value', async () => {
    const result = await registry.set(ctx, { name: 'budget', value: '10.50', type: 'number' })
    expect(result).toMatchObject({ type: 'number', value: '10.5' })
  })

  it('plain string variables store no type marker', async () => {
    const result = await registry.set(ctx, { name: 'note', value: 'hello' })
    expect(result.type).toBeUndefined()
  })

  it('type is sticky: untyped update validates against the existing type', async () => {
    await registry.set(ctx, { name: 'budget', value: '1', type: 'number' })
    await expect(registry.set(ctx, { name: 'budget', value: 'abc' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE' })
    const updated = await registry.set(ctx, { name: 'budget', value: '2' })
    expect(updated).toMatchObject({ type: 'number', value: '2' })
  })

  it('append creates a missing variable as a list and accumulates', async () => {
    await registry.append(ctx, { name: 'names', value: 'alice' })
    const result = await registry.append(ctx, { name: 'names', value: 'bob' })
    expect(result).toMatchObject({ type: 'list', value: '["alice","bob"]' })
  })

  it('append with type=set creates a set; remove drops elements', async () => {
    await registry.append(ctx, { name: 'tags', value: 'x', type: 'set' })
    await registry.append(ctx, { name: 'tags', value: 'x' })
    const afterAppend = await registry.get(ctx, 'tags')
    expect(afterAppend).toMatchObject({ type: 'set', value: '["x"]' })

    await registry.append(ctx, { name: 'tags', value: 'y' })
    const afterRemove = await registry.remove(ctx, { name: 'tags', value: 'x' })
    expect(afterRemove.value).toBe('["y"]')
  })

  it('description and state are sticky across value updates; "" clears', async () => {
    await registry.set(ctx, {
      name: 'deploy', value: 'staging', description: 'current deploy target', state: true,
    })
    const updated = await registry.set(ctx, { name: 'deploy', value: 'prod' })
    expect(updated).toMatchObject({
      value: 'prod', description: 'current deploy target', state: true,
    })

    const cleared = await registry.set(ctx, { name: 'deploy', value: 'prod', description: '' })
    expect(cleared.description).toBeUndefined()
  })

  it('append on a scalar variable is rejected', async () => {
    await registry.set(ctx, { name: 'flag', value: 'true', type: 'bool' })
    await expect(registry.append(ctx, { name: 'flag', value: 'x' }))
      .rejects.toMatchObject({ code: 'INVALID_VALUE' })
  })
})
