import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { ScratchpadChangedPayload, ScratchpadDocument } from '@/types'
import { platformApi } from '@/platform'

export interface ScratchpadRecord {
  content: string
  /** 文件 mtime(ms);0 = 这张纸还没落过盘。 */
  version: number
  filePath: string
  loaded: boolean
  /** 本地有未 flush 的编辑 —— 远端回声在这期间一律延后应用。 */
  dirty: boolean
  /** 引擎真正消费过的最新版本(由 `scratchpad:consumed` 回推,不是猜的)。 */
  consumedVersion: number
}

/** 每次 flush 记一笔 {版本 → 当时的文档长度},水位线靠它把版本换算成位置。 */
interface VersionLength {
  version: number
  docLength: number
}

/** 环长:一次会话里能追溯的历史版本数。多了也没人看,少了水位会掉。 */
const VERSION_RING_SIZE = 24
const FLUSH_DEBOUNCE_MS = 500

/**
 * **这里不记"开着没开"**(2026-08-15 合并)。草稿纸并进 Todo 窗之后,"在不在
 * 看这张纸"就是那扇窗的模式(`components/chat/todo-panel-mode.ts`,每窗口一份
 * localStorage),不再是每会话的一位状态 —— 连同悬浮垫的几何一起退役了。
 * 这个 store 只管纸的**内容**与**已读水位**。
 */

function emptyRecord(): ScratchpadRecord {
  return {
    content: '',
    version: 0,
    filePath: '',
    loaded: false,
    dirty: false,
    consumedVersion: 0,
  }
}

