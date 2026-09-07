import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import * as path from 'node:path'
import type { OnethingTodoPlanStore, TodoPlanChangedPayload } from './store.js'

export interface OnethingTodoPlanWatcherOptions {
  store: OnethingTodoPlanStore
  notifyChanged: (payload: TodoPlanChangedPayload) => void
  onError?: (error: unknown) => void
}

// Coalesce the burst of events a single save produces (editors commonly write,
// truncate and rename), and give the file a moment to settle before we read it.
const DEBOUNCE_MS = 120

/**
 * Watches the todo store on disk and broadcasts what changed.
 *
 * The AI edits its todo with the ordinary write/edit tools, which know nothing
 * about the todo store, so nothing would tell the UI to refresh without this.
 * It also means a todo edited by hand, in the user's own editor, updates the
 * panel the same way the AI's edits do.
 */
export class OnethingTodoPlanWatcher {
  private watcher: fsSync.FSWatcher | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly changedPaths = new Set<string>()
  private watchedDirectory = ''
  private generation = 0
  private accepting = true
  private readonly operations = new Set<Promise<void>>()

  constructor(private readonly options: OnethingTodoPlanWatcherOptions) {}

  start(): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Todo watcher is shutting down'))
    const directory = this.options.store.getDirectory()
    if (this.watcher && this.watchedDirectory === directory) return Promise.resolve()
    this.stop()
    return this.track(this.open(directory, this.generation))
  }

  private track(work: Promise<void>): Promise<void> {
    this.operations.add(work)
    void work.then(() => this.operations.delete(work), () => this.operations.delete(work))
    return work
  }

  private async open(directory: string, generation: number): Promise<void> {
    try {
      await fs.mkdir(directory, { recursive: true })
      if (!this.accepting || this.generation !== generation) return
      const watcher = fsSync.watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
        if (!this.accepting || this.generation !== generation) return
        if (!filename) return
        this.changedPaths.add(path.resolve(directory, filename.toString()))
        this.schedule()
      })
      this.watcher = watcher
      this.watchedDirectory = directory
      // Register at creation: an OS error may close it before stop() is called.
      this.track(new Promise<void>(resolve => watcher.once('close', () => {
        if (this.watcher === watcher) {
          this.watcher = null
          this.watchedDirectory = ''
        }
        resolve()
      })))
      watcher.on('error', error => this.options.onError?.(error))
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  stop(): void {
    this.generation += 1
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = null
    }
    if (this.watcher) {
      this.watcher.close()
    }
    this.watcher = null
    this.watchedDirectory = ''
    this.changedPaths.clear()
  }

  quiesce(): void { this.accepting = false; this.stop() }

  async drain(): Promise<void> {
    this.quiesce()
    while (this.operations.size) await Promise.allSettled([...this.operations])
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending)
    const generation = this.generation
    this.pending = setTimeout(() => {
      this.pending = null
      if (!this.accepting || generation !== this.generation) return
      const paths = [...this.changedPaths]
      this.changedPaths.clear()
      for (const payload of this.classify(paths)) {
        if (!this.accepting || generation !== this.generation) break
        this.options.notifyChanged(payload)
      }
    }, DEBOUNCE_MS)
  }

  private classify(paths: string[]): TodoPlanChangedPayload[] {
    const directory = this.watchedDirectory
    const payloads: TodoPlanChangedPayload[] = []
    const seenSessions = new Set<string>()
    let sawUserNote = false

    for (const changed of paths) {
      // A write we made ourselves already went out through notifyChanged.
      if (this.options.store.wasSelfWrite(changed)) continue

      const relative = path.relative(directory, changed)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      const segments = relative.split(path.sep)

      if (segments[0] === 'user-notes' && segments.length === 2 && segments[1].toLowerCase().endsWith('.md')) {
        sawUserNote = true
        continue
      }

      // sessions/<sessionId>/ai-todo.md — the session id is the directory name.
      if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'ai-todo.md') {
        const sessionId = segments[1]
        if (sessionId && !seenSessions.has(sessionId)) {
          seenSessions.add(sessionId)
          payloads.push({ scope: 'session-ai-todo', sessionId })
        }
      }
    }

    // User notes are global, so one refresh covers every panel.
    if (sawUserNote) payloads.push({ scope: 'global-user' })
    return payloads
  }
}
