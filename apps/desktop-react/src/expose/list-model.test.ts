import { describe, expect, it } from 'vitest'
import {
  applyQuery,
  applyScope,
  attachChildren,
  bucketize,
  buildListModel,
  findRow,
  flatten,
  rowIndexOf,
  sessionMatchesQuery,
} from './list-model'
import { PINNED_SECTION_ID } from './sections'
import { projectScope } from './scopes'
import { toSessionSummary } from './projection'
import { NOW, ONETHING_DIR, SESSIONS, TRANSREADER_DIR } from '../data/__fixtures__/sessions'
import type { SessionMeta } from '@shared/ipc/chat'
import type { ProjectScope, SessionSummary } from './types'

/**
 * 列表模型的五步各自一组,最后一组是端到端(设计 §5 P0 点名的五条:
 * 置顶节、月桶顺序、孤儿回顶层、子命中父展开、`rowIds` 顺序)。
 *
 * 夹具是真的那一份(`data/__fixtures__/sessions.ts`)—— 它从 `SessionMeta` 起步,
 * 所以每一条用例顺带验着 `projection` 那层映射,而不是一份自己造的中间态。
 */

const ALL: ProjectScope = { kind: 'all' }
const ids = (list: readonly SessionSummary[]) => list.map((s) => s.id)

function model(over: Partial<Parameters<typeof buildListModel>[0]> = {}) {
  return buildListModel({
    sessions: SESSIONS,
    scope: ALL,
    query: '',
    expandedRooms: [],
    now: NOW,
    ...over,
  })
}

/* ── 1. 范围 ─────────────────────────────────────────────────────────────── */

describe('applyScope(第 1 步:范围过滤)', () => {
  it('all 恒真:一条不少', () => {
    expect(applyScope(SESSIONS, ALL)).toHaveLength(SESSIONS.length)
  })

  it('collab = 三档房间(群房 / 私聊 / agent 私聊)+ 它们的子行', () => {
    // 子行按**父房间**判:wk-verify / ag-xiaoli 自己不是房间,却跟着 rm-release 进来。
    expect(ids(applyScope(SESSIONS, { kind: 'collab' })).sort()).toEqual(
      ['ag-xiaoli', 'dm-ying', 'rm-release', 'sw-pair', 'wk-verify'].sort(),
    )
  })

  it('loose = 没有工作目录且不是协作;孤儿按**它自己**判(父不在集合里)', () => {
    const loose = ids(applyScope(SESSIONS, { kind: 'loose' }))
    expect(loose).toContain('lo-notes')
    // wk-orphan 的房间 rm-gone 不在名册里,于是按它自己的事实归档(它没有工作目录)。
    expect(loose).toContain('wk-orphan')
    expect(loose).not.toContain('rm-release')
  })

  it('project:子行跟着父房间走,不看自己那一格工作目录', () => {
    const inProject = ids(applyScope(SESSIONS, projectScope(ONETHING_DIR)))
    // wk-verify **带着** ONETHING_DIR,但它的父房间 rm-release 也带着 —— 两边同时
    // 成立时看不出判据是谁,所以这一条钉的是反面:换成 transreader 那一档,
    // wk-verify 一定不在(它父亲不在)。
    expect(inProject).toContain('wk-verify')
    expect(ids(applyScope(SESSIONS, projectScope(TRANSREADER_DIR)))).not.toContain('wk-verify')
  })

  it('父被范围滤掉时子行跟着走 —— 不会留下一条无处安放的子行', () => {
    const inProject = applyScope(SESSIONS, projectScope(TRANSREADER_DIR))
    expect(ids(inProject)).toEqual(['tr-menubar', 'tr-flask'])
  })
})

/* ── 2. 挂父 ─────────────────────────────────────────────────────────────── */

