/**
 * 生产用的 WorkerMindPort:把一份工作交给**真的引擎**跑
 * (docs/design/collab-actor-v3.md §1.6)。
 *
 * ## 本期只写不接
 *
 * 这个文件在 D4 **没有任何生产调用点** —— v2 的 worker 链(`worker.ts` 的板事件
 * 监听 + 队列 + spawn/harvest)仍然是生产,接线在 D6。写在这里而不是等到 D6 一起
 * 写,理由与 `engine-mind-port.ts` 同一条:端口的形状要由「真机那一侧到底需要
 * 什么」来定,而不是由假端口的方便程度来定。
 *
 * ## 复用哪些、不 import 什么
 *
 * 复用 C2-5 的四个基元(`turn-primitives.ts`):drive 信封、模型绑定取舍、超时后
 * 的僵尸流兜底、房内 say 的倒序收割 —— 它们是叶子模块,谁 import 都不成环。
 *
 * **不 import `worker.ts`**:那是 v2 编排的入口(板事件监听、房间闸、FIFO 队列、
 * 收养回声),而 v3 的编排在 AgentActor 与子 actor 里;搭上去等于把刚拆开的那个
 * 环换个方向重新接上,而且 D6 要整层删掉它。代价是这里重写了一遍**等终端事件**
 * 与**工作会话的准备**——两段都不带 v2 的编排语义,只剩机械动作。
 *
 * **不 import `board-store.ts`**:卡的读写归 `CollabWorkerBoardPort`(D6 接)。
 * 一个既驱动会话又直写看板的端口,会让「这份工作跑成了什么」有两个属主。
 *
 * **不挂 typing 观察器**:`typing-observer.ts` 经 `inspector.ts` 连着 v2 协调器的
 * 快照面,而那一面 D6 要重画。W19 的灯在 v3 由房间快照点亮,接线时一并处理。
 *
 * ## 与 `engine-mind-port` 的四处有意分歧
 *
 * | | 对话回合 | 工作回合 |
 * | --- | --- | --- |
 * | 会话 | 既有执行会话(`agent-exec-…`) | **work 会话**(新建 / 续做) |
 * | 墙钟 | 10 分钟 | **30 分钟**(v2 原值) |
 * | 计费归属 | `COLLAB_USAGE_SOURCE_ROOM` | `COLLAB_USAGE_SOURCE_WORK` |
 * | 收割 | 房内 say + 宿主消息 | 房内 say + **代码采集的 evidence** |
 *
 * 分歧做成两个端口而不是一个带开关的,理由见 `worker-child.ts` 的
 * `CollabWorkerMindPort` 注释。
 */
import { randomUUID } from 'node:crypto'

import {
  COLLAB_USAGE_SOURCE_WORK,
  type CollabMentionLike,
} from '@onething/runtime/collab'
import {
  COLLAB_WORKER_START_TIMEOUT_MS,
  COLLAB_WORKER_WALL_CLOCK_MS,
  buildCollabWorkerBriefing,
  collectCollabWorkerEvidence,
  type CollabWorkerEvidenceRef,
  type CollabWorkerToolCallLike,
} from '@onething/runtime/collab/actors'
import { isActiveAgent, type ChatMessage } from '@shared/ipc.js'

import { findAgent } from '../../agents/index.js'
import { getEventBus } from '../../../events/index.js'
import { getStreamEngineSafe } from '../../engine/index.js'
import * as store from '../../../store.js'
import { sessionReads } from '../../../session/reads.js'
import { issueCollabDriveToken } from '@onething/runtime/collab/drive-guard'
import { collabRoomFolder, ensureCollabRoomFolder } from '../room-folder.js'
import {
  abortCollabZombieStream,
  collabAgentModelFields,
  collabDriveEnvelope,
  scanCollabRoomSays,
} from '../turn-primitives.js'
import type { CollabMindSay } from '@onething/runtime/collab/actors/mind-port'
import type {
  CollabWorkerMindPort,
  CollabWorkerRunRequest,
  CollabWorkerRunResult,
} from '@onething/runtime/collab/actors/worker-child'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('collab.actors.mind')


type TerminalOutcome = 'complete' | 'error' | 'aborted' | 'timeout'

/**
 * 等这条会话上下一个流的终端事件。
 *
 * 与 `engine-mind-port.ts` 的同名函数逐行同义(两个默认值不同)。没有把它抽成
 * 共用件:抽出来的那一个会立刻长出 `startTimeoutMs/totalTimeoutMs/…` 一串参数,
 * 而这三十行本身没有任何分支 —— 复制的是**机械动作**,不是决策。真正会漂的那
 * 部分(墙钟数字)已经在 `worker-rules.ts` 里只有一份。
 */
function waitForTerminalEvent(
  sessionId: string,
  startTimeoutMs: number,
  totalTimeoutMs: number,
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
      'collab-v3-work-wait',
    )
    const startTimer = setTimeout(() => {
      if (!sawStart) finish('timeout')
    }, startTimeoutMs)
    const totalTimer = setTimeout(() => finish('timeout'), totalTimeoutMs)
  })
}

