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
 *     是工作目录里随便前 N 个文件,把它叫「最近」就是编。所以 `browseRows` 的
 *     文件侧恒空,面板据此说一句「文件要先输入关键词」。
 *
 *     **09-01 复核**(用户报障「空词只列 8 条」时一并核过):这条判例说的是
 *     「不许伪造一张最近打开的文件表」,**不是**「文件档不许浏览」。真要浏览,
 *     缺的是一个「列出这个根下全部文件」的产地 —— `files.list` 只在带 query 时
 *     才有意义(空 query 直接被数据源短路成 idle,见 data/files-source.ts)。
 *     缺口还在,如实说,不补假的。
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

/*
 * ↑↓ 走行的 `moveRow` 在这里退役(09-02 清尸):09-01 批 4 把检索面的走行迁进了
 * `ui/a11y/list-selection` 的 `useListSelection`(`loop: false` 那一档就是它
 * 原来那次夹),之后这个函数只剩自己的单测吊着 —— 零产品消费者。
 * 「到端点就停、不回卷」那条判据没有丢,它现在写在原语那一侧。
 */

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

/* ── 分页 ──────────────────────────────────────────────────────────────────
 *
 * ## 为什么是「递增 limit 重查」而不是真游标
 *
 * 两个产地都没有游标,也都不下发命中总数:
 *  - 文件侧 `files.list`(`@shared/ipc/files.ts` 的 `FilesListRequest`)只有
 *    `limit` 一格;后端 `listOnethingFileSearchEntries` 数到 limit 就 break,
 *    回执里没有 total。
 *  - 后端那个 `search` 域(`@shared/ipc/search.ts` 的 `SearchRequest`)同样
 *    只有 `limit`,而且这块面板根本没用它。
 * 于是分页只能是**要更多**:第 n 页带一个更大的 limit 从头重查一遍。
 * **代价如实记在这里**:每翻一页都是一次全量重拉再截断,不是增量取。
 * 后端补游标(以及下发 total)属另拍,不在本批。
 *
 * ## 「取尽」的唯一判据
 *
 * 没有 total,就只能用**回来的条数 < 要的条数**。等号成立时后端只是说
 * 「我给满了」,不是说「没有了」—— 所以那一刻不许写「已全部显示」。
 *
 * ## 会话侧不发请求,但**照样分页**
 *
 * 会话侧的素材(整张 listMeta)本来就全量在手,`searchRows` / `browseRows` 造出来的
 * 会话行一条不少。所以分页在会话侧纯粹是**窗口**:翻页只是把窗口拉大,不发请求。
 * 「不发请求」不等于「不分页」—— 500 条会话一次性铺满 DOM 是另一种病。
 *
 * ## 空词 = 浏览态,同一套机件(09-01 用户裁定)
 *
 * 从前空词那张列表叫「最近」,硬截 8 条、没有读数、没有翻页 —— 用户的原话是
 * 「我要能够在这里面看到所有的条数,所有的记录,要能够翻页」。所以空词现在是
 * **浏览全部会话**:同一个 `pageWindow`、同一条底部 item、同一张 `moreState` 判据表。
 * 没有第二套分页机件,也没有第二个「一页多少条」的常量。
 */

/** 首屏默认给多少条。 */
export const SEARCH_FIRST_PAGE = 20

/** 每按一次「加载更多」再放出多少条(同时也是文件侧 limit 的增量)。 */
export const SEARCH_PAGE_SIZE = 20

/** 第 n 页(从 1 数)的窗口大小 = 首屏 + 之后每页的增量。 */
export function pageWindow(page: number): number {
  return SEARCH_FIRST_PAGE + Math.max(page - 1, 0) * SEARCH_PAGE_SIZE
}

/**
 * 文件侧那一半此刻的处境。**四态,不是三个布尔** —— 「还在路上」与「给满了」
 * 与「取尽了」是三件不同的事,合成布尔就得在读的地方再拼一次。
 */
export type SearchFileSide =
  /** 取尽了(或这一档根本不看文件):后面没有了。 */
  | 'exhausted'
  /** 给满了(回来的条数 == 要的条数):后面**可能**还有,但没人说过有。 */
  | 'more'
  /** 还在路上 / 还没发。 */
  | 'pending'
  /** 这一次塌了。 */
  | 'failed'

