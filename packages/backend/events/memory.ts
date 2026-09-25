/**
 * 事件总线重放缓冲在内存预算表上的那一行(2026-09-25)。
 *
 * 每条碰过的会话一只环形缓冲(每只最多 `bufferCapacity` 条信封),从前只有删会话才
 * 释放。松手的判据写在 `EventBus.releaseIdleBuffers` 上:没人订阅 + 好一阵没动。
 */
import type { MemoryHolder } from '@onething/core/memory'
import type { EventBus } from './index.js'

/** soft 档:十分钟没动、没人订阅的丢掉。hard 档:一分钟。 */
const IDLE_MS = { soft: 10 * 60_000, hard: 60_000 } as const

export function createReplayBufferMemoryHolder(bus: EventBus): MemoryHolder {
  return {
    id: 'events.replay-buffers',
    label: '会话事件缓冲',
    usage() {
      const usage = bus.bufferUsage()
      return {
        entries: usage.entries,
        unit: 'events',
        // 没有总上限 —— 只有每会话一只的容量,会话数不设顶。这正是它要进表的理由。
        detail: { sessions: usage.sessions, subscribed: usage.subscribed, capacityPerSession: usage.capacityPerSession },
      }
    },
    trim(pressure) {
      const released = bus.releaseIdleBuffers(IDLE_MS[pressure])
      return { releasedEntries: released.releasedEntries }
    },
  }
}
