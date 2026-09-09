/**
 * K0 —— 地址语法(`docs/design/atom-2026-09.md` §2)。
 *
 * 用的 scheme 全是假的(`demo` / `fake` / …):内核不认识任何真 scheme,测试也不该
 * 教它认识 —— 见 `stranger.test.ts`。
 */

import { describe, expect, it } from 'vitest'
import {
  formatRef,
  isRef,
  isRefPrefix,
  isRefScheme,
  matchesRefPrefix,
  normalizeSchemeSegment,
  parseRef,
  sameRef,
  uniqueName,
} from '../ref.js'

describe('resource ref', () => {
  it('splits at the first colon and round-trips', () => {
    const parsed = parseRef('demo:inbox/1')
    expect(parsed).toEqual({ scheme: 'demo', path: 'inbox/1' })
    expect(formatRef(parsed!)).toBe('demo:inbox/1')
  })

  it('keeps colons and slashes inside the path', () => {
    // `fake:/a/b:c` 是合法地址:冒号只在第一处有分隔含义,之后归 path 自己。
    for (const id of ['fake:/a/b:c', 'fake:C:\\x\\y', 'fake:https://example.test/a', 'fake:a b c', 'fake::']) {
      const parsed = parseRef(id)
      expect(parsed, id).not.toBeNull()
      expect(formatRef(parsed!), id).toBe(id)
      expect(isRef(id), id).toBe(true)
    }
    expect(parseRef('fake:/a/b:c')).toEqual({ scheme: 'fake', path: '/a/b:c' })
  })

  it('accepts digits and hyphens after the first letter of a scheme', () => {
    expect(isRefScheme('demo')).toBe(true)
    expect(isRefScheme('demo-2')).toBe(true)
    expect(parseRef('demo-2:x')).toEqual({ scheme: 'demo-2', path: 'x' })
  })

  it('rejects schemes that are uppercase, digit-led, empty or otherwise off-grammar', () => {
    for (const id of ['Demo:x', 'DEMO:x', '1demo:x', '-demo:x', 'de_mo:x', 'de mo:x', ':x', 'demo.x:y']) {
      expect(parseRef(id), id).toBeNull()
      expect(isRef(id), id).toBe(false)
    }
  })

  it('rejects an empty path and a missing colon', () => {
    expect(parseRef('demo:')).toBeNull()
    expect(parseRef('demo')).toBeNull()
    expect(parseRef('')).toBeNull()
    expect(isRef('demo:')).toBe(false)
  })

  it('formats without validating, and the malformed result fails the guard', () => {
    // formatRef 是格式化器不是构造器(见 ref.ts 的注释)。往返保证只朝一个方向成立。
    const bad = formatRef({ scheme: 'Demo', path: '' })
    expect(bad).toBe('Demo:')
    expect(isRef(bad)).toBe(false)
  })

  it('compares two refs field by field', () => {
    expect(sameRef({ scheme: 'demo', path: 'a' }, { scheme: 'demo', path: 'a' })).toBe(true)
    expect(sameRef({ scheme: 'demo', path: 'a' }, { scheme: 'demo', path: 'b' })).toBe(false)
    expect(sameRef({ scheme: 'demo', path: 'a' }, { scheme: 'fake', path: 'a' })).toBe(false)
  })

  it('only calls `scheme:` and `scheme:path/` a prefix', () => {
    expect(isRefPrefix('demo:')).toBe(true)
    expect(isRefPrefix('demo:/a/')).toBe(true)
    expect(isRefPrefix('demo:inbox/')).toBe(true)
    // 不以 `:` 或 `/` 收尾 = 不在段边界上,不是前缀。
    expect(isRefPrefix('demo:/a')).toBe(false)
    expect(isRefPrefix('demo')).toBe(false)
    expect(isRefPrefix(':x/')).toBe(false)
    expect(isRefPrefix('Demo:')).toBe(false)
    // 冒号不是路径的段分隔符,所以 `a:b:` 也不是前缀。
    expect(isRefPrefix('demo:b:')).toBe(false)
  })

  it('matches a whole scheme without bleeding into a neighbouring one', () => {
    expect(matchesRefPrefix('a:x', 'a:')).toBe(true)
    // 裸 startsWith 的第一种病:`a:` 吃掉 `ab:`。
    expect(matchesRefPrefix('ab:x', 'a:')).toBe(false)
    expect(matchesRefPrefix('a:x', 'ab:')).toBe(false)
  })

  it('matches on a path segment boundary, not on characters', () => {
    expect(matchesRefPrefix('fake:/a/b', 'fake:/a/')).toBe(true)
    expect(matchesRefPrefix('fake:/a/b/c', 'fake:/a/')).toBe(true)
    // 裸 startsWith 的第二种病:看住 `/a/` 的订阅收到了 `/ab` 的事件。
    expect(matchesRefPrefix('fake:/ab', 'fake:/a/')).toBe(false)
    expect(matchesRefPrefix('fake:/ab/c', 'fake:/a/')).toBe(false)
  })

  it('refuses to match when either side is malformed', () => {
    expect(matchesRefPrefix('demo:', 'demo:')).toBe(false)
    expect(matchesRefPrefix('Demo:x', 'demo:')).toBe(false)
    expect(matchesRefPrefix('demo:x', 'demo')).toBe(false)
    expect(matchesRefPrefix('demo:x', 'demo:x')).toBe(false)
  })
})

