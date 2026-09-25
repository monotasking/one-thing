import { memoryRouter, type MemoryPressure, type MemoryReportResponse, type MemoryTrimReport } from '@shared/ipc/memory'
import { createMutation, createQuery } from './kernel'

/**
 * 内存监视器的数据面(2026-09-25)。读的是 core 的 `memory` RPC 域 —— 与
 * `bun run memory:report` 同一只接口,所以面板上的数与终端里的数是同一份。
 *
 * 轮询**不在这里**:要不要问、多久问一次是「面板此刻看不看得见」的事,归面板。
 */
export interface MemoryPort {
  report(): Promise<MemoryReportResponse>
  trim(pressure: MemoryPressure): Promise<MemoryTrimReport>
}

let override: MemoryPort | undefined
/** 测试缝:换一只假的端口。 */
export function configureMemoryPort(port?: MemoryPort): void { override = port }

async function memoryPort(): Promise<MemoryPort> {
  if (override) return override
  const { onethingClient } = await import('../platform/connection')
  const api = (await onethingClient()).api(memoryRouter)
  return {
    report: () => api.report({}),
    trim: pressure => api.trim({ pressure }),
  }
}

export const memoryReportQuery = createQuery<MemoryReportResponse>(
  'memory.report',
  async () => (await memoryPort()).report(),
)

/** 手动释放一次。成功后后台补拉报表(不清屏)。 */
export const memoryTrimMutation = createMutation<MemoryPressure, MemoryTrimReport>('memory.trim', {
  run: async pressure => (await memoryPort()).trim(pressure),
  settle: () => { void memoryReportQuery.refetch() },
})
