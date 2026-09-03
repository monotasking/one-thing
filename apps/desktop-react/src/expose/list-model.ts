import { isRoomChildKind, isRoomKind } from './row-kinds'
import { scopeMatches } from './scopes'
import { PINNED_SECTION, sectionOf, type SectionLabel } from './sections'
import type { ProjectScope, SessionSummary } from './types'

/**
 * **列表模型**(方向 A §2)—— 一份会话名册 + 一格范围 + 一个词 + 一份展开表
 * → 屏幕上那张树。纯函数,不认识 React、不发请求、不产出任何界面字符串。
 *
 * 它接替的是从前的 `projection.buildGroups` + `transitions.visibleCardIds`:
 * 那两处各算各的(一份用来画、一份用来走键盘),于是「屏幕上有哪些行」与
 * 「方向键走哪些行」是两份事实。这里合成一份 —— `rowIds` 与 `sections`
 * 由**同一次** flatten 产出,结构上不可能漂移。
 *
 * ── 五步,每步一只纯函数,各自有单测(§2)────────────────────────────────
 *  1. `applyScope`     范围过滤(子会话按**父房间**的归属判,不看自己);
 *  2. `attachChildren` work / agent 按 `roomId` 挂到父;父不在集合里 → 回顶层;
 *  3. `bucketize`      顶层行按 `SECTION_BUCKETS` 落桶,`isPinned` 先于时间;
 *  4. `applyQuery`     判父与子;子命中则父**强制展开**(派生态,不落库);
 *  5. `flatten`        展开的父后面紧跟子行,`rowIds` 由此一次产出。
 * ──────────────────────────────────────────────────────────────────────
 */

export interface ListRow {
  /** = session.id。行的身份就是会话的身份,不另造一个坐标。 */
  id: string
  session: SessionSummary
  /** 0 = 顶层,1 = 房间的子行。再深一层要放宽这里 + `attachChildren` 递归。 */
  depth: 0 | 1
  parentId: string | null
  /** 有子行可展开(空房间不画箭头 —— 一个点开什么都没有的箭头是谎话)。 */
  expandable: boolean
  /** 此刻展开着(用户展开的 ∪ 搜索命中强制展开的)。 */
  expanded: boolean
}

export interface ListSection {
  id: string
  label: SectionLabel
  rows: ListRow[]
}

export interface ListModel {
  sections: ListSection[]
  /**
   * 平铺、按屏幕顺序、**只含可见行**(收起来的子行不在里面)。
   *
   * **焦点序列的唯一产地**:`moveFocus` / `treeKey` / `quickLookPrev|Next` /
   * `quickLookNeighbors` / 删除后的夹持全吃它。
   */
  rowIds: string[]
}

export interface ListModelInput {
  sessions: readonly SessionSummary[]
  scope: ProjectScope
  query: string
  expandedRooms: readonly string[]
  now: number
}

/* ── 判据:一条会话命不命中 ───────────────────────────────────────────────── */

function has(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle)
}

/**
 * 一条会话命不命中。看的正是行上与 Quick Look 上写着的那三格:标题、预览、摘要
 * —— 「命中的东西必须看得见」是 F 批的口径,搜的格与画的格是同一批。
 * 摘要缺席(老会话)时它是 null,那一格既不画也不参与判定。
 *
 * ── 诚实缺口:消息正文搜不到 ─────────────────────────────────────────────
 * 后端没有跨会话的内容检索面,前端唯一的替代是把每条会话每一页消息都拉下来
 * 在内存里扫 —— 那是把缺口伪装成功能。留待后批(检索面板另有一条真检索路)。
 *
 * 它住在这只文件里而不是 `transitions.ts`,因为它是**第 4 步的判据**;
 * `transitions` 再导出一次给旧调用点,方向是单向的(transitions → list-model)。
 */
export function sessionMatchesQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    has(session.title, q) ||
    has(session.preview, q) ||
    (session.digest !== null && has(session.digest, q))
  )
}

/* ── 1. 范围过滤 ─────────────────────────────────────────────────────────── */

/**
 * 子会话**按父房间的归属判,不看自己**(§2 步骤 1)。
 *
 * 理由是屏幕:子行不占顶层,它长在父房间那一行下面 —— 父在这一档里、子不在,
 * 展开之后就会出现一条「本不该在这一档里」的行;反过来父不在、子在,那条子行
 * 会成为孤儿冒到顶层,而它的父其实好端端地在别的范围里。归属只有一处产地:父。
 *
 * 父不在这份名册里(级联删了 / 被别的过滤摘了)时按**它自己**判 —— 那时它已经
 * 是一条孤儿顶层行了(见 `attachChildren`),孤儿按自己的事实归档。
 */
