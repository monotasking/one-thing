/**
 * 房间的**读写原语** —— 一间房是什么形态、上限是多少、答在哪条通道上、系统行
 * 怎么贴进去。
 *
 * D6-b 之前这个文件还是另一半东西的家:per-room 的调度运行时(激活记录、队列、
 * 在飞表、floor 世代、意愿判定轮、编排 state、`state.json`)。那一半随 v2 调度链
 * 整层删掉了 —— 它描述的每一格状态在 v3 里都搬进了 RoomActor 的账(`actors/`
 * 目录下的 `room.json`),而两本账同时描述同一间房正是 v3 要终结的病。
 *
 * 留下来的是**没有第二个住处**的那些:
 *
 *  - 房间的**配置读数**:链长闸上限、同时发言上限 —— 它们从 `session.room.budgets`
 *    现取,是配置不是状态,房账不该抄一份;
 *  - 房间的**输出原语**:系统行(运维行 / 任务行两档)、通道解析、房间快照广播;
 *  - 房间的**清理原语**:删房时把磁盘目录带走。
 *
 * 为什么不并进 `room-config.ts`:那个文件是**门**(用户拨开关),这个文件是
 * **词汇**(别人贴一行系统消息)。建房的两条路(`room-create` / `user-dm-room`)
 * 只要后者,不该为了发一条事件把整扇配置门拖进来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  COLLAB_DEFAULT_MAX_CHAIN,
  COLLAB_DM_PAIR_MAX_CHAIN,
  COLLAB_MESSAGE_SOURCE,
  COLLAB_SYSTEM_SOURCE_TASK,
  isAgentPairDmRoom,
  isCollabForcedSerialRoom,
} from '@onething/runtime/collab'
import { type ChatMessage, type ChatSession } from '@shared/ipc.js'
import * as store from '../store.js'
import { sessionCommands } from '../session/commands.js'
import { getEventBus } from '../events/index.js'
import { getStreamEngineSafe } from '../engine/index.js'
import { getStorePath } from '../stores/paths.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.room')


/**
 * 一间房同时最多几个人在说话。
 *
 * 并行化(2026-08-01)之前这个数恒等于 1:房间队列严格串行,一轮 20–40 秒,于是
 * 「@ 谁」和「谁在说」在屏幕上错位一到两轮——用户报的正是这个。
 *
 * 有上限而不是彻底放开:每条回合都是一次全上下文模型调用 + 工具执行,八个人
 * 同时开口就是八条并发流打同一个 provider(限流)和同一份账单。6 覆盖到目前
 * 房间的实际规模。
 */
export const COLLAB_MAX_CONCURRENT_TURNS = 6

/**
 * 这间房的同时发言上限。与 dailyCostUSD / maxChain 同一套约定:
 * 缺省(没配过)= 内置默认;**0 = 不限**;其余正数原样生效。
 *
 * 负数按"没配"处理 —— 它不是一个有意义的上限。
 */
export function maxConcurrentTurnsFor(session: ChatSession | undefined): number {
  // **用户钉死的顺序仍然是钉死的**(审查 #21):批边界只管发言策略排出来的批次,
  // 而策略之外的激活(任务事件的级联、自选发言)照旧按房间上限发牌。
  // 「用户强制,房间不得违背」这条不能只在一种策略里成立。
  if (isCollabForcedSerialRoom(session?.room)) return 1
  const configured = session?.room?.budgets?.maxConcurrentTurns
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    return COLLAB_MAX_CONCURRENT_TURNS
  }
  return configured === 0 ? Number.POSITIVE_INFINITY : Math.floor(configured)
}

/**
 * 这个房间的链长闸上限:无人类输入时,讨论最多连着走几条。
 *
 * 三条规则,与 dailyCostUSD / 两个回合断路器上限同一套约定:
 *  - 缺省(从没配过)→ `COLLAB_DEFAULT_MAX_CHAIN`,**双成员 dm 房除外**:那里
 *    缺省是 `COLLAB_DM_PAIR_MAX_CHAIN`(6,agent-im-dm.md §3.3)。一对一免判
 *    激活之后,唯一还拦得住客套乒乓的就是这道闸,而群房那个 32 对两个人来说
 *    等于没有。**只改缺省**:显式配置(含 0 = 不限)照旧原样生效;
 *  - **0 = 关闭该闸** → Infinity。`CollabRoomBudgets` 的注释一直是这么写的,
 *    但代码此前把 0 读成"没配"、回落默认——文档与行为对不上,填 0 的人得到的
 *    是默认值而不是"不限"。现在按文档来。
 *  - 其余正数原样生效,**不再夹上限**。此前有一道 `min(cap, 默认×4)` 的隐形
 *    天花板:填 100 实际得到 32,而没有任何地方告诉你被夹了。要么让人填,
 *    要么别让人填,不该给一个填得进去却不生效的数字。
 *
 * 负数按"没配"处理——它不是一个有意义的上限,也不该被当成关闭。
 */
