import { describe, expect, it } from 'vitest'
// 经 barrel 进来,因为内置那几种是 `types/index.ts` 在被 import 时登记的。
import { RefTypeRegistry, refTypes } from '../index.js'
import type { RefTypeSpec } from '../spec.js'

const drill: RefTypeSpec = {
  type: 'drill-a',
  summary: 'a drill',
  attrs: [{ name: 'id', required: true, description: 'the id' }],
  example: { type: 'drill-a', attrs: { id: '1' } },
}

describe('RefTypeRegistry', () => {
  it('keeps registration order', () => {
    const registry = new RefTypeRegistry()
    registry.register({ ...drill, type: 'z' })
    registry.register({ ...drill, type: 'a' })
    expect(registry.list().map(spec => spec.type)).toEqual(['z', 'a'])
  })

  it('refuses a duplicate type', () => {
    const registry = new RefTypeRegistry()
    registry.register(drill)
    expect(() => registry.register({ ...drill })).toThrow(/duplicate/)
  })

  it('hands back a disposer that only removes its own entry', () => {
    const registry = new RefTypeRegistry()
    const dispose = registry.register(drill)
    expect(registry.get('drill-a')).toBe(drill)

    dispose()
    expect(registry.get('drill-a')).toBeUndefined()

    const replacement = { ...drill }
    registry.register(replacement)
    dispose()
    expect(registry.get('drill-a')).toBe(replacement)
  })

  it('answers null for a type that has no plain-text opinion', () => {
    const registry = new RefTypeRegistry()
    registry.register(drill)
    expect(registry.describePlainText({ type: 'drill-a', attrs: {} })).toBeNull()
    expect(registry.describePlainText({ type: 'nobody', attrs: {} })).toBeNull()
  })

  it('carries the builtin table, and each entry projects its own wording', () => {
    expect(refTypes.list().length).toBeGreaterThanOrEqual(5)
    expect(
      refTypes.describePlainText({ type: 'command', attrs: { name: 'compact' } }),
    ).toBe('/compact')
    expect(
      refTypes.describePlainText({
        type: 'reference',
        attrs: { href: 'https://x/', title: 'X' },
      }),
    ).toBe('X (https://x/)')
    // A type without a `plainText` leaves the codec's default alone.
    expect(
      refTypes.describePlainText({ type: 'file', attrs: { path: '/a' } }),
    ).toBeNull()
  })
})