/** 房间的连接器 —— 活干在工作会话里,但它属于那间房。 */
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
 * 这一段执行留下的痕迹。
 *
 * 走的是**整条工作会话**而不是「这一窗」:一张卡可能跑过好几段(中断 → 续做),
 * 而 evidence 回答的是「这张卡到底动过什么」——按窗切会让续做的那一份看起来
 * 只干了最后五分钟的活。口径与 v2 `collectWorkEvidence(task.workSessionIds)`
 * 一致(那边遍历卡上的全部会话,这边这条会话就是那一串里的当前项)。
 */
function collectEvidence(workSessionId: string, roomSessionId: string): CollabWorkerEvidenceRef[] {
  const messages = sessionReads.listMessages(workSessionId).messages
  const calls: CollabWorkerToolCallLike[] = []
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) calls.push(call as CollabWorkerToolCallLike)
  }
  const base = collabRoomFolder(roomSessionId)
  return collectCollabWorkerEvidence(calls, { ...(base ? { relativeTo: base } : {}) })
}

/** 群聊最近几条真消息 —— 任务书里那一块「这一刻的讨论」。 */
function roomTail(roomSessionId: string, limit: number): string {
  const messages = sessionReads.listMessages(roomSessionId).messages
  const tail: string[] = []
  for (let index = messages.length - 1; index >= 0 && tail.length < limit; index -= 1) {
    const message = messages[index]
    const content = (message.content ?? '').trim()
    if (!content) continue
    const who = message.role === 'user' ? '用户' : message.agentId ? agentLabel(message.agentId) : '系统'
    tail.unshift(`${who}: ${content}`)
  }
  return tail.join('\n')
}

function agentLabel(agentId: string): string {
  return findAgent(agentId)?.name ?? agentId
}

export interface CreateCollabEngineWorkerPortOptions {
  /** 时钟注入(排障脚本按转录时刻重放时用)。 */
  now?: () => number
  startTimeoutMs?: number
  totalTimeoutMs?: number
  /** 任务书里带几条群聊尾巴(v2 是 12)。 */
  roomTailLimit?: number
  /** 新工作会话的 id(测试与重放注入确定性种子)。 */
  newWorkSessionId?: () => string
}

/**
 * 真机的 WorkerMindPort。
 *
 * 一份工作 = 备好会话 → 先订阅 → 驱动 → 等终端事件 → 收割。**先订阅后驱动**与
 * 对话回合同一条理由:总线是同步投递的,一个在 `emit` 里就起完又结束的流会在
 * 等待者存在之前 settle(v2 P2-7)。
 */
