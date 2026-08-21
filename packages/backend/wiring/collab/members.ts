/**
 * 「在册 ∩ 在职 → CollabAgentLike」的**单一投影点**(架构审查 B8)。
 *
 * ## 收口之前
 *
 * 同一段 `memberAgentIds.map(findAgent).filter(isActiveAgent).map(取几个字段)`
 * 在七处各写了一遍:房间运行时、ingress 的 @ 落点、say 的 @ 落点、board 的
 * 指派解析、意愿判定的花名册、日摘要的署名表、系统提示词的花名册。七份复刻
 * 之间有三处**真实**差异 —— 要不要 `description`、要不要头像、退休的算不算 ——
 * 而这三处差异是有意的,混在七份各自的循环里就分不清哪一处是"想这样"、哪一处
 * 是"抄的时候漏了"。
 *
 * 所以收口收成一份实现 + 三个参数:差异从**复刻的副产物**变成调用点显式写下的
 * 一行,而"哪几处带 description"这个问题从此 grep 一次就答完。
 *
 * ## 为什么是独立模块而不是挂在 room-runtime 上
 *
 * `room-runtime.ts` 吃 `node:fs` 与 `../engine/index.js`;而消费方之一是
 * `engine/prompt/system-prompt.ts` —— 挂在那边就得让引擎反向 import 房间运行时,
 * 一条 `engine → room-runtime → engine` 的环。这里只吃 agents 名册与一个纯谓词,
 * 是一片叶子,谁都可以指向它。`room-runtime.roomMembers` 保留为它的转发口
 * (既有调用点不动)。
 *
 * ## 为什么「前成员占位」不是这里的参数
 *
 * `engine/stream/message-helpers.ts` 那份投影在名册有 id、全局查不到人时**造**
 * 一个「前成员」占位。那不是本函数的一个开关:它把谓词从「在册 ∩ 在职」换成
 * 了「在册」再加一次伪造 —— 返回的那一项背后没有 agent。同一个函数既能返回
 * 真人又能返回伪造项,调用点就必须再判一次"这一项是真的吗",而那正是本次要
 * 消灭的东西。要收口就该收成另一个显式命名的函数。
 */
import { isActiveAgent, type ChatSession } from '@shared/ipc.js'
import type { CollabAgentLike } from '@onething/runtime/collab'
import { findAgent } from '../agents/index.js'

export interface CollabRoomMemberOptions {
  /**
   * 带上 `description`(一句职责说明)。
   *
   * 只有**模型面**要:系统提示词的花名册、意愿判定的材料 —— 模型据此决定这件事
   * 该找谁。解析面(@ 落点、指派)与摘要面不要:多一句说明既不影响匹配,又是
   * 按条计费的纯开销。缺省 false。
   */
  withDescription?: boolean
  /**
   * 带上 `avatar` / `avatarImage`。投影到 UI 的那几条链路(消息署名、成员条)
   * 要,纯文本链路(指派解析、日摘要)不要。缺省 true。
   */
  withAvatar?: boolean
  /**
   * 退休的成员也列。缺省 false —— 域模型 §3.2:它照旧留在 `memberAgentIds` 里
   * (数据不动,成员条上是墓碑),但不被提名、不被 @ 到、不进模型看到的花名册,
   * 因为一个永远不会应答的名字出现在那三处只会让房间对着它空转。
   *
   * 传 true 的是**读历史**的两条链路(日摘要的署名表、系统提示词的花名册):
   * 那里要回答的是"这条是谁说的",而退休不会让说过的话消失。
   */
  includeRetired?: boolean
}

/**
 * 一串成员 id → 可用的同事投影。查无此人一律丢弃(不造占位,见文件头)。
 */
export function collabRoomMembers(
  memberAgentIds: readonly string[] | undefined | null,
  options: CollabRoomMemberOptions = {},
): CollabAgentLike[] {
  const withAvatar = options.withAvatar ?? true
  const members: CollabAgentLike[] = []
  for (const id of memberAgentIds ?? []) {
    const agent = findAgent(id)
    if (!agent) continue
    if (!options.includeRetired && !isActiveAgent(agent)) continue
    members.push({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      ...(options.withDescription ? { description: agent.description } : {}),
      ...(withAvatar ? { avatar: agent.avatar, avatarImage: agent.avatarImage } : {}),
    })
  }
  return members
}

/** 同上,入参是房间会话(最常见的手上有的东西)。 */
export function collabSessionRoomMembers(
  session: Pick<ChatSession, 'room'> | { room?: { memberAgentIds?: string[] } } | undefined | null,
  options: CollabRoomMemberOptions = {},
): CollabAgentLike[] {
  return collabRoomMembers(session?.room?.memberAgentIds, options)
}
