import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  InteractionAnswer,
  InteractionQuestionAnswer,
  InteractionRequest,
} from '@shared/ipc.js'
import { platformApi } from '@/platform'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'

/**
 * agent 提问的 renderer 账本(claude-code-integration-v2 §4,E2)。
 *
 * ## 为什么是独立的一个 store,而不是塞进 collabBoard
 *
 * collabBoard 里已经有一本**审批**的 pending 账,形状几乎一样,顺手挂过去最省事 ——
 * 但那正是 E1 反复论证过不该做的合并:提问与审批是两条并列的等待链,生命周期
 * (提问没有「以后都这样」的授权留存)、应答形状(结构化答案 vs 四选一档位)、
 * 呈现(卡片 vs 账页栏位)三样都不一样。更实际的一条:提问**不是协作专属**的 ——
 * `origin: 'host-tool'` 是协议里写明的一等分支,直聊里的本地工具将来也会问,而把
 * 它记在一本叫 collabBoard 的账上,就是给下一个人「提问 = 协作功能」的错觉。
 *
 * 拆开不等于多一条订阅链:会话事件的水龙头仍然只有 ipc-hub 一个(与审批事件同一
 * 处分发),这里不自己 `onSessionEvent`。C4 那条纪律说的是「一个事实一本账」,
 * 不是「所有账挤进一个 store」。
 *
 * ## 账本内容永远来自反查
 *
 * `pending` 只由 `getPendingInteractions` 的**全量**答案写入,事件只是「这个会话的
 * 欠账动了,去重新问一次」的触发器。理由与审批那本逐字相同(collabBoard 里那段
 * 「±事件记账 cannot be right even in principle」):事件会丢、会乱序、窗口重载后
 * 一条都不会补发,而「屏幕上有没有这张卡」不允许有第二个答案。
 *
 * ## 结算事件只做一件事:提前摘牌
 *
 * 提问收场之后栏位整块撤走、会话里不留痕,所以这里**没有**第二本记「上一次怎么
 * 收的场」的账 —— 没有人画它。曾经有过一本(`settled`),它存在的唯一理由是流内
 * 提问卡的历史态;卡改成 composer 上方的栏位之后,那本账连同它的 request 快照
 * 缓存一起撤掉,免得留一堆只增不减、又没人读的内存。
 *
 * `interaction:settled` 到达时仍然当场把这条从 pending 里摘掉,而不是干等那次
 * 反查:留着它,栏位会在那 200ms 里继续要你回答一条已经结了的提问。
 *
 * 「用户刚才答了什么」仍然对得了账 —— 那次 `ask_user` 工具调用的结果里就写着,
 * 那是内核持久化的真值,不需要渲染层再存一份。
 */

/** 事件到达与反查之间的合并窗口。与审批那条链同一个数,理由也同一条。 */
const RECONCILE_DEBOUNCE_MS = 200

/** ipc-hub 转过来的两条事件的最小形状(整份 request / answer 透传)。 */
export interface InteractionBusEventLike {
  type: string
  request?: InteractionRequest
  answer?: InteractionAnswer
  toolCallId?: string
}

