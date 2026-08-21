/**
 * 派工的**装配层** —— `task` 工具背后的那台机器
 * (`docs/audit/self-hosting-gap-audit-2026-08-11.md` P0-3 / P0-5)。
 *
 * ## 一句话
 *
 * 建一条不抢焦点的真会话 → 先订阅终端事件 → 用既有的 `command:send-message` 驱动它
 * → 工具**当场返回** → 那边跑完了,沿插件信使的唤醒路径把**完整**结果投回调用方。
 *
 * ## 每一环都是既有的
 *
 * 这个文件几乎没有新机制,它是四段现成链路的接线:
 *
 * | 环 | 复用的东西 |
 * | --- | --- |
 * | 建会话不抢焦点 | `store.createSessionWithoutFocus`(collab 的四个调用点同款) |
 * | 驱动 | `command:send-message` —— 与调度器、语音、网关、插件同一条命令 |
 * | 等终端事件 | `eventBus.onAny` 上的 `stream:complete/error/aborted`(与 collab 的 worker 逐行同义) |
 * | 回投唤醒 | `deliverInternalMessage`(插件 N1 的三态矩阵 + 链长闸 + 频率闸,一本账) |
 *
 * **没有新队列,没有轮询,没有第二本账。**
 *
 * ## 与 collab worker 的四处分歧(正是审计骂的那四条)
 *
 * | | collab `board start` | 派工 |
 * | --- | --- | --- |
 * | cwd | 无条件切群目录(P0-4 已改成「缺席才给默认值」) | **继承调用方会话**,或参数指定 |
 * | 完成 | 只 fold 进看板,父会话不动 | **叫醒调用方**(idle 起轮 / busy 降级 steer) |
 * | 回报 | 硬截 200 字符 | **不截断**(走的是另一条路径,collab 那条截断一个字没动) |
 * | 语义 | assign ≠ launch | 调用即开跑 |
 *
 * ## 已知边界(v1,写在这里也写进工具描述与文档)
 *
 * - 工作会话可能**停在审批卡**上等人。它是一条普通会话,人点得进去回答;v1
 *   不做「卡住了也叫醒你」—— 那需要一条独立于终端事件的通知路径,不在本期。
 *   兜底是墙钟:超时会如实报一句「超时结束,会话仍在」。
 * - 没有 kill 工具。工具结果与报告都带 `taskSessionId`,停它 = 打开那条会话按停止。
 * - 并发账是**内存态**。进程重启后在飞的任务不再被等待(它们的会话还在盘上,
 *   人点得进去看结果)。给它落盘等于第二本账,而两本账迟早会漂。
 */
import { randomUUID } from 'node:crypto'
import type { MessageOrigin } from '@shared/ipc.js'
// 子路径直取:`TaskSessionRef` 是本期新加的类型,而 `@shared/ipc` 的 index 是一份
// 逐名再导出的清单 —— 走子路径省掉那次清单改动(其它 app 模块同样这么取)。
import type { TaskSessionRef } from '@shared/ipc/chat.js'
import {
  TASK_MAX_CONCURRENT_PER_SESSION,
  TASK_START_TIMEOUT_MS,
  TASK_WALL_CLOCK_MS,
  isTaskSession,
  renderTaskReport,
  taskSessionName,
  type TaskOutcome,
} from '@onething/runtime/tasks'
import type {
  TaskDispatchOutcome,
  TaskDispatchRequest,
} from '@onething/runtime/toolkit'

import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { getEventBus } from '../../events/index.js'
import { getStreamEngineSafe } from '../engine/index.js'
import { taskMessageSource } from '../../channel/origin.js'
import { deliverInternalMessage } from '../plugins/sessions.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('tasks')


/* ── 在飞的账(内存态,单一属主)────────────────────────────────────────────── */

interface ActiveTask {
  callerSessionId: string
  description?: string
  startedAt: number
}

const activeTasks = new Map<string, ActiveTask>()

