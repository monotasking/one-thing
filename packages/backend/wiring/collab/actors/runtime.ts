/**
 * Collab v3 的**生产装配**(docs/design/collab-actor-v3.md §6 D6)。
 *
 * D0-D5 把五个 actor、四个生产适配器、一个迁移器全写好了,而且一个生产调用点都
 * 没有 —— v2 的调度链一直是生产。这个文件就是那一刀:`createOnethingBackend`
 * 从此起 v3 运行时,v2 的 `initializeCollabCoordinator` 不再被调用(代码与测试
 * 都留着,删除是 D6-b)。
 *
 * ## 这里做的四件事
 *
 *  1. **迁移**(marker 门控,一趟单向门):v2 的房间账 → v3 的房账 + agent 账 +
 *     未读回填。已经迁过的机器整体跳过 —— 判据在 `migrate.ts` 自己身上,这里只
 *     负责「boot 时调一次」;
 *  2. **起 actor**:每间协作房一个 `RoomActor`(账落盘 + 广播续播),每位在职
 *     同事一个 `AgentActor`(持久信箱开箱),外加**一个**跨房的 `RefereeActor`;
 *  3. **接口子**:四个生产适配器(engine-mind-port / worker-mind-port /
 *     referee-judge / board 端口)在这里被第一次调用;发言口注册进
 *     `turn-context.ts`,say 工具从此走租约;
 *  4. **收摊**:顺序与 v2 协调器同一套纪律 —— 先上闩(令牌作废、发言口摘下),
 *     再停循环,最后清表。
 *
 * ## 为什么 actor 是**懒**建的
 *
 * boot 时把每间房、每位同事都建出来是一次全量磁盘往返(每个 agent 一个
 * `DurableMailbox.open` = 一次 jsonl 扫描)。真机上一台机器可能有几十间房而当天
 * 只用到两间。所以:boot 只做迁移 + 订阅 + 续播已有的房账;actor 在**第一次被
 * 寻址**时开箱(`ensureRoom` / `ensureAgent`),而两个入口都是 `async`,懒建因此
 * 不需要任何"先注册后使用"的时序约定。
 *
 * 一个例外:`RoomActorHost.memberMailbox` 是同步口。它返回的 `append` 是异步的,
 * 于是开箱推迟到 append 里 —— 房间因此不必知道信箱是不是已经开过。
 */
import { randomUUID } from 'node:crypto'

import {
  DurableMailbox,
  createActorEvent,
  type ActorEvent,
} from '@onething/core/actors'
import {
  COLLAB_DEFAULT_DAILY_COST_USD,
  buildCollabDriveRoomContext,
  buildCollabReplyToSnapshot,
  buildCollabTaskInterruptedLine,
  collectCollabFoldedFacts,
  formatCollabAdoptedEcho,
  formatCollabUserLabel,
  isAgentPairDmRoom,
  isCollabRoomFact,
  isUserDmRoom,
  planCollabHistoryWindow,
  renderCollabBoardDigest,
  wrapCollabMessageEnvelope,
  type CollabAgentLike,
  type CollabMessageLike,
} from '@onething/runtime/collab'
import {
  collabActorRef,
  collabAgentSpawnWorker,
  collabRoomCardEvent,
  collabRoomMembershipChanged,
  collabRoomPosted,
  collabAgentSpeak,
  collabRoomActiveLeases,
  collabWorkerRunningForCard,
  collabSchedulerJudgeDegraded,
  collabSchedulerJudgeVerdict,
  createCollabHeuristicHandEvaluator,
  createCollabRoomAccount,
  resolveCollabRoomFloorPolicy,
  type CollabActorVerb,
  type CollabAgentWorkerRecord,
  type CollabCardEventKind,
  type CollabHandEvaluator,
  type CollabRaisedHand,
  type CollabRoomAccount,
  type CollabRoomEffects,
  type CollabRoomJudgmentRequest,
} from '@onething/runtime/collab/actors'
import {
  isActiveAgent,
  type ChatMessage,
  type CollabCoordinatorState,
  type CollabRoomRevokeLeaseRequest,
  type CollabRoomRevokeLeaseResult,
} from '@shared/ipc.js'

import {
  broadcastCollabAgentActivity,
  configureCollabAgentActivitySource,
  shutdownCollabAgentActivity,
  type CollabAgentActivityView,
} from '../agent-activity.js'
import {
  configureCollabExternalLogSink,
  installCollabExternalObservers,
} from '../external-observability.js'
import { findAgent, listAgents } from '../../agents/index.js'
import { getEventBus } from '../../../events/index.js'
import { getStreamEngineSafe } from '../../../engine/index.js'
import * as store from '../../../store.js'
import { sessionCommands } from '../../../session/commands.js'
import { sessionReads } from '../../../session/reads.js'
import { advanceSeenCursor, ensureCollabAgentSession } from '../agent-session.js'
import {
  forgetCollabBoardRoom,
  getCollabTask,
  loadCollabBoard,
  onCollabBoardEvent,
  patchCollabTask,
  shutdownCollabBoardBroadcasts,
} from '../board-store.js'
import { readCollabRoomSpentTodayUSD } from '../budget.js'
import { getCollabDigestsForDays } from '@onething/runtime/collab/digest-store'
import { configureCollabDriveGuard } from '@onething/runtime/collab/drive-guard'
import { buildCollabIdentityDirectory } from '../identity-directory.js'
import {
  broadcastCollabCoordinator,
  configureCollabRoomSnapshotSource,
  forgetCollabInspector,
  shutdownCollabInspector,
} from '../inspector.js'
import { collabRoomMembers } from '../members.js'
import {
  deleteRoomRuntime,
  maxChainFor,
  maxConcurrentTurnsFor,
  postSystemLine,
  postTaskSystemLine,
  removeCollabRoomDirectory,
} from '../room-runtime.js'
import { collabUserPromptFields, resolveUserIdentity } from '../user-identity.js'
import { clearCollabWakeFollowups } from '../wake-followup.js'
import {
  CollabAgentActor,
  type CollabAgentActorHost,
  type CollabAgentRoomContextInput,
} from '@onething/runtime/collab/actors/agent-actor'
import { openCollabAgentMailbox } from '@onething/runtime/collab/actors/agent-mailbox'
import { createCollabEngineMindPort } from './engine-mind-port.js'
import type { CollabMindPort } from '@onething/runtime/collab/actors/mind-port'
import { createCollabNotebookFileStore } from '@onething/runtime/collab/actors/notebook-store'
import {
  CollabRefereeActor,
  type CollabRefereeActorHost,
  type CollabRefereeJudgePort,
} from '@onething/runtime/collab/actors/referee-actor'
import { createCollabEngineRefereeJudgePort } from './referee-judge.js'
import { collabRoomActorsDir, createCollabRoomAccountFileStore } from '@onething/runtime/collab/actors/room-account'
import { CollabRoomActor, type CollabRoomActorHost } from '@onething/runtime/collab/actors/room-actor.wiring'
import {
  createCollabDeadLetterSink,
  createCollabSchedulerLogFileStore,
  sweepCollabSchedulerLogs,
  type CollabSchedulerLogStore,
} from '@onething/runtime/collab/actors/scheduler-log'
import {
  clearCollabV3Turns,
  collabV3TurnsInRoom,
  findCollabV3Turn,
  configureCollabV3RoomPostPort,
  configureCollabV3RoomResetPort,
  configureCollabV3SpeakPort,
  configureCollabV3TurnObserver,
  type CollabV3SpeakInput,
  type CollabV3SpeakResult,
} from '@onething/runtime/collab/actors/turn-context.wiring'
import {
  createCollabWorkerSlotLedger,
  type CollabWorkerBoardPort,
  type CollabWorkerMindPort,
  type CollabWorkerSlotLedger,
} from '@onething/runtime/collab/actors/worker-child'
import { createCollabEngineWorkerPort } from './worker-mind-port.js'
import { migrateCollabToV3 } from './migrate.js'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.runtime')


/** 预算读数的缓存窗口。与 v2 费用闸同一个数 —— 两代对同一笔钱不该有两种口径。 */
const BUDGET_CACHE_MS = 60_000
/** 裁判的房间尾巴取多少条(压缩窗在纯层再裁一次)。 */
const REFEREE_RECENT_LIMIT = 40

interface RoomEntry {
  roomId: string
  actor: CollabRoomActor
  mailbox: DurableMailbox<ActorEvent<CollabActorVerb>>
}

interface AgentEntry {
  agentId: string
  actor: CollabAgentActor
  mailbox: DurableMailbox<ActorEvent<CollabActorVerb>>
}

interface BudgetCell {
  spentUSD: number
  checkedAt: number
  reading?: Promise<number>
  noticedDay?: string
}

interface RuntimeState {
  rooms: Map<string, RoomEntry>
  agents: Map<string, AgentEntry>
  roomPending: Map<string, Promise<RoomEntry | undefined>>
  agentPending: Map<string, Promise<AgentEntry | undefined>>
  budget: Map<string, BudgetCell>
  /**
   * 每间房那扇**还没去买**的裁决窗(见 `scheduleJudgment`)。
   *
   * `opensAt` 是这一拍的到期时刻 —— 房间快照的 `judgment: 'debouncing'` 读它。
   * 防抖窗在房账里没有对应字段(房间是事件驱动开窗,不防抖),它是**运行时**的
   * 状态:钱还没花出去。少了这一格,「防抖」与「在飞」在界面上长得一模一样,
   * 而它们的等待理由完全不同(一个几十毫秒后自解,一个正在烧一次模型调用)。
   */
  judgments: Map<string, {
    timer: ReturnType<typeof setTimeout>
    request: CollabRoomJudgmentRequest
    opensAt: number
  }>
  slots: CollabWorkerSlotLedger
  referee: CollabRefereeActor
  /** 调度时间轴的落盘面(D8 §3.3)。三个产生点共用同一个实例。 */
  schedulerLog: CollabSchedulerLogStore
  disposers: Array<() => void>
  /** 收摊闩:置位之后不再开新 actor,在飞的收尾照常跑完。 */
  stopping: boolean
  ports: { mind: CollabMindPort; worker: CollabWorkerMindPort }
}

let state: RuntimeState | null = null
let booting: Promise<void> | null = null

/* ── 生命周期 ─────────────────────────────────────────────────────────── */

