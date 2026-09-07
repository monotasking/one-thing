/**
 * R3a 移植 —— `board`。§4 的 `CollabTool` 一族。
 *
 * 描述、参数、动作映射、拒绝文案、回执逐字沿用旧 `tools/builtin/board.ts`;
 * rev / 广播 / 协调器事件照旧全部在 adapters 后面(`app/collab/board-store.ts`)。
 *
 * ## 与旧实现的一处结构差别(行为等价)
 *
 * 旧的 app 装配壳 `resolveContext(sessionId)` 里做三件事:场子门、房间解析、
 * 取 `session.agentId`。前后两件在 R3a 收进了 `CollabTool`(门走
 * `COLLAB_TOOL_VENUES` 一张表,actor 走 `principal` 优先),留给适配层的只剩
 * **房间解析**这一件 —— 而"房场子的房是它自己"是这个工具的事实,不是场子表的
 * 事实,所以那一句判断留在这里。
 *
 * 等价性:`chat`(含 kind 缺席的网关会话)照旧拿不到 context,工具回那句
 * 「boards exist only in collab rooms and their work sessions」。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { CollabVenueTool } from '../../collab/tool-surface.js'
import {
  COLLAB_BOARD_START_RECEIPT_NOTE,
  COLLAB_TASK_STATUSES,
  renderCollabBoardDigest,
  type CollabBoard,
  type CollabBoardAction,
  type CollabTask,
  type CollabTaskStatus,
} from '../../collab/index.js'
import { defineInput } from '../contract.js'
import { CollabTool, type CollabToolAdapters, type CollabScope } from '../families/collab.js'

export interface BoardToolContext {
  roomSessionId: string
  /** The acting agent; undefined = the user side. */
  actorAgentId?: string
}

export interface BoardToolAdapters extends CollabToolAdapters {
  /**
   * 这条会话挂着的那间房(work 的母房、agent 这一轮在答的那间房)。
   * `room` 场子**不**走它 —— 那间房就是它自己。
   */
  resolveLinkedRoom(sessionId: string, executionContext?: unknown): string | undefined
  /** Member display name → agent id (accepts an id passthrough too). */
  resolveMember(roomSessionId: string, nameOrId: string, executionContext?: unknown): string | null
  agentName(agentId: string): string
  applyAction(
    roomSessionId: string,
    action: CollabBoardAction,
    actor: { type: 'user' | 'agent'; agentId?: string },
    options?: { executionContext?: unknown; sourceSessionId: string },
  ): Promise<{ board: CollabBoard; task?: CollabTask; error?: string }>
}

export const BoardInputSchema = z.object({
  action: z.enum(['list', 'create', 'start', 'assign', 'move', 'update', 'comment', 'complete', 'block']),
  taskId: z.string().optional().describe('Target task id (from action:list). Required for everything except list/create/start — start without a taskId creates the card it starts.'),
  title: z.string().optional().describe('create/update/start: task title (start uses it only when there is no taskId)'),
  description: z.string().optional().describe('create/update/start: task detail — everything the assignee needs to execute independently'),
  assignee: z.string().optional().describe('create/assign: the member, as the roster writes them — 名字#句柄 (or just #句柄). A bare name works when only one member goes by it.'),
  status: z.enum(COLLAB_TASK_STATUSES as [CollabTaskStatus, ...CollabTaskStatus[]]).optional()
    .describe('move: target column'),
  expectedRev: z.number().optional().describe('assign/move/update/complete/block: the task rev you last read — stale revs are rejected so you never overwrite someone else\'s change'),
  comment: z.string().optional().describe('comment: note appended to the task\'s activity log'),
  summary: z.string().optional().describe('complete: delivery report (≤2000 chars) — it is posted into the room under your name and reviewed'),
  reason: z.string().optional().describe('block (and move→blocked): why the task cannot proceed — say what you tried and what stopped you; it is stored on the card and shown to whoever has to unblock it'),
})

export const BOARD_DESCRIPTION = `The room's shared task board (kanban). Columns: backlog → todo → doing → review → done, plus blocked.

- list: read the current board (do this before mutating — you need each task's rev).
- create: add a task. Give it a title and a description complete enough to execute without asking. Adding "assignee" puts it on that member's todo and tells them — they decide when to start.
- start: START WORKING on a task, right now, in your own work session (full tools, its own turn budget and a 30-minute wall clock). Use it for anything that needs more than a couple of tool calls or touches several files. Without a taskId it creates the card first, so you never have to leave the work to file paperwork. You can only start a card that is unassigned (you claim it) or already yours. It is also how you RESUME a card that was interrupted — the same work session is reopened with your history intact.
- assign: put a task on a member (by 名字#句柄, as the roster and this board write them). Assigning is a notification, not a launch: the assignee gets told, and can ask questions, start, or block it.
- move: change a task's column. Moving an assigned card back to todo (from review, blocked or done) actually re-runs it in a fresh work session — it is a real retry, not a label change.
- comment: append a note to the task's activity log.
- complete: (as the assignee, from your work session) declare the task done with a delivery summary — it moves to review, your summary is posted to the room, and the reviewer takes over. Call this exactly once, as your final action.
- block: mark the task stuck and say why (pass "reason" — it is stored on the card and read by whoever unblocks it). A card that halts twice stops being retried automatically and waits for the user.

State-changing actions (start/assign/move/update/complete/block) take expectedRev from your last read; a stale rev is rejected — re-list and retry.`

const BoardContract = defineInput(BoardInputSchema)

export type BoardInput = z.infer<typeof BoardInputSchema>