/** 这条调用方会话上此刻在跑几个。 */
export function runningTaskCount(callerSessionId: string): number {
  let count = 0
  for (const task of activeTasks.values()) {
    if (task.callerSessionId === callerSessionId) count += 1
  }
  return count
}

/** 测试与进程收摊用。 */
export function resetTaskDispatchLedger(): void {
  activeTasks.clear()
}

/* ── 终端事件 ─────────────────────────────────────────────────────────────── */

/**
 * 等这条工作会话上下一个流的终端事件。
 *
 * 与 collab 的 `waitForTerminalEvent` 逐行同义(两个默认值不同)。没有抽成共用件,
 * 与那边同一条理由:这三十行没有任何分支,复制的是**机械动作**不是决策,而真正
 * 会漂的那部分(墙钟数字)在产品层只有一份。
 *
 * `timeout` 的两种成因都是真的、都要如实报:引擎压根没起流(命令被丢掉),或者
 * 这一轮跑得太久 / 停在了一张没人答的审批卡上。
 */
function waitForTaskTerminalEvent(sessionId: string): Promise<TaskOutcome> {
  return new Promise<TaskOutcome>(resolve => {
    let sawStart = false
    let settled = false
    const finish = (outcome: TaskOutcome): void => {
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
      'task-dispatch-wait',
    )
    const startTimer = setTimeout(() => {
      if (!sawStart) finish('timeout')
    }, TASK_START_TIMEOUT_MS)
    const totalTimer = setTimeout(() => finish('timeout'), TASK_WALL_CLOCK_MS)
  })
}

/** 工作会话留下的最后一条助手正文 —— **整条**。 */
function lastAssistantText(sessionId: string): string | undefined {
  const message = sessionReads.findMessage(
    sessionId,
    candidate => candidate?.role === 'assistant'
      && typeof candidate.content === 'string'
      && candidate.content.trim() !== '',
    { from: 'end' },
  )
  return message ? (message.content as string).trim() : undefined
}

/* ── 回投 ─────────────────────────────────────────────────────────────────── */

function taskOrigin(taskSessionId: string, hop: number, now: number): MessageOrigin {
  return {
    transport: 'api',
    source: taskMessageSource(taskSessionId),
    receivedAt: now,
    task: { sessionId: taskSessionId, hop },
  }
}

/**
 * 把结果投回调用方。`triggerTurn: true` = 三态矩阵的「空闲起一轮 / 在忙降级 steer」,
 * 结果里 `delivered` 如实说走了哪一格 —— 这就是「被唤醒」的兑现。
 */
async function reportBack(
  taskSessionId: string,
  task: ActiveTask,
  outcome: TaskOutcome,
): Promise<void> {
  const engine = getStreamEngineSafe()
  if (!engine) return
  const body = lastAssistantText(taskSessionId)
  const content = renderTaskReport({
    taskSessionId,
    ...(task.description ? { description: task.description } : {}),
    outcome,
    ...(body ? { body } : {}),
  })
  const result = await deliverInternalMessage(
    { eventBus: getEventBus(), streamEngine: engine },
    {
      actorKey: taskMessageSource(taskSessionId),
      sessionId: task.callerSessionId,
      content,
      options: { triggerTurn: true },
      origin: (hop, now) => taskOrigin(taskSessionId, hop, now),
    },
  )
  if (!result.ok) {
    log.warn(
      'task report not delivered',
      { taskSessionId, reason: result.reason, detail: result.detail },
    )
  }
}

/* ── 派工 ─────────────────────────────────────────────────────────────────── */

export interface DispatchTaskOptions {
  /** 测试注入确定性种子。 */
  newTaskSessionId?: () => string
  now?: () => number
}

