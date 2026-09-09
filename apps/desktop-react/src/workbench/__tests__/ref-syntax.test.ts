import { describe, expect, it } from 'vitest'
import { isRefScheme } from '@onething/core/resource'
import { contentKindList, parseRefId, refId, sameRef } from '../kinds'
import { pairPartsOf, pairRefOf } from '../../content/kinds/pair-ref'
/* 这一组要问「**这台上真正登记着的**那几种」,所以整张表得先接上来。 */
import '../../content/kinds'

/**
 * **地址合一:壳的 ref 与 core 的 `Ref` 是同一套语法**(K2b-1,
 * `docs/design/atom-2026-09.md` §7 盲点 2)。
 *
 * 这一组守三件:
 *  ① 语法闸真的生效了 —— `parseRefId` 委托的是 core 的 `parseRef`,所以
 *     `Demo:x` 这种从前切得开的串从今天起**不是**地址;
 *  ② 这台上登记着的每一个种类名都过得了 core 那条 scheme 语法 —— 两边合的是
 *     **同一张表**,不是「壳这边宽一点」;
 *  ③ 往返无损照旧 —— `key` 里的冒号(`file:/a/b:c`)与 `pair` 那格 `%7C` 转义
 *     在换了产地之后一个字都没变。
 *
 * **反证**:把 `kinds.ts` 的 `parseRefId` 换回旧那份手写实现(只判「有没有冒号」)
 * → ① 当场红。
 */

describe('地址语法的唯一产地在 core', () => {
  it('`Demo:x` 不是地址 —— scheme 必须小写开头(从前壳这边只判冒号,切得开)', () => {
    expect(parseRefId('Demo:x')).toBeNull()
  })

  it('同族的另外几种写法一并挡掉:数字开头、下划线、空 scheme、空 path', () => {
    expect(parseRefId('1a:x')).toBeNull()
    expect(parseRefId('a_b:x')).toBeNull()
    expect(parseRefId(':x')).toBeNull()
    expect(parseRefId('file:')).toBeNull()
    expect(parseRefId('nocolon')).toBeNull()
  })

  it('合法的照旧切得开,而且**在第一个冒号处**切', () => {
    expect(parseRefId('file:/a/b:c')).toEqual({ kind: 'file', key: '/a/b:c' })
    expect(parseRefId('dir:/x')).toEqual({ kind: 'dir', key: '/x' })
  })

  it('**这台上登记着的每一个种类名都是合法 scheme**(同一张表,不是壳宽一点)', () => {
    const ids = contentKindList().map((kind) => kind.id)
    // 前提:表真的接上来了(空表会让这一条空过)。
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.filter((id) => !isRefScheme(id))).toEqual([])
  })

  it('往返无损:`key` 里带冒号的那一族', () => {
    const ref = { kind: 'file', key: '/a/b:c' }
    expect(parseRefId(refId(ref))).toEqual(ref)
    expect(sameRef(parseRefId(refId(ref))!, ref)).toBe(true)
  })

  it('往返无损:`pair` 那格 key(含 `%7C` 转义与两侧各自的冒号)', () => {
    const left = { kind: 'file', key: '/a|b.ts' }
    const right = { kind: 'dir', key: '/c/d:e' }
    const pair = pairRefOf(left, right)
    expect(pair.key).toContain('%7C')
    expect(parseRefId(refId(pair))).toEqual(pair)
    expect(pairPartsOf(pair)).toEqual([left, right])
  })

  it('`sameRef` 逐字段判(它也委托 core,行为一个字没变)', () => {
    expect(sameRef({ kind: 'dir', key: '/x' }, { kind: 'dir', key: '/x' })).toBe(true)
    expect(sameRef({ kind: 'dir', key: '/x' }, { kind: 'file', key: '/x' })).toBe(false)
    expect(sameRef({ kind: 'dir', key: '/x' }, { kind: 'dir', key: '/y' })).toBe(false)
  })
})
