/**
 * R1 家族基类 —— `ProcessTool`(§4 的第四族)。
 *
 * 这一族每个成员都做的三件事:
 *
 *  1. **命令级分类**:`plan` 把一条命令交给分类器 → 一条 `bash` 效果(资源是命令
 *     模式 `rm *`,不是工具名)+ 越界的 `external_directory`。判据与外部 agent 的
 *     审批桥**共用同一个函数**(`tools/permission-effects.ts`)—— 两侧各写一份就是
 *     两套判据。
 *  2. **前台执行**:子进程输出流经 `emit(partial)`,尾部截断 + 溢出落盘,退出码 /
 *     超时 / 取消三态。
 *  3. **后台分离**:`ctx.jobs.spawn` 生出一个 job,立刻返回句柄(归属由系统填)。
 *
 * ## 取消与超时不再靠字符串
 *
 * 旧 bash 靠 `error.message === 'aborted'` 与 `error.message.startsWith('timeout:')`
 * 判定三态 —— 一条恰好含 "aborted" 字样的失败消息就能把工具的失败洗成用户的取消。
 * 这里两者都由作用域回答:超时是 `ctx.abort.child({ timeoutMs })`(它的 `timedOut`
 * 为真),取消是父作用域 `ctx.abort.aborted` 为真。执行体抛的是什么错不参与判定。
 */

import { Tool } from '@onething/core/toolkit'
import type { AbortView, Effect, Job, Preview, RunContext } from '@onething/core/toolkit'
import type { ToolEffect, ToolPreview } from '@onething/core/tools'
import { toJsonObject } from '@onething/core'
import type { BashOperations } from '../../tools/bash-executor.js'
import { analyzeBashPermission } from '../../tools/permission-effects.js'
import { classifyBashCommand, parseCommand } from '../../tools/bash-classifier.js'
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  OutputAccumulator,
  type OutputSnapshot,
} from '../../tools/output-accumulator.js'
import { getCoreSandboxBoundary, getCoreSandboxRoots } from '../../tools/sandbox.js'
import { fileScopeOf, type FileToolContextLike } from './file.js'

import { getLogger } from '../../logging/index.js'

const log = getLogger('toolkit.process')

/** 输出刷新的节流窗口。旧 bash 里的同一个常量。 */
const OUTPUT_UPDATE_THROTTLE_MS = 100

/**
 * 一次进程输出的**成文**形式:尾部裁剪的说明块 + 溢出文件位置。
 *
 * 它住在家族基类而不是 bash 里,是尺子① 的直接后果:累积器与阈值本来就归这一族
 * 管,那么"被裁掉了多少、剩下的在哪儿"这句话也该归它说。`<bash_metadata>` 的措辞
 * 逐字沿用旧 bash —— 模型认的是这个标签。
 */
export function formatProcessOutput(snapshot: OutputSnapshot, emptyText = '(no output)'): string {
  let text = snapshot.content || emptyText
  const cut = snapshot.truncation
  if (cut.truncated) {
    const by = cut.truncatedBy === 'lines'
      ? `showing last ${cut.outputLines} of ${cut.totalLines} lines`
      : `showing last ${cut.outputBytes} of ${cut.totalBytes} bytes`
    text += `\n\n<bash_metadata>\nOutput truncated (${by}).\n${snapshot.fullOutputPath ? `Full output saved to: ${snapshot.fullOutputPath}\n` : ''}</bash_metadata>`
  }
  return text
}

export interface ProcessOperationsOptions {
  shellPath?: string
  sessionId?: string
}

export interface ProcessToolAdapters {
  getDefaultWorkingDirectory?(): string | undefined
  getConnectedDirectories?(sessionId?: string): string[]
  getToolOutputsDir(): string
  getShellPath?(): string | undefined
  createOperations(options: ProcessOperationsOptions): BashOperations
  /** 宿主让命令变得可跑的机会(music 的常驻播放器…)。失败只记日志,不拦命令。 */
  prepareForCommand?(command: string): Promise<void>
}

export interface CommandScope {
  readonly command: string
  /** 命令实际跑在哪 —— 沙箱边界。 */
  readonly workingDirectory: string
  readonly sandboxRoots: string[]
}

export interface CommandClassification {
  readonly effects: Effect[]
  readonly preview: Preview
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly deniedHead?: string
}

export interface ForegroundRun {
  readonly snapshot: OutputSnapshot
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly backgroundJobIds?: string[]
}

export interface ForegroundRunInput {
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxBytes?: number
  readonly tempFilePrefix?: string
  /** 每次节流窗口到点时把当前快照投出去(渲染器的实时刷新)。 */
  readonly onSnapshot?: (snapshot: OutputSnapshot) => void
}

export abstract class ProcessTool<In, Payload> extends Tool<In, Payload> {
  protected readonly adapters: ProcessToolAdapters

  constructor(adapters: ProcessToolAdapters) {
    super()
    this.adapters = adapters
  }

  /** 命令跑在哪、允许的根有哪些。 */
  protected commandScope(command: string, ctx: FileToolContextLike): CommandScope {
    const scope = fileScopeOf(ctx)
    const defaultWorkingDirectory = this.adapters.getDefaultWorkingDirectory?.()
    return {
      command,
      workingDirectory: getCoreSandboxBoundary({
        workingDirectory: scope.workingDirectory,
        defaultWorkingDirectory,
      }),
      sandboxRoots: getCoreSandboxRoots({
        workingDirectory: scope.workingDirectory,
        workingDirectoryRoots: scope.workingDirectoryRoots,
        connectedDirectories: this.adapters.getConnectedDirectories?.(scope.sessionId),
        defaultWorkingDirectory,
      }),
    }
  }

