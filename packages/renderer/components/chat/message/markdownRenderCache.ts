import type { MarkdownSegment } from '@/composables/parseStreamingMarkdown'

/**
 * Markdown render cache.
 *
 * Two layers:
 * - In-memory LRU (`segmentCache`, `mdCache`) — primary read path, sync.
 * - IndexedDB write-through for `mdCache` — survives app restarts so repeat
 *   visits to the same session don't pay markdown-it + hljs again.
 *
 * `segmentCache` is intentionally **not** persisted: it only feeds the
 * streaming pipeline (which is transient), and completed messages render via
 * StaticMarkdown using `static:*` keys in `mdCache`.
 *
 * Bump `CACHE_DB_VERSION` whenever a markdown-it rule, hljs config, or anything
 * that changes the rendered HTML format ships — the upgrade handler drops the
 * store wholesale so we never serve stale HTML.
 */

// v2: status emoji (✅❌⚠️) now normalize to ink glyphs in the text rule.
// v3: numeric table cells get the md-cell-numeric class (no-wrap).
// v4: tables render inside a .md-table-scroll wrapper.
// v5: collab <card>/<file> inline tags render as .collab-tag spans.
// v6: @mention markers render as neutral .md-mention spans (im-message §A).
// v7: mention marker field separator | → U+E001 (裸竖线在表格里被当列分隔线切碎)。
// v8: 消息引用打标 —— link_open / code_inline 产出 .msg-ref 锚点与 data-ref。
const CACHE_DB_VERSION = 8
const DB_NAME = 'onething-markdown-cache'
const STORE_NAME = 'md'

const SEGMENT_CACHE_MAX = 256
const MD_CACHE_MAX = 1024
const INIT_TIMEOUT_MS = 1000

interface DiskEntry {
  id: string
  value: string
}

const segmentCache = new Map<string, MarkdownSegment[]>()
const mdCache = new Map<string, string>()

let db: IDBDatabase | null = null
let initPromise: Promise<void> | null = null
let disabled = false

const pendingWrites = new Map<string, string>()
const pendingDeletes = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY_MS = 250

function isIDBAvailable(): boolean {
  return !disabled && typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    let settled = false
    const finish = (database: IDBDatabase | null) => {
      if (settled) {
        try { database?.close() } catch { /* noop */ }
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(database)
    }
    const timeout = setTimeout(() => {
      console.warn('[markdown-cache] open timed out')
      finish(null)
    }, INIT_TIMEOUT_MS)
    try {
      request = indexedDB.open(DB_NAME, CACHE_DB_VERSION)
    } catch (e) {
      console.warn('[markdown-cache] indexedDB.open threw', e)
      finish(null)
      return
    }
    request.onerror = () => {
      console.warn('[markdown-cache] open failed', request.error)
      finish(null)
    }
    request.onblocked = () => {
      console.warn('[markdown-cache] open blocked')
    }
    request.onupgradeneeded = (event) => {
      const upgrading = (event.target as IDBOpenDBRequest).result
      if (upgrading.objectStoreNames.contains(STORE_NAME)) {
        upgrading.deleteObjectStore(STORE_NAME)
      }
      upgrading.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const opened = request.result
      // If another tab triggers a version change, drop the connection so we
      // stop writing into a store the new tab is about to recreate.
      opened.onversionchange = () => {
        try { opened.close() } catch { /* noop */ }
        db = null
        disabled = true
      }
      finish(opened)
    }
  })
}

