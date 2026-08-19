import { randomUUID } from 'node:crypto'
import type {
  InteractionAnswer,
  InteractionAskInput,
  InteractionOutcome,
  InteractionQuestionAnswer,
  InteractionRequest,
} from './types.js'

/**
 * 交互协议内核(docs/design/claude-code-integration-v2.md §4,E1 期)。
 *
 * 与 `packages/core/permission/index.ts` **并列的一等概念**,不是它的一个 case。
 * 结构上刻意与 Permission 同构(ask / respond / clearSession / getPending / 通道亲和
 * / 会话清理逐条 settle),这样两条等待链在观测面、停止链、宿主接线上是同一套心智;
 * 语义上刻意不同(见下「与 Permission 的差异」),这样两个概念不会被合并回去。
 *
 * ## 与 Permission 的同构点
 *
 * - `initialize(bus, channelResolver)` 订阅一条 EventBus 命令,重复 initialize 先退订
 *   旧订阅(不泄漏)。
 * - ask 时记下 `targetChannel = channelResolver(sessionId)`;respond 的 channel 必须
 *   与之相等,否则拒收。跨通道冒批在这里同样被挡住。
 * - `clearSession(sessionId)` 把该会话所有 pending **逐条 settle** 再删表 ——
 *   与 `settlePendingReject` 同款纪律:留一条不结算的 pending,等它的那个回合就永远
 *   醒不过来。
 * - respond 支持按 `toolCallId` 定位(持久相关键),不强迫应答方记住只活在内存里的
 *   `interactionId`。
 *
 * ## 与 Permission 的差异(都是刻意的)
 *
 * 1. **ask 只 resolve,永不 reject。** Permission 的拒绝是一个 `RejectedError`,靠异常
 *    中断工具执行;提问的四种收场(answered/declined/timeout/aborted)全是**正常返回**。
 *    理由是原则 3:调用方必须把每一种收场翻译成模型看得懂的工具结果,异常路径会诱使
 *    调用方让它冒泡成一次挂起或红错 —— 那正是 F3 那 2 分 11 秒的成因。
 * 2. **registry 自己挂表结算 deadline。** Permission 没有定时器(超时兜底长在外面的
 *    `permission-policy.ts` 桥上,而那座桥恰恰是外部通路绕开的那一座)。这里把 deadline
 *    收进内核:**不依赖 UI 在场,也不依赖调用方记得包一层超时**(原则 4)。
 * 3. **不排队、不合并。** Permission 把同会话的审批串成一条队列(并发工具不叠卡),
 *    并把等价的 ask 合并成 followers。提问不合并 —— 两次提问即便字面相同也是两件事
 *    (答案要分别回给各自的工具调用);也不排队 —— 卡片的呈现节奏是 UI 的事(E2),
 *    内核压着不发只会让 deadline 空转。
 * 4. **没有授权留存。** 提问没有 `session`/`workdir` 这种「以后都这样」的档位,
 *    所以这里没有 grants 那一层。
 */

/** 没给 deadline 时的兜底超时。与无人值守审批的 120s 同一档,便于两条等待链一起讲。 */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 120_000

export const DEFAULT_INTERACTION_TIMEOUT_REASON =
  '无人应答,提问已超时结算。请按你自己的判断选一条最稳妥的路继续,并在回答里说明你替用户做了哪个假设。'

export const DEFAULT_INTERACTION_DECLINED_REASON =
  '用户选择不回答这个问题。请不要重复提问,按你自己的判断继续。'

export const DEFAULT_INTERACTION_ABORTED_REASON = 'Session cleared'

export type InteractionBusEvent =
  | {
      type: 'interaction:requested'
      request: InteractionRequest
    }
  | {
      type: 'interaction:settled'
      toolCallId?: string
      answer: InteractionAnswer
    }

export interface InteractionCommandEnvelope<TCommand = unknown> {
  sessionId: string
  event: TCommand
}