export interface CollabV3RuntimeOptions {
  /**
   * boot 时执行迁移(marker 门控)。默认 **true**。
   *
   * 关掉它的唯一用途是测试与排障:一趟单向门在生产里没有"要不要走"的选择,
   * 走没走过由 marker 说了算。
   */
  migrate?: boolean
  /**
   * 三个端口的替身(**测试与重放专用**,生产一个都不传)。
   *
   * 装配级测试要问的是"用户消息 → 裁决 → 授牌 → 说话 → 广播 → 水位"这条环闭不
   * 闭得上,而不是"今天这个模型想说什么"。端口存在的全部理由就是让这条缝在接线
   * 之后依然可用 —— 生产适配器在缺省档里,一行都不会因为测试而改形状。
   */
  ports?: {
    mind?: CollabMindPort
    judge?: CollabRefereeJudgePort
    worker?: CollabWorkerMindPort
  }
}

/** 起来了吗。say 工具与私聊执行器按它决定走 v3 还是回落 v2 落库路径。 */
export function isCollabV3RuntimeRunning(): boolean {
  return state !== null
}

/**
 * 起 v3 运行时。**幂等**:重复调用等同一个 promise,marker 门控保证迁移只跑一次。
 */
export function initializeCollabV3Runtime(
  options: CollabV3RuntimeOptions = {},
): Promise<void> {
  if (booting) return booting
  booting = boot(options).catch((error: unknown) => {
    booting = null
    throw error
  })
  return booting
}

async function boot(options: CollabV3RuntimeOptions): Promise<void> {
  if (state) return

  // ① 迁移排在**任何 actor 开箱之前**:一间房的 v3 账要么由迁移器写出来,要么
  //    是全新的空账 —— 中间不能有第三种(actor 先建了一份空账,迁移器随后判定
  //    "已有 v3 账"跳过,那间房的 v2 历史就永久丢在门外了)。
  if (options.migrate !== false) {
    try {
      const report = await migrateCollabToV3({ dryRun: false })
      if (!report.skipped) {
        log.info('collab v3 migration complete', { totals: report.totals })
      }
    } catch (error) {
      // 迁移炸了不阻断启动:v3 会以空账起跑(房间历史仍在转录里,只是未读水位
      // 从头算)。让整个应用起不来是更贵的失败。
      log.error('collab v3 migration failed, continuing with empty ledger', {}, error)
    }
  }

  const slots = createCollabWorkerSlotLedger()
  const ports = {
    mind: options.ports?.mind ?? createCollabEngineMindPort(),
    worker: options.ports?.worker ?? createCollabEngineWorkerPort(),
  }
  const schedulerLog = createCollabSchedulerLogFileStore()
  const runtime: RuntimeState = {
    rooms: new Map(),
    agents: new Map(),
    roomPending: new Map(),
    agentPending: new Map(),
    budget: new Map(),
    judgments: new Map(),
    slots,
    referee: new CollabRefereeActor({
      refereeId: 'referee',
      host: refereeHost(),
      judge: options.ports?.judge ?? createCollabEngineRefereeJudgePort(),
      // 裁决的三格(why / elapsedMs / model)在这里被接住 —— 时间轴上
      // `judge-verdict` / `judge-degraded` 两类行的唯一产生点(D8 §3.3)。
      onJudged: trace => {
        schedulerLog.append(trace.roomId, trace.degraded
          ? collabSchedulerJudgeDegraded({
              at: Date.now(),
              token: trace.token,
              reason: trace.reason ?? 'unreadable',
              elapsedMs: trace.elapsedMs,
              triggeredBy: trace.token,
            })
          : collabSchedulerJudgeVerdict({
              at: Date.now(),
              token: trace.token,
              order: [...trace.grants],
              elapsedMs: trace.elapsedMs,
              ...(trace.why ? { why: trace.why } : {}),
              ...(trace.model ? { model: trace.model } : {}),
              triggeredBy: trace.token,
            }))
      },
    }),
    disposers: [],
    stopping: false,
    ports,
    schedulerLog,
  }
  state = runtime

  // 清老:14 天前的时间轴文件。**在开箱之前**跑一次 —— 一间房刚被开箱就往
  // 今天的文件里追加,而清老扫的是整个 collab 目录,顺序反了会多扫一遍新写的文件。
  try {
    sweepCollabSchedulerLogs()
  } catch (error) {
    log.warn('scheduler timeline sweep failed', {}, error)
  }

  // ② 令牌:与 v2 同一把锁、同一个门面(`drive-guard.ts`)。引擎的房/exec 两道
  //    门认的是"这一条命令带的令牌等于本进程当前发出去的那一个",而令牌的
  //    **来源**从 v2 协调器换成了 v3 运行时 —— 门一行不用改,凭据换了发行方。
  configureCollabDriveGuard(randomUUID())
  // ③ 两个口子:say 工具从此在 v3 回合里走租约,入口与跨房落库之后投信进房
  //    (见 `turn-context.ts` 的文件头 —— 为什么是端口而不是直接 import)。
  configureCollabV3SpeakPort(speak)
  configureCollabV3RoomPostPort(async (roomSessionId, message) => {
    await postCollabV3RoomMessage(roomSessionId, message)
  })
  configureCollabV3RoomResetPort(resetRoomAccount)
  // ④ 状态条:C4 快照协议的供数改由房账出(seq / typing / 「刚才」仍归 inspector,
  //    见 `configureCollabRoomSnapshotSource` 的注释)。
  configureCollabRoomSnapshotSource(roomId => roomSnapshotOf(runtime, roomId))
  // ④' Agent 视角(D8 §3.1):另一本账,九格全部现算,供数口的实现在下面。
  configureCollabAgentActivitySource({
    agent: agentId => agentActivityViewOf(runtime, agentId),
    agentIds: () => [...runtime.agents.keys()],
    rooms: () => collabRoomAccountsOf(runtime),
    now: () => Date.now(),
  })
  // ④'' 回合登记簿:起落两端各推一次(房间那侧的 `executing`、agent 那侧的
  //     `mind` 同时翻面)。在 D8 之前这张表是零广播的,于是「持牌 N · 生成中 M」
  //     里的 M 是个要等别的事顺带播一遍才会动的死数字。
  configureCollabV3TurnObserver(turn => {
    broadcastCollabCoordinator(turn.roomSessionId, { activity: true })
    broadcastCollabAgentActivity(turn.agentId, { activity: true })
  })
  // ④''' 外部通路的观测面(E6,§6):外部回合的起落、每一次工具决定、每一次提问
  //      都进这本时间轴。写入口在这里装 —— 它与账本同生同灭,而不是让一个还在飞的
  //      外部回合往一份已经收摊的运行时里记账。
  configureCollabExternalLogSink(schedulerLog)
  runtime.disposers.push(installCollabExternalObservers())
  // ④'''' 提问的那盏灯(E2 §4):房间转录落一行「XX 正在等你回答」。
  //
  //      为什么在这里而不是在观测面里:提问跑在 `kind:'agent'` 的执行会话上,
  //      而人看的是房 —— 不落这一行,房里就只剩一段静默(那个人还持着牌,确实
  //      还在这一轮,但屏幕上没有任何东西说它在等谁)。而**说话要名册**,把名册
  //      拖进观测面就等于让「记一笔账」把半个主进程拉起来 —— 记账与说话是两件事。
  //      这里则本来就既有名册又有系统行出口。
  //
  //      与预算、断路器同一类机械台账,所以走 `postSystemLine`(display-only,
  //      不进模型投影):这不是房里的一句发言,是一盏灯。只在提问**开**的那一刻
  //      落一行 —— 收场时卡片自己会变成历史态,再补一行只是把转录撑长。
  runtime.disposers.push(getEventBus().onAnySession(SESSION_EVENT_TYPES.INTERACTION_REQUESTED, envelope => {
    const turn = findCollabV3Turn(envelope.sessionId)
    if (!turn) return
    const name = findAgent(turn.agentId)?.name ?? turn.agentId
    postSystemLine(turn.roomSessionId, `${name} 正在等你回答`)
  }, 'collab-v3-interaction-notice'))

  // ⑤ 删房:actor 跟着走。房目录整个被删掉(`removeCollabRoomDirectory`),
  //    v3 的账与信箱就在那个目录下,所以这里只需要把内存里的循环停掉。
  runtime.disposers.push(store.onSessionsDeleted(sessionIds => {
    for (const sessionId of sessionIds) void disposeRoom(sessionId)
  }))

  // ⑥ 看板:开工是一个动作(collab-team-v2 §3)。`task-started` 派一只手,
  //    其余板事件只是**卡的动静** —— 进房间当 `room:card-event`,由各成员的
  //    折叠信封在下一轮 drive 里读到。
  runtime.disposers.push(onCollabBoardEvent((roomSessionId, event) => {
    void handleBoardEvent(roomSessionId, event).catch((error: unknown) => {
      log.error('board event handling failed', { roomSessionId }, error)
    })
  }))

  // ⑦ 续播:每间已有 v3 账的房把没投完的广播接着投完。**只对已经有账的房**开箱
  //    ——一间从没被驱动过的房没有在飞广播,为它开一次信箱是纯浪费。
  await resumeKnownRooms()
}

/**
 * 收摊。顺序照 v2 协调器那套纪律:**先上闩,再停循环,最后清表**。
 *
 * 上闩在最前面 —— 一条已经排到 `emitDrive` 门口的 drive 不该活过它的发行方。
 */
