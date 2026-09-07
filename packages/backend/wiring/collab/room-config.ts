/**
 * 房间的**配置门** —— 用户(以及 daemon)能拨动的每一个开关。
 *
 * 这些函数原本住在 `coordinator.ts` 的尾巴上,和 v2 调度链的进程生命周期挤在
 * 一个文件里。D6-b 删掉那条链时它们必须先搬出来:它们与调度**无关** —— 冻结、
 * 预算、名册、看板动作、清空历史,每一件都是"用户改了这间房的某个字段,然后
 * 让运行时知道"。留在原地就意味着为了保住五扇门而保住一个已经没人跑的协调器。
 *
 * 三条纪律,与 v2 那一版逐条相同(搬家不是改写):
 *
 *  1. **校验在这里,不在壳层**。IPC handler 与 daemon 方法整体透传形状,一条
 *     业务规则都不留 —— 界面上的只读不算防线,程序化调用直接落到这个文件上。
 *  2. **落盘之后再播**。快照现读 store,提前播就是播一条假消息。
 *  3. **停在删之前**。清空历史那条路上,任何一步的次序错了都会让一个在飞回合
 *     的收尾写进一间刚被清空的房。
 *
 * 与 v2 的**唯一**行为差别:"停下这间房"和"停掉在飞的活"两件事换了执行方 ——
 * 从 v2 的 `activeTurns` / `activeByTask` 两张进程内表,换成 v3 的租约换代与
 * 各位同事账里的子清单。语义一格没变,账本换了住处。
 */
import {
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
  buildCollabMembershipLines,
  collabAgentSessionId,
  isAgentPairDmRoom,
  isUserDmRoom,
  type CollabBoard,
  type CollabBoardAction,
} from '@onething/runtime/collab'
import {
  isActiveAgent,
  type CollabRoomBudgetsPatch,
  type CollabRoomUpdatePatch,
  type PermissionMode,
} from '@shared/ipc.js'
import * as store from '../../store.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionAccess } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import type { RuntimeRequestContext } from '@onething/core'
import { ownedCollabSessionId } from './owned-session-id.js'
import { getEventBus } from '../../events/index.js'
import { findAgent } from '../agents/index.js'
import { applyBoardAction, clearCollabBoard } from './board-store.js'
import { emitCollabTyping } from './typing-observer.js'
import {
  broadcastCollabCoordinator,
  buildCollabCoordinatorState,
  forgetCollabInspector,
} from './inspector.js'
import { forgetCollabDigests } from '@onething/runtime/collab/digest-store'
import { resetCollabSeenCursor } from './agent-session.js'
import { emitCollabRoomUpdated, postSystemLine } from './room-runtime.js'
import { forgetCollabRoomBudgetCache } from './budget.js'
import { abortCollabRoomTurnForStop } from './actors/stop-door.js'
import {
  forgetCollabV3RoomBudget,
  collabV3RoomStopTargets,
  freezeCollabV3RoomWork,
  postCollabV3MembershipChanged,
  resumeCollabV3RoomWork,
  syncCollabV3RoomFloorPolicy,
} from './actors/runtime.js'
import { collabV3TurnsInRoom, resetCollabV3RoomAccount } from '@onething/runtime/collab/actors/turn-context.wiring'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.room')


/** 预算/费用的读口从这里转发一次,调用方(say 执行器、设置面板、IPC)只认一个入口。 */
export {
  getCollabRoomSpend,
  isRoomOverBudget,
  readCollabRoomSpentTodayUSD,
} from './budget.js'

/**
 * 协调器状态条的冷启动读取(docs/design/collab-coordinator-inspector.md §5)。
 *
 * 实时更新走 `collab:coordinator-changed` 会话事件;这一扇门只服务"面板刚打开"。
 */
export function getCollabCoordinatorState(roomSessionId: string) {
  return buildCollabCoordinatorState(roomSessionId)
}

export interface CollabRoomClearHistoryResult {
  success: boolean
  error?: string
  /** 清掉的房间消息条数(= 留档文件里的那一份)。 */
  clearedMessageCount?: number
  /** 一并清空的成员执行会话数。 */
  clearedSessionCount?: number
  /** 连带清空的成员间私聊房数(仅当 includeMemberDms)。 */
  clearedDmRoomCount?: number
  /** 一并清掉的看板卡片数。 */
  clearedTaskCount?: number
}

