import { describe, expect, it } from 'vitest'
import {
  createModelsDevCache,
  MODELS_DEV_API_URL,
  MODELS_DEV_DEFAULT_MAX_AGE_MS,
  type ModelsDevCacheFs,
} from '../models-dev-cache.js'

const FILE = '/store/cache/models-dev.json'
const V1 = { deepseek: { id: 'deepseek', name: 'DeepSeek', models: {} } }
const V2 = { openai: { id: 'openai', name: 'OpenAI', models: {} } }

/** 内存文件系统:只实现这个模块要的那几口,并记下每一次 rename(原子写的证据)。 */
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const renames: Array<[string, string]> = []
  const fs: ModelsDevCacheFs = {
    async readFile(path) {
      const text = files.get(path)
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return text
    },
    async writeFile(path, data) { files.set(path, data) },
    async rename(from, to) {
      const text = files.get(from)
      if (text === undefined) throw new Error('ENOENT')
      files.delete(from)
      files.set(to, text)
      renames.push([from, to])
    },
    async mkdir() { return undefined },
    async rm(path) { files.delete(path) },
  }
  return { fs, files, renames }
}

function cachedFile(fields: { etag?: string; fetchedAt: number; data?: unknown }) {
  return JSON.stringify({ version: 1, data: V1, ...fields })
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag ? { etag: init.etag } : {},
  })
}

function recordingFetch(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
    return respond(init)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('models.dev single cache (§5.4)', () => {
  it('fresh cache hit: reads the file, sends zero requests', async () => {
    const { fs } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 1_000 }) })
    const { fetch, calls } = recordingFetch(() => jsonResponse(V2))
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => 1_000 + 60_000 })

    const result = await cache.get()
    expect(result).toMatchObject({ data: V1, stale: false, from: 'cache', fetchedAt: 1_000 })
    expect(calls).toHaveLength(0)
  })

  it('expired cache + 304: conditional request, only fetchedAt moves', async () => {
    const { fs, files, renames } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 0 }) })
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 304 }))
    const now = MODELS_DEV_DEFAULT_MAX_AGE_MS + 5
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => now })

    const result = await cache.get()
    expect(result).toMatchObject({ data: V1, stale: false, from: 'not-modified', fetchedAt: now })
    expect(calls).toEqual([{ url: MODELS_DEV_API_URL, headers: { Accept: 'application/json', 'If-None-Match': '"v1"' } }])
    const onDisk = JSON.parse(files.get(FILE)!)
    expect(onDisk).toEqual({ version: 1, etag: '"v1"', fetchedAt: now, data: V1 })
    // 原子写:临时文件 rename 到终点,盘上不留临时文件。
    expect(renames).toHaveLength(1)
    expect(renames[0][1]).toBe(FILE)
    expect([...files.keys()]).toEqual([FILE])
  })

  it('force on a fresh cache still asks — but conditionally, not a blind re-download', async () => {
    const { fs } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 1_000 }) })
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 304 }))
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => 2_000 })

    const result = await cache.get({ force: true })
    expect(result.from).toBe('not-modified')
    expect(calls[0].headers['If-None-Match']).toBe('"v1"')
  })

  it('200: replaces the whole file and keeps the new etag', async () => {
    const { fs, files } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 0 }) })
    const { fetch } = recordingFetch(() => jsonResponse(V2, { etag: '"v2"' }))
    const now = MODELS_DEV_DEFAULT_MAX_AGE_MS * 2
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => now, headers: { 'User-Agent': 'ua' } })

    const result = await cache.get()
    expect(result).toMatchObject({ data: V2, stale: false, from: 'network', fetchedAt: now })
    expect(JSON.parse(files.get(FILE)!)).toEqual({ version: 1, etag: '"v2"', fetchedAt: now, data: V2 })
    // 下一次在 24 小时内:读内存 / 文件,不再打网络。
    const again = await cache.get()
    expect(again.from).toBe('cache')
    expect(again.data).toEqual(V2)
  })

  it('no cache at all: plain request without If-None-Match, then writes the file', async () => {
    const { fs, files } = memoryFs()
    const { fetch, calls } = recordingFetch(() => jsonResponse(V1))
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => 7 })

    await expect(cache.get()).resolves.toMatchObject({ data: V1, from: 'network' })
    expect(calls[0].headers['If-None-Match']).toBeUndefined()
    expect(JSON.parse(files.get(FILE)!)).toEqual({ version: 1, fetchedAt: 7, data: V1 })
  })

  it('network failure with a cache: hands back the cache, marked stale', async () => {
    const { fs } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 0 }) })
    const { fetch } = recordingFetch(() => { throw new Error('offline') })
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => MODELS_DEV_DEFAULT_MAX_AGE_MS * 3 })

    await expect(cache.get()).resolves.toMatchObject({ data: V1, stale: true, from: 'stale-cache', fetchedAt: 0 })
  })

  it('non-2xx with a cache is also a failure → stale cache', async () => {
    const { fs } = memoryFs({ [FILE]: cachedFile({ fetchedAt: 0 }) })
    const { fetch } = recordingFetch(() => new Response('nope', { status: 503 }))
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => MODELS_DEV_DEFAULT_MAX_AGE_MS * 3 })

    await expect(cache.get({ force: true })).resolves.toMatchObject({ stale: true, data: V1 })
  })

  it('network failure without a cache: throws', async () => {
    const { fs } = memoryFs()
    const { fetch } = recordingFetch(() => { throw new Error('offline') })
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch })

    await expect(cache.get()).rejects.toThrow('offline')
  })

  it('a corrupt or foreign-shaped file reads as "no cache"', async () => {
    for (const text of ['{not json', JSON.stringify({ version: 2, fetchedAt: 1, data: {} })]) {
      const { fs } = memoryFs({ [FILE]: text })
      const { fetch, calls } = recordingFetch(() => jsonResponse(V2))
      const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => 2 })
      await expect(cache.get()).resolves.toMatchObject({ data: V2, from: 'network' })
      expect(calls[0].headers['If-None-Match']).toBeUndefined()
    }
  })

  it('single flight: two concurrent refreshes send exactly one request', async () => {
    const { fs } = memoryFs({ [FILE]: cachedFile({ etag: '"v1"', fetchedAt: 0 }) })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetch, calls } = recordingFetch(async () => {
      await gate
      return jsonResponse(V2, { etag: '"v2"' })
    })
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => MODELS_DEV_DEFAULT_MAX_AGE_MS * 2 })

    const first = cache.get({ force: true })
    const second = cache.get({ force: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toHaveLength(1)
    expect(a.data).toEqual(V2)
    expect(b.data).toEqual(V2)
  })

  it("one caller's abort rejects only that caller; the shared request still lands in the cache", async () => {
    const { fs, files } = memoryFs()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { fetch, calls } = recordingFetch(async () => {
      await gate
      return jsonResponse(V1)
    })
    const cache = createModelsDevCache({ filePath: FILE, fs, fetch, now: () => 9 })

    const controller = new AbortController()
    const aborted = cache.get({ signal: controller.signal })
    const rider = cache.get()
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort(new Error('shutdown'))
    await expect(aborted).rejects.toThrow('shutdown')
    release()
    await expect(rider).resolves.toMatchObject({ data: V1 })
    expect(calls).toHaveLength(1)
    expect(files.has(FILE)).toBe(true)
  })
})
