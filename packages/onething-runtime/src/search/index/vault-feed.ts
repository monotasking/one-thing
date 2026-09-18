/**
 * `VaultFeed` —— 一个笔记库这一个来源。
 *
 * 设计:`docs/design/notes-obsidian-cli-2026-09.md` §4.1(P2)/
 * `docs/design/search-index-2026-09.md` §5.2b ——「**加一种来源 = 加一个 feed,
 * 索引服务与倒排一字不改**」。
 *
 * 它是 `DailyNotesFeed`(S3b)的替身,两处不同:
 *
 *  ① **递归**。从前那把 feed 只认笔记根目录下**平铺的那一层**,因为它说的是
 *     「每日笔记那个目录」;今天说的是「一个笔记库」,而库是一棵树。跳过点开头
 *     的目录(`.obsidian` / `.trash` / `.git` 自然都在里面)与 `node_modules`;
 *  ② **facets 多两格**:`vault`(哪个库 —— 库表是能力自述里那张 enum)与
 *     `daily`(这篇是不是日记文件夹里的)。两格都是**数据**:能力按它们过滤,
 *     `packages/core/search` 一个字都不认识它们。
 *
 * key = 库相对路径(**posix 分隔符**,见 `toKey`),`fingerprint` = `mtimeMs:size`,
 * `documentsOf` = 一个文件一份文档(`fields: { title, content }`,title 取文件名
 * 去掉扩展名)。`policy.build` 仍取 `lazy`:笔记不是产品主路,首次查询再建就够了。
 *
 * **这个文件不认识 Obsidian**,也不认识 `NoteVault`:它收的是三格纯数据
 * (`vaultId` / `root` / `dailyFolder`),由装配从笔记领域算好递进来。理由是它住在
 * Worker 那条线程里 —— 那边没有笔记领域的注册表,也不该有(领域里有会去问 app 的
 * 方法,而这条线程是后台路,一条命令都不许发)。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DocPayload, DocumentFeed, FeedPolicy } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import {
  DIRECTORY_POLL_INTERVAL_MS,
  DIRECTORY_WATCH_DEBOUNCE_MS,
} from './ledger-feed.js'

const log = getLogger('search.index.vault-feed')

/** 这一类的能力 id。feed 与能力是同一件事的两半,所以这个常量住这里。 */
export const DEFAULT_NOTES_CAPABILITY = 'notes'

/** feed id 的前缀:一个库一把 feed,id = `vault:<vaultId>`。 */
export const VAULT_FEED_ID_PREFIX = 'vault:'

/** 认哪些扩展名。数据一行,不是 `if`。 */
export const DEFAULT_NOTE_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt']

/**
 * 不下去的目录。点开头的那一族由 `isSkippedDirectory` 统一判(`.obsidian` /
 * `.trash` / `.git` 都在里面),这张表只列**不以点开头**的那几个。
 */
export const SKIPPED_VAULT_DIRECTORIES: readonly string[] = ['node_modules']

/** 一把 feed 认哪个库。三格纯数据 —— 见文件头「这个文件不认识 Obsidian」。 */
export interface VaultFeedSpec {
  /** 库 id。`vault` facet 写的就是它,能力自述里的 enum 值也是它。 */
  id: string
  /** 库根(绝对路径)。 */
  root: string
  /**
   * 日记文件夹(库相对路径,posix 分隔符)。缺席 = 这个库答不出日记落点
   * (没有快照的 Obsidian 库),于是每一篇的 `daily` facet 都是 `false`。
   *
   * 空串 = 日记就落在库根。
   */
  dailyFolder?: string
}

export interface VaultFeedOptions extends VaultFeedSpec {
  /** feed id。缺省 `vault:<id>`。 */
  feedId?: string
  capability?: string
  extensions?: readonly string[]
  policy?: FeedPolicy
}

export function vaultFeedIdOf(vaultId: string): string {
  return `${VAULT_FEED_ID_PREFIX}${vaultId}`
}

/** 点开头的目录一律不下去 —— `.obsidian` / `.trash` / `.git` 都是它捞的。 */
function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_VAULT_DIRECTORIES.includes(name)
}

/** 库相对路径的**规范形**:posix 分隔符。key 与 `dailyFolder` 都走它。 */
function toKey(relative: string): string {
  return relative.split(path.sep).join('/')
}

export class VaultFeed implements DocumentFeed<string> {
  readonly id: string
  readonly capabilities: string[]
  readonly policy: FeedPolicy

  private readonly vaultId: string
  private readonly root: string
  private readonly dailyFolder: string | undefined
  private readonly capability: string
  private readonly extensions: readonly string[]

  constructor(options: VaultFeedOptions) {
    this.vaultId = options.id
    this.id = options.feedId ?? vaultFeedIdOf(options.id)
    this.root = options.root
    this.dailyFolder = options.dailyFolder === undefined
      ? undefined
      : toKey(options.dailyFolder).replace(/^\/+|\/+$/g, '')
    this.capability = options.capability ?? DEFAULT_NOTES_CAPABILITY
    this.extensions = options.extensions ?? DEFAULT_NOTE_EXTENSIONS
    this.capabilities = [this.capability]
    this.policy = options.policy ?? { build: 'lazy' }
  }

