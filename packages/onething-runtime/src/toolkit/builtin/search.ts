/**
 * S6 —— `search`:**AI 自己是搜索的消费者**。
 *
 * 设计:docs/design/search-index-2026-09.md §14。
 *
 * 助手拿到的这只工具走的是**同一份索引、同一条流水线、同一个注册表**,只是
 * `SearchContext.surface = 'agent-tool'`、`principal.kind = 'agent'`。索引即助手的
 * 记忆底座;这里不建第二套「记忆检索」。
 *
 * ## 这个文件里为什么一个能力名都没有
 *
 * 「加功能不许改骨架」那条法在这里的落点:`kind` 参数的合法取值是**注册表答的**
 * (`adapters.listKinds()`),结果行里的 `<kind>` 由候选自带,`expand` 的四种载荷
 * 按 `PreviewPayload.kind` 分派而不是按能力分派。于是 S7 加一个 symbol 能力时,
 * 这只工具**一字不改**就能搜符号(§14.4 的陌生能力演练)。
 *
 * 唯一一处按 kind 分支是 `expand` 的文本化(`renderPreview`),而它分的是**预览
 * 载荷的形**,不是能力 —— 四种形住 `search/capabilities/preview.ts`,认不出的形
 * 走 JSON 缩排兜底(不是报错:一个新能力带来一种新预览形,不该让 expand 塌掉)。
 *
 * ## 与协作 `history` 的关系
 *
 * 同一种模式(`HistoryTool` 靠注入的 `adapters.search` 查,这只靠注入的
 * `SearchToolAdapters` 查),runtime 不 import backend。两只工具在协作房里并存
 * **不越权**:messages 能力的 agent 支已经把「不是成员的房」排在查询之外
 * (§6.4b + `search/capabilities/visibility.ts`),不是靠这只工具自觉。
 *
 * ## 适配器没装 = 结构化拒绝,不是抛
 *
 * server / CLI / 单测里都可能没有索引。那时 `perform` 答一句「search unavailable」
 * 并把 `ok:false` 写进 details —— 与 `history` 拿不到结果时同一种形。抛出去会变成
 * 一次工具失败,而「这台宿主没有搜索」不是一次失败。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, Scene, ToolSpec } from '@onething/core/toolkit'
import { defineInput } from '../contract.js'
import { ReadOnlyTool } from '../families/read-only.js'

/* ── 适配器(装配层注入)────────────────────────────────────────────────── */

/** 一条结果:工具认识的全部。**没有 capability 之外的类型知识**。 */
export interface SearchToolHit {
  /** `${capability}:${candidate.id}` —— 跨调用稳定,`expand` 拿它回来。 */
  ref: string
  capability: string
  id: string
  title: string
  subtitle?: string
  time?: number
}

/**
 * **有一类没答完**(09-08:`docs/design/search-index-2026-09.md` §13.x 留账①)。
 *
 * 两种没答完,末行分开说:
 *  - `partial` —— 那一路的预算到点,交的是**已经扫到的那些**(core `SearchPage.partial`);
 *  - `error` —— 那一路根本没搜成(组级 `error`)。
 *
 * 为什么非说不可:两种情况下那一类的结果都是空的或短的,而工具的末行只报 `total`。
 * 不说,模型读到的就是「这一类没有」——把「没扫完」与「没有」画成一件事,正是
 * §13.x 那张表第 2 行判过的病。这一格里的 `capability` 是**数据**(响应里带回来的
 * 那个 id),这个文件照旧一个能力名都不认识。
 */
export interface SearchToolIncomplete {
  capability: string
  reason: 'partial' | 'error'
}

export interface SearchToolPage {
  hits: SearchToolHit[]
  /** 授权之后的真数(§6.4b);答不出就缺席,工具照实不印这一格。 */
  total?: number
  /** 放宽到了第几级(§6.2);0 / 缺席 = 没放宽。 */
  relaxed?: number
  /** 索引还欠着几把钥匙(§8);缺席 = 问不出来。 */
  pending?: number
  /** 哪几类没答完;缺席 / 空 = 每一类都答完了。 */
  incomplete?: readonly SearchToolIncomplete[]
}