/**
 * 列表底部那条 item 的处境。它是**一条 item**,不是一颗悬浮按钮 ——
 * 所以「没有它」也是一种正经状态('none'),而不是把它画成禁用态占着位置。
 *
 * 'none' 现在**只剩「一条都没有」这一格**(09-01 裁定):空词不再是「没在搜」,
 * 它是浏览态,一样有读数一样能翻页 —— 只要屏幕上有行,底下就一定有一行东西可读。
 */
export type SearchMore =
  | { kind: 'none' }
  /** 还能再要。`total` 只有在文件侧取尽时才知道 —— 不知道就是 null,不猜。 */
  | { kind: 'more'; shown: number; total: number | null }
  | { kind: 'loading' }
  | { kind: 'error' }
  /** 取尽了:「共 N 条 · 已全部显示」。非交互读数,第一页就取尽也算数。 */
  | { kind: 'end'; total: number }
  /**
   * 文件侧还没落定,而会话侧那份数已经定了:先如实报**此刻已经在屏幕上的条数**。
   * 非交互读数 —— 它既不许诺「还有更多」(文件侧没说过话),也不说「全都在这了」
   * (那要等文件侧取尽)。用「已显示」而不是「共」正是这个区别:
   * 「共」是一句关于总数的断言,这一刻还没人有资格下。
   */
  | { kind: 'count'; shown: number }

export interface SearchMoreInput {
  /**
   * 此刻有没有词。
   *
   * 它**不再决定「有没有底部这一行」**(那是 09-01 之前的读法),只决定
   * 「还有没有更多」这件事去问谁:搜索态问文件侧那四态,浏览态谁都不用问 ——
   * 行全部来自会话侧,而会话侧整张表在手,后面有没有当场就知道。
   */
  searching: boolean
  /** 第几页,从 1 数。 */
  page: number
  /** 此刻**造得出来**的全部行数(受当前 limit 约束的那一份)。 */
  total: number
  files: SearchFileSide
}

/**
 * ## 底部那一行是**常驻读数**,不是「翻过页才出现的东西」(08-31 拍板)
 *
 * 从前这里有一条「第一页装得下就什么都不画」的判据:理由是那条 item 长得像按钮,
 * 一按不动的按钮比一句话更让人犹豫。**这条理由被推翻了** —— 它把「有几条」这件
 * 用户随时想知道的事,变成了「翻过页的人才配知道」:第一页装得下(绝大多数搜索
 * 都是)时屏幕上一个数都没有,「共 N 条」只在翻页之后才现身。
 *
 * 新裁定:**只要有行,底下就一直有一行东西可读**。它是按钮还是读数由处境决定,
 * 而不是由「有没有翻过页」决定。
 *
 * ## 09-01 第二次收窄:空词是浏览态,不是「没在搜」
 *
 * 从前 `searching: false` 直接落 'none' —— 于是空词那张列表既没有总数也没法翻页
 * (用户报障:「只列 8 条、没有读数、不能翻页」)。裁定:**空词与搜索态走同一族**。
 * 判据表因此只多一句翻译,不多一条支路:浏览态的行全部来自会话侧,而会话侧
 * 整张表在手 —— 所以它在这张表里就是**恒定的 `exhausted`**(后面确实没有了)。
 * 于是 count / end / 加载更多逐格复用,没有第二套。
 *
 * | 行数  | searching | page | files      | 结果      | 屏幕上                       |
 * | ---   | ---       | ---  | ---        | ---       | ---                          |
 * | 0 条  | 任意      | 任意 | 任意       | `none`    | 什么都不画                    |
 * | >0    | 空词      | 任意 | (不问)    | 同 exhausted 那两格 | 「加载更多 · 已显示 a / 共 b」或「共 N 条 · 已全部显示」 |
 * | >0    | 搜索态    | >1   | failed     | `error`   | 「没加载成,点一下重试」(可按) |
 * | >0    | 搜索态    | >1   | pending    | `loading` | 「加载中…」                    |
 * | 窗口装不下(shown<total) | 任意 | 任意 | exhausted | `more`(带 total) | 「加载更多 · 已显示 a / 共 b」 |
 * | 窗口装不下        | 搜索态 | 任意 | 其余       | `more`(total=null) | 「加载更多」            |
 * | 全装下            | 任意   | 任意 | exhausted  | `end`     | 「共 N 条 · 已全部显示」(读数) |
 * | 全装下            | 搜索态 | 1    | pending    | `count`   | 「已显示 N 条」(读数)         |
 * | 全装下            | 搜索态 | 任意 | more/failed | `more`(total=null) | 「加载更多」            |
 *
 * 两处**没有**跟着改的地方,理由都还成立:
 *  - 文件侧 pending 的第一页**仍然不许诺**「加载更多」:那一句是在说「后面还有」,
 *    而这一刻没人说过有;每敲一个字母闪一下它就是噪音。改的只是那一格从「什么都
 *    不画」变成「照实报此刻的条数」—— 报数不是许诺,而且这个数是**会话侧已经定了
 *    的那一份**(文件侧此刻恒空,不猜它)。
 *  - failed 的语义一格没动:第一页塌了那次,「没搜成」归列表上面那行,而这条 item
 *    是「再试一次」的落点(所以它是可按的 `more`,不是读数)。
 */
