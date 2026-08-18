/**
 * R3a 移植 —— `history`。§4 的 `CollabTool` 一族。
 *
 * 描述、参数、五态空结果、覆盖面提示、上限逐字沿用旧 `tools/builtin/history.ts`;
 * 扫房 / 可见性 / 游标那套在 adapters 后面(`app/collab/history-tool.ts` 的
 * `searchCollabHistory`)。
 *
 * 场子门:面上由 `CollabTool.visibleIn` 摘;硬调时的拒绝仍由执行器给
 * (`result.ok === false` + 它自己的 error)—— 那句话是执行器的资产。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { CollabVenueTool } from '../../collab/tool-surface.js'
import { defineInput } from '../contract.js'
import { CollabTool, type CollabToolAdapters, type CollabScope } from '../families/collab.js'

export interface HistoryEntry {
  /** `<message>` 信封原样,与房间投影同一种形状。 */
  line: string
}

export interface HistoryToolResult {
  ok: boolean
  entries?: HistoryEntry[]
  total?: number
  nextCursor?: string
  scannedRooms?: number
  skippedRooms?: number
  fellBackToRange?: boolean
  noRooms?: boolean
  unknownRoom?: { available: string[] }
  endOfRange?: boolean
  error?: string
}

export interface HistoryToolAdapters extends CollabToolAdapters {
  search(input: {
    sessionId: string
    q?: string
    who?: string
    where?: string
    since?: string
    until?: string
    limit: number
    cursor?: string
  }): Promise<HistoryToolResult>
}

/** 一次最多返回多少条。上限而非建议。 */
export const HISTORY_MAX_LIMIT = 30
const HISTORY_DEFAULT_LIMIT = 10

export const HistoryInputSchema = z.object({
  q: z.string().optional()
    .describe('Only messages containing this text. Plain substring, case-insensitive — no tokenising, no fuzzy match. Pass one or two keywords, never a whole sentence: a sentence almost never appears verbatim. If it matches nothing, you get the most recent messages in the same range instead, clearly marked.'),
  who: z.string().optional()
    .describe('Only messages from this speaker — a name or 名字#句柄 as it appears in a roster, 「用户」 for the human, 「系统」 for room system lines. Leave out for everyone.'),
  where: z.string().optional()
    .describe('Which room: a room name, or 名字#句柄 to mean your private chat with that colleague. Leave out to search every room you are in.'),
  since: z.string().optional()
    .describe('Earliest day to look at, YYYY-MM-DD.'),
  until: z.string().optional()
    .describe('Latest day to look at, YYYY-MM-DD.'),
  limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional()
    .describe(`How many messages to return, newest first. Default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}.`),
  cursor: z.string().optional()
    .describe('Continue from a previous call — pass the nextCursor it returned. Paging always walks towards OLDER messages, and a cursor only works with the exact same filters.'),
})

export const HISTORY_DESCRIPTION = `Search the chat history of any room you are in — group rooms and private chats alike.

- Scope is fixed by who you are: every room you are a member of, plus rooms you were removed from (up to the moment you left). Conversations you were never part of do not exist for this tool.
- Narrow it down: "where" (a room, or a colleague for your private chat with them), "who", "since"/"until" (YYYY-MM-DD), "q".
- Results are capped (max ${HISTORY_MAX_LIMIT}) and come back newest first, in the same <message> form as your room payload. If there are more, pass the returned cursor.
- Anything this tool leaves out says so in the output — a short result is never silent truncation.`

const HistoryContract = defineInput(HistoryInputSchema)

export type HistoryInput = z.infer<typeof HistoryInputSchema>

/** 空结果的五态。顺序即优先级。逐字沿用旧实现。 */
function emptyOutput(result: HistoryToolResult): string {
  if (result.noRooms) {
    return '你还没有加入任何房间,没有可查的历史。'
  }
  if (result.unknownRoom) {
    const names = result.unknownRoom.available
    return names.length
      ? `没有这样一间房。你能查的是:${names.join('、')}。`
      : '没有这样一间房。'
  }
  if (result.endOfRange) {
    return '已经翻到最早的一条了,这个范围里没有更早的消息。'
  }
  return '这个范围里没有任何消息。换个时间段、换个人,或者去掉筛选条件再看看。'
}

/** 覆盖面与每一处截断,都要出一行。逐字沿用旧实现。 */
function noticeLines(result: HistoryToolResult): string[] {
  const lines: string[] = []
  if (result.fellBackToRange) {
    lines.push('(没有匹配到关键词。以下是这个范围里最近的几条。)')
  }
  if (result.skippedRooms) {
    const scanned = typeof result.scannedRooms === 'number' ? `查了 ${result.scannedRooms} 间房,` : ''
    lines.push(`(${scanned}还有 ${result.skippedRooms} 间这次没查到。缩小 where 或时间范围可以覆盖它们。)`)
  } else if (typeof result.scannedRooms === 'number' && result.scannedRooms > 0) {
    lines.push(`(查了 ${result.scannedRooms} 间房。)`)
  }
  return lines
}

export class HistoryTool extends CollabTool<HistoryInput> {
  protected readonly venueTool: CollabVenueTool = 'history'
  private readonly adapters: HistoryToolAdapters

  readonly spec: ToolSpec = {
    id: 'history',
    title: 'History',
    description: HISTORY_DESCRIPTION,
    input: HistoryContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(adapters: HistoryToolAdapters) {
    super(adapters)
    this.adapters = adapters
  }

  protected async perform(scope: CollabScope<HistoryInput>, ctx: RunContext): Promise<Result> {
    const args = scope.input
    const result = await this.adapters.search({
      sessionId: scope.sessionId,
      ...(args.q ? { q: args.q } : {}),
      ...(args.who ? { who: args.who } : {}),
      ...(args.where ? { where: args.where } : {}),
      ...(args.since ? { since: args.since } : {}),
      ...(args.until ? { until: args.until } : {}),
      limit: Math.min(args.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    })

    if (!result.ok) {
      return this.done(ctx, 'History — 查不了', result.error ?? '翻不了历史。', { ok: false })
    }

    const entries = result.entries ?? []
    const notices = noticeLines(result)

    if (entries.length === 0) {
      const seen = result.endOfRange && result.total
        ? `\n(这个范围里一共 ${result.total} 条,你已经全部翻过。)`
        : ''
      return this.done(
        ctx,
        'History',
        [emptyOutput(result), ...notices].join('\n') + seen,
        {
          ok: true,
          returned: 0,
          // 空页 ≠ 命中数为零:带游标翻到尽头时 total 是这次查询的全部命中。
          total: result.total ?? 0,
          ...(typeof result.scannedRooms === 'number' ? { scannedRooms: result.scannedRooms } : {}),
          ...(result.skippedRooms ? { skippedRooms: result.skippedRooms } : {}),
        },
      )
    }

    const more = result.nextCursor
      ? `\n\n还有更早的 —— 再查一次并带上 cursor="${result.nextCursor}"(筛选条件要保持一致)。`
      : ''
    return this.done(
      ctx,
      `History · ${entries.length} 条`,
      [
        ...notices,
        entries.map(entry => entry.line).join('\n'),
      ].filter(Boolean).join('\n') + more,
      {
        ok: true,
        returned: entries.length,
        ...(typeof result.total === 'number' ? { total: result.total } : {}),
        ...(typeof result.scannedRooms === 'number' ? { scannedRooms: result.scannedRooms } : {}),
        ...(result.skippedRooms ? { skippedRooms: result.skippedRooms } : {}),
      },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createHistoryTool(adapters: HistoryToolAdapters): HistoryTool {
  return new HistoryTool(adapters)
}