/** 清场后最多等多久(次数 × 间隔)让在飞回合落地。 */
const QUIESCE_ATTEMPTS = 60
const QUIESCE_INTERVAL_MS = 50

/**
 * 清空这间房的对话记忆(docs/design/collab-room-clear-and-mention-all.md B)。
 *
 * 「对话记忆」散在六处,漏一处就留一个幽灵:房间转录、每位成员执行会话的转录
 * 与已读游标、`digests.json`、`board.json` + `activity.jsonl`、v3 房账(水位/
 * 链数/举手/租约/发言策略)、渲染层。**次序是强制的**:先停(否则在飞回合的
 * 收尾会往刚清空的会话里写)、后删、再播。
 *
 * 看板一并清(2026-08-02 真机:清完消息,卡片还挂在那儿)。留着它不是"保守",
 * 是自相矛盾 —— `getCollabSelfTaskFacts` 会把 doing/blocked 卡片当既成事实注入
 * 提示词,于是清空后的第一个回合里,同事张口就在谈一段谁都读不到的工作。
 *
 * 刻意不动:房间配置、成员本体、`budgetSpentUSD` / `budgetNoticeDay`(钱花了
 * 就是花了,预算闸照常),以及成员之间的私聊房。
 */
export async function clearCollabRoomHistory(
  roomSessionId: string,
  options: { includeMemberDms?: boolean; executionContext?: RuntimeRequestContext } = {},
): Promise<CollabRoomClearHistoryResult> {
  const executionContext = fixedExecutionContext(options.executionContext)
  sessionAccess.resolve(executionContext, roomSessionId, 'write')
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room' || !session.room) {
    return { success: false, error: 'Not a room session' }
  }

  // Freeze the full expansion before aborting or changing anything. A member DM
  // is shared by its participants, so room access alone never authorizes it.
  const membersOf = (room: NonNullable<typeof session>) => [...new Set([
    ...(room.room?.memberAgentIds ?? []),
    ...(room.room?.formerMembers ?? []).map(entry => entry.agentId),
  ])]
  const plannedRooms = [session]
  if (options.includeMemberDms) {
    const members = new Set(membersOf(session))
    for (const meta of store.getSessionsList()) {
      if (meta.kind !== 'room' || meta.id === roomSessionId) continue
      const candidate = store.getSession(meta.id)
      const pair = candidate?.room?.memberAgentIds ?? []
      if (candidate?.kind === 'room' && candidate.room?.dm === true
        && pair.length === 2 && pair.every(agentId => members.has(agentId))) {
        plannedRooms.push(candidate)
      }
    }
  }
  const plan = plannedRooms.map(room => ({
    roomId: room.id,
    executionIds: membersOf(room)
      .map(agentId => ownedCollabSessionId(collabAgentSessionId(agentId, room.id), executionContext))
      .filter((id): id is string => Boolean(id && store.getSession(id))),
  }))
  const targetIds = plan.flatMap(room => [...collabV3RoomStopTargets(room.roomId), ...room.executionIds])
  const authorize = () => {
    if (plan.some(room => collabV3RoomStopTargets(room.roomId).some(id => !targetIds.includes(id)))) {
      throw new Error('房间执行状态已变化,请重试')
    }
    return sessionAccess.resolveAll(executionContext, targetIds, 'write')
  }
  authorize()

  // Quiesce every planned room before deleting any transcript. Never discover
  // additional targets after this point, including after an asynchronous wait.
  for (const target of plan) {
    for (let attempt = 0; attempt < QUIESCE_ATTEMPTS; attempt++) {
      authorize()
      // A late activation must not silently enlarge the authorized batch.
      if (collabV3RoomStopTargets(target.roomId).some(id => !targetIds.includes(id))) {
        return { success: false, error: '房间执行状态已变化,请重试' }
      }
      abortCollabRoomTurnForStop(target.roomId, { executionContext })
      authorize()
      freezeCollabV3RoomWork(target.roomId, { executionContext })
      if (collabV3TurnsInRoom(target.roomId).length === 0) break
      await new Promise(resolve => setTimeout(resolve, QUIESCE_INTERVAL_MS))
    }
    if (collabV3TurnsInRoom(target.roomId).length > 0) {
      return { success: false, error: '仍有回合在收尾,请稍后重试' }
    }
  }

  let clearedMessageCount = 0
  let clearedSessionCount = 0
  let clearedTaskCount = 0
  for (const target of plan) {
    authorize()
    const board = await clearCollabBoard(target.roomId)
    authorize()
    const room = await sessionCommands.replaceAll(target.roomId, { messages: [], reason: 'clear' })
    if (target.roomId === roomSessionId) clearedMessageCount = room.previousCount
    clearedTaskCount += board.clearedTaskCount
    for (const execSessionId of target.executionIds) {
      authorize()
      const cleared = await sessionCommands.replaceAll(execSessionId, { messages: [], reason: 'clear' })
      if (!cleared.replaced) continue
      authorize()
      clearedSessionCount += 1
      resetCollabSeenCursor(execSessionId)
      broadcastClearedTranscript(execSessionId)
    }
    authorize()
    await resetCollabV3RoomAccount(target.roomId)
    authorize()
    forgetCollabDigests(target.roomId)
    forgetCollabInspector(target.roomId)
    broadcastClearedTranscript(target.roomId)
    broadcastCollabCoordinator(target.roomId)
  }
  return {
    success: true,
    clearedMessageCount,
    clearedSessionCount,
    clearedTaskCount,
    ...(options.includeMemberDms ? { clearedDmRoomCount: plan.length - 1 } : {}),
  }
}
/**
 * 让渲染层把这条会话的消息列表整体换成空的。
 *
 * 复用 `messages:replaced`(编辑重发的截断走的就是它),而不是新造一个
 * 「已清空」事件:渲染层那侧已经有一条处理完备的路径(重建 contentParts、
 * 重置滚动锚点),新事件类型意味着把同一件事再实现一遍。
 */
