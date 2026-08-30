import { describe, expect, it } from 'vitest'
import { BlockRegistry, isBlockRegistered, resolveBlock, type BlockDef } from '../registry'
import '../index'

/**
 * 注册表的两条硬规矩,和它们各自的理由:
 *  · 未知 kind **不是错误** —— 兜到 source-fallback,源码永远可见;
 *  · 重复注册**是**错误 —— 静默后胜会让「我改了怎么没生效」变成一小时排查。
 *
 * 用例各起各的表(`new BlockRegistry()`):表是有状态的,共用一张全局表的话
 * 「重复注册抛错」这条本身就会污染别的用例。
 */

function def(kind: string): BlockDef {
  return {
    kind: kind as BlockDef['kind'],
    presentation: 'flow',
    streaming: 'append',
    Component: () => null,
  }
}

describe('块注册表', () => {
  it('查得到就是它自己', () => {
    const registry = new BlockRegistry()
    const paragraph = def('paragraph')
    registry.register(paragraph)
    registry.register(def('source-fallback'))
    expect(registry.resolve('paragraph')).toBe(paragraph)
  })

  it('未知 kind 兜到 source-fallback —— 版本错位 / 插件缺席都算正常情况', () => {
    const registry = new BlockRegistry()
    const fallback = def('source-fallback')
    registry.register(fallback)
    expect(registry.resolve('mermaid-from-the-future')).toBe(fallback)
  })

  it('连兜底都没注册 = 装配错了,当场说清是哪件事没做', () => {
    const registry = new BlockRegistry()
    expect(() => registry.resolve('paragraph')).toThrow(/source-fallback/)
  })

  it('同一个 kind 注册两次抛错,不静默覆盖', () => {
    const registry = new BlockRegistry()
    registry.register(def('code'))
    expect(() => registry.register(def('code'))).toThrow(/重复注册/)
  })
})

describe('生产那张表(barrel 注册的两个块)', () => {
  it('P0 注册了段落与兜底', () => {
    expect(isBlockRegistered('paragraph')).toBe(true)
    expect(isBlockRegistered('source-fallback')).toBe(true)
  })

  it('段落是 flow(不进物件框),兜底是 object(有檐、有动作)', () => {
    expect(resolveBlock('paragraph').presentation).toBe('flow')
    const fallback = resolveBlock('source-fallback')
    expect(fallback.presentation).toBe('object')
    expect(fallback.chrome?.({ kind: 'source-fallback', reason: 'x', source: 's' })).toEqual({
      id: 'x',
    })
  })

  it('还没注册的 kind 经生产那张表也兜到兜底', () => {
    expect(resolveBlock('table').kind).toBe('source-fallback')
  })
})
