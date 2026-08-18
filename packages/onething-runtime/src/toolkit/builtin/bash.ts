/**
 * R1 移植 —— `bash`。`ProcessTool` 一族。
 *
 * 三态判定不再靠错误消息的字符串:超时是子作用域(`ctx.abort.child({timeoutMs})`)
 * 说的,取消是父作用域说的,退出码是执行器说的 —— 三个独立的证人,不再互相冒充。
 * 分类、越界、输出累积与落盘全部在家族基类或旧树的纯模块里,这里只剩"壳":读参数、
 * 挑前台/后台、把三态拼成模型看得懂的文本。
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import { Intent, jobSnapshot } from '@onething/core/toolkit'
import type { PlanContext, Result, RunContext, ToolSpec } from '@onething/core/toolkit'
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_MAX_LINES,
} from '../../tools/output-accumulator.js'
import { readBackgroundJobOutput } from '../../tools/background-jobs.js'
import { defineInput, listZodIssues } from '../contract.js'
import {
  formatProcessOutput,
  ProcessTool,
  type CommandClassification,
  type CommandScope,
  type ProcessToolAdapters,
} from '../families/process.js'

const MAX_OUTPUT_LENGTH = DEFAULT_OUTPUT_MAX_BYTES
const MAX_OUTPUT_DISPLAY = `${Math.round(DEFAULT_OUTPUT_MAX_BYTES / 1000)}KB`
const DEFAULT_TIMEOUT = 2 * 60 * 1000
/** 后台启动后等一下,好让进程吐出启动输出或快速失败。 */
const BACKGROUND_STARTUP_GRACE_MS = 1500

export const BashInputSchema = z.object({
  command: z.string().min(1)
    .describe('The bash command to execute. It runs in the session work directory.'),
  timeout: z.number().optional()
    .describe('Command timeout in milliseconds (default: 120000)'),
  run_in_background: z.boolean().optional()
    .describe('Run as a managed background job and return immediately (for dev servers, watchers — never for commands that finish on their own). The result carries the log file path and pid: read the log with read / `tail`, stop the job with `kill -- -<pid>`.'),
})

export const BASH_DESCRIPTION = `Execute a bash command in the session work directory; returns stdout+stderr, truncated to the last ${DEFAULT_OUTPUT_MAX_LINES} lines / ${MAX_OUTPUT_DISPLAY} (full output is saved to a temp file when truncated). Also the way to find files and search contents (rg / fd / find / grep).

Long-running services: set run_in_background: true — the call returns at once with a job id, initial output, the log file path and pid. Read the log later with read or \`tail\`; stop it with \`kill -- -<pid>\`.

To change the work directory for bash and file tools, use variable { action: "set", name: "workdir", value: <directory> } first.`

const BashContract = defineInput(BashInputSchema, {
  formatError: error => `Invalid bash parameters:\n${listZodIssues(error)}`,
})

export type BashInput = z.infer<typeof BashInputSchema>
export type BashToolAdapters = ProcessToolAdapters

interface BashPayload {
  readonly input: BashInput
  readonly scope: CommandScope
  readonly classification: CommandClassification
}

export class BashTool extends ProcessTool<BashInput, BashPayload> {
  readonly spec: ToolSpec = {
    id: 'bash',
    title: 'Bash',
    description: BASH_DESCRIPTION,
    input: BashContract.schema,
    effects: ['bash', 'external_directory'],
    presentation: { kind: 'bash', shell: 'default' },
    concurrency: 'sequential',
    // 输出已经被 OutputAccumulator 截到 2000 行 / 30KB 并附了 `<bash_metadata>`;
    // 内核预算只当兜底,留出说明块的余量。
    budget: { maxLines: DEFAULT_OUTPUT_MAX_LINES + 48, maxBytes: 128 * 1024 },
  }

  async plan(input: BashInput, ctx: PlanContext): Promise<Intent<BashPayload>> {
    const scope = this.commandScope(input.command, ctx)
    const classification = this.classify(scope)
    return Intent.of({
      effects: classification.effects,
      preview: classification.preview,
      payload: { input, scope, classification },
    })
  }

