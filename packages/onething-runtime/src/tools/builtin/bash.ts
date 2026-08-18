/**
 * Built-in Tool: Bash
 *
 * Execute bash commands with:
 * - Lightweight command parsing for permission checks
 * - Central PermissionPolicy integration via analyze()
 * - Command classification (read-only, dangerous, forbidden)
 * - Directory sandbox restrictions
 */

import { z } from 'zod'
import { toJsonObject } from '@onething/core'
import { createToolAbortError } from '@onething/core/tools'
import { Tool } from '../tool.js'
import type { BashOperations } from '../bash-executor.js'
import {
  getCoreSandboxBoundary,
  getCoreSandboxRoots,
} from '../sandbox.js'
import { analyzeBashPermission } from '../permission-effects.js'
import {
  classifyBashCommand,
  classifyCommand,
  parseCommand,
} from '../bash-classifier.js'
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_MAX_LINES,
  OutputAccumulator,
} from '../output-accumulator.js'
import { readBackgroundJobOutput } from '../background-jobs.js'

const MAX_OUTPUT_LENGTH = DEFAULT_OUTPUT_MAX_BYTES
const MAX_OUTPUT_DISPLAY = `${Math.round(DEFAULT_OUTPUT_MAX_BYTES / 1000)}KB`
const DEFAULT_TIMEOUT = 2 * 60 * 1000
const BASH_UPDATE_THROTTLE_MS = 100

export interface BashOperationsOptions {
  shellPath?: string
  /** Owning session for background jobs registered by this call. */
  sessionId?: string
}

export interface BashToolAdapters {
  getDefaultWorkingDirectory?(): string | undefined
  getToolOutputsDir(): string
  /** 用户配置的「接入目录」= 额外的可写沙箱根;缺席 = 现状不变。 */
  /** 见 WriteToolAdapters:per-space,按**会话归属**取(批 B2)。 */
  getConnectedDirectories?(sessionId?: string): string[]
  getShellPath?(): string | undefined
  createOperations(options: BashOperationsOptions): BashOperations
  /**
   * Lets the host make a command workable before it runs — e.g. music: mpv
   * only plays while a resident client holds ncm-cli's player daemon open, and
   * bash is the only place that sees a play coming, because the model drives
   * ncm-cli itself. Failures are logged and ignored: a host that cannot prepare
   * must not stop the command from running and reporting its own error.
   */
  prepareForCommand?(command: string): Promise<void>
}

export interface BashMetadata {
  command: string
  workingDirectory: string
  exitCode: number
  output: string
  outputFilePath?: string
  description?: string
  backgroundJobIds?: string[]
}