/**
 * K5-a —— 把外来的名字归一成 scheme 语法。
 *
 * 四组判据对应四种真实的外部 id:大写、下划线 / 连字符 / 点、非 ASCII、以及归一
 * 之后必然出现的撞名。
 */
describe('normalizeSchemeSegment', () => {
  it('lowercases', () => {
    expect(normalizeSchemeSegment('MyServer')).toBe('myserver')
    expect(normalizeSchemeSegment('ABC')).toBe('abc')
  })

  it('turns every illegal character into a hyphen, then collapses and trims', () => {
    expect(normalizeSchemeSegment('my_server')).toBe('my-server')
    expect(normalizeSchemeSegment('my.server')).toBe('my-server')
    expect(normalizeSchemeSegment('my server')).toBe('my-server')
    expect(normalizeSchemeSegment('__my__server__')).toBe('my-server')
    expect(normalizeSchemeSegment('a///b')).toBe('a-b')
    // 已经合法的原样过 —— 归一是幂等的。
    expect(normalizeSchemeSegment('my-server-1')).toBe('my-server-1')
    expect(normalizeSchemeSegment(normalizeSchemeSegment('My_Server')!)).toBe('my-server')
  })

  it('keeps digits, including at the head — the prefix is the caller\'s job', () => {
    // scheme 首字符必须是字母,而这只函数交的是**尾段**:补首字母是调用方的前缀
    // 干的事,不是这里替它决定。
    expect(normalizeSchemeSegment('2fa')).toBe('2fa')
    expect(isRefScheme('2fa')).toBe(false)
    expect(isRefScheme(`x-${normalizeSchemeSegment('2fa')}`)).toBe(true)
  })

  it('gives up instead of inventing a name', () => {
    expect(normalizeSchemeSegment('')).toBeNull()
    expect(normalizeSchemeSegment('___')).toBeNull()
    expect(normalizeSchemeSegment('。。。')).toBeNull()
  })

  it('folds non-ASCII into hyphens rather than smuggling it into an address', () => {
    expect(normalizeSchemeSegment('服务器')).toBeNull()
    expect(normalizeSchemeSegment('a服务器b')).toBe('a-b')
  })
})

describe('uniqueName', () => {
  it('returns the base when nothing has taken it', () => {
    expect(uniqueName('a', new Set())).toBe('a')
    expect(uniqueName('a', new Set(['b']), '-')).toBe('a')
  })

  it('counts from 2 and keeps counting', () => {
    expect(uniqueName('a', new Set(['a']), '-')).toBe('a-2')
    expect(uniqueName('a', new Set(['a', 'a-2']), '-')).toBe('a-3')
    expect(uniqueName('a', new Set(['a', 'a-2', 'a-3']), '-')).toBe('a-4')
  })

  it('serves the second alphabet too — member names take no hyphen', () => {
    expect(uniqueName('getDocs', new Set(['getDocs']))).toBe('getDocs2')
    expect(uniqueName('getDocs', new Set(['getDocs', 'getDocs2']))).toBe('getDocs3')
  })

  it('depends only on base and taken — not on call order', () => {
    const taken = new Set(['a', 'a-2'])
    expect(uniqueName('a', taken, '-')).toBe(uniqueName('a', taken, '-'))
  })

  it('produces something the scheme grammar still accepts', () => {
    expect(isRefScheme(uniqueName('x-my-server', new Set(['x-my-server']), '-'))).toBe(true)
  })
})
