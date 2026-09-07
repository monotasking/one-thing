/** Workspace watches belong to one server surface, shared by its RPC and SSE. */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isPathInside } from '../../rpc/sandbox.js'
import { getLogger } from '../logging/index.js'
import { createWorkspaceWatchDriver, type WorkspaceWatchDriver } from './workspace-watch-driver.js'

const log = getLogger('files.watch')

export interface WorkspaceFileChangedPayload {
  root: string
  path: string
  eventType: string
}
export type WorkspaceFileChangedHandler = (payload: WorkspaceFileChangedPayload) => void
export interface WorkspaceWatchResult { success: boolean; error?: string }

export interface WorkspaceWatchService {
  start(scope: string, root: string): Promise<WorkspaceWatchResult>
  stop(scope: string, root: string): Promise<WorkspaceWatchResult>
  subscribe(scope: string, handler: WorkspaceFileChangedHandler): () => void
  close(): Promise<void>
}

interface WatchEntry {
  scope: string
  root: string
  stopped: boolean
  driver?: WorkspaceWatchDriver
  setup: Promise<void>
  ready: Promise<WorkspaceWatchResult>
  closing?: Promise<void>
}

const closedMessage = 'Workspace watches are closed.'
function failed(error: unknown): WorkspaceWatchResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/** No process-wide registry: closing one owner cannot affect another owner. */
export function createWorkspaceWatchService(
  options: { createDriver?: typeof createWorkspaceWatchDriver } = {},
): WorkspaceWatchService {
  const createDriver = options.createDriver ?? createWorkspaceWatchDriver
  const entries = new Map<string, Map<string, WatchEntry>>()
  // A closing entry remains owned until its actual close succeeds. Failed close
  // stays here so a later surface shutdown still observes the failure.
  const owned = new Set<WatchEntry>()
  const handlers = new Map<string, Set<WorkspaceFileChangedHandler>>()
  let closed = false
  let disposal: Promise<void> | undefined

  function removeEntry(entry: WatchEntry): void {
    const roots = entries.get(entry.scope)
    if (roots?.get(entry.root) !== entry) return
    roots.delete(entry.root)
    if (roots.size === 0) entries.delete(entry.scope)
  }

  function closeEntry(entry: WatchEntry): Promise<void> {
    if (entry.closing) return entry.closing
    entry.stopped = true
    let complete!: () => void
    let reject!: (error: unknown) => void
    entry.closing = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail })
    void entry.closing.catch(() => {})
    // Cancel a ready wait before awaiting setup, which may be waiting for ready.
    let driverClose: Promise<void> | undefined
    try { driverClose = entry.driver?.close() }
    catch (error) { driverClose = Promise.reject(error) }
    void driverClose?.catch(() => {})
    void (async () => {
      await entry.setup.catch(() => {}) // Start reports its own setup failure.
      if (!driverClose && entry.driver) driverClose = entry.driver.close()
      await driverClose
      removeEntry(entry)
      owned.delete(entry)
    })().then(complete, reject)
    return entry.closing
  }

  const service: WorkspaceWatchService = {
    start(scopeInput, rootInput) {
      if (closed) return Promise.resolve(failed(closedMessage))
      const scope = resolve(scopeInput)
      const root = resolve(rootInput)
      if (!isPathInside(root, scope)) {
        return Promise.resolve(failed('Workspace watch root must stay inside the workspace sandbox root.'))
      }
      let roots = entries.get(scope)
      const existing = roots?.get(root)
      if (existing) {
        return existing.stopped
          ? Promise.resolve(failed('Workspace watch is stopping or failed to close.'))
          : existing.ready
      }
      if (!roots) { roots = new Map(); entries.set(scope, roots) }
      // Register ownership before the first asynchronous stat/import/ready wait.
      const entry: WatchEntry = {
        scope, root, stopped: false,
        setup: Promise.resolve(), ready: Promise.resolve({ success: false }),
      }
      roots.set(root, entry)
      owned.add(entry)
      entry.setup = (async () => {
        const rootStats = await stat(root).catch(() => null)
        if (entry.stopped || closed) throw new Error(closedMessage)
        if (!rootStats?.isDirectory()) throw new Error('Workspace watch root must be an existing directory.')
        entry.driver = createDriver(root, (changedPath, eventType) => {
          if (closed || entry.stopped || !isPathInside(changedPath, scope)) return
          for (const handler of handlers.get(scope) ?? []) {
            try { handler({ root, path: changedPath, eventType }) }
            catch (error) { log.warn('workspace change subscriber failed', { root }, error) }
          }
        }, error => {
          log.warn('workspace watcher failed', { watchRoot: root }, error)
          // Errors after ready still own their actual close.
          void closeEntry(entry).catch(() => {})
        })
        // A driver may report an error synchronously while being constructed.
        if (entry.stopped || closed) void entry.driver.close().catch(() => {})
        await entry.driver.ready
        if (entry.stopped || closed) throw new Error(closedMessage)
      })()
      entry.ready = entry.setup.then(
        () => ({ success: true }),
        async error => {
          try { await closeEntry(entry) }
          catch (cleanupError) {
            log.warn('workspace watcher cleanup failed', { watchRoot: root }, cleanupError)
          }
          return failed(error)
        },
      )
      return entry.ready
    },
    async stop(scopeInput, rootInput) {
      const entry = entries.get(resolve(scopeInput))?.get(resolve(rootInput))
      if (entry) await closeEntry(entry)
      return { success: true }
    },
    subscribe(scopeInput, handler) {
      if (closed) throw new Error(closedMessage)
      const scope = resolve(scopeInput)
      let subscriptions = handlers.get(scope)
      if (!subscriptions) { subscriptions = new Set(); handlers.set(scope, subscriptions) }
      subscriptions.add(handler)
      return () => {
        subscriptions.delete(handler)
        if (subscriptions.size === 0 && handlers.get(scope) === subscriptions) handlers.delete(scope)
      }
    },
    close() {
      if (disposal) return disposal
      closed = true
      handlers.clear()
      let complete!: () => void
      let reject!: (error: unknown) => void
      disposal = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail })
      void disposal.catch(() => {})
      const closing = [...owned].map(closeEntry)
      void Promise.allSettled(closing).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Workspace watchers failed to close.')
      }).then(complete, reject)
      return disposal
    },
  }
  return service
}