export interface SearchToolQuery {
  query: string
  /** 能力 id;缺席 = 全部。 */
  capability?: string
  /** 只搜这一条会话(`scope: 'session'` 的落点)。 */
  sessionId?: string
  since?: number
  until?: number
  limit: number
  /**
   * 这次工具调用的取消口(`ctx.abort.signal`)。
   *
   * 检索一路到 `SearchContext.signal` 是**唯一**能真的停下一次外部枚举的东西
   * (09-08 事故第 3、4 条修:`fanout` 由它派生每一路的超时信号,扫盘那一路
   * abort 即 `kill()`)。工具的 abort scope 本来就有这条信号,不递等于这条路上
   * 只有工具自己知道该停了。缺席 = 不认取消(单测 / 老调用方),`createSearchContext`
   * 照旧兜一条永不 abort 的。
   */
  signal?: AbortSignal
}

/** 一次调用的坐标 —— 授权用的那三格(§14.3)。 */
export interface SearchToolPrincipal {
  executionContext?: unknown
  kind: 'user' | 'agent' | 'plugin'
  id: string
  sessionId: string
  spaceId: string
}

export interface SearchToolAdapters {
  /**
   * 现在注册表里有哪几类。**描述里那份清单从这里来**,不是写死的 ——
   * 注销一个能力,下一回合的工具描述就少一项。
   */
  listKinds(): readonly string[]
  search(query: SearchToolQuery, principal: SearchToolPrincipal): Promise<SearchToolPage>
  /** `expand` 那一路:一条 ref → 它那个能力的预览载荷。 */
  preview(ref: string, principal: SearchToolPrincipal): Promise<{ kind: string; payload: unknown; title?: string }>
}

let adapters: SearchToolAdapters | null = null

/**
 * 装上适配器;返回**还原**函数(判例同 `search/capabilities/visibility.ts`:
 * 还原而不是清空,两份宿主在同一进程里先后起落时不互相抹)。
 */
export function configureSearchToolAdapters(next: SearchToolAdapters | null): () => void {
  const previous = adapters
  adapters = next
  return () => {
    if (adapters === next) adapters = previous
  }
}

export function getSearchToolAdapters(): SearchToolAdapters | null {
  return adapters
}

/* ── 契约(§14.2 逐字)──────────────────────────────────────────────────── */

/** 一次最多给几条。上限而非建议(§14.2「预算」那一行)。 */
export const SEARCH_MAX_LIMIT = 20
export const SEARCH_DEFAULT_LIMIT = 8

export const SearchInputSchema = z.object({
  query: z.string().min(1)
    .describe('What to look for. Plain words; quotes for an exact phrase; -word to exclude.'),
  kind: z.string().optional()
    .describe('Restrict to one kind. Omit for everything. Kinds are listed in the tool description.'),
  scope: z.enum(['session', 'space', 'all']).optional()
    .describe('How far to look: this conversation, this space (default), or everything you may see.'),
  since: z.string().optional()
    .describe('Only results after this time: ISO date, or relative like 7d / 2w.'),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional()
    .describe(`Default ${SEARCH_DEFAULT_LIMIT}.`),
  expand: z.string().optional()
    .describe('A result id from a previous call: return its full context (the message with a few before and after, or the file excerpt) instead of searching.'),
})

const SearchContract = defineInput(SearchInputSchema)

export type SearchInput = z.infer<typeof SearchInputSchema>

/**
 * 描述。**kind 清单是参数**,由 `spec` 每次现算 —— 见文件头「这个文件里为什么一个
 * 能力名都没有」。
 *
 * `scope` 那两句说的是**事实**,不是回避指令(08-18 判例):`'all'` 在拍点辛 a 下
 * 就是「当前空间 + 我在的房」,把它说成「everything」而不注明上限才是撒谎。
 */
