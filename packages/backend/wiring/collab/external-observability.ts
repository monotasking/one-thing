/**
 * 外部通路的**观测面**(docs/design/claude-code-integration-v2.md §6,E6 期)。
 *
 * 在这个文件之前,一个绑了 Claude Code 的同事在调度时间轴上只有两行:发牌与收牌。
 * 中间那几分钟 —— 它跑了什么工具、被哪一次提问卡住、最后是跑完了还是被掐了 ——
 * 一个字都没有。F3 那 2 分 11 秒之所以只能靠截图复盘,根子就在这片空白。
 *
 * ## 三类事件,三个**唯一**产生点
 *
 * | 类 | 产生点 | 为什么是它 |
 * | --- | --- | --- |
 * | `external-turn` | connector 的 `streamTurn` 起 / `finally` 落(经本文件的端口) | 只有它知道 connector 那一侧的边界与收场;引擎那一层看到的是流事件,起落对不齐 |
 * | `external-tool` | connector `canUseTool` 的**唯一出口**(经本文件的端口) | 决定就在那儿做;写在下游的执行器里就漏掉了 deny 的那一半 |
 * | `interaction` | EventBus 上的 `interaction:requested` / `interaction:settled` | core 的 `settle()` 是唯一结算出口,而它已经在那儿广播了;再从 core 拉一条端口就是同一件事记两遍 |
 *
 * 前两类走**端口**而不是让 connector 直接 import 这里:connector 在纯运行时层
 * (`src/external-agents/`),那一层不认识 `@onething/backend`。端口的形状与 E4 的
 * `permissionHandler` / `interactionHandler` 逐字同款 —— 装配层装上,不装就是不记账。
 *
 * ## 房间从哪来
 *
 * 三类事件手上都只有**执行会话 id**,而时间轴是按房落盘的。翻译靠 D6-a 的回合登记簿
 * (`turn-context.ts` 的 `findCollabV3Turn`):它在 drive 发出去之前就登记了
 * `{agentId, roomSessionId, leaseId}`,所以外部回合里任何一个迟到的回调都查得到自己
 * 在哪间房。查不到 = 这条会话此刻不在任何一轮 v3 回合里(独立聊天窗里跟 Claude Code
 * 对话就是这一支)—— **不记账,也不报错**:那种场合根本没有房间时间轴可写。
 *
 * ## 因果引用
 *
 * 三类的 `triggeredBy` 全部是**牌号**(`leaseId`)—— 于是「发牌 → 外部回合起 → 跑了
 * 哪几个工具 / 卡在哪次提问 → 回合落 → 收牌」在文件里是一条连得起来的链,与本地回合
 * 的 `grant → speak → yield` 接在同一个节点上。提问的后四相另指回 `open` 那一行的
 * `interactionId`,因为一次提问的开与结之间可能隔着好几分钟和别人的好几行。
 *
 * ## 保密纪律
 *
 * 一个字的正文都不进:提问只记题数不记题干,工具只记名字与决定不记 input。
 * 类型级门(`COLLAB_SCHEDULER_LOG_CARRIES_NO_TRANSCRIPT`)守着这条,新加的三类
 * 与原来十四类过的是同一道。
 */
import {
  collabSchedulerExternalTool,
  collabSchedulerExternalTurn,
  collabSchedulerInteraction,
  type CollabExternalTurnOutcome,
  type CollabSchedulerInteractionPhase,
  type CollabSchedulerLogRow,
  type CollabSchedulerLogSink,
} from '@onething/runtime/collab/actors'

import { getEventBus } from '../../events/index.js'
import { broadcastCollabAgentActivity } from './agent-activity.js'
import { findCollabV3Turn } from '@onething/runtime/collab/actors/turn-context.wiring'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.observability')


/* ── 写入口 ───────────────────────────────────────────────────────────────── */

let sink: CollabSchedulerLogSink | null = null

/**
 * 装上(或以 null 摘下)时间轴的写入口。由 v3 运行时在起停两端调 ——
 * 与 `configureCollabAgentActivitySource` 同一时机、同一条纪律:
 * **不装 = 不记账**,观测是旁路,没有它不该让同一条剧本跑出两个结果。
 */
export function configureCollabExternalLogSink(next: CollabSchedulerLogSink | null): void {
  sink = next
}

/** 写一行。写失败在落盘那一层已经被吞过一次,这里只挡「没装」与「不在房里」。 */
function append(roomSessionId: string, row: CollabSchedulerLogRow): void {
  if (!sink) return
  try {
    sink.append(roomSessionId, row)
  } catch (error) {
    log.warn('external scheduler timeline append failed', { roomSessionId }, error)
  }
}

/* ── external-turn / external-tool 的端口 ─────────────────────────────────── */

/**
 * connector 侧的观测口(纯层的 `ExternalAgentObserver` 的实现)。
 *
 * 两个方法都是**同步、绝不抛**:它们挂在外部回合的关键路径上,一次记账失败让那一轮
 * 炸掉是把「看不见」升级成「跑不动」(与落盘层同一条理由)。
 */
