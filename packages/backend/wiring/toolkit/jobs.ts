/**
 * R2a —— `BackgroundJobRegistry implements JobRegistry`(设计文档 §2 / §10.1)。
 *
 * 内核的 `JobRegistry` 是一个协议;这里把**已经存在**的那张真表包成它:
 * `tools/background-jobs.ts`(注册 / 刷新 / 增量读日志 / 停止 / 日志清扫)加上
 * `bash-executor.ts` 的 `execBackground`(spawn + 日志落盘 + 注册)。
 *
 * 为什么是"包"而不是"重写":那张表已经有三个消费者 —— IPC
 * (`tools:background-jobs:{list,stop}`)、变量板的 `background_jobs` provider、
 * 渲染器状态栏。再造一份内存表会造出一个和真表对不上的 job:模型拿到一个 id,
 * 用户在状态栏里看到的是另一批。
 *
 * ## 归属(owner)为什么要另存一份
 *
 * `BackgroundJob` 只有 `sessionId`,没有 `toolCallId` —— 它诞生时还没有"工具调用"
 * 这个概念。归属是内核 `Job` 协议的一部分(exit 时要把系统消息回投到正确的会话,
 * 而 `bindJobRegistry` 靠它挡住"别的调用生出来的 job"),所以这里维护一张
 * `jobId → owner` 的旁表。它随进程活,与那张真表同寿 —— 两者都不跨重启。
 */

import type { JsonObject } from '@onething/core'
import type { Job, JobEvent, JobOwner, JobRegistry, JobSpec, JobStatus } from '@onething/core/toolkit'
import {
  listBackgroundJobs,
  readBackgroundJobOutput,
  refreshBackgroundJob,
  stopBackgroundJob,
  type BackgroundJob,
} from '@onething/runtime/tools/background-jobs'
import type { BashOperations } from '@onething/runtime/tools/bash-executor'
import { createLocalBashOperations } from '@onething/runtime/tools/bash-executor'
import { getSettings } from '../../stores/settings.js'

/** 轮询间隔:`events()` 靠它把"日志长长了 / 进程没了"变成一条流。 */
const JOB_POLL_INTERVAL_MS = 500

export interface BackgroundJobRegistryOptions {
  /**
   * 怎么造一个执行器。默认是本机 shell;测试注入一个假的就能在不 spawn 的前提下
   * 验证注册表本身(与 bash 对拍用的是同一个假执行器)。
   */
  readonly createOperations?: (options: { shellPath?: string; sessionId?: string }) => BashOperations
  readonly getShellPath?: () => string | undefined
  readonly pollIntervalMs?: number
}

function statusOf(job: BackgroundJob | undefined): JobStatus {
  // `unknown`(刚起来、进程组还没扫到)对内核协议来说就是 running:它还没退出。
  if (!job) return 'running'
  return job.status === 'exited' || job.status === 'killed' ? job.status : 'running'
}

class BackgroundJobHandle implements Job {
  constructor(
    readonly id: string,
    readonly owner: JobOwner,
    readonly label: string | undefined,
    readonly log: string | undefined,
    readonly metadata: JsonObject | undefined,
    private readonly pollIntervalMs: number,
  ) {}

  get status(): JobStatus {
    return statusOf(refreshBackgroundJob(this.id))
  }

  /**
   * 增量读日志 + 状态轮询。`readBackgroundJobOutput` 自己维护读游标,所以连续调用
   * 只吐新内容 —— 这条流不会把同一段输出重放两遍。
   *
   * 端口没有区分 stdout / stderr:`execBackground` 把两条管子都 pipe 进同一个日志
   * 文件(那是它的落盘方式,不是这里的选择),所以这里如实报 `stdout`,不编一个
   * 分不出来的区分。
   */
  async *events(): AsyncIterable<JobEvent> {
    let knownPorts = ''
    for (;;) {
      const read = readBackgroundJobOutput(this.id)
      if (!read) return

      if (read.output) yield { type: 'output', stream: 'stdout', chunk: read.output }

      const ports = read.job.ports ?? []
      const signature = ports.join(',')
      if (signature !== knownPorts) {
        knownPorts = signature
        if (ports.length > 0) yield { type: 'ports', ports }
      }

      const status = statusOf(read.job)
      if (status !== 'running') {
        yield { type: 'exit', status, code: null }
        return
      }

      await new Promise<void>(resolve => {
        setTimeout(resolve, this.pollIntervalMs).unref?.()
      })
    }
  }

