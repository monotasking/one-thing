import { z } from 'zod'
import type { JsonObject, JsonObjectProperty } from '@onething/core'
import { Tool } from '../tool.js'
import {
  TASK_MAX_CONCURRENT_PER_SESSION,
  TASK_TOOL_ID,
  describeTaskRejection,
  type TaskRejectionReason,
} from '../../tasks/index.js'

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
    /** 工作会话真正落到的工作目录(缺省 = 调用方会话的)。 */
    workingDirectory?: string
    /** 这条调用方会话上此刻在跑的工作会话数(含这一条)。 */
    running: number
  }
  | { ok: false; reason: TaskRejectionReason; detail?: string }

export interface TaskToolPorts {
  dispatch(request: TaskDispatchRequest): Promise<TaskDispatchOutcome>
}

const TaskParameters = z.object({
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

interface TaskMetadata extends JsonObject {
  taskSessionId?: string
  running?: number
  rejected?: boolean
  [key: string]: JsonObjectProperty
}

/**
 * 派工工具(自举差距审计 P0-3 / P0-5)。
 *
 * 语义是 **fire-and-report**,不是 fire-and-forget,也不是阻塞等待:
 * 调用当场返回一个 `taskSessionId`,调用方这一回合继续往下走;工作会话跑完
 * (complete / error / aborted 都算)会**主动把结果投回来**,走的是与插件
 * `api.sendMessage` 同一条唤醒路径(空闲起一轮、在忙降级为 steer),所以
 * 调用方是被**叫醒**的,不需要轮询。
 *
 * 工具描述里的每一句都是真的、也是必须说的:后台异步、会回投、可能停在审批卡、
 * 并发上限、不许套娃。一个说得比实际能力大的描述会让模型替用户许下做不到的承诺。
 */
export function createTaskTool(
  ports: TaskToolPorts,
): Tool.Info<typeof TaskParameters, TaskMetadata> {
  return Tool.define<typeof TaskParameters, TaskMetadata>(TASK_TOOL_ID, {
    name: 'Task',
    description: `Dispatch self-contained work to a BACKGROUND session and keep going. It returns immediately with the new session id — it does NOT wait; when that session finishes (done, failed or stopped) its full closing text is delivered back into THIS conversation on its own, so never poll and never promise to "check back".

The task session is a real session (visible in the session list, the user can open or take it over), starts empty (sees only your prompt), inherits this session's working directory (unless overridden), model and permission mode, and has the normal tools. It may stop on a permission card nobody is watching — prefer work that runs under this session's existing permissions. At most ${TASK_MAX_CONCURRENT_PER_SESSION} tasks per session run at once (a further dispatch is refused, not queued); a task session may NOT dispatch tasks of its own.

Use it for work that would otherwise eat this conversation (a codebase survey, a long build-and-fix loop, a batch of independent edits) — not to ask a question you could answer here. To stop one, open that session and stop it there.`,
    category: 'builtin',
    enabled: true,
    autoExecute: true,
    // 本工具自己不碰文件系统;工作会话里的每一次真实副作用都在**那条会话**上
    // 照常走审批。在这里再要一次审批只会让派工这个动作本身变得昂贵。
    permissionGuard: 'safe',
    // 派工是一次登记(建会话 + 记账),两次并发登记会把并发闸算错。
    executionMode: 'sequential',
    renderKind: 'text',

    parameters: TaskParameters,

    async execute(args, ctx) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) {
        return {
          title: 'Task rejected',
          output: describeTaskRejection('empty-prompt'),
          metadata: { rejected: true },
        }
      }

      const outcome = await ports.dispatch({
        callerSessionId: ctx.sessionId,
        prompt,
        ...(args.workingDirectory?.trim() ? { workingDirectory: args.workingDirectory.trim() } : {}),
        ...(args.model?.trim() ? { model: args.model.trim() } : {}),
        ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      })

      if (!outcome.ok) {
        return {
          title: 'Task rejected',
          output: describeTaskRejection(outcome.reason, outcome.detail),
          metadata: { rejected: true },
        }
      }

      const lines = [
        `Task started in session ${outcome.taskSessionId}.`,
        outcome.workingDirectory ? `Working directory: ${outcome.workingDirectory}` : undefined,
        `Running background tasks for this session: ${outcome.running}/${TASK_MAX_CONCURRENT_PER_SESSION}.`,
        'It will report back here on its own when it finishes — do not wait for it, and do not poll.',
      ].filter((line): line is string => Boolean(line))

      return {
        title: args.description?.trim() || 'Task started',
        output: lines.join('\n'),
        metadata: {
          taskSessionId: outcome.taskSessionId,
          running: outcome.running,
        },
      }
    },
  })
}
