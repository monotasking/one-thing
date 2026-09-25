/**
 * 事件总线重放缓冲的内存登记。
 *
 * 每个会话有一个环形缓冲,用于客户端断线重连后补发事件。缓冲数量随访问过的会话增长,
 * 此前只在删除会话时释放。释放条件见 `EventBus.releaseIdleBuffers`:没有订阅者且
 * 一段时间内没有新事件。
 */
import type { MemoryHolder } from '@onething/core/memory'
import type { EventBus } from './index.js'

/** 缓冲闲置多久后可以释放:soft 10 分钟,hard 1 分钟。 */
const IDLE_MS = { soft: 10 * 60_000, hard: 60_000 } as const

export function createReplayBufferMemoryHolder(bus: EventBus): MemoryHolder {
  return {
    id: 'events.replay-buffers',
    label: '会话更新缓冲',
    usage() {
      const usage = bus.bufferUsage()
      return {
        entries: usage.entries,
        unit: 'events',
        // 只有每个会话的容量上限,没有总上限。
        detail: { sessions: usage.sessions, capacityPerSession: usage.capacityPerSession },
      }
    },
    trim(pressure) {
      const released = bus.releaseIdleBuffers(IDLE_MS[pressure])
      return { releasedEntries: released.releasedEntries }
    },
  }
}
