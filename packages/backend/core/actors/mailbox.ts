/**
 * Actor 持久 mailbox(docs/design/collab-actor-v3.md §1.2 / §3)。
 *
 * 三面纪律里,mailbox 横跨「转录」与「账」两面:
 * - `<name>.jsonl` 是**转录**:只追加,永不改写,崩溃后靠合法前缀自愈。
 * - `<name>.cursor` 是**账**:同步原子写,先于下一步动作落盘。
 *
 * 交付语义 = **at-least-once + 消费端幂等**:
 * 1. 游标只在 `ack()` 时前进 —— 处理到一半崩了,那一批重启后原样重投;
 * 2. 已 ack 的事件 id 进一个有界窗口**跟着游标一起落盘** —— 同一封信被上游
 *    重投(补水、跨房转投、重启广播)时,即使跨了进程边界也只会被消费一次。
 *
 * 为什么窗口里只记**已 ack** 的 id:如果把「已投递」的也记进去,崩溃重启后那批
 * 未 ack 的事件会被自己的去重窗口挡住 —— 重投语义当场作废。两个性质靠这一条
 * 边界同时成立:未 ack 的重投得来,已 ack 的重投进不来。
 *
 * 行编解码直接复用会话 jsonl 的编解码器(`session/storage/jsonl/codec.ts`),
 * 连同它已经测过的崩溃恢复语义:尾部截断行静默丢弃、seq 断序视为损坏点并丢弃
 * 其后全部。代价是 header 里那个字段叫 `sessionId` —— 在邮箱语境里它装的是
 * **邮箱主人 id**。为一个字段名再造一套恢复扫描不划算,这里记一笔就够。
 */
import {
  decodeJsonlLine,
  encodeJsonlHeaderLine,
  encodeJsonlMessageLine,
  scanJsonlLog,
} from '../session/storage/jsonl/codec.js'
import {
  appendTextFile,
  ensureDirAsync,
  joinPaths,
  pathExists,
  readBinaryFile,
  readJsonFile,
  writeJsonFile,
  writeTextFileIfMissing,
} from '../storage/json-file.js'
import {
  createSeenActorEventWindow,
  DEFAULT_SEEN_ACTOR_EVENT_WINDOW,
  type ActorEvent,
  type SeenActorEventWindow,
} from './envelope.js'

/** 一次交给心智循环的积压。批内保序,`cursor` 是批尾的 seq。 */
export interface ActorMailboxBatch<TEvent> {
  events: TEvent[]
  cursor: number
}

/**
 * 心智循环看得见的 mailbox 面。
 *
 * 之所以是接口而不是直接吃 `DurableMailbox`:测试与「不需要跨重启」的房间
 * 内部通道用 `InMemoryMailbox`,ActorBase 一行都不用改。
 */
export interface ActorMailboxSource<TEvent> {
  /** 批迭代:有积压就一次全给,没有就挂起等新事件;`close()` 后正常结束。 */
  batches(): AsyncIterableIterator<ActorMailboxBatch<TEvent>>
  /** 确认消费到 `cursor`(含)。落盘之后,这些事件不会再被投递。 */
  ack(cursor: number): void | Promise<void>
  /**
   * 还没 ack 的事件数 —— 口径是「**未确认**」而不是「未交出去」。
   *
   * 差别不是措辞:交出去到 ack 之间有一段在飞窗口,用「未交出去」当口径的话,
   * `drain()` 会在这段窗口里看到「零积压」而提前返回,把还在处理的一批当成
   * 处理完了(D0 实测踩到过)。未确认口径让在飞的那一批一直算数,直到账落盘。
   */
  pendingCount(): number
  /**
   * 最旧那封**还没 ack** 的信是什么时候到的(没有积压 = undefined)。
   *
   * 可选:观测面(D8 §3.1 的 `inbox.oldestAt`)问的问题是「这个人的积压压了多久」,
   * 而 `pendingCount` 只答得出「压了多少」。两者一起才分得开「刚进来两封」与
   * 「两封在那儿躺了十分钟」——后者是一条卡死的心智循环,前者什么事都没有。
   *
   * 声明成可选而不是必选:`ActorMailboxSource` 有一堆手写替身(测试、重放),
   * 为一个纯观测的读口让它们全部红一遍,代价与收益不成比例。
   */
  oldestPendingAt?(): number | undefined
  /** 结束迭代。已经交出去的在飞批由调用方自己 drain。 */
  close(): void
}

