import { describe, expect, it } from 'vitest'
import {
  ARCHIVED_FACET,
  DIR_FACET,
  INITIAL_FILTERS,
  REASONING_FACET,
  ROLE_FACET,
  SPACE_FACET,
  TIME_FACET,
  facetKeysOf,
  filterChipsOf,
  filtersAreDefault,
  filtersOf,
  isOtherSpace,
  spaceFilterValue,
} from '../filters'
import type { SearchFilterState } from '../filters'
import { FAKE_CAPABILITY_MANIFESTS, FAKE_EXTRA_MANIFEST } from '../../test/fake-search-port'

/**
 * 过滤片(检索重建 S4b,设计 §9 第五条 / §4.0 那张清账表的「过滤片」一行)。
 *
 * 两件事是这一批的判据:
 *  1. 一颗片画不画由**能力自述**说了算 —— 不是壳自己拍;
 *  2. 片以**结构**落成 `filters`,一个字符串都不拼。
 */

const DEFAULT_SPACE = 'default'
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0)

const ctx = (available: Iterable<string>, spaceId = 'w1') => ({
  spaceId,
  defaultSpaceId: DEFAULT_SPACE,
  now: NOW,
  available: new Set(available),
})

describe('facetKeysOf(哪几颗片摆得出来 —— 问自述,不问壳)', () => {
  it('单类档 = 那一个能力声明的 facets', () => {
    const keys = facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'messages', 'all')
    expect([...keys].sort()).toEqual(['archived', 'role', 'sessionId', 'spaceId', 'time'])
  })

  it('一个 facet 都不声明的能力(prompts / actions)→ 一颗片都没有', () => {
    expect(facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'prompts', 'all').size).toBe(0)
  })

  /**
   * files 只声明**一个** facet(`dir` = 扫描根,S4b)。它不落成屏幕上的一颗片
   * (`filterChipsOf` 只认那五颗),但它决定两件事:「在此目录内搜」按不按得动,
   * 以及缺省的当前会话工作目录发不发得出去。
   */
  it('files 只认一格 `dir`(扫描根)—— 五颗片一颗都不画', () => {
    expect([...facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'files', 'all')]).toEqual([DIR_FACET])
    expect(filterChipsOf(INITIAL_FILTERS, facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'files', 'all')))
      .toEqual([])
  })

  it('`all` 档 = 各组声明的**并集**(§9 原话)', () => {
    const keys = facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'all', 'all')
    // chats 不声明 role,messages 声明了 —— 全部档里那颗片仍然该画。
    expect(keys.has('role')).toBe(true)
    expect(keys.has('path')).toBe(true)
  })

  /** §4.0 的硬指标:加一个设计时没想过的能力,壳一个字不改就跟上了。 */
  it('注册表多一个陌生能力、它声明了 role → 它那一档自动有角色片', () => {
    const keys = facetKeysOf([...FAKE_CAPABILITY_MANIFESTS, FAKE_EXTRA_MANIFEST], FAKE_EXTRA_MANIFEST.id, 'all')
    expect([...keys]).toEqual(['role'])
  })
})

describe('filterChipsOf(摆不出那个键的片整颗不画)', () => {
  it('messages 档:空间 / 角色 / 时间 / 含归档 四颗', () => {
    const available = facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'messages', 'all')
    expect(filterChipsOf(INITIAL_FILTERS, available).map(c => c.id))
      .toEqual(['space', 'role', 'time', 'archived'])
  })

  it('「含推理」今天画不出来 —— **没有一个能力声明 includeReasoning**', () => {
    const available = facetKeysOf(FAKE_CAPABILITY_MANIFESTS, 'all', 'all')
    expect(available.has(REASONING_FACET)).toBe(false)
    expect(filterChipsOf(INITIAL_FILTERS, available).some(c => c.id === 'reasoning')).toBe(false)
    // 判据是「声明了没有」,不是「壳想不想画」:硬给一个键,片当场出现。
    expect(filterChipsOf(INITIAL_FILTERS, new Set([REASONING_FACET])).map(c => c.id))
      .toEqual(['reasoning'])
  })

  it('files 档:一颗片都没有(它只声明 `dir`,而 `dir` 不落成一颗片)', () => {
    expect(filterChipsOf(INITIAL_FILTERS, new Set())).toEqual([])
    expect(filterChipsOf(INITIAL_FILTERS, new Set([DIR_FACET]))).toEqual([])
  })

  it('`on` 说的是「挑过了没有」,不是「此刻是什么值」', () => {
    const available = new Set([SPACE_FACET, ROLE_FACET])
    const chips = filterChipsOf(INITIAL_FILTERS, available)
    expect(chips.map(c => c.on)).toEqual([false, false])
    const picked = filterChipsOf({ ...INITIAL_FILTERS, role: 'user' }, available)
    expect(picked.find(c => c.id === 'role')?.on).toBe(true)
  })
})