  /**
   * 命令级效果面。`ToolEffect` 与内核 `Effect` 的字段逐字同形(内核那份就是照着它
   * 写的),所以这里是一次结构性的转手,不是翻译。
   */
  protected classify(scope: CommandScope): CommandClassification {
    const analysis: { effects: ToolEffect[]; preview: ToolPreview } = analyzeBashPermission({
      command: scope.command,
      workingDirectory: scope.workingDirectory,
      sandboxRoots: scope.sandboxRoots,
    })
    const classification = classifyBashCommand(scope.command)
    const denied = classification.commands.find(item => item.decision === 'deny')
    return {
      effects: analysis.effects as unknown as Effect[],
      preview: analysis.preview as unknown as Preview,
      decision: classification.decision,
      reason: classification.reason,
      deniedHead: denied?.head || parseCommand(scope.command).head,
    }
  }

  /**
   * 前台跑一条命令。
   *
   * 超时用**子作用域**而不是执行器自己的 timer:一个到点的子作用域抛的是
   * `ToolTimeoutError`,归因清清楚楚,而父作用域(用户按停止)照样级联下来。
   */
  protected async runForeground(ctx: RunContext, input: ForegroundRunInput): Promise<ForegroundRun> {
    const output = new OutputAccumulator({
      maxBytes: input.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      tempDir: this.adapters.getToolOutputsDir(),
      tempFilePrefix: input.tempFilePrefix ?? 'process',
    })

    let updateTimer: ReturnType<typeof setTimeout> | undefined
    let updateDirty = false
    let lastUpdateAt = 0

    const flush = () => {
      if (!updateDirty) return
      updateDirty = false
      lastUpdateAt = Date.now()
      input.onSnapshot?.(output.snapshot({ persistIfTruncated: true }))
    }
    const clearUpdateTimer = () => {
      if (updateTimer) {
        clearTimeout(updateTimer)
        updateTimer = undefined
      }
    }
    const schedule = () => {
      updateDirty = true
      const delay = OUTPUT_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)
      if (delay <= 0) {
        clearUpdateTimer()
        flush()
        return
      }
      updateTimer ??= setTimeout(() => {
        updateTimer = undefined
        flush()
      }, delay)
    }
    const append = (data: Buffer) => {
      output.append(data)
      schedule()
    }

    const ops = this.adapters.createOperations({
      shellPath: this.adapters.getShellPath?.(),
      sessionId: ctx.invocation.sessionId,
    })
    const deadline: AbortView = ctx.abort.child({
      timeoutMs: input.timeoutMs,
      reason: `Command timed out after ${input.timeoutMs} ms`,
    })

    let timedOut = false
    let result: { exitCode: number | null; backgroundJobIds?: string[] }
    try {
      result = await ops.exec(input.command, input.cwd, {
        onData: append,
        signal: deadline.signal,
      })
    } catch (error) {
      // 归因只看作用域:父信号响了 = 用户取消(往上抛,由 Runner 判 aborted);
      // 只有子作用域响了 = 这条命令超时(是一个正常的三态之一,不是失败)。
      if (ctx.abort.aborted) throw error
      if (deadline.timedOut) {
        timedOut = true
        result = { exitCode: null }
      } else {
        throw error
      }
    } finally {
      clearUpdateTimer()
      flush()
    }

    output.finish()
    const snapshot = output.snapshot({ persistIfTruncated: true })
    await output.closeTempFile()

    return { snapshot, exitCode: result.exitCode, timedOut, backgroundJobIds: result.backgroundJobIds }
  }

  /**
   * 后台分离 —— 走 `ctx.jobs.spawn`,不再自己调 `ops.execBackground`(R2a 决定 B5,
   * 设计文档 §11.5 偏差 6)。
   *
   * R1 直接调执行器,于是"这条命令生出来的东西"只活在 bash 的返回文本里:归属
   * (哪个会话、哪次调用)没人记,状态栏与变量板看到的是另一份账。`JobRegistry`
   * 端口就是那份账,归属由 `RunContext` 填 —— 工具连 owner 参数都拿不到,自然
   * 也就没法把自己的后台进程挂到别的会话名下。
   *
   * 返回的是内核的 `Job` 句柄。pid 这类"这台机器上的执行体"的属性走
   * `job.metadata`:内核不认识 POSIX,但模型拿到的 `kill -- -<pid>` 需要它。
   */
  protected async runBackground(
    ctx: RunContext,
    input: { command: string; cwd: string; label?: string },
  ): Promise<Job> {
    return await ctx.jobs.spawn({
      label: input.label ?? input.command,
      command: input.command,
      cwd: input.cwd,
    })
  }

  /** 宿主的准备钩子。失败被吞掉是**有意**的:准备不了不该拦住命令自己报错。 */
  protected async prepareHost(command: string): Promise<void> {
    if (!this.adapters.prepareForCommand) return
    try {
      await this.adapters.prepareForCommand(command)
    } catch (error) {
      log.warn('host could not prepare for the command', { command }, error)
    }
  }

  protected snapshotDetails(snapshot: OutputSnapshot): ReturnType<typeof toJsonObject> {
    return toJsonObject({
      truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
      ...(snapshot.fullOutputPath && {
        fullOutputPath: snapshot.fullOutputPath,
        outputFilePath: snapshot.fullOutputPath,
      }),
    })
  }
}
