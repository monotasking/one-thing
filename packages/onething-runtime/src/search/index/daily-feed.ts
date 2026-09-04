/**
 * `DailyNotesFeed` —— 每日笔记目录这一个来源。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2b —— 「**加一种来源 = 加一个 feed,
 * 索引服务与倒排一字不改**」。这个文件就是那句话的第二份活证据:它与 `LedgerFeed`
 * 没有任何共享代码,索引服务对两者一视同仁。
 *
 * key = 文件路径(相对笔记根目录),`fingerprint` = `mtimeMs:size`(与 §5.2b 里
 * `FileTreeFeed` 那一行同款),`documentsOf` = 一个文件一份文档
 * (`fields: { title, content }`,title 取文件名去掉扩展名)。
 *
 * `policy.build` 取 `lazy`:笔记不是产品主路,首次查询再建就够了(§5.2b 那张表
 * 「账本 eager;文件树 lazy」)。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DocPayload, DocumentFeed, FeedPolicy } from '@onething/core/search'

import { getLogger } from '../../logging/index.js'
import {
  DIRECTORY_POLL_INTERVAL_MS,
  DIRECTORY_WATCH_DEBOUNCE_MS,
} from './ledger-feed.js'

const log = getLogger('search.index.daily-feed')

export const DAILY_FEED_ID = 'daily-notes'
export const DEFAULT_DAILY_CAPABILITY = 'daily'

/** 认哪些扩展名。数据一行,不是 `if`。 */
export const DEFAULT_DAILY_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt']

export interface DailyNotesFeedOptions {
  /** 笔记根目录。不存在也不报错 —— 用户没配笔记目录是常态。 */
  notesDir: string
  /**
   * feed id。缺省 `DAILY_FEED_ID`;**同一个进程里装两个笔记目录时第二个起要另
   * 给一个**(索引服务按 id 找 feed,重名的那个永远收不到自己的钥匙)。
   */
  id?: string
  capability?: string
  extensions?: readonly string[]
  policy?: FeedPolicy
}

export class DailyNotesFeed implements DocumentFeed<string> {
  readonly id: string
  readonly capabilities: string[]
  readonly policy: FeedPolicy

  private readonly notesDir: string
  private readonly capability: string
  private readonly extensions: readonly string[]

  constructor(options: DailyNotesFeedOptions) {
    this.id = options.id ?? DAILY_FEED_ID
    this.notesDir = options.notesDir
    this.capability = options.capability ?? DEFAULT_DAILY_CAPABILITY
    this.extensions = options.extensions ?? DEFAULT_DAILY_EXTENSIONS
    this.capabilities = [this.capability]
    this.policy = options.policy ?? { build: 'lazy' }
  }

  async *keys(): AsyncIterable<string> {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.notesDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!this.extensions.includes(path.extname(entry.name).toLowerCase())) continue
      yield entry.name
    }
  }

  fingerprint(key: string): string | undefined {
    try {
      const stat = fs.statSync(path.join(this.notesDir, key))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return undefined
    }
  }

  async *documentsOf(key: string): AsyncIterable<DocPayload> {
    const filePath = path.join(this.notesDir, key)
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
      // `path` 是**绝对路径**(S3b 改;S3a 放的是 key 那个相对名):壳拿到一条
      // 笔记结果之后要去打开那个文件,而相对名相对的是这把 feed 自己的根目录 ——
      // 一台机器上可以有两个笔记根,相对名就打不开了。key 仍是相对名(整键替换
      // 的粒度),两者各司其职。
      facets: { path: filePath, time },
      fields: { title: path.basename(key, path.extname(key)), content },
    }
  }

  /**
   * 与 `LedgerFeed` 同款的目录监视:去抖 500ms,`fs.watch` 抛出就降级成 30s 轮询
   * 并记 warn。**降级要说出来**,不装成实时。
   *
   * 这里 `recursive: false` 是**对的**(账本那边不是,见 `ledger-feed.ts` 的说明):
   * 笔记是 `notesDir` 里的一层平铺文件,写它就是写这一层的目录条目,非递归的
   * kqueue / inotify 报得出来。
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
      watcher = fs.watch(this.notesDir, { recursive: false }, (_event, filename) => {
        if (typeof filename !== 'string' || filename.length === 0) return
        if (!this.extensions.includes(path.extname(filename).toLowerCase())) return
        schedule(filename)
      })
    } catch (error) {
      log.warn('daily notes dir watch unavailable; falling back to mtime polling', { err: error })
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
