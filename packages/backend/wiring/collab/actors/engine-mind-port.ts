/**
 * 生产用的 MindPort:把一轮对话性回合交给**真的引擎**跑
 * (docs/design/collab-actor-v3.md §1.2)。
 *
 * ## 本期只写不接
 *
 * 这个文件在 D2 **没有任何生产调用点** —— v2 的调度链(coordinator/queue/turn)
 * 仍然是生产,接线在 D6。写在这里而不是等到 D6 一起写,是因为端口的形状要由
 * 「真机那一侧到底需要什么」来定,而不是由假端口的方便程度来定:一个只被
 * FakeMindPort 满足过的接口,到接线那天多半要重画。
 *
 * ## 四个基元来自 `turn-primitives.ts`,回合本体**不**来自 `turn.ts`
 *
 * 复用的是 C2-5 已经合成过一次的那四块 —— drive 信封、模型绑定取舍、超时后的
 * 僵尸流兜底、房内 say 的倒序收割。它们是叶子模块,谁 import 都不成环。
 *
 * `turn.ts` 本体不 import:那是 v2 编排的入口(队列、级联、意愿判定、房间运行时),
 * 而 v3 的编排在房间与心智循环里。搭上去等于把刚拆开的那个环换个方向重新接上,
 * 而且 D6 要整层删掉它。代价是这里重写了一遍**等终端事件**(30 行)与**注入**
 * (40 行)——两段都不带 v2 的编排语义,只剩机械动作。
 *
 * ## 一条刻意的收窄:没有 `waitForEngineBound`
 *
 * v2 的回合起跑前会等最多五分钟的「引擎绑定」(桌面端等窗口)。v3 不等:引擎没绑
 * 就是 `skipped`,牌当场交回去。房间的座位是稀缺资源,而一个挂五分钟的回合会把
 * 它占住 —— 等待的判断属于**房间**(要不要现在发这张牌),不属于拿到牌之后的
 * 这一步。
 */
import {
  COLLAB_MESSAGE_SOURCE,
  COLLAB_USAGE_SOURCE_ROOM,
  type CollabMentionLike,
} from '@onething/runtime/collab'
import type { ChatMessage } from '@shared/ipc.js'

import { findAgent } from '../../agents/index.js'
import { getEventBus } from '../../../events/index.js'
import { getStreamEngineSafe } from '../../engine/index.js'
import * as store from '../../../store.js'
import { sessionReads } from '../../../session/reads.js'
import { noteCollabAdoptedEcho } from '../agent-session.js'
import { issueCollabDriveToken } from '@onething/runtime/collab/drive-guard'
import { emitCollabTurnActive, observeCollabSayTyping } from '../typing-observer.js'
import {
  abortCollabZombieStream,
  collabAgentModelFields,
  collabDriveEnvelope,
  scanCollabRoomSays,
} from '../turn-primitives.js'
import type {
  CollabMindPort,
  CollabMindSay,
  CollabMindSteerRequest,
  CollabMindTurnRequest,
  CollabMindTurnResult,
} from '@onething/runtime/collab/actors/mind-port'
import {
  beginCollabV3Turn,
  collabV3SpeakPort,
  endCollabV3Turn,
} from '@onething/runtime/collab/actors/turn-context.wiring'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.actors.mind')


/** 起流的等待上限。没见到 `stream:start` 就是没跑起来。 */
const TURN_START_TIMEOUT_MS = 20_000
/** 一轮的总墙钟。超了掐流(见 `abortCollabZombieStream`)。 */
const TURN_TOTAL_TIMEOUT_MS = 10 * 60_000
/** 注入等一个工具回合边界的上限。超过它就当作「这一轮不会再读了」。 */
const STEER_CONSUME_TIMEOUT_MS = 10 * 60_000
/** 收尾正文超过这个长度还零 say = 「写而未发」;更短的当收尾自语,算真沉默。 */
const COLLAB_UNSENT_PROSE_MIN = 40

