/**
 * 内存预算(一处产地):环境变量 `ONETHING_MEMORY_SOFT_MB` / `ONETHING_MEMORY_HARD_MB`,缺省 1024 / 1536 MB。
 *
 * 后端的内存治理(`packages/backend/memory/`)按它判自己进程超没超;第④步批 2b 起 Electron 主进程也有一份
 * 自己的采样(内置浏览器的标签页住在 Electron 那几个进程里,后端的 RSS 量不到它们),两边要读同一把尺子,
 * 所以判据搬到 `@shared`:纯函数,环境变量由调用方递进来,这里不碰 `process`。
 */

export interface MemoryBudget {
  /** 超过此值按 `soft` 力度释放。 */
  softBytes: number
  /** 超过此值按 `hard` 力度释放。 */
  hardBytes: number
}

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
export function resolveMemoryBudgetFrom(env: Readonly<Record<string, string | undefined>>): MemoryBudget {
  const softBytes = readMb(env.ONETHING_MEMORY_SOFT_MB) ?? DEFAULT_MEMORY_BUDGET.softBytes
  const hardBytes = readMb(env.ONETHING_MEMORY_HARD_MB) ?? Math.max(DEFAULT_MEMORY_BUDGET.hardBytes, softBytes)
  return { softBytes, hardBytes: Math.max(hardBytes, softBytes) }
}
