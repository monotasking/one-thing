/**
 * 笔记检索能力 —— **索引型**(P2)。
 *
 * 设计:`docs/design/notes-obsidian-cli-2026-09.md` §4.1;索引侧的形状仍是
 * `docs/design/search-index-2026-09.md` §4.2 / §5.2b。
 *
 * P2 之前这一类叫 `daily`(「每日笔记」),它的笔记根来自
 * `general.dailyNotes` 那五格设置 + 一次向上找 `.obsidian` 的探路。今天它叫
 * `notes`,来源是**笔记领域的库表**(`NoteVault`),于是:
 *
 *  - 搜的是整个库(递归),不再是「日记那一层」;
 *  - 多两格 facet:`vault`(哪个库)与 `daily`(是不是日记文件夹里的那一篇);
 *  - 「今天」那一条问的是**主库**的 `dailyNote(date, { offline: true })` ——
 *    `offline` 是硬约束:检索是后台路,一条 CLI 命令都不许发(发一条 =
 *    把 Obsidian 拉起来,正是笔记领域第一条纪律禁止的事)。
 *
 * ## 「首次查询才建」在哪儿
 *
 * **不在这里。** 这份 manifest 与另外两条索引型能力逐字同形,它不知道自己的来源
 * 是懒的。懒在 `VaultFeed.policy.build = 'lazy'` 与索引服务的**纳入时机**上
 * (`IndexWorkerCore.ensureFeedsFor`)。
 *
 * ## 「今天那一条」不在索引里,所以它是这一层加回去的
 *
 * 「打开今天 / 新建今天的日记」说的是「今天那个文件在不在」——**不存在的文件没有
 * 文档**,索引在结构上答不出它。今天已经存在时索引也会答出它,于是按 `filePath`
 * 去重。「新建今天的日记」与「新建笔记」两条都**不是结果、是 `SearchPage.actions`
 * 上的动作**(检索面终稿 §0 ③):它们指的文件还不存在,占一格配额、计进 total、
 * 还画不出预览。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  indexedCapability,
  rrfFusion,
  type ActionDescriptor,
  type Candidate,
  type CapabilityManifest,
  type FacetDeclaration,
  type FacetFilter,
  type PageRequest,
  type PreviewPayload,
  type Retriever,
  type RetrievedPage,
  type SearchCapability,
  type SearchContext,
  type SearchPage,
  type SearchQuery,
} from '@onething/core/search'
import { NoteVaultUnavailable, type NoteVault, type NoteVaultUnavailableReason } from '../../notes/types.js'
import { createSqliteLexicalRetriever } from '../index/service.js'
import { vaultRelativeKey } from '../index/vault-feed.js'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import {
  queryRangesOf,
  snippetOf,
  snippetWindowOf,
  trackIndexGeneration,
  type SearchIndexQueryFace,
} from './indexed.js'
import type { ResultBackedCandidate, SearchServiceResult } from './scan-adapter.js'
import { normalizeSearchQuery } from './text-match.js'
import {
  PreviewUnavailableError,
  firstCandidate,
  requireStringField,
  targetPayloadOf,
  type NoteExcerptPreview,
} from './preview.js'

/** 这一类的目标形:一篇笔记文件;`actionId` 在「还没建出来」那条上才有。 */
export interface NoteTarget {
  kind: 'note'
  payload: {
    filePath: string
    /** 「还没建出来」那条的动作号。 */
    actionId?: string
    /**
     * **「这一行能在它自己的 app 里打开」那一格能力位**(P5,§4.1 行动作)。
     *
     * 在场 = 这篇笔记所在的库答得出 `openInApp`,壳照它画一条行动作;缺席 =
     * 这个系统没有「在 app 里打开」这回事(目录库就是这一档)。
     *
     * 为什么是**动作号**而不是一个布尔:动作 id 是后端的词汇,壳拼不得
     * (与两条 create 动作同一条判例 —— 路径编在 id 里,授权夹的就是那一格)。
     * 壳因此也不需要认识任何一个笔记系统的名字:它只问「这一格在不在」。
     */
    openInAppActionId?: string
  }
}

/**
 * **第二条召回路的 id**(P5,§4.3)。
 *
 * 叫 `notes-live` 而不是 `obsidian-live`:能力的自述里不点任何一个笔记系统的
 * 名字 —— 这条路问的是「**这个库自己**的搜索」,谁答得上由每个库的 `liveSearch`
 * 在不在决定,不由一张系统名单决定。
 */
export const LIVE_RETRIEVER_ID = 'notes-live'

/**
 * 「这一次明说要活检索」那一格。
 *
 * 它是**这一类自己的控制位**,不是一条文档 facet —— 没有哪一篇笔记带着 `live`
 * 这个 facet。所以它在进索引之前必须被摘掉(`withoutControlFilters`),理由写在
 * 那只函数上。
 */
export const LIVE_FILTER_KEY = 'live'

