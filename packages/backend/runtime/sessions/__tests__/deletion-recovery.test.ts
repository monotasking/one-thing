import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createSessionDeletionRecovery } from '../deletion-recovery.js'
import { writeDurableJson as writeDurableSessionJson } from '../../storage/durable-json.js'

let directory: string
const metaPath = (id: string) => path.join(directory, id, 'meta.json')
const indexPath = () => path.join(directory, 'index.json')
function seed(ids: readonly string[], legacy = false) {
  const records = ids.map(id => ({ id, name: id, createdAt: 1, storageGeneration: `original-${id}` }))
  for (const record of records) {
    writeDurableSessionJson(legacy ? path.join(directory, `${record.id}.json`) : metaPath(record.id), record)
    if (!legacy) fs.writeFileSync(path.join(directory, record.id, 'events.jsonl'), 'original events')
  }
  writeDurableSessionJson(indexPath(), records)
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-deletion-recovery-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })

it('makes intent failure visible before any destructive action', async () => {
  seed(['parent'])
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  const failure = new Error('intent storage failed')
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw failure })
  expect(() => recovery.prepare(['parent'])).toThrow(failure)
  expect(fs.existsSync(metaPath('parent'))).toBe(true)
  expect(JSON.parse(fs.readFileSync(indexPath(), 'utf8'))).toHaveLength(1)
})

it('rejects every mutation through an owner whose lease was released', async () => {
  seed(['parent'])
  let owned = true
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {
    if (!owned) throw new Error('Store lease is no longer held')
  } })
  const intent = recovery.prepare(['parent'])
  owned = false
  expect(() => recovery.prepare(['parent'])).toThrow('lease is no longer held')
  await expect(recovery.commit(intent)).rejects.toThrow('lease is no longer held')
  await expect(recovery.recover()).rejects.toThrow('lease is no longer held')
  expect(fs.existsSync(metaPath('parent'))).toBe(true)
})

it('retains the original generation and retries partial quarantine cleanup after a cold reopen', async () => {
  seed(['parent', 'child'])
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  const intent = recovery.prepare(['parent', 'child'])
  expect(Object.isFrozen(intent.targets)).toBe(true)
  const remove = fs.rmSync
  const failure = new Error('quarantine cleanup failed')
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (String(file).endsWith('parent.directory')) throw failure
    return remove(file, options)
  })
  await expect(recovery.commit(intent)).rejects.toThrow(failure)
  // 工单 5 §3:代际是这套墓碑唯一的判据。meta 已经进隔离区,不交代际就问不出
  // 判据 —— 从此答 false(从前答 true,于是一次历史删除会永久毒死这个 id)。
  expect(recovery.isDeleted('parent')).toBe(false)
  expect(recovery.isDeleted('parent', 'original-parent')).toBe(true)
  expect(fs.existsSync(metaPath('parent'))).toBe(false)
  expect(fs.existsSync(metaPath('child'))).toBe(true)
  vi.restoreAllMocks()
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  expect(JSON.parse(fs.readFileSync(indexPath(), 'utf8'))).toEqual([])
  expect(fs.existsSync(metaPath('child'))).toBe(false)
  expect(cold.isDeleted('parent', 'original-parent')).toBe(true)
})

it('keeps completed tombstones authoritative if old files reappear, while preserving a newer incarnation', async () => {
  seed(['resurrected', 'replaced'])
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await recovery.commit(recovery.prepare(['resurrected', 'replaced']))
  seed(['resurrected', 'replaced']) // Model filesystem replay of old directory entries.
  writeDurableSessionJson(metaPath('replaced'), { id: 'replaced', storageGeneration: 'new-incarnation', name: 'new' })
  writeDurableSessionJson(indexPath(), [
    { id: 'resurrected', storageGeneration: 'original-resurrected' },
    { id: 'replaced', storageGeneration: 'new-incarnation' },
  ])
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  /*
   * 工单 5 §3:complete 的 intent **不再每次开机重放一遍删除**(那是每台机器每次
   * 启动都为几百条历史删除跑几百趟空转文件系统往返)。权威从"再删一次"换成
   * "墓碑仍在":复活回来的那份带的是旧代际,于是它被索引滤掉、`isDeleted` 认得它,
   * 读路一条都够不着 —— 而新的化身(不同代际)一个字没被碰。
   */
  expect(cold.isDeleted('resurrected')).toBe(true)
  expect(cold.isDeleted('resurrected', 'original-resurrected')).toBe(true)
  expect(JSON.parse(fs.readFileSync(metaPath('replaced'), 'utf8')).name).toBe('new')
  expect(JSON.parse(fs.readFileSync(indexPath(), 'utf8'))).toEqual([{ id: 'replaced', storageGeneration: 'new-incarnation' }])
  expect(cold.isDeleted('replaced', 'new-incarnation')).toBe(false)
})

it('stamps ownerless legacy metadata without changing its content and resumes its removal', async () => {
  writeDurableSessionJson(path.join(directory, 'legacy.json'), { id: 'legacy', messages: [{ id: 'message', content: 'saved' }] })
  writeDurableSessionJson(indexPath(), [{ id: 'legacy' }])
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  const intent = recovery.prepare(['legacy'])
  const stamped = JSON.parse(fs.readFileSync(path.join(directory, 'legacy.json'), 'utf8'))
  expect(stamped.storageGeneration).toBe(intent.targets[0].generation)
  expect(stamped.messages).toEqual([{ id: 'message', content: 'saved' }])
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  expect(fs.existsSync(path.join(directory, 'legacy.json'))).toBe(false)
})

