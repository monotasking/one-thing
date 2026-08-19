/**
 * `send_message` **私聊档**的执行器(agent-im-dm.md D5 / §3.4 —— 发起 agent
 * 互聊;collab-send-channel-and-wake.md §2.2 —— 合并进统一发送面)。
 *
 * 2026-08-02 起 `dm` 不再是一个工具:发送面只有 `send_message` 一个,带 `to`
 * 就走这里。这个文件因此只剩执行器,没有工具注册 —— 契约在
 * `tools/builtin/say.ts`。
 *
 * `send_message` 把话发进"这一轮在答的那间房",带 `to` 则发进"我和某个人的那间
 * 房"—— 后者可能还不存在,所以这个执行器比 say 多了一步建房,其余每一步都是
 * 既有链路:
 *
 *  - **身份**:发言人 = 当前会话的属主 agent(与 say 同一处推导,不另立一套);
 *  - **收件人**:`findAgent` 严格解析 + `isColleague` + `isActiveAgent` + ≠自己。
 *    四道都答"是"才开房 —— 与 `ensureAgentDmRoom` 的校验重复是刻意的:那边保证
 *    "不会建出一间没人的房",这边保证"拒绝时能说清楚是哪一种拒绝";
 *  - **落库**:直接调 `speakIntoCollabRoom` 并显式指定房间。于是转义白名单、
 *    mention 解析、幂等窗、冻结/预算/成员门一件不落地继承,没有第二条写消息的路;
 *  - **激活**:与 worker 的 `enqueueRoomActivation` 同一个入口(enqueue + 该房的
 *    runtime),reason 用 'mention' —— dm 就是点名,该走满格链长闸、该被去重、
 *    该在驱动侧被退休/预算门拦下。
 *
 * **不搬运上下文**(§3.4 防滥用):这里一个字的群历史都不转运。发起方要交代
 * 背景就自己写进 message —— 工具描述里也是这么说的,两处必须一致。
 */
import type { CollabDmSendResult } from '@onething/runtime/toolkit'
import { isColleague } from '@onething/runtime/agents'
import {
  COLLAB_SAY_REFUSED_EMPTY,
  COLLAB_SAY_REFUSED_UNKNOWN_ROOM,
  COLLAB_SEND_REFUSED_DM_NO_TARGET,
  COLLAB_WAKE_REFUSED_NO_ROOM,
  COLLAB_WAKE_REFUSED_SELF_NOT_MEMBER,
  COLLAB_WAKE_REFUSED_USER_TARGET,
  formatCollabWakeRefusedTargetNotMember,
  normalizeCollabSayContent,
  resolveCollabSayRoomSessionId,
} from '@onething/runtime/collab'
import { isActiveAgent } from '@shared/ipc.js'
import * as store from '../store.js'
import { findAgent, listAgents } from '../agents/index.js'
import { ensureAgentDmRoom } from './agent-dm-room.js'
import { ensureUserDmRoom } from './user-dm-room.js'
import { resolveDmTarget } from './dm-target.js'
import { resolveUserIdentity } from './user-identity.js'
import { speakIntoCollabRoom } from './say-tool.js'
import { collabLinkedRoomSessionId, collabToolAllowedInSession } from './venue.js'
import { registerCollabWakeFollowup } from './wake-followup.js'

/** 拒绝文案。每一条都说清"是哪一种拒绝",因为模型能据此改做别的事。 */
const DM_REFUSED_NO_SELF = '这一轮没有可用的发言身份,私聊发不出去。'
const DM_REFUSED_NOT_COLLAB = '私聊只在群聊/私聊/工作台的回合里可用,这场对话里没有可发起私聊的身份。'
/** 空 `to`。与合并后的发送面共用同一句(工具契约那边也要用它拒绝 channel:'dm')。 */
const DM_REFUSED_EMPTY_TARGET = COLLAB_SEND_REFUSED_DM_NO_TARGET
const DM_REFUSED_SELF = '这是你自己的 id —— 不能给自己发私聊。'
const DM_REFUSED_NO_ROOM = '私聊房打不开,这条消息没能送出。'

