/**
 * 内存预算表的装配半边(2026-09-25)。机制在 `@onething/core/memory`,这里只做三件:
 *
 *  ① 造一张 `MemoryRegistry`,先登记「本进程」这一只探针(server / CLI 只有它;
 *     Electron 壳会再登记一只报渲染 / GPU / 内置浏览器那些进程);
 *  ② 按预算起一只 `MemoryGovernor` —— 预算读 `ONETHING_MEMORY_SOFT_MB` /
 *     `ONETHING_MEMORY_HARD_MB`,缺省 1024 / 1536;
 *  ③ 交回 `dispose`,装配层 `own()` 它。
 *
 * **这个文件不认识任何一只持有者。** 谁攒东西,谁在自己的模块里写一只
 * `MemoryHolder`,装配处一行 `backend.memory.registry.registerHolder(...)`。
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

/** 环境变量说了算,缺省走 `DEFAULT_MEMORY_BUDGET`;hard 低于 soft 时抬到 soft。 */
export function resolveMemoryBudget(env: NodeJS.ProcessEnv = process.env): MemoryBudget {
  const softBytes = readMb(env.ONETHING_MEMORY_SOFT_MB) ?? DEFAULT_MEMORY_BUDGET.softBytes
  const hardBytes = readMb(env.ONETHING_MEMORY_HARD_MB) ?? Math.max(DEFAULT_MEMORY_BUDGET.hardBytes, softBytes)
  return { softBytes, hardBytes: Math.max(hardBytes, softBytes) }
}

/** 本进程这一只探针。RSS 含 Worker 线程(同一个进程),不含子进程。 */
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
