/**
 * §2/§3 内核 —— `Job` 与 `JobRegistry` 端口。
 *
 * Job 是一个**分离**的执行体:apply 把它生出来、拿到句柄就返回,执行体自己活下去。
 * 三种执行形态里的"后台分离"那一档全部落在这里,工具不再各自维护后台表。
 *
 * R0 只定义协议。真正的实现在 R2/R3 由 `app` 层把现有 `tools/background-jobs.ts`
 * (register / list / read / stop / 日志落盘 / IPC / 变量板)包成这个端口 —— 内核
 * 不碰进程、不碰 fs。
 */

import type { JsonObject } from '../json.js'

export type JobStatus = 'running' | 'exited' | 'killed'

/** 归属坐标。exit 时靠它把系统消息回投到正确的会话(与 task 工具同一条唤醒路)。 */
export interface JobOwner {
  readonly sessionId: string
  readonly toolCallId: string
}

export interface JobSpec {
  readonly owner: JobOwner
  /** 人类可读的标签,状态栏用。 */
  readonly label?: string
  readonly command?: string
  readonly cwd?: string
  readonly metadata?: JsonObject
}

export type JobEvent =
  | { type: 'output'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'ports'; ports: readonly number[] }
  | { type: 'exit'; status: 'exited' | 'killed'; code: number | null }

export interface Job {
  readonly id: string
  readonly owner: JobOwner
  readonly status: JobStatus
  readonly label?: string
  /** 日志落盘位置。模型拿到的句柄里就有它,后续 tail 靠它。 */
  readonly log?: string
  /**
   * 宿主注册表填的额外句柄信息(pid、pgid、端口…)。内核不解释它:进程号是
   * 「这台机器上的执行体」的属性,不是 Job 协议的一部分,但模型拿到的那句
   * `kill -- -<pid>` 又确实需要它 —— 于是它走这个不透明的口子,而不是让内核
   * 长出一个 `pid` 字段去认识 POSIX。
   */
  readonly metadata?: JsonObject
  events(): AsyncIterable<JobEvent>
  kill(): Promise<void>
}

/** 可放进 `ToolEvent.spawned` / Result.details 的只读快照(不含 events/kill)。 */
export interface JobSnapshot {
  readonly id: string
  readonly owner: JobOwner
  readonly status: JobStatus
  readonly label?: string
  readonly log?: string
  readonly metadata?: JsonObject
}

export function jobSnapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    owner: job.owner,
    status: job.status,
    label: job.label,
    log: job.log,
    metadata: job.metadata,
  }
}

export interface JobRegistry {
  spawn(spec: JobSpec): Job | Promise<Job>
  get(id: string): Job | undefined
  /** 不给 owner = 全量;给了 owner = 只看这一次调用/这个会话生出来的。 */
  list(owner?: Partial<JobOwner>): readonly Job[]
}

/**
 * 绑定到一次调用的视图。工具拿不到 `owner` 这个参数 —— 归属由系统填,不由工具
 * 声明,否则一个工具就能把自己的后台进程挂到别的会话名下。
 */
export interface BoundJobRegistry {
  spawn(spec: Omit<JobSpec, 'owner'>): Promise<Job>
  get(id: string): Job | undefined
  list(): readonly Job[]
}

export function bindJobRegistry(
  registry: JobRegistry | undefined,
  owner: JobOwner,
): BoundJobRegistry {
  return {
    async spawn(spec) {
      if (!registry) throw new Error('No JobRegistry port is bound to this RunContext')
      return await registry.spawn({ ...spec, owner })
    },
    get(id) {
      const job = registry?.get(id)
      // 别的调用生出来的 job 对这次调用不存在 —— 句柄不是能力凭证。
      return job && job.owner.sessionId === owner.sessionId ? job : undefined
    },
    list() {
      return registry?.list({ sessionId: owner.sessionId }) ?? []
    },
  }
}