/** 注入消息在执行会话里的来源标记 —— 刻意**不是** `COLLAB_MESSAGE_SOURCE`。
 *  那个标记的语义是「这是一条驱动」,而注入消息会被引擎持久化进执行会话;打上
 *  它,下一轮的历史构建就会把这条注入当成「本轮驱动」追到上下文尾部。 */
export const COLLAB_V3_STEER_SOURCE = 'collab-steer'

type TerminalOutcome = 'complete' | 'error' | 'aborted' | 'timeout'

/**
 * 等这条会话上下一个流的终端事件。
 *
 * 与 v2 `waitForRoomTurn` 逐行同义,重写在这里的理由见文件头。两个定时器:
 * 起流超时(没见到 `stream:start`)与总墙钟,任何一个先到都算 `timeout`。
 */
function waitForTerminalEvent(
  sessionId: string,
  startTimeoutMs = TURN_START_TIMEOUT_MS,
  totalTimeoutMs = TURN_TOTAL_TIMEOUT_MS,
): Promise<TerminalOutcome> {
  return new Promise<TerminalOutcome>(resolve => {
    let sawStart = false
    let settled = false
    const finish = (outcome: TerminalOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(startTimer)
      clearTimeout(totalTimer)
      unsubscribe()
      resolve(outcome)
    }
    const unsubscribe = getEventBus().onAny(
      sessionId,
      envelope => {
        const type = (envelope.event as { type?: string } | undefined)?.type
        if (type === SESSION_EVENT_TYPES.STREAM_START) sawStart = true
        else if (type === SESSION_EVENT_TYPES.STREAM_COMPLETE) finish('complete')
        else if (type === SESSION_EVENT_TYPES.STREAM_ERROR) finish('error')
        else if (type === SESSION_EVENT_TYPES.STREAM_ABORTED) finish('aborted')
      },
      'collab-v3-turn-wait',
    )
    const startTimer = setTimeout(() => {
      if (!sawStart) finish('timeout')
    }, startTimeoutMs)
    const totalTimer = setTimeout(() => finish('timeout'), totalTimeoutMs)
  })
}

/**
 * 房间的连接器 —— 回合跑在执行会话里,但它答的是这间房,出站路由与权限亲和
 * 都跟着房走。
 *
 * 这两行与 v2 `room-runtime.ts#roomChannel` 同义,没有 import 它:那个文件是
 * v2 房间运行时的门面(队列、活动记录、快照广播),为两行代码搭上去等于给这个
 * 叶子模块接一条通往整条 v2 链的实边。
 */
function roomConnector(roomSessionId: string): string | undefined {
  const live = getStreamEngineSafe()?.getChannel(roomSessionId)
  if (live && live !== 'ipc') return live
  return store.getSession(roomSessionId)?.lastConnector || live
}

function toMindSay(message: ChatMessage): CollabMindSay {
  const mentions: CollabMentionLike[] = (message.mentions ?? [])
    .filter(mention => typeof mention?.agentId === 'string')
    .map(mention => ({ agentId: mention.agentId as string, label: mention.label }))
  return {
    content: message.content ?? '',
    ...(mentions.length ? { mentions } : {}),
    ...(message.id ? { messageId: message.id } : {}),
    ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
  }
}

/**
 * 回合的宿主消息 —— 执行会话里这一窗最新的那条 assistant 记录。
 *
 * 多带一个 `prose`(正文原文),端口内部用:收养式兜底要搬运的就是它。它**不**
 * 进 `CollabMindTurnResult` —— 那一层只需要「有没有、有多长」,给它全文等于让每
 * 一个读者都有机会把回合正文当成一条发言(见 `mind-port.ts` 的 `turnMessage`)。
 */