/**
 * 一个库的活检索最多等多久。
 *
 * CLI 自己的预算是 10s(`OBSIDIAN_CLI_BUDGET_MS`)—— 那是给「建一篇日记」这种
 * 前台动作的。检索面是另一种时间感:这颗片是用户按下去的显式动作,不在逐键那条
 * 300ms 的路上,但它也不该让一张清单停三秒以上。
 */
export const LIVE_SEARCH_BUDGET_MS = 3_000

/**
 * 这次查询像不像在用**笔记 app 自己的搜索语法**。
 *
 * 判据是一张表,不是一串 `||`:Obsidian 的搜索操作符(`tag:` / `path:` / `file:` /
 * `line:` / `section:` / `block:` / `task:`)与属性查询(`[prop]`)。这几个词是
 * **查询语法**,索引那一侧根本解释不了它们 —— 用户打出 `tag:今天` 的那一刻,他
 * 要的就是那台 app 的答案,所以这一条与那颗片是同一件事的两种说法。
 *
 * 判词住在能力自己这儿(而不是 core):core 的 `RetrieverWhen` 只认「调用方明说了
 * 没有」,它没有、也不该有「一个查询串长得像谁的语法」这种知识。
 */
const LIVE_QUERY_OPERATORS: readonly string[] = ['tag:', 'path:', 'file:', 'line:', 'section:', 'block:', 'task:']

/** `[prop]` / `[prop:value]` —— 属性查询。方括号里非空、且不含空白。 */
const LIVE_PROPERTY_PATTERN = /\[[^\s[\]]+\]/

export function looksLikeLiveQuery(raw: string): boolean {
  const q = raw.toLowerCase()
  if (LIVE_QUERY_OPERATORS.some(operator => q.includes(operator))) return true
  return LIVE_PROPERTY_PATTERN.test(raw)
}

/**
 * 自述的**不变的那一半**。
 *
 * `facets` 里的 `vault` 那一格要列出当前在册的库 id,而库表是会变的 —— 所以
 * 完整的 manifest 由 `notesManifestOf(adapters)` 现算,这一份是它的底。装配层
 * 读 `schema` 那一格(字段表进 `workerData`)时用的也是它:字段表与库表无关。
 */
export const notesSearchManifest: CapabilityManifest = {
  id: 'notes',
  labelKey: 'search.capability.notes',
  icon: 'FileText',
  kind: 'indexed',
  schema: {
    title: { analyzer: 'composite', weight: 2 },
    // `embed: true`(S7):笔记正文是成段的话,改写句对得上(§15.3)。
    content: { analyzer: 'composite', weight: 1, embed: true },
  },
  facets: [
    { key: 'vault', type: 'enum' },
    { key: 'path', type: 'enum' },
    { key: 'time', type: 'range' },
    { key: 'daily', type: 'boolean' },
  ],
  budget: { default: 6, timeoutMs: 300 },
  order: 3,
  orderWhenIntent: { actions: 4 },
  ranking: { pinFieldHit: 'title' },
  // 与 messages 同一条判据:词法严格档零命中、放宽到 ② 及以后才加向量路(§15.4)。
  // `notes-live` 是**第二条召回路的自述**(P5,§4.3):`explicit` = 除非明说,
  // 否则不跑。「明说」在这一类里有两种形(带操作符的词 / 那颗片),判词见
  // `wantsLiveSearch`。
  retrievers: { vector: { when: 'relaxed' }, [LIVE_RETRIEVER_ID]: { when: 'explicit' } },
  visibility: () => ({}),
  // **lazy**:要读一次文件。随候选带就是一次 `all` 档读六个文件。
  preview: { mode: 'lazy' },
}

/**
 * 这一刻的自述:`vault` 那一格填上当前在册的库 id。
 *
 * **库表变了自述跟着变** —— 壳画过滤片读的就是这张表,所以它不能是装配那一刻
 * 冻起来的快照。`core` 的 `FacetDeclaration.values?` 本来就是可选数组,所以这
 * 件事不需要 core 改一个字。
 */
export function notesManifestOf(adapters: OnethingSearchProvidersAdapters): CapabilityManifest {
  const vaults = noteVaultsOf(adapters)
  const values = vaults.map(vault => vault.id)
  const facets: FacetDeclaration[] = (notesSearchManifest.facets ?? []).map(facet =>
    facet.key === 'vault' ? { ...facet, values } : facet)
  // **「有没有一条活检索路可走」也是自述的一格**(P5):有一个在册的库答得出
  // `liveSearch`,这一格就摆得出来,壳照它画那颗片;一个都没有(只有目录库、
  // 或者压根没有库)就整格不出现,壳于是连画的机会都没有。
  //
  // 为什么是 facet 而不是别的:壳画片的唯一判据就是「这一档摆得出哪些 facet 键」
  // (`filters.ts` 的 `facetKeysOf`),走这条既有的路,壳一个笔记系统的名字都不
  // 需要认识,也不用为这颗片新开一条协议。
  if (vaults.some(vault => typeof vault.liveSearch === 'function')) {
    facets.push({ key: LIVE_FILTER_KEY, type: 'boolean' })
  }
  return { ...notesSearchManifest, facets }
}