export const useInteractionsStore = defineStore('interactions', () => {
  /** sessionId → `getPendingInteractions` 反查回来的那一份**全量**。 */
  const pending = ref<Record<string, InteractionRequest[]>>({})
  const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 每问一次 +1;迟到的答案按号丢弃(与审批账本同一条去序纪律)。 */
  const reconcileGenerations = new Map<string, number>()

  function nextGeneration(sessionId: string): number {
    const next = (reconcileGenerations.get(sessionId) ?? 0) + 1
    reconcileGenerations.set(sessionId, next)
    return next
  }

  /** 问一次主进程:这个会话此刻还欠哪些回答。 */
  async function reconcile(sessionId: string): Promise<void> {
    if (!sessionId) return
    const generation = nextGeneration(sessionId)
    try {
      const response = await platformApi.getPendingInteractions?.(sessionId)
      // 更新的一问已经在路上(或已经答完),这份答案不再是真相。
      if (reconcileGenerations.get(sessionId) !== generation) return
      const requests = response?.success && response.pending ? response.pending : []
      pending.value = { ...pending.value, [sessionId]: requests }
    } catch (error) {
      // 读失败不是「没有欠账」的证据 —— 保留上一份,否则等于告诉用户相反的话。
      // web 宿主上这两条是桩(返回 success:false),走的也是这一支:卡片不出现,
      // 提问照旧由内核到点自结算,不会挂住。
      console.error('[interactions] pending reconcile failed:', error)
    }
  }

  function scheduleReconcile(sessionId: string): void {
    const existing = reconcileTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    // 事件一到就把号往前推:在飞的那次反查是这条事件之前发出的,它的答案已经过期。
    nextGeneration(sessionId)
    reconcileTimers.set(sessionId, setTimeout(() => {
      reconcileTimers.delete(sessionId)
      void reconcile(sessionId)
    }, RECONCILE_DEBOUNCE_MS))
  }

  /**
   * 提问事件的**唯一**落点(ipc-hub 转发过来)。
   *
   * 两条事件在这里只有两个身份:
   *  1. 「这个会话的欠账动了」—— 一律合并成一次反查;
   *  2. settled 额外确定一件反查还要 200ms 才追上的事:这条已经不欠了。
   */
  function noteInteractionEvent(sessionId: string, event: InteractionBusEventLike): void {
    if (event.type === SESSION_EVENT_TYPES.INTERACTION_SETTLED && event.answer) {
      dropPending(sessionId, event.answer.id)
    }
    scheduleReconcile(sessionId)
  }

  /**
   * 结了的那条当场摘牌。
   *
   * pending 的真值仍然等反查,但摘牌是确定的(core 是先 `pending.delete` 再
   * `emitSettled`):留着它,栏位会在那 200ms 里继续要你回答一条已经结了的提问 ——
   * 到点自结算与别处代答走的都是这一支。
   */
  function dropPending(sessionId: string, interactionId: string): void {
    const previous = pending.value[sessionId]
    if (!previous?.some(item => item.id === interactionId)) return
    pending.value = {
      ...pending.value,
      [sessionId]: previous.filter(item => item.id !== interactionId),
    }
  }

  /** 一个会话上屏时的补水(冷启动、切会话都走它)。 */
  async function ensureForSession(sessionId: string | undefined | null): Promise<void> {
    if (!sessionId) return
    await reconcile(sessionId)
  }

  function pendingFor(sessionId: string | undefined | null): InteractionRequest[] {
    return (sessionId && pending.value[sessionId]) || []
  }

  /**
   * 交卷。
   *
   * 走 `respondInteraction` 这条专用 IPC 面而不是统一命令通道:E1 就是为这一刻
   * 建的它,而且它**答得回来成不成**(命令通道是单向的)。跨传输面的应答仍然可以
   * 走 `command:interaction-respond`,两条路进的是同一个内核。
   *
   * 应答之后不本地伪造收场:`interaction:settled` 会带着真正的 outcome 回来,
   * 摘牌由它做。这里只把反查往前推一格,让栏位尽快离开「待答」。
   */
  async function respond(
    sessionId: string,
    request: InteractionRequest,
    answers: Record<string, InteractionQuestionAnswer>,
  ): Promise<boolean> {
    return submit({
      sessionId,
      interactionId: request.id,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      answers,
    })
  }

  /** 「不回答」——落成 declined 而不是一份空答案的 answered(两者对模型的意思不同)。 */
  async function decline(
    sessionId: string,
    request: InteractionRequest,
    reason?: string,
  ): Promise<boolean> {
    return submit({
      sessionId,
      interactionId: request.id,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      decline: true,
      ...(reason ? { reason } : {}),
    })
  }

  async function submit(request: {
    sessionId: string
    interactionId?: string
    toolCallId?: string
    answers?: Record<string, InteractionQuestionAnswer>
    decline?: boolean
    reason?: string
  }): Promise<boolean> {
    try {
      const response = await platformApi.respondInteraction?.(request)
      scheduleReconcile(request.sessionId)
      return Boolean(response?.success)
    } catch (error) {
      console.error('[interactions] respond failed:', error)
      return false
    }
  }

  return {
    pending,
    pendingFor,
    ensureForSession,
    reconcile,
    noteInteractionEvent,
    respond,
    decline,
  }
})
