/**
 * R3a 移植 —— `notebook`。§4 的 `CollabTool` 一族。
 *
 * 描述、参数、上限、回执与预算提示逐字沿用旧 `tools/builtin/notebook.ts`;
 * 身份识别、场子门与落盘照旧在 adapters 后面(那两句拒绝文案是执行器的资产)。
 *
 * 预算与单条上限直接吃纯规则模块(`collab/actors/notebook-rules.ts`)而不是抄
 * 两个数字:它在描述里、在回执里、在注入面各出现一次,三处各写一个字面量迟早
 * 分家,而分家的形态是「工具说 1500,实际截在 800」这种没人看得出来的谎。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import type { Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import type { CollabVenueTool } from '../../collab/tool-surface.js'
import {
  COLLAB_NOTEBOOK_ENTRY_MAX_CHARS,
  COLLAB_NOTEBOOK_INJECT_MAX_CHARS,
} from '../../collab/actors/notebook-rules.js'
import { defineInput } from '../contract.js'
import { CollabTool, type CollabToolAdapters, type CollabScope } from '../families/collab.js'

export interface NotebookToolResult {
  ok: boolean
  entry?: string
  totalChars?: number
  budgetChars?: number
  error?: string
}

export interface NotebookToolAdapters extends CollabToolAdapters {
  append(input: { sessionId: string; note: string }, executionContext?: unknown): Promise<NotebookToolResult>
}

/** 单次写入的字符上限。落盘那一侧按同一个数截并声明。 */
export const NOTEBOOK_NOTE_MAX_CHARS = COLLAB_NOTEBOOK_ENTRY_MAX_CHARS

export const NotebookInputSchema = z.object({
  note: z.string().min(1).max(NOTEBOOK_NOTE_MAX_CHARS * 4)
    .describe('What to remember, in one or two sentences. Write the conclusion, not the transcript — 「答应了老王周四前给方案」, not a recap of the conversation. It is appended with a timestamp; nothing is ever overwritten.'),
})

export const NOTEBOOK_DESCRIPTION = `Your own notebook — the one thing you carry between rooms.

Each room keeps its own history, and you only ever see envelopes of what happened elsewhere ("someone messaged you in that room"), never the words. Anything you want to still know when you are somewhere else has to be written here.

- Append-only, timestamped. There is no edit and no delete.
- Worth writing: what you promised, what you decided, what you learnt about someone. Not worth writing: what was just said (that is in the room's own history).
- Only the most recent stretch is shown to you each turn (about ${COLLAB_NOTEBOOK_INJECT_MAX_CHARS} characters), so old notes fade out. Keep entries short.`

const NotebookContract = defineInput(NotebookInputSchema)

export type NotebookInput = z.infer<typeof NotebookInputSchema>

export class NotebookTool extends CollabTool<NotebookInput> {
  protected readonly venueTool: CollabVenueTool = 'notebook'
  private readonly adapters: NotebookToolAdapters

  readonly spec: ToolSpec = {
    id: 'notebook',
    title: 'Notebook',
    description: NOTEBOOK_DESCRIPTION,
    input: NotebookContract.schema,
    effects: [],
    presentation: { kind: 'text', shell: 'default' },
    concurrency: 'parallel',
  }

  constructor(adapters: NotebookToolAdapters) {
    super(adapters)
    this.adapters = adapters
  }

  protected async perform(scope: CollabScope<NotebookInput>, ctx: RunContext): Promise<Result> {
    const result = await this.adapters.append({ sessionId: scope.sessionId, note: scope.input.note }, ctx.invocation.executionContext)

    if (!result.ok) {
      return this.done(ctx, 'Notebook — 记不了', result.error ?? '这条笔记没能记下来。', { ok: false })
    }

    // 预算说在回执里,而不是只说在工具描述里:描述是一次性的,而「我的笔记已经
    // 写满了」是一个会随时间变化的事实,只有写入的那一刻说得准。
    const budget = result.budgetChars ?? 0
    const total = result.totalChars ?? 0
    const pressure = budget > 0 && total > budget
      ? `\n(笔记已经超过每轮能带上的 ${budget} 字,更早的那些从下一轮起不再出现在你眼前。)`
      : ''

    return this.done(
      ctx,
      'Notebook',
      `记下了。\n${result.entry ?? ''}${pressure}`,
      {
        ok: true,
        ...(typeof result.totalChars === 'number' ? { totalChars: result.totalChars } : {}),
      },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createNotebookTool(adapters: NotebookToolAdapters): NotebookTool {
  return new NotebookTool(adapters)
}