export async function shutdownCollabV3Runtime(): Promise<void> {
  const runtime = state
  booting = null
  if (!runtime) return
  runtime.stopping = true

  // 闩:令牌作废(任何 drive 从此过不了引擎的房门)、发言口摘下(say 回落 v2
  // 落库路径)、快照源摘下(状态条回到 v2 的 inspector 视图)。
  configureCollabDriveGuard(null)
  configureCollabV3SpeakPort(null)
  configureCollabV3RoomPostPort(null)
  configureCollabV3RoomResetPort(null)
  configureCollabRoomSnapshotSource(null)
  configureCollabAgentActivitySource(null)
  configureCollabV3TurnObserver(null)
  configureCollabExternalLogSink(null)

  for (const dispose of runtime.disposers) {
    try { dispose() } catch { /* noop */ }
  }
  runtime.disposers = []
  /**
   * 三样带定时器的东西跟着收摊(与 v2 协调器逐条对齐 —— 它们在 v3 里仍然是生产)。
   *
   *  - 状态条的节流待发:一发已经排好的广播不该活过它要描述的那个运行时;
   *  - 看板的合并广播:同上;
   *  - 还在等对方读完的跨房唤醒:它的 120s 定时器到点会往房里发一条 poke,而那时
   *    已经没有房间在听了(collab-send-channel-and-wake.md §3.2)。
   */
  shutdownCollabInspector()
  shutdownCollabAgentActivity()
  shutdownCollabBoardBroadcasts()
  clearCollabWakeFollowups()
  // 还没去买的裁决窗跟着收摊:一次网络往返不该活过它的发行方(v2 那侧的
  // `runtime.judgements.abort()` 是同一条纪律)。
  for (const entry of runtime.judgments.values()) clearTimeout(entry.timer)
  runtime.judgments.clear()

  // 先停 agent 再停房:agent 的收尾会往房间投交牌信,反过来的话那几封信投进
  // 一个已经关掉的信箱(`append after close`),而它们本可以被正常处理掉。
  for (const entry of runtime.agents.values()) {
    try { await entry.actor.stop() } catch (error) {
      log.error('agent stop failed', { agentId: entry.agentId }, error)
    }
  }
  for (const entry of runtime.rooms.values()) {
    try { await entry.actor.stop() } catch (error) {
      log.error('room stop failed', {}, error)
    }
  }
  // 在途的追加写落盘再走。`close()` 只停迭代,不等写链 —— 一封已经排在链上的信
  // 会在进程收摊之后才落地,而那时它的目录可能已经被删房带走了。
  for (const entry of [...runtime.agents.values(), ...runtime.rooms.values()]) {
    try { await entry.mailbox.flush() } catch { /* 写不进去就算了,账已经在盘上 */ }
  }

  clearCollabV3Turns()
  runtime.rooms.clear()
  runtime.agents.clear()
  runtime.roomPending.clear()
  runtime.agentPending.clear()
  runtime.budget.clear()
  state = null
}

/**
 * 一间房没了 —— 它在会话文件之外拥有的每一样东西(D6-b 从 v2 协调器接手)。
 *
 * 跑在**删除之后**,所以会话已经不在了、`kind` 查不到 —— 这是刻意的:每一步对
 * 一个从没有过协作状态的 id 都是空操作,而"从名字猜它是不是房"比白跑四次更糟。
 *
 * 顺序有讲究:内存里的循环先停(它还可能往目录里写账),再删目录。反过来的话
 * 一次收尾写入会把刚删掉的目录重新造出来,留下一个只有半个文件的孤儿房。
 */
async function disposeRoom(roomId: string): Promise<void> {
  const runtime = state
  const entry = runtime?.rooms.get(roomId)
  if (runtime && entry) {
    runtime.rooms.delete(roomId)
    runtime.roomPending.delete(roomId)
    runtime.budget.delete(roomId)
    const judgment = runtime.judgments.get(roomId)
    if (judgment) {
      clearTimeout(judgment.timer)
      runtime.judgments.delete(roomId)
    }
    try { await entry.actor.stop() } catch { /* 房已经没了,停不动也不必再管 */ }
  }
  // 三张进程内的表 + 磁盘上那个目录(state.json / board.json / activity.jsonl /
  // actors/)。它们此前挂在 v2 协调器的 `disposeCollabRoom` 上,而那个文件在
  // D6-b 被删掉了 —— 少接这一段,删房会在内存与磁盘上各留一份永远查不到的残骸。
  forgetCollabBoardRoom(roomId)
  forgetCollabInspector(roomId)
  deleteRoomRuntime(roomId)
  removeCollabRoomDirectory(roomId)
}

/* ── actor 开箱 ───────────────────────────────────────────────────────── */

async function ensureRoom(roomId: string): Promise<RoomEntry | undefined> {
  const runtime = state
  if (!runtime || runtime.stopping) return undefined
  const existing = runtime.rooms.get(roomId)
  if (existing) return existing
  const pending = runtime.roomPending.get(roomId)
  if (pending) return pending
  if (store.getSession(roomId)?.kind !== 'room') return undefined

  const task = (async (): Promise<RoomEntry | undefined> => {
    const mailbox = await DurableMailbox.open<ActorEvent<CollabActorVerb>>({
      dir: collabRoomActorsDir(roomId),
      ownerId: roomId,
    })
    const actor = new WiredRoomActor({
      roomId,
      host: roomHost(),
      mailbox,
      schedulerLog: runtime.schedulerLog,
      onDeadLetter: deadLetterSink(`room:${roomId}`, roomId),
    })
    const entry: RoomEntry = { roomId, actor, mailbox }
    runtime.rooms.set(roomId, entry)
    // 续播在起循环**之前**:账里那几条在飞广播是上一条命留下的,先补完再收新信,
    // 成员看到的次序才与崩溃前一致。
    await actor.resumeBroadcasts()
    // 再把设置里的响应模式打进账(D6 接线)。排在续播**之后**:那几条广播是上
    // 一档留下的事实,先补完再换档;排在起循环**之前**:第一条新消息就该按新档走。
    // 设置没变(绝大多数情况)时它是一次纯比较,连账都不写。
    await actor.syncFloorPolicy()
    actor.start()
    return entry
  })()

  runtime.roomPending.set(roomId, task)
  try {
    return await task
  } finally {
    runtime.roomPending.delete(roomId)
  }
}

async function ensureAgent(agentId: string): Promise<AgentEntry | undefined> {
  const runtime = state
  if (!runtime || runtime.stopping) return undefined
  const existing = runtime.agents.get(agentId)
  if (existing) return existing
  const pending = runtime.agentPending.get(agentId)
  if (pending) return pending
  const agent = findAgent(agentId)
  // 退休的人不开循环(域模型 §3.2):它不被提名、不被发牌,一条为它开着的心智
  // 循环只会占着一份信箱句柄。
  if (!agent || !isActiveAgent(agent)) return undefined

  const task = (async (): Promise<AgentEntry | undefined> => {
    const mailbox = await openCollabAgentMailbox(agentId)
    const actor = new CollabAgentActor({
      agentId,
      host: agentHost(),
      mindPort: runtime.ports.mind,
      notebook: createCollabNotebookFileStore(),
      mailbox,
      handEvaluator: wiredHandEvaluator(),
      worker: {
        port: runtime.ports.worker,
        board: boardPort(),
        // 全局并发那本账必须是**同一个实例**,不然"全局"就退化成 per-agent。
        slots: runtime.slots,
        postResult: verb => postToAgent(agentId, verb, collabActorRef('worker', verb.workerId)),
      },
      onTurnFailure: failure => {
        log.error('agent turn failed', { agentId, roomId: failure.roomId }, failure.error)
      },
      onWorkerFailure: failure => {
        log.error('agent worker failed', { agentId, workerId: failure.workerId }, failure.error)
      },
      schedulerLog: runtime.schedulerLog,
      onDeadLetter: deadLetterSink(`agent:${agentId}`, undefined, agentId),
      /**
       * D8 §3.1 的发射点接线。档位按转变认:大脑 / 牌 / 手是界面上会**动**的东西
       * (成员条那四态徽标读的就是它们),走 120ms;`inbox` 是一个数字,走秒。
       */
      onActivity: transition => {
        broadcastCollabAgentActivity(agentId, { activity: transition !== 'inbox' })
      },
    })
    const entry: AgentEntry = { agentId, actor, mailbox }
    runtime.agents.set(agentId, entry)
    actor.start()
    // 重启对账:上一条命里还在跑的手全部标断,卡推回"没人在做"。**不 await**
    // 起循环 —— 对账要写板,而板的写队列是异步的。
    void actor.recoverWorkers().catch((error: unknown) => {
      log.error('worker recovery after restart failed', { agentId }, error)
    })
    return entry
  })()

  runtime.agentPending.set(agentId, task)
  try {
    return await task
  } finally {
    runtime.agentPending.delete(agentId)
  }
}

/**
 * 已有 v3 账的房:开箱 + 续播。
 *
 * 判据是**会话列表里的 room**,不是磁盘上的账文件:一间刚被建出来、还没有账的房
 * 同样要能收信,而 `ensureRoom` 对两者是同一条路。列表通常只有几十项,开箱的代价
 * 由 `DurableMailbox.open` 承担(一次 jsonl 扫描),所以只在 boot 走一遍。
 */
async function resumeKnownRooms(): Promise<void> {
  let metas: Array<{ id: string; kind?: string }> = []
  try {
    metas = store.getSessionsList() as Array<{ id: string; kind?: string }>
  } catch (error) {
    log.error('sessions list read failed', {}, error)
    return
  }
  for (const meta of metas) {
    if (meta.kind !== 'room') continue
    try {
      await ensureRoom(meta.id)
    } catch (error) {
      log.error('room resume failed', { roomSessionId: meta.id }, error)
    }
  }
}

/**
 * 房间的决策每一步都推一次状态条。
 *
 * 挂在 `decide` 而不是 `commit`:决策是唯一改账的地方,而快照读的就是账。
 * `broadcastCollabCoordinator` 自带节流(秒级 + 活动窗 120ms),所以这里可以
 * 无脑每次都喊 —— 节流的属主只有一个。
 *
 * **档位按转变认**(D8 §3.2 的发射时机):裁决窗与相位是界面上会**动**的东西
 * (转圈、黄牌、挂起徽标),它们走 120ms 那一档。其余照旧走秒 —— 闸的读数、
 * 链长这类数字慢一拍没人看得出来,而每一次决策都按 120ms 推等于把节流关掉。
 */
class WiredRoomActor extends CollabRoomActor {
  override decide(verb: CollabActorVerb): ReturnType<CollabRoomActor['decide']> {
    const before = this.account
    const effects = super.decide(verb)
    const activity = roomJudgmentOrPhaseChanged(before, this.account)
    broadcastCollabCoordinator(this.roomId, activity ? { activity: true } : {})
    return effects
  }
}

/**
 * 裁决窗的态或相位变了吗 —— 「三态转变各播一次」的判据(D8 §3.2)。
 *
 * 判的是**状态**而不是「有没有 judgment 这个对象」:`pending → degraded` 是最该
 * 被看见的那一次转变(降级要亮黄牌),而两者在"对象还在不在"这个口径下是同一
 * 个答案。
 */
