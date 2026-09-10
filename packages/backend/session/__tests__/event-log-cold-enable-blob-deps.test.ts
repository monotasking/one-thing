import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackendHandle, setCurrentBackend } from '../../current.js'
import {
  acquireSessionEventLogStore,
  flushSessionEventLog as flush,
  getSessionEventsLogPath,
} from '../event-log.js'
import { createSessionEventLayer } from '../event-layer.js'
import { getSessionBlobPath as blobPathOf, putSessionBlob } from '../blob-store.js'

/**
 * **冷启用时那份 blob 依赖账**(工单 6 ②b)。
 *
 * `tryEnable` 从盘上装载 `blobDependencies` —— 它决定「这个进程第一次做检查点时,
 * 哪些历史 blob 要先 fsync」。工单 6 把那一趟从「整份账本每行都 `JSON.parse`」
 * 收成「只解析结构上可能带引用的行」(53MB 夹具上 343ms → 46ms),所以这套用例
 * 钉的是**收窄之后答案一个字没变**:两种编码各一条、混在一堆不带引用的行中间,
 * 冷开之后都还认得出来。
 *
 * 判的是**看得见的后果**(那个 blob 有没有在账本之前被 fsync),不是内部那张表:
 * 表是私有的,而「先刷 blob 再刷账本」才是这份账存在的理由。
 */
let directory: string
let owner: ReturnType<typeof acquireSessionEventLogStore>
let layer: ReturnType<typeof createSessionEventLayer>

function reopen(): void {
  layer = createSessionEventLayer()
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cold-deps-')))
  owner = acquireSessionEventLogStore(directory)
  setCurrentBackend(createBackendHandle({ journalStore: owner }))
  reopen()
})

afterEach(async () => {
  layer.dispose()
  await owner.drainAndRelease().catch(() => undefined)
  setCurrentBackend(null)
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

/** 换一个进程接手同一份 store:释放 → 重新 acquire → 新的 layer。 */
async function coldReopen(): Promise<void> {
  layer.dispose()
  await owner.drainAndRelease()
  setCurrentBackend(null)
  owner = acquireSessionEventLogStore(directory)
  setCurrentBackend(createBackendHandle({ journalStore: owner }))
  reopen()
}

describe('cold enable restores blob dependencies', () => {
  it('syncs both encodings from history before the journal, with plain rows in between', async () => {
    const write = layer.writer.write
    write('s', 'session/created', { sessionId: 's' })
    const objectBlob = putSessionBlob('s', Buffer.alloc(96 * 1024, 0x5a), 'image/png')!
    const textBlob = putSessionBlob('s', 'data:image/png;base64,encoded-image')!
    // 不带引用的行夹在中间 —— 预筛跳过的正是它们这一类。
    for (let index = 0; index < 20; index += 1) {
      write('s', 'user/message', { message: { id: `plain-${index}`, role: 'user', content: `第 ${index} 句,没有任何引用` } })
    }
    // ① `BlobRef` 对象:编码之后必然带 `"hash"`。
    write('s', 'tool/result', { callId: 'c', result: { blob: objectBlob }, resultPreview: 'output', isError: false })
    // ② 正文内嵌:`onething-blob://<16 位十六进制>`。
    write('s', 'user/message', { message: { id: 'text-image', role: 'user', content: `image: onething-blob://${textBlob.hash}` } })
    await flush('s')

    await coldReopen()

    const synced: string[] = []
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.push(String(args[0])) })
      return handle
    })
    // 新进程的第一次检查点:`durableBlobs` 是空的,历史依赖照单全刷。
    layer.writer.write('s', 'request/end', { requestIndex: 1 })
    await flush('s')

    expect(synced).toContain(blobPathOf('s', objectBlob.hash))
    expect(synced).toContain(blobPathOf('s', textBlob.hash))
    // 账本永远排在它依赖的字节后面 —— 反过来就是「账本说有、文件还没有」。
    expect(synced.indexOf(getSessionEventsLogPath('s'))).toBeGreaterThan(
      Math.max(synced.indexOf(blobPathOf('s', objectBlob.hash)), synced.indexOf(blobPathOf('s', textBlob.hash))),
    )
  })

  it('reports a historical blob that went missing (the dependency really was restored)', async () => {
    const write = layer.writer.write
    write('s', 'session/created', { sessionId: 's' })
    const blob = putSessionBlob('s', 'important tool output', 'text/plain')!
    write('s', 'tool/result', { callId: 'c', result: { blob }, resultPreview: 'output', isError: false })
    await flush('s')

    await coldReopen()
    fs.unlinkSync(blobPathOf('s', blob.hash))

    layer.writer.write('s', 'request/end', { requestIndex: 1 })
    // 认不出那条历史依赖的话,这一发会安安静静地成功 —— 那才是真正的静默损坏。
    await expect(flush('s')).rejects.toMatchObject({ operation: 'blob', cause: { code: 'ENOENT' } })
  })
})