function harvestTurnMessage(
  execSessionId: string,
  sinceTs: number,
): { id?: string; proseChars: number; at?: number; prose: string } | undefined {
  const messages = sessionReads.listMessages(execSessionId).messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.timestamp < sinceTs) break
    if (message.role !== 'assistant') continue
    const prose = (message.content ?? '').trim()
    return {
      ...(message.id ? { id: message.id } : {}),
      proseChars: prose.length,
      ...(typeof message.timestamp === 'number' ? { at: message.timestamp } : {}),
      prose,
    }
  }
  return undefined
}

export interface CreateCollabEngineMindPortOptions {
  /** 时钟注入(排障脚本按转录时刻重放时用)。 */
  now?: () => number
  startTimeoutMs?: number
  totalTimeoutMs?: number
}

/**
 * 真机的 MindPort。
 *
 * 一轮 = 先订阅、再驱动、等终端事件、收割。**先订阅后驱动**不是风格问题:
 * 总线是同步投递的,一个在 `emitDrive` 里就起完又结束的流会在等待者存在之前
 * settle —— 那一轮会坐满整个起流超时,然后被当成它从来不是的僵尸掐掉(v2 P2-7)。
 */
export function createCollabEngineMindPort(
  options: CreateCollabEngineMindPortOptions = {},
): CollabMindPort {
  const now = options.now ?? Date.now

  return {
    name: 'engine',

    async runConversationalTurn(request: CollabMindTurnRequest): Promise<CollabMindTurnResult> {
      const engine = getStreamEngineSafe()
      // 引擎没绑就不驱动:没有 sender 的命令会被引擎静默丢掉,而那一轮会白白
      // 烧掉一张牌(等待的判断归房间,见文件头)。
      if (!engine?.hasCommandTarget()) return { outcome: 'skipped', says: [] }

      const agent = findAgent(request.agentId)
      if (!agent) return { outcome: 'skipped', says: [] }

      // 会话被用户钉过模型就一个绑定字段都不带 —— 命令级 override 会整个盖过会话
      // 自己的配置,于是用户在那个会话 UI 里挑的模型永远生效不了(P1-4)。
      const modelPinned = store.getSession(request.execSessionId)?.modelPinned === true
      const startedAt = now()
      const driveToken = issueCollabDriveToken()

      /**
       * 回合语境的登记(D6-a)。
       *
       * `send_message` 只拿得到 `sessionId`,而 v3 的房间验票 —— 票在这张表里。
       * 登记必须在 **emit 之前**:总线是同步投递的,工具可能在 `emit` 还没返回
       * 的时候就已经被调用了。
       */
      beginCollabV3Turn({
        agentId: request.agentId,
        roomSessionId: request.roomSessionId,
        execSessionId: request.execSessionId,
        leaseId: request.lease.leaseId,
        epoch: request.lease.epoch,
        startedAt,
      })
      // W19 的灯:观察器挂在**执行会话**的事件流上(回合就跑在那儿),灯点在房间。
      // 断路器同理 —— 它是引擎侧的回合内计数,与这里挂不挂无关,v3 回合照样受它管。
      const detachTyping = observeCollabSayTyping({
        sessionId: request.execSessionId,
        roomSessionId: request.roomSessionId,
        agentId: request.agentId,
      })
      // 停止按钮要在人伸手的那一刻就已经画好(collab-team-v2 §5.1)。
      emitCollabTurnActive(request.roomSessionId, request.agentId, true)

      try {
        const turnEnded = waitForTerminalEvent(
          request.execSessionId,
          options.startTimeoutMs,
          options.totalTimeoutMs,
        )
        await getEventBus().emit(request.execSessionId, {
          ...collabDriveEnvelope({
            channel: roomConnector(request.roomSessionId),
            content: request.driveContent,
            // W13.3:这一轮记房间的账,不是匿名 chat。归属而已 —— 预算闸仍按
            // sessionId 求和。
            usageSource: COLLAB_USAGE_SOURCE_ROOM,
          }),
          // 标记说这是什么,令牌证明是谁发的:引擎的 room/exec 门因此不必信一个字符串。
          ...(driveToken ? { collabDriveToken: driveToken } : {}),
          // 令牌既然证明了「是协调者发的」,它就有资格指名这一轮的行动主体。
          // 引擎那侧只在验票通过时才采信这个字段(engine/turn-principal.ts)。
          ...(driveToken ? { principal: { kind: 'agent', agentId: request.agentId } } : {}),
          // 这一轮答的是哪张牌。落在执行会话里 = 一份比内存账活得久的幂等凭据。
          collabLeaseId: request.lease.leaseId,
          ...collabAgentModelFields(agent, modelPinned),
        } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

        const outcome = await turnEnded
        // 等待放弃了,请求并没有:它会继续拿整个上下文来回打,而这一轮已经没有人在听。
        abortCollabZombieStream(outcome, request.execSessionId)

        // 不论结局都收割:一个被 abort 的半截回合里说出去的话**已经在房间里了**。
        const roomMessages = sessionReads.listMessages(request.roomSessionId).messages
        const { says } = scanCollabRoomSays(roomMessages, request.agentId, startedAt)
        const turnMessage = harvestTurnMessage(request.execSessionId, startedAt)
        const harvested = says.map(toMindSay)

        /**
         * 收养式兜底(2026-08-02「写而未发」,v3 落点)。
         *
         * 零 say + 收尾正文达标 = 它写完了却没按发送。**只搬运已写好的文本,不再
         * 驱动模型** —— 被拆除的 W14d nudge 死在补救轮里模型重发,而这里的前提就是
         * 本回合零发送,重复在结构上不可能发生。
         *
         * 走的是与 `send_message` **同一条** speak(同一张牌、同一套门、同一个幂等
         * 窗),所以收养出来的消息与它自己说的那句在房间里没有任何区别。
         */
        if (outcome === 'complete' && harvested.length === 0) {
          const adopted = await adoptUnsentProse(request, turnMessage?.prose ?? '')
          if (adopted) harvested.push(adopted)
        }

        return {
          outcome,
          says: harvested,
          ...(turnMessage
            ? {
                turnMessage: {
                  ...(turnMessage.id ? { id: turnMessage.id } : {}),
                  proseChars: turnMessage.proseChars,
                  ...(turnMessage.at === undefined ? {} : { at: turnMessage.at }),
                },
              }
            : {}),
        }
      } finally {
        detachTyping()
        emitCollabTurnActive(request.roomSessionId, request.agentId, false)
        endCollabV3Turn(request.execSessionId, request.lease.leaseId)
        /**
         * 每日摘要的触发点(D6-b:从删掉的 `turn.ts` 回合尾原样接过来)。
         *
         * 回合的首字延迟押在一个后台任务上;晚一轮拿到摘要是可接受的代价,而
         * `<Folded count>` 在此期间照旧诚实地说少了多少条。开关见
         * `room.context.dailyDigest`。
         *
         * **动态 import 是刻意的**:摘要跑模型,所以它的静态图里挂着整个 provider
         * 栈(settings 仓库 → stores/paths)。静态引它,这个文件就把那条依赖带给
         * 每一个 import 它的装配测试 —— 那些测试 partial-mock `stores/paths`,
         * 于是会在收集阶段就炸。这是一个真正的后台子系统,按需加载正合适。
         */
        void import('../digest-runner.js')
          .then(module => module.ensureCollabDigestsForRoom(request.roomSessionId))
          .catch((error: unknown) => {
            log.error('daily digest trigger failed', { roomSessionId: request.roomSessionId }, error)
          })
      }
    },

    /**
     * 把一条中途到达的同房消息并进正在跑的这一轮。
     *
     * 等一个结果而不是投完就走:注入在**工具回合边界**才被 drain,而一个回合可能
     * 已经跑到了最后一轮 —— 那条消息就会烂在队列里,等到这个 agent 下次被驱动时
     * 才以一个完全错位的时序出现在它眼前。所以迟到要撤回(v2 steer.ts 第三处收窄)。
     */
    async steer(request: CollabMindSteerRequest): Promise<boolean> {
      const engine = getStreamEngineSafe()
      const body = request.body.trim()
      if (!engine || !body) return false

      let queuedMessageId: string | undefined
      let settle: ((consumed: boolean) => void) | undefined
      const outcome = new Promise<boolean>(resolve => {
        let settled = false
        const finish = (consumed: boolean): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          resolve(consumed)
        }
        settle = finish
        const unsubscribe = getEventBus().onAny(
          request.execSessionId,
          envelope => {
            const event = envelope.event as { type?: string; messageId?: string } | undefined
            switch (event?.type) {
              case SESSION_EVENT_TYPES.STEERING_QUEUED:
                if (event.messageId) queuedMessageId = event.messageId
                return
              case SESSION_EVENT_TYPES.STEERING_CONSUMED:
                finish(true)
                return
              case SESSION_EVENT_TYPES.STREAM_COMPLETE:
              case SESSION_EVENT_TYPES.STREAM_ERROR:
              case SESSION_EVENT_TYPES.STREAM_ABORTED:
                // 回合结束了却没人 drain 过 —— 这条注入迟到了。
                finish(false)
                return
              default:
            }
          },
          'collab-v3-steer',
        )
        const timer = setTimeout(() => finish(false), STEER_CONSUME_TIMEOUT_MS)
      })

      try {
        engine.steerMessage(request.execSessionId, body, COLLAB_V3_STEER_SOURCE)
      } catch (error) {
        log.error('steer inject failed', { execSessionId: request.execSessionId }, error)
        settle?.(false)
        return false
      }

      if (await outcome) return true

      if (queuedMessageId) {
        try {
          engine.retractSteerMessage(request.execSessionId, queuedMessageId)
        } catch (error) {
          log.error('steer retract failed', { execSessionId: request.execSessionId, queuedMessageId }, error)
        }
      }
      return false
    },
  }
}

