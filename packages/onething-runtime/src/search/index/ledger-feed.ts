/**
 * `LedgerFeed` —— 账本这一个来源。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2b(`DocumentFeed`)+ §5.2 最后两段
 * (改名 / 归档 / 删除不经账本,拍点甲 b)+ §5.3(增量挂在同步观察者上)。
 *
 * key = sessionId。三件事:
 *
 * - **`fingerprint(id)` = `${lastSeq}:${metaMtimeMs}`**。`lastSeq` 读**文件尾**
 *   一行(`stat` 拿大小 + 尾读一小段),不读整份 —— 一条 480MB 的账本上「变没变」
 *   这个问题不该花一次全文件读。`metaMtimeMs` 认改名与归档(那两件事只改
 *   `meta.json`,账本一个字节都不动)。目录不在 → `undefined` = 墓碑,而删会话
 *   正是 `rmSync` 整个目录 —— 这就是拍点甲选 (b) 的理由:`session/deleted` 要写进
 *   的那本账自己已经没了。
 * - **`documentsOf(id)`** = 整份 `events.jsonl` 经 `IndexProjector` 折出全部文档
 *   (冷路径,整键替换、幂等)。
 * - **`subscribe`** 挂三样(§5.2 原文):进程内 append 观察者(毫秒级,由装配层
 *   注入 —— runtime 不许 import backend)、总线的 `session:renamed` / `deleted`
 *   (同样注入)、以及 `sessions/` 目录的 `fs.watch` 去抖 500ms,**为了另一个进程
 *   写的账本**。三样都只喊一声 key,不带内容。目录监视那一样在去抖之后还过一道
 *   尾读:这一批新记录里没有一条会改文档(`affectsIndexedDocuments`,判据住投影
 *   器)就不喊 —— 流式回复的 delta 全在这一档里,重折一遍是纯白做工。
 *
 * **为什么注入而不是直接挂**:`registerSessionLogEventAppendObserver` 与总线都住
 * `packages/backend`,而 runtime 不许 import 装配层(边界检查器守)。所以这里收
 * 两个 `(cb) => () => void` 形状的适配器,S3b 在装配时把真的接上;测试里传假的。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DocPayload, DocumentFeed, FeedPolicy } from '@onething/core/search'
import type { SessionLogEventRecord } from '@onething/core/session'
import { parseSessionLogEventLog } from '@onething/core/session'

import { getLogger } from '../../logging/index.js'
import type { SessionMetaSnapshot } from './projector.js'
import { IndexProjector, affectsIndexedDocuments } from './projector.js'

const log = getLogger('search.index.ledger-feed')

export const LEDGER_FEED_ID = 'ledger'

/** 目录监视的去抖窗口(§5.2「`fs.watch`,去抖 500ms」)。 */
export const DIRECTORY_WATCH_DEBOUNCE_MS = 500

/** `fs.watch` 抛出时的降级:每 30s 扫一遍 mtime。 */
export const DIRECTORY_POLL_INTERVAL_MS = 30_000

/** 尾读多少字节去找最后一行(一条事件行远小于此;不够就再翻一倍,最多两次)。 */
const TAIL_READ_BYTES = 64 * 1024

export type SubscribeAdapter = (onChange: (sessionId: string) => void) => () => void

export interface LedgerFeedOptions {
  /** `<store>/sessions` 目录。 */
  sessionsDir: string
  projector?: IndexProjector
  /**
   * 进程内 append 观察者(§5.3)。S3b 用
   * `registerSessionLogEventAppendObserver` 接;不注入 = 只剩目录监视那条路
   * (慢 ~1s,不是错)。
   */
  subscribeAppend?: SubscribeAdapter
  /** 总线的 `session:renamed` / `session:deleted`。同上,注入。 */
  subscribeMeta?: SubscribeAdapter
  capabilities?: readonly string[]
  policy?: FeedPolicy
}

export class LedgerFeed implements DocumentFeed<string> {
  readonly id = LEDGER_FEED_ID
  readonly capabilities: string[]
  readonly policy: FeedPolicy

  private readonly sessionsDir: string
  private readonly projector: IndexProjector
  private readonly subscribeAppend: SubscribeAdapter | undefined
  private readonly subscribeMeta: SubscribeAdapter | undefined

  constructor(options: LedgerFeedOptions) {
    this.sessionsDir = options.sessionsDir
    this.projector = options.projector ?? new IndexProjector()
    this.subscribeAppend = options.subscribeAppend
    this.subscribeMeta = options.subscribeMeta
    this.capabilities = [...(options.capabilities ?? ['messages', 'chats'])]
    // 账本是 eager:它是产品的主路,不该等到第一次查询才建(§5.2b 那张表)。
    this.policy = options.policy ?? { build: 'eager' }
  }

  // ---- 枚举 -------------------------------------------------------------

