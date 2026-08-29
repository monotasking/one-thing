import { projectNameOf } from '../expose/projection'
import { splitHighlight } from '../expose/transitions'
import type { SessionChapter, SessionSummary } from '../expose/types'
import { FILES } from './data'
import type { FileMock, SearchOrigin, SearchRow, SearchScope, SearchTarget } from './types'

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
 * expose/transitions.ts 的 searchSessions 上,两个面同一条口径,留待后批。
 * 文件侧仍是 mock(FILES),见 ./data.ts 顶部。
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
  /** 文件侧仍是 mock —— 缺席就用 ./data.ts 那张表。 */
  files?: FileMock[]
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

/** Toast 里那句「已打开 …」的落点,与 fileLine 出处同一个拼法。 */
export function targetText(target: SearchTarget): string {
  return target.kind === 'file'
    ? originText({ kind: 'fileLine', file: fileName(target.path), line: target.line })
    : target.sessionId
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

function fileRows(q: string, files: FileMock[]): SearchRow[] {
  const rows: SearchRow[] = []
  for (const file of files) {
    const ext = fileExt(file.path)
    // 路径命中 = 顶级,和会话标题命中同一级:它说的是「这个东西叫什么」。
    if (has(file.path, q)) {
      rows.push({
        id: `${file.path}:name`,
        domain: 'file',
        badge: { kind: 'file', ext },
        text: fileName(file.path),
        code: false,
        origin: { kind: 'path', path: file.path },
        target: { kind: 'file', path: file.path, line: 1 },
        tier: 'title',
      })
    }
    for (const ln of file.lines) {
      if (!has(ln.text, q)) continue
      rows.push({
        id: `${file.path}:${ln.line}`,
        domain: 'file',
        badge: { kind: 'file', ext },
        text: ln.text,
        // 「文件里的一行」一律等宽 —— 判据是它来自文件,不是它属于哪门语言。
        code: true,
        origin: { kind: 'fileLine', file: fileName(file.path), line: ln.line },
        target: { kind: 'file', path: file.path, line: ln.line },
        tier: 'body',
      })
    }
  }
  return rows
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
  const { sessions, chapters = {}, files = FILES, timeOf } = material
  const fromSessions = scope === 'files' ? [] : sessionRows(q, sessions, chapters, timeOf)
  const fromFiles = scope === 'sessions' ? [] : fileRows(q, files)
  return [
    ...interleave(fromSessions.filter(isTitle), fromFiles.filter(isTitle)),
    ...interleave(fromSessions.filter(isBody), fromFiles.filter(isBody)),
  ]
}

/** 空态列表的长度。再多就不是「最近」了。 */
export const RECENT_LIMIT = 8

/**
 * 词为空时的那张列表:最近会话 + 最近文件混排,**没有任何标题行**。
 * 每一行的解剖与命中行完全一样(徽 + 名称 + 出处),所以视图只有一套行渲染。
 */
export function recentRows(scope: SearchScope, material: SearchMaterial): SearchRow[] {
  const { sessions, files = FILES, timeOf } = material
  const fromSessions: SearchRow[] =
    scope === 'files'
      ? []
      : sessions.map((session) => ({
          id: `${session.id}:recent`,
          domain: 'session',
          badge: { kind: 'session' },
          text: session.title,
          code: false,
          origin: { kind: 'time', time: timeOf(session) },
          target: { kind: 'session', sessionId: session.id },
          tier: 'title',
        }))
  const fromFiles: SearchRow[] =
    scope === 'sessions'
      ? []
      : files.map((file) => ({
          id: `${file.path}:recent`,
          domain: 'file',
          badge: { kind: 'file', ext: fileExt(file.path) },
          text: fileName(file.path),
          code: false,
          origin: { kind: 'path', path: file.path },
          target: { kind: 'file', path: file.path, line: 1 },
          tier: 'title',
        }))
  return interleave(fromSessions, fromFiles).slice(0, RECENT_LIMIT)
}
