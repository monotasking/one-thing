import type { FileSearchEntry } from '@shared/ipc/files'
import { projectNameOf } from '../expose/projection'
import { splitHighlight } from '../expose/transitions'
import type { SessionChapter, SessionSummary } from '../expose/types'
import type { SearchOrigin, SearchRow, SearchScope, SearchTarget } from './types'

/**
 * 检索面的全部逻辑。纯函数,不认识 React —— 组件只负责画。
 *
 * 高亮切片**直接复用** expose/transitions 的 splitHighlight(下面原样再导出),
 * 不复制一份:两个面上「什么算命中」必须是同一件事,否则迟早漂移。
 *
 * ── D1:会话侧接真数据 ───────────────────────────────────────────────────
 * 素材从参数进来(mock 默认值全部退役,只剩文件侧的 FILES 还是 mock)。会话侧
 * 能搜到的三样东西各有产地:
 *  - 标题:`SessionMeta.name`(listMeta,整表在手,即时滤);
 *  - 预览:`SessionMeta.previewText`(同上);
 *  - 章节:`sessions.getSegments`,**按需**拉、拉过就缓存 —— 所以这里收的是
 *    「已经到手的那份缓存」,而不是一个会去发请求的取数函数。
 *
 * **消息正文搜不到**(诚实缺口):后端没有跨会话内容检索面,判据写在
 * expose/transitions.ts 的 sessionMatchesQuery 上,两个面同一条口径,留待后批。
 *
 * ── D5:文件侧接真数据(`./data.ts` 那张 mock 表连同文件一起退役) ────────
 * 素材从 `files.list` 来(数据源 `data/files-source.ts` 的 `searchHits`),
 * 由渲染层递进 `material.files`。这一侧因此**不再有默认值**:缺席 = 一条都没有,
 * 而不是掉回一张假表。
 *
 * 真实产地是「**按名字找文件**」,不是按内容搜,于是换真之后少了两样东西 ——
 * 两样都是可感知的行为变化,记在这里而不是悄悄改掉:
 *
 *  1. **没有「命中的那一行」**。旧 mock 每个文件带三条 `{line, text}` 假代码行;
 *     行号与行文在真实产地上一个都不存在,所以它们连同 `FileMock` /
 *     `FileLineMock` 一起删掉,而不是拿 `line: 1` 去顶一个假行号(与 D1 那条
 *     「映射不到的旧 mock 字段删掉而不是留空壳」是同一条纪律)。文件侧因此
 *     只剩 title 级的行 —— body 级在这个产地上根本不存在。
 *     要真的按内容搜,缺的是一个跨目录内容检索面(rg --json / 索引器);
 *     后端的 `search` 域是**网页搜索**不是文件搜索。缺口还在,只是小了一圈:
 *     现在缺的是「行」,不是「文件」。
 *  2. **空词时没有文件行**。「最近打开的文件」在后端没有产地;空词去 list 拿回来的
 *     是工作目录里随便前 N 个文件,把它叫「最近」就是编。所以 `recentRows` 的
 *     文件侧恒空,面板据此说一句「文件要先输入关键词」。
 */
export { splitHighlight }

/**
 * 两个出口共用的素材袋。它是一个**参数**而不是四个位置参数,理由很实际:
 * 会话侧从此有三样东西(表 / 章节缓存 / 时间拼法),再摊成位置参数,调用点就成了
 * 一串谁也认不出的实参。
 */
export interface SearchMaterial {
  sessions: SessionSummary[]
  /** 已经拉到手的按会话章节缓存;缺席 = 一条都还没拉过。 */
  chapters?: Record<string, SessionChapter[]>
  /**
   * `files.list` 这一次交回来的命中(`data/files-source.ts` 的 `searchHits`)。
   * **缺席 = 一条都没有**,不是「掉回一张假表」—— mock 已经退役。
   */
  files?: readonly FileSearchEntry[]
  /** 相对时间的成品句子(要查字典,所以由渲染层递进来)。 */
  timeOf: (session: SessionSummary) => string
}

/* ── scope ────────────────────────────────────────────────────────────── */

