/**
 * 金重放测试架(docs/design/collab-actor-v3.md §7 风险 1 的对策)。
 *
 * v3 是**直接替换、不留双轨**,所以「新运行时的行为对不对」不能靠上线后观察。
 * 这个架子把一份房间转录按时间序翻成 posted 事件流,喂给一条可插拔的**决策管线**,
 * 把管线吐出的全部动词按序捕获,与期望快照逐字节比 —— 旧房的真实剧本因此成了
 * 新运行时的行为对照。
 *
 * D0 阶段管线只有一个直通 stub(记录收到什么);D1-D3 会把真的 Room/Agent/Referee
 * 插进来,快照那一刻才有对错可言。架子先立,是因为契约先行:D1 写第一行 RoomActor
 * 之前就该知道自己要被怎么验。
 *
 * 两条硬性质,测试逐条钉住:
 * 1. **确定性** —— 同一份 fixture 两次重放,动词序列逐字节相同。事件 id 与时刻
 *    都从转录里派生,不碰 randomUUID、不碰 Date.now(),不然快照每次都变。
 * 2. **幂等** —— 重复/乱序注入被去重窗口挡住,不进管线。at-least-once 的代价
 *    在这里先付清,免得 D1 才发现重放和真机对不上。
 *
 * 数据纪律:fixture 全部合成。真实用户转录只能用同目录外的本地脚本
 * (`scripts/collab-v3-replay.mjs`,只读)手工对照,**不入库**。
 */
import { createActorEvent, createSeenActorEventWindow, formatActorRef, type ActorEvent } from '@onething/backend/collab/kernel'

import type { CollabMessageLike } from '../collab-types.js'
import {
  collabActorRef,
  collabAgentNote,
  collabRoomPosted,
  type CollabActorRef,
  type CollabActorVerb,
  type CollabRoomPostedVerb,
} from './collab-actors-protocol.js'

/** 一份房间转录:重放的输入。 */
export interface CollabActorReplayTranscript {
  roomId: string
  messages: CollabMessageLike[]
}

/** 管线每收到一条 posted 时拿到的语境。 */
export interface CollabActorReplayContext {
  roomId: string
  /** 去重、排序之后的稳定序号(0 起)。 */
  index: number
  total: number
}

/**
 * 决策管线:重放架与真运行时之间的**唯一**接缝。
 *
 * 同步返回动词而不是投进 mailbox —— 重放要的是「这一条消息导致了什么决策」,
 * 异步投递会把决策与调度搅在一起,快照就不再是决策的快照了。
 */
export interface CollabActorReplayPipeline {
  readonly name: string
  /** 每次重放开始时调用,清掉上一轮的内部状态。 */
  reset?(): void
  onPosted(event: ActorEvent<CollabRoomPostedVerb>, context: CollabActorReplayContext): CollabActorVerb[]
}

export interface CollabActorReplayOptions {
  transcript: CollabActorReplayTranscript
  pipeline: CollabActorReplayPipeline
  /** 幂等窗口容量。默认盖住整份转录。 */
  seenWindowSize?: number
}

export interface CollabActorReplayResult {
  /** 实际喂进管线的 posted 事件(已去重、已按时间序)。 */
  events: ActorEvent<CollabRoomPostedVerb>[]
  verbs: CollabActorVerb[]
  /** `verbs` 的一行一条形态 —— 金快照比的就是它。 */
  lines: string[]
  duplicatesDropped: number
}

export const COLLAB_REPLAY_EVENT_ID_PREFIX = 'replay'

/**
 * 重放一份转录。
 *
 * 时间序:按 `timestamp` 稳定排序 —— 转录本来就是按时间落的,但迁移/合并会打乱
 * 文件顺序,排序让「乱序注入」进不来。同刻的按原序,保持稳定。
 */
export function replayRoomTranscript(options: CollabActorReplayOptions): CollabActorReplayResult {
  const { transcript, pipeline } = options
  pipeline.reset?.()

  const ordered = orderTranscriptMessages(transcript.messages)

  // 先按身份去重再编号:编号建立在去重之后的位置上,重复注入才不会把后面所有
  // 事件的 id 都顶偏(顶偏 = 确定性当场失效)。
  const seenKeys = createSeenActorEventWindow(
    options.seenWindowSize ?? Math.max(1, ordered.length * 2),
  )
  const unique: CollabMessageLike[] = []
  let duplicatesDropped = 0
  for (const message of ordered) {
    if (!seenKeys.remember(transcriptMessageKey(message))) {
      duplicatesDropped += 1
      continue
    }
    unique.push(message)
  }

  const events: ActorEvent<CollabRoomPostedVerb>[] = []
  const verbs: CollabActorVerb[] = []
  for (let index = 0; index < unique.length; index += 1) {
    const message = unique[index]
    const author = replayMessageAuthor(message, transcript.roomId)
    const event = createActorEvent<CollabRoomPostedVerb>({
      id: replayEventId(transcript.roomId, message, index),
      at: message.timestamp ?? index,
      type: 'room:posted',
      from: author,
      // 入口那一跳:UserProxy/agent 把消息投给房间。房间再广播给成员 mailbox
      // 是 D1 的事,重放阶段管线一个人扮演房间与全体成员。
      to: collabActorRef('room', transcript.roomId),
      payload: collabRoomPosted({ roomId: transcript.roomId, author, message }),
    })
    events.push(event)
    verbs.push(...pipeline.onPosted(event, { roomId: transcript.roomId, index, total: unique.length }))
  }

  return { events, verbs, lines: verbs.map(formatCollabActorVerb), duplicatesDropped }
}