/** 游标文件的形状。`seen` 是**已 ack** 事件 id 的有界窗口。 */
export interface ActorMailboxCursorRecord {
  v: 1
  ownerId: string
  seq: number
  at: number
  seen: string[]
}

export const ACTOR_MAILBOX_CURSOR_VERSION = 1
export const DEFAULT_ACTOR_MAILBOX_NAME = 'inbox'

export interface DurableMailboxOptions {
  /** 邮箱目录。`<name>.jsonl` 与 `<name>.cursor` 都落在这里。 */
  dir: string
  /** 邮箱主人(agent id / room id)。写进 header,重开时校验。 */
  ownerId: string
  /** 文件名前缀,默认 `inbox`。 */
  name?: string
  /** 持久去重窗口容量,默认 256。 */
  seenWindowSize?: number
  /** 注入时钟,测试用。 */
  now?: () => number
}

interface MailboxEntry<TEvent> {
  seq: number
  event: TEvent
}

/**
 * jsonl + 游标的持久 mailbox。**单消费者**:一个 agent 一个心智循环,
 * 同时开两路迭代等于把串行保证扔了,所以第二次 `batches()` 直接抛。
 */
export class DurableMailbox<TEvent extends ActorEvent = ActorEvent> implements ActorMailboxSource<TEvent> {
  readonly ownerId: string
  readonly logPath: string
  readonly cursorPath: string

  private readonly now: () => number
  private readonly seen: SeenActorEventWindow
  private readonly entries: MailboxEntry<TEvent>[]

  private nextSeq: number
  /** 已交出去的条目数(索引口径)。重启时回落到 ackedIndex —— 重投就是这么来的。 */
  private deliveredIndex: number
  private ackedIndex: number
  private ackedSeq: number

  private closed = false
  private iterating = false
  private writeChain: Promise<void> = Promise.resolve()
  private persistenceFailure: { cause: unknown } | undefined
  private waiters: Array<() => void> = []
  /** 因为已在持久窗口里而被丢掉的重投数,观测用。 */
  private duplicates = 0

  private constructor(init: {
    ownerId: string
    logPath: string
    cursorPath: string
    now: () => number
    seen: SeenActorEventWindow
    entries: MailboxEntry<TEvent>[]
    nextSeq: number
    ackedIndex: number
    ackedSeq: number
  }) {
    this.ownerId = init.ownerId
    this.logPath = init.logPath
    this.cursorPath = init.cursorPath
    this.now = init.now
    this.seen = init.seen
    this.entries = init.entries
    this.nextSeq = init.nextSeq
    this.ackedIndex = init.ackedIndex
    this.deliveredIndex = init.ackedIndex
    this.ackedSeq = init.ackedSeq
  }

  static async open<TEvent extends ActorEvent = ActorEvent>(
    options: DurableMailboxOptions,
  ): Promise<DurableMailbox<TEvent>> {
    const name = options.name ?? DEFAULT_ACTOR_MAILBOX_NAME
    const logPath = joinPaths(options.dir, `${name}.jsonl`)
    const cursorPath = joinPaths(options.dir, `${name}.cursor`)

    await ensureDirAsync(options.dir)
    await writeTextFileIfMissing(logPath, encodeJsonlHeaderLine(options.ownerId))

    const buffer = await readBinaryFile(logPath)
    const scan = scanJsonlLog<TEvent>(buffer)
    if (scan.header && scan.header.sessionId !== options.ownerId) {
      throw new Error(
        `[actor-mailbox] ${logPath} belongs to "${scan.header.sessionId}", refusing to open as "${options.ownerId}"`,
      )
    }

    const entries: MailboxEntry<TEvent>[] = scan.entries.map(entry => ({ seq: entry.seq, event: entry.message }))
    const lastSeq = entries.length ? entries[entries.length - 1].seq : 0

    const record = pathExists(cursorPath)
      ? readJsonFile<ActorMailboxCursorRecord | null>(cursorPath, null)
      : null
    // 游标可能指到日志尾巴之后:恢复扫描丢掉了断序/截断的一段。夹回合法前缀,
    // 不然 ackedIndex 会越界,而那一段本来就已经不存在了。
    const ackedSeq = Math.max(0, Math.min(record?.seq ?? 0, lastSeq))
    let ackedIndex = 0
    while (ackedIndex < entries.length && entries[ackedIndex].seq <= ackedSeq) ackedIndex += 1

    return new DurableMailbox<TEvent>({
      ownerId: options.ownerId,
      logPath,
      cursorPath,
      now: options.now ?? Date.now,
      seen: createSeenActorEventWindow(
        options.seenWindowSize ?? DEFAULT_SEEN_ACTOR_EVENT_WINDOW,
        record?.seen ?? [],
      ),
      entries,
      nextSeq: lastSeq + 1,
      ackedIndex,
      ackedSeq,
    })
  }

