import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackendHandle, setCurrentBackend } from '../../current.js'
import {
  acquireSessionEventLogStore,
  flushSessionEventLog as flush,
  getSessionEventsLogPath,
  readSessionLogEventsSync,
  SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED,
} from '../event-log.js'
import { createSessionEventLayer } from '../event-layer.js'
import { getSessionBlobPath, putSessionBlob, readSessionBlob } from '../blob-store.js'

let directory: string
let owner: ReturnType<typeof acquireSessionEventLogStore>
let layer: ReturnType<typeof createSessionEventLayer>
/**
 * 这套用例验的是**低层落盘契约**(blob 依赖屏障、故障粘住),但写还是走正门
 * (工单 4 D1):`appendSessionLogEvent` 只有写入口一个调用者,连故障注入的
 * 存储组件测试也不例外 —— 从前这里是靠给检查器加一条测试白名单绕过去的,
 * 那正是「改闸门迁就代码」。
 */
const append: ReturnType<typeof createSessionEventLayer>['writer']['write'] =
  (...args) => layer.writer.write(...args)
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-blob-')))
  owner = acquireSessionEventLogStore(directory)
  setCurrentBackend(createBackendHandle({ journalStore: owner }))
  layer = createSessionEventLayer()
  append('s', 'session/created', { sessionId: 's' })
})
afterEach(async () => {
  layer.dispose()
  await owner.drainAndRelease().catch(() => undefined)
  setCurrentBackend(null)
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('checkpoint blob dependencies', () => {
  it('flushes new referenced blob bytes before the journal and cold-replays full content', async () => {
    await flush('s')
    const content = Buffer.alloc(128 * 1024, 0xa5)
    const blob = putSessionBlob('s', content, 'image/png')!
    const blobPath = getSessionBlobPath('s', blob.hash)
    const synced: string[] = []
    const opened: Array<[string, unknown]> = []
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      opened.push([String(args[0]), args[1]])
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.push(String(args[0])) })
      return handle
    })
    const seq = append('s', 'user/message', {
      message: { id: 'image', role: 'user', attachments: [{ base64Data: blob }] },
    })!
    await flush('s', seq)
    expect(synced[0]).toBe(blobPath)
    expect(synced.at(-1)).toBe(getSessionEventsLogPath('s'))
    expect(opened.find(([p]) => p === blobPath)?.[1]).toBe('r+')
    expect(opened.find(([p]) => p.endsWith('events.jsonl'))?.[1]).toBe('r+')
    if (SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED) expect(synced).toContain(path.dirname(blobPath))
    else expect(synced).toEqual([blobPath, getSessionEventsLogPath('s')])
    await owner.drainAndRelease()
    owner = acquireSessionEventLogStore(directory)
    setCurrentBackend(createBackendHandle({ journalStore: owner }))
    expect(readSessionLogEventsSync('s')).toHaveLength(2)
    expect(readSessionBlob('s', blob.hash)).toEqual(content)
  })

  it.each(['sync', 'missing', 'corrupt'] as const)('rejects %s blob dependency and blocks subsequent events', async failure => {
    const blob = putSessionBlob('s', 'important tool output', 'text/plain')!
    const blobPath = getSessionBlobPath('s', blob.hash)
    const cause = new Error('blob fsync EIO')
    if (failure === 'missing') fs.unlinkSync(blobPath)
    if (failure === 'corrupt') fs.writeFileSync(blobPath, 'different data')
    if (failure === 'sync') {
      const open = fs.promises.open.bind(fs.promises)
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (String(args[0]) === blobPath) vi.spyOn(handle, 'sync').mockRejectedValue(cause)
        return handle
      })
    }
    append('s', 'tool/result', { callId: 'c', result: { blob }, resultPreview: 'output', isError: false })
    await expect(flush('s')).rejects.toMatchObject({ operation: 'blob', ...(failure === 'sync' ? { cause } : {}) })
    expect(() => append('s', 'request/end', { requestIndex: 1 })).toThrow('session event log write failed')
    expect(() => putSessionBlob('s', 'later body')).toThrow('session event log write failed')
  })

  it('does not require a later event blob to persist an earlier target', async () => {
    const earlier = 1
    append('s', 'tool/result', { callId: 'c', result: { blob: { hash: 'abcdef0123456789', bytes: 10 } }, resultPreview: 'output', isError: false })
    await expect(flush('s', earlier)).resolves.toBeUndefined()
    await expect(flush('s', 2)).rejects.toMatchObject({ operation: 'blob' })
  })

  it('also checks synthesized image references embedded inside text', async () => {
    const blob = putSessionBlob('s', 'data:image/png;base64,encoded-image')!
    append('s', 'user/message', { message: { id: 'text-image', role: 'user', content: `image: onething-blob://${blob.hash}` } })
    fs.unlinkSync(getSessionBlobPath('s', blob.hash))
    await expect(flush('s')).rejects.toMatchObject({ operation: 'blob', cause: { code: 'ENOENT' } })
  })

  it.runIf(SESSION_EVENT_DIRECTORY_SYNC_SUPPORTED)('includes the newly created blobs directory after the first journal checkpoint', async () => {
    await flush('s')
    const blob = putSessionBlob('s', 'new body')!
    const cause = new Error('blobs directory sync failed')
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === path.dirname(getSessionBlobPath('s', blob.hash))) {
        vi.spyOn(handle, 'sync').mockRejectedValue(cause)
      }
      return handle
    })
    append('s', 'tool/result', { callId: 'c', result: { blob }, resultPreview: 'output', isError: false })
    await expect(flush('s')).rejects.toMatchObject({ operation: 'blob', cause })
  })
})