/**
 * 这一次要不要问各个库自己的搜索(§4.3 的 `explicit` 判词)。
 *
 * 两种「明说」:那颗片(`filters.live === true`),或者查询串本身就是那台 app 的
 * 搜索语法(`looksLikeLiveQuery`)。**缺省是不问** —— 索引是缺省路(R3)。
 */
export function wantsLiveSearch(query: SearchQuery): boolean {
  if (query.filters[LIVE_FILTER_KEY] === true) return true
  return looksLikeLiveQuery(query.raw)
}

/**
 * 把**控制位**从过滤片里摘掉,再交给索引。
 *
 * 这一句不是洁癖,是一条 bug 的防线:词法那一侧(`sqlite-index.ts` 的
 * `facetClause`)把 `filters` 里的**每一个**键都翻成一条
 * `EXISTS(doc_facets … key = ?)` 子句,而没有哪一篇笔记带着 `live` 这个 facet ——
 * 不摘掉它,这颗片一打开,索引那一路就是**零命中**。
 *
 * 顺带一个好处:游标的形状哈希(`hashQueryShape`)读的也是这一份摘过的
 * `filters`,所以开 / 关那颗片不会把在飞的分页游标作废 —— 索引那一侧答的本来
 * 就是同一页。
 */
function withoutControlFilters(query: SearchQuery): SearchQuery {
  if (query.filters[LIVE_FILTER_KEY] === undefined) return query
  const filters: Record<string, FacetFilter> = { ...query.filters }
  delete filters[LIVE_FILTER_KEY]
  return { ...query, filters }
}

function noteVaultsOf(adapters: OnethingSearchProvidersAdapters): NoteVault[] {
  return adapters.getNoteVaults?.() ?? []
}

function primaryVaultOf(adapters: OnethingSearchProvidersAdapters): NoteVault | null {
  return adapters.getPrimaryNoteVault?.() ?? null
}

/** 命中行前后各留几行。§4.5 那张表的 `note-excerpt` 说的是「命中行 ±3 行」。 */
const NOTE_EXCERPT_RADIUS = 3

/**
 * 一篇笔记 → 命中行 ±N 行。
 *
 * **命中行怎么判**:用候选自己那句 `subtitle` —— 那正是 `toCandidate` 里从正文
 * 切出来的那一段。所以这里不重新跑一遍匹配器:分析器 / 放宽阶梯判出来的命中是
 * **索引那一侧**的事,在预览里再判一遍就是第二个「什么算命中」的产地。判不出来
 * (标题命中那种,`subtitle` 是文件名)就给**开头那几行** —— 诚实地退到「这篇
 * 笔记长这样」,不去伪造一个命中位置。
 */
function noteExcerptOf(text: string, hint: string | undefined): string {
  const lines = text.split('\n')
  const needle = (hint ?? '').replace(/^(\.{3}|…)+/, '').replace(/(\.{3}|…)+$/, '').trim()
  const at = needle.length === 0 ? -1 : lines.findIndex(line => line.includes(needle))
  if (at < 0) return lines.slice(0, NOTE_EXCERPT_RADIUS * 2 + 1).join('\n')
  return lines.slice(Math.max(0, at - NOTE_EXCERPT_RADIUS), at + NOTE_EXCERPT_RADIUS + 1).join('\n')
}

/**
 * 读一篇笔记做预览。**零副作用**:只 `readFile`,不写、不 touch、不建目录 ——
 * 「还没建」那条(`actionId` 在 payload 上)在这里**不许**顺手把文件建出来,
 * 那是 `invoke` 的活,不是看一眼的活。所以那一条直接抛原话。
 */
async function noteExcerptPreview(
  candidates: Candidate[],
  query: string | undefined,
): Promise<PreviewPayload> {
  const candidate = firstCandidate(candidates)
  const payload = targetPayloadOf(candidate, 'note')
  if (typeof payload?.actionId === 'string') {
    throw new PreviewUnavailableError('这一条还没有文件可看')
  }
  const filePath = requireStringField(payload, 'filePath', '这条笔记命中')
  let text: string
  try {
    text = await readFile(filePath, 'utf-8')
  } catch (error) {
    throw new PreviewUnavailableError(`读不到 ${filePath}:${(error as Error).message}`)
  }
  const body = noteExcerptOf(text, candidate.subtitle)
  // 与列表行同一条高亮判据(`queryRangesOf`);没带查询词就不标(不是「没命中」)。
  const ranges = query === undefined ? [] : queryRangesOf(body, query)
  const excerpt: NoteExcerptPreview = {
    path: filePath,
    title: candidate.title,
    excerpt: body,
    ...(ranges.length === 0 ? {} : { ranges }),
  }
  return { kind: 'note-excerpt', payload: excerpt, title: candidate.title }
}

