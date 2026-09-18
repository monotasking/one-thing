/**
 * 「这个名字是库里的哪个文件」—— 一份递归的 basename 索引。
 *
 * 两个用处:`FolderVault` 的 `resolveByName`(它没有别的办法),以及
 * `ObsidianVault` 在**降级态**下的同一个问题(Obsidian 活着时那个答案问
 * `metadataCache` 更准,因为它还认别名)。所以它住在领域根,不住任何一个驱动
 * 的目录里。
 *
 * 两道闸:TTL(缺省 30s)与条目上限(缺省 2 万)。没有上限的话一个 30 万文件的
 * 盘会把一次「解析一个链接」变成一次全盘遍历 + 几十 MB 常驻。
 */

import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'

/**
 * 显式跳过的目录。
 *
 * **点开头的一律跳**(下面 `dirent.name.startsWith('.')` 那一句),所以 `.git` /
 * `.obsidian` / `.trash` 不用也不该列在这里 —— 列了就是在领域根点某个驱动的名字。
 * 剩下这一条不是点开头的。
 */
const SKIP_DIRECTORIES = new Set(['node_modules'])

export interface BasenameIndexOptions {
  ttlMs?: number
  maxEntries?: number
  /** 只收这些扩展名(带点,小写)。缺省只收 markdown。 */
  extensions?: readonly string[]
}

export class BasenameIndex {
  private entries: Map<string, string[]> | null = null
  private builtAt = 0
  private building: Promise<Map<string, string[]>> | null = null

  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly extensions: readonly string[]

  constructor(private readonly root: string, options: BasenameIndexOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.maxEntries = options.maxEntries ?? 20_000
    this.extensions = options.extensions ?? ['.md']
  }

  /**
   * 解析一个名字 → 绝对路径。
   *
   * `name` 可以带扩展名、可以是一段相对路径(`folder/note` / `folder/note.md`)。
   * 多个同名文件时:**离 `sourceDoc` 最近的那个赢** —— 与 Obsidian wikilink 的
   * 「最短路径」直觉一致,而且是确定的。
   */
  async resolve(name: string, sourceDoc?: string): Promise<string | null> {
    const index = await this.ensure()
    const candidates = index.get(normalizeKey(name))
    if (!candidates || candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]
    const from = sourceDoc ? path.dirname(path.resolve(this.root, sourceDoc)) : this.root
    return [...candidates].sort((a, b) => distance(from, a) - distance(from, b) || a.localeCompare(b))[0]
  }

  /**
   * 全部条目(绝对路径)。`listNotes` 的降级实现用它。
   *
   * **必须去重**:一个文件在索引里挂着最多四把钥匙(`note` / `note.md` /
   * `folder/note` / `folder/note.md`),摊平之后同一个路径会出现好几次。
   */
  async all(): Promise<string[]> {
    const index = await this.ensure()
    return [...new Set([...index.values()].flat())].sort()
  }

  invalidate(): void {
    this.entries = null
    this.builtAt = 0
  }

  private async ensure(): Promise<Map<string, string[]>> {
    const fresh = this.entries !== null && Date.now() - this.builtAt < this.ttlMs
    if (fresh && this.entries) return this.entries
    // 并发调用共用同一次遍历 —— 一个回合里 AI 连问五个链接不该扫五遍盘。
    this.building ??= this.build().finally(() => { this.building = null })
    return this.building
  }

  private async build(): Promise<Map<string, string[]>> {
    const index = new Map<string, string[]>()
    let count = 0
    const walk = async (dir: string): Promise<void> => {
      if (count >= this.maxEntries) return
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return // 权限不足 / 目录刚被删:跳过,不是错误。
      }
      for (const dirent of dirents) {
        if (count >= this.maxEntries) return
        const full = path.join(dir, dirent.name)
        if (dirent.isDirectory()) {
          if (SKIP_DIRECTORIES.has(dirent.name) || dirent.name.startsWith('.')) continue
          await walk(full)
          continue
        }
        if (!dirent.isFile()) continue
        if (!this.extensions.includes(path.extname(dirent.name).toLowerCase())) continue
        count += 1
        // 三把钥匙都指向同一个文件:`note`、`note.md`、`folder/note`。
        const relative = path.relative(this.root, full)
        for (const key of keysFor(dirent.name, relative)) {
          const bucket = index.get(key)
          if (bucket) bucket.push(full)
          else index.set(key, [full])
        }
      }
    }
    await walk(this.root)
    this.entries = index
    this.builtAt = Date.now()
    return index
  }
}

function keysFor(fileName: string, relativePath: string): string[] {
  const stem = fileName.slice(0, fileName.length - path.extname(fileName).length)
  const relativeStem = relativePath.slice(0, relativePath.length - path.extname(relativePath).length)
  return [...new Set([
    normalizeKey(fileName),
    normalizeKey(stem),
    normalizeKey(relativePath),
    normalizeKey(relativeStem),
  ])]
}

function normalizeKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase()
}

/** 「离得多近」= 从 `from` 走到那个文件要跨几层目录。 */
function distance(from: string, target: string): number {
  const relative = path.relative(from, path.dirname(target))
  if (relative === '') return 0
  return relative.split(path.sep).length
}