  /**
   * 整棵树。**深度优先、同步 readdir**:这只迭代器跑在 Worker 里,那条线程上没有
   * 别人等着,而一次 `readdirSync` 比一次 `await` 便宜得多(1032 文件的真库实测
   * 见报告)。目录读不动(权限 / 刚被删)就跳过那一枝,不把整把 feed 弄红。
   */
  async *keys(): AsyncIterable<string> {
    const stack: string[] = ['']
    while (stack.length > 0) {
      const relative = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(path.join(this.root, relative), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const childRelative = relative === '' ? entry.name : `${relative}${path.sep}${entry.name}`
        if (entry.isDirectory()) {
          if (isSkippedDirectory(entry.name)) continue
          stack.push(childRelative)
          continue
        }
        if (!entry.isFile()) continue
        if (!this.extensions.includes(path.extname(entry.name).toLowerCase())) continue
        yield toKey(childRelative)
      }
    }
  }

  fingerprint(key: string): string | undefined {
    try {
      const stat = fs.statSync(this.absoluteOf(key))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return undefined
    }
  }

  async *documentsOf(key: string): AsyncIterable<DocPayload> {
    const filePath = this.absoluteOf(key)
    let content: string
    let time = 0
    try {
      content = fs.readFileSync(filePath, 'utf-8')
      time = fs.statSync(filePath).mtimeMs
    } catch {
      return
    }
    yield {
      capability: this.capability,
      key,
      time,
      facets: {
        // `path` 是**绝对路径**(S3b 定的):壳拿到一条笔记结果之后要去打开那个
        // 文件,而相对名相对的是这把 feed 自己的库根 —— 一台机器上有好几个库,
        // 相对名就打不开了。key 仍是相对名(整键替换的粒度),两者各司其职。
        path: filePath,
        time,
        vault: this.vaultId,
        daily: this.isDaily(key),
      },
      fields: { title: path.basename(key, path.extname(key)), content },
    }
  }

  /**
   * 这篇是不是日记。
   *
   * 判据是**所在目录与日记文件夹逐字相等**,不是前缀:日记文件夹里是一层平铺的
   * 日期文件,而前缀判会把 `Journal/归档/2024/…` 这种「从日记文件夹里搬出来的
   * 旧账」也算成日记。`dailyFolder` 是空串(日记落在库根)时,库根那一层为真、
   * 子目录为假 —— 同一句话,不需要第二个分支。
   */
  private isDaily(key: string): boolean {
    if (this.dailyFolder === undefined) return false
    const at = key.lastIndexOf('/')
    return (at < 0 ? '' : key.slice(0, at)) === this.dailyFolder
  }

  private absoluteOf(key: string): string {
    return path.join(this.root, ...key.split('/'))
  }

  /**
   * 与 `LedgerFeed` 同款的目录监视:去抖 500ms,`fs.watch` 抛出就降级成 30s 轮询
   * 并记 warn。**降级要说出来**,不装成实时。
   *
   * 这里 `recursive: true`(`DailyNotesFeed` 那时是 `false`,因为它只认平铺的一层)。
   * macOS / Windows 原生支持;Linux 的 `fs.watch` 递归在部分 Node 版本上直接抛
   * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` —— 那一抛正好落进下面的 catch,于是那台
   * 机器走轮询。**不去猜平台**:让运行时自己说。
   */
  subscribe(onChange: (key: string, hint?: unknown) => void): () => void {
    const pending = new Map<string, NodeJS.Timeout>()
    const schedule = (key: string): void => {
      const existing = pending.get(key)
      if (existing !== undefined) clearTimeout(existing)
      pending.set(key, setTimeout(() => {
        pending.delete(key)
        onChange(key)
      }, DIRECTORY_WATCH_DEBOUNCE_MS))
    }

    let watcher: fs.FSWatcher | undefined
    try {
      watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (typeof filename !== 'string' || filename.length === 0) return
        if (!this.extensions.includes(path.extname(filename).toLowerCase())) return
        const key = toKey(filename)
        if (key.split('/').slice(0, -1).some(isSkippedDirectory)) return
        schedule(key)
      })
    } catch (error) {
      log.warn('vault watch unavailable; falling back to mtime polling', {
        fields: { vault: this.vaultId },
        err: error,
      })
    }

    let poller: NodeJS.Timeout | undefined
    if (watcher === undefined) {
      const seen = new Map<string, string>()
      poller = setInterval(() => {
        void (async () => {
          for await (const key of this.keys()) {
            const fingerprint = this.fingerprint(key)
            if (fingerprint === undefined) continue
            if (seen.get(key) !== fingerprint) {
              seen.set(key, fingerprint)
              onChange(key)
            }
          }
        })()
      }, DIRECTORY_POLL_INTERVAL_MS)
      poller.unref?.()
    }

    return () => {
      watcher?.close()
      if (poller !== undefined) clearInterval(poller)
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }
}