export function searchDescription(kinds: readonly string[]): string {
  const list = kinds.length > 0 ? kinds.join(', ') : '(none — this host has no search index)'
  return `Search everything you have access to — your own past work, and the material around it.

- kind restricts the search to one class of thing. Available kinds: ${list}. Omit it to search all of them.
- scope narrows, it never widens. "session" = this conversation only; "space" (default) and "all" are both bounded by what you are allowed to see, which is the non-collaborative sessions in your current space plus the rooms you are a member of — "all" does not mean every space.
- Results come back as [ref] lines. Pass a ref back as "expand" to read the full context around that hit instead of searching again.
- The last line reports the true totals: how many matched, whether the query had to be relaxed to find anything, whether the index is still catching up, and whether a kind came back "incomplete" (only part of it was looked at) or "failed" (that kind could not be searched at all) — in either case its absence from the results is not evidence that nothing is there.`
}

/* ── 输出 ────────────────────────────────────────────────────────────────── */

/** 一条结果一行:`[ref] <kind> · <title> · <time> — <snippet>`(§14.2)。 */
function hitLine(hit: SearchToolHit): string {
  const when = hit.time === undefined ? '' : ` · ${new Date(hit.time).toISOString().slice(0, 16).replace('T', ' ')}`
  const snippet = hit.subtitle === undefined || hit.subtitle.length === 0 ? '' : ` — ${hit.subtitle}`
  return `[${hit.ref}] ${hit.capability} · ${hit.title}${when}${snippet}`
}

/**
 * 末行的三格 —— **说实话那三格**(§14.2)。
 *
 * `relaxed` / `index pending` 只在**真的发生了**时才印:恒印一句 `relaxed 0` 会把
 * 「没放宽」说成一件需要注意的事,而它是常态。
 */
function tallyLine(page: SearchToolPage): string {
  const parts = [`total ${page.total ?? page.hits.length}`]
  if (page.relaxed !== undefined && page.relaxed > 0) parts.push(`relaxed ${page.relaxed}`)
  if (page.pending !== undefined && page.pending > 0) parts.push(`index pending ${page.pending}`)
  // 没答完的那几类排在最后,一类一格。同一条判词:只在**真的发生了**时才印。
  for (const note of page.incomplete ?? []) {
    parts.push(`${note.capability} ${note.reason === 'partial' ? 'incomplete' : 'failed'}`)
  }
  return parts.join(' · ')
}

/** 末行那几格的 JSON 形(details 里的 `incomplete`)。 */
function incompleteDetails(page: SearchToolPage): JsonObject {
  const notes = page.incomplete ?? []
  if (notes.length === 0) return {}
  return { incomplete: notes.map(note => ({ capability: note.capability, reason: note.reason })) }
}

/**
 * 一份预览载荷 → 文本。
 *
 * 分的是**载荷的形**(§4.5 那张表的四行),不是能力。认不出的形走 JSON 缩排:
 * 一个新能力带来一种新预览形是设计允许的常态,不该让 `expand` 塌掉 —— 缩排的
 * JSON 至少是**真的内容**,而一句「不支持」是把信息扔了。
 */
export function renderPreview(preview: { kind: string; payload: unknown; title?: string }): string {
  const payload = preview.payload
  const head = preview.title === undefined || preview.title.length === 0 ? '' : `${preview.title}\n\n`

  if (preview.kind === 'message-context' && isRecord(payload)) {
    const before = messageLines(payload.before)
    const after = messageLines(payload.after)
    const hit = isRecord(payload.hit) ? messageLine(payload.hit) : ''
    return `${head}${[...before, hit === '' ? undefined : `>>> ${hit}`, ...after]
      .filter((line): line is string => line !== undefined && line !== '')
      .join('\n')}`
  }

  if (preview.kind === 'session-overview' && isRecord(payload)) {
    const updated = typeof payload.updatedAt === 'number'
      ? new Date(payload.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
      : '?'
    const lines = [
      `${str(payload.title) || '(untitled)'}`,
      `${numberOf(payload.messageCount)} messages · last active ${updated}`,
    ]
    const preface = str(payload.preview)
    if (preface !== '') lines.push('', preface)
    return `${head}${lines.join('\n')}`
  }

  if (preview.kind === 'note-excerpt' && isRecord(payload)) {
    return `${head}${str(payload.title) || str(payload.path)}\n${str(payload.path)}\n\n${numbered(str(payload.excerpt))}`
  }

  // `file-excerpt` 只有路径(后端刻意不读正文,见 preview.ts 的文件头)。
  if (preview.kind === 'file-excerpt' && isRecord(payload)) {
    return `${head}${str(payload.path)}`
  }

  return `${head}${JSON.stringify(payload, null, 2)}`
}

function messageLines(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isRecord).map(messageLine) : []
}