function broadcastClearedTranscript(sessionId: string): void {
  void getEventBus().emit(sessionId, {
    type: SESSION_EVENT_TYPES.MESSAGES_REPLACED,
    messages: [],
  } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}

/** Room-wide pause switch (总闸): freezes activations AND all work streams. */
export function setCollabRoomFrozen(
  roomSessionId: string,
  frozen: boolean,
  options: { executionContext?: RuntimeRequestContext } = {},
): boolean {
  const executionContext = fixedExecutionContext(options.executionContext)
  sessionAccess.resolveAll(executionContext, collabV3RoomStopTargets(roomSessionId), 'write')
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room' || !session.room) return false
  const updated = store.updateSessionCollab(roomSessionId, {
    room: { ...session.room, frozen },
  })
  if (!updated) return updated
  if (frozen) {
    // 冻结门本身是房间**现读** `session.room.frozen`(v3 的 gates),所以落盘那一行
    // 已经把闸关上了。这里要做的只剩"把已经在跑的停下来":在外的牌与在飞的流走
    // 停止按钮那扇门,在飞的活走子清单。
    abortCollabRoomTurnForStop(roomSessionId, { executionContext })
    freezeCollabV3RoomWork(roomSessionId, { executionContext })
    postSystemLine(roomSessionId, '房间已全部暂停:进行中的执行已中止,恢复后可重新指派')
  } else {
    void resumeCollabV3RoomWork(roomSessionId).catch((error: unknown) => {
      log.error('resume room work failed', { roomSessionId }, error)
    })
  }
  // 暂停/恢复是状态条上最显眼的一格(常驻条直接换成「已暂停 · 恢复」),不推的话
  // 面板要等下一次调度才追上一个用户刚刚亲手拨过的开关。
  broadcastCollabCoordinator(roomSessionId)
  // `frozen` 也是会话列表读的房间字段(看板面板的暂停开关此前靠写完 loadSessions
  // 全量重拉),所以这里同时播一份房间快照(C4 §3)。
  emitCollabRoomUpdated(roomSessionId)
  return updated
}

export interface CollabBoardActResult {
  success: boolean
  error?: string
  board?: CollabBoard
}

/**
 * The USER's board mutation door (W16). Same reducer, same per-room write
 * queue, same broadcast as the board tool — the only thing pinned here is the
 * actor: a human. That matters beyond bookkeeping, because W9b's halt cap and
 * the 打回 counter gate AGENT-driven retries only, so a user can always push a
 * card that the room has stopped touching by itself.
 *
 * The board comes back on BOTH paths: a rev conflict is the expected outcome
 * of two writers (agent + user) on one card, and the caller repaints from the
 * returned truth rather than guessing.
 */
export async function applyUserCollabBoardAction(
  roomSessionId: string,
  action: CollabBoardAction,
): Promise<CollabBoardActResult> {
  const session = store.getSession(roomSessionId)
  if (!session) return { success: false, error: 'Session not found' }
  if (session.kind !== 'room' || !session.room) return { success: false, error: 'Not a room session' }
  const outcome = await applyBoardAction(roomSessionId, action, { type: 'user' })
  // Reducer refusals (unknown id, rev conflict, illegal transition) travel
  // VERBATIM: their wording is the actionable part ("re-read the board…").
  if (outcome.error) return { success: false, error: outcome.error, board: outcome.board }
  return { success: true, board: outcome.board }
}

const PERMISSION_MODES: readonly PermissionMode[] = ['normal', 'auto-accept-edits', 'dangerously-allow-all']
const RESPONSE_MODES: ReadonlyArray<'auto' | 'parallel' | 'serial'> = ['auto', 'parallel', 'serial']

/**
 * Room settings patch (W6). Absent field = unchanged; pmAgentId null = clear.
 *
 * **就是** shared 的 `CollabRoomUpdatePatch`(线上请求减去它的地址)。不再另写一份
 * 结构相同的接口:IPC handler 现在整体透传 `{ roomSessionId, ...patch }`,两侧共用
 * 同一个类型之后,「shared 加了个字段、app 层忘了收」这类漂移在编译期就死了。
 */
export type CollabRoomConfigPatch = CollabRoomUpdatePatch

export interface CollabRoomConfigResult {
  success: boolean
  error?: string
}

/**
 * Team settings (W6): rename / roster / PM / permission mode in one atomic
 * validation pass, followed by the 群公告 lines the room (and the model) reads.
 *
 * Membership semantics (§3.5 C): a removed member keeps its in-flight work
 * session — the task is still harvested — but stops taking the floor. Nothing
 * caches the roster: the room's gates, mention decisions and the drive-time
 * guard all read store.getSession() fresh, so the next round after this write
 * already excludes them.
 */
export function setCollabRoomConfig(
  roomSessionId: string,
  patch: CollabRoomConfigPatch,
): CollabRoomConfigResult {
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room' || !session.room) {
    return { success: false, error: 'Not a room session' }
  }

  const previousMembers = session.room.memberAgentIds ?? []
  let nextMembers = previousMembers
  if (patch.memberAgentIds !== undefined) {
    // 私聊房的名册**不可编辑**(agent-im-dm.md D1/D3:人数即形态)。改一个单成员
    // dm 房的成员就是把它悄悄变成群,而所有读它的分支(免判激活、union 工具面、
    // dm 版提示词)仍按私聊在跑 —— 形态与语义分家,最难查的那一类。
    //
    // 界面上这两处本来就是只读的,但那只是**界面**:daemon 与任何程序化调用都
    // 直接落到这个函数上,防线画在 UI 层等于没画。
    if (isUserDmRoom(session.room) || isAgentPairDmRoom(session.room)) {
      return {
        success: false,
        error: '私聊的成员不能改:这间房的成员就是私聊的双方。要和别人聊请另开一间私聊,要多人参与请建群。',
      }
    }
    const requested = Array.isArray(patch.memberAgentIds) ? patch.memberAgentIds : []
    const unique = [...new Set(requested.filter(id => typeof id === 'string' && id.length > 0))]
    if (unique.length === 0) {
      return { success: false, error: 'Room needs at least one member agent' }
    }
    for (const agentId of unique) {
      const agent = findAgent(agentId)
      if (!agent) {
        return { success: false, error: `Unknown agent: ${agentId}` }
      }
      // 退休的人不能被**拉进来**(域模型 §3.2);已经在房里的原样通过 —— 否则
      // 一间旧房只要有一个成员退休了,这间房的任何设置修改都会被整体拒掉,
      // 而"已在房的 retired 成员留在 memberAgentIds"正是本期的数据纪律。
      if (!isActiveAgent(agent) && !previousMembers.includes(agentId)) {
        return { success: false, error: `Agent is retired: ${agent.name}` }
      }
    }
    nextMembers = unique
  }

  const previousPm = session.room.pmAgentId || undefined
  let nextPm = previousPm
  if (patch.pmAgentId !== undefined) {
    nextPm = patch.pmAgentId || undefined
    if (nextPm && !nextMembers.includes(nextPm)) {
      return { success: false, error: 'PM must be a room member' }
    }
  }
  // PM dropped from the roster → the room simply has no PM (§3.5 C). Validation
  // guarantees this rather than leaving a dangling pmAgentId behind.
  if (nextPm && !nextMembers.includes(nextPm)) nextPm = undefined

  if (patch.permissionMode !== undefined && !PERMISSION_MODES.includes(patch.permissionMode)) {
    return { success: false, error: `Invalid permission mode: ${patch.permissionMode}` }
  }

  let nextName: string | undefined
  if (patch.name !== undefined) {
    nextName = patch.name.trim()
    if (!nextName) return { success: false, error: 'Room name cannot be empty' }
  }

  // 响应模式三件套(collab-speaking-order.md §2)。校验只管形状,**不校验 speakOrder
  // 里的 id 是否在册** —— 列表里留着一个已离房的人是合法数据(§3④:读时忽略,
  // 他被拉回来时次序还在),在这里拒掉等于逼用户每次改名册都回来清一遍列表。
  if (patch.responseMode !== undefined && !RESPONSE_MODES.includes(patch.responseMode)) {
    return { success: false, error: `Invalid response mode: ${patch.responseMode}` }
  }
  let nextSpeakOrder: string[] | undefined
  if (patch.speakOrder !== undefined) {
    if (!Array.isArray(patch.speakOrder)) {
      return { success: false, error: 'speakOrder must be an array' }
    }
    nextSpeakOrder = [...new Set(patch.speakOrder.filter(id => typeof id === 'string' && id.length > 0))]
  }
  if (
    patch.relayLoops !== undefined
    && (!Number.isFinite(patch.relayLoops) || patch.relayLoops < 0)
  ) {
    return { success: false, error: 'relayLoops must be a number >= 0' }
  }

  const previousResponseMode = session.room.responseMode
  const nextResponseMode = patch.responseMode ?? previousResponseMode
  const previousRelayLoops = session.room.relayLoops
  const nextRelayLoops = patch.relayLoops !== undefined
    ? Math.floor(patch.relayLoops)
    : previousRelayLoops
  const previousSpeakOrder = session.room.speakOrder ?? []
  const effectiveSpeakOrder = nextSpeakOrder ?? previousSpeakOrder
  // 名册相等是**集合**相等(换个顺序不算改),次序表相等是**序列**相等 —— 换个
  // 顺序正是这张表存在的全部意义。两处不能共用一个判据。
  const speakOrderChanged = nextSpeakOrder !== undefined
    && (nextSpeakOrder.length !== previousSpeakOrder.length
      || nextSpeakOrder.some((agentId, index) => previousSpeakOrder[index] !== agentId))
  const relayChanged = nextResponseMode !== previousResponseMode
    || nextRelayLoops !== previousRelayLoops
    || speakOrderChanged

  // Roster equality is SET equality: re-sending the same members in another
  // order is not a membership change and must not post a 群公告 (or rewrite
  // the room). Only joins and departures count.
  const membersChanged = nextMembers !== previousMembers
    && (nextMembers.length !== previousMembers.length
      || nextMembers.some(id => !previousMembers.includes(id)))
  const pmChanged = nextPm !== previousPm

  if (membersChanged || pmChanged || relayChanged) {
    const room = { ...session.room, memberAgentIds: [...nextMembers] }
    /**
     * 被移出的人留一条 `{agentId, removedAt}`(collab-history-search.md §3)。
     *
     * 历史检索的授权判据靠它回答「这位同事能看到这间房到什么时候」——当前成员
     * 全部可见,被移出的只到这一刻为止。**只追加不删除**:同一个人移出→拉回→
     * 再移出会留下多条,读时取最后一次(`collabRoomVisibleUntil`)。
     *
     * 写在这里而不是下面那个发系统行的分支里:`room` 这个对象只在这一处被组装
     * 与持久化,判据也只有 `membersChanged` 这一个。同一件事分两处判定 = 迟早
     * 分家 —— 这个仓库刚为同类问题付过两天代价。
     */
    if (membersChanged) {
      const removed = previousMembers.filter(id => !nextMembers.includes(id))
      if (removed.length > 0) {
        const removedAt = Date.now()
        room.formerMembers = [
          ...(session.room.formerMembers ?? []),
          ...removed.map(agentId => ({ agentId, removedAt })),
        ]
      }
    }
    if (nextPm) room.pmAgentId = nextPm
    else delete room.pmAgentId
    if (nextResponseMode) room.responseMode = nextResponseMode
    else delete room.responseMode
    if (effectiveSpeakOrder.length > 0) room.speakOrder = [...effectiveSpeakOrder]
    else delete room.speakOrder
    if (typeof nextRelayLoops === 'number') room.relayLoops = nextRelayLoops
    else delete room.relayLoops
    if (!store.updateSessionCollab(roomSessionId, { room })) {
      return { success: false, error: 'Failed to update room' }
    }
  }

  if (patch.permissionMode !== undefined && patch.permissionMode !== session.permissionMode) {
    store.updateSessionPermissionMode(roomSessionId, patch.permissionMode)
  }
  if (nextName && nextName !== session.name) {
    store.renameSession(roomSessionId, nextName)
  }

  if (membersChanged || pmChanged) {
    const roster = [...new Set([...previousMembers, ...nextMembers])]
      .map(agentId => findAgent(agentId))
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
      .map(agent => ({ id: agent.id, name: agent.name, avatar: agent.avatar }))
    for (const line of buildCollabMembershipLines({
      previousMemberIds: previousMembers,
      nextMemberIds: nextMembers,
      previousPmAgentId: previousPm,
      nextPmAgentId: nextPm,
      agents: roster,
    })) {
      postSystemLine(roomSessionId, line, COLLAB_SYSTEM_SOURCE_MEMBERSHIP)
    }
    if (membersChanged) clearTypingForNonMembers(roomSessionId, nextMembers)
  }

  /**
   * 名册变了,**同事那侧**也要知道(D6-b 收口)。
   *
   * 上面那几行群公告是给人看的 —— 它落在房间转录里,而同事读的是自己的折叠信封。
   * 少了这一投,一位同事会在名册已经变了之后继续 @ 一个上周就离开的人:那件事
   * 从来没有出现在它的上下文里。协议动词与折叠都早就有了,缺的一直是生产者。
   *
   * 排在群公告之后:两条路最终都进模型的下一轮,而"先看到转录里那一行"与真机
   * 的观感一致。空变更(只改了房名/预算)不投信。
   */
  if (membersChanged) {
    const joined = nextMembers.filter(id => !previousMembers.includes(id))
    const left = previousMembers.filter(id => !nextMembers.includes(id))
    void postCollabV3MembershipChanged(roomSessionId, joined, left).catch((error: unknown) => {
      log.error('post membership change failed', { roomSessionId }, error)
    })
  }

  /**
   * 响应模式三件套改了 → **立刻换档**(D6 接线遗漏的补口)。
   *
   * 上面那几行只把字段写进了会话;发言策略住在 v3 房账里(`ring` 的环位、`waves`
   * 的批位是账的一部分,不能每次决策现读设置),所以要显式推一次 —— 少这一推,
   * 一个刚拨到"接力"的开关要等到下次重启才有反应,而那正是 D6 漏掉的那一格。
   *
   * 名册变化不必推:环是每次决策按当时的在职名册现构的(`buildCollabRelayRing`),
   * `speakOrder` 定的只是**已列出者的相对次序**。
   *
   * 不 await:换档要写账、要广播,而这扇门对调用方(IPC / daemon)是同步的。失败
   * 只影响这一次即时生效,下一次开箱的 `syncFloorPolicy()` 仍会补上。
   */
  if (relayChanged) {
    void syncCollabV3RoomFloorPolicy(roomSessionId).catch((error: unknown) => {
      log.error('sync floor policy failed', { roomSessionId }, error)
    })
  }

  // 模式、次序表、名册都改状态条的样子(接力那一段整段出现或消失)。
  broadcastCollabCoordinator(roomSessionId)
  // 会话列表那一侧(成员条、房名、设置面板)从此吃这条推送,而不是每个写入方
  // 自己 `loadSessions()` 全量重拉(C4 §3)。
  emitCollabRoomUpdated(roomSessionId)
  return { success: true }
}