  /** 已 ack 到的 seq。 */
  get cursor(): number {
    return this.ackedSeq
  }

  /** 日志里的最后一条 seq。 */
  get lastSeq(): number {
    return this.nextSeq - 1
  }

  get duplicatesDropped(): number {
    return this.duplicates
  }

  /**
   * 追加一封信。
   *
   * seq 在**写链内部**才分配:一次写失败就不会消耗掉一个号,日志里也就不会留下
   * 断序空洞(恢复扫描会把空洞之后的全部丢掉 —— 那是真丢数据)。
   */
  append(event: TEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error('[actor-mailbox] append after close'))
    const task = this.writeChain.then(async () => {
      const seq = this.nextSeq
      const line = encodeJsonlMessageLine(seq, event)
      try {
        await appendTextFile(this.logPath, line)
      } catch (error) {
        this.persistenceFailure ??= { cause: error }
        throw error
      }
      this.nextSeq = seq + 1
      this.entries.push({ seq, event })
      this.wake()
    })
    // Preserve queue progress, but never turn a failed save into a successful
    // flush. A later successful append does not repair the missing event.
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /** 等待在途的追加写落盘。 */
  async flush(): Promise<void> {
    await this.writeChain
    if (this.persistenceFailure) throw this.persistenceFailure.cause
  }

  /** 未 ack 的积压(含在飞的那一批)。 */
  pendingCount(): number {
    return this.entries.length - this.ackedIndex
  }

  /** 最旧那封未 ack 的信的到达时刻。O(1) —— 游标位那一条就是它。 */
  oldestPendingAt(): number | undefined {
    return this.entries[this.ackedIndex]?.event.at
  }

  async *batches(): AsyncIterableIterator<ActorMailboxBatch<TEvent>> {
    if (this.iterating) throw new Error('[actor-mailbox] single consumer only — batches() is already running')
    this.iterating = true
    try {
      while (!this.closed) {
        if (this.deliveredIndex >= this.entries.length) {
          await this.waitForArrival()
          continue
        }

        const slice = this.entries.slice(this.deliveredIndex)
        this.deliveredIndex = this.entries.length
        const cursor = slice[slice.length - 1].seq

        const events: TEvent[] = []
        for (const entry of slice) {
          if (this.seen.has(entry.event.id)) {
            this.duplicates += 1
            continue
          }
          events.push(entry.event)
        }

        if (events.length === 0) {
          // 整批都是已 ack 过的重投:不惊动心智循环,直接把游标推过去。
          this.ack(cursor)
          continue
        }

        yield { events, cursor }
      }
    } finally {
      this.iterating = false
    }
  }

  /** 确认消费到 `cursor`(含)。同步原子写 —— 账必须先于下一步动作落盘。 */
  ack(cursor: number): void {
    if (cursor <= this.ackedSeq) return
    let index = this.ackedIndex
    while (index < this.entries.length && this.entries[index].seq <= cursor) {
      this.seen.remember(this.entries[index].event.id)
      index += 1
    }
    this.ackedIndex = index
    this.ackedSeq = cursor
    if (this.deliveredIndex < this.ackedIndex) this.deliveredIndex = this.ackedIndex
    this.persistCursor()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake()
  }

  private persistCursor(): void {
    const record: ActorMailboxCursorRecord = {
      v: ACTOR_MAILBOX_CURSOR_VERSION,
      ownerId: this.ownerId,
      seq: this.ackedSeq,
      at: this.now(),
      seen: this.seen.snapshot(),
    }
    try {
      writeJsonFile(this.cursorPath, record)
    } catch (error) {
      this.persistenceFailure ??= { cause: error }
      throw error
    }
  }