function messageLine(message: Record<string, unknown>): string {
  const role = str(message.role) || '?'
  return `${role}: ${str(message.text)}`
}

/** 笔记片段带行号(§14.2「带行号片段」)。行号是**片段内**的序号,不是文件行号 —— 载荷里没有起始行,编一个绝对行号就是撒谎。 */
function numbered(excerpt: string): string {
  if (excerpt.length === 0) return ''
  return excerpt.split('\n').map((line, i) => `${String(i + 1).padStart(3, ' ')} | ${line}`).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/* ── 时间 ────────────────────────────────────────────────────────────────── */

/**
 * `since` / `until` → 毫秒。ISO 日期,或 `7d` / `2w` 这类相对量。
 *
 * 认不出就**缺席**(不抛):模型写了一个解析不了的时间,把整次搜索打掉不如照旧
 * 搜一遍 —— 结果里带不带时间窗,模型自己从行上的时间看得出来。
 */
export function parseSearchTime(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const relative = /^(\d+)\s*([hdwmy])$/i.exec(value.trim())
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2]!.toLowerCase()
    const ms = unit === 'h' ? 3_600_000
      : unit === 'd' ? 86_400_000
        : unit === 'w' ? 604_800_000
          : unit === 'm' ? 2_592_000_000
            : 31_536_000_000
    return now - amount * ms
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/* ── 工具 ────────────────────────────────────────────────────────────────── */

/**
 * 提示词(随回合面进出,同 `edit` 那套)。
 *
 * **写事实不写回避指令**(08 判例):这里说的是「什么时候这个工具有用」与「引用
 * 时带什么」,不是「不要凭记忆回答」——后者是一句劝导,而劝导对不接的宿主无效
 * (「结构修复不劝导」那条判例)。
 */
export const SEARCH_TOOL_PROMPT = {
  guidelines: [
    '用户提到「上次」「之前聊过」「那个文件是哪次改的」这类指回过去的说法时，先用 search 查，再据结果回答。',
    '引用检索结果时带上它的 id 或时间，不要把整段原文复述一遍。',
  ],
} as const

export class SearchTool extends ReadOnlyTool<SearchInput> {
  /**
   * **每次现算**:描述里的 kind 清单要跟着注册表走(注销一个能力就少一项)。
   * 算一次是一个 `join` —— 便宜到不值得为它引入一份会过期的缓存。
   */
  get spec(): ToolSpec {
    return {
      id: 'search',
      title: 'Search',
      description: searchDescription(adapters?.listKinds() ?? []),
      input: SearchContract.schema,
      effects: [],
      presentation: { kind: 'search', shell: 'default' },
      concurrency: 'parallel',
      prompt: SEARCH_TOOL_PROMPT,
    }
  }

  /**
   * 场景面:普通聊天 / goal / task / 协作房**都可见**。
   *
   * 协作房里与 `history` 并存不越权 —— 越权由 messages 能力的 agent 支挡
   * (§14.2「场景」那一行)。所以这里不写 `visibleIn`,吃基类的「到处成立」;
   * 留这个方法只是为了让「恒真是一个决定」被读出来,而不是被当成忘了写。
   */
  visibleIn(_scene: Scene): boolean {
    return true
  }

  protected async perform(input: SearchInput, ctx: RunContext): Promise<Result> {
    const installed = adapters
    if (installed === null) {
      return done(ctx, 'Search — 不可用', 'search unavailable: this host has no search index.', {
        ok: false,
        reason: 'no-adapters',
      })
    }

    const principal = principalOf(ctx)

    if (input.expand !== undefined && input.expand.length > 0) {
      return await this.expand(installed, input.expand, principal, ctx)
    }

    const limit = Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)
    const now = ctx.now()
    const query: SearchToolQuery = {
      query: input.query,
      ...(input.kind === undefined ? {} : { capability: input.kind }),
      // `scope` 只能**收窄**:'session' 加一条会话过滤,'space' / 'all' 都不放宽 ——
      // 上限由 visibility 定(§14.2)。
      ...(input.scope === 'session' ? { sessionId: principal.sessionId } : {}),
      ...(withValue('since', parseSearchTime(input.since, now))),
      ...(withValue('until', parseSearchTime(input.until, now))),
      limit,
      signal: ctx.abort.signal,
    }

    ctx.emit({
      type: 'partial',
      result: {
        content: [{ type: 'text', text: `Searching ${input.kind ?? 'everything'}…` }],
        details: { phase: 'running' },
      },
    })

    let page: SearchToolPage
    try {
      page = await installed.search(query, principal)
    } catch (error) {
      return done(ctx, 'Search — 查不了', messageOf(error), { ok: false })
    }

    if (page.hits.length === 0) {
      return done(
        ctx,
        'Search · 0 条',
        `Nothing matched.\n${tallyLine(page)}`,
        {
          ok: true,
          returned: 0,
          ...(page.total === undefined ? {} : { total: page.total }),
          ...incompleteDetails(page),
        },
      )
    }

    return done(
      ctx,
      `Search · ${page.hits.length} 条`,
      [...page.hits.map(hitLine), '', tallyLine(page)].join('\n'),
      {
        ok: true,
        returned: page.hits.length,
        ...(page.total === undefined ? {} : { total: page.total }),
        ...(page.relaxed === undefined ? {} : { relaxed: page.relaxed }),
        ...incompleteDetails(page),
      },
    )
  }

  private async expand(
    installed: SearchToolAdapters,
    ref: string,
    principal: SearchToolPrincipal,
    ctx: RunContext,
  ): Promise<Result> {
    try {
      const preview = await installed.preview(ref, principal)
      return done(ctx, `Search · ${ref}`, renderPreview(preview), { ok: true, ref, kind: preview.kind })
    } catch (error) {
      return done(ctx, 'Search — 展不开', messageOf(error), { ok: false, ref })
    }
  }
}

