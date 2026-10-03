import { ensureDir } from './json-file.js'
import type { CoreStorageProvider } from './provider.js'

export type CoreStorageDirectorySource = string[] | (() => string[])

export interface CoreFileStorageProviderOptions {
  dataDir?: string
  directories?: CoreStorageDirectorySource
}

export class CoreFileStorageProvider implements CoreStorageProvider {
  constructor(private readonly options: CoreFileStorageProviderOptions = {}) {}

  async initialize(): Promise<void> {
    const dirs = [
      ...(this.options.dataDir ? [this.options.dataDir] : []),
      ...this.resolveDirectories(),
    ]
    for (const dir of dirs) {
      ensureDir(dir)
    }
  }

  async close(): Promise<void> {
    // File-backed storage does not hold open resources.
  }

  private resolveDirectories(): string[] {
    const directories = this.options.directories
    if (!directories) return []
    return Array.isArray(directories) ? directories : directories()
  }
}
