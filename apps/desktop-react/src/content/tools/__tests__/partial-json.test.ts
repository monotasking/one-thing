import { describe, expect, it } from 'vitest'
import { parsePartialJson, partialString } from '../partial-json'

/**
 * 半截 JSON 的容错前缀解析(§6.2)。
 *
 * 判据只有一条:**已经能确定的才说**。这张表逐行钉的就是「哪些算确定」——
 * 说少了屏幕上少一格字,说错了屏幕上是一句**假的**参数,后者坏得多。
 */

describe('已经闭合的字段进 values', () => {
  it.each([
    ['{"path": "/a/b.ts"', { path: '/a/b.ts' }],
    ['{"path": "/a/b.ts"}', { path: '/a/b.ts' }],
    ['{"path": "/a/b.ts", ', { path: '/a/b.ts' }],
    ['{"a": 12}', { a: 12 }],
    ['{"a": true, "b": null}', { a: true, b: null }],
    ['{"o": {"b": 1}, "p": "x"}', { o: { b: 1 }, p: 'x' }],
    ['{"arr": [1, 2], "p": "x"}', { arr: [1, 2], p: 'x' }],
  ])('%s', (text, values) => {
    expect(parsePartialJson(text).values).toEqual(values)
  })
})

describe('还开着的那一格:说出到目前为止,并标出它没说完', () => {
  it('字符串值没闭合 → openKey / openValue', () => {
    expect(parsePartialJson('{"command": "rg -n \\"follow')).toEqual({
      values: {},
      openKey: 'command',
      openValue: 'rg -n "follow',
    })
  })

  it('前面闭合的照旧进 values,最后那一格才是开着的', () => {
    expect(parsePartialJson('{"path": "/a.ts", "text": "hel')).toEqual({
      values: { path: '/a.ts' },
      openKey: 'text',
      openValue: 'hel',
    })
  })

  it('转义还原;末尾悬空的反斜杠是**半个转义**,不吐出来', () => {
    expect(parsePartialJson('{"t": "a\\nb\\').openValue).toBe('a\nb')
    expect(parsePartialJson('{"t": "a\\u4e2d').openValue).toBe('a中')
    // \u 还没凑齐四位:那还不是一个字。
    expect(parsePartialJson('{"t": "a\\u4e').openValue).toBe('a')
  })

  it('空值也算「开着」—— 键已经定了,内容是空串', () => {
    expect(parsePartialJson('{"command": "')).toEqual({
      values: {},
      openKey: 'command',
      openValue: '',
    })
  })
})

describe('说不准的一律不说', () => {
  it('半截的数字不算 —— 下一片可能是 3,那时 12 就是错的', () => {
    expect(parsePartialJson('{"path": "/a.ts", "limit": 12').values).toEqual({ path: '/a.ts' })
    expect(parsePartialJson('{"limit": 12}').values).toEqual({ limit: 12 })
  })

  it('键自己没说完 → 这一格连名字都不知道', () => {
    expect(parsePartialJson('{"query": "天黑请闭眼", "cou')).toEqual({
      values: { query: '天黑请闭眼' },
    })
  })

  it('半棵树不算 —— 它的形还没定,硬画等于猜', () => {
    expect(parsePartialJson('{"p": "x", "o": {"b": ').values).toEqual({ p: 'x' })
    expect(parsePartialJson('{"p": "x", "arr": [1, ').values).toEqual({ p: 'x' })
  })

  it('容器里的引号不影响配对(字符串里的 } 不算收口)', () => {
    expect(parsePartialJson('{"o": {"b": "}"}, "p": "x"}').values).toEqual({
      o: { b: '}' },
      p: 'x',
    })
  })

  it.each(['', '{', ' ', '[1,2]', 'not json', 'null'])('认不出的一律空:%s', (text) => {
    expect(parsePartialJson(text).values).toEqual({})
  })
})

describe('partialString:闭合的优先,没有就退到还开着的那一截', () => {
  it('按给的顺序找第一格有的', () => {
    const parsed = parsePartialJson('{"filePath": "/a.ts"')
    expect(partialString(parsed, 'path', 'filePath')).toBe('/a.ts')
  })

  it('开着的那一格也算数', () => {
    const parsed = parsePartialJson('{"command": "rg -n')
    expect(partialString(parsed, 'command')).toBe('rg -n')
  })

  it('一格都没有就是 undefined —— 不返回空串冒充「有但是空」', () => {
    expect(partialString(parsePartialJson('{"other": 1}'), 'path')).toBeUndefined()
  })

  it('非字符串的值不冒充字符串', () => {
    expect(partialString(parsePartialJson('{"path": 12}'), 'path')).toBeUndefined()
  })
})
