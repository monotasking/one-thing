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
  stream: { midway: 'grow', settled: 'same', failure: 'source', identity: 'origin', geometry: 'flow' },
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

  it('流式五问缺一问,注册当场抛(不是 warn —— warn 会被滚过去)', () => {
    const registry = new BlockRegistry()
    const bare = { ...def('code'), stream: undefined } as unknown as BlockDef
    expect(() => registry.register(bare)).toThrow(/五问缺一/)
    const partial = {
      ...def('code'),
      stream: { midway: 'grow', settled: 'same' },
    } as unknown as BlockDef
    expect(() => registry.register(partial)).toThrow(/failure \/ identity \/ geometry/)
  })

  it('同一个 kind 注册两次抛错,不静默覆盖', () => {
    const registry = new BlockRegistry()
    registry.register(def('code'))
    expect(() => registry.register(def('code'))).toThrow(/重复注册/)
  })
})

describe('生产那张表(barrel 注册了哪些块)', () => {
  it('八个块 + 兜底:P1 六个,P3 补上 figure 与 diff', () => {
    for (const kind of [
      'paragraph',
      'heading',
      'list',
      'quote',
      'code',
      'table',
      'figure',
      'diff',
      'source-fallback',
    ]) {
      expect(isBlockRegistered(kind)).toBe(true)
    }
  })

  it('段落是 flow(不进物件框),兜底是 object(有檐、有动作)', () => {
    expect(resolveBlock('paragraph').presentation).toBe('flow')
    const fallback = resolveBlock('source-fallback')
    expect(fallback.presentation).toBe('object')
    expect(fallback.chrome?.({ kind: 'source-fallback', reason: 'x', source: 's' })).toEqual({
      id: 'x',
    })
  })

  it('真的未知 kind 经生产那张表兜到兜底(P3 之后 figure / diff 都在表上了)', () => {
    expect(resolveBlock('figure').kind).toBe('figure')
    expect(resolveBlock('diff').kind).toBe('diff')
    // 剩下的兜底位留给版本错位、将来的新语法这类**真的**未知。
    expect(resolveBlock('katex-from-the-future').kind).toBe('source-fallback')
  })
})