export function moreState({ searching, page, total, files }: SearchMoreInput): SearchMore {
  if (total === 0) return { kind: 'none' }
  /*
   * 浏览态(空词)的行全部来自会话侧,而会话侧整张 listMeta 在手 ——
   * 「后面还有没有」这件事当场就知道,而且答案永远是「没有了」。所以这里不是
   * 一条支路,是**一次翻译**:把浏览态翻成文件侧那四态里的 'exhausted',
   * 下面每一格照旧,count / end / 加载更多一格都不用重写。
   */
  const side = searching ? files : 'exhausted'
  /*
   * 加载中 / 失败这两种只在**翻过页之后**才由这条 item 来说。
   * 第一页那次失败归列表上面那行(`search.filesFailed`)—— 一次失败说两遍
   * 是噪音;而「重试」这个动作在翻页之后才落在这条 item 身上。
   */
  if (page > 1) {
    if (side === 'failed') return { kind: 'error' }
    if (side === 'pending') return { kind: 'loading' }
  }
  const shown = Math.min(total, pageWindow(page))
  if (shown < total) return { kind: 'more', shown, total: side === 'exhausted' ? total : null }
  // 窗口已经装下此刻的全部行 —— 还有没有更多,只有文件侧那一边知道。
  // 取尽 = 后面没有了,这就是最终那个数,**第一页就取尽也算数**。
  if (side === 'exhausted') return { kind: 'end', total }
  /*
   * 还没落定:不许诺「还有更多」,但照实报此刻的条数(page > 1 的 pending 已经
   * 在上面被 'loading' 截走了,所以走到这里的一定是第一页)。
   */
  if (side === 'pending') return { kind: 'count', shown }
  /*
   * 剩下两种('more' = 给满了,'failed' = 第一页那次塌了)都是**不知道后面还有没有**,
   * 于是照旧给一条能按的 item,总数写 null。第一页塌了那次尤其要给 ——
   * 上面那行只是把失败说出来,而「再试一次」这个动作得有地方按。
   */
  return { kind: 'more', shown, total: null }
}

/**
 * 词为空时的那张列表:**全部会话**,没有任何标题行。
 * 每一行的解剖与命中行完全一样(徽 + 名称 + 出处),所以视图只有一套行渲染。
 *
 * ── 09-01:这里**不再截断**(用户裁定) ──────────────────────────────────
 * 从前它叫 `recentRows`,尾巴上挂一句 `.slice(0, RECENT_LIMIT)`,屏幕上恒定 8 条,
 * 没有总数、没有下一页。用户的原话:「我要能够在这里面看到所有的条数,所有的记录,
 * 要能够翻页」。所以名字与行为一起改:它是**浏览**,不是「最近」。
 *
 * 截断这件事从此只发生在**一个地方** —— 渲染层的 `rows.slice(0, pageWindow(page))`,
 * 与搜索态逐字同一行代码。数据层交出去的永远是完整的那一份,否则「共 N 条」就是假的
 * (报一个自己刚截过的数)。
 *
 * **次序照现状**:入参 `sessions` 是数据源交下来的那一份(`sessions.listMeta` 的
 * 次序),这里一次都不重排 —— 与从前那 8 条的取法逐字相同,只是不再切掉后面的。
 *
 * 文件侧在这里是空的,而且**不是暂时**空:见文件头第 2 条 ——
 * 「最近打开的文件」在后端没有产地。所以这里连 `files` 都不读。
 */
export function browseRows(scope: SearchScope, material: SearchMaterial): SearchRow[] {
  const { sessions, timeOf } = material
  if (scope === 'files') return []
  return sessions.map<SearchRow>((session) => ({
    id: `${session.id}:browse`,
    domain: 'session',
    badge: { kind: 'session' },
    text: session.title,
    code: false,
    origin: { kind: 'time', time: timeOf(session) },
    target: { kind: 'session', sessionId: session.id },
    tier: 'title',
  }))
}
