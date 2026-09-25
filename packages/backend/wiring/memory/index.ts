/**
 * 内存管理的装配:创建登记表,注册本进程探针,按预算启动调度器。
 *
 * 预算取自环境变量 `ONETHING_MEMORY_SOFT_MB` / `ONETHING_MEMORY_HARD_MB`,
 * 默认 1024 / 1536 MB。Electron 宿主会另外注册一个探针,报告其他 Chromium 进程。
 * 各缓存模块通过 `backend.memory.registry.registerHolder(...)` 注册自己。
 */
import {
  MemoryGovernor,
  MemoryRegistry,
  type MemoryBudget,
  type MemoryProcessProbe,
} from '@onething/core/memory'
import { getLogger } from '../logging/index.js'

const log = getLogger('app.memory')

const MB = 1024 * 1024

export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  softBytes: 1024 * MB,
  hardBytes: 1536 * MB,
}

function readMb(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value * MB) : undefined
}

/** 读取预算:优先环境变量,否则用默认值。硬上限低于软上限时取软上限。 */
export function resolveMemoryBudget(env: NodeJS.ProcessEnv = process.env): MemoryBudget {
  const softBytes = readMb(env.ONETHING_MEMORY_SOFT_MB) ?? DEFAULT_MEMORY_BUDGET.softBytes
  const hardBytes = readMb(env.ONETHING_MEMORY_HARD_MB) ?? Math.max(DEFAULT_MEMORY_BUDGET.hardBytes, softBytes)
  return { softBytes, hardBytes: Math.max(hardBytes, softBytes) }
}

/** 本进程探针。RSS 包含 Worker 线程,不包含子进程。 */
export const selfProcessProbe: MemoryProcessProbe = {
  id: 'process.self',
  sample: () => [{ pid: process.pid, kind: 'main', name: 'core', bytes: process.memoryUsage.rss() }],
}

export interface MemorySubsystem {
  readonly registry: MemoryRegistry
  readonly governor: MemoryGovernor
  dispose(): void
}

export function createMemorySubsystem(options: { budget?: MemoryBudget; intervalMs?: number } = {}): MemorySubsystem {
  const registry = new MemoryRegistry()
  const releaseSelfProbe = registry.registerProbe(selfProcessProbe)
  const governor = new MemoryGovernor({
    registry,
    budget: options.budget ?? resolveMemoryBudget(),
    fallbackBytes: () => process.memoryUsage.rss(),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    onTrim: ({ pressure, beforeBytes, trim }) => {
      log.warn('memory over budget; released idle caches', {
        pressure,
        beforeMb: Math.round(beforeBytes / MB),
        releasedEntries: trim.releasedEntries,
        releasedMb: Math.round(trim.releasedBytes / MB),
        holders: trim.holders.map(row => `${row.id}:${row.releasedEntries}${row.error ? '!' : ''}`).join(','),
      })
    },
    onError: error => log.error('memory governor tick failed', {}, error),
  })
  governor.start()
  return {
    registry,
    governor,
    dispose() {
      governor.stop()
      releaseSelfProbe()
    },
  }
}
