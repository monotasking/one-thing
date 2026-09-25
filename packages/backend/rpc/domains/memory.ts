/**
 * `memory` RPC 域:读取内存报告、手动释放缓存。
 *
 * `report` 只返回计数和字节数,不含会话 id 或进程命令行,所有调用方都可读取。
 * `trim` 会导致缓存重建,只允许本机可信的调用方使用(`isHostLocallyTrusted()`)。
 */
import type { MemoryRoutes } from '@shared/ipc/memory.js'
import { getCurrentBackendInstance, BackendNotAssembledError } from '../../current.js'
import { isHostLocallyTrusted } from '../../server/host-trust.js'
import type { RpcRouteHandlers } from '../registry.js'

function memory() {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new BackendNotAssembledError()
  return backend.memory
}

export const memoryRpcHandlers: RpcRouteHandlers<MemoryRoutes> = {
  async report() {
    const subsystem = memory()
    const report = await subsystem.registry.report()
    const usage = process.memoryUsage()
    return {
      ...report,
      budget: { ...subsystem.governor.budget },
      heap: {
        usedBytes: usage.heapUsed,
        totalBytes: usage.heapTotal,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
      },
    }
  },
  async trim(request) {
    if (!isHostLocallyTrusted()) throw new Error('memory.trim is only available to locally trusted callers')
    return memory().registry.trim(request?.pressure === 'soft' ? 'soft' : 'hard')
  },
}
