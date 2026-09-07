import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let previousPath: string | undefined
let directory: string
let stores: typeof import('../sessions.js')
let layer: Awaited<ReturnType<typeof import('../../session/testing/store-layer.js').installStoreSessionLayerForTest>>

beforeEach(async () => {
  vi.resetModules()
  previousPath = process.env.ONETHING_STORE_PATH
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-deletion-lifetime-'))
  process.env.ONETHING_STORE_PATH = directory
  stores = await import('../sessions.js')
  const { installStoreSessionLayerForTest } = await import('../../session/testing/store-layer.js')
  layer = await installStoreSessionLayerForTest()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await layer?.dispose()
  if (previousPath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousPath
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('deletion over the real session writer and store', () => {
  it('keeps the directory until a paused append finishes and rejects late writes after deletion', async () => {
    stores.createSession('held', 'held')
    await stores.flushSessionSave('held')
    const { flushSessionEventLog } = await import('../../session/event-log.js')
    await flushSessionEventLog('held')
    const entered = barrier()
    const release = barrier()
    const append = fs.promises.appendFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return append(...args)
    })
    layer.sessionLayer.commands.appendMessage('held', { message: {
      id: 'old-message', role: 'user', content: 'save before deletion', timestamp: 1,
    } })
    await entered.promise
    const deleting = layer.deleteSession('held')
    let finished = false
    void deleting.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(fs.existsSync(path.join(directory, 'sessions', 'held', 'events.jsonl'))).toBe(true)
    expect(stores.findSessionIndexMeta('held')).toBeDefined()
    expect(() => layer.sessionLayer.deletion.assertAccepting('held')).toThrow()
    release.resolve()
    await deleting
    expect(fs.existsSync(path.join(directory, 'sessions', 'held'))).toBe(false)
    expect(() => layer.sessionLayer.commands.appendMessage('held', { message: {
      id: 'late', role: 'user', content: 'late', timestamp: 2,
    } })).toThrow()
    expect(fs.existsSync(path.join(directory, 'sessions', 'held'))).toBe(false)
  })

  it('recreates the same id with a new ledger and projection while retained old state stays unchanged', async () => {
    stores.createSession('reuse', 'old')
    layer.sessionLayer.commands.appendMessage('reuse', { message: {
      id: 'old-message', role: 'user', content: 'old', timestamp: 1,
    } })
    const old = layer.sessionLayer.events.projections.getLiveSessionProjection('reuse')!
    const oldState = structuredClone(old)
    await layer.sessionLayer.ensureWritable('reuse')
    await layer.deleteSession('reuse')
    stores.createSession('reuse', 'new')
    layer.sessionLayer.commands.appendMessage('reuse', { message: {
      id: 'new-message', role: 'user', content: 'new', timestamp: 2,
    } })
    await layer.sessionLayer.ensureWritable('reuse')
    const { flushSessionEventLog, readSessionLogEventsSync } = await import('../../session/event-log.js')
    await flushSessionEventLog('reuse')
    expect(layer.sessionLayer.reads.listMessages('reuse').messages.map(message => message.id)).toEqual(['new-message'])
    expect(layer.sessionLayer.events.projections.getLiveSessionProjection('reuse')).not.toBe(old)
    expect(old).toEqual(oldState)
    const disk = readSessionLogEventsSync('reuse')
    expect(disk[0].seq).toBe(1)
    expect(JSON.stringify(disk)).not.toContain('old-message')
  })
})