it('recovers associated resource failures and preserves traces belonging to a new generation', async () => {
  seed(['parent'])
  const traces = path.join(directory, 'trace-store')
  fs.mkdirSync(path.join(traces, 'parent'), { recursive: true })
  fs.writeFileSync(path.join(traces, 'parent', 'trace.json'), 'old trace')
  const options = { sessionsDir: directory, associatedDirectories: { traces }, assertOwned() {} }
  const recovery = createSessionDeletionRecovery(options)
  const intent = recovery.prepare(['parent'])
  expect(intent.targets[0].associated).toEqual(['traces'])
  const remove = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (String(file).endsWith('parent.associated-traces')) throw new Error('trace removal failed')
    return remove(file, options)
  })
  await expect(recovery.commit(intent)).rejects.toThrow('trace removal failed')
  expect(fs.existsSync(metaPath('parent'))).toBe(true)
  vi.restoreAllMocks()
  await expect(createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} }).recover()).rejects.toThrow('unavailable associated')
  expect(fs.existsSync(metaPath('parent'))).toBe(true)
  await createSessionDeletionRecovery(options).recover()
  expect(fs.existsSync(path.join(traces, 'parent'))).toBe(false)
  writeDurableSessionJson(metaPath('parent'), { id: 'parent', storageGeneration: 'new-parent' })
  writeDurableSessionJson(indexPath(), [{ id: 'parent', storageGeneration: 'new-parent' }])
  fs.mkdirSync(path.join(traces, 'parent'))
  fs.writeFileSync(path.join(traces, 'parent', 'trace.json'), 'new trace')
  await createSessionDeletionRecovery(options).recover()
  expect(fs.readFileSync(path.join(traces, 'parent', 'trace.json'), 'utf8')).toBe('new trace')
})

it.each(['isolate', 'index'])('recovers a child-process crash after %s through the persisted intent', async stage => {
  seed(['parent', 'child'])
  const fixture = fileURLToPath(new URL('./fixtures/delete-crash.ts', import.meta.url))
  const child = spawnSync('bun', [fixture, directory, stage], { encoding: 'utf8', timeout: 15000 })
  expect(child.error, child.stderr).toBeUndefined()
  expect(child.status, child.stderr).toBe(73)
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  await cold.recover()
  expect(JSON.parse(fs.readFileSync(indexPath(), 'utf8'))).toEqual([])
  expect(fs.existsSync(metaPath('parent'))).toBe(false)
  expect(fs.existsSync(metaPath('child'))).toBe(false)
  expect(cold.isDeleted('child', 'original-child')).toBe(true)
})

/*
 * 工单 5 §3 的两条判据。
 *
 * 判"次数"而不是判"结果":`recover()` 改成只重放 pending 之后,结果层面看不出
 * 差别(该不可见的仍然不可见),真正变了的是**开机要做多少次文件系统往返**。
 * 所以这里数 `fs.fsyncSync` 与 `fs.rmSync` 的调用次数 —— 反证成立:把 `recover()`
 * 里那句 `.filter(intent => intent.status === 'pending')` 换回 `intents.values()`,
 * 下面两条都红。
 */
it('replays only the intent that never completed, and leaves the finished ones alone', async () => {
  seed(['done', 'crashed'])
  const first = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await first.commit(first.prepare(['done']))

  // 崩在 isolate 与 complete 之间:intent 落了盘,状态还是 pending。
  const second = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  const intent = second.prepare(['crashed'])
  expect(intent.status).toBe('pending')

  const removed: string[] = []
  const remove = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => { removed.push(String(file)); return remove(file, options) })
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  vi.restoreAllMocks()

  // 只有崩掉那一条的隔离区被碰过;已完成那一条的路径一次都没出现。
  expect(removed.some(file => file.includes('crashed'))).toBe(true)
  expect(removed.some(file => file.includes('done'))).toBe(false)
  expect(fs.existsSync(metaPath('crashed'))).toBe(false)
  expect(cold.isDeleted('done', 'original-done')).toBe(true)
  expect(cold.isDeleted('crashed', 'original-crashed')).toBe(true)
})

it('does not pay one fsync per historical deletion at startup', { timeout: 120_000 }, async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `gone-${index}`)
  seed(ids)
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  for (const id of ids) await recovery.commit(recovery.prepare([id]))

  let fsyncs = 0
  const fsync = fs.fsyncSync
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { fsyncs += 1; return fsync(fd) })
  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  vi.restoreAllMocks()

  // 一百条已完成的删除 = 零次重放。开机只剩"读一遍墓碑"这件事本身。
  expect(fsyncs).toBe(0)
  expect(cold.isDeleted('gone-0', 'original-gone-0')).toBe(true)
  expect(cold.isDeleted('gone-99', 'original-gone-99')).toBe(true)
})

it('drops a completed intent once it is older than the retention window', async () => {
  seed(['old'])
  const recovery = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  const intent = recovery.commit(recovery.prepare(['old']))
  await intent
  const operations = fs.readdirSync(path.join(directory, '.deletions'))
  expect(operations).toHaveLength(1)
  const intentFile = path.join(directory, '.deletions', operations[0]!, 'intent.json')
  const stale = Date.now() - 8 * 24 * 60 * 60 * 1000
  fs.utimesSync(intentFile, stale / 1000, stale / 1000)

  const cold = createSessionDeletionRecovery({ sessionsDir: directory, assertOwned() {} })
  await cold.recover()
  expect(fs.readdirSync(path.join(directory, '.deletions'))).toHaveLength(0)
  expect(cold.isDeleted('old', 'original-old')).toBe(false)
})