/**
 * wake 的目标群 + 那道门(collab-send-channel-and-wake.md §2.3)。
 *
 * 全部在**调用时**判完:发起方在这一轮里能拿到一句可操作的拒绝,而不是几分钟
 * 后发现"什么都没发生"。缺省房走的是 say 那条同款解析(这一轮在答的那间房),
 * 于是狼人杀主用例(上帝在群里给玩家发牌)一个参数都不用写。
 */
function resolveWakeRoom(input: {
  session: { id: string; kind?: string; collab?: { roomSessionId?: string } }
  selfId: string
  targetAgentId: string
  requestedRoom?: string
}): { ok: true; roomSessionId: string; roomName: string } | { ok: false; error: string } {
  // 「哪些 kind 挂着一间房」走统一场子判定(C3-6,`venue.ts`)—— 与 say 那一份
  // 同源,而它们此前是各自手写的两份。
  const linkedRoomSessionId = collabLinkedRoomSessionId(input.session)
  const roomSessionId = resolveCollabSayRoomSessionId({
    kind: input.session.kind,
    sessionId: input.session.id,
    ...(input.requestedRoom ? { requestedRoomSessionId: input.requestedRoom } : {}),
    ...(linkedRoomSessionId ? { linkedRoomSessionId } : {}),
  })
  if (!roomSessionId) return { ok: false, error: COLLAB_WAKE_REFUSED_NO_ROOM }

  const room = store.getSession(roomSessionId)
  if (room?.kind !== 'room' || !room.room) {
    // 指了一个不是群的 id,与"这一轮没有关联的群"是两种不同的错 —— 沿用 say 的
    // 那句(措辞已经说清了 room 参数该指什么)。
    return { ok: false, error: input.requestedRoom ? COLLAB_SAY_REFUSED_UNKNOWN_ROOM : COLLAB_WAKE_REFUSED_NO_ROOM }
  }
  const members = room.room.memberAgentIds ?? []
  // poke 由发起人署名落群 —— 说话的门就是这道门。
  if (!members.includes(input.selfId)) {
    return { ok: false, error: COLLAB_WAKE_REFUSED_SELF_NOT_MEMBER }
  }
  if (!members.includes(input.targetAgentId)) {
    const target = findAgent(input.targetAgentId)
    return { ok: false, error: formatCollabWakeRefusedTargetNotMember(target?.name ?? input.targetAgentId) }
  }
  return { ok: true, roomSessionId, roomName: room.name || '这个群' }
}