/** A queued-but-removed member stops "typing" immediately. Since W19 a merely
 *  -queued member has no light to clear (nothing lights until its `say`
 *  streams), so this is 兜底 for stale trues, not the mechanism. */
function clearTypingForNonMembers(roomSessionId: string, members: readonly string[]): void {
  for (const turn of collabV3TurnsInRoom(roomSessionId)) {
    if (!members.includes(turn.agentId)) emitCollabTyping(roomSessionId, turn.agentId, false)
  }
}

/** Soft reminder line for long-pending worker permission asks (D8 30min). */
export function postCollabSystemLine(roomSessionId: string, content: string): void {
  if (store.getSession(roomSessionId)?.kind !== 'room') return
  postSystemLine(roomSessionId, content)
}

/**
 * 预算可配置(用户要求):只改给定字段;0 = 关闭该闸。生效即时(缓存失效)。
 *
 * 参数类型直接吃 shared 的 `CollabRoomBudgetsPatch` —— 这里以前是一份手写的同形
 * 接口,而中转层同时也在逐字段手抄,于是 `maxConcurrentTurns` 悄悄丢了几个月。
 * 一份类型 + 整体透传,那种漏抄不再有藏身处。下面每个字段的取值校验照旧:形状
 * 由类型保证,**取值**由这里保证。
 */