export async function dispatchTask(
  request: TaskDispatchRequest,
  options: DispatchTaskOptions = {},
): Promise<TaskDispatchOutcome> {
  const now = options.now?.() ?? Date.now()
  const caller = store.getSession(request.callerSessionId)
  if (!caller) {
    return { ok: false, reason: 'unsupported', detail: 'the calling session no longer exists' }
  }

  // 闸一:禁止套娃。工具面上工作会话本来就看不见 `task`(产品层
  // `sessionHiddenToolIds`),这一条是**不能被绕过的那一层** —— 工具面是给模型看的。
  if (isTaskSession(caller)) {
    return { ok: false, reason: 'nested' }
  }

  // 闸二:并发。超限**不排队**,当场拒绝 —— 悄悄排队会让模型以为活已经派出去了。
  const running = runningTaskCount(request.callerSessionId)
  if (running >= TASK_MAX_CONCURRENT_PER_SESSION) {
    return {
      ok: false,
      reason: 'concurrency',
      detail: `${running} running: ${[...activeTasks]
        .filter(([, task]) => task.callerSessionId === request.callerSessionId)
        .map(([id]) => id)
        .join(', ')}`,
    }
  }

  const taskSessionId = (options.newTaskSessionId ?? randomUUID)()
  const description = request.description?.trim()

  try {
    // 幕后建的会话不该抢走用户正在看的东西。
    store.createSessionWithoutFocus(taskSessionId, taskSessionName(description, request.prompt))
    const mark: TaskSessionRef = {
      parentSessionId: request.callerSessionId,
      createdAt: now,
      ...(description ? { description } : {}),
    }
    store.updateSessionTask(taskSessionId, mark)

    /**
     * cwd:**参数优先,否则继承调用方**。绝不是 collab 那个群目录 ——
     * 审计 P0-4 的教训是「一张『去仓库里改这个 bug』的卡,worker 一开工就被切进
     * 一间空屋子」。派工的默认工作面就是派它的人正在看的那一面。
     */
    const workingDirectory = request.workingDirectory?.trim() || caller.workingDirectory?.trim()
    if (workingDirectory) {
      store.updateSessionWorkingDirectory(taskSessionId, workingDirectory)
      if (caller.workingDirectoryRoots?.length) {
        store.updateSessionWorkingDirectoryRoots(taskSessionId, [...caller.workingDirectoryRoots])
      }
    }

    // 权限模式继承调用方(v1 口径:worker 里的审批卡照常出现在**那条**会话上)。
    if (caller.permissionMode) {
      store.updateSessionPermissionMode(taskSessionId, caller.permissionMode)
    }

    /**
     * 模型:缺省与调用方同款。`model` 参数只换 modelId,**provider 仍是调用方的** ——
     * 一个裸模型 id 反查 provider 在这个仓库里没有单一答案(provider 解析链的旧账),
     * 猜错的后果是任务在一个不存在的模型上失败。工具描述里如实写了这一条。
     */
    const providerId = caller.lastProvider
    const modelId = request.model || caller.lastModel
    if (providerId && modelId) {
      store.updateSessionModel(taskSessionId, providerId, modelId, { pinned: Boolean(request.model) })
    }

    const task: ActiveTask = {
      callerSessionId: request.callerSessionId,
      ...(description ? { description } : {}),
      startedAt: now,
    }
    activeTasks.set(taskSessionId, task)

    // **先订阅后驱动**:总线是同步投递的,一个在 `emit` 里就起完又结束的流会在
    // 等待者存在之前 settle(collab v2 P2-7 踩过的那一脚)。
    const terminal = waitForTaskTerminalEvent(taskSessionId)

    await getEventBus().emit(taskSessionId, {
      type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
      content: request.prompt,
      source: taskMessageSource(taskSessionId),
      origin: taskOrigin(taskSessionId, 0, now),
    } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])

    // 不 await:工具当场返回,调用方这一回合继续往下走(fire-and-report)。
    void terminal
      .then(outcome => reportBack(taskSessionId, task, outcome))
      .catch(error => log.error('task report failed', { taskSessionId }, error))
      .finally(() => activeTasks.delete(taskSessionId))

    return {
      ok: true,
      taskSessionId,
      ...(workingDirectory ? { workingDirectory } : {}),
      running: runningTaskCount(request.callerSessionId),
    }
  } catch (error) {
    activeTasks.delete(taskSessionId)
    return {
      ok: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