export async function sendCollabDm(input: {
  sessionId: string
  to: string
  message: string
  /** 送达并被消化之后,到群里 @ TA 一声(设计 §3)。 */
  wake?: boolean
  /** wake 的目标群。缺省 = 这一轮在答的那间房。 */
  wakeRoom?: string
}): Promise<CollabDmSendResult> {
  const session = store.getSession(input.sessionId)
  const selfId = session?.agentId
  if (!selfId) return { ok: false, error: DM_REFUSED_NO_SELF }
  // 注入面写的是"群房工具面 + dm 房常驻会话",这一行让它在行为上也成立。
  // 没配白名单的 agent 看得见注册表里的每一个工具(send_message/board 一直如此),所以
  // "哪些场子能用"不能只由白名单说了算 —— 普通 chat 会话是直播式对话,那里的
  // agent 没有"我去私下问问 TA"这件事,它就在用户眼前说话。
  //
  // 判据本身走统一那一份(C3-6,`venue.ts` + `collab/tool-surface.ts` 的一览表);
  // 拒绝的那句话留在这里,它是这个工具自己的资产。
  if (!collabToolAllowedInSession(session, 'send_message')) {
    return { ok: false, error: DM_REFUSED_NOT_COLLAB }
  }

  const raw = (input.to ?? '').trim()
  if (!raw) return { ok: false, error: DM_REFUSED_EMPTY_TARGET }

  /**
   * 空正文**提前判**,拒绝语与群发送逐字相同(`COLLAB_SAY_REFUSED_EMPTY`)。
   *
   * 落库那一步本来就会拒(`speakIntoCollabRoom` 第一件事就是归一化正文),但那
   * 时房已经建出来了 —— 一次发不出去的私聊不该在侧栏留下一间空房(拒绝时什么
   * 都不留下,是这个执行器的既有纪律)。
   *
   * 这条路真的会被走到:`content: ""`(或只有空白)是模型每天都在犯的那种错,
   * 而它过得了 zod(`z.string()` 收空串)。
   *
   * 旧转录里的 `dm({to, message})` 走的是**另一半**同一条降级:`message` 被 zod
   * strip 掉之后 `content` 直接缺席,于是在校验层就被挡下 —— 那一层把拒绝语翻成
   * 同一句 `COLLAB_SAY_REFUSED_EMPTY`(`tools/builtin/say.ts` 的
   * `formatValidationError`,设计 §5 R1 / §9.3 偏离)。两半合起来才是「有收件人、
   * 没正文一律说同一句可操作的话」,模型手上还攥着原文,下一轮用 `content` 重发。
   */
  if (!normalizeCollabSayContent(input.message)) {
    return { ok: false, error: COLLAB_SAY_REFUSED_EMPTY }
  }

  /**
   * 收件人解析(collab-agent-handle.md §2.4 + agent-dm-user.md §3.1)。
   *
   * 此前这里是 `findAgent(input.to)` —— 严格按 id 比对,而 agent 从来拿不到任何
   * id(花名册只有名字),于是 dm 这条链路在提示词层面**从未通过**:模型只能填
   * 名字,必然撞上「没有 id 为「小李」的同事」。现在走统一解析器:全 id、句柄、
   * `名字#句柄`、以及唯一命中的裸名字都认,重名则拒绝并列出候选 —— 拒绝的措辞
   * 本身可操作,这是 A1「严格解析,查无此人绝不 default 冒充」的原意。
   *
   * 候选池是**全体 agent** 而不是某间房的成员:dm 的对象是同事,不是室友。
   * 用户本人在这一层之前先被匹配掉(`resolveDmTarget`)。
   */
  const resolved = resolveDmTarget(raw, listAgents())
  if (!resolved.ok) return { ok: false, error: resolved.error }

  if (resolved.target.kind === 'user') {
    // 用户没有执行会话可拉(agent-dm-user.md §3.2 的同一条事实):TA 收到通知
    // 就会看到,没有"读完之后"这个时刻可以挂唤醒。
    if (input.wake) return { ok: false, error: COLLAB_WAKE_REFUSED_USER_TARGET }
    return sendDmToUser(input, selfId)
  }

  const targetId = resolved.target.agentId
  if (targetId === selfId) return { ok: false, error: DM_REFUSED_SELF }

  const target = findAgent(targetId)
  if (!target) {
    return { ok: false, error: `没有 id 为「${targetId}」的同事。` }
  }
  // 退休先判、service 后判:两句话说的是完全不同的两件事,而"已注销"是模型最
  // 需要知道的那一件(去找活人,而不是换个说法再试)。
  if (!isActiveAgent(target)) {
    return { ok: false, error: `${target.name} 已注销,私聊发不出去 —— 这件事得找别人。` }
  }
  if (!isColleague(target)) {
    return { ok: false, error: `${target.name} 不是同事(它是系统服务),没有私聊。` }
  }

  // wake 的门在**建房之前**:一次注定唤不醒的私聊不该在侧栏留下一间新房,
  // 也不该让发起方以为已经安排好了(设计 §2.3 全部调用时 fail fast)。
  const wake = input.wake
    ? resolveWakeRoom({
        session: { id: input.sessionId, kind: session.kind, collab: session.collab },
        selfId,
        targetAgentId: targetId,
        ...(input.wakeRoom ? { requestedRoom: input.wakeRoom } : {}),
      })
    : null
  if (wake && !wake.ok) return { ok: false, error: wake.error }

  const roomSessionId = ensureAgentDmRoom(selfId, targetId)
  if (!roomSessionId) return { ok: false, error: DM_REFUSED_NO_ROOM }

  // 落库走 send_message 的执行器:显式指定房间,于是"发进哪间房"这件事不靠会话指针。
  // `chainReset` 让这条消息**自己**带着清零标记落库(见下面那段注释)。
  const said = await speakIntoCollabRoom({
    sessionId: input.sessionId,
    content: input.message,
    room: roomSessionId,
    chainReset: true,
  })
  // 冻结、超预算、空正文 —— 发送执行器的拒绝文案原样透传,措辞本身就是可操作的。
  if (!said.ok || !said.messageId) {
    return { ok: false, error: said.error ?? DM_REFUSED_NO_ROOM }
  }

  /**
   * 清零与送达激活都归房间(D6-a 接线,D6-b 删掉对照面)。
   *
   * 上面那次落库已经把消息投进了 RoomActor(`say-tool.ts` 的跨房分支),而房间
   * 收到一条带 `collabChainReset` 的 posted 之后自己就会清链、按 @ 发牌、给对端
   * 投信。这里从前还留着一份 v2 的手工版(两处内存账凑出同一件事),作为 D6-b
   * 的行为对照 —— 它现在没有到达路径了(`isCollabV3Wired()` 恒真),跟着 v2
   * 调度链一起删。留着两本账写同一间房的链数,漂的那一天没人知道该信哪一本。
   */

  // 唤醒登记(设计 §3.2)。**送达之后**才登记:门都过了、消息真的在那间房里,
  // 才有"读完之后"这个时刻可以等。
  if (wake?.ok) {
    registerCollabWakeFollowup({
      dmRoomSessionId: roomSessionId,
      targetAgentId: targetId,
      wakeRoomSessionId: wake.roomSessionId,
      senderSessionId: input.sessionId,
      senderAgentId: selfId,
      sinceMessageId: said.messageId,
    })
  }

  return {
    ok: true,
    targetKind: 'agent',
    roomSessionId,
    messageId: said.messageId,
    peerName: target.name,
    ...(wake?.ok ? { wakeRoomName: wake.roomName } : {}),
  }
}

