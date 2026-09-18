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
  type ActionDescriptor,
  type Candidate,
  type CapabilityManifest,
  type FacetDeclaration,
  type PageRequest,
  type PreviewPayload,
  type SearchCapability,
  type SearchContext,
  type SearchPage,
  type SearchQuery,
} from '@onething/core/search'
import type { NoteVault } from '../../notes/types.js'
import { createSqliteLexicalRetriever } from '../index/service.js'
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
  payload: { filePath: string; actionId?: string }
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
  retrievers: { vector: { when: 'relaxed' } },
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
  const values = noteVaultsOf(adapters).map(vault => vault.id)
  const facets: FacetDeclaration[] = (notesSearchManifest.facets ?? []).map(facet =>
    facet.key === 'vault' ? { ...facet, values } : facet)
  return { ...notesSearchManifest, facets }
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

/** 这一类自报的两个动作 id(壳按 `kind` 画,按 `id` 回调 `search.invoke`)。 */
export const CREATE_DAILY_ACTION = 'create-daily'
export const CREATE_NOTE_ACTION = 'create-note'

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
function shortcutCandidate(shortcut: TodayShortcut, timestamp: number, score: number): ResultBackedCandidate {
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
    target: { kind: 'note', payload: { filePath: shortcut.filePath } } satisfies NoteTarget,
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

export function createNotesSearchCapability(
  adapters: OnethingSearchProvidersAdapters,
  index: SearchIndexQueryFace,
  now: () => Date = () => new Date(),
): SearchCapability {
  const tracked = trackIndexGeneration(index)

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
          target: { kind: 'note', payload: { filePath } } satisfies NoteTarget,
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
    const indexedPage = await indexed.search(query, page, ctx)
    // 翻页时不再补动作与快捷项 —— 它们是首页的事。
    if (page.cursor !== undefined) return indexedPage

    const today = now()
    const shortcut = await resolveTodayShortcut(adapters, query.raw, today).catch(() => undefined)

    const withShortcut = shortcut === undefined || !shortcut.exists
      ? indexedPage
      : mergeTodayShortcut(indexedPage, shortcut, today.getTime(), page.limit)

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

    return actions.length === 0 ? withShortcut : { ...withShortcut, actions }
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
    const candidate = shortcutCandidate(shortcut, timestamp, Math.max(0, ...rest.map(item => item.score)) + 1)
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
