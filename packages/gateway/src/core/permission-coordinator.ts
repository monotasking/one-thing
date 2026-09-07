import type {
  CorePermissionDecision,
  CorePermissionRequestEvent,
  CorePermissionSurface,
} from '@onething/core/gateway-runtime'
import type { Unsubscribe } from '@onething/core/gateway-runtime'
import { gatewayLogger, resolveGatewayLogger, type Logger } from './logging.js'

export interface GatewayPermissionCoordinatorOptions {
  permissions: CorePermissionSurface
  timeoutMs: number
  /** 构造时注入(L2)。 */
  logger?: Logger
}

const STALE_PERMISSION_REPLY_TTL_MS = 60_000

export interface GatewayPermissionWatchInput {
  sessionId: string
  channelId: string
  userId: string
  conversationId: string
  sendText: (text: string) => Promise<void>
}

interface PendingGatewayPermission {
  sessionId: string
  channelId: string
  userId: string
  conversationId: string
  request: CorePermissionRequestEvent
  sendText: (text: string) => Promise<void>
  owner: Set<PendingGatewayPermission>
  timer?: ReturnType<typeof setTimeout>
}

interface StaleGatewayPermissionReply {
  channelId: string
  userId: string
  conversationId: string
  sendText: (text: string) => Promise<void>
  replyText: string
  expiresAt: number
}

export class GatewayPermissionCoordinator {
  private readonly queues = new Map<string, PendingGatewayPermission[]>()
  private readonly staleReplies = new Map<string, StaleGatewayPermissionReply[]>()

  private readonly log: Logger

  constructor(private readonly options: GatewayPermissionCoordinatorOptions) {
    this.log = resolveGatewayLogger(options.logger, 'permission')
  }

  watch(input: GatewayPermissionWatchInput): Unsubscribe {
    const ownedPending = new Set<PendingGatewayPermission>()
    const unsubscribe = this.options.permissions.onPermissionRequest(input.sessionId, (request) => {
      if (request.targetChannel !== input.channelId || request.sessionId !== input.sessionId) return
      const pending: PendingGatewayPermission = {
        sessionId: input.sessionId,
        channelId: input.channelId,
        userId: input.userId,
        conversationId: input.conversationId,
        request,
        sendText: input.sendText,
        owner: ownedPending,
      }
      ownedPending.add(pending)
      this.enqueue(pending)
    })

    return () => {
      unsubscribe()
      for (const pending of Array.from(ownedPending)) {
        this.cancelPending(pending, '审批已失效，请重新发送请求。')
      }
    }
  }

  async tryHandleReply(channelId: string, userId: string, conversationId: string, text: string): Promise<boolean> {
    this.pruneStaleReplies()
    const key = permissionQueueKey(channelId, userId, conversationId)
    const pending = this.queues.get(key)?.[0]

    const decision = parsePermissionReply(text)
    if (pending && !decision) {
      await pending.sendText('未能识别，请回复 1 / 2 / 3。')
      return true
    }

    if (pending && decision) {
      await this.resolvePending(key, pending, decision)
      return true
    }

    if (!decision) return false

    const stale = this.takeFirstStaleReply(key)
    if (!stale) {
      // A reply from another identity must neither settle an approval nor become
      // a new model request while this channel is exchanging approval decisions.
      return this.hasApprovalExchange(channelId)
    }

    await sendTextSafely(stale, stale.replyText)
    return true
  }

  private hasApprovalExchange(channelId: string): boolean {
    return Array.from(this.queues.values()).some(queue => queue[0]?.channelId === channelId)
      || Array.from(this.staleReplies.values()).some(replies => replies[0]?.channelId === channelId)
  }

  private enqueue(pending: PendingGatewayPermission): void {
    const key = permissionQueueKey(pending.channelId, pending.userId, pending.conversationId)
    const queue = this.queues.get(key) ?? []
    queue.push(pending)
    this.queues.set(key, queue)

    if (queue.length === 1) {
      void this.activateHead(key)
    }
  }

  private async activateHead(key: string): Promise<void> {
    const pending = this.queues.get(key)?.[0]
    if (!pending) return

    const timeoutMs = pending.request.timeoutMs ?? this.options.timeoutMs
    pending.timer = setTimeout(() => {
      void this.rejectTimedOut(key, pending)
    }, timeoutMs)
    pending.timer.unref?.()

    await sendTextSafely(pending, formatPermissionPrompt(pending.request, timeoutMs))
  }

  private async resolvePending(
    key: string,
    pending: PendingGatewayPermission,
    decision: CorePermissionDecision,
  ): Promise<void> {
    const rejectReason = decision === 'reject' ? '用户远程拒绝权限请求' : undefined
    await this.settlePending(key, pending, decision, confirmationText(decision), rejectReason)
  }

  private async rejectTimedOut(key: string, pending: PendingGatewayPermission): Promise<void> {
    await this.settlePending(
      key,
      pending,
      'reject',
      '审批超时，已自动拒绝。',
      '审批超时自动拒绝',
      '审批已过期，请重新发送请求。',
    )
  }