function roomJudgmentOrPhaseChanged(
  before: CollabRoomAccount,
  after: CollabRoomAccount,
): boolean {
  if (before.judgment?.state !== after.judgment?.state) return true
  if (before.judgment?.token !== after.judgment?.token) return true
  // 降级的痕(O2 前置修)也算一次转变 —— 而且是**最该被看见**的那一次:窗在同一步里
  // 就关了,只比 `judgment` 的话这条转变在这个判据下完全不可见,黄牌要等下一件事
  // 才顺带播出去。
  if (before.lastDegraded?.at !== after.lastDegraded?.at) return true
  return before.phase !== after.phase
}

/**
 * 这间房此刻的 C4 快照 —— 房账 + **运行时才知道的那一格**。
 *
 * 防抖窗只存在于运行时(见 `RuntimeState.judgments` 的注释):房账在开窗那一刻就
 * 已经是 `pending`,而钱要再过一拍才花出去。快照层把这一拍画成 `debouncing`,
 * 于是「防抖 → 在飞 → 降级」三态在界面上是三个样子,而不是两个。
 */
function roomSnapshotOf(runtime: RuntimeState, roomId: string): CollabCoordinatorState | null {
  const snapshot = runtime.rooms.get(roomId)?.actor.snapshot()
  if (!snapshot) return null
  const debounce = runtime.judgments.get(roomId)
  if (!debounce || snapshot.judgment.state !== 'inflight') return snapshot
  return { ...snapshot, judgment: { state: 'debouncing', opensAt: debounce.opensAt } }
}

/** 各房账 —— agent 快照的 `heldLeases` 扫的就是它(租约的唯一权威)。 */
function* collabRoomAccountsOf(
  runtime: RuntimeState,
): Iterable<{ roomSessionId: string; account: CollabRoomAccount }> {
  for (const [roomSessionId, entry] of runtime.rooms) {
    yield { roomSessionId, account: entry.actor.account }
  }
}

/**
 * 一位同事的原始事实(D8 §3.1 的供数口)。
 *
 * 四样各有各的属主,这里只是把它们摆到一起:循环状态在 AgentActor、账在它的
 * `state.json`、积压在 mailbox 的游标差、死信在 ActorBase 的环。**一个字都不新记**。
 */
function agentActivityViewOf(
  runtime: RuntimeState,
  agentId: string,
): CollabAgentActivityView | undefined {
  const entry = runtime.agents.get(agentId)
  if (!entry) return undefined
  const inFlight = entry.actor.inFlightTurn
  const oldestAt = entry.mailbox.oldestPendingAt()
  return {
    inFlight: inFlight
      ? { roomSessionId: inFlight.roomId, since: inFlight.startedAt }
      : null,
    account: entry.actor.account,
    inbox: {
      // 游标差,O(1) —— 不数文件行(一条跑了三个月的信箱有几万行)。
      depth: entry.mailbox.pendingCount(),
      ...(oldestAt === undefined ? {} : { oldestAt }),
    },
    deadLetterCount: entry.actor.deadLetterCount,
  }
}

/**
 * 死信的三路出口(D8 §3.4)。实现在 `scheduler-log.ts` 的
 * `createCollabDeadLetterSink` —— 这里只是把它接到两类 actor 上,并在第一路
 * (计数)上再推一次快照:计数本身是 ActorBase 的环长,不新记一本,但**没人播
 * 的话那个红点要等下一件事顺带才亮**,而系统静默变哑正是死信要治的那个病。
 */
function deadLetterSink(
  actorId: string,
  fallbackRoomId?: string,
  agentId?: string,
): ReturnType<typeof createCollabDeadLetterSink> {
  const sink = createCollabDeadLetterSink({
    actorId,
    ...(fallbackRoomId ? { roomId: fallbackRoomId } : {}),
    // 装配时运行时一定在(两个调用点都在 `ensureRoom` / `ensureAgent` 里),
    // 但闭包活得比它长 —— 收摊之后的迟到死信写进一份孤儿 store 好过 NPE。
    log: { append: (roomId, row) => state?.schedulerLog.append(roomId, row) },
  })
  return deadLetter => {
    sink(deadLetter)
    // 红点走普通档:它是一个计数,不是一盏会闪的灯。
    if (fallbackRoomId) broadcastCollabCoordinator(fallbackRoomId)
    if (agentId) broadcastCollabAgentActivity(agentId)
  }
}

/* ── 投递 ─────────────────────────────────────────────────────────────── */

let eventOrdinal = 0

function nextEventId(from: string, verb: CollabActorVerb): string {
  eventOrdinal += 1
  return `v3:${from}:${verb.type}:${Date.now()}:${eventOrdinal}`
}

async function postToRoom(
  roomId: string,
  verb: CollabActorVerb,
  from: ReturnType<typeof collabActorRef>,
): Promise<void> {
  const entry = await ensureRoom(roomId)
  if (!entry) return
  await entry.mailbox.append(createActorEvent<CollabActorVerb>({
    id: nextEventId(from.id, verb),
    at: Date.now(),
    type: verb.type,
    from,
    to: collabActorRef('room', roomId),
    payload: verb,
  }))
}

async function postToAgent(
  agentId: string,
  verb: CollabActorVerb,
  from: ReturnType<typeof collabActorRef>,
): Promise<void> {
  const entry = await ensureAgent(agentId)
  if (!entry) return
  await entry.mailbox.append(createActorEvent<CollabActorVerb>({
    id: nextEventId(from.id, verb),
    at: Date.now(),
    type: verb.type,
    from,
    to: collabActorRef('agent', agentId),
    payload: verb,
  }))
  // 积压涨了一条(D8 §3.1 的 `inbox`)。普通档:这是一个数字,不是一盏会闪的灯。
  // 消化那一侧由 AgentActor 的 `handleEvent` 收尾通知 —— 一进一出各有一处。
  broadcastCollabAgentActivity(agentId)
}

/**
 * 一条消息进房(入口面)。
 *
 * 两个调用点:`ingress.ts`(用户消息落库之后)与 `say-tool.ts` 的**跨房**分支
 * (私聊注入、工作台汇报 —— 那些不在某张牌的语境里,所以走不了 speak)。
 * 落库归调用方,这里只投信:房间的 `applyCollabRoomPosted` 对非 `extraMessages`
 * 的 posted 不写转录,正是为了让"谁落的库"只有一个答案。
 */
export async function postCollabV3RoomMessage(
  roomId: string,
  message: ChatMessage,
): Promise<boolean> {
  if (!state) return false
  const author = message.role === 'user'
    ? collabActorRef('user', resolveUserIdentity().handle || 'user')
    : collabActorRef('agent', message.agentId ?? '')
  if (author.kind === 'agent' && !author.id) return false
  await postToRoom(roomId, collabRoomPosted({
    roomId,
    author,
    message: message as CollabMessageLike,
  }), author)
  return true
}

/* ── 发言(租约面) ───────────────────────────────────────────────────── */

/**
 * 说一句话 —— **唯一发送面**在 v3 的落点(§2「speak 的工具面形态就是 send_message」)。
 *
 * 同步 `decide` + 异步 `commit`,而不是投进房间信箱等它自己处理:工具要在**这一次
 * 调用里**拿到回执(拒绝文案、messageId),而投信只能拿到"投出去了"。
 *
 * 与房间循环并发跑是安全的,而且不是巧合:账的每一次转换都是
 * `this.state = f(this.state)` 的同步读改写,中间没有 await —— 交错执行只会让两次
 * 转换排成某个次序,不会丢写。这条性质是 D1 把规则做成纯函数换来的。
 */