/** 轮转次序 = 分段器上的次序,只此一处。 */
export const SCOPES: SearchScope[] = ['all', 'sessions', 'files']

/** Tab 往前、⇧Tab 往后,到头回卷。 */
export function nextScope(scope: SearchScope, step: 1 | -1): SearchScope {
  const at = SCOPES.indexOf(scope)
  return SCOPES[(at + step + SCOPES.length) % SCOPES.length]
}

/**
 * ↑↓ 走行:**夹住两端,不回卷**。列表是一条有始有终的东西,
 * 在第一行按 ↑ 回到最后一行会让「我在哪」这件事丢失。
 */
export function moveRow(index: number, step: 1 | -1, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(index + step, 0), count - 1)
}

/* ── 路径拆解 ──────────────────────────────────────────────────────────── */

export function fileName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

/** 徽上那两三个字母。没有扩展名就把整个名字大写 —— 不造「未知」这种文案。 */
export function fileExt(path: string): string {
  const name = fileName(path)
  const at = name.lastIndexOf('.')
  return (at <= 0 ? name : name.slice(at + 1)).toUpperCase()
}

/* ── 出处 ──────────────────────────────────────────────────────────────── */

/**
 * 行尾那行灰字的拼法只在这里定一次。
 * 分隔符是**标点**不是文案(换语言不该变),所以纯函数可以给;
 * 真·文案(徽上的「会话」「消息」)一个字都不在这里。
 */
export function originText(origin: SearchOrigin): string {
  switch (origin.kind) {
    case 'session':
      return origin.session
    case 'fileLine':
      return `${origin.file}:${origin.line}`
    case 'projectTime':
      return `${origin.project} · ${origin.time}`
    case 'time':
      return origin.time
    case 'path':
      return origin.path
  }
}

/**
 * 通知里那句「已打开 …」的落点。
 *
 * 带行号时与 fileLine 出处同一个拼法;不带(D5 之后的常态 —— 真实产地给不出行号)
 * 就是整条路径 —— **不补一个 `:1` 去凑格式**,那会让人以为后端说了它在第一行。
 */
export function targetText(target: SearchTarget): string {
  if (target.kind !== 'file') return target.sessionId
  return target.line === undefined
    ? target.path
    : originText({ kind: 'fileLine', file: fileName(target.path), line: target.line })
}

/* ── 造行 ──────────────────────────────────────────────────────────────── */

function has(text: string, q: string): boolean {
  return text.toLowerCase().includes(q)
}

/**
 * 会话标题命中的出处:项目名 · 时间;不属于任何项目就只剩时间。
 *
 * 时间在这一层是**已经拼好的那句话**:相对时间要查字典(见
 * expose/components/session-time.ts),纯函数不产界面字符串,所以由调用方递进来。
 */
function sessionHead(session: SessionSummary, time: string): SearchOrigin {
  return session.projectId
    ? { kind: 'projectTime', project: projectNameOf(session.projectId), time }
    : { kind: 'time', time }
}

function sessionRows(
  q: string,
  sessions: SessionSummary[],
  chapters: Record<string, SessionChapter[]>,
  timeOf: (session: SessionSummary) => string,
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const session of sessions) {
    const target: SearchTarget = { kind: 'session', sessionId: session.id }
    const inSession: SearchOrigin = { kind: 'session', session: session.title }

    // 标题命中 = 顶级:整条会话就叫这个名字。
    if (has(session.title, q)) {
      rows.push({
        id: `${session.id}:title`,
        domain: 'session',
        badge: { kind: 'session' },
        text: session.title,
        code: false,
        origin: sessionHead(session, timeOf(session)),
        target,
        tier: 'title',
      })
    }
    // 预览是会话**内容**(第一条用户消息的截断),所以它是「消息」徽、正文级 ——
    // 不因为挂在会话头上就升级。
    if (session.preview && has(session.preview, q)) {
      rows.push({
        id: `${session.id}:preview`,
        domain: 'session',
        badge: { kind: 'message' },
        text: session.preview,
        code: false,
        origin: inSession,
        target,
        tier: 'body',
      })
    }
    for (const chapter of chapters[session.id] ?? []) {
      if (has(chapter.title, q)) {
        rows.push({
          id: `${session.id}:chapter:${chapter.id}:title`,
          domain: 'session',
          badge: { kind: 'message' },
          text: chapter.title,
          code: false,
          origin: inSession,
          target,
          tier: 'title',
        })
      }
      if (has(chapter.detail, q)) {
        rows.push({
          id: `${session.id}:chapter:${chapter.id}:detail`,
          domain: 'session',
          badge: { kind: 'message' },
          text: chapter.detail,
          code: false,
          origin: inSession,
          target,
          tier: 'body',
        })
      }
    }
  }
  return rows
}

