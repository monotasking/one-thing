import type { FileSearchEntry } from '@shared/ipc/files'
import type { SearchResult } from '@shared/ipc/search'
import { projectNameOf } from '../expose/projection'
import { splitHighlight } from '../expose/transitions'
import type { SessionChapter, SessionSummary } from '../expose/types'
import { ALL_TAB } from './capabilities'
import { CHATS_CAPABILITY, FILES_CAPABILITY, MESSAGES_CAPABILITY } from './sources'
import type {
  MessageHit,
  SearchOrigin,
  SearchRow,
  SearchScope,
  SearchTarget,
} from './types'

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
 * ── 09-02:正文接上了,那句「诚实缺口」是错的 ────────────────────────────
 * 这里从前写着一句「**消息正文搜不到**(诚实缺口):后端没有跨会话内容检索面」。
 * **那句话在写下的时候就不对**,而它正是用户报障「搜索有问题,有些 message
 * 搜索不到」的第一半病根:后端一直有 —— `@shared/ipc/search.ts` 的 `searchRouter`
 * (`category:'messages'`)、`runtime/src/search/providers.ts` 的 `searchMessages`
 * (逐会话读消息 `content` 做 indexOf,回执带 `sessionId` / `messageId` /
 * `matchRanges` 与一段截断片段)。缺的是壳这一侧没有接。
 *
 * 接上之后,这张表**现在的实情**是:
 *
 * | 搜得到 | 产地 | 怎么滤 |
 * | --- | --- | --- |
 * | 会话标题 | `SessionMeta.name` | 本地(整张 listMeta 在手) |
 * | 会话预览(首条用户消息的截断) | `SessionMeta.previewText` | 本地 |
 * | 章节标题 / 摘要 | `sessions.getSegments`(按需拉、拉过就缓存) | 本地 |
 * | **消息正文** | `search.query` 的 `category:'messages'` | **后端**(`data/message-search-source.ts`) |
 * | 文件名 | `files.list` | 后端 |
 *
 * | 还搜不到 | 为什么 |
 * | --- | --- |
 * | 文件**内容**的那一行 | `files.list` 是按名字找文件,给不出行号与行文(见下面 D5 那一节) |
 * | ~~归档会话里的消息~~ | **S3b 起搜得到了**(索引照建归档会话的文档,那正是 S3b 治好的病)。壳这边按命中带回来的 `facets.archived` 画一颗「已归档」徽 —— 搜得到但要看得出来 |
 * | 别的工作区的消息 | 后端搜的是整台机器,而这块面画的是**当前空间**那一份;命中按会话表投影(见 `messageRows`) |
 * | 消息里的工具调用 / 思考 / 附件文本 | 后端只看消息的 `content` 那一格 |
 * | 正文命中的**总数** | 后端不下发 total,也没有游标(见下面「分页」一节) |
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
  /**
   * `search.query`(`category:'messages'`)这一次交回来的正文命中
   * (`data/message-search-source.ts`)。**缺席 = 一条都没有**。
   */
  messages?: readonly MessageHit[]
  /** 相对时间的成品句子(要查字典,所以由渲染层递进来)。 */
  timeOf: (session: SessionSummary) => string
}

/* ── 档位 ──────────────────────────────────────────────────────────────── */

/*
 * 从前这里有一张 `SCOPES = ['all','sessions','files']` 与一只 `nextScope`。
 * **S4a 两个都搬走了**:档位由 `search.capabilities` 回来的自述算出来
 * (`./capabilities.ts` 的 `tabsOf` / `nextTab`),这个文件因此不再知道
 * 「一共有哪几档」—— 它只知道「这一行是哪个能力产的」(`SearchRow.capability`),
 * 过滤就是拿它和当前档比一下。§4.0 那张枚举点清账表的最后一行。
 */