/** 这一类自报的三个动作 id(壳按 `kind` 画,按 `id` 回调 `search.invoke`)。 */
export const CREATE_DAILY_ACTION = 'create-daily'
export const CREATE_NOTE_ACTION = 'create-note'
/** 「在它自己的 app 里打开」——**行**动作(P5,§4.1),不是页级动作。 */
export const OPEN_IN_APP_ACTION = 'open-in-app'

/**
 * 「这一次没用上某个库」那一条提示,以及它为什么不是一条动作。
 *
 * `SearchPage` 上今天没有「提示」这一格(core 冻着,P5 一个字不改),而页级
 * `actions` 是**唯一**一处「不属于任何一条结果、属于这一页」的开放槽。所以提示
 * 走同一格,靠 `kind: 'notice'` 与真动作分开:壳那一侧把 `notice` 从动作行里择
 * 出来画进页脚(与「已放宽」「索引不可用」同一行读数),它按不下去、也不进 ↑↓
 * 序列。留账里记着「`SearchPage` 该有一格 `notices`」这笔账。
 */
export const NOTICE_ACTION_KIND = 'notice'

/**
 * **两个动作的 id 里都编着目标路径**,而不是标题。
 *
 * 理由与 `create-daily` 从前那一条逐字相同:`invoke` 只收得到一个 actionId,而
 * 「建哪个文件」不能靠 `invoke` 那一侧再算一遍 —— 那就是第二个「今天是哪天 /
 * 落哪个库」的产地。授权那一侧(`wiring/search/authorization.ts`)把这条路径夹在
 * 库根里,夹的也正是这一格。给人看的句子由壳按 `labelKey + params` 拼(R12)。
 */
function actionWithPath(id: string, labelKey: string, filePath: string, params: Record<string, string>): ActionDescriptor {
  return {
    id: `${id}:${encodeURIComponent(filePath)}`,
    kind: 'create',
    capability: notesSearchManifest.id,
    labelKey,
    params: { ...params, path: filePath },
    payload: { filePath },
  }
}

function pathOfAction(actionId: string, prefix: string): string {
  const filePath = decodeURIComponent(actionId.slice(`${prefix}:`.length))
  if (filePath.length === 0) throw new Error(`${prefix} action carries no path`)
  return filePath
}

/** 「在 app 里打开这一篇」的动作号。**与两条 create 同一条规矩**:路径编在 id 里。 */
export function openInAppActionIdOf(filePath: string): string {
  return `${OPEN_IN_APP_ACTION}:${encodeURIComponent(filePath)}`
}

/**
 * 一条笔记命中的 `target` —— **两条召回路共用的唯一产地**。
 *
 * 「这一行能不能在 app 里打开」由**库自己**答(`typeof vault.openInApp ===
 * 'function'`),不由任何一张系统名单答:加一种笔记系统只要它实现了那个方法,
 * 这一格自己就出现了,这个文件与壳都不改一个字。
 */
function noteTargetOf(adapters: OnethingSearchProvidersAdapters, filePath: string): NoteTarget {
  const vault = vaultContaining(adapters, filePath)
  const openable = vault !== null && typeof vault.openInApp === 'function'
  return {
    kind: 'note',
    payload: {
      filePath,
      ...(openable ? { openInAppActionId: openInAppActionIdOf(filePath) } : {}),
    },
  }
}

/** 今天那一天的 ISO 形。**不经时区转换** —— 「今天」说的是本机日历上的今天。 */
function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 「今天」那几个词根。数据一张表,不是一串 `||`。 */
const TODAY_WORDS: readonly string[] = ['today', 'daily', 'diary', 'journal', '日记', '今天']

/**
 * 这次查询像不像在问「今天」。
 *
 * **P2 收紧**(壳正本 84 号):从前是 `todayIso.includes(q) || 那几个词根互含`,
 * 于是 `n`(note 的第一个字母)、`0`(ISO 里的任意一位)都能把「今天」那一条顶到
 * 第一行 —— 一次正常的检索被一条与词无关的快捷项挤掉。今天的判据是两条:
 *
 *  ① 至少两个字符(单字母永远不是「我要今天的日记」);
 *  ② 要么是那几个词根的**整词前缀**,要么是今天 ISO 日期的前缀
 *     (`2026-09` 中,`09-18` 不中 —— 后者是「某个月的某天」,不是「今天」)。
 *
 * 空词答 `false`:空输入框里该出现的是浏览态,不是一条自作主张的快捷项。
 */
export function todayMatchesQuery(query: string, todayIso: string): boolean {
  const q = normalizeSearchQuery(query)
  if (q.length < 2) return false
  if (todayIso.startsWith(q)) return true
  return TODAY_WORDS.some(word => word.startsWith(q))
}

/** 「今天那一条」的两态:文件在 = 一条真结果;不在 = 一个动作。 */
interface TodayShortcut {
  filePath: string
  exists: boolean
}

/**
 * 「今天那一条」的**唯一产地**。
 *
 * 主库答不出日记落点(Obsidian 没跑过、连快照都没有)就 `undefined` —— **省掉
 * 比编一个强**。`offline: true` 是硬约束,见文件头。
 */
