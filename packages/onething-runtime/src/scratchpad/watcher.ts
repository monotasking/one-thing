import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { OnethingScratchpadStore, ScratchpadChangedPayload } from './store.js'

export interface OnethingScratchpadWatcherOptions {
  store: OnethingScratchpadStore
  notifyChanged: (payload: ScratchpadChangedPayload) => void
  onError?: (error: unknown) => void
}

// Coalesce the burst of events a single save produces, and give the file a
// moment to settle before consumers re-read it.
const DEBOUNCE_MS = 120

/**
 * Watches the scratchpad directory and broadcasts which session's paper
 * changed. The AI edits the paper with the ordinary write/edit tools, which
 * know nothing about the store, so nothing would tell the UI to refresh
 * without this.
 */
export class OnethingScratchpadWatcher {
  private watcher: fsSync.FSWatcher | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly changedPaths = new Set<string>()
  private watchedDirectory = ''

  constructor(private readonly options: OnethingScratchpadWatcherOptions) {}

  async start(): Promise<void> {
    const directory = this.options.store.getDirectory()
    if (this.watcher && this.watchedDirectory === directory) return
    this.stop()

    try {
      await fs.mkdir(directory, { recursive: true })
      this.watcher = fsSync.watch(directory, { persistent: false }, (_event, filename) => {
        if (!filename) return
        this.changedPaths.add(path.resolve(directory, filename.toString()))
        this.schedule()
      })
      this.watchedDirectory = directory
      this.watcher.on('error', error => this.options.onError?.(error))
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  stop(): void {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = null
    }
    this.watcher?.close()
    this.watcher = null
    this.watchedDirectory = ''
    this.changedPaths.clear()
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending)
    this.pending = setTimeout(() => {
      this.pending = null
      const paths = [...this.changedPaths]
      this.changedPaths.clear()
      for (const changed of paths) {
        // A write we made ourselves already went out through notifyChanged.
        if (this.options.store.wasSelfWrite(changed)) continue
        const name = path.basename(changed)
        if (!name.toLowerCase().endsWith('.md')) continue
        const sessionId = name.replace(/\.md$/i, '')
        if (sessionId) this.options.notifyChanged({ sessionId })
      }
    }, DEBOUNCE_MS)
  }
}
