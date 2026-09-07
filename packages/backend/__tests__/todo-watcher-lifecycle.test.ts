import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OnethingBackend } from '../backend.js'

let directory: string
let previous: string | undefined
let backend: OnethingBackend | undefined
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
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backend-todo-watcher-')))
  previous = process.env.ONETHING_STORE_PATH
  process.env.ONETHING_STORE_PATH = path.join(directory, 'a')
  vi.resetModules()
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  expect(handles.every(handle => handle.closeRequested)).toBe(true)
  // Native children of Node's Linux recursive wrapper emit close on nextTick.
  await Promise.all(handles.map(handle => handle.completion))
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(directory, { recursive: true, force: true })
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

// Keep the actual recursive subscriptions distinct from the native watchers
// that Node may create beneath each subscription on Linux.
function subscriptions() { return handles.filter(handle => handle.recursive) }

async function assemble(name: string) {
  const { createOnethingBackend } = await import('../backend.js')
  backend = await createOnethingBackend({ storePath: path.join(directory, name), owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
    terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null, plugins: null,
    gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
  } })
  return backend
}

async function saveDirectory(target: string) {
  const { getSettings } = await import('../stores/settings.js')
  const { dispatchRpc } = await import('../rpc/registry.js')
  const current = getSettings()
  return dispatchRpc({ domain: 'settings', method: 'saveSettings', payload: {
    ...current, general: { ...current.general, todoPlan: { ...current.general?.todoPlan, directory: target } },
  } })
}

it('settings RPC repoints actual fs watchers and Backend exit waits for their close events', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  observeWatchers()
  const firstDirectory = path.join(directory, 'notes-1')
  expect(await saveDirectory(firstDirectory)).toMatchObject({ ok: true, data: { success: true } })
  expect(subscriptions()).toHaveLength(1)
  const first = subscriptions()[0]
  const secondDirectory = path.join(directory, 'notes-2')
  expect(await saveDirectory(secondDirectory)).toMatchObject({ ok: true, data: { success: true } })
  expect(subscriptions().map(handle => handle.directory)).toEqual([firstDirectory, secondDirectory])
  const second = subscriptions()[1]
  expect(second.handle).not.toBe(first.handle)
  expect(second.closed).toBe(false)
  await instance.dispose()
  expect(first.closed).toBe(true)
  expect(second.closed).toBe(true)
})

it('shutdown drains a pending settings-triggered open and prevents the old instance from watching Backend B', { timeout: 60000 }, async () => {
  const instance = await assemble('a')
  const old = instance.todoPlans
  const target = path.join(directory, 'pending-notes')
  const mkdir = fs.mkdir.bind(fs)
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
    if (String(args[0]) === target) { entered(); await held }
    return mkdir(...args)
  })
  const watch = observeWatchers()
  const saving = saveDirectory(target)
  await started
  let disposed = false
  const stopping = instance.dispose().then(() => { disposed = true })
  await expect(old.start()).rejects.toThrow()
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: path.join(directory, 'a') }).status).toBe('held')
  expect(disposed).toBe(false)
  release()
  await saving
  await stopping
  expect(watch).not.toHaveBeenCalled()
  const current = await assemble('b')
  process.env.ONETHING_STORE_PATH = path.join(directory, 'unrelated')
  await current.todoPlans.start()
  expect(subscriptions()).toHaveLength(1)
  const actual = subscriptions()[0]
  expect(actual.directory).toBe(path.join(directory, 'b', 'todo-plan'))
  await expect(old.start()).rejects.toThrow()
  expect(() => old.store.getDirectory()).toThrow('disposed')
  old.stop()
  await old.drain()
  expect(actual.closed).toBe(false)
  await current.dispose()
  expect(actual.closed).toBe(true)
})
