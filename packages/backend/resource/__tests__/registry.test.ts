/**
 * K0 —— 注册表(`docs/design/atom-2026-09.md` §2 不变量 3、§9 K0)。
 *
 * 每个用例自己 `new` 一张表 —— 这正是「注册表是类不是模块单例」买到的东西
 * (registry.ts 文件头):没有跨用例的残留要清。
 */

import { describe, expect, it, vi } from 'vitest'
import { ResourceSpecError } from '../contract.js'
import { ResourceRegistry, ResourceSchemeTakenError } from '../registry.js'
import type { ResourceSpec } from '../spec.js'

const anySchema = { type: 'object' }

function spec(scheme: string, overrides: Partial<ResourceSpec> = {}): ResourceSpec {
  return {
    scheme,
    title: scheme,
    reads: { get: { title: 'Get', query: anySchema, result: anySchema } },
    ops: { act: { title: 'Act', params: anySchema, effects: ['read'], home: 'core' } },
    events: { changed: { title: 'Changed', payload: anySchema } },
    ...overrides,
  }
}

describe('ResourceRegistry', () => {
  it('registers a spec and finds it by scheme', () => {
    const registry = new ResourceRegistry()
    registry.register(spec('demo'))
    expect(registry.has('demo')).toBe(true)
    expect(registry.get('demo')?.title).toBe('demo')
    expect(registry.has('fake')).toBe(false)
    expect(registry.get('fake')).toBeNull()
  })

  it('rejects an invalid spec before touching the table', () => {
    const registry = new ResourceRegistry()
    expect(() => registry.register({ ...spec('demo'), scheme: 'Demo' })).toThrow(ResourceSpecError)
    expect(registry.has('Demo')).toBe(false)
    expect(registry.list()).toHaveLength(0)
  })

  it('refuses a second provider for the same scheme, keeping the first', () => {
    const registry = new ResourceRegistry()
    registry.register(spec('demo'))
    const second = spec('demo', { title: 'Impostor' })
    expect(() => registry.register(second)).toThrow(ResourceSchemeTakenError)
    expect(registry.get('demo')?.title).toBe('demo')
    try {
      registry.register(second)
    } catch (error) {
      expect((error as ResourceSchemeTakenError).scheme).toBe('demo')
    }
  })

  it('returns an idempotent unregister that does not evict a later provider', () => {
    const registry = new ResourceRegistry()
    const dispose = registry.register(spec('demo'))
    dispose()
    expect(registry.has('demo')).toBe(false)
    // 第二次调用是空操作,不抛。
    expect(() => dispose()).not.toThrow()

    // 同一个 scheme 换了提供者之后,拿旧闭包再关一次不该把后来者摘掉。
    registry.register(spec('demo', { title: 'Second' }))
    dispose()
    expect(registry.get('demo')?.title).toBe('Second')
  })

  it('lists by scheme in lexicographic order regardless of registration order', () => {
    const registry = new ResourceRegistry()
    registry.register(spec('zeta'))
    registry.register(spec('alpha'))
    registry.register(spec('mid'))
    expect(registry.list().map(item => item.scheme)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('freezes what it hands out — the table cannot be rewritten after the fact', () => {
    const registry = new ResourceRegistry()
    const original = spec('demo')
    registry.register(original)
    const stored = registry.get('demo')!
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(registry.list())).toBe(true)
    // 交出去的就是登记的那一份(身份不分叉,见 registry.ts 文件头)。
    expect(stored).toBe(original)
    expect(() => {
      ;(stored as { title: string }).title = 'rewritten'
    }).toThrow(TypeError)
    expect(registry.get('demo')?.title).toBe('demo')
  })

  it('resolves an address to its spec plus the parsed ref', () => {
    const registry = new ResourceRegistry()
    registry.register(spec('demo'))
    expect(registry.resolve('demo:inbox/1')).toEqual({
      spec: registry.get('demo'),
      ref: { scheme: 'demo', path: 'inbox/1' },
    })
    // 语法不合 / 没人登记过这个 scheme,都是 null,不抛。
    expect(registry.resolve('demo')).toBeNull()
    expect(registry.resolve('demo:')).toBeNull()
    expect(registry.resolve('Demo:x')).toBeNull()
    expect(registry.resolve('fake:x')).toBeNull()
  })

  it('looks up an op and a read by address', () => {
    const registry = new ResourceRegistry()
    registry.register(spec('demo'))
    expect(registry.opOf('demo:1', 'act')?.title).toBe('Act')
    expect(registry.readOf('demo:1', 'get')?.title).toBe('Get')
    expect(registry.opOf('demo:1', 'nope')).toBeNull()
    expect(registry.readOf('demo:1', 'nope')).toBeNull()
    expect(registry.opOf('fake:1', 'act')).toBeNull()
    expect(registry.readOf('bad ref', 'get')).toBeNull()
  })

  it('never answers with something inherited from Object.prototype', () => {
    // op 名会直接来自模型的工具参数与 deeplink,即外面。
    const registry = new ResourceRegistry()
    registry.register(spec('demo'))
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(registry.opOf('demo:1', name), name).toBeNull()
      expect(registry.readOf('demo:1', name), name).toBeNull()
    }
  })

  it('notifies subscribers on both register and unregister, and stops after unsubscribe', () => {
    const registry = new ResourceRegistry()
    const listener = vi.fn()
    const stop = registry.subscribe(listener)

    const dispose = registry.register(spec('demo'))
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    // 空操作的注销不通知 —— 表没变。
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    stop()
    registry.register(spec('fake'))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(() => stop()).not.toThrow()
  })

  it('lets a listener unsubscribe from inside its own callback', () => {
    const registry = new ResourceRegistry()
    const seen: string[] = []
    const stopA = registry.subscribe(() => {
      seen.push('a')
      stopA()
    })
    registry.subscribe(() => seen.push('b'))

    registry.register(spec('demo'))
    // b 没有被 a 的退订挤掉(notify 遍历的是快照)。
    expect(seen).toEqual(['a', 'b'])
    registry.register(spec('fake'))
    expect(seen).toEqual(['a', 'b', 'b'])
  })

  it('does not notify when a registration was rejected', () => {
    const registry = new ResourceRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    expect(() => registry.register({ ...spec('demo'), title: '' })).toThrow(ResourceSpecError)
    registry.register(spec('demo'))
    expect(() => registry.register(spec('demo'))).toThrow(ResourceSchemeTakenError)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