  async apply(intent: Intent<BashPayload>, ctx: RunContext): Promise<Result> {
    const { input, scope, classification } = intent.payload
    const command = input.command
    const workingDir = scope.workingDirectory

    ctx.emit({
      type: 'annotate',
      title: command,
      details: { command, workingDirectory: workingDir, exitCode: -1, output: '' },
    })

    // 硬禁命令。这不是"没批准",是"永远不批准" —— 走失败路径,与旧口径一致。
    if (classification.decision === 'deny') {
      throw new Error(classification.reason || `Command "${classification.deniedHead}" is forbidden for security reasons`)
    }
    ctx.abort.throwIfAborted()

    ctx.emit({ type: 'partial', result: { content: [] } })
    await this.prepareHost(command)

    return input.run_in_background
      ? await this.applyBackground(ctx, command, workingDir)
      : await this.applyForeground(ctx, input, command, workingDir)
  }

  private async applyBackground(ctx: RunContext, command: string, workingDir: string): Promise<Result> {
    // R2a 决定 B5:后台执行体由 `JobRegistry` 端口生出来(归属由系统填),不再
    // 由工具直接调执行器。返回文本与旧 bash 逐字相同 —— pid 走 `job.metadata`。
    const job = await this.runBackground(ctx, { command, cwd: workingDir })
    const jobId = job.id
    const pid = Number(job.metadata?.pid ?? 0)
    const logPath = job.log ?? ''

    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, BACKGROUND_STARTUP_GRACE_MS)
      ctx.abort.onAbort(() => {
        clearTimeout(timer)
        resolve()
      })
    })

    const read = readBackgroundJobOutput(jobId, { fromStart: true })
    const registered = read?.job
    const ports = registered?.ports?.length ? ` Listening on port(s): ${registered.ports.join(', ')}.` : ''
    const startupOutput = read?.output.trim()

    let output = `Started background job ${jobId} (${registered?.status ?? 'unknown'}).${ports}`
    if (startupOutput) output += `\n\n${startupOutput}`
    output += `\n\n<bash_metadata>\nBackground job: ${jobId} (pid ${pid}). Read new output: tail the log file; stop: kill -- -${pid}\nLog file: ${logPath}\n</bash_metadata>`

    ctx.emit({ type: 'spawned', job: jobSnapshot(job) })

    const metadata = toJsonObject({
      command, workingDirectory: workingDir, exitCode: 0, output,
      backgroundJobIds: [jobId],
    })
    ctx.emit({ type: 'annotate', title: `${command} (background ${jobId})`, details: metadata })
    return { content: [{ type: 'text', text: output }], details: metadata }
  }

  private async applyForeground(
    ctx: RunContext,
    input: BashInput,
    command: string,
    workingDir: string,
  ): Promise<Result> {
    const timeoutMs = input.timeout || DEFAULT_TIMEOUT
    const run = await this.runForeground(ctx, {
      command,
      cwd: workingDir,
      timeoutMs,
      maxBytes: MAX_OUTPUT_LENGTH,
      tempFilePrefix: 'bash',
      onSnapshot: snapshot => ctx.emit({
        type: 'partial',
        result: {
          content: [{ type: 'text', text: formatProcessOutput(snapshot, '') }],
          details: this.snapshotDetails(snapshot),
        },
      }),
    })

    let output = formatProcessOutput(run.snapshot)
    if (run.timedOut) output += `\n\n<bash_metadata>\nCommand timed out after ${timeoutMs} ms\n</bash_metadata>`
    if (run.exitCode !== null && run.exitCode !== 0) {
      output += `\n\n<bash_metadata>\nExit code: ${run.exitCode}\n</bash_metadata>`
    }
    if (run.backgroundJobIds?.length) {
      output += `\n\n<bash_metadata>\nBackground job(s): ${run.backgroundJobIds.join(', ')}\n</bash_metadata>`
    }

    const exitCode = run.exitCode ?? (run.timedOut ? -1 : 0)
    const metadata = toJsonObject({
      command,
      workingDirectory: workingDir,
      exitCode,
      output,
      ...(run.snapshot.fullOutputPath && { outputFilePath: run.snapshot.fullOutputPath }),
      ...(run.backgroundJobIds?.length && { backgroundJobIds: run.backgroundJobIds }),
    })
    ctx.emit({
      type: 'annotate',
      title: exitCode === 0 ? command : `Failed (exit ${exitCode}): ${command}`,
      details: metadata,
    })
    return { content: [{ type: 'text', text: output }], details: metadata }
  }
}

export function createBashTool(adapters: BashToolAdapters): BashTool {
  return new BashTool(adapters)
}