async function speak(input: CollabV3SpeakInput): Promise<CollabV3SpeakResult> {
  const entry = await ensureRoom(input.roomSessionId)
  if (!entry) return { ok: false, error: undefined }

  const effects = entry.actor.decide(collabAgentSpeak({
    roomId: input.roomSessionId,
    agentId: input.agentId,
    leaseId: input.leaseId,
    content: input.content,
    // label 是**此刻**的称呼(快照语义)。房间那侧只读 `agentId` 去做白名单,
    // 但协议里这一格是必填 —— 给一个真名字,总好过给一个空串占位。
    ...(input.mentions?.length
      ? { mentions: input.mentions.map(agentId => ({ agentId, label: findAgent(agentId)?.name ?? agentId })) }
      : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
  }))
  if (effects.refusal) return { ok: false, error: effects.refusal }

  // 这一步写下的那条话。房间也可能同时写下闸的提示行,所以按作者认。
  const spoken = effects.messages.find(
    message => message.role === 'assistant' && message.agentId === input.agentId,
  )
  if (!spoken) {
    // 决策通过却没写下消息 —— 不该发生;当作一次失败而不是静默成功,否则模型
    // 会以为话已经进群了。
    return { ok: false, error: undefined }
  }

  /**
   * 引用快照与清零标记**补在这里**。
   *
   * 纯层的 `applyCollabRoomSpeak` 只认协议里那几格(它不认识 store,查不了被引用
   * 的那条消息还在不在);而 `CollabRoomTranscriptMessage` 与 `ChatMessage` 是逐
   * 字段同形的两个名字。
   *
   * P0.2:补写从「就地改那一个对象」换成 COW —— 消息对象一旦造出来就不许再改
   * (`session:gate` 规则 B)。旧写法靠的是「转录里那条 = 广播 posted 里那条 =
   * 同一个引用」,所以换对象时**两处一起换**,两边照旧不分家。
   */
  const replyTo = buildCollabV3ReplyTo(input.roomSessionId, input.replyToMessageId)
  if (replyTo || input.chainReset) {
    const patched = {
      ...(spoken as ChatMessage),
      ...(replyTo ? { replyTo } : {}),
      ...(input.chainReset ? { collabChainReset: true } : {}),
    } as unknown as typeof spoken
    replaceCollabV3EffectMessage(effects, spoken, patched)
  }

  await entry.actor.commit(effects)
  return { ok: true, messageId: spoken.id }
}

/**
 * 把 effects 里的某一条消息整体换掉(COW 补写用)。
 *
 * 转录清单与 `room:posted` 广播里装的**本来就是同一个对象引用**
 * (`applyCollabRoomPosted` 把 verb 直接推进 broadcast),所以换对象必须两处同步 ——
 * 只换一处的下场是「房间里存下来的那条带引用,播出去的那条不带」。
 */
function replaceCollabV3EffectMessage(
  effects: CollabRoomEffects,
  previous: CollabRoomEffects['messages'][number],
  next: CollabRoomEffects['messages'][number],
): void {
  const index = effects.messages.indexOf(previous)
  if (index >= 0) effects.messages[index] = next
  for (let cursor = 0; cursor < effects.broadcast.length; cursor += 1) {
    const verb = effects.broadcast[cursor]
    if (verb.type === 'room:posted' && verb.message === previous) {
      effects.broadcast[cursor] = { ...verb, message: next }
    }
  }
}

/** 引用是一次**拷贝**(W7):被引的那条消息不在了就整格丢掉,绝不编造。 */
function buildCollabV3ReplyTo(
  roomSessionId: string,
  replyToMessageId: string | undefined,
): ChatMessage['replyTo'] | undefined {
  if (!replyToMessageId) return undefined
  const target = sessionReads.getMessage(roomSessionId, replyToMessageId)
  if (!target) return undefined
  const authorLabel = target.role === 'user'
    ? resolveUserIdentity().label
    : (target.agentId ? findAgent(target.agentId)?.name ?? target.agentId : '')
  // 摘录的裁剪规则(长度、空白折行)归纯层那一份 —— say 那条路走的就是它,
  // 两处各裁一遍必然裁出两种样子。
  return buildCollabReplyToSnapshot({
    messageId: target.id,
    authorLabel,
    content: target.content,
  }) ?? undefined
}

/* ── 喊停 ─────────────────────────────────────────────────────────────── */

/**
 * 停止按钮在 v3 的落点(collab-team-v2 §5.1 入口①)。
 *
 * 「喊停清三样」原样保留,只是三样都换了住处:
 *  1. **在飞的流** —— 按回合登记簿找到这间房的执行会话,逐条 abort;
 *  2. **在外的牌** —— `bumpEpoch` 换代,全部作废(agent 收到 floor-revoked 之后
 *     这一轮不再开口、不再交牌);
 *  3. **排着的手** —— 换代同时清空(纯层 `bumpCollabRoomEpoch` 的既定行为)。
 *
 * 返回 `null` = 这不是一间 v3 房(运行时没起、或会话不是房),调用方回落 v2。
 */
export function stopCollabV3RoomFloor(sessionId: string): boolean | null {
  const runtime = state
  if (!runtime) return null
  const entry = runtime.rooms.get(sessionId)
  if (!entry) return null

  const turns = collabV3TurnsInRoom(sessionId)
  const engine = getStreamEngineSafe()
  for (const turn of turns) engine?.abort(turn.execSessionId)
  engine?.abort(sessionId)

  /**
   * 外部执行体要**再停一次**(E4/G10)。
   *
   * `engine.abort` 掐的是我们这一侧的流;外部 agent 的思考在别的进程里,那边收不到
   * 我们的 abort,于是「停了」之后它还在跑工具、还在记账。`interrupt` 才是那一侧的
   * 停止键,能力表说它有(`capabilities.interrupt`)才调。
   *
   * **动态 import 是刻意的**:静态引会把连接器注册表(node:child_process / node:fs /
   * 审批门 / 宿主工具面)拖进每一个 import 这个文件的协作测试的收集阶段。与同文件
   * 里 `digest-runner` 那条同一个理由。
   */
  if (turns.length > 0) {
    void import('../../external-agents/index.js')
      .then(async module => {
        for (const turn of turns) {
          await module.interruptExternalAgentSessions(turn.execSessionId)
        }
      })
      .catch((error: unknown) => {
        log.error('external agent interrupt failed', {}, error)
      })
  }

  const hadFloor = collabRoomActiveLeases(entry.actor.account, Date.now()).length > 0
  void entry.actor.bumpEpoch('epoch-bumped').catch((error: unknown) => {
    log.error('epoch bump failed', {}, error)
  })
  return hadFloor || turns.length > 0
}

/**
 * 人级停止(E5):点名把某一张在外的牌收回来。
 *
 * ## 为什么这一级此前不可达
 *
 * 三级停止里房级(上面那个)与卡级(`stopCollabV3TaskWork`)都有对外的口,唯独
 * 「停下 TA」没有:`revokeFloorLease` 只在房账内部被让位/过期/换代调用。界面上
 * 能做的只有拿房级喊停冒充,而那会把同房其他人一起打断 —— O2 因此宁可把调度页
 * 那颗「撤牌」做成只读(`RoomSchedulePanel.vue` 里那段说明),也不肯装一个名不
 * 副实的按钮。这个函数就是那段说明里点名要的东西。
 *
 * ## 四件事,一件不少(与房级同构,只是范围收到一张牌)
 *
 *  1. **撤这张牌** —— `actor.revokeLease`(账 + 广播 floor-revoked + 立刻补发);
 *  2. **掐我们这侧的流** —— `engine.abort(execSessionId)`;
 *  3. **掐外部执行体** —— `interruptExternalAgentSessions`,能力位说了算(E4/G10);
 *  4. **结算 pending 审批/提问** —— **不在这里做**,见下。
 *
 * ## 谁已经做了什么:abort 与 settle 的职责划分
 *
 * `engine.abort` 的最后一行是 `onSessionCleared(sessionId)`(core
 * `headless-stream-engine.ts`),它在装配层落到 `clearPermissionSession` ——
 * 那一个回调里 `Permission.clearSession` 与 `Interaction.clearSession` 同进同退
 * (`app/engine/stream-engine-runtime.ts`)。两者都是**逐条 settle 再删表**。
 * 所以这里再补一次结算是**重复**的:重复 settle 一条已经结算过的 pending 不会
 * 更干净,只会多一处将来会与内核漂移的账。这一段写下来是因为「abort 到底带不
 * 带走审批」是本期唯一一个必须查证才敢不做的问题。
 *
 * ## epoch 前置条件
 *
 * 仿看板的 `expectedRev`:界面看见这张牌时房间是第几代,撤的时候就得还是第几代。
 * 牌号本身已经唯一,代数管的是**这一屏描述的是哪一轮** —— 中间换过代(用户刚
 * 喊过停、换过相、有人插过话),这一屏说的就已经是上一轮的事,此时撤牌撤到的
 * 很可能是刚被发到牌的下一位无辜者。对不上就拒绝,并把当前代数回给界面自愈。
 */
export async function revokeCollabV3RoomLease(
  request: CollabRoomRevokeLeaseRequest,
): Promise<CollabRoomRevokeLeaseResult> {
  const runtime = state
  if (!runtime) return { ok: false, reason: 'not-a-room' }
  const entry = runtime.rooms.get(request.roomSessionId)
  if (!entry) return { ok: false, reason: 'not-a-room' }

  const epoch = entry.actor.account.floor.epoch
  if (request.expectedEpoch !== epoch) return { ok: false, reason: 'epoch-stale', epoch }

  const lease = entry.actor.account.floor.active.find(item => item.leaseId === request.leaseId)
  if (!lease) return { ok: false, reason: 'not-found', epoch }
  const agentId = lease.agentId

  /**
   * **先掐流,后撤牌**。反过来的话补发出去的下一张牌可能在同一个 tick 里就把新的
   * 一轮起跑了,而我们随后那次 abort 打的是刚出生的那条流(靶子按 execSessionId
   * 取,而登记簿此刻已经换了人)。房级那侧没有这个次序问题 —— 换代之后没有人会
   * 被补发。
   */
  const turns = collabV3TurnsInRoom(request.roomSessionId)
    .filter(turn => turn.leaseId === request.leaseId)
  const engine = getStreamEngineSafe()
  // abort 顺带结算这条会话的 pending 审批/提问(见上「职责划分」)。
  for (const turn of turns) engine?.abort(turn.execSessionId)

  // 外部执行体要再停一次:我们的 abort 掐不到别的进程里的那颗大脑(E4/G10)。
  // 动态 import 与房级喊停同一个理由 —— 静态引会把连接器注册表拖进每一个 import
  // 这个文件的协作测试的收集阶段。
  if (turns.length > 0) {
    void import('../../external-agents/index.js')
      .then(async module => {
        for (const turn of turns) {
          await module.interruptExternalAgentSessions(turn.execSessionId)
        }
      })
      .catch((error: unknown) => {
        log.error('external agent interrupt failed', {}, error)
      })
  }

  const revoked = await entry.actor.revokeLease(request.leaseId)
  if (!revoked) return { ok: false, reason: 'not-found', epoch }
  return { ok: true, revoked: true, agentId, epoch: entry.actor.account.floor.epoch }
}

/**
 * 这间房此刻的 C4 快照(状态条冷启动读它)。不是 v3 房就是 null。
 *
 * 走与广播**同一个**组装函数 —— 防抖窗那一格只有运行时知道,两条路各拼一份的话
 * 冷启动看到的裁决态会与广播出去的那一份不一样。
 */
export function peekCollabV3RoomSnapshot(roomSessionId: string): CollabCoordinatorState | null {
  return state ? roomSnapshotOf(state, roomSessionId) : null
}

/**
 * 房账那侧的预算读数立刻过期(改预算、清历史时调)。
 *
 * v3 房间的闸判定必须是同步的,所以它读的是一份 60s 缓存 —— 与 `budget.ts` 那
 * 一份是**两本**(一本给同步决策,一本给异步问询)。用户拨完开关要立刻生效,
 * 于是两本都得作废;只作废一本,就会出现"设置面板说没超,房间却还在拦"。
 */
export function forgetCollabV3RoomBudget(roomSessionId: string): void {
  state?.budget.delete(roomSessionId)
}

/**
 * 房间的响应模式改了 —— 把新档立刻打进房账(D6 接线的第二个生效点)。
 *
 * 只推**已经开着的**房:一间还没开箱的房,它的账在磁盘上仍是旧档,而下一次
 * `ensureRoom` 的 `syncFloorPolicy()` 会补上 —— 为了改一个开关去开一间没人在用的
 * 房(一次 mailbox 扫描)不划算,而且那扇门本来就守着这件事。
 *
 * 换档走的是 `set-floor-policy` 那条既有的路,所以 D3 的顶掉语义原样成立:游标
 * 清空(环从起棒人重来)、还没答的裁决窗作废(它判的是上一档该谁说)、在飞的
 * 编排批位归零。**在外的牌不收**:一位同事正在说的那句话与"下一句该谁说"是两件
 * 事,把它掐掉只会让房间里多一条说了一半的话。
 */
export async function syncCollabV3RoomFloorPolicy(roomSessionId: string): Promise<void> {
  const entry = state?.rooms.get(roomSessionId)
  if (!entry) return
  await entry.actor.syncFloorPolicy()
}

/* ── 卡级停止(D6-b 收口) ─────────────────────────────────────────────── */

/**
 * 这张卡此刻有没有手在做 —— 「停止执行」菜单项的显示条件。
 *
 * 账在**每位同事自己的子清单**里(`account.workers`),没有第二本:v2 那侧是
 * 协调器进程内的一张 `activeByTask` 表,而 v3 把它落进了 agent 账(崩溃之后父
 * 能发现孤儿,靠的就是这张表能活过重启)。所以这里扫的是账,不是内存索引 ——
 * 一只在飞的手无论派生自哪一条命,都数得着。
 */
export function hasActiveCollabV3Work(taskId: string): boolean {
  return findCollabV3Worker(taskId) !== null
}

function findCollabV3Worker(
  taskId: string,
  roomSessionId?: string,
): { agentId: string; record: CollabAgentWorkerRecord } | null {
  const runtime = state
  if (!runtime) return null
  for (const [agentId, entry] of runtime.agents) {
    const record = collabWorkerRunningForCard(entry.actor.account.workers, taskId)
    if (!record) continue
    // 指定了房就按房认:同一张卡 id 不会跨房,但「停这间房的这张卡」是调用方
    // 的原话,把它当成判据而不是注释,是 v2 那侧就有的纪律。
    if (roomSessionId !== undefined && record.roomId !== roomSessionId) continue
    return { agentId, record }
  }
  return null
}

/**
 * 卡级停止(collab-team-v2 §5.1 入口②)在 v3 的落点。
 *
 * 与 v2 逐条对齐,三件事一件不少:掐流、把卡放回可续做的 `todo`、在群里留一行
 * 说明。差别只在**账在哪儿** —— v2 读协调器的 `activeByTask`,v3 读派这只手的
 * 那位同事的子清单。
 *
 * 返回 false = 这张卡此刻没有在跑的执行,按钮不该出现在那儿。
 *
 * **不等这只手收工**:abort 之后子 actor 会自己走完 `interrupted` 那条收尾路
 * (回投结果 → 记账 → 放槽位),而按钮要的是"按下去立刻有反应"。等它等于把一次
 * UI 交互挂在一条正在拆的模型流上。
 */
export async function stopCollabV3TaskWork(
  roomSessionId: string,
  taskId: string,
): Promise<boolean> {
  if (!state) return false
  const found = findCollabV3Worker(taskId, roomSessionId)
  if (!found) return false
  const task = getCollabTask(roomSessionId, taskId)

  await patchCollabTask(roomSessionId, taskId, { status: 'todo' })
  // 掐的是**工作会话**那条流,不是房间流:停一张卡不该让同房其他人的对话跟着断。
  if (found.record.workSessionId) getStreamEngineSafe()?.abort(found.record.workSessionId)
  if (task) {
    postTaskSystemLine(roomSessionId, buildCollabTaskInterruptedLine({
      title: task.title,
      ...(task.assigneeAgentId
        ? { assigneeName: findAgent(task.assigneeAgentId)?.name ?? task.assigneeAgentId }
        : {}),
      cause: '执行已被停止',
      hasWorkSession: task.workSessionIds.length > 0,
    }))
  }
  return true
}

/**
 * 总闸落下:这间房在飞的每一只手都停掉(v2 `freezeRoomWork` 的 v3 落点)。
 *
 * **卡的状态刻意不动**(与 v2 逐字一致):冻结中止的是执行,不是这张卡的归属。
 * 卡留在 `doing` 上,恢复时由下面那个函数原地续做 —— 中断说明也因此被抑制,
 * 因为「暂停」本身已经在群里说过一次了。
 */
export function freezeCollabV3RoomWork(roomSessionId: string): void {
  const runtime = state
  if (!runtime) return
  const engine = getStreamEngineSafe()
  for (const entry of runtime.agents.values()) {
    for (const record of entry.actor.account.workers) {
      if (record.status !== 'running' || record.roomId !== roomSessionId) continue
      if (record.workSessionId) engine?.abort(record.workSessionId)
    }
  }
}

/**
 * 总闸抬起:把冻结搁浅的卡重新派出去。
 *
 * `doing` 一并算进来是刻意的(v2 同注释):总闸掐掉了流却把卡留在 `doing`,
 * 只扫 `todo` 会让它们一直搁浅到下一次重启才被对账认领。已经有手在做的卡跳过。
 *
 * 走的是与 `task-started` 完全同一条派生路 —— 续做接着原来那条工作会话往下做。
 */
export async function resumeCollabV3RoomWork(roomSessionId: string): Promise<void> {
  const runtime = state
  if (!runtime) return
  let board: ReturnType<typeof loadCollabBoard>
  try {
    board = loadCollabBoard(roomSessionId)
  } catch (error) {
    log.error('board read for resume failed', { roomSessionId }, error)
    return
  }
  for (const task of board.tasks) {
    if (task.status !== 'todo' && task.status !== 'doing') continue
    const assignee = task.assigneeAgentId
    if (!assignee) continue
    if (findCollabV3Worker(task.id, roomSessionId)) continue
    const previous = task.workSessionIds[task.workSessionIds.length - 1]
    await postToAgent(assignee, collabAgentSpawnWorker({
      agentId: assignee,
      workerId: randomUUID(),
      cardId: task.id,
      roomId: roomSessionId,
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      ...(previous ? { workSessionId: previous } : {}),
    }), collabActorRef('room', roomSessionId))
  }
}

/* ── 成员变更(D6-b 收口) ─────────────────────────────────────────────── */

/**
 * 名册变了,告诉房间一声(`room:membership-changed`)。
 *
 * 协议里这个动词早就有,消费端也早就接好了 —— 房间落账后原样播给在册成员,
 * 每位同事把它折进下一轮的信封(`envelope-fold.ts`:「谁来了谁走了」)。缺的
 * 一直是**生产者**:改名册的那扇门还在 v2 协调器里,它只会贴一条群公告系统行。
 *
 * 群公告是给**人**看的(转录里那一行),折叠信封是给**模型**看的。两者不是同一
 * 件事,少了后者的结果是:同事在名册已经变了之后,还会 @ 一个上周就离开的人 ——
 * 它的上下文里从来没出现过那件事。
 *
 * 空变更不投信:一次只改了房名的保存不该在每个人的信封里留一条噪声。
 */
export async function postCollabV3MembershipChanged(
  roomSessionId: string,
  joined: readonly string[],
  left: readonly string[],
): Promise<boolean> {
  if (!state) return false
  if (joined.length === 0 && left.length === 0) return false
  if (!state.rooms.has(roomSessionId) && store.getSession(roomSessionId)?.kind !== 'room') return false
  await postToRoom(
    roomSessionId,
    collabRoomMembershipChanged({ roomId: roomSessionId, joined: [...joined], left: [...left] }),
    collabActorRef('room', roomSessionId),
  )
  return true
}

/* ── 闸的读口 ─────────────────────────────────────────────────────────── */

/**
 * 预算闸的**同步**读数。
 *
 * 房间的决策必须是同步的(金重放与真机走同一行代码),而账本读取是一次磁盘往返
 * —— 所以这里是一份 60s 缓存,过期时**异步**去补,当次仍按旧值判。与 v2 费用闸
 * 同一套做法(那边也是 60s + 单次在飞读取),口径因此没有变。
 */
function roomOverBudget(roomId: string): boolean {
  const runtime = state
  if (!runtime) return false
  const limit = budgetLimitOf(roomId)
  if (limit <= 0) return false
  const cell = budgetCell(roomId)
  const now = Date.now()
  if (now - cell.checkedAt > BUDGET_CACHE_MS && !cell.reading) {
    cell.reading = readCollabRoomSpentTodayUSD(roomId)
      .then(value => {
        cell.spentUSD = value
        cell.checkedAt = Date.now()
        return value
      })
      .catch((error: unknown) => {
        log.error('budget read failed', { roomId }, error)
        return cell.spentUSD
      })
      .finally(() => {
        cell.reading = undefined
      })
  }
  const over = cell.spentUSD >= limit
  if (over) {
    const day = budgetDay(now)
    if (cell.noticedDay !== day) {
      cell.noticedDay = day
      postSystemLine(
        roomId,
        `今天这个房间已花费 $${cell.spentUSD.toFixed(2)},达到日预算 $${limit}——明天自动恢复,或调整房间预算`,
      )
    }
  }
  return over
}

function budgetCell(roomId: string): BudgetCell {
  const runtime = state!
  let cell = runtime.budget.get(roomId)
  if (!cell) {
    cell = { spentUSD: 0, checkedAt: 0 }
    runtime.budget.set(roomId, cell)
  }
  return cell
}

function budgetLimitOf(roomId: string): number {
  return store.getSession(roomId)?.room?.budgets?.dailyCostUSD ?? COLLAB_DEFAULT_DAILY_COST_USD
}

/** 用户时区的日历日(与 v2 `budgetDayKey` 同一套算法 —— 两处"今天"必须同一天)。 */
function budgetDay(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* ── 宿主端口 ─────────────────────────────────────────────────────────── */

function roomMembersOf(roomId: string): CollabAgentLike[] {
  return collabRoomMembers(store.getSession(roomId)?.room?.memberAgentIds)
}

/** 这间房挂裁判吗:群房挂,私聊房不挂(与 v2 的「私聊免判」逐条对齐)。 */
function roomHasReferee(roomId: string): boolean {
  const room = store.getSession(roomId)?.room
  if (!room) return false
  if (isUserDmRoom(room) || isAgentPairDmRoom(room)) return false
  return (room.memberAgentIds ?? []).length >= 2
}

/**
 * 一扇裁决窗开出来之后**先等一拍再去买**(D6-a)。
 *
 * 举手是异步到的:房间开窗是在**第一只手**落地的那一刻,而其余几位的心智循环
 * 各自还在路上。窗一开就调裁判,拿到的候选表永远只有一个人 —— 那样的"批量裁决"
 * 与 v2 的 per-agent 判定没有区别,只是把 N 次调用换成了 N 扇窗。
 *
 * 一拍 = 150ms:比一次 mailbox 往返长一个量级,比人眼的"它怎么不说话"短一个
 * 量级。同一间房后到的窗**顶掉**前一扇(token 不同,前一扇的答案房间本来就会
 * 丢掉),所以连着几条消息进来只会买最后那一次。
 */
const JUDGMENT_DEBOUNCE_MS = 150

function scheduleJudgment(request: CollabRoomJudgmentRequest): void {
  const runtime = state
  if (!runtime || runtime.stopping) return
  const pending = runtime.judgments.get(request.roomId)
  if (pending) clearTimeout(pending.timer)
  const timer = setTimeout(() => {
    runtime.judgments.delete(request.roomId)
    // 起飞:这一拍过完,窗从「防抖」翻成「在飞」—— 钱是从这一刻开始花的。
    broadcastCollabCoordinator(request.roomId, { activity: true })
    void runtime.referee.adjudicate(request).catch((error: unknown) => {
      log.error('adjudication failed', { roomId: request.roomId }, error)
    })
  }, JUDGMENT_DEBOUNCE_MS)
  timer.unref?.()
  runtime.judgments.set(request.roomId, {
    timer,
    request,
    opensAt: Date.now() + JUDGMENT_DEBOUNCE_MS,
  })
  // 开窗:虚点亮起来。走活动档 —— 这一拍只有 150ms,按秒节流的话它会被整个吞掉,
  // 而那正是「刚才为什么没人理我」最开头的那一帧。
  broadcastCollabCoordinator(request.roomId, { activity: true })
}

/** 把等着的那几扇窗立刻买掉。停机与装配级测试用 —— 生产靠上面那一拍。 */
async function flushJudgments(): Promise<void> {
  const runtime = state
  if (!runtime) return
  const pending = [...runtime.judgments.values()]
  runtime.judgments.clear()
  for (const entry of pending) {
    clearTimeout(entry.timer)
    if (runtime.stopping) continue
    // 与定时器那条路同一帧:窗从「防抖」翻成「在飞」。
    broadcastCollabCoordinator(entry.request.roomId, { activity: true })
    try {
      await runtime.referee.adjudicate(entry.request)
    } catch (error) {
      log.error('adjudication failed', { roomId: entry.request.roomId }, error)
    }
  }
}

function roomHost(): CollabRoomActorHost {
  return {
    members: roomMembersOf,
    // 授权面(谁能被发牌)与识别面(哪串字符是一个真身份)分家 —— 用户与退休
    // 成员的句柄要认得出来,但他们不在名册里(collab-handle-codec.md §2.1)。
    directory: () => buildCollabIdentityDirectory(),
    frozen: roomId => store.getSession(roomId)?.room?.frozen === true,
    overBudget: roomOverBudget,
    maxChain: roomId => {
      const session = store.getSession(roomId)
      return session ? maxChainFor(session) : 0
    },
    maxConcurrent: roomId => maxConcurrentTurnsFor(store.getSession(roomId)),
    pairDm: roomId => isAgentPairDmRoom(store.getSession(roomId)?.room),
    budget: roomId => ({ spentUSD: budgetCell(roomId).spentUSD, limitUSD: budgetLimitOf(roomId) }),
    referee: roomHasReferee,
    // 设置里的「响应模式三件套」→ 发言策略档。这一口只在装配与改设置时被问
    // (`syncFloorPolicy()`),不是每次决策现读 —— 理由见端口自己的注释。
    floorPolicy: roomId => resolveCollabRoomFloorPolicy(store.getSession(roomId)?.room),
    openJudgment: scheduleJudgment,
    appendMessage: (roomId, message) => {
      const chat = message as ChatMessage
      sessionCommands.appendMessage(roomId, { message: chat, stampCollab: true })
      // 与 v2 say / ingress 共用同一条广播:房间 UI 与 SSE 镜像不必认新事件。
      void getEventBus().emit(roomId, {
        type: SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
        message: chat,
      } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
    },
    memberMailbox: agentId => ({
      append: async event => {
        const entry = await ensureAgent(agentId)
        // 开不出信箱(人退休了 / 被删了)不算投递失败:房间那侧会把它当"这位
        // 此刻没有信箱"跳过,而不是让整条广播炸掉。
        if (!entry) return
        await entry.mailbox.append(event)
      },
    }),
    newMessageId: () => randomUUID(),
    now: () => Date.now(),
  }
}

function agentHost(): CollabAgentActorHost {
  return {
    execSessionId: (agentId, roomId) => ensureCollabAgentSession(agentId, roomId),
    buildRoomContext: buildV3RoomContext,
    roomOutbox: roomId => ({
      post: verb => postToRoom(roomId, verb, collabActorRef('agent', collabVerbAgentId(verb))),
    }),
    members: roomMembersOf,
    dm: roomId => {
      const room = store.getSession(roomId)?.room
      return isUserDmRoom(room) || isAgentPairDmRoom(room)
    },
    roomLabel: roomId => store.getSession(roomId)?.name,
    speakerLabel: agentId => findAgent(agentId)?.name,
    projectedThrough: roomId => {
      const messages = sessionReads.listMessages(roomId).messages
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!isCollabRoomFact(message as CollabMessageLike)) continue
        return {
          ...(message.id ? { messageId: message.id } : {}),
          ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
        }
      }
      return undefined
    },
    persistSeen: input => {
      advanceSeenCursor(input.execSessionId, input.messageId)
    },
    formatSteerBody: formatV3SteerBody,
    now: () => Date.now(),
  }
}

/**
 * 接线之后的举手判据(D6-a)。
 *
 * D2 的启发式只认两条直通(被 @ / 私聊里的人类消息),其余一律不举手 —— 那是
 * 「D2 没有意愿判定」时唯一安全的默认。**D3 之后不该再是它**:意愿判定的真身
 * 在裁判那一侧,而裁判「只在举手的人之间取舍,没有凭空点人的权力」。沿用 D2 的
 * 默认,结果是群里一条没被 @ 的消息谁都不举手 → 裁决窗里零候选 → 全员静默,
 * 而那正是 v2 用 N 次意愿判定解决的那个问题。
 *
 * 所以接线档是:**每一条房间事实都举手,取舍交给裁判**(qm P0-2 的 O(N)→O(1)
 * 就是这句话的全部内容)。举手不花钱 —— 它是一封信,不是一次调用。
 *
 * 剩下的取舍由三样按序兜住:裁判(挂了的房)、发言策略的 FIFO(没挂的房)、
 * 以及三道闸。没有一样依赖 agent 自己"懂事"。
 */
function wiredHandEvaluator(): CollabHandEvaluator {
  const heuristic = createCollabHeuristicHandEvaluator()
  return {
    name: 'wired',
    async evaluate(input) {
      const base = await heuristic.evaluate(input)
      // 被 @ / 私聊直通:原样保留,连 `urgency: 'high'` 一起 —— 裁判排序读它。
      if (base.raise) return base
      // 自己说的话、运营行、drive、thinking 都不是举手时机(判据与 D2 逐条一致)。
      if (input.author.kind === 'agent' && input.author.id === input.agentId) return base
      if (!isCollabRoomFact(input.message)) return base
      return { raise: true, reason: 'self-elected', why: '有话要说' }
    },
  }
}

/** 一条 agent → room 的动词是谁发的。投信的 `from` 要它。 */
function collabVerbAgentId(verb: CollabActorVerb): string {
  return 'agentId' in verb && typeof verb.agentId === 'string' ? verb.agentId : ''
}

/**
 * 中途来消息的注入信封 —— 与房间投影**同源**(v2 `steer.ts` 的第一处收窄)。
 *
 * 同一条消息在注入与投影两条路上必须长得一样,否则模型会把它读成两个人说的话。
 */
function formatV3SteerBody(message: CollabMessageLike): string {
  const text = (message.content ?? '').trim()
  if (!text) return ''
  if (message.agentId) {
    const label = findAgent(message.agentId)?.name ?? message.agentId
    return wrapCollabMessageEnvelope(label, text, message.timestamp)
  }
  const identity = resolveUserIdentity()
  return wrapCollabMessageEnvelope(
    formatCollabUserLabel(identity.label, identity.handle),
    text,
    message.timestamp,
  )
}

/**
 * 这条 drive 要带的房间内容。
 *
 * 与 v2 `buildDriveRoomContext` 逐格同参(投影、窗口、摘要、用户身份),多一件事:
 * **上一轮的代发回声**。回声接在房间内容之后而不是混进去 —— 它说的不是"房里发生
 * 了什么",而是"你上一轮那段话的下落"(架构审查 A6)。
 */
function buildV3RoomContext(input: CollabAgentRoomContextInput): string {
  const room = store.getSession(input.roomId)
  if (room?.kind !== 'room') return ''
  const messages = sessionReads.listMessages(input.roomId).messages
  const window = planCollabHistoryWindow({
    messages,
    ...(input.seenMessageId ? { seenMessageId: input.seenMessageId } : {}),
    selfAgentId: input.agentId,
    now: input.now,
    ...(room.room?.context ?? {}),
  })
  const roomContext = buildCollabDriveRoomContext({
    messages,
    selfAgentId: input.agentId,
    agents: roomMembersOf(input.roomId),
    resolveAgentName: id => findAgent(id)?.name,
    ...collabUserPromptFields(),
    window,
    bootstrap: input.bootstrap,
    ...(window.cut !== undefined
      ? { digests: getCollabDigestsForDays(input.roomId, foldedDaysOfWindow(messages, window)) }
      : {}),
  })

  const echo = takeCollabV3AdoptedEcho(input.execSessionId)
  if (!echo) return roomContext
  return [roomContext, formatCollabAdoptedEcho(echo)].filter(Boolean).join('\n\n')
}

/** 折叠段覆盖到的那几天 —— 首轮铺底按它取摘要(与 v2 同一份算法)。 */
function foldedDaysOfWindow(
  messages: readonly ChatMessage[],
  window: { folded: ReadonlySet<number> },
): string[] {
  const days = new Set<string>()
  for (const message of collectCollabFoldedFacts(messages, window)) {
    days.add(budgetDay(message.timestamp ?? 0))
  }
  return [...days].sort()
}

/**
 * 代发回声读一次就清。
 *
 * 走动态 import 是为了不在模块图上加一条 `runtime → agent-session` 之外的边:
 * 那条边已经有了(`ensureCollabAgentSession`),所以这里直接静态引也可以 ——
 * 保持静态,少一层。
 */
function takeCollabV3AdoptedEcho(
  execSessionId: string,
): { messageId: string; at?: number } | undefined {
  const session = store.getSession(execSessionId)
  const collab = session?.collab
  const messageId = collab?.adoptedEchoMessageId
  if (!collab || !messageId) return undefined
  const at = collab.adoptedEchoAt
  const next = { ...collab }
  delete next.adoptedEchoMessageId
  delete next.adoptedEchoAt
  store.updateSessionCollab(execSessionId, { collab: next })
  return { messageId, ...(typeof at === 'number' ? { at } : {}) }
}

function refereeHost(): CollabRefereeActorHost {
  return {
    candidates: (roomId): readonly CollabRaisedHand[] =>
      state?.rooms.get(roomId)?.actor.account.hands ?? [],
    members: roomMembersOf,
    recent: roomId => {
      const messages = sessionReads.listMessages(roomId).messages as readonly CollabMessageLike[]
      return messages.filter(isCollabRoomFact).slice(-REFEREE_RECENT_LIMIT)
    },
    roomLabel: roomId => store.getSession(roomId)?.name,
    userLabel: () => collabUserPromptFields().userLabel,
    persona: agentId => findAgent(agentId)?.systemPrompt,
    agentName: agentId => findAgent(agentId)?.name,
    constraints: roomId => {
      const account = state?.rooms.get(roomId)?.actor.account
      if (!account) return []
      const session = store.getSession(roomId)
      const maxChain = session ? maxChainFor(session) : 0
      const maxConcurrent = maxConcurrentTurnsFor(session)
      const lines: string[] = []
      if (Number.isFinite(maxChain) && maxChain > 0) {
        lines.push(`链闸:已连说 ${account.chainCount} 轮,上限 ${maxChain}`)
      }
      if (Number.isFinite(maxConcurrent) && maxConcurrent > 0) {
        const seats = maxConcurrent - collabRoomActiveLeases(account, Date.now()).length
        lines.push(`座位:还剩 ${Math.max(0, seats)} 个`)
      }
      return lines
    },
    mentioned: roomId => {
      const account = state?.rooms.get(roomId)?.actor.account
      const sourceMessageId = account?.judgment?.sourceMessageId
      if (!sourceMessageId) return []
      const source = sessionReads.getMessage(roomId, sourceMessageId)
      return (source?.mentions ?? [])
        .map(mention => mention.agentId)
        .filter((agentId): agentId is string => typeof agentId === 'string')
    },
    roomOutbox: roomId => ({
      post: verb => postToRoom(roomId, verb, collabActorRef('referee', 'referee')),
    }),
    now: () => Date.now(),
  }
}

/* ── 看板 ─────────────────────────────────────────────────────────────── */

/**
 * 卡的写口(D4 的 `CollabWorkerBoardPort` 生产实现)。
 *
 * 只走 `patchCollabTask` —— 那是**协调器内部**的写口,不会再触发一次语义板事件。
 * 用 `applyBoardAction` 的话,"开工写 doing"会再发一次 `task-started`,而那正是
 * 触发开工的那个事件:一只手会派出第二只手。
 */
function boardPort(): CollabWorkerBoardPort {
  return {
    started: async input => {
      const task = loadCollabBoard(input.roomId).tasks.find(entry => entry.id === input.cardId)
      if (!task) return
      const resuming = input.workSessionId
        ? task.workSessionIds.includes(input.workSessionId)
        : true
      await patchCollabTask(input.roomId, input.cardId, {
        status: 'doing',
        ...(resuming || !input.workSessionId
          ? {}
          : { workSessionIds: [...task.workSessionIds, input.workSessionId] }),
      })
    },
    settled: async input => {
      // 终局 → 卡的去处。交付进评审(人/PM 验收),受阻留 blocked,其余一律推回
      // todo —— 一段没跑完的执行不该把卡留在"在做"上,那是看板与进程说的不是
      // 同一件事的开始。
      const status = input.outcome === 'complete'
        ? 'review'
        : input.outcome === 'blocked' ? 'blocked' : 'todo'
      await patchCollabTask(input.roomId, input.cardId, {
        status,
        ...(input.summary ? { report: { summary: input.summary } } : {}),
      })
    },
    interrupted: async input => {
      await patchCollabTask(input.roomId, input.cardId, { status: 'todo' })
    },
    digest: input => renderCollabBoardDigest(
      loadCollabBoard(input.roomId),
      agentId => findAgent(agentId)?.name ?? agentId,
      { agentId: input.agentId },
    ),
  }
}

/** 板事件 → v3。开工派手,其余进房间当卡的动静。 */
async function handleBoardEvent(
  roomSessionId: string,
  event: { type: string; task: { id: string; title: string; description?: string; assigneeAgentId?: string; workSessionIds: string[] } },
): Promise<void> {
  if (!state) return
  const task = event.task
  const assignee = task.assigneeAgentId

  if (event.type === 'task-started' && assignee) {
    // 续做接着原来那条工作会话往下做:现场就在那条会话里,重开一条等于把它扔掉。
    const previous = task.workSessionIds[task.workSessionIds.length - 1]
    await postToAgent(assignee, collabAgentSpawnWorker({
      agentId: assignee,
      workerId: randomUUID(),
      cardId: task.id,
      roomId: roomSessionId,
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      ...(previous ? { workSessionId: previous } : {}),
    }), collabActorRef('room', roomSessionId))
  }

  const kind = boardEventKind(event.type)
  if (!kind) return
  if (event.type === 'task-assigned' && assignee) {
    postTaskSystemLine(roomSessionId, `「${task.title}」→ ${findAgent(assignee)?.name ?? assignee}`)
  }
  await postToRoom(roomSessionId, collabRoomCardEvent({
    roomId: roomSessionId,
    cardId: task.id,
    event: kind,
    ...(assignee ? { assigneeId: assignee } : {}),
    title: task.title,
  }), collabActorRef('room', roomSessionId))
}

function boardEventKind(type: string): CollabCardEventKind | undefined {
  switch (type) {
    case 'task-assigned':
    case 'task-requeued':
      return 'assigned'
    case 'task-started':
      return 'started'
    case 'task-completed':
      return 'delivered'
    case 'task-blocked':
      return 'blocked'
    case 'task-done':
      return 'closed'
    default:
      // `task-rejected` / `task-halted` 没有对应的卡事件档 —— 它们是**评审动作**,
      // 会以一条 assigned / blocked 紧随其后落地,折叠信封里说一次就够。
      return undefined
  }
}

/* ── 清空历史 ───────────────────────────────────────────────────────── */

/**
 * 把这间房的 v3 账整个换成新的(清空聊天记录的 IPC 走到最后调它)。
 *
 * 「对话记忆」在 v2 散在七处;v3 里房间那一份**全在账里**(水位、链数、举手、
 * 租约、发言策略),所以清它只有一个动作:停循环 → 写一份新账 → 让下一次寻址
 * 重新开箱。
 *
 * `epoch` 刻意**接着往下数**而不是归零:一条在飞回合的收尾可能带着旧牌回来,
 * 而代数是它「属于上一段」的记号。v3 的牌号台账其实已经足够(新账里没有那个
 * leaseId,验票直接判 `unknown`),这一条是第二层 —— 与 v2 清空时保留
 * `floorEpoch` 的理由逐字相同。
 *
 * 返回 false = 这不是一间 v3 房(运行时没起 / 会话已经不在),调用方不必再做什么。
 */
async function resetRoomAccount(roomSessionId: string): Promise<boolean> {
  const runtime = state
  const entry = runtime?.rooms.get(roomSessionId)
  if (!runtime || !entry) return false

  const epoch = entry.actor.account.floor.epoch + 1
  // 先按住在飞的那几条(掐流 + 换代),再动账 —— 反过来的话一条正在收尾的回合
  // 会把它的 say 写进一间刚被清空的房。
  stopCollabV3RoomFloor(roomSessionId)
  try {
    await entry.actor.stop()
    await entry.mailbox.flush()
  } catch (error) {
    log.error('stop room loop before clear failed', { roomSessionId }, error)
  }
  runtime.rooms.delete(roomSessionId)
  runtime.budget.delete(roomSessionId)
  const fresh = createCollabRoomAccount(roomSessionId)
  createCollabRoomAccountFileStore().save({ ...fresh, floor: { ...fresh.floor, epoch } })
  broadcastCollabCoordinator(roomSessionId)
  return true
}

/* ── 测试缝 ───────────────────────────────────────────────────────────── */

/** 这间房的 actor(装配级测试读它的账)。 */
export function peekCollabV3Room(roomSessionId: string): CollabRoomActor | undefined {
  return state?.rooms.get(roomSessionId)?.actor
}

/** 这位同事的 actor(装配级测试读它的账与水位)。 */
export function peekCollabV3Agent(agentId: string): CollabAgentActor | undefined {
  return state?.agents.get(agentId)?.actor
}

/**
 * 把每一位在职同事的循环提前开箱。
 *
 * 生产不需要(懒建覆盖了每一条真实路径),测试要:一个"用户消息 → 裁决 → 授牌"
 * 的全链路断言不该依赖"谁碰巧先被寻址到"。
 */
export async function warmCollabV3Agents(): Promise<void> {
  for (const agent of listAgents()) {
    if (!isActiveAgent(agent)) continue
    await ensureAgent(agent.id)
  }
}

/** 静默:全部信箱清空且没有在飞回合。装配级测试等它。 */
export async function drainCollabV3Runtime(maxRounds = 200): Promise<void> {
  const runtime = state
  if (!runtime) return
  for (let round = 0; round < maxRounds; round += 1) {
    for (const entry of runtime.agents.values()) await entry.actor.drain()
    for (const entry of runtime.rooms.values()) await entry.actor.drain()
    const busy = [...runtime.agents.values()].some(entry => entry.actor.inFlightRoomId !== null)
      || [...runtime.agents.values()].some(entry => entry.mailbox.pendingCount() > 0)
      || [...runtime.rooms.values()].some(entry => entry.mailbox.pendingCount() > 0)
    if (busy) continue
    // 等着的裁决窗也是"还没跑完的事",但它排在**最后**:防抖那一拍的全部意义就是
    // 让还在路上的手赶上同一批,而只要还有信没投完,那批就还没凑齐。抢在前面买
    // 掉它,`drain` 自己就成了那个把批次打散的人(实测:第二只手总是差一拍)。
    if (runtime.judgments.size > 0) {
      await flushJudgments()
      continue
    }
    return
  }
  throw new Error('[collab-v3] 环没闭合:超过静默轮数上限')
}
