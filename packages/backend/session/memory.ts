/**
 * 会话层的两个内存登记:会话投影缓存与会话对象 LRU。
 *
 * 两者需要一起释放:LRU 中的会话对象持有从投影生成的消息数组,只释放投影不会减少内存。
 * 是否可以释放统一由投影缓存的 `protectionOf` 判断(有正在运行的任务或未落盘的增量时不释放)。
 */
import type { MemoryHolder } from '@onething/core/memory'
import { getSessionCacheStats, releaseIdleCachedSessions } from '../stores/sessions.js'
import type { SessionProjectionCache } from './projection-cache.js'

const LRU_IDLE_MS = { soft: 10 * 60_000, hard: 0 } as const

export function createSessionMemoryHolders(projections: SessionProjectionCache): MemoryHolder[] {
  const projectionHolder: MemoryHolder = {
    id: 'sessions.projections',
    label: '会话内容缓存',
    usage() {
      const stats = projections.getMemoryStats()
      return {
        entries: stats.size,
        unit: 'sessions',
        bytes: stats.estimatedBytes,
        // 上限只约束空闲条目,正在使用的会话不计入。
        limit: { entries: stats.limits.maxIdleEntries, bytes: stats.limits.maxIdleBytes },
        detail: { idle: stats.idleCount, protected: stats.protectedCount },
      }
    },
    trim(pressure) {
      const released = projections.releaseIdle({ all: pressure === 'hard' })
      return { releasedEntries: released.releasedSessionIds.length, releasedBytes: released.releasedEstimatedBytes }
    },
  }
  const cacheHolder: MemoryHolder = {
    id: 'sessions.cache',
    label: '最近打开的会话',
    usage() {
      const stats = getSessionCacheStats()
      return { entries: stats.size, unit: 'sessions', limit: { entries: stats.maxSize } }
    },
    trim(pressure) {
      const released = releaseIdleCachedSessions({
        idleMs: LRU_IDLE_MS[pressure],
        isProtected: sessionId => projections.protectionOf(sessionId) !== undefined,
      })
      return { releasedEntries: released.length }
    },
  }
  return [projectionHolder, cacheHolder]
}
