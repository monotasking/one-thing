import type { Unsubscribe } from '../events/types.js'
import { PendingMessageQueue } from './message-queue.js'
import { getCoreLogger } from '../logging/index.js'

const log = getCoreLogger('core.engine')


export interface CoreCommandEnvelope<TCommand = unknown> {
  sessionId: string
  event: TCommand
}

export interface CoreEventBusLike {
  onAnySession(
    eventType: string,
    handler: (envelope: CoreCommandEnvelope) => void,
    label?: string
  ): Unsubscribe
}

export interface AbortLikeCommand {
  type?: string
  reason?: string
}

export interface InjectMessageCommand {
  type?: string
  content: string
  source?: string
  origin?: unknown
}

export interface RetractSteeringLikeCommand {
  type?: string
  messageId: string
}

/**
 * HeadlessStreamEngine owns the Electron-free part of the production stream
 * engine: command subscription, command target binding, active stream
 * lifecycle, and steering/follow-up queues.
 *
 * Platform-specific code supplies the command target and implements the
 * concrete command handlers.
 */
export abstract class HeadlessStreamEngine<
  TEventBus extends CoreEventBusLike = CoreEventBusLike,
  TCommandTarget = unknown,
> {
  protected activeStreams = new Map<string, AbortController>()
  protected sessionChannels = new Map<string, string>()
  protected eventBus: TEventBus | null = null
  protected commandTarget: TCommandTarget | null = null
  protected unsubs: Unsubscribe[] = []

  protected steeringQueues = new Map<string, PendingMessageQueue>()
  protected followUpQueues = new Map<string, PendingMessageQueue>()

  getChannel(sessionId: string): string {
    return this.sessionChannels.get(sessionId) || 'ipc'
  }

  getSteeringQueue(sessionId: string): PendingMessageQueue {
    let queue = this.steeringQueues.get(sessionId)
    if (!queue) {
      queue = new PendingMessageQueue('one-at-a-time')
      this.steeringQueues.set(sessionId, queue)
    }
    return queue
  }

  getFollowUpQueue(sessionId: string): PendingMessageQueue {
    let queue = this.followUpQueues.get(sessionId)
    if (!queue) {
      queue = new PendingMessageQueue('all')
      this.followUpQueues.set(sessionId, queue)
    }
    return queue
  }

  steerMessage(sessionId: string, content: string, source = 'api', origin?: unknown): void {
    const queue = this.getSteeringQueue(sessionId)
    queue.enqueue({
      content,
      source,
      timestamp: Date.now(),
      ...(origin !== undefined ? { origin } : {}),
    })
    this.log(`Steering queued for ${sessionId.slice(0, 8)}: "${content.slice(0, 60)}..."`)
  }

  /**
   * Retract a steering message that is still waiting in the queue. Returns
   * false when the message was already consumed by a turn (or never queued).
   */
  retractSteerMessage(sessionId: string, messageId: string): boolean {
    const removed = this.steeringQueues.get(sessionId)?.removeById(messageId)
    if (removed) {
      this.log(`Steering retracted for ${sessionId.slice(0, 8)}: ${messageId}`)
    }
    return Boolean(removed)
  }

  followUpMessage(sessionId: string, content: string, source = 'api', origin?: unknown): void {
    const queue = this.getFollowUpQueue(sessionId)
    queue.enqueue({
      content,
      source,
      timestamp: Date.now(),
      ...(origin !== undefined ? { origin } : {}),
    })
    this.log(`Follow-up queued for ${sessionId.slice(0, 8)}: "${content.slice(0, 60)}..."`)
  }

  setEventBus(eventBus: TEventBus): void {
    this.unsubscribeCommands()
    this.eventBus = eventBus
    this.subscribeToCommands(eventBus)
  }

  bindCommandTarget(target: TCommandTarget, onDestroyed?: (clear: () => void) => void): void {
    this.commandTarget = target
    onDestroyed?.(() => {
      if (this.commandTarget === target) {
        this.commandTarget = null
      }
    })
  }

  hasCommandTarget(isAlive?: (target: TCommandTarget) => boolean): boolean {
    if (!this.commandTarget) return false
    return isAlive ? isAlive(this.commandTarget) : true
  }

  handleAbort(sessionId: string, command: AbortLikeCommand = { type: 'command:abort' }): boolean {
    return this.abort(sessionId, command.reason)
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeStreams.keys())
  }

  getController(sessionId: string): AbortController | undefined {
    return this.activeStreams.get(sessionId)
  }

  registerController(sessionId: string, controller: AbortController): void {
    const existing = this.activeStreams.get(sessionId)
    if (existing) {
      this.log(`Aborting previous stream for session: ${sessionId}`)
      existing.abort()
      this.onSessionAbort(sessionId, 'Superseded by a new stream')
    }
    this.activeStreams.set(sessionId, controller)
  }

  removeController(sessionId: string): void {
    this.activeStreams.delete(sessionId)
    this.sessionChannels.delete(sessionId)
  }

  abort(sessionId: string, reason = 'User cancelled'): boolean {
    const controller = this.activeStreams.get(sessionId)
    if (controller) {
      this.log(`Aborting stream for session: ${sessionId} (${reason})`)
      controller.abort()
      this.activeStreams.delete(sessionId)
      this.onSessionAbort(sessionId, reason)
    }
    this.sessionChannels.delete(sessionId)
    this.steeringQueues.get(sessionId)?.clear()
    this.followUpQueues.get(sessionId)?.clear()
    this.onSessionCleared(sessionId)
    return Boolean(controller)
  }

  abortAll(): void {
    if (this.activeStreams.size > 0) {
      this.log(`Aborting ${this.activeStreams.size} active stream(s)`)
      for (const [sessionId, controller] of this.activeStreams) {
        controller.abort()
        this.onSessionAbort(sessionId, 'Abort all')
        this.onSessionCleared(sessionId)
      }
      this.activeStreams.clear()
      this.sessionChannels.clear()
    }
  }

  shutdown(): void {
    this.abortAll()
    this.unsubscribeCommands()
    this.steeringQueues.clear()
    this.followUpQueues.clear()
    this.commandTarget = null
    this.onShutdown()
  }

  protected subscribeToCommands(eventBus: TEventBus): void {
    this.unsubs.push(
      eventBus.onAnySession('command:send-message', (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleSendMessageCommand(envelope.sessionId, envelope.event, target)
          .catch(err => this.logError('command:send-message error:', err))
      }, 'StreamEngine'),
      eventBus.onAnySession('command:edit-and-resend', (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleEditAndResendCommand(envelope.sessionId, envelope.event, target)
          .catch(err => this.logError('command:edit-and-resend error:', err))
      }, 'StreamEngine'),
      eventBus.onAnySession('command:retry-message', (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleRetryMessageCommand(envelope.sessionId, envelope.event, target)
          .catch(err => this.logError('command:retry-message error:', err))
      }, 'StreamEngine'),
      eventBus.onAnySession('command:compact-context', (envelope) => {
        this.handleCompactContextCommand(envelope.sessionId, envelope.event)
          .catch(err => this.logError('command:compact-context error:', err))
      }, 'StreamEngine'),
      eventBus.onAnySession('command:abort', (envelope) => {
        this.handleAbort(envelope.sessionId, envelope.event as AbortLikeCommand)
      }, 'StreamEngine'),
      eventBus.onAnySession('command:resume-after-confirm', (envelope) => {
        const target = this.commandTarget
        if (!target) return
        this.handleResumeAfterConfirmCommand(envelope.sessionId, envelope.event, target)
          .catch(err => this.logError('command:resume-after-confirm error:', err))
      }, 'StreamEngine'),
      eventBus.onAnySession('command:inject-steering', (envelope) => {
        const command = envelope.event as InjectMessageCommand
        this.steerMessage(envelope.sessionId, command.content, command.source || 'eventbus', command.origin)
      }, 'StreamEngine'),
      eventBus.onAnySession('command:retract-steering', (envelope) => {
        const command = envelope.event as RetractSteeringLikeCommand
        this.retractSteerMessage(envelope.sessionId, command.messageId)
      }, 'StreamEngine'),
      eventBus.onAnySession('command:inject-followup', (envelope) => {
        const command = envelope.event as InjectMessageCommand
        this.followUpMessage(envelope.sessionId, command.content, command.source || 'eventbus', command.origin)
      }, 'StreamEngine'),
    )
  }

  protected unsubscribeCommands(): void {
    for (const unsubscribe of this.unsubs) {
      unsubscribe()
    }
    this.unsubs = []
  }

  protected onSessionAbort(_sessionId: string, _reason: string): void {}
  protected onSessionCleared(_sessionId: string): void {}
  protected onShutdown(): void {}

  protected log(message: string): void {
    log.debug(message)
  }

  protected logError(message: string, error: unknown): void {
    log.error(message, undefined, error)
  }

  protected abstract handleSendMessageCommand(
    sessionId: string,
    command: unknown,
    target: TCommandTarget
  ): Promise<void>

  protected abstract handleEditAndResendCommand(
    sessionId: string,
    command: unknown,
    target: TCommandTarget
  ): Promise<void>

  protected abstract handleRetryMessageCommand(
    sessionId: string,
    command: unknown,
    target: TCommandTarget
  ): Promise<void>

  protected abstract handleResumeAfterConfirmCommand(
    sessionId: string,
    command: unknown,
    target: TCommandTarget
  ): Promise<void>

  protected abstract handleCompactContextCommand(
    sessionId: string,
    command: unknown
  ): Promise<void>
}