function loadFromDisk(database: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction
    try {
      tx = database.transaction(STORE_NAME, 'readonly')
    } catch (e) {
      console.warn('[markdown-cache] read tx failed', e)
      resolve()
      return
    }
    const store = tx.objectStore(STORE_NAME)
    const request = store.openCursor()
    let count = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const entry = cursor.value as DiskEntry
      if (entry && typeof entry.id === 'string' && typeof entry.value === 'string') {
        mdCache.set(entry.id, entry.value)
        count += 1
      }
      cursor.continue()
    }
    request.onerror = () => resolve()
    tx.oncomplete = () => {
      // Map iteration order is insertion order. We just loaded entries in
      // whatever cursor order IDB returns (key-ordered). For LRU semantics
      // that's not "most recently used" but it's stable; subsequent reads
      // will reorder via touchCacheEntry as content gets accessed.
      // Trim to memory cap if disk had more (shouldn't normally happen, but
      // defensive).
      while (mdCache.size > MD_CACHE_MAX) {
        const firstKey = mdCache.keys().next().value
        if (firstKey === undefined) break
        mdCache.delete(firstKey)
        // Don't queue a disk delete here — the disk entry was just loaded; if
        // we drop it from memory and re-queue a delete, we lose it on next
        // session switch. Leave disk untouched until proper eviction.
      }
      if (count > 0) {
        console.info('[markdown-cache] restored', count, 'entries from disk')
      }
      resolve()
    }
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

export function ensureCacheReady(): Promise<void> {
  if (initPromise) return initPromise
  if (!isIDBAvailable()) {
    initPromise = Promise.resolve()
    return initPromise
  }
  initPromise = (async () => {
    try {
      db = await openDb()
      if (db) {
        await Promise.race([
          loadFromDisk(db),
          new Promise<void>(resolve => setTimeout(resolve, INIT_TIMEOUT_MS)),
        ])
      }
    } catch (e) {
      console.warn('[markdown-cache] init failed', e)
      disabled = true
    }
  })()
  return initPromise
}

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

function flush() {
  flushTimer = null
  if (!db) return
  if (pendingWrites.size === 0 && pendingDeletes.size === 0) return
  const writes = Array.from(pendingWrites)
  const deletes = Array.from(pendingDeletes)
  pendingWrites.clear()
  pendingDeletes.clear()
  let tx: IDBTransaction
  try {
    tx = db.transaction(STORE_NAME, 'readwrite')
  } catch (e) {
    console.warn('[markdown-cache] write tx failed', e)
    return
  }
  const store = tx.objectStore(STORE_NAME)
  tx.onerror = () => {
    // Likely a QuotaExceededError. Disable persistence for this session so we
    // stop hammering IDB; memory cache still works.
    console.warn('[markdown-cache] write failed', tx.error)
    if (tx.error?.name === 'QuotaExceededError') disabled = true
  }
  for (const [id, value] of writes) {
    try { store.put({ id, value }) } catch { /* noop */ }
  }
  for (const id of deletes) {
    try { store.delete(id) } catch { /* noop */ }
  }
}

// Flush on page hide so in-flight writes from a streaming completion or a
// rapid session switch don't get lost when the user closes the window.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  })
}

function queueWrite(key: string, value: string) {
  if (!isIDBAvailable()) return
  pendingDeletes.delete(key)
  pendingWrites.set(key, value)
  scheduleFlush()
}

function queueDelete(key: string) {
  if (!isIDBAvailable()) return
  pendingWrites.delete(key)
  pendingDeletes.add(key)
  scheduleFlush()
}

function touchCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  maxSize: number,
  onEvict?: (evictedKey: string) => void,
) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxSize) {
    const firstKey = cache.keys().next().value
    if (firstKey === undefined) break
    cache.delete(firstKey)
    onEvict?.(firstKey)
  }
}

export function getCachedSegments(key: string): MarkdownSegment[] | undefined {
  return segmentCache.get(key)
}

export function cacheSegments(key: string, value: MarkdownSegment[]) {
  touchCacheEntry(segmentCache, key, value, SEGMENT_CACHE_MAX)
}

export function getCachedMarkdownHtml(key: string): string | undefined {
  const cached = mdCache.get(key)
  if (cached === undefined) return undefined
  // LRU bump: re-insert to mark as most recently used.
  mdCache.delete(key)
  mdCache.set(key, cached)
  return cached
}

export function cacheMarkdownHtml(key: string, value: string) {
  touchCacheEntry(mdCache, key, value, MD_CACHE_MAX, queueDelete)
  queueWrite(key, value)
}

// Kick off IDB connection at module load so it runs in parallel with the rest
// of app boot. App.vue awaits `ensureCacheReady()` before unhiding the UI.
if (isIDBAvailable()) {
  void ensureCacheReady().catch((e) => console.warn('[markdown-cache] init failed', e))
}