/** 这一行在当前档里出不出。`all` 不挑,单类档只要那一个能力产的行。 */
function inScope(scope: SearchScope, capability: string): boolean {
  return scope === ALL_TAB || scope === capability
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
  const payload = (target.payload ?? {}) as { filePath?: string; line?: number; sessionId?: string }
  if (typeof payload.filePath !== 'string') return payload.sessionId ?? ''
  return payload.line === undefined
    ? payload.filePath
    : originText({ kind: 'fileLine', file: fileName(payload.filePath), line: payload.line })
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

/**
 * 把后端那批正文命中按会话归堆。**只此一次**,不是每条会话再扫一遍整表 ——
 * 命中最多几十条、会话可能几百条,乘起来就是一次纯粹白烧的 O(n·m)。
 */
function hitsBySession(messages: readonly MessageHit[]): Map<string, MessageHit[]> {
  const map = new Map<string, MessageHit[]>()
  for (const hit of messages) {
    const bucket = map.get(hit.sessionId)
    if (bucket) bucket.push(hit)
    else map.set(hit.sessionId, [hit])
  }
  return map
}

/**
 * 去重用的归一:把两头的省略号与首尾空白削掉,内部连续空白压成一个空格。
 *
 * 两边都是**同一段原文的不同截法**:预览是 `SessionMeta.previewText`
 * (第一条用户消息的截断),片段是后端在命中前后各留一段截出来的
 * (`providers.ts` 的 `searchMessages`,两头按需补 `...`)。所以比之前得先把
 * 各自的截断痕迹去掉,否则一句话的两种截法永远互不包含。
 */
function coreText(text: string): string {
  return text
    .replace(/^(\.{3}|…)+/, '')
    .replace(/(\.{3}|…)+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 归一之后短到这个长度以下就不做包含判定 —— 太短的串谁都包含得了。 */
const DEDUP_MIN = 8

/**
 * 这条正文命中说的是不是**预览那一段**。
 *
 * 用途只有一个:预览行与正文行同时命中同一条消息时去掉一行(预览命中的正是
 * **第一条用户消息**,而正文行是它更精确的那一份 —— 带 messageId、能滚过去)。
 *
 * 判据是**两段归一之后互相包含**,不是「这条会话有正文命中就把预览删掉」:
 * 后者在 limit 截断时会把「第一条消息也命中了」这件事整条抹掉(那条命中没回来,
 * 预览行又被删了,于是屏幕上一行都不剩)。判不出来的时候**两行都留** ——
 * 多一行是噪音,少一行是丢信息。
 */
function coversPreview(preview: string, hitText: string): boolean {
  const a = coreText(preview)
  const b = coreText(hitText)
  if (!a || !b) return false
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  if (shorter.length < DEDUP_MIN) return false
  return a.includes(b) || b.includes(a)
}

function sessionRows(
  q: string,
  sessions: SessionSummary[],
  chapters: Record<string, SessionChapter[]>,
  messages: readonly MessageHit[],
  timeOf: (session: SessionSummary) => string,
): SearchRow[] {
  const rows: SearchRow[] = []
  const bySession = hitsBySession(messages)
  for (const session of sessions) {
    const target: SearchTarget = { kind: 'chat', payload: { sessionId: session.id } }
    const inSession: SearchOrigin = { kind: 'session', session: session.title }
    /*
     * 正文命中**按会话归到这里**,而不是另起一路再和会话侧交替。
     *
     * 判据是「它是谁的内容」:一条正文命中说的是**这条会话里的一句话**,
     * 与预览 / 章节是同一类东西(都挂 `inSession` 出处、都是 body 级)。
     * 另起一路的话,同一条会话的四种命中会散在列表的四个地方 —— 而这张表
     * 本来就按会话的次序走,归堆之后一条会话的东西是连着的,扫得动。
     *
     * 「不按类型分堆」那条说的是**会话侧与文件侧**(interleave 那一手),
     * 不是「会话侧内部也要打散」。
     */
    const hits = bySession.get(session.id) ?? []

    // 标题命中 = 顶级:整条会话就叫这个名字。
    if (has(session.title, q)) {
      rows.push({
        id: `${session.id}:title`,
        capability: CHATS_CAPABILITY,
        domain: 'session',
        text: session.title,
        code: false,
        origin: sessionHead(session, timeOf(session)),
        target,
        tier: 'title',
      })
    }
    // 预览是会话**内容**(第一条用户消息的截断),所以它是「消息」徽、正文级 ——
    // 不因为挂在会话头上就升级。
    //
    // 09-02:同一条消息已经由正文那一路给出来时,这一行让位 —— 那一份带
    // messageId(点了能滚到那条消息),而这一份只能落到会话头上。
    if (
      session.preview
      && has(session.preview, q)
      && !hits.some((hit) => coversPreview(session.preview, hit.text))
    ) {
      rows.push({
        id: `${session.id}:preview`,
        capability: CHATS_CAPABILITY,
        domain: 'session',
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
          capability: CHATS_CAPABILITY,
          domain: 'session',
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
          capability: CHATS_CAPABILITY,
          domain: 'session',
          text: chapter.detail,
          code: false,
          origin: inSession,
          target,
          tier: 'body',
        })
      }
    }
    /*
     * 正文命中(09-02)。**这里不再滤一遍**:后端已经按词判过了 —— 壳再 indexOf
     * 一次就是两个产地各说一次「什么算命中」(后端的 `normalizeQuery` 剥掉了开头的
     * `>` 与 `/`,本地那一遍不会)。与文件侧那条判据逐字同源。
     *
     * 高亮同理:切片用后端给的 `ranges`,不用当前的词现算(`SearchRow.highlight`)。
     *
     * 出处是**所属会话名**(与预览 / 章节同一形),不是后端回执里的 `subtitle` ——
     * 会话名的产地是壳里那张会话表(改名走 SSE 增量),留两个产地必然漂。
     */
    for (const hit of hits) {
      rows.push({
        id: hit.id,
        // 正文命中是 **messages** 那个能力产的 —— 它归到会话下面是**版式**
        // (一间会话的东西连着好扫),不是分类:单类档 `messages` 要的正是这一批。
        capability: MESSAGES_CAPABILITY,
        domain: 'session',
        text: hit.text,
        // 消息正文是散文不是代码行,不上等宽 —— 与预览 / 章节同一档。
        code: false,
        origin: inSession,
        target: { kind: 'message', payload: { sessionId: session.id, messageId: hit.messageId } },
        tier: 'body',
        highlight: hit.ranges,
        // 后端给的那几格原样驮着;壳按它认得的两个键画徽(§9「徽」)。
        ...(hit.facets === undefined ? {} : { facets: hit.facets }),
      })
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
    capability: FILES_CAPABILITY,
    domain: 'file',
    // `label` 是接入目录那类命中自带的显示名(后端给的数据);没有就用文件名。
    text: entry.label ?? fileName(entry.path),
    // 文件**名**不是代码行,不上等宽 —— 等宽留给真的来自文件正文的那一行。
    code: false,
    origin: { kind: 'path', path: entry.path },
    target: { kind: 'file', payload: { filePath: entry.path } },
    tier: 'title',
  }))
}

/**
 * **通用一档的结果 → 行**(S4a)。
 *
 * 壳没有自带产地的那几类(`prompts` / `daily` / `actions`,以及任何一个插件能力)
 * 走的是 `search.query` 那条通用口,回来的是契约上的 `SearchResult`。这只函数是
 * 那条口**唯一**的一次投影,判据三条:
 *
 *  1. **`target` 缺席的行不出**。开放形的落点是这一整套的地基:没有它,点了就是
 *     一行按不动的东西。丢掉一行比画一行死的诚实(与正文那一路 `toHits` 里
 *     「缺 sessionId 就丢」是同一条判据)。
 *  2. **一律 title 级**。这些命中说的都是「这个东西叫什么」(一条命令、一条提示词、
 *     一篇笔记),与会话标题命中同级;body 级留给真的来自正文的那一行。
 *  3. **`domain` 取 `'file'`**。这一格今天只有一处消费 —— 排序时会话与文件交替
 *     (`interleave`),那是**版式**不是分类。归到文件那一侧是因为它们与文件行
 *     一样是「一个东西」而不是「一句话」;真要按能力分组是 `all` 档的事(§7.2),
 *     不在这一层。
 *
 * 高亮用后端给的 `matchRanges`,不在壳里再 indexOf 一遍 —— 与另外两路逐字同源。
 */
export function resultRows(
  results: readonly SearchResult[],
  capability: string,
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const result of results) {
    if (result.target === undefined) continue
    rows.push({
      id: result.id,
      capability,
      domain: 'file',
      text: result.title,
      code: false,
      origin: { kind: 'path', path: result.subtitle ?? result.detail ?? '' },
      target: result.target,
      tier: 'title',
      ...(result.matchRanges === undefined ? {} : { highlight: result.matchRanges }),
      ...(result.facets === undefined ? {} : { facets: result.facets }),
    })
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
  const { sessions, chapters = {}, files = [], messages = [], timeOf } = material
  /*
   * ── S4a:过滤从「哪一侧」换成「哪个能力」 ────────────────────────────
   * 从前这里判的是 `scope === 'files'` / `=== 'sessions'` —— 两个字面量,而且把
   * 「消息正文」和「会话标题」绑成了同一档(它们在屏幕上都挂在会话下面)。
   * 今天档位是能力,于是判据变成一句话:**这一行是这一档要的那个能力产的吗**。
   *
   * 可感知的一处变化(报告里列了):`messages` 从此是自己的一档,单类 `chats` 档
   * 里**不再混着正文命中**。全部档一格没动 —— 那正是用户日常看到的那一档。
   *
   * 命中在这里仍然**没有被单独过滤一遍**:`sessionRows` 逐条会话去 `bySession` 里取,
   * 而它遍历的是**屏幕那份会话表**(当前空间的投影)—— 于是「别的空间的会话」
   * 与「刚被删掉的会话」的命中天然不出行,不需要第二套名单去追。
   */
  const wantsSessionSide = inScope(scope, CHATS_CAPABILITY) || inScope(scope, MESSAGES_CAPABILITY)
  const fromSessions = wantsSessionSide
    ? sessionRows(q, sessions, chapters, messages, timeOf).filter(row => inScope(scope, row.capability))
    : []
  const fromFiles = inScope(scope, FILES_CAPABILITY) ? fileRows(files) : []
  return [
    ...interleave(fromSessions.filter(isTitle), fromFiles.filter(isTitle)),
    ...interleave(fromSessions.filter(isBody), fromFiles.filter(isBody)),
  ]
}

/* ── 全部档的分组(§7.2 / §9 第四条)────────────────────────────────────── */

/**
 * 全部档按**能力**归堆,组与组的先后由自述的 `order` 说(`tabsOf` 已经排好,
 * 这里收的就是那张表的 id 次序)。
 *
 * **只归堆,不重排组内** —— 组内那一刀(title 级在前、body 级在后、两侧交替)
 * 是 `searchRows` 的事,这里一个字不动它。所以这只函数是一次**稳定**的分桶:
 * 同一个能力的行按它们本来的先后连着出现。
 *
 * 单类档不调它(一张平铺列表就是它自己那一组)。
 */
export function groupRowsByCapability(
  rows: readonly SearchRow[],
  order: readonly string[],
): SearchRow[] {
  const buckets = new Map<string, SearchRow[]>()
  for (const row of rows) {
    const bucket = buckets.get(row.capability)
    if (bucket) bucket.push(row)
    else buckets.set(row.capability, [row])
  }
  const out: SearchRow[] = []
  // 先按自述次序放已知的那几组……
  for (const capability of order) {
    const bucket = buckets.get(capability)
    if (bucket === undefined) continue
    out.push(...bucket)
    buckets.delete(capability)
  }
  // ……剩下的(自述表还没回来、或者一个刚注销的能力还有行在屏上)按出现次序殿后。
  // **不丢**:壳没跟上不该把结果吞掉(§4.3 的同一条纪律)。
  for (const bucket of buckets.values()) out.push(...bucket)
  return out
}

/** 相邻两行之间要不要画一条组头(全部档)。首行永远要。 */
export function groupHeadAt(rows: readonly SearchRow[], index: number): string | undefined {
  const row = rows[index]
  if (row === undefined) return undefined
  const previous = rows[index - 1]
  return previous === undefined || previous.capability !== row.capability ? row.capability : undefined
}

/* ── 分页 ──────────────────────────────────────────────────────────────────
 *
 * ## 为什么是「递增 limit 重查」而不是真游标
 *
 * 两个远端产地都没有游标,也都不下发命中总数:
 *  - 文件侧 `files.list`(`@shared/ipc/files.ts` 的 `FilesListRequest`)只有
 *    `limit` 一格;后端 `listOnethingFileSearchEntries` 数到 limit 就 break,
 *    回执里没有 total。
 *  - 正文侧 `search.query`(`@shared/ipc/search.ts` 的 `SearchRequest`)同样
 *    只有 `limit`。09-02 之前这一行末尾写着「而且这块面板根本没用它」——
 *    那句话现在不成立了:正文检索走的正是它(`data/message-search-source.ts`)。
 * 于是分页只能是**要更多**:第 n 页带一个更大的 limit 从头重查一遍。
 * **代价如实记在这里**:每翻一页都是一次全量重拉再截断,不是增量取。
 * 后端补游标(以及下发 total)属另拍,不在本批。
 *
 * ## 正文侧的 limit 还多一层损耗(留账)
 *
 * `searchMessages` 的 limit 是**全局的**:它按会话表的次序扫,数满就 break ——
 * 所以「前 20 条」可能全部落在头两条会话里,后面的会话根本没被扫到。
 * 而壳这边还要再过一道**当前空间**的投影(别的空间的命中不出行),于是要了 20 条
 * 真正上屏的可能只有几条。两件事叠起来的样子是:**翻页在正文侧比在文件侧更早
 * 需要按**。这是后端那条口今天的形状,不在壳里补偿(补偿就是猜一个 limit 倍数,
 * 那会让「取尽了没有」这条唯一判据失真)。
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

/** 每按一次「加载更多」再放出多少条(同时也是两路远端 limit 的增量)。 */
export const SEARCH_PAGE_SIZE = 20

/** 第 n 页(从 1 数)的窗口大小 = 首屏 + 之后每页的增量。 */
export function pageWindow(page: number): number {
  return SEARCH_FIRST_PAGE + Math.max(page - 1, 0) * SEARCH_PAGE_SIZE
}

/**
 * **一个远端产地**此刻的处境。**四态,不是三个布尔** —— 「还在路上」与「给满了」
 * 与「取尽了」是三件不同的事,合成布尔就得在读的地方再拼一次。
 *
 * 09-02 之前这里叫 `SearchFileSide`,因为远端只有文件一路。正文检索接上之后
 * 有两路(文件 / 消息),名字跟着改成中性的 —— 类型说的一直是「一个会去问别人
 * 的产地此刻怎么样」,与它是哪一路无关。会话侧不在这张表上:它整表在手,
 * 「后面还有没有」当场就知道,恒定 `exhausted`。
 */
export type SearchRemoteSide =
  /** 取尽了(或这一档根本不看这一路):后面没有了。 */
  | 'exhausted'
  /** 给满了(回来的条数 == 要的条数):后面**可能**还有,但没人说过有。 */
  | 'more'
  /** 还在路上 / 还没发。 */
  | 'pending'
  /** 这一次塌了。 */
  | 'failed'

/**
 * 两路远端合成一路。**次序是判据,不是口味**:
 *
 *  1. `failed` —— 一次失败必须说出来,而底部那条 item 正是「再试一次」的落点;
 *  2. `more`   —— 有人说「我给满了」= 后面可能还有,那就得留一条能按的 item
 *     (排在 pending 前面:另一路还没说话不该把这条已经知道的路堵掉);
 *  3. `pending`—— 还没人说过有,于是**不许诺**,只报此刻的条数;
 *  4. `exhausted` —— 两路都说完了才轮得到它。
 *
 * 空入参(两档都不看远端)= `exhausted`:没有人可问,就是没有更多。
 */
const REMOTE_ORDER: SearchRemoteSide[] = ['failed', 'more', 'pending', 'exhausted']

export function remoteSide(...sides: SearchRemoteSide[]): SearchRemoteSide {
  for (const candidate of REMOTE_ORDER) {
    if (sides.includes(candidate)) return candidate
  }
  return 'exhausted'
}

/**
 * 列表底部那条 item 的处境。它是**一条 item**,不是一颗悬浮按钮 ——
 * 所以「没有它」也是一种正经状态('none'),而不是把它画成禁用态占着位置。
 *
 * 'none' 现在**只剩「一条都没有」这一格**(09-01 裁定):空词不再是「没在搜」,
 * 它是浏览态,一样有读数一样能翻页 —— 只要屏幕上有行,底下就一定有一行东西可读。
 */
export type SearchMore =
  | { kind: 'none' }
  /** 还能再要。`total` 只有在远端取尽时才知道 —— 不知道就是 null,不猜。 */
  | { kind: 'more'; shown: number; total: number | null }
  | { kind: 'loading' }
  | { kind: 'error' }
  /** 取尽了:「共 N 条 · 已全部显示」。非交互读数,第一页就取尽也算数。 */
  | { kind: 'end'; total: number }
  /**
   * 远端还没落定,而会话侧那份数已经定了:先如实报**此刻已经在屏幕上的条数**。
   * 非交互读数 —— 它既不许诺「还有更多」(远端没说过话),也不说「全都在这了」
   * (那要等远端取尽)。用「已显示」而不是「共」正是这个区别:
   * 「共」是一句关于总数的断言,这一刻还没人有资格下。
   */
  | { kind: 'count'; shown: number }

export interface SearchMoreInput {
  /**
   * 此刻有没有词。
   *
   * 它**不再决定「有没有底部这一行」**(那是 09-01 之前的读法),只决定
   * 「还有没有更多」这件事去问谁:搜索态问远端那四态,浏览态谁都不用问 ——
   * 行全部来自会话侧,而会话侧整张表在手,后面有没有当场就知道。
   */
  searching: boolean
  /** 第几页,从 1 数。 */
  page: number
  /** 此刻**造得出来**的全部行数(受当前 limit 约束的那一份)。 */
  total: number
  /**
   * 远端那几路合成的一个处境(09-02 起有两路:文件 / 消息正文,由 `remoteSide`
   * 合成)。这里只收合成之后的那一个 —— 判据表要问的一直是「后面还有没有」,
   * 那是一个问题,不是每来一路就多一个入参。
   */
  remote: SearchRemoteSide
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
 * ## 09-02:远端从一路变两路,判据表一格没动
 *
 * 正文检索接上之后远端有两路(文件 / 消息)。合成发生在**进这张表之前**
 * (`remoteSide`,次序 failed > more > pending > exhausted),所以这里收到的
 * 仍然是一个处境 —— 判据表要问的一直是「后面还有没有」,那是一个问题,
 * 不是每来一路就多一列。
 *
 * | 行数  | searching | page | remote     | 结果      | 屏幕上                       |
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
 *  - 远端 pending 的第一页**仍然不许诺**「加载更多」:那一句是在说「后面还有」,
 *    而这一刻没人说过有;每敲一个字母闪一下它就是噪音。改的只是那一格从「什么都
 *    不画」变成「照实报此刻的条数」—— 报数不是许诺,而且这个数是**会话侧已经定了
 *    的那一份**(远端此刻恒空,不猜它)。
 *  - failed 的语义一格没动:第一页塌了那次,「没搜成」归列表上面那行,而这条 item
 *    是「再试一次」的落点(所以它是可按的 `more`,不是读数)。
 */
export function moreState({ searching, page, total, remote }: SearchMoreInput): SearchMore {
  if (total === 0) return { kind: 'none' }
  /*
   * 浏览态(空词)的行全部来自会话侧,而会话侧整张 listMeta 在手 ——
   * 「后面还有没有」这件事当场就知道,而且答案永远是「没有了」。所以这里不是
   * 一条支路,是**一次翻译**:把浏览态翻成远端那四态里的 'exhausted',
   * 下面每一格照旧,count / end / 加载更多一格都不用重写。
   */
  const side = searching ? remote : 'exhausted'
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
  // 窗口已经装下此刻的全部行 —— 还有没有更多,只有远端那几路知道。
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
  // 浏览态的行**全部来自会话侧**,所以只有 `chats`(与 `all`)那两档有东西可画。
  if (!inScope(scope, CHATS_CAPABILITY)) return []
  return sessions.map<SearchRow>((session) => ({
    id: `${session.id}:browse`,
    capability: CHATS_CAPABILITY,
    domain: 'session',
    text: session.title,
    code: false,
    origin: { kind: 'time', time: timeOf(session) },
    target: { kind: 'chat', payload: { sessionId: session.id } },
    tier: 'title',
  }))
}
