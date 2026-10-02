/**
 * 内存报告与释放结果的形状。
 *
 * 它们是 `memory` RPC 域(`@shared/ipc/memory.ts`)的载荷;登记表、调度器以及
 * 「持有者 / 进程探针」这两个端口是后端的机制,留在 `packages/backend/runtime/memory/memory-registry.ts`,
 * 那边从这里取这些形状。
 */

/** 释放力度。`soft`:只释放长时间未使用的内容;`hard`:释放所有可以重建的内容。 */
export type MemoryPressure = 'soft' | 'hard'

export interface MemoryHolderUsage {
  /** 当前条目数,单位见 `unit`。 */
  entries: number
  /** 条目单位,如 `'sessions'` / `'events'` / `'views'`。 */
  unit: string
  /** 估算字节数。无法估算时不填,避免显示为 0。 */
  bytes?: number
  /** 上限;没有上限时不填。 */
  limit?: { entries?: number; bytes?: number }
  /** 其他明细计数,只放标量。 */
  detail?: Record<string, number | string | boolean>
}

export interface MemoryTrimResult {
  releasedEntries: number
  releasedBytes?: number
}

export type MemoryProcessKind = 'main' | 'renderer' | 'browser' | 'gpu' | 'utility' | 'worker' | 'other'

export interface MemoryProcessSample {
  pid: number
  kind: MemoryProcessKind
  /** 进程名或页面标题。不包含命令行参数,以免泄露凭证。 */
  name: string
  /** 字节数;无法测量时为 `null`。 */
  bytes: number | null
}

export interface MemoryHolderReport extends MemoryHolderUsage {
  id: string
  label: string
  trimmable: boolean
  /** `usage()` 抛出的错误信息;单个持有者出错不影响其他行。 */
  error?: string
}

export interface MemoryReport {
  capturedAt: number
  /** 所有进程的字节数之和;没有任何进程可测量时为 `null`。 */
  totalBytes: number | null
  /** 是否有进程无法测量;为 `true` 时 `totalBytes` 偏低。 */
  partial: boolean
  processes: MemoryProcessSample[]
  holders: MemoryHolderReport[]
}

export interface MemoryTrimReport {
  pressure: MemoryPressure
  releasedEntries: number
  releasedBytes: number
  holders: Array<{ id: string } & MemoryTrimResult & { error?: string }>
}
