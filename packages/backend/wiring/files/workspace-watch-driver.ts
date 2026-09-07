import { watch, type FSWatcher } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { platform } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

export interface WorkspaceWatchDriver {
  /** Native admission is established. Rejection never falls back to an unready watcher. */
  readonly ready: Promise<void>
  /** Stops callbacks immediately and waits for initialization and the first real native close. */
  close(): Promise<void>
}

const START_TIMEOUT_MS = 15_000
const NATIVE_FLAGS = {
  MustScanSubDirs: 0x1, UserDropped: 0x2, KernelDropped: 0x4, EventIdsWrapped: 0x8,
  HistoryDone: 0x10, RootChanged: 0x20, ItemCreated: 0x100, ItemRemoved: 0x200,
  ItemRenamed: 0x800, ItemCloned: 0x400000,
} as const

function watchError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  // The owner can call close before it begins awaiting ready. Keep the original
  // rejecting promise observable without creating an unhandled rejection.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Owns exactly one subscription. macOS uses a separate FSEvents stream and its
 * public HistoryDone sentinel: fs.watch returning is not a native ready ACK.
 * No readiness file is written, including when the watched directory is read-only.
 */
export function createWorkspaceWatchDriver(
  root: string,
  onChange: (path: string, eventType: string) => void,
  onError: (error: unknown) => void,
): WorkspaceWatchDriver {
  const admission = deferred()
  let phase: 'opening' | 'ready' | 'closing' | 'closed' = 'opening'
  let readySettled = false
  let hasFailure = false
  let firstFailure: unknown
  let stopNative: (() => void | Promise<void>) | undefined
  let closePromise: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined = undefined

  const settleReady = (error?: { value: unknown }): void => {
    if (readySettled) return
    readySettled = true
    clearTimeout(timer)
    if (error) admission.reject(error.value)
    else admission.resolve()
  }

  const fail = (error: unknown): void => {
    if (!hasFailure) {
      hasFailure = true
      firstFailure = error
      phase = 'closing'
      settleReady({ value: error })
      try { onError(error) } catch { /* The original watcher failure remains authoritative. */ }
    }
    void close().catch(() => {})
  }

  const markReady = (): void => {
    if (phase !== 'opening') return
    phase = 'ready'
    settleReady()
  }

  const deliver = (path: string, eventType: string): void => {
    if (phase !== 'ready') return
    try { onChange(path, eventType) } catch (error) { fail(error) }
  }

  // Queue initialization only after the synchronous owned handle is constructed.
  // close() also owns a dynamic import or realpath operation that is still pending.
  const initialization = Promise.resolve().then(async () => {
    if (phase !== 'opening') return
    if (!root || !isAbsolute(root) || root.includes('\0')) {
      throw watchError('WORKSPACE_WATCH_INVALID_ROOT', 'Workspace watch root must be an absolute path.')
    }
    const requestedRoot = resolve(root)
    if (platform() === 'darwin') {
      const fsevents = await import('fsevents')
      if (phase !== 'opening') return
      if (typeof fsevents.watch !== 'function' || typeof fsevents.constants !== 'object'
        || fsevents.constants === null
        || Object.entries(NATIVE_FLAGS).some(([name, value]) => Reflect.get(fsevents.constants, name) !== value)) {
        throw watchError('WORKSPACE_WATCH_NATIVE_UNAVAILABLE', 'The macOS watcher does not expose the required fsevents 2.3.2 contract.')
      }
      const physicalRoot = await realpath(requestedRoot)
      if (phase !== 'opening') return
      const flags = fsevents.constants
      const rescan = flags.MustScanSubDirs | flags.UserDropped | flags.KernelDropped
        | flags.RootChanged | flags.EventIdsWrapped
      const rename = flags.ItemCreated | flags.ItemRemoved | flags.ItemRenamed | flags.ItemCloned
      let historyDone = false
      const nativeStop = fsevents.watch(physicalRoot, 0, (changedPath, eventFlags) => {
        if (phase === 'closing' || phase === 'closed') return
        // HistoryDone has no meaningful path and must be handled before mapping.
        if (eventFlags & flags.HistoryDone) {
          historyDone = true
          if (stopNative) markReady()
          return
        }
        if (phase !== 'ready') return // Historical paths are not live changes.
        if (eventFlags & rescan) { deliver(requestedRoot, 'change'); return }
        if (!isAbsolute(changedPath)) return
        const suffix = relative(physicalRoot, resolve(changedPath))
        if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) return
        deliver(resolve(requestedRoot, suffix), eventFlags & rename ? 'rename' : 'change')
      })
      if (typeof nativeStop !== 'function') {
        throw watchError('WORKSPACE_WATCH_NATIVE_UNAVAILABLE', 'The macOS watcher did not return its native close function.')
      }
      stopNative = nativeStop
      if (historyDone) markReady()
      return
    }

    const listener = (eventType: string, name: string | Buffer | null): void => {
      const changedPath = typeof name === 'string' && name.length > 0 ? resolve(requestedRoot, name) : requestedRoot
      const suffix = relative(requestedRoot, changedPath)
      if (suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\') || isAbsolute(suffix)) return
      deliver(changedPath, eventType || 'change')
    }
    let watcher: FSWatcher
    try { watcher = watch(requestedRoot, { recursive: true }, listener) }
    catch { watcher = watch(requestedRoot, { recursive: false }, listener) }
    const nativeClosed = deferred()
    watcher.once('close', () => {
      nativeClosed.resolve()
      if (phase === 'opening' || phase === 'ready') {
        fail(watchError('WORKSPACE_WATCH_CLOSED', 'Workspace watcher closed unexpectedly.'))
      }
    })
    watcher.on('error', error => { if (phase !== 'closed') fail(error) })
    stopNative = async () => {
      try { watcher.close() } catch (error) { fail(error) }
      await nativeClosed.promise
    }
    markReady()
  }).catch(fail)

  function close(): Promise<void> {
    if (closePromise) return closePromise
    phase = 'closing'
    settleReady({ value: hasFailure ? firstFailure : watchError('WORKSPACE_WATCH_CLOSED', 'Workspace watcher was closed before becoming ready.') })
    closePromise = (async () => {
      await initialization
      try { await stopNative?.() } catch (error) { fail(error) }
      phase = 'closed'
      if (hasFailure) throw firstFailure
    })()
    void closePromise.catch(() => {})
    return closePromise
  }

  timer = setTimeout(() => fail(watchError('WORKSPACE_WATCH_START_TIMEOUT',
    `Workspace watcher did not become ready within ${START_TIMEOUT_MS} ms.`)), START_TIMEOUT_MS)
  return { ready: admission.promise, close }
}
