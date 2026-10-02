/**
 * Actor 骨架:串行事件循环(docs/design/collab-actor-v3.md §1.2)。
 *
 * 「一个大脑」这条宪法在代码里就是这一个 `for await`:一次一批,批内一条一条,
 * 上一批没跑完绝不去取下一批。跨房自相矛盾从结构上消失,靠的不是提示词纪律。
 *
 * 两条容错决策写死在这里:
 * 1. **单条事件抛错不杀循环**。一个 actor 是一条长命的循环,一封坏信让它退出
 *    等于这个 agent 从此聋了。坏信进 dead-letter,循环继续。
 * 2. **dead-letter 暴露给宿主**,不只是打日志。「它没回应」和「它试过但炸了」
 *    是两个完全不同的事故,可观测性得能分开这两者。
 *
 * 循环体是**串行**的,所以 ack 也是串行的:一批处理完才 ack —— 中途崩溃,那一批
 * 重启后原样重投(mailbox 的 at-least-once 语义在这里落地)。
 */
import type { ActorEvent } from './envelope.js'
import type { ActorMailboxBatch, ActorMailboxSource } from './mailbox.js'

export interface ActorDeadLetter<TEvent> {
  event: TEvent
  error: Error
  at: number
}

export interface ActorBaseOptions<TEvent extends ActorEvent = ActorEvent> {
  /** actor 身份,进日志与 dead-letter。 */
  id: string
  mailbox: ActorMailboxSource<TEvent>
  /** dead-letter 环形容量,默认 100。满了丢最旧的。 */
  maxDeadLetters?: number
  /** 宿主观测钩子。它自己抛错不会再回灌进 dead-letter(避免自噬)。 */
  onDeadLetter?: (deadLetter: ActorDeadLetter<TEvent>) => void
  now?: () => number
}

export const DEFAULT_ACTOR_DEAD_LETTER_CAPACITY = 100

export abstract class ActorBase<TEvent extends ActorEvent = ActorEvent> {
  readonly id: string

  protected readonly mailbox: ActorMailboxSource<TEvent>

  private readonly now: () => number
  private readonly maxDeadLetters: number
  private readonly onDeadLetter?: (deadLetter: ActorDeadLetter<TEvent>) => void
  private readonly deadLetterRing: ActorDeadLetter<TEvent>[] = []
  private readonly idleWaiters: Array<() => void> = []

  private loop: Promise<void> | null = null
  private inFlight: Promise<void> | null = null
  private stopping = false
  private loopError: Error | null = null
  private processed = 0

  constructor(options: ActorBaseOptions<TEvent>) {
    this.id = options.id
    this.mailbox = options.mailbox
    this.now = options.now ?? Date.now
    this.maxDeadLetters = options.maxDeadLetters ?? DEFAULT_ACTOR_DEAD_LETTER_CAPACITY
    if (options.onDeadLetter) this.onDeadLetter = options.onDeadLetter
  }

  /** 处理一封信。抛错 = 这封信进 dead-letter,循环不受影响。 */
  protected abstract handleEvent(event: TEvent): void | Promise<void>

  get running(): boolean {
    return this.loop !== null
  }

  get processedCount(): number {
    return this.processed
  }

  get deadLetters(): readonly ActorDeadLetter<TEvent>[] {
    return [...this.deadLetterRing]
  }

  get deadLetterCount(): number {
    return this.deadLetterRing.length
  }

  /** 起循环。重复调用是幂等的。 */
  start(): void {
    if (this.loop) return
    this.stopping = false
    this.loopError = null
    this.loop = this.run().catch((error: unknown) => {
      // 循环自身炸了(mailbox 协议被违反之类)——不是一封信的问题,留给 stop() 抛。
      this.loopError = toError(error)
    })
  }

  /**
   * 停循环:关掉 mailbox,并**等在飞的那一批跑完**(drain 语义)。
   * 半途掐断在飞批会留下「处理过但没 ack」的中间态,那正是重投要覆盖的场景,
   * 但优雅停机没必要制造它。
   */
  async stop(): Promise<void> {
    if (!this.loop) return
    this.stopping = true
    this.mailbox.close()
    const loop = this.loop
    await loop
    this.loop = null
    this.stopping = false
    this.notifyIdle()
    if (this.loopError) {
      const error = this.loopError
      this.loopError = null
      throw error
    }
  }

  /** 等到积压清空且没有在飞批。循环没起来时立即返回。 */
  async drain(): Promise<void> {
    while (this.running && (this.inFlight !== null || this.mailbox.pendingCount() > 0)) {
      await new Promise<void>(resolve => {
        this.idleWaiters.push(resolve)
      })
    }
  }

  private async run(): Promise<void> {
    for await (const batch of this.mailbox.batches()) {
      // 串行的落点就在这里:先把 inFlight 挂上,await 完才回到 for 去取下一批。
      const work = this.processBatch(batch)
      this.inFlight = work
      try {
        await work
      } finally {
        this.inFlight = null
        this.notifyIdle()
      }
      if (this.stopping) break
    }
  }

  private async processBatch(batch: ActorMailboxBatch<TEvent>): Promise<void> {
    for (const event of batch.events) {
      try {
        await this.handleEvent(event)
      } catch (error) {
        this.recordDeadLetter(event, toError(error))
      }
      this.processed += 1
    }
    // ack 排在整批处理之后:中途崩溃 = 这一批重启后原样重投。
    await this.mailbox.ack(batch.cursor)
  }

  private recordDeadLetter(event: TEvent, error: Error): void {
    const deadLetter: ActorDeadLetter<TEvent> = { event, error, at: this.now() }
    this.deadLetterRing.push(deadLetter)
    while (this.deadLetterRing.length > this.maxDeadLetters) this.deadLetterRing.shift()
    try {
      this.onDeadLetter?.(deadLetter)
    } catch {
      // 观测钩子自己炸了不能反过来影响循环。
    }
  }

  private notifyIdle(): void {
    if (this.idleWaiters.length === 0) return
    const pending = this.idleWaiters.splice(0, this.idleWaiters.length)
    for (const resolve of pending) resolve()
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 最薄的可用 actor:把每封信交给一个回调。
 * 房间/agent 的真身在 D1/D2,D0 阶段的接线与测试用它。
 */
export class CallbackActor<TEvent extends ActorEvent = ActorEvent> extends ActorBase<TEvent> {
  private readonly handler: (event: TEvent) => void | Promise<void>

  constructor(options: ActorBaseOptions<TEvent> & { handler: (event: TEvent) => void | Promise<void> }) {
    super(options)
    this.handler = options.handler
  }

  protected handleEvent(event: TEvent): void | Promise<void> {
    return this.handler(event)
  }
}