describe('attachChildren(第 2 步:挂父)', () => {
  const tree = attachChildren(SESSIONS)

  it('work / agent 挂到 roomId 指着的那间房,按 updatedAt 倒序', () => {
    expect(ids(tree.children.get('rm-release') ?? [])).toEqual(['wk-verify', 'ag-xiaoli'])
    expect(ids(tree.tops)).not.toContain('wk-verify')
  })

  it('**孤儿回顶层**:父不在集合里的子行不静默丢', () => {
    expect(ids(tree.tops)).toContain('wk-orphan')
  })

  it('顶层按 updatedAt 倒序 —— 节内的阅读次序由这一步定下', () => {
    const at = tree.tops.map((s) => s.updatedAt)
    expect([...at].sort((a, b) => b - a)).toEqual(at)
  })

  it('父不是一间房(roomId 指着一条普通会话)也算孤儿', () => {
    const meta = (over: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionSummary =>
      toSessionSummary({ name: over.id, createdAt: 0, updatedAt: 1, ...over } as SessionMeta)
    const list = [
      meta({ id: 'plain' }),
      meta({ id: 'w', kind: 'work', collab: { roomSessionId: 'plain' } }),
    ]
    expect(ids(attachChildren(list).tops)).toEqual(['plain', 'w'])
  })
})

/* ── 3. 落桶 ─────────────────────────────────────────────────────────────── */

describe('bucketize(第 3 步:分节)', () => {
  const tops = attachChildren(SESSIONS).tops

  it('置顶先于时间:三天前那条置顶会话排在最上面那一节,时间节里不重复', () => {
    const slices = bucketize(tops, NOW)
    expect(slices[0].id).toBe(PINNED_SECTION_ID)
    expect(ids(slices[0].sessions)).toEqual(['os-toolkit'])
    for (const slice of slices.slice(1)) {
      expect(ids(slice.sessions)).not.toContain('os-toolkit')
    }
  })

  it('节的次序:置顶 → 今天 → 昨天 → 本周 → 月桶', () => {
    expect(bucketize(tops, NOW).map((s) => s.id)).toEqual([
      'pinned',
      'today',
      'yesterday',
      'thisWeek',
      'month:2026-08',
    ])
  })

  it('**月桶最近的月在前**,而且逐月各一格', () => {
    const meta = (id: string, updatedAt: number): SessionSummary =>
      toSessionSummary({ id, name: id, createdAt: 0, updatedAt } as SessionMeta)
    const june = new Date('2026-06-11T10:00:00').getTime()
    const july = new Date('2026-07-03T10:00:00').getTime()
    const may = new Date('2026-05-20T10:00:00').getTime()
    const slices = bucketize([meta('a', june), meta('b', may), meta('c', july)], NOW)
    expect(slices.map((s) => s.id)).toEqual(['month:2026-07', 'month:2026-06', 'month:2026-05'])
  })

  it('跨年的月带上年,本年的月标题就是月份那一句', () => {
    const meta = (id: string, updatedAt: number): SessionSummary =>
      toSessionSummary({ id, name: id, createdAt: 0, updatedAt } as SessionMeta)
    const lastYear = new Date('2025-11-04T10:00:00').getTime()
    const [older] = bucketize([meta('a', lastYear)], NOW)
    expect(older.label).toEqual({ kind: 'monthYear', year: 2025, month: 11 })
    const thisYear = new Date('2026-06-11T10:00:00').getTime()
    expect(bucketize([meta('b', thisYear)], NOW)[0].label).toEqual({
      kind: 'key',
      key: 'time.month6',
    })
  })

  it('空节不出现:一条都没有的节在屏幕上没有任何可看的东西', () => {
    expect(bucketize([], NOW)).toEqual([])
  })
})

/* ── 4. 搜索 ─────────────────────────────────────────────────────────────── */

describe('applyQuery(第 4 步:过滤)', () => {
  const tree = attachChildren(SESSIONS)
  const slices = bucketize(tree.tops, NOW)

  it('空词是恒等变换,而且原样交回同一批引用(不搜时零分配)', () => {
    const out = applyQuery(slices, tree.children, '   ')
    expect(out.sections).toBe(slices)
    expect(out.children).toBe(tree.children)
    expect(out.forcedExpanded.size).toBe(0)
  })

  it('父命中:这一行留下,**子行一条不少**', () => {
    const out = applyQuery(slices, tree.children, '发版房')
    expect(out.sections.flatMap((s) => ids(s.sessions))).toEqual(['rm-release'])
    expect(ids(out.children.get('rm-release') ?? [])).toEqual(['wk-verify', 'ag-xiaoli'])
    // 父自己命中就不是「通路」,不强制展开(用户没搜里面那一条)。
    expect(out.forcedExpanded.has('rm-release')).toBe(false)
  })

  it('**子命中 → 父作为通路留下并强制展开**,而且只留命中的子行', () => {
    const out = applyQuery(slices, tree.children, '全链路验收')
    expect(out.sections.flatMap((s) => ids(s.sessions))).toEqual(['rm-release'])
    expect(ids(out.children.get('rm-release') ?? [])).toEqual(['wk-verify'])
    expect([...out.forcedExpanded]).toEqual(['rm-release'])
  })

  it('两样都不中 → 整支消失,空掉的节跟着消失', () => {
    expect(applyQuery(slices, tree.children, '这个词哪儿都没有').sections).toEqual([])
  })

  it('判据是标题 / 预览 / 摘要三格 —— 搜的格与画的格是同一批', () => {
    const provider = SESSIONS.find((s) => s.id === 'os-provider')!
    // '判定函数' 只在摘要(lastMessagePreview)里。
    expect(provider.title.includes('判定函数')).toBe(false)
    expect(sessionMatchesQuery(provider, '判定函数')).toBe(true)
    expect(sessionMatchesQuery(provider, 'PROVIDER')).toBe(true)
    const old = SESSIONS.find((s) => s.id === 'lo-notes')!
    expect(old.digest).toBeNull()
    expect(sessionMatchesQuery(old, '判定函数')).toBe(false)
    expect(sessionMatchesQuery(old, '')).toBe(true)
  })
})

/* ── 5. 平铺 ─────────────────────────────────────────────────────────────── */

describe('flatten(第 5 步:平铺)', () => {
  const tree = attachChildren(SESSIONS)
  const slices = bucketize(tree.tops, NOW)

  it('收起时子行不进 rowIds;展开时紧跟在父后面', () => {
    const closed = flatten(slices, tree.children, new Set())
    expect(closed.rowIds).not.toContain('wk-verify')

    const open = flatten(slices, tree.children, new Set(['rm-release']))
    const at = open.rowIds.indexOf('rm-release')
    expect(open.rowIds.slice(at, at + 3)).toEqual(['rm-release', 'wk-verify', 'ag-xiaoli'])
  })

  it('行自述层级:子行 depth 1、指着父;房间自述可展开', () => {
    const open = flatten(slices, tree.children, new Set(['rm-release']))
    expect(findRow(open, 'rm-release')).toMatchObject({ depth: 0, expandable: true, expanded: true })
    expect(findRow(open, 'wk-verify')).toMatchObject({
      depth: 1,
      parentId: 'rm-release',
      expandable: false,
    })
  })

  it('没有子行的房间**不可展开** —— 一个点开什么都没有的箭头是谎话', () => {
    const open = flatten(slices, tree.children, new Set(['sw-pair']))
    expect(findRow(open, 'sw-pair')).toMatchObject({ expandable: false, expanded: false })
  })

  it('rowIds 就是把 sections 里的行按屏幕顺序抄一遍 —— 两份事实同一次产出', () => {
    const open = flatten(slices, tree.children, new Set(['rm-release']))
    expect(open.rowIds).toEqual(open.sections.flatMap((s) => s.rows.map((r) => r.id)))
  })
})

/* ── 端到端 ──────────────────────────────────────────────────────────────── */

describe('buildListModel(端到端)', () => {
  it('rowIds 的次序 = 置顶 → 今天 → 昨天 → 本周 → 月桶,节内按时间倒序', () => {
    expect(model().rowIds).toEqual([
      'os-toolkit',
      'os-provider',
      'rm-release',
      'sw-pair',
      'wk-orphan',
      'os-compact',
      'dm-ying',
      'os-expose',
      'tr-menubar',
      'lo-notes',
      'tr-flask',
    ])
  })

  it('两条子行默认不在序列里(房间收着);展开一间房它们才出现', () => {
    expect(model().rowIds).not.toContain('ag-xiaoli')
    expect(model({ expandedRooms: ['rm-release'] }).rowIds).toContain('ag-xiaoli')
  })

  it('搜索命中子行:父自动展开,子行进序列(派生态,没落进 expandedRooms)', () => {
    const found = model({ query: '全链路验收' })
    expect(found.rowIds).toEqual(['rm-release', 'wk-verify'])
    expect(findRow(found, 'rm-release')?.expanded).toBe(true)
  })

  it('换范围:项目那一档只剩这个项目的行', () => {
    expect(model({ scope: projectScope(TRANSREADER_DIR) }).rowIds).toEqual([
      'tr-menubar',
      'tr-flask',
    ])
  })

  it('一条会话都没有时是空模型(不是一张有节没有行的表)', () => {
    const empty = model({ sessions: [] })
    expect(empty.sections).toEqual([])
    expect(empty.rowIds).toEqual([])
  })

  it('rowIndexOf / findRow 认得空 id 与不在屏幕上的 id', () => {
    const m = model()
    expect(rowIndexOf(m, null)).toBe(-1)
    expect(rowIndexOf(m, 'wk-verify')).toBe(-1)
    expect(rowIndexOf(m, 'os-toolkit')).toBe(0)
    expect(findRow(m, 'nope')).toBeUndefined()
  })
})