export function recordExternalAgentTurn(input: {
  localSessionId: string
  connectorId: string
  phase: 'start' | 'end'
  outcome?: CollabExternalTurnOutcome
  elapsedMs?: number
  at?: number
}): void {
  const turn = findCollabV3Turn(input.localSessionId)
  if (!turn) return
  append(turn.roomSessionId, collabSchedulerExternalTurn({
    at: input.at ?? Date.now(),
    agentId: turn.agentId,
    connectorId: input.connectorId,
    phase: input.phase,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
    triggeredBy: turn.leaseId,
  }))
}

export function recordExternalAgentTool(input: {
  localSessionId: string
  connectorId: string
  toolName: string
  decision: 'allow' | 'deny'
  hostTool: boolean
  toolCallId?: string
  at?: number
}): void {
  const turn = findCollabV3Turn(input.localSessionId)
  if (!turn) return
  append(turn.roomSessionId, collabSchedulerExternalTool({
    at: input.at ?? Date.now(),
    agentId: turn.agentId,
    connectorId: input.connectorId,
    toolName: input.toolName,
    decision: input.decision,
    hostTool: input.hostTool,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    triggeredBy: turn.leaseId,
  }))
}

/* ── interaction:总线观测 ────────────────────────────────────────────────── */

/**
 * 提问的五相,以及**「等你回答」这盏灯**。
 *
 * 一次订阅办两件事,刻意的:两件事的触发时机逐字相同(提问开了 / 结了),拆成两处
 * 订阅只会多一份「其中一处忘了跟上」的机会。审批那条链同理接在这里 —— 它与提问是
 * 两条并列的等待链,而快照上的 `waitingOn` 是它们共用的那一格。
 *
 * 广播走**活动档**:`waitingOn` 是会亮会灭的灯,不是一个数字(见
 * `agent-activity.ts` 的双档说明)。
 */
export function installCollabExternalObservers(): () => void {
  const bus = getEventBus()
  const unsubscribes = [
    bus.onAnySession(SESSION_EVENT_TYPES.INTERACTION_REQUESTED, envelope => {
      const request = envelope.event.request
      recordInteraction(envelope.sessionId, {
        phase: 'open',
        interactionId: request.id,
        origin: request.origin,
        questionCount: request.questions.length,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        // 开的那一行指回牌号(它是这一轮的根),后面几相才指回它自己。
        triggeredByLease: true,
      })
    }, 'collab-external-interaction-open'),

    bus.onAnySession(SESSION_EVENT_TYPES.INTERACTION_SETTLED, envelope => {
      const answer = envelope.event.answer
      recordInteraction(envelope.sessionId, {
        phase: answer.outcome,
        interactionId: answer.id,
        // origin / questionCount 一格都不补:结算事件载的是答案,它身上没有这两格,
        // 猜一个就是往账里写假话。它们在 `open` 那一行上,靠 `triggeredBy` 串起来读。
        ...(envelope.event.toolCallId ? { toolCallId: envelope.event.toolCallId } : {}),
        triggeredByLease: false,
      })
    }, 'collab-external-interaction-settle'),

    // 审批链只点灯不记账:它在时间轴上已经有自己的位置(策略门那一侧),
    // 这里要的只是让 `waitingOn` 那一格及时翻面。
    bus.onAnySession(SESSION_EVENT_TYPES.PERMISSION_REQUEST, envelope => {
      lightWaitingOn(envelope.sessionId)
    }, 'collab-external-permission-light'),
    bus.onAnySession(SESSION_EVENT_TYPES.PERMISSION_SETTLED, envelope => {
      lightWaitingOn(envelope.sessionId)
    }, 'collab-external-permission-light'),
  ]
  return () => {
    for (const unsubscribe of unsubscribes) {
      try { unsubscribe() } catch { /* noop */ }
    }
  }
}

function recordInteraction(
  sessionId: string,
  input: {
    phase: CollabSchedulerInteractionPhase
    interactionId: string
    origin?: 'external-agent' | 'host-tool'
    questionCount?: number
    toolCallId?: string
    triggeredByLease: boolean
  },
): void {
  const turn = findCollabV3Turn(sessionId)
  if (!turn) return
  // 注:房间转录里那一行「XX 正在等你回答」**不在这里** —— 记账与说话是两件事,
  // 而说话要的名册会把半个主进程拖进这个模块的图里(观测面刻意只认三样东西:
  // 总线、时间轴写入口、v3 登记簿)。那一行装在 `actors/runtime.ts`,与其他
  // 系统行同一处出口。
  append(turn.roomSessionId, collabSchedulerInteraction({
    at: Date.now(),
    phase: input.phase,
    interactionId: input.interactionId,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.questionCount === undefined ? {} : { questionCount: input.questionCount }),
    agentId: turn.agentId,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    triggeredBy: input.triggeredByLease ? turn.leaseId : input.interactionId,
  }))
  broadcastCollabAgentActivity(turn.agentId, { activity: true })
}

/** 只点灯,不记账。 */
function lightWaitingOn(sessionId: string): void {
  const turn = findCollabV3Turn(sessionId)
  if (!turn) return
  broadcastCollabAgentActivity(turn.agentId, { activity: true })
}
