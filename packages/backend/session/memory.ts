/**
 * 会话层在内存预算表上的两行(2026-09-25):活投影缓存与会话 LRU。
 *
 * 两者**要一起松**才真的省下内存:LRU 里那份会话对象的 `messages` 是从活投影
 * 物化出来的,只丢投影、LRU 还握着物化结果,那一份照样在堆上。
 *
 * 保护判据只有一个来源 —— 活投影自己的 `protectionOf`(在跑的 run、领先的 delta):
 * LRU 那一行问的也是它,不另抄一份「谁在跑」。
 */
import type { MemoryHolder } from '@onething/core/memory'
import { getSessionCacheStats, releaseIdleCachedSessions } from '../stores/sessions.js'
import type { SessionProjectionCache } from './projection-cache.js'

const LRU_IDLE_MS = { soft: 10 * 60_000, hard: 0 } as const

export function createSessionMemoryHolders(projections: SessionProjectionCache): MemoryHolder[] {
  const projectionHolder: MemoryHolder = {
    id: 'sessions.projections',
    label: '会话活投影(消息折叠状态)',
    usage() {
      const stats = projections.getMemoryStats()
      return {
        entries: stats.size,
        unit: 'sessions',
        bytes: stats.estimatedBytes,
        // 上限只管**空闲**那几条;在跑的 run 受保护,不算进上限。
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
    label: '会话对象 LRU(含物化出来的消息)',
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
