// @vitest-environment happy-dom
/**
 * 账本 blob 的渲染侧缓存(U2-a0)。
 *
 * 钉的是那道**同步问 / 异步补**的落差:折叠器要一个同步解析器,而渲染层拿正文
 * 只能是一次 RPC。没命中就先留占位、把拉取排出去,拉回来通知订阅者重物化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readBlobMock = vi.fn(async (_input: { sessionId: string; hash: string }) => (
  {} as { base64?: string; bytes?: number }
))

vi.mock('@/platform/session-events-client', () => ({
  sessionEventsApi: {
    readBlob: (input: { sessionId: string; hash: string }) => readBlobMock(input),
  },
}))

const {
  createSessionBlobResolver,
  getSessionBlobCacheStats,
  onSessionBlobLoaded,
  resetSessionBlobCache,
} = await import('@/stores/session-blobs')

const SESSION = 'blob-session'
const REF = { hash: 'abcdef0123456789', bytes: 4 }

beforeEach(() => {
  readBlobMock.mockReset()
  readBlobMock.mockResolvedValue({})
  resetSessionBlobCache()
})

afterEach(() => {
  resetSessionBlobCache()
})

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('session blob 缓存', () => {
  it('没命中:当场返回 undefined(留占位),同时把拉取排出去', async () => {
    readBlobMock.mockResolvedValue({ base64: 'AAEC', bytes: 3 })
    const resolve = createSessionBlobResolver(SESSION)

    expect(resolve(REF)).toBeUndefined()
    await tick()

    expect(readBlobMock).toHaveBeenCalledWith({ sessionId: SESSION, hash: REF.hash })
    // 拉回来之后同一格就有正文了 —— 下一次物化补上。
    expect(resolve(REF)).toBe('AAEC')
    expect(getSessionBlobCacheStats().entries).toBe(1)
  })

  it('正文到了通知订阅者(重物化的触发点)', async () => {
    readBlobMock.mockResolvedValue({ base64: 'AAEC', bytes: 3 })
    const seen: string[] = []
    const off = onSessionBlobLoaded(sessionId => seen.push(sessionId))

    createSessionBlobResolver(SESSION)(REF)
    await tick()
    off()

    expect(seen).toEqual([SESSION])
  })

  it('同一个 hash 只拉一次(并发重物化不放大成一串请求)', async () => {
    readBlobMock.mockResolvedValue({ base64: 'AAEC', bytes: 3 })
    const resolve = createSessionBlobResolver(SESSION)

    resolve(REF)
    resolve(REF)
    resolve(REF)
    await tick()

    expect(readBlobMock).toHaveBeenCalledTimes(1)
  })

  it('读不到就记下来,不每次物化都再问一遍', async () => {
    readBlobMock.mockResolvedValue({})
    const resolve = createSessionBlobResolver(SESSION)

    resolve(REF)
    await tick()
    resolve(REF)
    resolve(REF)
    await tick()

    expect(readBlobMock).toHaveBeenCalledTimes(1)
    expect(getSessionBlobCacheStats().missing).toBe(1)
    // 一直是 undefined:折叠侧照实留引用,屏幕上是占位 —— 那正是此刻的事实。
    expect(resolve(REF)).toBeUndefined()
  })

  it('拉取炸了不抛给渲染路径', async () => {
    readBlobMock.mockRejectedValue(new Error('boom'))
    const resolve = createSessionBlobResolver(SESSION)

    expect(resolve(REF)).toBeUndefined()
    await tick()
    expect(resolve(REF)).toBeUndefined()
    expect(getSessionBlobCacheStats().entries).toBe(0)
  })

  it('条数闸:超上限按插入序淘汰最老的', async () => {
    const { SESSION_BLOB_MAX_ENTRIES } = await import('@/stores/session-blobs')
    const resolve = createSessionBlobResolver(SESSION)
    for (let index = 0; index <= SESSION_BLOB_MAX_ENTRIES; index++) {
      readBlobMock.mockResolvedValue({ base64: 'AA', bytes: 1 })
      resolve({ hash: `hash${index.toString(16).padStart(16, '0')}`, bytes: 1 })
      await tick()
    }
    expect(getSessionBlobCacheStats().entries).toBeLessThanOrEqual(SESSION_BLOB_MAX_ENTRIES)
  })
})
