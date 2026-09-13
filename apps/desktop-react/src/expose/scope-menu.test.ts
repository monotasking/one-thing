import { describe, expect, it } from 'vitest'
import {
  EXPOSE_SCOPE_FILTER_MIN,
  EXPOSE_SCOPE_RECENT_MS,
  buildScopeMenu,
  scopeMenuRows,
  toScopeMenuProjects,
} from './scope-menu'
import type { ScopeMenuProject } from './scope-menu'

/**
 * 范围菜单那张表(A6,正本 §9 拍板 2)。
 *
 * 四条规矩各有一组用例,**边界都钉在两侧**:阈值(正好 8 / 9)、7 天(整 7 天 /
 * 差一毫秒)。门那一头钉不到「更早」那一档 —— `sessions` RPC 二十六条里没有一条
 * 设得了 `updatedAt`(会话是新建的,必然都在 7 天内),所以那一格的判据只能在
 * 这里,而门里那条是它的反面(12 个全新项目 → 一行「更早」都不该有)。
 */
const NOW = 1_757_000_000_000

const project = (name: string, agoMs: number): ScopeMenuProject => ({
  value: `project:/code/${name}`,
  label: name,
  updatedAt: NOW - agoMs,
})

const FIXED = [
  { value: 'all', label: '全部' },
  { value: 'collab', label: '协作' },
  { value: 'loose', label: '无项目' },
]

/** n 个刚刚动过的项目(名字 p0…p{n-1})。 */
const fresh = (n: number): ScopeMenuProject[] =>
  Array.from({ length: n }, (_, i) => project(`p${i}`, i * 1000))

const build = (over: Partial<Parameters<typeof buildScopeMenu>[0]> = {}) =>
  buildScopeMenu({
    fixed: FIXED,
    projects: fresh(12),
    query: '',
    now: NOW,
    olderExpanded: false,
    ...over,
  })

describe('筛选框:项目多过阈值才画', () => {
  it(`正好 ${EXPOSE_SCOPE_FILTER_MIN} 个不画(严格大于)`, () => {
    expect(build({ projects: fresh(EXPOSE_SCOPE_FILTER_MIN) }).filterShown).toBe(false)
  })

  it(`${EXPOSE_SCOPE_FILTER_MIN + 1} 个就画`, () => {
    expect(build({ projects: fresh(EXPOSE_SCOPE_FILTER_MIN + 1) }).filterShown).toBe(true)
  })

  it('一个项目都没有时当然不画', () => {
    expect(build({ projects: [] }).filterShown).toBe(false)
  })
})

describe('折叠:近 7 天没动过的收进「更早」', () => {
  it('整 7 天前动过的还算「最近」(边界闭区间)', () => {
    const model = build({
      projects: [...fresh(9), project('边界', EXPOSE_SCOPE_RECENT_MS)],
    })
    expect(model.recent.map((p) => p.label)).toContain('边界')
    expect(model.olderCount).toBe(0)
  })

  it('差一毫秒就落到「更早」', () => {
    const model = build({
      projects: [...fresh(9), project('久了', EXPOSE_SCOPE_RECENT_MS + 1)],
    })
    expect(model.recent.map((p) => p.label)).not.toContain('久了')
    expect(model.olderCount).toBe(1)
    // 收着的时候 `older` 是空的,而那一行仍要说得出「下面还有几个」。
    expect(model.older).toEqual([])
  })

  it('点开之后才画出来,而那一行(olderCount)还在 —— 它是开关', () => {
    const projects = [...fresh(9), project('久了', EXPOSE_SCOPE_RECENT_MS + 1)]
    const model = build({ projects, olderExpanded: true })
    expect(model.older.map((p) => p.label)).toEqual(['久了'])
    expect(model.olderCount).toBe(1)
  })

  it('短表**一格都不折**(折 5 个里的 2 个只藏东西,不省事)', () => {
    const model = build({ projects: [project('老的', EXPOSE_SCOPE_RECENT_MS * 10)] })
    expect(model.recent.map((p) => p.label)).toEqual(['老的'])
    expect(model.olderCount).toBe(0)
  })
})

describe('打词:固定档不参与,折叠全展开', () => {
  it('子串匹配,大小写不敏感', () => {
    const model = build({ projects: [...fresh(9), project('TransReader', 1000)], query: 'reader' })
    expect(model.recent.map((p) => p.label)).toEqual(['TransReader'])
  })

  it('固定三档**永远在**,词再怎么打都不滤掉', () => {
    const model = build({ query: '这个词一个项目都不命中' })
    expect(model.fixed.map((o) => o.value)).toEqual(['all', 'collab', 'loose'])
    expect(model.recent).toEqual([])
  })

  it('有词时「更早」那一档也参与匹配(搜不到 = 不存在)', () => {
    const projects = [...fresh(9), project('久了', EXPOSE_SCOPE_RECENT_MS + 1)]
    // 收着的那一档里那个项目,打词之后照样出现在画出来的那一半里。
    expect(build({ projects, query: '久' }).recent.map((p) => p.label)).toEqual(['久了'])
    expect(build({ projects, query: '久' }).olderCount).toBe(0)
  })

  it('前后空格不算词(只打空格 = 没在筛)', () => {
    const projects = [...fresh(9), project('久了', EXPOSE_SCOPE_RECENT_MS + 1)]
    expect(build({ projects, query: '   ' }).olderCount).toBe(1)
  })
})

describe('scopeMenuRows:屏幕上按得到的那几行', () => {
  it('次序 = 固定档 → 最近 → 展开的更早', () => {
    const projects = [project('近', 1000), project('久了', EXPOSE_SCOPE_RECENT_MS + 1)]
    const model = build({ projects: [...fresh(8), ...projects], olderExpanded: true })
    const rows = scopeMenuRows(model).map((o) => o.label)
    expect(rows.slice(0, 3)).toEqual(['全部', '协作', '无项目'])
    expect(rows[rows.length - 1]).toBe('久了')
  })
})

describe('toScopeMenuProjects:名册照搬,只换一格形', () => {
  it('名字与最近活动逐格转述,次序不动', () => {
    const got = toScopeMenuProjects(
      [
        { id: '/a', name: 'a', path: '/a', updatedAt: 2 },
        { id: '/b', name: 'b', path: '/b', updatedAt: 1 },
      ],
      (p) => `project:${p.id}`,
    )
    expect(got).toEqual([
      { value: 'project:/a', label: 'a', updatedAt: 2 },
      { value: 'project:/b', label: 'b', updatedAt: 1 },
    ])
  })
})
