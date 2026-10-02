import {
  getGatewayDataPath,
  readGatewayJsonFile,
  writeGatewayJsonFile,
} from '../storage.js'

export interface AllowlistConfig {
  mode: 'open' | 'strict'
  ids?: string[]
}

interface AllowlistFile {
  mode: 'open' | 'strict'
  ids: string[]
}

const DEFAULT_ALLOWLIST_PATH = getGatewayDataPath('allowlist.json')

export class Allowlist {
  private mode: 'open' | 'strict'
  private readonly ids: Set<string>

  constructor(
    config: AllowlistConfig = { mode: 'open' },
    private readonly filePath = DEFAULT_ALLOWLIST_PATH,
  ) {
    const saved = readGatewayJsonFile<AllowlistFile | null>(filePath, null)
    this.mode = config.mode ?? saved?.mode ?? 'open'
    this.ids = new Set(config.ids ?? saved?.ids ?? [])
  }

  check(userId: string): boolean {
    if (this.mode === 'open') return true
    return this.ids.has(userId)
  }

  add(userId: string): void {
    this.ids.add(userId)
    this.persist()
  }

  remove(userId: string): void {
    this.ids.delete(userId)
    this.persist()
  }

  toJSON(): AllowlistFile {
    return {
      mode: this.mode,
      ids: [...this.ids].sort(),
    }
  }

  private persist(): void {
    writeGatewayJsonFile(this.filePath, this.toJSON())
  }
}