export function applyScope(
  sessions: readonly SessionSummary[],
  scope: ProjectScope,
): SessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return sessions.filter((session) => {
    const parent =
      isRoomChildKind(session.kind) && session.roomId ? byId.get(session.roomId) : undefined
    return scopeMatches(scope, parent ?? session)
  })
}

/* ── 2. 挂父 ─────────────────────────────────────────────────────────────── */

export interface SessionTree {
  /** 顶层行(含孤儿),按 updatedAt 倒序。 */
  tops: SessionSummary[]
  /** 房间 id → 它的子行,按 updatedAt 倒序。没有子行的房间不在表里。 */
  children: ReadonlyMap<string, SessionSummary[]>
}

const byRecency = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt

/**
 * `work | agent` 按 `roomId` 挂到父房间;**父不在集合里 → 孤儿回顶层**
 * (用户 09-03 裁决 5:孤儿子会话不静默丢)。
 *
 * 父必须**真的是一间房**才收得下子行:`roomId` 指着一条已经被改成别的形态的
 * 会话时,那条子行同样是孤儿 —— 挂上去的话它会藏在一行永远画不出箭头的行下面。
 */
export function attachChildren(sessions: readonly SessionSummary[]): SessionTree {
  const rooms = new Map<string, SessionSummary>()
  for (const session of sessions) {
    if (isRoomKind(session.kind)) rooms.set(session.id, session)
  }

  const tops: SessionSummary[] = []
  const children = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const parentId = isRoomChildKind(session.kind) ? session.roomId : null
    if (parentId && rooms.has(parentId)) {
      const bucket = children.get(parentId)
      if (bucket) bucket.push(session)
      else children.set(parentId, [session])
      continue
    }
    tops.push(session)
  }

  tops.sort(byRecency)
  for (const bucket of children.values()) bucket.sort(byRecency)
  return { tops, children }
}

/* ── 3. 落桶 ─────────────────────────────────────────────────────────────── */

export interface SectionSlice {
  id: string
  label: SectionLabel
  /** 这一节的顶层行,按 updatedAt 倒序(节内即阅读顺序)。 */
  sessions: SessionSummary[]
}

/**
 * 顶层行按 `SECTION_BUCKETS` 落桶,**`isPinned` 先于时间**(裁决 4:置顶只在
 * 「置顶」那一节出现,不在时间节里重复一次)。
 *
 * 节的次序:置顶 → 表序(今天 / 昨天 / 本周)→ 月桶,最近的月在前。
 * 月桶的次序不用另排一遍 —— 输入按时间倒序,首次遇见的月自然就是最近的那个。
 * 空节不出现(一个「0 条」的节在屏幕上没有任何可看的东西)。
 */
export function bucketize(tops: readonly SessionSummary[], now: number): SectionSlice[] {
  const sorted = [...tops].sort(byRecency)
  const slices = new Map<string, SectionSlice>()
  // 月桶按遇见的次序记一份名单,好在最后按「表序在前、月桶在后」拼回去。
  const monthIds: string[] = []

  for (const session of sorted) {
    const bucket = session.isPinned ? PINNED_SECTION : sectionOf(session.updatedAt, now)
    const slice = slices.get(bucket.id)
    if (slice) {
      slice.sessions.push(session)
      continue
    }
    slices.set(bucket.id, { id: bucket.id, label: bucket.label, sessions: [session] })
    if (bucket.id.startsWith('month:')) monthIds.push(bucket.id)
  }

  const order = [PINNED_SECTION.id, 'today', 'yesterday', 'thisWeek', ...monthIds]
  return order.map((id) => slices.get(id)).filter((slice): slice is SectionSlice => !!slice)
}

/* ── 4. 搜索过滤 ─────────────────────────────────────────────────────────── */

export interface QueryResult {
  sections: SectionSlice[]
  children: ReadonlyMap<string, SessionSummary[]>
  /** 子行命中 → 父**强制展开**。派生态,不落库(清了词房间就该收回去)。 */
  forcedExpanded: ReadonlySet<string>
}

const NO_FORCED: ReadonlySet<string> = new Set()