export function maxChainFor(session: ChatSession): number {
  const configured = session.room?.budgets?.maxChain
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    return isAgentPairDmRoom(session.room) ? COLLAB_DM_PAIR_MAX_CHAIN : COLLAB_DEFAULT_MAX_CHAIN
  }
  return configured === 0 ? Number.POSITIVE_INFINITY : Math.floor(configured)
}

export function roomChannel(sessionId: string): string | undefined {
  // goal kick precedent: live channel unless it is the no-signal 'ipc'
  // fallback, then the session's persisted connector.
  const live = getStreamEngineSafe()?.getChannel(sessionId)
  if (live && live !== 'ipc') return live
  return store.getSession(sessionId)?.lastConnector || live
}

/**
 * 房间配置变了,把**全量小快照**播进会话通道(架构收敛 C4 §3)。
 *
 * 每一个改 `session.room` 的写入点在落盘之后调它一次,一行,不用管房间是什么形态
 * ——读的就是刚落下去的那份真值。放在这里而不是配置门里:它是「这间房的读写原语」
 * 那一族(与 `postSystemLine` / `roomChannel` 同族),而建房的两条路
 * (`room-create` / `user-dm-room`)不该为了发一条事件去 import 整扇配置门。
 *
 * 落盘之后再调,不是之前:快照现读 store,读到旧值就等于播了一条假消息。
 */
export function emitCollabRoomUpdated(roomSessionId: string): void {
  const session = store.getSession(roomSessionId)
  if (session?.kind !== 'room' || !session.room) return
  try {
    void getEventBus().emit(roomSessionId, {
      type: SESSION_EVENT_TYPES.SESSION_COLLAB_UPDATED,
      name: session.name,
      room: session.room,
    } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
  } catch (error) {
    // 播不出去不是写失败:建房的两条路会在事件系统起来之前跑(daemon 的建房
    // RPC、boot 期的私聊修复),而"房建好了但没人收到通知"远好过"房没建成"。
    log.error('room update broadcast failed', { sessionId: session.id }, error)
  }
}

/**
 * Operational system line: budget, chain gate, freeze, turn failures,
 * permission reminders. Display-only — never enters the model projection
 * (W9.1: machine bookkeeping is not a room fact).
 */
export function postSystemLine(roomSessionId: string, content: string, source: string = COLLAB_MESSAGE_SOURCE): void {
  const message: ChatMessage = {
    id: randomUUID(),
    role: 'system',
    content,
    timestamp: Date.now(),
    source,
  }
  sessionCommands.appendMessage(roomSessionId, { message, stampCollab: true })
  void getEventBus().emit(roomSessionId, {
    type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
    message,
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}

/**
 * Task-lifecycle system line (started / halted / interrupted / review). Same
 * message shape, different source marker — this one IS projected to the model
 * so a reviewer sees what actually happened instead of only what the executor
 * claims (W9.1). Renderer treats both identically.
 */
export function postTaskSystemLine(roomSessionId: string, content: string): void {
  postSystemLine(roomSessionId, content, COLLAB_SYSTEM_SOURCE_TASK)
}

export function isRoom(sessionId: string): boolean {
  return store.getSession(sessionId)?.kind === 'room'
}

/**
 * 删房的内存那一步(D6-b 起是显式空操作)。
 *
 * v2 的 per-room 运行时表已经不存在了,所以这里没有东西可删 —— 房间的每一格
 * 状态都在 RoomActor 的账里,由 actor 自己的 `stop()` 收。留一个显式的空操作,
 * 好过让删房那条路(`actors/runtime.ts` 的 `disposeRoom`)自己记住"这一步现在
 * 不需要了":删房是「内存 + 磁盘」两步,少写一步的下一个人会以为它被忘了。
 */
export function deleteRoomRuntime(_roomSessionId: string): void {
  /* 无内存表可清 —— 见上。 */
}

/**
 * Remove a deleted room's whole collab directory — board.json, activity.jsonl
 * and the v3 actor 账/信箱 (P2-10).
 *
 * The directory used to outlive the session entirely: delete a room and its
 * board, its audit trail and its watermark stayed on disk forever, keyed by an
 * id nothing would ever look up again.
 */
export function removeCollabRoomDirectory(roomSessionId: string): void {
  try {
    fs.rmSync(path.join(getStorePath(), 'collab', roomSessionId), { recursive: true, force: true })
  } catch (error) {
    log.error('room directory cleanup failed', { roomSessionId }, error)
  }
}
