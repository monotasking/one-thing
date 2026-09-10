/**
 * R3a 移植 —— `task`(派工)。§4 的 `SessionTool` 一族。
 *
 * 描述、参数、拒绝文案、metadata 逐字沿用旧 `tools/builtin/task.ts`;建会话 /
 * 驱动引擎 / 等终端事件 / 回投唤醒那台机器在 adapters 后面。
 *
 * ## `session_spawn`:报效果,弹一次卡
 *
 * 按 §4 家族表报一条 `session_spawn`,而那条 kind 在策略表里是 **`ask`**
 * (合表,2026-09-10 用户拍板「开子会话是真有后果的」,见 `core/toolkit/effects.ts`):
 * 派工会让另一个主体开始花钱和动手,这一下值一次同意;那条子会话里后续的每一次
 * 写盘 / 跑命令,由它自己的权限卡照常兜住(它继承调用方的权限模式),两道闸不是
 * 重复而是各管一段。
 *
 * R3a 复盘曾把这一行写成 `silent`,理由是"派工的本义就是派出去继续干"。那句话在
 * 真实的树里一天都没生效过 —— 判定核那一侧另有一份名单,派工照旧弹卡;合表删掉
 * 那份名单时顺带让策略表说了真话,所以**用户看到的东西没有变**。
 *
 * 效果同时是**审计**里那条证词:旧路里"这一回合派出去过一条会话"只留在日志里,
 * 谁都不能从工具调用本身读出来。屏障保留 —— 两次并发登记会把并发闸算错。
 */

import { z } from 'zod'
import type { JsonObject } from '@onething/core'
import { makeEffect } from '@onething/core/toolkit'
import type { Effect, PlanContext, Preview, Result, RunContext, Scene, ToolSpec } from '@onething/core/toolkit'
import {
  TASK_MAX_CONCURRENT_PER_SESSION,
  TASK_TOOL_ID,
  describeTaskRejection,
  type TaskRejectionReason,
} from '../../tasks/index.js'
import { defineInput } from '../contract.js'
import { SessionTool } from '../families/session.js'

export interface TaskDispatchRequest {
  /** 调用方会话 —— 完成回流投回它。 */
  callerSessionId: string
  prompt: string
  workingDirectory?: string
  model?: string
  description?: string
}

export type TaskDispatchOutcome =
  | {
    ok: true
    taskSessionId: string
    workingDirectory?: string
    running: number
  }
  | { ok: false; reason: TaskRejectionReason; detail?: string }

export interface TaskToolPorts {
  dispatch(request: TaskDispatchRequest, executionContext?: unknown): Promise<TaskDispatchOutcome>
}

export const TaskInputSchema = z.object({
  prompt: z.string().describe(
    'The task brief. The task session starts EMPTY — it does not see this conversation, so write everything it needs: what to do, where, what "done" looks like, and what to report back.',
  ),
  workingDirectory: z.string().optional().describe(
    'Working directory for the task session. Defaults to this session\'s working directory — pass it only to point the task somewhere else.',
  ),
  model: z.string().optional().describe(
    'Model id for the task session. Defaults to the model this session is running. It runs on THIS session\'s provider — a model id from another provider will fail in the task session.',
  ),
  description: z.string().optional().describe(
    'Short label (a few words) shown in the session list and in the report that comes back.',
  ),
})

export const TASK_DESCRIPTION = `Dispatch self-contained work to a BACKGROUND session and keep going. It returns immediately with the new session id — it does NOT wait; when that session finishes (done, failed or stopped) its full closing text is delivered back into THIS conversation on its own, so never poll and never promise to "check back".

The task session is a real session (visible in the session list, the user can open or take it over), starts empty (sees only your prompt), inherits this session's working directory (unless overridden), model and permission mode, and has the normal tools. It may stop on a permission card nobody is watching — prefer work that runs under this session's existing permissions. At most ${TASK_MAX_CONCURRENT_PER_SESSION} tasks per session run at once (a further dispatch is refused, not queued); a task session may NOT dispatch tasks of its own.

Use it for work that would otherwise eat this conversation (a codebase survey, a long build-and-fix loop, a batch of independent edits) — not to ask a question you could answer here. To stop one, open that session and stop it there.`

const TaskContract = defineInput(TaskInputSchema)

export type TaskInput = z.infer<typeof TaskInputSchema>

export class TaskTool extends SessionTool<TaskInput> {
  private readonly ports: TaskToolPorts

  readonly spec: ToolSpec = {
    id: TASK_TOOL_ID,
    title: 'Task',
    description: TASK_DESCRIPTION,
    input: TaskContract.schema,
    effects: ['session_spawn'],
    presentation: { kind: 'text', shell: 'default' },
    // 派工是一次登记(建会话 + 记账),两次并发登记会把并发闸算错。
    concurrency: 'sequential',
  }

  constructor(ports: TaskToolPorts) {
    super()
    this.ports = ports
  }

  /** 工作会话看不见 task —— 禁止套娃(旧场景表规则 3)。 */
  visibleIn(scene: Scene): boolean {
    return scene.taskSession !== true
  }

  protected effectsFor(input: TaskInput, ctx: PlanContext): Effect[] {
    const prompt = String(input.prompt ?? '').trim()
    // 空任务书根本不会开出会话(执行器提前判上),所以不报"我要开一条会话"。
    if (!prompt) return []
    return [makeEffect('session_spawn', [ctx.invocation.sessionId], {
      barrier: true,
      metadata: {
        description: input.description?.trim(),
        workingDirectory: input.workingDirectory?.trim(),
        model: input.model?.trim(),
      },
    })]
  }

  protected previewFor(input: TaskInput): Preview | undefined {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return undefined
    return {
      title: `Dispatch a background task: ${input.description?.trim() || prompt.slice(0, 60)}`,
      metadata: { description: input.description?.trim() },
    }
  }

  protected async perform(input: TaskInput, ctx: RunContext): Promise<Result> {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) {
      return this.done(ctx, 'Task rejected', describeTaskRejection('empty-prompt'), { rejected: true })
    }

    const outcome = await this.ports.dispatch({
      callerSessionId: ctx.invocation.sessionId,
      prompt,
      ...(input.workingDirectory?.trim() ? { workingDirectory: input.workingDirectory.trim() } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    }, ctx.invocation.executionContext)

    if (!outcome.ok) {
      return this.done(ctx, 'Task rejected', describeTaskRejection(outcome.reason, outcome.detail), { rejected: true })
    }

    const lines = [
      `Task started in session ${outcome.taskSessionId}.`,
      outcome.workingDirectory ? `Working directory: ${outcome.workingDirectory}` : undefined,
      `Running background tasks for this session: ${outcome.running}/${TASK_MAX_CONCURRENT_PER_SESSION}.`,
      'It will report back here on its own when it finishes — do not wait for it, and do not poll.',
    ].filter((line): line is string => Boolean(line))

    return this.done(
      ctx,
      input.description?.trim() || 'Task started',
      lines.join('\n'),
      { taskSessionId: outcome.taskSessionId, running: outcome.running },
    )
  }

  private done(ctx: RunContext, title: string, output: string, details: JsonObject): Result {
    ctx.emit({ type: 'annotate', title, details })
    return { content: [{ type: 'text', text: output }], details }
  }
}

export function createTaskTool(ports: TaskToolPorts): TaskTool {
  return new TaskTool(ports)
}
