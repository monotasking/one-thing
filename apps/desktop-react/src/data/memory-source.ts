import { memoryRouter, type MemoryPressure, type MemoryReportResponse, type MemoryTrimReport } from '@shared/ipc/memory'
import { createMutation, createQuery } from './kernel'

/**
 * 内存面板的数据源,调用 `memory` RPC 域。轮询由面板根据自身是否可见控制。
 */
export interface MemoryPort {
  report(): Promise<MemoryReportResponse>
  trim(pressure: MemoryPressure): Promise<MemoryTrimReport>
}

let override: MemoryPort | undefined
/** 测试用:替换为假的端口实现。 */
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

/** 手动释放缓存。成功后在后台刷新报表。 */
export const memoryTrimMutation = createMutation<MemoryPressure, MemoryTrimReport>('memory.trim', {
  run: async pressure => (await memoryPort()).trim(pressure),
  settle: () => { void memoryReportQuery.refetch() },
})