/**
 * 发给**用户本人**(agent-dm-user.md §3.2)。
 *
 * 与 agent 分支共用前面每一道门(场子门、发言身份、非空正文),落库也还是
 * `speakIntoCollabRoom` —— 转义、mention 解析、幂等窗、冻结/预算门一件不落。
 * 结构上只差一件事:**不 enqueue**。
 *
 * 为什么不 enqueue:enqueue 是「把对端的模型拉起来答话」,而对端是人,没有模型
 * 可拉。消息落库即发 `message:user-created` → renderer 水位 `noteInboundActivity`
 * → 未读墨点 + 系统通知。用户回话时走 D6 免判激活(单成员 dm 房里用户说话等价
 * 于 @ 唯一成员),闭环天然成立,零新机制。
 *
 * 房从 `ensureUserDmRoom(selfId)` 来 —— 它自带的三道校验(严格解析 / isColleague
 * / isActiveAgent)就是发起人门:service agent 和退休 agent 发不出私聊。
 */
async function sendDmToUser(
  input: { sessionId: string; message: string },
  selfId: string,
): Promise<CollabDmSendResult> {
  const roomSessionId = ensureUserDmRoom(selfId)
  if (!roomSessionId) return { ok: false, error: DM_REFUSED_NO_ROOM }

  const said = await speakIntoCollabRoom({
    sessionId: input.sessionId,
    content: input.message,
    room: roomSessionId,
  })
  if (!said.ok || !said.messageId) {
    return { ok: false, error: said.error ?? DM_REFUSED_NO_ROOM }
  }

  return {
    ok: true,
    targetKind: 'user',
    roomSessionId,
    messageId: said.messageId,
    peerName: resolveUserIdentity().label,
  }
}