export class BoardTool extends CollabTool<BoardInput> {
  protected readonly venueTool: CollabVenueTool = 'board'
  private readonly adapters: BoardToolAdapters

  readonly spec: ToolSpec = {
    id: 'board',
    title: 'Board',
    description: BOARD_DESCRIPTION,
    input: BoardContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'sequential',
  }

  constructor(adapters: BoardToolAdapters) {
    super(adapters)
    this.adapters = adapters
  }

  private contextOf(scope: CollabScope<BoardInput>, executionContext?: unknown): BoardToolContext | null {
    if (!scope.allowed) return null
    if (scope.venue === 'room') {
      return { roomSessionId: scope.sessionId, ...(scope.actorAgentId ? { actorAgentId: scope.actorAgentId } : {}) }
    }
    // W18: a room turn runs in the agent's own execution session, which carries
    // the room it is currently answering — same shape a work session uses.
    const linked = this.adapters.resolveLinkedRoom(scope.sessionId, executionContext)
    if (linked) return { roomSessionId: linked, ...(scope.actorAgentId ? { actorAgentId: scope.actorAgentId } : {}) }
    return null
  }

  protected async perform(scope: CollabScope<BoardInput>, ctx: RunContext): Promise<Result> {
    const args = scope.input
    const context = this.contextOf(scope, ctx.invocation.executionContext)
    if (!context) {
      return this.done(
        ctx,
        'Board unavailable',
        'This session has no room board (boards exist only in collab rooms and their work sessions).',
        { action: args.action },
      )
    }
    const actor = context.actorAgentId
      ? { type: 'agent' as const, agentId: context.actorAgentId }
      : { type: 'user' as const }

    const planned = this.toAction(args, context, ctx.invocation.executionContext)
    if ('error' in planned) {
      return this.done(ctx, 'Board — invalid call', planned.error, { action: args.action, taskId: args.taskId })
    }

    const result = await this.adapters.applyAction(context.roomSessionId, planned, actor, {
      executionContext: ctx.invocation.executionContext, sourceSessionId: scope.sessionId,
    })
    if (result.error) {
      return this.done(ctx, 'Board — rejected', result.error, { action: args.action, taskId: args.taskId })
    }

    // W10: an agent reads its own cards as 「你(小研)」.
    const self = context.actorAgentId
      ? { agentId: context.actorAgentId, name: this.adapters.agentName(context.actorAgentId) }
      : undefined
    const digest = renderCollabBoardDigest(result.board, this.adapters.agentName, self)
    const headline = result.task
      ? `${args.action} ok: #${result.task.id.slice(0, 8)}「${result.task.title}」[${result.task.status}] rev${result.task.rev}`
      : 'board'
    // C3-5:`start` 派生了一整条工作会话,回执必须说出来 —— 不说,模型就会在
    // 这一轮里自己再干一遍那件重活。只在真的开成了(卡进 `doing`)时说。
    const note =
      args.action === 'start' && result.task?.status === 'doing'
        ? `\n${COLLAB_BOARD_START_RECEIPT_NOTE}`
        : ''
    return this.done(
      ctx,
      `Board — ${args.action}`,
      `${headline}${note}\n\n${digest}`,
      { action: args.action, taskId: result.task?.id ?? args.taskId },
    )
  }

  /** 与旧实现逐字相同的动作映射。 */
  private toAction(args: BoardInput, context: BoardToolContext, executionContext?: unknown): CollabBoardAction | { error: string } {
    switch (args.action) {
      case 'list':
        return { action: 'list' }
      case 'create':
        return {
          action: 'create',
          title: args.title ?? '',
          description: args.description,
          assigneeAgentId: args.assignee
            ? this.adapters.resolveMember(context.roomSessionId, args.assignee, executionContext) ?? undefined
            : undefined,
        }
      case 'start':
        return {
          action: 'start',
          ...(args.taskId ? { taskId: args.taskId } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
          ...(args.expectedRev !== undefined ? { expectedRev: args.expectedRev } : {}),
        }
      case 'assign': {
        if (!args.taskId) return { error: 'assign requires taskId' }
        const member = args.assignee
          ? this.adapters.resolveMember(context.roomSessionId, args.assignee, executionContext)
          : null
        if (!member) return { error: `Unknown member: ${args.assignee ?? '(missing assignee)'}` }
        return { action: 'assign', taskId: args.taskId, assigneeAgentId: member, expectedRev: args.expectedRev }
      }
      case 'move':
        if (!args.taskId || !args.status) return { error: 'move requires taskId and status' }
        return { action: 'move', taskId: args.taskId, status: args.status, expectedRev: args.expectedRev, reason: args.reason }
      case 'update':
        if (!args.taskId) return { error: 'update requires taskId' }
        return { action: 'update', taskId: args.taskId, title: args.title, description: args.description, expectedRev: args.expectedRev }
      case 'comment':
        if (!args.taskId || !args.comment) return { error: 'comment requires taskId and comment' }
        return { action: 'comment', taskId: args.taskId, comment: args.comment }
      case 'complete':
        if (!args.taskId || !args.summary) return { error: 'complete requires taskId and summary' }
        return { action: 'complete', taskId: args.taskId, summary: args.summary, expectedRev: args.expectedRev }
      case 'block':
        if (!args.taskId) return { error: 'block requires taskId' }
        return { action: 'block', taskId: args.taskId, reason: args.reason, expectedRev: args.expectedRev }
    }
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createBoardTool(adapters: BoardToolAdapters): BoardTool {
  return new BoardTool(adapters)
}