export function setCollabRoomBudgets(
  roomSessionId: string,
  budgets: CollabRoomBudgetsPatch,
): boolean {
  const session = store.getSession(roomSessionId)
  if (!session || session.kind !== 'room' || !session.room) return false
  const next = { ...(session.room.budgets ?? {}) }
  if (budgets.dailyCostUSD !== undefined && Number.isFinite(budgets.dailyCostUSD) && budgets.dailyCostUSD >= 0) {
    next.dailyCostUSD = budgets.dailyCostUSD
  }
  if (budgets.maxChain !== undefined && Number.isFinite(budgets.maxChain) && budgets.maxChain >= 0) {
    next.maxChain = Math.floor(budgets.maxChain)
  }
  // 回合断路器上限 (W22): same 0 = 关闭 shape as the gates above. Takes effect on
  // the next turn — the breaker reads its caps when the turn window opens.
  if (
    budgets.maxTurnToolCalls !== undefined
    && Number.isFinite(budgets.maxTurnToolCalls)
    && budgets.maxTurnToolCalls >= 0
  ) {
    next.maxTurnToolCalls = Math.floor(budgets.maxTurnToolCalls)
  }
  if (
    budgets.maxTurnSayCalls !== undefined
    && Number.isFinite(budgets.maxTurnSayCalls)
    && budgets.maxTurnSayCalls >= 0
  ) {
    next.maxTurnSayCalls = Math.floor(budgets.maxTurnSayCalls)
  }
  // 同时发言上限(并行化)。0 = 不限,与本族其它闸同一套约定;下一次发牌现取。
  if (
    budgets.maxConcurrentTurns !== undefined
    && Number.isFinite(budgets.maxConcurrentTurns)
    && budgets.maxConcurrentTurns >= 0
  ) {
    next.maxConcurrentTurns = Math.floor(budgets.maxConcurrentTurns)
  }
  const updated = store.updateSessionCollab(roomSessionId, {
    room: { ...session.room, budgets: next },
  })
  if (updated) {
    // 新额度立刻生效:两处 60s 缓存(费用闸的读数、v3 房账那侧的判据)都失效,
    // 否则一个刚被抬高的上限还要等最多一分钟才拦不住人。
    forgetCollabRoomBudgetCache(roomSessionId)
    forgetCollabV3RoomBudget(roomSessionId)
    broadcastCollabCoordinator(roomSessionId)
    // 预算同样是会话列表读的房间字段(看板面板的预算格)(C4 §3)。
    emitCollabRoomUpdated(roomSessionId)
  }
  return updated
}
