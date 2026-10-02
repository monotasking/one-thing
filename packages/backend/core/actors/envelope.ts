/**
 * Actor 事件信封(docs/design/collab-actor-v3.md §2)。
 *
 * 协议里的每一个动词都是一封**持久事件**:有 id、有时刻、有寄件人、有收件人。
 * 这一层只管信封,不认识任何产品语境 —— `type` 与 `payload` 的形状归上层
 * (collab 的动词表在 `src/collab/actors/protocol.ts`)。core 是骨架,不是产品。
 *
 * 交付语义 = **at-least-once + 消费端幂等**:投递方允许重发(崩溃点、重启补水、
 * 跨房转投),去重的责任在收件方,判据是事件 id。所以 id 必须是**事件的身份**而
 * 不是「这一次投递的流水号」—— 同一封信重投多少次,id 都得是同一个。
 */
import { createCoreId } from '../engine/ids.js'

/**
 * 一个 actor 的地址。
 *
 * `kind` 在 core 里是**开放字符串**:room/agent/user/referee/worker 是 collab
 * 的语境词,骨架层不该认识它们。上层用自己的联合类型收窄(见 `CollabActorKind`)。
 */
export interface ActorRef {
  kind: string
  id: string
}

/** 事件信封。跨进程/跨重启的唯一形态就是它的 JSON。 */
export interface ActorEvent<TPayload = unknown> {
  /** 事件身份。重投不变 —— 幂等窗口按它去重。 */
  id: string
  /** 事件发生时刻(ms)。不是投递时刻:重投沿用原值,不然重放顺序会漂。 */
  at: number
  /** 动词名。core 不解释它。 */
  type: string
  from: ActorRef
  to: ActorRef
  payload: TPayload
}

/** 事件 id 前缀。裸 uuid 在日志里认不出是什么,带个前缀省事。 */
export const ACTOR_EVENT_ID_PREFIX = 'evt-'

/**
 * 生成事件 id。
 *
 * 复用 core 既有的 `createCoreId()`(node:crypto randomUUID)—— core 禁 uuid 包,
 * 但 node 内置的 crypto 一直是这一层的既有做法(见 engine/ids.ts、permission/)。
 */
export function createActorEventId(): string {
  return `${ACTOR_EVENT_ID_PREFIX}${createCoreId()}`
}

export interface CreateActorEventOptions<TPayload> {
  type: string
  from: ActorRef
  to: ActorRef
  payload: TPayload
  /**
   * 显式事件 id。**重放与迁移必须传**:确定性重放要求同一份输入两次跑出同一串
   * 事件 id,随机 id 会让金重放的快照每次都变。
   */
  id?: string
  /** 显式时刻。缺省取 `Date.now()`;重放传转录里的时间戳。 */
  at?: number
}

export function createActorEvent<TPayload>(options: CreateActorEventOptions<TPayload>): ActorEvent<TPayload> {
  return {
    id: options.id ?? createActorEventId(),
    at: options.at ?? Date.now(),
    type: options.type,
    from: options.from,
    to: options.to,
    payload: options.payload,
  }
}

/** `kind:id` —— 游标文件、日志行、重放快照里用的扁平地址形态。 */
export function formatActorRef(ref: ActorRef): string {
  return `${ref.kind}:${ref.id}`
}

/**
 * 解析 `kind:id`。id 里可以再含冒号(会话 id 就长这样),所以只切**第一个**冒号。
 * 形状不对返回 null —— 让调用方决定是丢弃还是报错,这一层不替它拍板。
 */
export function parseActorRef(value: string): ActorRef | null {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return null
  return { kind: value.slice(0, separator), id: value.slice(separator + 1) }
}

export function actorRefEquals(a: ActorRef, b: ActorRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/**
 * 事件 id 的**有界**去重窗口。
 *
 * 为什么有界:一个 agent 的 inbox 会长到几万条,把全部见过的 id 都记住等于
 * 第二本转录。窗口只需要盖住「重投可能发生的距离」—— 重投来自崩溃重启与
 * 上游补水,都是近端事件,几百条足够。
 *
 * 为什么先进先出而不是 LRU:重投的是**刚刚**那批,不是很久以前热过的那条;
 * 按插入序淘汰恰好匹配这个分布,而且不需要每次命中都动结构。
 */
export interface SeenActorEventWindow {
  /** 见过就返回 true(不改变窗口)。 */
  has(eventId: string): boolean
  /** 记下一个 id;返回 false 表示它本来就在窗口里(即:这是一次重投)。 */
  remember(eventId: string): boolean
  /** 当前窗口内容,插入序(旧 → 新)。持久化游标时原样落盘。 */
  snapshot(): string[]
  readonly size: number
  readonly capacity: number
}

export const DEFAULT_SEEN_ACTOR_EVENT_WINDOW = 256

export function createSeenActorEventWindow(
  capacity: number = DEFAULT_SEEN_ACTOR_EVENT_WINDOW,
  initial: readonly string[] = [],
): SeenActorEventWindow {
  const limit = Math.max(1, Math.floor(capacity))
  // Set 的迭代序 = 插入序,所以它同时是「集合」和「队列」,不用再配一个数组。
  const seen = new Set<string>()
  for (const id of initial.slice(-limit)) seen.add(id)

  const evict = (): void => {
    while (seen.size > limit) {
      const oldest = seen.values().next()
      if (oldest.done) break
      seen.delete(oldest.value)
    }
  }

  return {
    has: (eventId: string) => seen.has(eventId),
    remember: (eventId: string) => {
      if (seen.has(eventId)) return false
      seen.add(eventId)
      evict()
      return true
    },
    snapshot: () => Array.from(seen),
    get size() {
      return seen.size
    },
    get capacity() {
      return limit
    },
  }
}