describe('filtersOf(结构,不是拼串)', () => {
  it('缺省那一份**只发空间一格** —— 那正是 S4b 之前的行为(当前空间那张会话表)', () => {
    const all = new Set([SPACE_FACET, ROLE_FACET, TIME_FACET, ARCHIVED_FACET])
    expect(filtersOf(INITIAL_FILTERS, ctx(all))).toEqual({ spaceId: 'w1' })
  })

  it('「当前」在**默认空间**上收两个值 —— 老会话的 workspaceId 是空的(后端零迁移)', () => {
    const all = new Set([SPACE_FACET])
    expect(filtersOf(INITIAL_FILTERS, ctx(all, DEFAULT_SPACE))).toEqual({ spaceId: [DEFAULT_SPACE, ''] })
    expect(spaceFilterValue('', DEFAULT_SPACE)).toEqual([DEFAULT_SPACE, ''])
    expect(spaceFilterValue('w9', DEFAULT_SPACE)).toBe('w9')
  })

  it('「全部空间」= **不发这一格**(缺席就是不限)', () => {
    const state: SearchFilterState = { ...INITIAL_FILTERS, space: 'all' }
    expect(filtersOf(state, ctx([SPACE_FACET]))).toEqual({})
  })

  it('角色是一格枚举,值原样落 —— 不拼进查询串', () => {
    const state: SearchFilterState = { ...INITIAL_FILTERS, space: 'all', role: 'user' }
    expect(filtersOf(state, ctx([ROLE_FACET]))).toEqual({ role: 'user' })
  })

  it('时间是**区间**(FacetFilter 的 gte/lte 形),三档各算各的', () => {
    const base: SearchFilterState = { ...INITIAL_FILTERS, space: 'all' }
    const today = filtersOf({ ...base, time: 'today' }, ctx([TIME_FACET])) as { time: { gte: number } }
    expect(today.time.gte).toBeLessThanOrEqual(NOW)
    const week = filtersOf({ ...base, time: 'week' }, ctx([TIME_FACET])) as { time: { gte: number } }
    expect(NOW - week.time.gte).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('自定时间:两头都没填 = 不发(一个空区间不是一次过滤)', () => {
    const base: SearchFilterState = { ...INITIAL_FILTERS, space: 'all', time: 'custom' }
    expect(filtersOf(base, ctx([TIME_FACET]))).toEqual({})
    expect(filtersOf({ ...base, customFrom: 1, customTo: 2 }, ctx([TIME_FACET])))
      .toEqual({ time: { gte: 1, lte: 2 } })
  })

  it('「含归档」是缺省 —— **只有关掉它才发一格**', () => {
    const base: SearchFilterState = { ...INITIAL_FILTERS, space: 'all' }
    expect(filtersOf(base, ctx([ARCHIVED_FACET]))).toEqual({})
    expect(filtersOf({ ...base, archived: false }, ctx([ARCHIVED_FACET]))).toEqual({ archived: false })
  })

  it('摆不出那个 facet 键就**不发** —— 壳不替一个不认这个键的能力回答', () => {
    const state: SearchFilterState = { ...INITIAL_FILTERS, role: 'user', archived: false }
    // 一个 facet 都摆不出的档(files):一格都不发。
    expect(filtersOf(state, ctx([]))).toEqual({})
  })

  it('范围片就是 filters 的一格;它的键摆不出时同样不发(片画成失效)', () => {
    const state: SearchFilterState = {
      ...INITIAL_FILTERS,
      space: 'all',
      scope: { key: 'sessionId', value: 's1', label: '那间会话' },
    }
    expect(filtersOf(state, ctx(['sessionId']))).toEqual({ sessionId: 's1' })
    expect(filtersOf(state, ctx([]))).toEqual({})
  })
})

/**
 * **扫描根**(S4b 修)。旧行为:文件那一档搜的是当前会话的工作目录
 * (`useSessionCwd()`);改读后端之后要由壳把它结构地递回去,否则后端那张根列表
 * 认的是它自己那条 `getCurrentSessionId()`,而 React 壳从不告诉它当前会话是谁。
 */
describe('filtersOf:扫描根 `dir`(缺省 = 当前会话的工作目录)', () => {
  const withCwd = (available: Iterable<string>, cwd?: string) => ({ ...ctx(available), ...(cwd === undefined ? {} : { cwd }) })
  const noSpace: SearchFilterState = { ...INITIAL_FILTERS, space: 'all' }

  it('这一档认 `dir` 且壳知道 cwd → **结构地**发一格(不拼字符串)', () => {
    expect(filtersOf(noSpace, withCwd([DIR_FACET], '/repo/a'))).toEqual({ dir: '/repo/a' })
  })

  it('这一档不认 `dir`(消息 / 会话)→ 一格都不发', () => {
    expect(filtersOf(noSpace, withCwd([ROLE_FACET], '/repo/a'))).toEqual({})
  })

  it('壳这边也不知道 cwd → 不发,由后端自己那张根列表答', () => {
    expect(filtersOf(noSpace, withCwd([DIR_FACET]))).toEqual({})
  })

  it('「在此目录内搜」那颗范围片**替换**缺省 —— 用户明说了就听他的', () => {
    const scoped: SearchFilterState = {
      ...noSpace,
      scope: { key: DIR_FACET, value: '/repo/b', label: '/repo/b' },
    }
    expect(filtersOf(scoped, withCwd([DIR_FACET], '/repo/a'))).toEqual({ dir: '/repo/b' })
  })

  it('× 掉范围片 → **回到缺省 cwd**,不是回到「无 dir」(无 dir = 后端的根列表)', () => {
    const scoped: SearchFilterState = {
      ...noSpace,
      scope: { key: DIR_FACET, value: '/repo/b', label: '/repo/b' },
    }
    const removed: SearchFilterState = { ...scoped, scope: undefined }
    expect(filtersOf(removed, withCwd([DIR_FACET], '/repo/a'))).toEqual({ dir: '/repo/a' })
  })
})

describe('isOtherSpace(跨空间徽的判据 —— 与「空 = 默认空间」是同一句话的另一半)', () => {
  it('空 workspaceId 在默认空间上**不算别的空间**', () => {
    expect(isOtherSpace('', DEFAULT_SPACE, DEFAULT_SPACE)).toBe(false)
    expect(isOtherSpace(DEFAULT_SPACE, '', DEFAULT_SPACE)).toBe(false)
  })

  it('真不同才算', () => {
    expect(isOtherSpace('w2', 'w1', DEFAULT_SPACE)).toBe(true)
  })

  it('后端没给这一格(不是字符串)= 不知道,不画徽', () => {
    expect(isOtherSpace(undefined, 'w1', DEFAULT_SPACE)).toBe(false)
    expect(isOtherSpace(7, 'w1', DEFAULT_SPACE)).toBe(false)
  })
})

describe('filtersAreDefault', () => {
  it('缺省那一份是真,挑过任何一格就是假(范围片也算)', () => {
    expect(filtersAreDefault(INITIAL_FILTERS)).toBe(true)
    expect(filtersAreDefault({ ...INITIAL_FILTERS, role: 'user' })).toBe(false)
    expect(filtersAreDefault({
      ...INITIAL_FILTERS,
      scope: { key: 'sessionId', value: 's', label: 'x' },
    })).toBe(false)
  })
})
