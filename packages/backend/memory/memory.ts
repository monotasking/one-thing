/**
 * 内存管理的装配:创建登记表,注册本进程探针,按预算启动调度器。
 *
 * 预算取自环境变量 `ONETHING_MEMORY_SOFT_MB` / `ONETHING_MEMORY_HARD_MB`,
 * 默认 1024 / 1536 MB。Electron 宿主会另外注册一个探针,报告其他 Chromium 进程。
 * 各缓存模块通过 `backend.memory.registry.registerHolder(...)` 注册自己。
 *
 * 对外交出两类东西:装配用的子系统(`createMemorySubsystem` 与预算、本进程探针),以及
 * 缓存模块与宿主探针要实现的两个形状(`MemoryHolder` / `MemoryProcessProbe`)。依赖 logging。
 */
import {
  MemoryGovernor,
  MemoryRegistry,
  type MemoryBudget,
  type MemoryProcessProbe,
} from '@onething/backend/memory/memory-registry'
import { getLogger } from '@onething/backend/logging'
import { DEFAULT_MEMORY_BUDGET, resolveMemoryBudgetFrom } from '@shared/memory/budget'

export type { MemoryHolder, MemoryProcessProbe } from './memory-registry.js'

const log = getLogger('app.memory')

const MB = 1024 * 1024

export { DEFAULT_MEMORY_BUDGET }

/** 读取预算:优先环境变量,否则用默认值(判据在 `@shared/memory/budget`,这里只补「缺省读本进程的环境」)。 */
export function resolveMemoryBudget(env: NodeJS.ProcessEnv = process.env): MemoryBudget {
  return resolveMemoryBudgetFrom(env)
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