/**
 * 主体 = 调用坐标上那一个,**不是这一层现编的**(§14.3)。
 *
 * core 的 `Principal` 有 `system` 这一支而 `SearchPrincipal` 没有:映射成 `agent`
 * 而不是 `user` —— `systemPrincipal` 是最小权限的那一个(见
 * `core/permission/principal.ts` 的原话),把它读成用户就是把兜底变成绕过。
 */
function principalOf(ctx: RunContext): SearchToolPrincipal {
  const principal = ctx.invocation.principal
  const sessionId = ctx.invocation.sessionId
  const metadata = ctx.session?.metadata
  const spaceId = metadata !== undefined && typeof metadata.workspaceId === 'string'
    ? metadata.workspaceId
    : ''

  const executionContext = ctx.invocation.executionContext
  if (principal.kind === 'user') return { kind: 'user', id: principal.userId, sessionId, spaceId, executionContext }
  if (principal.kind === 'agent') return { kind: 'agent', id: principal.agentId, sessionId, spaceId, executionContext }
  return { kind: 'agent', id: `system:${principal.component}`, sessionId, spaceId, executionContext }
}

function withValue(key: 'since' | 'until', value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : '搜不了。'
}

function done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
  ctx.emit({ type: 'annotate', title, details })
  return { content: [{ type: 'text', text: output }], details }
}

export function createSearchTool(): SearchTool {
  return new SearchTool()
}