export const useScratchpadStore = defineStore('scratchpad', () => {
  const records = reactive<Record<string, ScratchpadRecord>>({})
  const versionRings = new Map<string, VersionLength[]>()
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Map<string, Promise<void>>()
  /** 本地脏着时收到的远端快照,flush 落地后再补应用。 */
  const deferredRemote = new Map<string, ScratchpadDocument | null>()
  const loading = new Map<string, Promise<void>>()

  function ensureRecord(sessionId: string): ScratchpadRecord {
    let record = records[sessionId]
    if (!record) {
      record = emptyRecord()
      records[sessionId] = record
    }
    return record
  }

  function getRecord(sessionId: string | undefined | null): ScratchpadRecord | null {
    if (!sessionId) return null
    return records[sessionId] ?? null
  }

  function noteVersionLength(sessionId: string, version: number, docLength: number) {
    if (!version) return
    let ring = versionRings.get(sessionId)
    if (!ring) {
      ring = []
      versionRings.set(sessionId, ring)
    }
    const existing = ring.find(entry => entry.version === version)
    if (existing) {
      existing.docLength = docLength
      return
    }
    ring.push({ version, docLength })
    if (ring.length > VERSION_RING_SIZE) ring.splice(0, ring.length - VERSION_RING_SIZE)
  }

  function applyDocument(sessionId: string, document: ScratchpadDocument) {
    const record = ensureRecord(sessionId)
    record.content = document.content
    record.version = document.version
    record.filePath = document.filePath
    record.loaded = true
    noteVersionLength(sessionId, document.version, document.content.length)
  }

  async function load(sessionId: string, options?: { force?: boolean }): Promise<void> {
    if (!sessionId) return
    const record = records[sessionId]
    if (record?.loaded && !options?.force) return
    const pending = loading.get(sessionId)
    if (pending) return pending
    const task = (async () => {
      try {
        const response = await platformApi.getScratchpad({ sessionId })
        if (response?.success && response.document) {
          // 装载期间用户已经动过纸 —— 本地是更新的事实,不许被回填盖掉。
          if (!records[sessionId]?.dirty) applyDocument(sessionId, response.document)
        } else {
          ensureRecord(sessionId).loaded = true
        }
      } catch (error) {
        console.error('[scratchpad] load failed:', error)
        ensureRecord(sessionId).loaded = true
      } finally {
        loading.delete(sessionId)
      }
    })()
    loading.set(sessionId, task)
    return task
  }

  /** 本地即改 + 防抖落盘。纸自己就是事实,不写 composerDrafts。 */
  function setContent(sessionId: string, content: string) {
    if (!sessionId) return
    const record = ensureRecord(sessionId)
    if (record.content === content) return
    record.content = content
    record.loaded = true
    record.dirty = true
    scheduleFlush(sessionId)
  }

  function scheduleFlush(sessionId: string) {
    const existing = flushTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    flushTimers.set(
      sessionId,
      setTimeout(() => {
        flushTimers.delete(sessionId)
        void flush(sessionId)
      }, FLUSH_DEBOUNCE_MS),
    )
  }

  async function flush(sessionId: string): Promise<void> {
    const record = records[sessionId]
    if (!record || !record.dirty) return
    // 上一发还在路上就排在它后面 —— 并发两发的返回顺序不可保证,后到的旧
    // 版本会把新版本盖回去。
    const running = inFlight.get(sessionId)
    if (running) {
      await running
      return flush(sessionId)
    }
    const content = record.content
    const task = (async () => {
      try {
        const response = await platformApi.updateScratchpad({ sessionId, content })
        if (response?.success && response.document) {
          record.version = response.document.version
          record.filePath = response.document.filePath
          noteVersionLength(sessionId, response.document.version, content.length)
        }
        // flush 期间又打了字 → 还脏,下一拍继续。
        if (record.content === content) record.dirty = false
      } catch (error) {
        console.error('[scratchpad] flush failed:', error)
      } finally {
        inFlight.delete(sessionId)
      }
    })()
    inFlight.set(sessionId, task)
    await task
    if (!record.dirty) drainDeferredRemote(sessionId)
  }

  /** 切会话 / 卸载时把欠的账立刻结掉。 */
  async function flushNow(sessionId?: string | null): Promise<void> {
    if (!sessionId) return
    const timer = flushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      flushTimers.delete(sessionId)
    }
    await flush(sessionId)
  }

  async function flushAll(): Promise<void> {
    await Promise.all(Object.keys(records).map(sessionId => flushNow(sessionId)))
  }

  function drainDeferredRemote(sessionId: string) {
    if (!deferredRemote.has(sessionId)) return
    const document = deferredRemote.get(sessionId) ?? null
    deferredRemote.delete(sessionId)
    if (document) {
      applyRemoteDocument(sessionId, document)
    } else {
      void load(sessionId, { force: true })
    }
  }

  function applyRemoteDocument(sessionId: string, document: ScratchpadDocument) {
    const record = records[sessionId]
    if (!record) return
    // 回声抑制:自己刚写出去的那一份原样回来了,只认版本号不动正文。
    if (document.content === record.content) {
      if (document.version > record.version) record.version = document.version
      if (document.filePath) record.filePath = document.filePath
      noteVersionLength(sessionId, document.version, document.content.length)
      return
    }
    if (document.version && document.version <= record.version) return
    applyDocument(sessionId, document)
  }

  /** 主进程广播(用户在别的窗口改、或 AI 用文件工具改了这张纸)。 */
  function applyChanged(payload: ScratchpadChangedPayload) {
    const sessionId = payload?.sessionId
    if (!sessionId) return
    const record = records[sessionId]
    // 没在本窗口装载过的会话不需要同步:下次 load 自然读到最新。
    if (!record) return
    if (record.dirty) {
      deferredRemote.set(sessionId, payload.document ?? null)
      return
    }
    if (payload.document) {
      applyRemoteDocument(sessionId, payload.document)
    } else {
      void load(sessionId, { force: true })
    }
  }

  async function remove(sessionId: string): Promise<void> {
    if (!sessionId) return
    const timer = flushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      flushTimers.delete(sessionId)
    }
    deferredRemote.delete(sessionId)
    versionRings.delete(sessionId)
    delete records[sessionId]
    try {
      await platformApi.deleteScratchpad({ sessionId })
    } catch (error) {
      console.error('[scratchpad] delete failed:', error)
    }
  }

  /** 草稿会话物化成正式 id 时,纸跟着搬家。 */
  async function adopt(fromSessionId: string, toSessionId: string): Promise<void> {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
    await flushNow(fromSessionId)
    const from = records[fromSessionId]
    if (from) {
      records[toSessionId] = { ...from, filePath: '', dirty: false }
      delete records[fromSessionId]
    }
    const ring = versionRings.get(fromSessionId)
    if (ring) {
      versionRings.set(toSessionId, ring)
      versionRings.delete(fromSessionId)
    }
    try {
      await platformApi.adoptScratchpad({ fromSessionId, toSessionId })
    } catch (error) {
      console.error('[scratchpad] adopt failed:', error)
    }
    await load(toSessionId, { force: true })
  }

  // --- 已读水位(P1) ---

  /** 引擎回推的消费点。诚实起见:只认事件,不猜。 */
  function noteConsumed(sessionId: string, version: number) {
    if (!sessionId || !version) return
    const record = ensureRecord(sessionId)
    if (version > record.consumedVersion) record.consumedVersion = version
  }

  /**
   * 已读末尾在**当前文档**里的字符位置。
   *
   * 版本命中环里的记录 → 取那一版的长度;之后本地又打了字,长度只会变长,所以
   * `min(记录长度, 当前长度)` 是一个不会说谎的下界。没记录 = 不知道,返回 null,
   * UI 就不画线(宁可不画,也不画在错的地方)。
   */
  function consumedOffset(sessionId: string | undefined | null): number | null {
    if (!sessionId) return null
    const record = records[sessionId]
    if (!record || !record.consumedVersion) return null
    const ring = versionRings.get(sessionId)
    const entry = ring?.find(item => item.version === record.consumedVersion)
    if (!entry) return null
    return Math.min(entry.docLength, record.content.length)
  }

  /** 水位之后还没被读过的那一段(手动发送的缺省载荷)。 */
  function pendingText(sessionId: string | undefined | null): string {
    const record = getRecord(sessionId)
    if (!record) return ''
    const offset = consumedOffset(sessionId)
    if (offset === null) return record.content
    return record.content.slice(offset)
  }

  // 一次性订阅:主进程 / server 的 changed 广播是这张纸的第二个写者。
  // 宿主缺席(node 环境的组件单测)时静静跳过,不炸掉整个 store。
  try {
    if (typeof platformApi.onScratchpadChanged === 'function') {
      platformApi.onScratchpadChanged(payload => applyChanged(payload as ScratchpadChangedPayload))
    }
  } catch (error) {
    console.error('[scratchpad] subscribe failed:', error)
  }

  return {
    records,
    getRecord,
    load,
    setContent,
    flush,
    flushNow,
    flushAll,
    applyChanged,
    remove,
    adopt,
    noteConsumed,
    consumedOffset,
    pendingText,
  }
})