  private waitForArrival(): Promise<void> {
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private wake(): void {
    if (this.waiters.length === 0) return
    const pending = this.waiters
    this.waiters = []
    for (const resolve of pending) resolve()
  }
}

/**
 * 不落盘的 mailbox。房间内部的短命通道、以及测试用它 —— 语义与
 * `DurableMailbox` 一致(批语义、ack 推进、id 去重),只是重启后一切归零。
 */
export class InMemoryMailbox<TEvent extends ActorEvent = ActorEvent> implements ActorMailboxSource<TEvent> {
  private readonly entries: MailboxEntry<TEvent>[] = []
  private readonly seen: SeenActorEventWindow
  private nextSeq = 1
  private deliveredIndex = 0
  private ackedIndex = 0
  private ackedSeq = 0
  private closed = false
  private iterating = false
  private waiters: Array<() => void> = []
  private duplicates = 0

  constructor(options: { seenWindowSize?: number } = {}) {
    this.seen = createSeenActorEventWindow(options.seenWindowSize ?? DEFAULT_SEEN_ACTOR_EVENT_WINDOW)
  }

  get cursor(): number {
    return this.ackedSeq
  }

  get duplicatesDropped(): number {
    return this.duplicates
  }

  append(event: TEvent): Promise<void> {
    if (this.closed) return Promise.reject(new Error('[actor-mailbox] append after close'))
    this.entries.push({ seq: this.nextSeq, event })
    this.nextSeq += 1
    this.wake()
    return Promise.resolve()
  }

  /** 未 ack 的积压(含在飞的那一批)。口径同 `DurableMailbox`。 */
  pendingCount(): number {
    return this.entries.length - this.ackedIndex
  }

  /** 最旧那封未 ack 的信的到达时刻。口径同 `DurableMailbox`。 */
  oldestPendingAt(): number | undefined {
    return this.entries[this.ackedIndex]?.event.at
  }

  async *batches(): AsyncIterableIterator<ActorMailboxBatch<TEvent>> {
    if (this.iterating) throw new Error('[actor-mailbox] single consumer only — batches() is already running')
    this.iterating = true
    try {
      while (!this.closed) {
        if (this.deliveredIndex >= this.entries.length) {
          await new Promise<void>(resolve => this.waiters.push(resolve))
          continue
        }
        const slice = this.entries.slice(this.deliveredIndex)
        this.deliveredIndex = this.entries.length
        const cursor = slice[slice.length - 1].seq
        const events: TEvent[] = []
        for (const entry of slice) {
          if (this.seen.has(entry.event.id)) {
            this.duplicates += 1
            continue
          }
          events.push(entry.event)
        }
        if (events.length === 0) {
          this.ack(cursor)
          continue
        }
        yield { events, cursor }
      }
    } finally {
      this.iterating = false
    }
  }

  ack(cursor: number): void {
    if (cursor <= this.ackedSeq) return
    let index = this.ackedIndex
    while (index < this.entries.length && this.entries[index].seq <= cursor) {
      this.seen.remember(this.entries[index].event.id)
      index += 1
    }
    this.ackedIndex = index
    this.ackedSeq = cursor
    if (this.deliveredIndex < this.ackedIndex) this.deliveredIndex = this.ackedIndex
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake()
  }

  private wake(): void {
    if (this.waiters.length === 0) return
    const pending = this.waiters
    this.waiters = []
    for (const resolve of pending) resolve()
  }
}

/** 直接读一份 mailbox 日志(不开消费者)。迁移器与对账脚本要的就是这个。 */
export async function readActorMailboxLog<TEvent extends ActorEvent = ActorEvent>(
  logPath: string,
): Promise<TEvent[]> {
  if (!pathExists(logPath)) return []
  const buffer = await readBinaryFile(logPath)
  return scanJsonlLog<TEvent>(buffer).entries.map(entry => entry.message)
}

/** 只读一行 —— 排障脚本按行喂进来时用。 */
export function decodeActorMailboxLine<TEvent extends ActorEvent = ActorEvent>(line: string): TEvent | null {
  const decoded = decodeJsonlLine<TEvent>(line)
  return decoded && decoded.t === 'm' ? decoded.message : null
}