export function createCollabEngineWorkerPort(
  options: CreateCollabEngineWorkerPortOptions = {},
): CollabWorkerMindPort {
  const now = options.now ?? Date.now
  const newWorkSessionId = options.newWorkSessionId ?? randomUUID

  return {
    name: 'engine-worker',

    async runWorkTurn(request: CollabWorkerRunRequest): Promise<CollabWorkerRunResult> {
      const engine = getStreamEngineSafe()
      // 引擎没绑就不驱动 —— 没有 sender 的命令会被引擎静默丢掉,而这张卡会
      // 显示成「在做」却什么都不会发生。等待的判断归派活那一侧,不归这里
      // (与 `engine-mind-port` 同一条收窄:没有 `waitForEngineBound`)。
      if (!engine?.hasCommandTarget()) return { outcome: 'skipped' }

      const agent = findAgent(request.agentId)
      if (!agent) return { outcome: 'skipped' }
      // 退休的人不开工(域模型 §3.2)。卡留在板上等改派。
      if (!isActiveAgent(agent)) return { outcome: 'skipped' }

      /**
       * 续做模式(collab-team-v2 §5.3)。
       *
       * 一张被中断过的卡带着它上一条工作会话。重开一条新会话等于把现场扔掉,
       * 让模型从零开始猜自己上次做到哪儿了;重驱**同一条**则什么都不用做 ——
       * 它自己的转录就是现场。这就是不变量二的兑现:流从不恢复,只重驱。
       */
      const previous = request.workSessionId
      const resuming = Boolean(previous && store.getSession(previous))
      const workSessionId = resuming ? previous! : newWorkSessionId()

      try {
        if (!resuming) {
          // 工作会话是幕后基础设施,建它不该动用户正在看的标签页。
          store.createSessionWithoutFocus(workSessionId, `[任务] ${request.title}`)
        }
        // C3-5:工作身份进了 system prompt(engine/prompt 的 work 分支),它要的
        // 卡框架从这份 meta 取。每次开工/续做都重盖一遍。
        store.updateSessionCollab(workSessionId, {
          kind: 'work',
          collab: {
            roomSessionId: request.roomSessionId,
            taskId: request.cardId,
            taskTitle: request.title,
          },
        })
        store.updateSessionAgent(workSessionId, request.agentId)

        /**
         * collab-team-v2 §7:工作台的 cwd **默认**是群 folder —— 「产出放哪儿」
         * 因此不需要任何新工具或新约定。
         *
         * 2026-08-11 止血 6(`docs/audit/self-hosting-gap-audit-2026-08-11.md`
         * P0-4):这句以前是无条件的,于是**任务自己带的工作目录会被每一轮重新
         * 盖回群 folder**。代价在自举场景里是致命的:一张「去仓库里改这个 bug」
         * 的卡,worker 一开工就被切进 `~/.onething/collab-rooms/<id>/`,它根本
         * 看不见那个仓库,只能在一间空屋子里摸索。
         *
         * 现在的口径与紧邻的 permissionMode 同一条:**缺席才给默认值**。会话上
         * 已经有工作目录(续做时用户改过的、建卡时指定的),就是它;一条什么都
         * 没有的新工作会话,才落到群 folder 上 —— 交付物语义因此一个字没变。
         */
        const boundWorkdir = store.getSession(workSessionId)?.workingDirectory?.trim()
        if (!boundWorkdir) {
          const workdir = ensureCollabRoomFolder(request.roomSessionId)
          if (workdir) store.updateSessionWorkingDirectory(workSessionId, workdir)
        }

        // 权限模式继承房间,**只在建会话的那一次**(P1-4):每次续做都重盖的话,
        // 用户手改过的那条会话会在下一轮被房间的值悄悄覆盖回去。
        const roomSession = store.getSession(request.roomSessionId)
        if (!resuming && roomSession?.permissionMode) {
          store.updateSessionPermissionMode(workSessionId, roomSession.permissionMode)
        }

        // P1-4:用户钉过的会话不带命令级 override,也不回写系统那份绑定 ——
        // 后者会把「用户选过」抹成「没选过」。
        const pinned = store.getSession(workSessionId)?.modelPinned === true
        if (!pinned && agent.model?.providerId && agent.model?.modelId) {
          store.updateSessionModel(workSessionId, agent.model.providerId, agent.model.modelId, { pinned: false })
        }

        // 交付时顺手 @ 谁。自己就是负责人的话不提 —— 「@ 你自己」是一句噪声。
        const pm = roomSession?.room?.pmAgentId
        const pmName = pm && pm !== request.agentId ? agentLabel(pm) : undefined

        const startedAt = now()
        const driveToken = issueCollabDriveToken()
        const turnEnded = waitForTerminalEvent(
          workSessionId,
          request.startTimeoutMs ?? options.startTimeoutMs ?? COLLAB_WORKER_START_TIMEOUT_MS,
          request.totalTimeoutMs ?? options.totalTimeoutMs ?? COLLAB_WORKER_WALL_CLOCK_MS,
        )

        await getEventBus().emit(workSessionId, {
          ...collabDriveEnvelope({
            channel: roomConnector(request.roomSessionId),
            content: buildCollabWorkerBriefing({
              ...(roomSession?.name ? { roomName: roomSession.name } : {}),
              cardId: request.cardId,
              title: request.title,
              ...(request.description ? { description: request.description } : {}),
              ...(request.boardDigest ? { boardDigest: request.boardDigest } : {}),
              roomTail: roomTail(request.roomSessionId, options.roomTailLimit ?? 12),
              resuming,
              ...(pmName ? { pmName } : {}),
            }),
            // W13.3:任务执行记 WORK,不是一次匿名 chat。归属而已 —— 预算闸仍按
            // sessionId 求和。
            usageSource: COLLAB_USAGE_SOURCE_WORK,
          }),
          ...(driveToken ? { collabDriveToken: driveToken } : {}),
          // 同 engine-mind-port:验过票的 drive 才有资格指名主体。
          ...(driveToken ? { principal: { kind: 'agent', agentId: request.agentId } } : {}),
          ...collabAgentModelFields(agent, pinned),
        } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

        const outcome = await turnEnded
        // 超时不留僵尸流:槽位马上要放,而「一张卡同时只有一只手」这条不变式
        // 指望流真的结束。
        abortCollabZombieStream(outcome, workSessionId)

        // 不论结局都收割:一个被 abort 的半截回合里说出去的话**已经在房间里了**。
        const roomMessages = sessionReads.listMessages(request.roomSessionId).messages
        const { says } = scanCollabRoomSays(roomMessages, request.agentId, startedAt)
        const evidence = collectEvidence(workSessionId, request.roomSessionId)

        return {
          outcome,
          workSessionId,
          says: says.map(toMindSay),
          ...(evidence.length ? { evidence } : {}),
        }
      } catch (error) {
        // 会话都备不出来 = 这一轮压根没跑成。抛回给子 actor 会被它记成 `error`,
        // 但这里自己返回更诚实:`workSessionId` 要带回去,不然一次失败的开工会
        // 在盘上留一条没人认领的会话。
        log.error('work turn failed', {}, error)
        return {
          outcome: 'error',
          workSessionId,
          summary: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