  async kill(): Promise<void> {
    stopBackgroundJob(this.id)
  }
}

export class BackgroundJobRegistry implements JobRegistry {
  private readonly options: BackgroundJobRegistryOptions
  private readonly owners = new Map<string, JobOwner>()
  private readonly handles = new Map<string, BackgroundJobHandle>()

  constructor(options: BackgroundJobRegistryOptions = {}) {
    this.options = options
  }

  async spawn(spec: JobSpec): Promise<Job> {
    const command = spec.command
    if (!command) throw new Error('A background job needs a command')
    const cwd = spec.cwd
    if (!cwd) throw new Error('A background job needs a working directory')

    const ops = this.operations(spec.owner.sessionId)
    if (!ops.execBackground) {
      throw new Error('Background execution is not supported in this environment')
    }

    const launch = await ops.execBackground(command, cwd)
    this.owners.set(launch.jobId, spec.owner)
    const handle = new BackgroundJobHandle(
      launch.jobId,
      spec.owner,
      spec.label ?? command,
      launch.logPath,
      { ...(spec.metadata ?? {}), pid: launch.pid, command, cwd },
      this.options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS,
    )
    this.handles.set(launch.jobId, handle)
    return handle
  }

  get(id: string): Job | undefined {
    const known = this.handles.get(id)
    if (known) return known
    // 进程里别处起的后台任务(旧 bash 路径、CLI)也在同一张真表里。它们没有
    // toolCallId —— 归属只答得出会话,如实填空串而不是编一个调用 id。
    const job = listBackgroundJobs({ includeInactive: true }).find(item => item.id === id)
    if (!job) return undefined
    return this.adopt(job)
  }

  list(owner?: Partial<JobOwner>): readonly Job[] {
    return listBackgroundJobs({ includeInactive: true })
      .filter(job => {
        const known = this.owners.get(job.id)
        const sessionId = known?.sessionId ?? job.sessionId
        if (owner?.sessionId && sessionId !== owner.sessionId) return false
        if (owner?.toolCallId && known?.toolCallId !== owner.toolCallId) return false
        return true
      })
      .map(job => this.handles.get(job.id) ?? this.adopt(job))
  }

  private adopt(job: BackgroundJob): BackgroundJobHandle {
    const owner = this.owners.get(job.id) ?? { sessionId: job.sessionId ?? '', toolCallId: '' }
    const handle = new BackgroundJobHandle(
      job.id,
      owner,
      job.command,
      job.logPath,
      { pid: job.pgid, command: job.command, cwd: job.cwd },
      this.options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS,
    )
    this.handles.set(job.id, handle)
    return handle
  }

  private operations(sessionId: string): BashOperations {
    if (this.options.createOperations) {
      return this.options.createOperations({ shellPath: this.options.getShellPath?.(), sessionId })
    }
    const bash = getSettings().tools?.bash
    const allowlist = Array.isArray(bash?.envAllowlist) ? bash.envAllowlist : null
    return createLocalBashOperations({
      shellPath: this.options.getShellPath?.() ?? configuredShellPath(),
      sessionId,
      envAllowlist: allowlist,
    })
  }
}

/** 与 `app/tools/builtin/bash.ts` 同一个读法:每次现取,用户改了设置立刻生效。 */
function configuredShellPath(): string | undefined {
  const bash = getSettings().tools?.bash
  return bash && 'shellPath' in bash && typeof bash.shellPath === 'string' ? bash.shellPath : undefined
}
