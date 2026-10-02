import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OnethingTodoPlanStore } from '../store.js'
import { OnethingTodoPlanWatcher } from '../watcher.js'

let root: string
let selected: string
let watcher: OnethingTodoPlanWatcher
type WatchedHandle = {
  directory: string
  recursive: boolean
  handle: fsSync.FSWatcher
  closeRequested: boolean
  closed: boolean
  completion: Promise<void>
}
let handles: WatchedHandle[]
const releases: Array<() => void> = []
beforeEach(async () => {
  handles = []
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-watcher-life-'))
  selected = path.join(root, 'a')
  watcher = new OnethingTodoPlanWatcher({
    store: new OnethingTodoPlanStore({ getConfiguredDirectory: () => selected, getDefaultStorePath: () => root }),
    notifyChanged: vi.fn(),
  })
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await watcher.drain()
  expect(handles.every(handle => handle.closeRequested)).toBe(true)
  // Linux's recursive wrapper closes native children synchronously, but their
  // close notifications arrive on nextTick after the wrapper's own close event.
  await Promise.all(handles.map(handle => handle.completion))
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

function observeWatchers() {
  const watch = fsSync.watch.bind(fsSync)
  return vi.spyOn(fsSync, 'watch').mockImplementation((...args) => {
    const handle = watch(...args)
    const options: unknown = args[1]
    const observed: WatchedHandle = {
      directory: String(args[0]),
      recursive: typeof options === 'object' && options !== null && 'recursive' in options && options.recursive === true,
      handle, closeRequested: false, closed: false,
      completion: Promise.resolve(),
    }
    observed.completion = new Promise(resolve => handle.once('close', () => { observed.closed = true; resolve() }))
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(() => { observed.closeRequested = true; close() })
    handles.push(observed)
    return handle
  })
}

// Node's Linux fallback calls fs.watch again for each native child. Count the
// application's recursive subscriptions, while retaining every real handle.
function subscriptions() { return handles.filter(handle => handle.recursive) }

function blockMkdir(directory: string) {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const mkdir = fs.mkdir.bind(fs)
  vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
    if (String(args[0]) === directory) { entered(); await held }
    return mkdir(...args)
  })
  releases.push(release)
  return { started, release }
}

it('waits for a pending mkdir but never opens a watcher after quiesce', async () => {
  const blocked = blockMkdir(selected)
  const watch = observeWatchers()
  const starting = watcher.start()
  await blocked.started
  watcher.quiesce()
  let drained = false
  const draining = watcher.drain().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  await expect(watcher.start()).rejects.toThrow('shutting down')
  blocked.release()
  await starting
  await draining
  expect(watch).not.toHaveBeenCalled()
})

it('a superseded start cannot replace the real watcher opened for the new directory', async () => {
  const blocked = blockMkdir(selected)
  observeWatchers()
  const first = watcher.start()
  await blocked.started
  watcher.stop()
  selected = path.join(root, 'b')
  await fs.mkdir(path.join(selected, 'nested'), { recursive: true })
  await watcher.start()
  expect(subscriptions()).toHaveLength(1)
  const actual = subscriptions()[0]
  expect(actual.directory).toBe(selected)
  blocked.release()
  await first
  await watcher.start()
  expect(subscriptions()).toEqual([actual])
  await watcher.drain()
  expect(actual.closed).toBe(true)
})

it('observes an OS handle closed before stop and can open a replacement without a stuck drain', async () => {
  observeWatchers()
  await watcher.start()
  expect(subscriptions()).toHaveLength(1)
  const first = subscriptions()[0]
  first.handle.close()
  await first.completion
  await watcher.start()
  expect(subscriptions()).toHaveLength(2)
  const second = subscriptions()[1]
  expect(second.handle).not.toBe(first.handle)
  expect(second.closed).toBe(false)
  await watcher.drain()
  expect(second.closed).toBe(true)
})
