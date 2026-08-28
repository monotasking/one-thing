/**
 * **账本 blob 的渲染侧缓存**(U2-a0,§17.8)。
 *
 * ## 它解决的是什么
 *
 * 账本里超 64KB 的正文(图片附件、大工具结果)只留 `BlobRef{hash,bytes,mime}`,
 * 真身在主进程的 `sessions/<id>/blobs/`。折叠器换回正文要的是一个**同步**解析器
 * (`ProjectionMaterializeOptions.resolveBlob`),而渲染层拿正文只能是**异步**的
 * (一次 RPC)。这两句话之间的落差就是这个文件:
 *
 *  - **同步问**:命中缓存就当场给,没有就返回 `undefined`——折叠器照实留引用
 *    (`onMissing:'keep'`),屏幕上那一格是占位,而占位正是此刻的事实;
 *  - **异步补**:同一次问触发一次拉取,拉回来写进缓存并通知订阅者,
 *    由订阅者决定要不要重物化(本批的订阅者是 ui-refold 的活折)。
 *
 * ## 边界
 *
 * - **绝不抛**:拉失败、没这段字节、id 不合法,一律"没有" —— 占位比崩溃好;
 * - **有上限**:`MAX_ENTRIES` 条 + `MAX_BYTES` 字节的双闸,超了按插入序淘汰
 *   (最老的先走)。一段 base64 图能有几百 KB,没有上限的 Map 就是一条内存泄漏;
 * - **同一个 hash 只拉一次**:`pending` 挡住并发重复拉(一次重物化会把同一格再问一遍)。
 */

import { sessionEventsApi } from '@/platform/session-events-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.session-blobs')

/** 缓存条数上限。 */
export const SESSION_BLOB_MAX_ENTRIES = 64
/** 缓存字节上限(base64 长度计)。 */
export const SESSION_BLOB_MAX_BYTES = 24_000_000

interface Entry {
  base64: string
  bytes: number
}

const cache = new Map<string, Entry>()
const pending = new Set<string>()
const missing = new Set<string>()
let totalBytes = 0
const listeners = new Set<(sessionId: string) => void>()

function keyOf(sessionId: string, hash: string): string {
  return `${sessionId}:${hash}`
}

/** 双闸淘汰:按插入序(Map 的迭代序)扔最老的,直到两条闸都满足。 */
function evictIfNeeded(): void {
  while (cache.size > SESSION_BLOB_MAX_ENTRIES || totalBytes > SESSION_BLOB_MAX_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    const entry = cache.get(oldest.value)
    cache.delete(oldest.value)
    totalBytes -= entry?.bytes ?? 0
  }
}

/**
 * **同步解析器** —— 直接喂给 `materializeChatMessages({ resolveBlob })`。
 *
 * 命中即返回;没命中就安排一次拉取并返回 `undefined`(这一次物化留占位,拉回来
 * 之后订阅者重物化一次就补上了)。
 */
export function createSessionBlobResolver(
  sessionId: string,
): (ref: { hash: string; bytes: number; mime?: string }) => string | undefined {
  return ref => {
    try {
      const key = keyOf(sessionId, ref.hash)
      const hit = cache.get(key)
      if (hit) return hit.base64
      if (!missing.has(key)) void fetchBlob(sessionId, ref.hash)
      return undefined
    } catch {
      return undefined
    }
  }
}

async function fetchBlob(sessionId: string, hash: string): Promise<void> {
  const key = keyOf(sessionId, hash)
  if (pending.has(key) || cache.has(key)) return
  pending.add(key)
  try {
    const { base64, bytes } = await sessionEventsApi.readBlob({ sessionId, hash })
    if (!base64) {
      // 读不到就记下来,别每次物化都再问一遍(账本引用的正文可能真的没了)。
      missing.add(key)
      return
    }
    cache.set(key, { base64, bytes: bytes ?? base64.length })
    totalBytes += bytes ?? base64.length
    evictIfNeeded()
    for (const listener of listeners) {
      try {
        listener(sessionId)
      } catch {
        // 订阅者自己的事故不该影响别的订阅者。
      }
    }
  } catch (error) {
    missing.add(key)
    log.debug('session blob fetch failed', { sessionId, hash }, error)
  } finally {
    pending.delete(key)
  }
}

/** 有正文拉回来了 —— 订阅者据此重物化。返回注销函数。 */
export function onSessionBlobLoaded(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 仅测试 / 会话删除:忘掉一切。 */
export function resetSessionBlobCache(): void {
  cache.clear()
  pending.clear()
  missing.clear()
  totalBytes = 0
}

/** 现场读数(缓存了几条、多少字节、几条确认读不到)。 */
export function getSessionBlobCacheStats(): {
  entries: number
  bytes: number
  missing: number
} {
  return { entries: cache.size, bytes: totalBytes, missing: missing.size }
}