  private async settlePending(
    key: string,
    pending: PendingGatewayPermission,
    decision: CorePermissionDecision,
    confirmation: string,
    rejectReason?: string,
    staleReplyText?: string,
  ): Promise<void> {
    const queue = this.queues.get(key)
    if (!queue || queue[0] !== pending) return

    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }

    queue.shift()
    pending.owner.delete(pending)
    if (!queue.length) {
      this.queues.delete(key)
    }
    if (staleReplyText) {
      this.recordStaleReply(pending, staleReplyText)
    }

    try {
      await this.options.permissions.respondPermission({
        sessionId: pending.sessionId,
        requestId: pending.request.requestId,
        channel: pending.request.targetChannel,
        decision,
        rejectReason,
      })
    } catch (error) {
      this.log.error('permission respond failed', {
        sessionId: pending.sessionId,
        requestId: pending.request.requestId,
        decision,
      }, error)
    }
    await sendTextSafely(pending, confirmation)

    if (queue.length) {
      void this.activateHead(key)
    }
  }

  private cancelPending(pending: PendingGatewayPermission, replyText: string): void {
    const key = permissionQueueKey(pending.channelId, pending.userId, pending.conversationId)
    const queue = this.queues.get(key)
    if (!queue) {
      pending.owner.delete(pending)
      return
    }

    const index = queue.indexOf(pending)
    if (index === -1) {
      pending.owner.delete(pending)
      return
    }

    const wasHead = index === 0
    queue.splice(index, 1)
    pending.owner.delete(pending)

    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }

    this.recordStaleReply(pending, replyText)
    void sendTextSafely(pending, replyText)

    if (!queue.length) {
      this.queues.delete(key)
      return
    }
    if (wasHead) {
      void this.activateHead(key)
    }
  }

  private recordStaleReply(pending: PendingGatewayPermission, replyText: string): void {
    this.pruneStaleReplies()
    const key = permissionQueueKey(pending.channelId, pending.userId, pending.conversationId)
    const replies = this.staleReplies.get(key) ?? []
    replies.push({
      channelId: pending.channelId,
      userId: pending.userId,
      conversationId: pending.conversationId,
      sendText: pending.sendText,
      replyText,
      expiresAt: Date.now() + STALE_PERMISSION_REPLY_TTL_MS,
    })
    this.staleReplies.set(key, replies)
  }

  private takeFirstStaleReply(key: string): StaleGatewayPermissionReply | null {
    const replies = this.staleReplies.get(key)
    const reply = replies?.shift() ?? null
    if (replies && !replies.length) {
      this.staleReplies.delete(key)
    }
    return reply
  }

  private pruneStaleReplies(now = Date.now()): void {
    for (const [key, replies] of this.staleReplies) {
      const fresh = replies.filter(reply => reply.expiresAt > now)
      if (fresh.length) {
        this.staleReplies.set(key, fresh)
      } else {
        this.staleReplies.delete(key)
      }
    }
  }
}

function permissionQueueKey(channelId: string, userId: string, conversationId: string): string {
  return JSON.stringify([channelId, userId, conversationId])
}

async function sendTextSafely(
  pending: Pick<PendingGatewayPermission, 'sendText'>,
  text: string,
): Promise<void> {
  try {
    await pending.sendText(text)
  } catch (error) {
    // 自由函数,没有构造注入口 —— 读进程级工厂(见 logging.ts 头注)。
    gatewayLogger('permission').error('permission message send failed', {}, error)
  }
}

function parsePermissionReply(text: string): CorePermissionDecision | null {
  const normalized = text.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]/g, '')
  if (!normalized) return null

  if (/^1(?:\s|$)/.test(normalized)
    || normalized === '允许'
    || normalized === '允许一次'
    || normalized === '同意'
    || normalized === 'y'
    || normalized === 'yes'
    || normalized === 'ok'
    || normalized === 'okay') {
    return 'once'
  }

  if (/^2(?:\s|$)/.test(normalized)
    || normalized === '本次会话'
    || normalized === '会话'
    || normalized === 'session'
    || normalized.includes('本次会话')) {
    return 'session'
  }

  if (/^3(?:\s|$)/.test(normalized)
    || normalized === '拒绝'
    || normalized === '不同意'
    || normalized === '不允许'
    || normalized === 'n'
    || normalized === 'no'
    || normalized === 'reject') {
    return 'reject'
  }

  return null
}

function formatPermissionPrompt(request: CorePermissionRequestEvent, timeoutMs: number): string {
  return [
    `AI 想执行：${request.title}`,
    `回复 1 允许一次 / 2 本次会话允许 / 3 拒绝（${formatTimeout(timeoutMs)}内未回复将自动拒绝）`,
  ].join('\n')
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 60_000) {
    const minutes = timeoutMs / 60_000
    return Number.isInteger(minutes) ? `${minutes} 分钟` : `${Math.round(minutes)} 分钟`
  }
  return `${Math.ceil(timeoutMs / 1000)} 秒`
}

function confirmationText(decision: CorePermissionDecision): string {
  switch (decision) {
    case 'once':
      return '已允许一次。'
    case 'session':
      return '已允许本次会话。'
    case 'workdir':
      return '已允许当前工作目录。'
    case 'reject':
      return '已拒绝。'
  }
}