/**
 * 一条真命中 → 一行。
 *
 * **这里不再过滤**:后端已经按 query 滤过了(`files.list` 收 query),
 * 壳再滤一遍就是两个产地各说一次「什么算命中」—— 迟早漂移。会话侧要在本地滤
 * 是因为它的素材(整张 listMeta)本来就是全量的;文件侧的素材是一次带词的查询。
 *
 * 命中一律 title 级:一条文件命中说的是「这个东西叫什么」,与会话标题命中同级。
 */
function fileRows(files: readonly FileSearchEntry[]): SearchRow[] {
  return files.map((entry) => ({
    id: `file:${entry.path}`,
    domain: 'file',
    badge: { kind: 'file', ext: fileExt(entry.path) },
    // `label` 是接入目录那类命中自带的显示名(后端给的数据);没有就用文件名。
    text: entry.label ?? fileName(entry.path),
    // 文件**名**不是代码行,不上等宽 —— 等宽留给真的来自文件正文的那一行。
    code: false,
    origin: { kind: 'path', path: entry.path },
    target: { kind: 'file', path: entry.path },
    tier: 'title',
  }))
}

/**
 * 交替取:这就是「不按类型分堆」那句话的实现。
 * 两侧各自保持自己那张表的次序,谁先谁后只由「第几个」决定。
 */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i])
    if (i < b.length) out.push(b[i])
  }
  return out
}

const isTitle = (r: SearchRow) => r.tier === 'title'
const isBody = (r: SearchRow) => r.tier === 'body'

/* ── 两个出口 ──────────────────────────────────────────────────────────── */

/**
 * 有词时的那张平铺列表。排序只有一刀:title 级整段在前,body 级整段在后;
 * 每一段里会话与文件交替 —— 所以列表里没有任何「一堆会话之后一堆文件」的地形。
 */
export function searchRows(
  query: string,
  scope: SearchScope,
  material: SearchMaterial,
): SearchRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const { sessions, chapters = {}, files = [], timeOf } = material
  const fromSessions = scope === 'files' ? [] : sessionRows(q, sessions, chapters, timeOf)
  const fromFiles = scope === 'sessions' ? [] : fileRows(files)
  return [
    ...interleave(fromSessions.filter(isTitle), fromFiles.filter(isTitle)),
    ...interleave(fromSessions.filter(isBody), fromFiles.filter(isBody)),
  ]
}

/** 空态列表的长度。再多就不是「最近」了。 */
export const RECENT_LIMIT = 8

/**
 * 词为空时的那张列表:**只有最近会话**,没有任何标题行。
 * 每一行的解剖与命中行完全一样(徽 + 名称 + 出处),所以视图只有一套行渲染。
 *
 * 文件侧在这里是空的,而且**不是暂时**空:见文件头第 2 条 ——
 * 「最近打开的文件」在后端没有产地。所以这里连 `files` 都不读。
 */
export function recentRows(scope: SearchScope, material: SearchMaterial): SearchRow[] {
  const { sessions, timeOf } = material
  if (scope === 'files') return []
  return sessions
    .map<SearchRow>((session) => ({
      id: `${session.id}:recent`,
      domain: 'session',
      badge: { kind: 'session' },
      text: session.title,
      code: false,
      origin: { kind: 'time', time: timeOf(session) },
      target: { kind: 'session', sessionId: session.id },
      tier: 'title',
    }))
    .slice(0, RECENT_LIMIT)
}