/**
 * 「写而未发」的收养:把回合里写好却没送出去的正文,经**同一张牌**代发进房间。
 *
 * 三条与 v2 逐条对齐:
 *  - **阈值**(`COLLAB_UNSENT_PROSE_MIN`):更短的当收尾自语,算真沉默;
 *  - **回声登记**:代发的是作者**自己**的消息,而自己的消息永不进自己的未读
 *    (history-window.ts)—— 不留这一笔,作者下一轮读到的世界里那段话仍然没发
 *    出去,再发一遍是它合理的下一步(架构审查 A6);
 *  - **失败不重试**:房间冻结 / 超预算 / 已除名,回落静默收尾。
 *
 * 返回值带 `messageId` —— AgentActor 据此认出「这句已经在房间里了」,不会再发一次
 * `agent:speak`(见 `agent-actor.ts` 的收尾)。
 */
async function adoptUnsentProse(
  request: CollabMindTurnRequest,
  prose: string,
): Promise<CollabMindSay | undefined> {
  if (prose.length < COLLAB_UNSENT_PROSE_MIN) return undefined
  const speak = collabV3SpeakPort()
  if (!speak) return undefined
  try {
    const delivered = await speak({
      agentId: request.agentId,
      roomSessionId: request.roomSessionId,
      leaseId: request.lease.leaseId,
      content: prose,
    })
    if (!delivered.ok || !delivered.messageId) return undefined
    noteCollabAdoptedEcho(request.execSessionId, delivered.messageId)
    return { content: prose, messageId: delivered.messageId }
  } catch (error) {
    log.error('adopted relay say failed', { execSessionId: request.execSessionId }, error)
    return undefined
  }
}

/** drive 信封上的来源标记 —— 与 v2 同一个常量,导出只为让接线那侧有一处可断言。 */
export const COLLAB_V3_DRIVE_SOURCE = COLLAB_MESSAGE_SOURCE

/** 一张牌的 id 在命令上的字段名。D6 的引擎侧门按它认「这一轮答的是哪张牌」。 */
export const COLLAB_V3_LEASE_FIELD = 'collabLeaseId'
