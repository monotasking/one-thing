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
  parseRef,
  sameRef,
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