async function resolveTodayShortcut(
  adapters: OnethingSearchProvidersAdapters,
  query: string,
  today: Date,
): Promise<TodayShortcut | undefined> {
  const vault = primaryVaultOf(adapters)
  if (vault === null) return undefined
  if (!todayMatchesQuery(query, toIsoDate(today))) return undefined
  const ref = await vault.dailyNote(today, { offline: true })
  return { filePath: ref.path, exists: ref.exists }
}

/** 「今天那一条」已经存在时 → 一枚候选,排最前。 */
function shortcutCandidate(
  adapters: OnethingSearchProvidersAdapters,
  shortcut: TodayShortcut,
  timestamp: number,
  score: number,
): ResultBackedCandidate {
  const result: SearchServiceResult = {
    id: noteResultId(shortcut.filePath),
    type: 'note',
    title: path.basename(shortcut.filePath, path.extname(shortcut.filePath)),
    subtitle: shortcut.filePath,
    filePath: shortcut.filePath,
    timestamp,
  }
  return {
    capability: notesSearchManifest.id,
    id: result.id,
    title: result.title,
    subtitle: result.subtitle,
    score,
    time: timestamp,
    target: noteTargetOf(adapters, shortcut.filePath),
    result,
  }
}

/** `note:<绝对路径>` —— 剖 id 与拼 id 只在这一个地方。 */
function noteResultId(filePath: string): string {
  return `note:${filePath}`
}

/**
 * 「新建笔记 “…”」这个动作该不该出。
 *
 * 两个条件:词非空,且**这一页没有标题与它逐字相同的命中** —— 已经有一篇叫这个
 * 名字的笔记时再给一条「新建」,按下去不是建而是撞名。
 */
function createNoteAction(
  adapters: OnethingSearchProvidersAdapters,
  query: SearchQuery,
  page: SearchPage,
): ActionDescriptor | undefined {
  // **标题保留用户打的大小写**(`normalizeSearchQuery` 会小写,那一份只配当判据):
  // 屏幕上那句「新建笔记 “OnethingNotes”」与真落盘的文件名必须是同一串字。
  const title = noteTitleFromQuery(query.raw)
  if (normalizeSearchQuery(query.raw).length === 0) return undefined
  if (page.items.some(item => item.title.trim().toLowerCase() === title.toLowerCase())) return undefined

  // facet 选了库就落那个库,否则主库。两个都答不出 = 这台机器上没有笔记库。
  const requested = query.filters.vault
  const vault = vaultOfFilter(adapters, requested) ?? primaryVaultOf(adapters)
  if (vault === null) return undefined

  const filePath = path.join(vault.root, `${sanitizeNoteFileName(title)}.md`)
  return actionWithPath(CREATE_NOTE_ACTION, 'search.action.createNote', filePath, { title })
}

/** 「新建笔记 “…”」里引号中间那串字。**只是料,不是句子**(R12)。 */
export function noteTitleFromQuery(raw: string): string {
  return raw.trim().replace(/^>/, '').replace(/^\//, '').trim()
}

/**
 * 「`vault` 那一格过滤片选中的是哪个库」。
 *
 * 过滤值可以是一个串,也可以是一张表(`FacetFilter`)。选了不止一个库时不猜 ——
 * 回 `null`,由调用方退回主库。
 */
function vaultOfFilter(adapters: OnethingSearchProvidersAdapters, filter: unknown): NoteVault | null {
  const id = typeof filter === 'string'
    ? filter
    : Array.isArray(filter) && filter.length === 1 && typeof filter[0] === 'string' ? filter[0] : undefined
  if (id === undefined) return null
  return noteVaultsOf(adapters).find(vault => vault.id === id) ?? null
}

/** 文件名里不许出现的那几个字符 → `-`。**不是净化用户输入**,是让文件建得出来。 */
export function sanitizeNoteFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+/, '').trim() || 'Untitled'
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第二条召回路:各个库自己的搜索(P5,§4.3)
 * ══════════════════════════════════════════════════════════════════════════ */

/** 一个库这一次为什么没答上。`vault` / `system` 只给壳拼那句话用。 */
export interface LiveSearchSkip {
  vaultId: string
  vault: string
  system: string
  reason: NoteVaultUnavailableReason | 'failed'
}

/** 活检索这一趟的结果:命中,加上「哪些库没答上、为什么」。 */
export interface LiveSearchOutcome {
  items: Candidate[]
  skipped: LiveSearchSkip[]
}

/** 驱动 id → 屏幕上那个名字。`system` 本来就是「只给人看的」那一格(领域契约)。 */
function systemLabelOf(system: string): string {
  return system.length === 0 ? system : system[0]!.toUpperCase() + system.slice(1)
}

