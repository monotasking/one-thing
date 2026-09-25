/**
 * `memory` 域 —— 内存预算表的读面与手动松手(2026-09-25)。
 *
 * `report` 只交计数与字节,不交会话 id、不交进程命令行,所以谁都能读。
 * `trim` 会让缓存重建(下一次读变慢),是一次有副作用的动作:只给本机可信的调用方
 * (`isHostLocallyTrusted()`,与 `rpc/sandbox.ts` 同一个谓词)。
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