export const BashParameters = z.object({
  command: z
    .string()
    .min(1)
    .describe('The bash command to execute. It runs in the session work directory.'),
  timeout: z
    .number()
    .optional()
    .describe('Command timeout in milliseconds (default: 120000)'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Run as a managed background job and return immediately (for dev servers, watchers — never for commands that finish on their own). The result carries the log file path and pid: read the log with read / `tail`, stop the job with `kill -- -<pid>`.'),
})

function formatTruncatedOutput(
  snapshot: ReturnType<OutputAccumulator['snapshot']>,
  emptyText = '(no output)',
): string {
  let text = snapshot.content || emptyText
  const truncation = snapshot.truncation
  if (truncation.truncated) {
    const by = truncation.truncatedBy === 'lines'
      ? `showing last ${truncation.outputLines} of ${truncation.totalLines} lines`
      : `showing last ${truncation.outputBytes} of ${truncation.totalBytes} bytes`
    text += `\n\n<bash_metadata>\nOutput truncated (${by}).\n${snapshot.fullOutputPath ? `Full output saved to: ${snapshot.fullOutputPath}\n` : ''}</bash_metadata>`
  }
  return text
}

export function createBashTool(adapters: BashToolAdapters): Tool.Info<typeof BashParameters, BashMetadata> {
  return Tool.define<typeof BashParameters, BashMetadata>('bash', {
    name: 'Bash',
    description: `Execute a bash command in the session work directory; returns stdout+stderr, truncated to the last ${DEFAULT_OUTPUT_MAX_LINES} lines / ${MAX_OUTPUT_DISPLAY} (full output is saved to a temp file when truncated). Also the way to find files and search contents (rg / fd / find / grep).

Long-running services: set run_in_background: true — the call returns at once with a job id, initial output, the log file path and pid. Read the log later with read or \`tail\`; stop it with \`kill -- -<pid>\`.

To change the work directory for bash and file tools, use variable { action: "set", name: "workdir", value: <directory> } first.`,
    category: 'builtin',
    enabled: true,
    autoExecute: false,
    permissionGuard: 'internal-check',
    executionMode: 'sequential',
    renderKind: 'bash',

    parameters: BashParameters,

    /**
     * 副作用面在 `../permission-effects.js` —— 外部 agent 的审批桥调的是**同一个
     * 函数**(`docs/audit/claude-code-sdk-audit-2026-08-11.md` P0-4)。两侧各写一份
     * 命令分析就是两套判据,同一条 `rm -rf ./dist` 迟早在两种会话里长成两张不同
     * 的卡。
     */
    async analyze(args, ctx) {
      const defaultWorkingDirectory = adapters.getDefaultWorkingDirectory?.()
      return analyzeBashPermission({
        command: args.command,
        workingDirectory: getCoreSandboxBoundary({
          workingDirectory: ctx.workingDirectory,
          defaultWorkingDirectory,
        }),
        sandboxRoots: getCoreSandboxRoots({
          workingDirectory: ctx.workingDirectory,
          workingDirectoryRoots: ctx.workingDirectoryRoots,
          connectedDirectories: adapters.getConnectedDirectories?.(ctx.sessionId),
          defaultWorkingDirectory,
        }),
      })
    },

    async execute(args, ctx) {
      const { command, timeout } = args
      const sandboxBoundary = getCoreSandboxBoundary({
        workingDirectory: ctx.workingDirectory,
        defaultWorkingDirectory: adapters.getDefaultWorkingDirectory?.(),
      })
      const workingDir = sandboxBoundary
      const commandClassification = classifyBashCommand(command)
      const commandAction = commandClassification.decision

      ctx.metadata({
        title: command,
        metadata: {
          command,
          workingDirectory: workingDir,
          exitCode: -1,
          output: '',
        },
      })

      if (commandAction === 'deny') {
        const deniedCommand = commandClassification.commands.find(item => item.decision === 'deny')
        const head = deniedCommand?.head || parseCommand(command).head
        throw new Error(commandClassification.reason || `Command "${head}" is forbidden for security reasons`)
      }

      if (ctx.abortSignal?.aborted) {
        throw createToolAbortError('Command execution aborted')
      }

      await ctx.beforeSideEffect?.()

      const output = new OutputAccumulator({
        maxBytes: MAX_OUTPUT_LENGTH,
        tempDir: adapters.getToolOutputsDir(),
        tempFilePrefix: 'bash',
      })

      let updateTimer: NodeJS.Timeout | undefined
      let updateDirty = false
      let lastUpdateAt = 0

      const emitOutputUpdate = () => {
        if (!updateDirty) return
        updateDirty = false
        lastUpdateAt = Date.now()
        const snapshot = output.snapshot({ persistIfTruncated: true })
        ctx.updateResult?.({
          content: [{ type: 'text', text: formatTruncatedOutput(snapshot, '') }],
          details: toJsonObject({
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            ...(snapshot.fullOutputPath && {
              fullOutputPath: snapshot.fullOutputPath,
              outputFilePath: snapshot.fullOutputPath,
            }),
          }),
        })
      }

      const clearUpdateTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer)
          updateTimer = undefined
        }
      }

      const scheduleOutputUpdate = () => {
        updateDirty = true
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)
        if (delay <= 0) {
          clearUpdateTimer()
          emitOutputUpdate()
          return
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined
          emitOutputUpdate()
        }, delay)
      }

      const append = (data: Buffer) => {
        output.append(data)
        scheduleOutputUpdate()
      }

      ctx.updateResult?.({ content: [], details: undefined })

      if (adapters.prepareForCommand) {
        try {
          await adapters.prepareForCommand(command)
        } catch (error) {
          console.warn('[bash] host could not prepare for the command', error)
        }
      }

      const ops = adapters.createOperations({
        shellPath: adapters.getShellPath?.(),
        sessionId: ctx.sessionId,
      })

      if (args.run_in_background) {
        if (!ops.execBackground) {
          throw new Error('Background execution is not supported in this environment')
        }
        const launch = await ops.execBackground(command, workingDir)

        // Give the process a moment to produce startup output or fail fast.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500)
          ctx.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })

        const read = readBackgroundJobOutput(launch.jobId, { fromStart: true })
        const job = read?.job
        const ports = job?.ports?.length ? ` Listening on port(s): ${job.ports.join(', ')}.` : ''
        const startupOutput = read?.output.trim()

        let backgroundOutput = `Started background job ${launch.jobId} (${job?.status ?? 'unknown'}).${ports}`
        if (startupOutput) {
          backgroundOutput += `\n\n${startupOutput}`
        }
        backgroundOutput += `\n\n<bash_metadata>\nBackground job: ${launch.jobId} (pid ${launch.pid}). Read new output: tail the log file; stop: kill -- -${launch.pid}\nLog file: ${launch.logPath}\n</bash_metadata>`

        return {
          title: `${command} (background ${launch.jobId})`,
          output: backgroundOutput,
          metadata: {
            command,
            workingDirectory: workingDir,
            exitCode: 0,
            output: backgroundOutput,
            backgroundJobIds: [launch.jobId],
          },
        }
      }

      let aborted = false
      let timedOut = false
      let result: { exitCode: number | null; backgroundJobIds?: string[] }
      try {
        result = await ops.exec(command, workingDir, {
          onData: append,
          signal: ctx.abortSignal,
          timeout: timeout || DEFAULT_TIMEOUT,
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'aborted') {
          aborted = true
          result = { exitCode: null }
        } else if (error instanceof Error && error.message.startsWith('timeout:')) {
          timedOut = true
          result = { exitCode: null }
        } else {
          throw error
        }
      } finally {
        clearUpdateTimer()
        emitOutputUpdate()
      }

      output.finish()
      const finalSnapshot = output.snapshot({ persistIfTruncated: true })
      await output.closeTempFile()

      let finalOutput = formatTruncatedOutput(finalSnapshot)
      const outputFilePath = finalSnapshot.fullOutputPath

      if (timedOut) {
        finalOutput += `\n\n<bash_metadata>\nCommand timed out after ${timeout || DEFAULT_TIMEOUT} ms\n</bash_metadata>`
      }

      if (aborted) {
        throw createToolAbortError(`${finalOutput}\n\nCommand execution was cancelled by user`)
      }

      if (result.exitCode !== null && result.exitCode !== 0) {
        finalOutput += `\n\n<bash_metadata>\nExit code: ${result.exitCode}\n</bash_metadata>`
      }

      const exitCode = result.exitCode ?? (timedOut || aborted ? -1 : 0)
      const metadata: BashMetadata = {
        command,
        workingDirectory: workingDir,
        exitCode,
        output: finalOutput,
        ...(outputFilePath && { outputFilePath }),
        ...(result.backgroundJobIds?.length && { backgroundJobIds: result.backgroundJobIds }),
      }

      if (result.backgroundJobIds?.length) {
        finalOutput += `\n\n<bash_metadata>\nBackground job(s): ${result.backgroundJobIds.join(', ')}\n</bash_metadata>`
        metadata.output = finalOutput
      }

      return {
        title: exitCode === 0
          ? command
          : `Failed (exit ${exitCode}): ${command}`,
        output: finalOutput,
        metadata,
      }
    },

    formatValidationError(error) {
      const issues = error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
      return `Invalid bash parameters:\n${issues.join('\n')}`
    },
  })
}

export { classifyCommand, parseCommand }