/**
 * 判父与子(§2 步骤 4)。两种命中,与从前 `filterGroups` 的组名 / 卡两种命中
 * 同一条口径:
 *  · **父命中** → 这一行留下,**子行一条不少**(用户搜到一间房,想看的是这间房
 *    的全部,而不是「房在、里面的活都不见了」);
 *  · **父不命中、有子命中** → 父作为**通路**留下,只留命中的子行,并强制展开
 *    —— 不展开的话屏幕上是一行与词毫无关系的房间,像过滤器坏了。
 *  · 两样都不中 → 整支消失;空掉的节跟着消失。
 *
 * 空词是恒等变换,而且**原样返回同一批引用** —— 不搜那条路上一次多余的分配都
 * 不该有(它是每次渲染、每次按方向键都要走的路)。
 */
export function applyQuery(
  sections: readonly SectionSlice[],
  children: ReadonlyMap<string, SessionSummary[]>,
  query: string,
): QueryResult {
  const q = query.trim()
  if (!q) return { sections: sections as SectionSlice[], children, forcedExpanded: NO_FORCED }

  const kept = new Map<string, SessionSummary[]>()
  const forced = new Set<string>()
  const out: SectionSlice[] = []

  for (const slice of sections) {
    const rows: SessionSummary[] = []
    for (const session of slice.sessions) {
      const kids = children.get(session.id) ?? []
      if (sessionMatchesQuery(session, q)) {
        rows.push(session)
        if (kids.length > 0) kept.set(session.id, kids)
        continue
      }
      const hits = kids.filter((kid) => sessionMatchesQuery(kid, q))
      if (hits.length === 0) continue
      rows.push(session)
      kept.set(session.id, hits)
      forced.add(session.id)
    }
    if (rows.length > 0) out.push({ id: slice.id, label: slice.label, sessions: rows })
  }

  return { sections: out, children: kept, forcedExpanded: forced }
}

/* ── 5. 平铺 ─────────────────────────────────────────────────────────────── */

/**
 * 节内按次序铺行,展开的父后面**紧跟**它的子行;`rowIds` 由这同一次遍历产出
 * —— 「屏幕上有哪些行」与「键盘走哪些行」因此是同一份事实,不是两份对得上的表。
 */
export function flatten(
  sections: readonly SectionSlice[],
  children: ReadonlyMap<string, SessionSummary[]>,
  expanded: ReadonlySet<string>,
): ListModel {
  const out: ListSection[] = []
  const rowIds: string[] = []

  for (const slice of sections) {
    const rows: ListRow[] = []
    for (const session of slice.sessions) {
      const kids = children.get(session.id) ?? []
      const open = kids.length > 0 && expanded.has(session.id)
      rows.push({
        id: session.id,
        session,
        depth: 0,
        parentId: null,
        expandable: kids.length > 0,
        expanded: open,
      })
      rowIds.push(session.id)
      if (!open) continue
      for (const kid of kids) {
        rows.push({
          id: kid.id,
          session: kid,
          depth: 1,
          parentId: session.id,
          expandable: false,
          expanded: false,
        })
        rowIds.push(kid.id)
      }
    }
    out.push({ id: slice.id, label: slice.label, rows })
  }

  return { sections: out, rowIds }
}

/* ── 合成 ────────────────────────────────────────────────────────────────── */

/** 一张空模型的恒等引用 —— 免得每次「一条会话都没有」都换一张新的空表(律④)。 */
export const EMPTY_LIST_MODEL: ListModel = { sections: [], rowIds: [] }

export function buildListModel(input: ListModelInput): ListModel {
  const scoped = applyScope(input.sessions, input.scope)
  const tree = attachChildren(scoped)
  const buckets = bucketize(tree.tops, input.now)
  const filtered = applyQuery(buckets, tree.children, input.query)
  const expanded = new Set<string>(input.expandedRooms)
  for (const id of filtered.forcedExpanded) expanded.add(id)
  return flatten(filtered.sections, filtered.children, expanded)
}

/* ── 取数(纯查表) ──────────────────────────────────────────────────────── */

export function findRow(model: ListModel, id: string | null): ListRow | undefined {
  if (!id) return undefined
  for (const section of model.sections) {
    const row = section.rows.find((r) => r.id === id)
    if (row) return row
  }
  return undefined
}

/** 这一行在焦点序列里的下标;不在屏幕上是 -1(与 `indexOf` 同一口径)。 */
export function rowIndexOf(model: ListModel, id: string | null): number {
  return id ? model.rowIds.indexOf(id) : -1
}