/**
 * 这一路召回器。
 *
 * ── 它为什么**不**交给 `indexedCapability` 去跑 ──────────────────────────
 * core 的 `retrieverRuns` 认两种「明说」:`query.filters.semantic === true`,或者
 * `ctx.surface` 在能力声明的 `surfaces` 里。这一路的判据两个都不是 ——「用户点了
 * 那颗片」与「这个词长得像 Obsidian 的搜索语法」在 core 的词汇表里没有名字。
 * 而 `semantic` 那一格也**借不得**:词法那一侧会把 `filters` 里的每个键翻成一条
 * facet 子句,借它等于让每一次活检索的词法路零命中(同 `withoutControlFilters`)。
 *
 * 所以「这一次跑不跑」由能力自己判(`wantsLiveSearch`),融合用的仍然是 core 的
 * `rrfFusion` —— 算法只有一处产地。manifest 里那一行 `{ when: 'explicit' }` 是
 * **自述**:它告诉读表的人(壳、AI、下一个施工的人)这条路是要明说才跑的。
 * 让 core 也能驱动它,要给 `RetrieverWhen` 加一格「按召回器 id 的显式开关」,
 * 那是 core 的改动,记在留账里。
 *
 * ── 一条命令都不会把 app 拉起来 ──────────────────────────────────────────
 * `liveSearch` 自己有两道闸(库开着 ∧ app 活着),不成立就抛
 * `NoteVaultUnavailable` 并把**理由**交出来。这一路把理由收进 `skipped`,由
 * 能力画成页上那一句 —— 「没搜到」与「这次没问成」是两句话。
 */
export function createLiveNotesRetriever(
  adapters: OnethingSearchProvidersAdapters,
  budgetMs: number = LIVE_SEARCH_BUDGET_MS,
): Retriever & { collect(query: SearchQuery, ctx: SearchContext, limit: number): Promise<LiveSearchOutcome> } {
  async function askOne(
    vault: NoteVault,
    query: SearchQuery,
    ctx: SearchContext,
    limit: number,
  ): Promise<{ items: Candidate[]; skip?: LiveSearchSkip }> {
    const skipOf = (reason: LiveSearchSkip['reason']): LiveSearchSkip =>
      ({ vaultId: vault.id, vault: vault.name, system: systemLabelOf(vault.system), reason })
    try {
      // 「用户换了词」与「这个库太慢了」是同一条取消路的两个源头,合成一个信号
      // 递下去 —— 领域那一侧于是只需要认识 `signal` 一格,不必再长一个 timeout 参数。
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)])
      const hits = await vault.liveSearch!(query.raw, { limit, signal })
      return {
        items: hits.slice(0, limit).map((hit, rank) => {
          const matched = hit.matches[0]?.text
          const result: SearchServiceResult = {
            id: noteResultId(hit.path),
            type: 'note',
            title: path.basename(hit.path, path.extname(hit.path)),
            // 出处那一段与索引那一路**同一把尺子**:库相对 posix 路径
            // (`vaultRelativeKey` 住在 feed 那边,key 的产地就在那里)。
            subtitle: matched ?? vaultRelativeKey(vault.root, hit.path),
            filePath: hit.path,
          }
          const candidate: ResultBackedCandidate = {
            capability: notesSearchManifest.id,
            id: result.id,
            title: result.title,
            subtitle: result.subtitle,
            // 分数只在**组内**有意义,而融合读的是**名次**(RRF)—— 所以这里给的是
            // 「app 自己排的第几」的倒序,不去发明第二套相关度。
            score: hits.length - rank,
            target: noteTargetOf(adapters, hit.path),
            facets: { path: hit.path, vault: vault.id },
            result,
          }
          return candidate
        }),
      }
    } catch (error) {
      // 这一发整个被撤了(换词):没有人还在等这张页,不必解释什么。
      if (ctx.signal.aborted) return { items: [] }
      if (error instanceof NoteVaultUnavailable) return { items: [], skip: skipOf(error.reason) }
      // 超时 / CLI 说了句错话 / 解析不出来 —— 都是「这次没问成」,如实说一句,
      // 而不是让它看起来像「这个库里没有」。
      return { items: [], skip: skipOf('failed') }
    }
  }

  async function collect(query: SearchQuery, ctx: SearchContext, limit: number): Promise<LiveSearchOutcome> {
    // 答得出 `liveSearch` 的库才问 —— 目录库没有这个方法,它就不在这条路上。
    const vaults = noteVaultsOf(adapters).filter(vault => typeof vault.liveSearch === 'function')
    if (vaults.length === 0) return { items: [], skipped: [] }
    const answers = await Promise.all(vaults.map(vault => askOne(vault, query, ctx, limit)))
    return {
      items: answers.flatMap(answer => answer.items),
      skipped: answers.flatMap(answer => (answer.skip === undefined ? [] : [answer.skip])),
    }
  }

  return {
    id: LIVE_RETRIEVER_ID,
    collect,
    async retrieve(query: SearchQuery, ctx: SearchContext, page): Promise<RetrievedPage> {
      // `total` 不给:一台 app 的搜索答的是「这些」,不是「一共多少条」(§7.3)。
      return { items: (await collect(query, ctx, page.limit)).items }
    },
  }
}