export interface InteractionEventBusLike {
  onAnySession(
    eventType: string,
    handler: (envelope: InteractionCommandEnvelope) => void,
    label?: string
  ): () => void
  emit(sessionId: string, event: InteractionBusEvent): Promise<unknown>
}

/** `command:interaction-respond` 的结构镜像(shared 侧的 typed 版本在 session-commands.ts)。 */
export interface InteractionRespondCommandLike {
  /** 活的请求 id(应答方接到了 interaction:requested 事件时用它)。 */
  interactionId?: string
  /** 持久相关键:这次提问挂在哪个工具调用上。 */
  toolCallId?: string
  answers?: Record<string, InteractionQuestionAnswer>
  /** 用户主动放弃回答 → declined,而不是空答案的 answered。 */
  decline?: boolean
  reason?: string
  channel?: string
}

export namespace Interaction {
  interface PendingEntry {
    request: InteractionRequest
    settle: (answer: InteractionAnswer) => void
    /** deadline 自结算的表。settle 时必须清掉,否则留一只孤儿定时器。 */
    timer: ReturnType<typeof setTimeout> | null
  }

  interface SessionState {
    pending: Map<string, PendingEntry>
  }

  /**
   * 提问链的**账本旁听席** —— 与 `Permission.Recorder` 同一条纪律
   * (session-event-sourcing §10.2)。core 仍零依赖:这只是一个回调。
   */
  export interface Recorder {
    onAsked?(request: InteractionRequest): void
    onAnswered?(request: InteractionRequest, answer: InteractionAnswer): void
  }

  const sessions = new Map<string, SessionState>()
  let recorder: Recorder | null = null
  let eventBus: InteractionEventBusLike | null = null
  let channelResolver: ((sessionId: string) => string) | null = null
  let unsubInteractionRespond: (() => void) | null = null