  async *keys(): AsyncIterable<string> {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // `legacy-backup/` 之类的旁路目录没有账本,天然被这一条挡住。
      if (!fs.existsSync(path.join(this.sessionsDir, entry.name, 'events.jsonl'))) continue
      yield entry.name
    }
  }

  // ---- 指纹 -------------------------------------------------------------

  /** `${lastSeq}:${metaMtimeMs}`;`undefined` = 这把钥匙不存在了(墓碑)。 */
  fingerprint(sessionId: string): string | undefined {
    const dir = path.join(this.sessionsDir, sessionId)
    let logStat: fs.Stats
    try {
      logStat = fs.statSync(path.join(dir, 'events.jsonl'))
    } catch {
      return undefined
    }
    const lastSeq = readLastSeq(path.join(dir, 'events.jsonl'), logStat.size)
    let metaMtime = 0
    try {
      metaMtime = fs.statSync(path.join(dir, 'meta.json')).mtimeMs
    } catch {
      // 没有 meta.json 的会话(刚建、还没落盘)照样有账本;指纹用 0 占位,
      // meta 一落盘 mtime 就变、指纹就变。
    }
    return `${lastSeq}:${metaMtime}`
  }

  // ---- 折 ---------------------------------------------------------------

  async *documentsOf(sessionId: string): AsyncIterable<DocPayload> {
    const dir = path.join(this.sessionsDir, sessionId)
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8')
    } catch {
      return
    }
    const events: readonly SessionLogEventRecord[] = parseSessionLogEventLog(text)
    const meta = readSessionMeta(path.join(dir, 'meta.json'))
    for (const doc of this.projector.project({ sessionId, events, meta })) yield doc
  }

  // ---- 订阅 -------------------------------------------------------------

  subscribe(onChange: (key: string, hint?: unknown) => void): () => void {
    const disposers: Array<() => void> = []
    if (this.subscribeAppend !== undefined) disposers.push(this.subscribeAppend(key => onChange(key)))
    if (this.subscribeMeta !== undefined) disposers.push(this.subscribeMeta(key => onChange(key)))
    disposers.push(this.watchDirectory(onChange))
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          log.warn('ledger feed unsubscribe failed', { err: error })
        }
      }
    }
  }

  /**
   * 目录监视 —— **为了另一个进程写的账本**(§5.2 / §5.6)。
   *
   * **设计 §5.2 写的是 `{ recursive: false }`,实测不成立,S3a 改成 `true`。**
   * 账本住 `sessions/<id>/events.jsonl`,而非递归的 `fs.watch` 在 macOS 上走 kqueue,
   * 只报**这一层目录条目**的增删改名,子目录里某个文件被写了它一声不吭 ——
   * 「另一个进程 append 的消息 500ms 内被折进来」那条用例在非递归下等到超时都不响
   * (真跑出来的读数,不是推理)。递归监视在三个平台上 Node ≥ 20 都有,而仓里的
   * 地板是 22.13,所以直接用它;抛出了退回非递归(至少还认得「会话目录被删了」),
   * 再抛就降级成每 30s 扫一遍 mtime。**每一档降级都记一条 warn** —— 不装成实时。
   *
   * **去抖之后还有一道尾读**(S3b 第二轮):监视器只知道「这条会话动了」,而
   * 「动了」里绝大多数是流式回复的 `assistant/chunks` —— 折出来的文档逐字不变,
   * 重折一遍是纯白做工(与观察者那条路同一个病,判据同一张表,见 `projector.ts`
   * 的 `INDEX_DOCUMENT_EFFECTS`)。所以这里从上次判过的 `seq` 起**只读尾巴**,把
   * 这一批新记录解出来问一句 `affectsIndexedDocuments`,全是 `false` 就不喊。
   *
   * 三种「问不出来」一律**照喊**(宁可白折一次,不肯漏一条):账本不在了(墓碑)、
   * 这把钥匙第一次见(基线未知)、账本没长(那就是 `meta.json` 动了 = 改名 / 归档,
   * 指纹的后半格)。尾读窗口够不到上次那一格时同理。
   */
  private watchDirectory(onChange: (key: string) => void): () => void {
    const pending = new Map<string, NodeJS.Timeout>()
    /** 上一次判过的账本 `seq` —— 尾读的起点。 */
    const judged = new Map<string, number>()
    const schedule = (key: string): void => {
      const existing = pending.get(key)
      if (existing !== undefined) clearTimeout(existing)
      pending.set(key, setTimeout(() => {
        pending.delete(key)
        if (this.batchAffectsDocuments(key, judged)) onChange(key)
      }, DIRECTORY_WATCH_DEBOUNCE_MS))
    }

    const onEntry = (_event: string, filename: string | Buffer | null): void => {
      if (typeof filename !== 'string' || filename.length === 0) return
      // 冒上来的是 `<id>` 或 `<id>/events.jsonl`(递归档),取第一段。
      const key = filename.split(path.sep)[0]!
      if (key.length > 0) schedule(key)
    }

    let watcher: fs.FSWatcher | undefined
    for (const recursive of [true, false]) {
      try {
        watcher = fs.watch(this.sessionsDir, { recursive }, onEntry)
        if (!recursive) {
          log.warn('recursive sessions dir watch unavailable; only directory-level changes are seen')
        }
        break
      } catch (error) {
        if (!recursive) log.warn('sessions dir watch unavailable; falling back to mtime polling', { err: error })
      }
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
      judged.clear()
    }
  }

  /**
   * 这一批(去抖窗口里攒下的)新记录里,有没有一条会改文档。
   *
   * 判据全在 `affectsIndexedDocuments`(住投影器)—— 这个方法只负责**把新记录拿
   * 到手**:从上次判过的 `seq` 起尾读一段,解出来的行按 `seq` 筛。窗口够不到上次
   * 那一格(一次去抖里涌进来的行超过 256KB)就答 `true`,不猜。
   */
  private batchAffectsDocuments(key: string, judged: Map<string, number>): boolean {
    const logPath = path.join(this.sessionsDir, key, 'events.jsonl')
    let size: number
    try {
      size = fs.statSync(logPath).size
    } catch {
      // 账本没了 = 墓碑那一路,必须喊(`fingerprint` 会答 undefined)。
      judged.delete(key)
      return true
    }
    const previous = judged.get(key)
    const lastSeq = readLastSeq(logPath, size)
    judged.set(key, lastSeq)
    // 第一次见这把钥匙:基线未知,照喊。
    if (previous === undefined) return true
    // 账本没长 —— 动的是 `meta.json`(改名 / 归档),照喊。
    if (lastSeq <= previous) return true
    const tail = readRecordsAfter(logPath, size, previous)
    if (!tail.complete) return true
    return tail.records.some(record => affectsIndexedDocuments(record))
  }
}