/**
 * 「这一次没用上这个库」→ 页上那一条提示。
 *
 * **后端只交码与料**(R12):哪一句人话由壳的字典按 `labelKey` 查出,库名与系统名
 * 走 `params`。三句话对三种处境,因为它们真的不一样:app 没跑 / 这个库没在它里面
 * 打开 / 问了但没问成。
 */
const LIVE_NOTICE_KEYS: Record<LiveSearchSkip['reason'], string> = {
  'system-not-running': 'search.notice.liveNotRunning',
  'cli-not-registered': 'search.notice.liveNotRunning',
  'no-snapshot': 'search.notice.liveNotRunning',
  'vault-not-open': 'search.notice.liveVaultNotOpen',
  failed: 'search.notice.liveFailed',
}

function noticeOf(skip: LiveSearchSkip): ActionDescriptor {
  return {
    id: `${LIVE_RETRIEVER_ID}:${skip.reason}:${skip.vaultId}`,
    kind: NOTICE_ACTION_KIND,
    capability: notesSearchManifest.id,
    labelKey: LIVE_NOTICE_KEYS[skip.reason],
    params: { system: skip.system, vault: skip.vault },
  }
}

export function createNotesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
  now: () => Date = () => new Date(),
): SearchCapability {
  const tracked = trackIndexGeneration(index)
  const liveRetriever = createLiveNotesRetriever(adapters)

  const indexed = indexedCapability({
    manifest: notesSearchManifest,
    generation: tracked.generation,
    retrievers: [createSqliteLexicalRetriever({
      manifest: notesSearchManifest,
      service: tracked.face,
      toCandidate({ doc, hit, score }) {
        // `path` facet 是**绝对路径**(壳按它打开文件);`key` 是库相对名。
        const filePath = typeof doc.facets.path === 'string' ? doc.facets.path : doc.key
        const title = doc.fields.title ?? doc.key
        const titleSnippet = snippetOf(title, hit.matched)
        const titleWindow = snippetWindowOf(titleSnippet)
        // 标题里没命中就把摘要开在正文上 —— 用户想看的是「命中的那句话」。
        const body = hit.fields.includes('content')
          ? snippetOf(doc.fields.content ?? '', hit.matched).text
          : undefined

        const result: SearchServiceResult = {
          id: noteResultId(filePath),
          type: 'note',
          title,
          subtitle: body ?? doc.key,
          filePath,
          timestamp: doc.time,
          matchRanges: titleSnippet.ranges,
          ...(titleWindow === undefined ? {} : { snippet: titleWindow }),
          source: 'lexical',
        }
        const candidate: ResultBackedCandidate = {
          capability: notesSearchManifest.id,
          id: result.id,
          title: result.title,
          subtitle: result.subtitle,
          ranges: titleSnippet.ranges,
          score,
          time: doc.time,
          target: noteTargetOf(adapters, filePath),
          facets: doc.facets,
          result,
        }
        return candidate
      },
    })],
  })

  async function search(
    query: SearchQuery,
    page: PageRequest,
    ctx: SearchContext,
  ): Promise<SearchPage> {
    // 控制位不进索引(判词在 `withoutControlFilters` 上)。
    const inner = withoutControlFilters(query)
    const indexedPage = await indexed.search(inner, page, ctx)
    // 翻页时不再补动作与快捷项 —— 它们是首页的事。活检索同理:它是按下那一颗片
    // 的**那一下**,不是一条翻得动的流。
    if (page.cursor !== undefined) return indexedPage

    const live = wantsLiveSearch(query)
      ? await liveRetriever.collect(inner, ctx, page.limit)
      : { items: [], skipped: [] }
    const fused = mergeLive(indexedPage, live.items)

    const today = now()
    const shortcut = await resolveTodayShortcut(adapters, query.raw, today).catch(() => undefined)

    const withShortcut = shortcut === undefined || !shortcut.exists
      ? fused
      : mergeTodayShortcut(fused, shortcut, today.getTime(), page.limit)

    const actions: ActionDescriptor[] = []
    if (shortcut !== undefined && !shortcut.exists) {
      actions.push(actionWithPath(
        CREATE_DAILY_ACTION,
        'search.action.createDailyNote',
        shortcut.filePath,
        { date: toIsoDate(today) },
      ))
    }
    const createNote = createNoteAction(adapters, query, withShortcut)
    if (createNote !== undefined) actions.push(createNote)
    // 「这一次没用上哪个库」排在动作后面 —— 它不是一件能做的事。
    for (const skip of live.skipped) actions.push(noticeOf(skip))

    return actions.length === 0 ? withShortcut : { ...withShortcut, actions }
  }

  /**
   * 索引那一页 + 活检索那一把 → 一页。**融合用 core 的 RRF**(k=60),算法只有
   * 一处产地。
   *
   * 两件事写在这里免得下一个人再推一遍:
   *
   *  ① **活检索一条都没答出来时是恒等变换** —— 连融合都不跑。RRF 会把分数重写成
   *     `1/(k+rank)`,而这一类的「今天那一条」要拿 `max(score)+1` 排头;不设这道
   *     门,「没点那颗片」与「点了但 app 没跑」两种情形下的分数就不一样了,而它们
   *     在屏幕上本来应该逐字相同。
   *  ② **不切到 `limit`,也不动游标**。索引那一路的游标数的是它自己那条流的
   *     offset;把活检索的命中挤进同一个配额里,被挤掉的那几条词法命中就再也翻不
   *     到了(它们的 offset 已经被算过)。所以这一页可以比 `limit` 长 —— 多出来的
   *     正是用户按那颗片要来的东西,而 RRF 已经把最该看的排在了前面。
   */
  function mergeLive(page: SearchPage, live: readonly Candidate[]): SearchPage {
    if (live.length === 0) return page
    const items = rrfFusion()([
      { id: 'lexical', items: page.items },
      { id: LIVE_RETRIEVER_ID, items: live },
    ])
    // 两路都出了候选时 `total` 说不出口(§7.3「不知道就别给」):词法那个数说的是
    // 倒排里有多少条,它数不到 app 自己答的那些。
    const { total: _total, ...rest } = page
    return page.items.length === 0 ? { ...page, items } : { ...rest, items }
  }

  /** 今天那一份索引也答得出 —— 按 `filePath` 去重,再把快捷项排最前。 */
  function mergeTodayShortcut(
    page: SearchPage,
    shortcut: TodayShortcut,
    timestamp: number,
    limit: number,
  ): SearchPage {
    const rest = page.items.filter(item => item.id !== noteResultId(shortcut.filePath))
    const deduped = rest.length !== page.items.length
    // 分数只在**组内**排序时有意义(§6.5);排头就给一个比谁都大的。
    const candidate = shortcutCandidate(adapters, shortcut, timestamp, Math.max(0, ...rest.map(item => item.score)) + 1)
    return {
      ...page,
      items: [candidate, ...rest].slice(0, limit),
      ...(page.total === undefined
        ? {}
        : { total: deduped ? page.total : page.total + 1 }),
    }
  }

  /**
   * 两个动作按下去那一下(§8 `invoke`)。
   *
   * **只有这里允许把 app 拉起来**(`mayLaunch: true`):它是用户**按下去的**那一下,
   * 不是后台路。检索的其余每一条读法都是 `offline`。
   */
  const invoke = async (actionId: string): Promise<void> => {
    if (actionId.startsWith(`${CREATE_DAILY_ACTION}:`)) {
      const vault = primaryVaultOf(adapters)
      if (vault === null) throw new Error('no primary note vault')
      // 路径在 id 里只为**授权**与「按下去的是哪个文件」这件事说得出口;真正建
      // 文件走库自己的 `createDailyNote`(它吃用户的日记文件夹 / 格式 / 模板)。
      pathOfAction(actionId, CREATE_DAILY_ACTION)
      await vault.createDailyNote(new Date(), { mayLaunch: true })
      return
    }
    if (actionId.startsWith(`${CREATE_NOTE_ACTION}:`)) {
      const filePath = pathOfAction(actionId, CREATE_NOTE_ACTION)
      const vault = vaultContaining(adapters, filePath)
      if (vault === null) throw new Error(`no note vault contains ${filePath}`)
      await vault.createNote(path.relative(vault.root, filePath), {}, { mayLaunch: true })
      return
    }
    if (actionId.startsWith(`${OPEN_IN_APP_ACTION}:`)) {
      const filePath = pathOfAction(actionId, OPEN_IN_APP_ACTION)
      const vault = vaultContaining(adapters, filePath)
      if (vault === null) throw new Error(`no note vault contains ${filePath}`)
      // 「这个系统没有『在 app 里打开』这回事」与「打不开」是两句话。行上那条
      // 动作本来就只在库答得出这个方法时才画,所以走到这里说明有人绕过了屏幕。
      if (typeof vault.openInApp !== 'function') throw new Error(`vault ${vault.id} cannot open notes in an app`)
      await vault.openInApp(filePath, { mayLaunch: true })
      return
    }
    throw new Error(`no such action: ${actionId}`)
  }

  return {
    // **getter**:库表变了自述跟着变(见 `notesManifestOf`)。
    get manifest() {
      return notesManifestOf(adapters)
    },
    // 空词(以及裸 `/` `>`)时这一类**整组不出现**;一个库都没有时也不出现 ——
    // 后者说的是「这台机器上没有笔记库」,不是「零条」。
    supports: (query: SearchQuery) =>
      normalizeSearchQuery(query.raw).length > 0 && noteVaultsOf(adapters).length > 0,
    search,
    preview: async (candidates, _ctx, options) => noteExcerptPreview(candidates, options?.query),
    invoke,
  }
}

/** 这条绝对路径落在哪个库里。最长根赢(库套库时里面那个)。 */
function vaultContaining(adapters: OnethingSearchProvidersAdapters, filePath: string): NoteVault | null {
  let best: NoteVault | null = null
  for (const vault of noteVaultsOf(adapters)) {
    const relative = path.relative(vault.root, filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (best === null || vault.root.length > best.root.length) best = vault
  }
  return best
}