  function getSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId)
    if (!session) {
      session = { pending: new Map() }
      sessions.set(sessionId, session)
    }
    return session
  }

  function emitInteractionEvent(sessionId: string, event: InteractionBusEvent): void {
    eventBus?.emit(sessionId, event)
      .catch(err => console.error('[Interaction] EventBus emit error:', err))
  }

  function findPendingByToolCallId(session: SessionState, toolCallId: string): PendingEntry | undefined {
    for (const entry of session.pending.values()) {
      if (entry.request.toolCallId === toolCallId) return entry
    }
    return undefined
  }

  function resolvePending(
    session: SessionState,
    input: { interactionId?: string; toolCallId?: string },
  ): PendingEntry | undefined {
    if (input.interactionId) {
      const byId = session.pending.get(input.interactionId)
      if (byId) return byId
    }
    if (input.toolCallId) return findPendingByToolCallId(session, input.toolCallId)
    return undefined
  }

  /**
   * 唯一的结算出口。所有收场(答复 / 放弃 / 超时 / 会话清理)都从这里走,
   * 于是「摘表 → 停表 → resolve → 广播 settled」四件事不可能只做一半。
   */
  function settle(
    session: SessionState,
    entry: PendingEntry,
    outcome: InteractionOutcome,
    answers: Record<string, InteractionQuestionAnswer>,
    reason?: string,
  ): void {
    session.pending.delete(entry.request.id)
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    const answer: InteractionAnswer = {
      id: entry.request.id,
      answers,
      outcome,
      ...(reason ? { reason } : {}),
    }
    entry.settle(answer)
    emitInteractionEvent(entry.request.sessionId, {
      type: 'interaction:settled',
      toolCallId: entry.request.toolCallId,
      answer,
    })
    try {
      recorder?.onAnswered?.(entry.request, answer)
    } catch (error) {
      console.warn('[Interaction] recorder onAnswered failed:', error)
    }
  }

  /** 账本旁听席的接线口。传 null 摘下。 */
  export function setRecorder(next: Recorder | null): void {
    recorder = next
  }

  /**
   * deadline 自结算:到点把这条 pending 结成 timeout。
   *
   * `unref` 是有意的 —— 一条挂着的提问不该把进程摁住不让退出(而且进程真要退出时,
   * 会话清理那条路会把它结成 aborted)。测试里的假表没有 unref,所以要探一下再调。
   */
  function armDeadline(session: SessionState, entry: PendingEntry): void {
    const delay = Math.max(0, entry.request.deadlineAt - Date.now())
    const timer = setTimeout(() => {
      entry.timer = null
      if (!session.pending.has(entry.request.id)) return
      console.warn('[Interaction] Deadline reached, settling as timeout:', entry.request.id)
      settle(session, entry, 'timeout', {}, DEFAULT_INTERACTION_TIMEOUT_REASON)
    }, delay)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
    entry.timer = timer
  }

  export function initialize(
    bus: InteractionEventBusLike,
    resolver: (sessionId: string) => string,
  ): void {
    // Re-initialization must not leak the previous respond subscription.
    unsubInteractionRespond?.()
    eventBus = bus
    channelResolver = resolver

    unsubInteractionRespond = bus.onAnySession(
      'command:interaction-respond',
      (envelope) => {
        const cmd = envelope.event as InteractionRespondCommandLike
        if (cmd.decline) {
          decline({
            sessionId: envelope.sessionId,
            interactionId: cmd.interactionId,
            toolCallId: cmd.toolCallId,
            reason: cmd.reason,
            channel: cmd.channel,
          })
          return
        }
        respond({
          sessionId: envelope.sessionId,
          interactionId: cmd.interactionId,
          toolCallId: cmd.toolCallId,
          answers: cmd.answers ?? {},
          channel: cmd.channel,
        })
      },
      'Interaction',
    )

    console.log('[Interaction] Initialized with EventBus')
  }

  export function shutdown(): void {
    if (unsubInteractionRespond) {
      unsubInteractionRespond()
      unsubInteractionRespond = null
    }
    eventBus = null
    channelResolver = null
    console.log('[Interaction] Shut down')
  }

  /**
   * 提一个问题,等一个结构化答案。
   *
   * 返回的 Promise **只会 resolve**,四种 outcome 都是正常返回值 —— 调用方必须逐种
   * 翻译成工具结果,不能靠 try/catch 把它当异常放过去。
   */
  export function ask(input: InteractionAskInput): Promise<InteractionAnswer> {
    const session = getSession(input.sessionId)
    const targetChannel = channelResolver ? channelResolver(input.sessionId) : 'ipc'
    const createdAt = Date.now()
    const deadlineAt = input.deadlineAt
      ?? createdAt + (input.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS)

    const request: InteractionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      origin: input.origin,
      questions: input.questions,
      deadlineAt,
      createdAt,
      targetChannel,
    }

    console.log(
      '[Interaction] Asking:', request.id, request.origin,
      `${request.questions.length} question(s)`,
      'targetChannel:', targetChannel,
      'deadlineIn:', `${Math.max(0, deadlineAt - createdAt)}ms`,
    )

    try {
      recorder?.onAsked?.(request)
    } catch (error) {
      console.warn('[Interaction] recorder onAsked failed:', error)
    }

    return new Promise<InteractionAnswer>(resolve => {
      const entry: PendingEntry = { request, settle: resolve, timer: null }
      session.pending.set(request.id, entry)
      // 表先挂:没有 EventBus(或者没人在听)不该变成一次无限等待 —— 这正是内核自结算
      // 相对于「UI 侧倒计时」的全部意义。
      armDeadline(session, entry)
      if (!eventBus) {
        console.warn('[Interaction] EventBus not initialized; the ask will settle by deadline only')
        return
      }
      emitInteractionEvent(input.sessionId, { type: 'interaction:requested', request })
    })
  }

  /**
   * 回答一次提问。答案表**整体透传**,不在这里按题过滤 —— 键名写错要在上层被看见,
   * 而不是在这里被悄悄 strip 成空答案。
   */
  export function respond(input: {
    sessionId: string
    interactionId?: string
    toolCallId?: string
    answers: Record<string, InteractionQuestionAnswer>
    channel?: string
  }): boolean {
    const session = getSession(input.sessionId)
    const pending = resolvePending(session, input)
    if (!pending) {
      // 重复应答走到这里:第一次已经把它摘表了,第二次是无害的 no-op(幂等)。
      console.warn('[Interaction] No pending interaction for respond:', input.interactionId ?? input.toolCallId)
      return false
    }
    if (!checkChannelAffinity(pending, input.channel)) return false

    settle(session, pending, 'answered', input.answers)
    return true
  }

  /** 用户主动放弃回答(或 pair 房这类根本没有人类的场合当场拒绝)。 */
  export function decline(input: {
    sessionId: string
    interactionId?: string
    toolCallId?: string
    reason?: string
    channel?: string
  }): boolean {
    const session = getSession(input.sessionId)
    const pending = resolvePending(session, input)
    if (!pending) {
      console.warn('[Interaction] No pending interaction for decline:', input.interactionId ?? input.toolCallId)
      return false
    }
    if (!checkChannelAffinity(pending, input.channel)) return false

    settle(session, pending, 'declined', {}, input.reason || DEFAULT_INTERACTION_DECLINED_REASON)
    return true
  }

  /**
   * **发起方**自己收回一次提问(回合被 abort、工具被取消)。
   *
   * 与 respond / decline 的区别是「谁在说话」:那两条是应答方从某条传输面回来的,
   * 所以必须过通道亲和;这一条是当初调 `ask` 的那段代码自己撤回它,没有第二方
   * 可冒充 —— 照搬通道亲和只会让「回合已经停了」这件事被自己的通道挡在门外,
   * 于是工具永远等不到收场。
   *
   * 收场是 `aborted`,与会话清理同一种 —— 因为它就是同一件事的更小粒度版本:
   * 那条回合不在了,等它的这次提问也就没有人会答了。
   */
  export function abort(input: {
    sessionId: string
    interactionId?: string
    toolCallId?: string
    reason?: string
  }): boolean {
    const session = getSession(input.sessionId)
    const pending = resolvePending(session, input)
    if (!pending) {
      // 已经收场了(用户抢在 abort 之前答完)—— 幂等的 no-op,不是错误。
      return false
    }
    settle(session, pending, 'aborted', {}, input.reason || DEFAULT_INTERACTION_ABORTED_REASON)
    return true
  }

  function checkChannelAffinity(pending: PendingEntry, channel?: string): boolean {
    const expectedChannel = pending.request.targetChannel || 'ipc'
    const responseChannel = channel || 'ipc'
    if (expectedChannel !== responseChannel) {
      console.warn(
        `[Interaction] Response from wrong channel: expected '${expectedChannel}', got '${responseChannel}'. Ignoring.`,
      )
      return false
    }
    return true
  }

  /** UI 补水读它:重连 / 刷新之后把还没答的提问重新画出来。 */
  export function getPending(sessionId: string): InteractionRequest[] {
    const session = sessions.get(sessionId)
    if (!session) return []
    return Array.from(session.pending.values()).map(entry => entry.request)
  }

  /**
   * 会话清理:全量 settle 成 `aborted`。
   *
   * 与 Permission 的 `clearSession` 同款纪律 —— 逐条结算再删表。少结算一条,
   * 等它的那个回合就再也醒不过来(而且它的定时器会一直挂着)。
   */
  export function clearSession(sessionId: string): void {
    const session = sessions.get(sessionId)
    if (!session) return

    for (const entry of Array.from(session.pending.values())) {
      settle(session, entry, 'aborted', {}, DEFAULT_INTERACTION_ABORTED_REASON)
    }

    sessions.delete(sessionId)
  }
}