/** 稳定按时间序。不改输入数组。 */
export function orderTranscriptMessages(messages: readonly CollabMessageLike[]): CollabMessageLike[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0) || a.index - b.index)
    .map(entry => entry.message)
}

/**
 * 消息的身份键。有 id 就用 id(转录里 id 就是身份);没有的就用内容指纹 ——
 * 老转录缺 id 是常态,不能因此把去重整个关掉。
 */
export function transcriptMessageKey(message: CollabMessageLike): string {
  if (message.id) return `id:${message.id}`
  return `fp:${JSON.stringify([message.role, message.agentId ?? '', message.timestamp ?? 0, message.content])}`
}

function replayEventId(roomId: string, message: CollabMessageLike, index: number): string {
  return `${COLLAB_REPLAY_EVENT_ID_PREFIX}:${roomId}:${message.id ?? `idx-${index}`}`
}

/** 谁说的。没有 agentId 的用户行归 `user`,系统行归房间自己。 */
export function replayMessageAuthor(message: CollabMessageLike, roomId: string): CollabActorRef {
  if (message.agentId) return collabActorRef('agent', message.agentId)
  if (message.role === 'user') return collabActorRef('user', 'user')
  return collabActorRef('room', roomId)
}

/**
 * 一个动词一行。字段名排序后输出 —— 构造函数的字面量顺序不该成为快照的一部分,
 * 不然重排一次字段就是一次假 diff。
 */
export function formatCollabActorVerb(verb: CollabActorVerb): string {
  // 动词是判别联合,没有索引签名 —— 逐字段列举一遍只为了打印一行不划算,
  // 这里明确走一次 unknown 中转,把「我知道我在做结构反射」写在代码里。
  const { type, ...rest } = verb as unknown as { type: string } & Record<string, unknown>
  const fields = Object.keys(rest)
    .sort()
    .filter(key => rest[key] !== undefined)
    .map(key => `${key}=${formatVerbValue(rest[key])}`)
  return fields.length ? `${type} ${fields.join(' ')}` : type
}

function formatVerbValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || typeof value !== 'object') return String(value)
  return JSON.stringify(value)
}

/** 快照文本:一行一动词,末尾带换行。 */
export function formatCollabActorReplay(result: CollabActorReplayResult): string {
  return result.lines.length ? `${result.lines.join('\n')}\n` : ''
}

/**
 * 读一份 jsonl 转录。
 *
 * 两种行都吃:会话 jsonl 的 `{"t":"m","seq":N,"m":{…}}`,以及一行一条裸消息的
 * fixture。**同一个解析器**服务测试与真机脚本 —— 两套解析器迟早会漂,而
 * 「金重放在 fixture 上绿、在真房上炸」是最难查的那种漂。
 */
export function parseRoomTranscriptJsonl(text: string, roomId: string): CollabActorReplayTranscript {
  const messages: CollabMessageLike[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 崩溃截断的尾行:丢掉,与会话 jsonl 的恢复语义一致
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as { t?: unknown; m?: unknown }
    if (record.t === 'h') continue
    const candidate = record.t === 'm' ? record.m : parsed
    if (isTranscriptMessage(candidate)) messages.push(candidate)
  }
  return { roomId, messages }
}

function isTranscriptMessage(value: unknown): value is CollabMessageLike {
  if (!value || typeof value !== 'object') return false
  const record = value as { role?: unknown; content?: unknown }
  return typeof record.role === 'string' && typeof record.content === 'string'
}

/** 直通 stub 额外暴露的观测面。 */
export interface CollabActorPassthroughPipeline extends CollabActorReplayPipeline {
  readonly received: ActorEvent<CollabRoomPostedVerb>[]
}

/**
 * D0 的占位管线:把收到的每一条 posted 记下来,并吐一条 `agent:note` 作为
 * 「我看见了」的协议形态。
 *
 * 为什么不是「什么都不吐」:那样金快照永远是空文件,架子本身有没有跑通就看不出来。
 * 一条可预期的动词让快照对比这条链路在 D0 就是活的。
 */
export function createCollabActorPassthroughPipeline(
  agentId = 'replay-observer',
): CollabActorPassthroughPipeline {
  const received: ActorEvent<CollabRoomPostedVerb>[] = []
  return {
    name: 'passthrough',
    received,
    reset: () => {
      received.length = 0
    },
    onPosted: event => {
      received.push(event)
      return [
        collabAgentNote({
          agentId,
          roomId: event.payload.roomId,
          note: `saw ${formatActorRef(event.from)} ${event.payload.message.id ?? '(no-id)'}`,
        }),
      ]
    },
  }
}
