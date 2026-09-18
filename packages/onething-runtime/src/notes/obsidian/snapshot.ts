/**
 * 每个库一份「上次看到的配置」。
 *
 * 存在的理由是**后台不许拉起 Obsidian**:AI 要知道今天的日记在哪、附件该往哪
 * 放,而这些答案的产地是 Obsidian 自己的配置。Obsidian 活着时每读一次就顺手写
 * 一份快照;它没跑时我们用快照复现同样的三条语义,并且如实告诉调用方
 * 「这是降级读数」(`NoteVault.degraded`)。
 *
 * 落点 `<store>/notes/obsidian/<id>.json`。store 根**经注入**,这个文件不 import
 * 存储路径模块 —— 08-18 C1 事故的判例:模块级根让一条单测打在了用户真实的
 * `~/.onething` 上。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ObsidianVaultSnapshot {
  /** daily-notes 插件的文件夹(vault 相对);插件没开就是 `''`。 */
  dailyFolder: string
  dailyFormat: string
  dailyTemplate?: string
  /** 四种语义见 `scripts.ts` 的 `ObsidianVaultConfigRead`。 */
  attachmentFolderPath: string
  useMarkdownLinks: boolean
  /** `'shortest' | 'relative' | 'absolute'`。 */
  newLinkFormat: string
  capturedAt: number
}

export interface SnapshotStore {
  read(vaultId: string): Promise<ObsidianVaultSnapshot | null>
  write(vaultId: string, snapshot: ObsidianVaultSnapshot): Promise<void>
}

export interface FileSnapshotStoreLogger {
  warn(message: string, fields?: Record<string, unknown>, error?: unknown): void
}

/**
 * 文件形态的快照库。
 *
 * **读坏了当没有**(返回 `null`),不抛:一份坏掉的快照不该让「Obsidian 没跑」
 * 这件本来就降级的事变成一次崩溃。写失败只记 warn —— 快照是缓存,不是账本。
 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(
    /** `<store>/notes/obsidian` 的绝对路径,由装配层给。 */
    private readonly directory: string,
    private readonly logger?: FileSnapshotStoreLogger,
  ) {}

  private fileFor(vaultId: string): string {
    // 库 id 是 `obsidian.json` 的键(16 位 hex),但名册是外部文件 —— 不许让它
    // 决定我们写到哪个目录去。非 `[A-Za-z0-9_-]` 一律折成 `_`。
    const safe = vaultId.replace(/[^A-Za-z0-9_-]/g, '_')
    return path.join(this.directory, `${safe}.json`)
  }

  async read(vaultId: string): Promise<ObsidianVaultSnapshot | null> {
    try {
      const raw = await fs.readFile(this.fileFor(vaultId), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ObsidianVaultSnapshot>
      if (typeof parsed?.capturedAt !== 'number') return null
      return {
        dailyFolder: typeof parsed.dailyFolder === 'string' ? parsed.dailyFolder : '',
        dailyFormat: typeof parsed.dailyFormat === 'string' && parsed.dailyFormat ? parsed.dailyFormat : 'YYYY-MM-DD',
        dailyTemplate: typeof parsed.dailyTemplate === 'string' ? parsed.dailyTemplate : undefined,
        attachmentFolderPath: typeof parsed.attachmentFolderPath === 'string' ? parsed.attachmentFolderPath : '',
        useMarkdownLinks: parsed.useMarkdownLinks === true,
        newLinkFormat: typeof parsed.newLinkFormat === 'string' ? parsed.newLinkFormat : 'shortest',
        capturedAt: parsed.capturedAt,
      }
    } catch {
      return null
    }
  }

  async write(vaultId: string, snapshot: ObsidianVaultSnapshot): Promise<void> {
    const file = this.fileFor(vaultId)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8')
    } catch (error) {
      this.logger?.warn('writing the obsidian vault snapshot failed', { vaultId }, error)
    }
  }
}

/** 进程内的快照库 —— 单测与 `--dry-run` 用,不落盘。 */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly entries = new Map<string, ObsidianVaultSnapshot>()

  async read(vaultId: string): Promise<ObsidianVaultSnapshot | null> {
    return this.entries.get(vaultId) ?? null
  }

  async write(vaultId: string, snapshot: ObsidianVaultSnapshot): Promise<void> {
    this.entries.set(vaultId, snapshot)
  }
}