// ---- 纯函数 -------------------------------------------------------------

/**
 * 账本最后一行的 `seq`,**不读整份文件**:从尾巴上取一段,找最后一条解得开的行。
 *
 * 与 `projection-cache.ts` 那条边界同一条理由 —— 「不在写路径上读整文件」。指纹是
 * 每次校对每把钥匙都要问一遍的东西,读整份 480MB 的账本去回答「变没变」,那道门
 * 自己就是病。
 */
export function readLastSeq(filePath: string, size: number): number {
  if (size === 0) return 0
  let handle: number | undefined
  try {
    handle = fs.openSync(filePath, 'r')
    for (const window of [TAIL_READ_BYTES, TAIL_READ_BYTES * 4]) {
      const length = Math.min(window, size)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, size - length)
      const records = parseSessionLogEventLog(buffer.toString('utf-8'))
      const last = records[records.length - 1]
      if (last !== undefined) return last.seq
      if (length === size) return 0
    }
    return 0
  } catch {
    return 0
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

/**
 * 账本上 `seq > afterSeq` 的那些记录,**从尾巴上读**。
 *
 * `complete` 说的是「这一段真的盖住了 `afterSeq` 之后的全部行」:窗口里最早那条
 * 的 `seq` 已经 ≤ `afterSeq`(或者干脆整份文件都读进来了)才算盖住。盖不住时调用
 * 方按「不知道」办 —— 与 `readLastSeq` 同一条边界:绝不为了回答一个问题去读一份
 * 480MB 的账本。
 */
export function readRecordsAfter(
  filePath: string,
  size: number,
  afterSeq: number,
): { records: SessionLogEventRecord[]; complete: boolean } {
  if (size === 0) return { records: [], complete: true }
  let handle: number | undefined
  try {
    handle = fs.openSync(filePath, 'r')
    for (const window of [TAIL_READ_BYTES, TAIL_READ_BYTES * 4]) {
      const length = Math.min(window, size)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, size - length)
      const parsed = parseSessionLogEventLog(buffer.toString('utf-8'))
      const first = parsed[0]
      // 整份文件都在手里,或者窗口第一条已经在 afterSeq 之前 —— 都算盖住了。
      if (!(length === size || (first !== undefined && first.seq <= afterSeq))) continue
      return { records: parsed.filter(record => record.seq > afterSeq), complete: true }
    }
    return { records: [], complete: false }
  } catch {
    return { records: [], complete: false }
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

/** `meta.json` 里索引要用的那几格。读不出来 = 没有(不猜)。 */
export function readSessionMeta(metaPath: string): SessionMetaSnapshot | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    return {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.workspaceId === 'string' ? { workspaceId: raw.workspaceId } : {}),
      ...(typeof raw.isArchived === 'boolean' ? { isArchived: raw.isArchived } : {}),
      ...(typeof raw.createdAt === 'number' ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
    }
  } catch {
    return undefined
  }
}
