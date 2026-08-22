import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import { SESSION_COMMAND_TYPES } from '../events/session-command-types.js'
import { randomUUID } from 'node:crypto'
import type { JsonObject } from '../json.js'
import type { Principal } from './principal.js'
import * as PermissionGrants from './permission-grants.js'
import { getCoreLogger, toLogger, type CompatLogger, type Logger } from '../logging/index.js'

export const DEFAULT_PERMISSION_REJECTED_MESSAGE = 'The user rejected permission for this tool.'

export function formatPermissionRejectedMessage(reason?: string): string {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : ''
  return trimmedReason
    ? `${DEFAULT_PERMISSION_REJECTED_MESSAGE} Reason: ${trimmedReason}`
    : DEFAULT_PERMISSION_REJECTED_MESSAGE
}

export interface PermissionCommandEnvelope<TCommand = unknown> {
  sessionId: string
  event: TCommand
}

export type PermissionBusEvent =
  | {
      type: typeof SESSION_EVENT_TYPES.PERMISSION_REQUEST
      requestId: string
      targetChannel: string
      toolCallId: string
      messageId: string
      permissionType: string
      title: string
      pattern?: string | string[]
      metadata: JsonObject
      userId?: string
      workspaceId?: string
    }
  | {
      type: typeof SESSION_EVENT_TYPES.PERMISSION_QUEUED
      requestId: string
      toolCallId: string
      messageId: string
    }
  | {
      type: typeof SESSION_EVENT_TYPES.PERMISSION_SETTLED
      requestId: string
      toolCallIds: string[]
      decision: 'allowed' | 'rejected'
    }

export interface PermissionEventBusLike {
  onAnySession(
    eventType: string,
    handler: (envelope: PermissionCommandEnvelope) => void,
    label?: string
  ): () => void
  emit(sessionId: string, event: PermissionBusEvent): Promise<unknown>
}

export interface PermissionRespondCommandLike {
  requestId?: string
  /**
   * Durable correlation key: the tool call this response targets. Unlike
   * requestId (which only ever lives in memory on both ends), the tool call
   * id is persisted with the message, so responders can always supply it.
   */
  toolCallId?: string
  decision: Permission.Response
  channel?: string
  rejectReason?: string
}

export namespace Permission {
  export interface Info {
    id: string
    type: string
    pattern?: string | string[]
    sessionId: string
    messageId: string
    callId?: string
    title: string
    metadata: JsonObject
    createdAt: number
    workingDirectory?: string
    targetChannel?: string
    userId?: string
    workspaceId?: string
    /**
     * Who is asking. Minted once per turn at the engine boundary (see
     * ./principal.ts) and carried down — this is NOT re-derived here.
     * Optional while the mint sites are being wired; absent means "the
     * boundary could not prove an actor", which reads as least privilege.
     */
    principal?: Principal
  }

  export type Response = 'once' | 'session' | 'workdir' | 'reject'
  export type Mode = 'normal' | 'auto-accept-edits' | 'dangerously-allow-all'

  interface PendingSettler {
    resolve: () => void
    reject: (error: Error) => void
  }

  interface PendingEntry extends PendingSettler {
    info: Info
    /**
     * Equivalent asks issued while this one is pending share its outcome
     * instead of prompting again.
     */
    followers: PendingSettler[]
    /** Tool call ids of coalesced followers, for the settled event. */
    followerCallIds: string[]
    /** Whether the permission:request event has been sent to the channel. */
    emitted: boolean
  }

  interface SessionState {
    pending: Map<string, PendingEntry>
    /**
     * Ask order. Only the head request is emitted to the UI/gateway; the rest
     * wait so concurrent tools never stack prompts, and a grant landing in the
     * meantime can settle them before they are ever shown.
     */
    promptOrder: string[]
  }

  /**
   * 审批的**账本旁听席**(session-event-sourcing §10.2 的"权限/交互层")。
   *
   * 事件溯源要的是"什么时候问了谁、答了什么、为什么拒",而 `permission:settled`
   * 那条总线事件只带 allowed/rejected —— 拒绝的**理由**只活在
   * `RejectedError.reason` 里,而投影正是靠它把 `rejectionReason` 接到 toolCall
   * 上(G6)。所以这里开一个口子,而不是让装配层去听总线再猜。
   *
   * core 仍然零依赖:这只是一个回调,落盘在 `app/session/` 那一侧。
   */
  export interface Recorder {
    onAsked?(info: Info): void
    onAnswered?(input: {
      info: Info
      toolCallIds: string[]
      approved: boolean
      scope?: Response
      reason?: string
    }): void
  }

  const sessions = new Map<string, SessionState>()
  let recorder: Recorder | null = null
  let eventBus: PermissionEventBusLike | null = null
  let channelResolver: ((sessionId: string) => string) | null = null
  let modeResolver: ((sessionId: string) => Mode) | null = null
  let unsubPermissionRespond: (() => void) | null = null
  /** core 不持有全局 root:装配层注入,缺省 noop(§8.3 区 ①)。 */
  let log: Logger = getCoreLogger('core.permission')

  /** 装配层的接线口。传 null 摘下。 */
  export function setLogger(next: CompatLogger | null): void {
    log = next ? toLogger(next, 'core.permission') : getCoreLogger('core.permission')
  }

  function getSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId)
    if (!session) {
      session = { pending: new Map(), promptOrder: [] }
      sessions.set(sessionId, session)
    }
    return session
  }

  function equivalenceKey(info: Pick<Info, 'type' | 'pattern' | 'workingDirectory' | 'userId' | 'workspaceId' | 'metadata'>): string {
    // metadata carries the concrete request (bash command text, MCP args,
    // file diff…). Including it restricts coalescing to literally identical
    // requests: a bash pattern like `rm *` must NOT merge two different rm
    // commands, or approving the shown one would silently approve the other.
    // Identical construction sites produce identical key order, so plain
    // JSON.stringify is a stable discriminator here.
    return JSON.stringify([
      info.type,
      info.pattern ?? null,
      info.workingDirectory ?? null,
      info.userId ?? null,
      info.workspaceId ?? null,
      info.metadata ?? null,
    ])
  }

  function findEquivalentPending(session: SessionState, info: Info): PendingEntry | undefined {
    const key = equivalenceKey(info)
    for (const entry of session.pending.values()) {
      if (equivalenceKey(entry.info) === key) return entry
    }
    return undefined
  }

  function findPendingByCallId(session: SessionState, callId: string): PendingEntry | undefined {
    for (const entry of session.pending.values()) {
      if (entry.info.callId === callId || entry.followerCallIds.includes(callId)) return entry
    }
    return undefined
  }

  function removePending(session: SessionState, id: string): void {
    session.pending.delete(id)
    const index = session.promptOrder.indexOf(id)
    if (index !== -1) session.promptOrder.splice(index, 1)
  }

  function emitPermissionEvent(sessionId: string, event: PermissionBusEvent): void {
    eventBus?.emit(sessionId, event)
      .catch(err => log.error('event emit failed', { sessionId, eventType: event.type }, err))
  }

  function emitSettled(
    entry: PendingEntry,
    decision: 'allowed' | 'rejected',
    details: { scope?: Response; reason?: string } = {},
  ): void {
    const toolCallIds = [entry.info.callId, ...entry.followerCallIds]
      .filter((id): id is string => Boolean(id))
    emitPermissionEvent(entry.info.sessionId, {
      type: SESSION_EVENT_TYPES.PERMISSION_SETTLED,
      requestId: entry.info.id,
      toolCallIds,
      decision,
    })
    try {
      recorder?.onAnswered?.({
        info: entry.info,
        toolCallIds,
        approved: decision === 'allowed',
        ...(details.scope !== undefined ? { scope: details.scope } : {}),
        ...(details.reason !== undefined ? { reason: details.reason } : {}),
      })
    } catch (error) {
      log.warn('recorder onAnswered failed', { requestId: entry.info.id }, error)
    }
  }

  function settlePendingResolve(
    session: SessionState,
    entry: PendingEntry,
    scope?: Response,
  ): void {
    removePending(session, entry.info.id)
    entry.resolve()
    for (const follower of entry.followers) follower.resolve()
    emitSettled(entry, 'allowed', scope !== undefined ? { scope } : {})
  }

  function settlePendingReject(session: SessionState, entry: PendingEntry, error: Error): void {
    removePending(session, entry.info.id)
    entry.reject(error)
    for (const follower of entry.followers) follower.reject(error)
    const reason = error instanceof RejectedError ? error.reason : undefined
    emitSettled(entry, 'rejected', reason !== undefined ? { reason } : {})
  }

  /** 账本旁听席的接线口。传 null 摘下。 */
  export function setRecorder(next: Recorder | null): void {
    recorder = next
  }

  function emitNextPrompt(sessionId: string, session: SessionState): void {
    const headId = session.promptOrder[0]
    if (!headId) return
    const entry = session.pending.get(headId)
    if (!entry || entry.emitted) return
    entry.emitted = true

    if (!eventBus) {
      log.warn('event bus not initialized, permission request will hang', { sessionId, requestId: entry.info.id })
      return
    }
    const info = entry.info
    eventBus.emit(sessionId, {
      type: SESSION_EVENT_TYPES.PERMISSION_REQUEST,
      requestId: info.id,
      targetChannel: info.targetChannel ?? 'ipc',
      toolCallId: info.callId || '',
      messageId: info.messageId,
      permissionType: info.type,
      title: info.title,
      pattern: info.pattern,
      metadata: info.metadata,
      userId: info.userId,
      workspaceId: info.workspaceId,
    }).catch(err => log.error('event emit failed', { sessionId, eventType: SESSION_EVENT_TYPES.PERMISSION_REQUEST }, err))
  }

  export function initialize(
    bus: PermissionEventBusLike,
    resolver: (sessionId: string) => string,
    permissionModeResolver?: (sessionId: string) => Mode,
  ): void {
    // Re-initialization must not leak the previous respond subscription.
    unsubPermissionRespond?.()
    eventBus = bus
    channelResolver = resolver
    modeResolver = permissionModeResolver ?? null

    unsubPermissionRespond = bus.onAnySession(
      SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
      (envelope) => {
        const cmd = envelope.event as PermissionRespondCommandLike
        const sessionId = envelope.sessionId
        const responseChannel = cmd.channel || 'ipc'

        const session = getSession(sessionId)
        const byRequestId = cmd.requestId ? session.pending.get(cmd.requestId) : undefined
        const byCallId = !byRequestId && cmd.toolCallId
          ? findPendingByCallId(session, cmd.toolCallId)
          : undefined
        // A queued (never-emitted) prompt was never shown to anyone; a response
        // addressed to it by tool call id would be a blind approval. Responses
        // for coalesced followers are fine — their request is literally the
        // emitted head's.
        if (byCallId && !byCallId.emitted) {
          log.warn('response targets a queued prompt, ignored', { sessionId, toolCallId: cmd.toolCallId })
          return
        }
        const pending = byRequestId ?? byCallId
        if (!pending) {
          log.warn('no pending request for respond', { sessionId, requestId: cmd.requestId, toolCallId: cmd.toolCallId })
          return
        }

        const expectedChannel = pending.info.targetChannel || 'ipc'
        if (expectedChannel !== responseChannel) {
          log.warn('response from wrong channel, ignored', { sessionId, expectedChannel, responseChannel })
          return
        }

        respond({
          sessionId,
          permissionId: pending.info.id,
          response: cmd.decision,
          rejectReason: cmd.rejectReason,
        })
      },
      'Permission',
    )

    log.info('permission initialized')
  }

  export function shutdown(): void {
    if (unsubPermissionRespond) {
      unsubPermissionRespond()
      unsubPermissionRespond = null
    }
    eventBus = null
    channelResolver = null
    modeResolver = null
    log.info('permission shut down')
  }

  export function getPending(sessionId: string): Info[] {
    const session = getSession(sessionId)
    // Only emitted requests are visible prompts; queued ones surface when they
    // reach the head of the prompt queue.
    return Array.from(session.pending.values())
      .filter(p => p.emitted)
      .map(p => p.info)
  }

  export type PromptState = 'actionable' | 'queued'

  export interface PendingPromptInfo extends Info {
    /**
     * 'actionable' — the prompt has been emitted and a response is expected.
     * 'queued' — waiting behind the head of the session's prompt queue (or a
     * coalesced follower of an emitted head); show a waiting state, no card.
     */
    promptState: PromptState
  }

  /**
   * Full per-tool-call picture for rebuilding UI state after a reload —
   * unlike getPending, this includes queued prompts and coalesced followers,
   * each labeled with its promptState.
   */
  export function getPendingPrompts(sessionId: string): PendingPromptInfo[] {
    const session = getSession(sessionId)
    const result: PendingPromptInfo[] = []
    for (const entry of session.pending.values()) {
      result.push({ ...entry.info, promptState: entry.emitted ? 'actionable' : 'queued' })
      // Coalesced followers are separate tool calls awaiting the head's
      // outcome — surface each under its own callId so per-call UI state can
      // be rebuilt after a reload.
      for (const followerCallId of entry.followerCallIds) {
        result.push({ ...entry.info, callId: followerCallId, promptState: 'queued' })
      }
    }
    return result
  }

  export function getMode(sessionId: string): Mode {
    return modeResolver ? modeResolver(sessionId) : 'normal'
  }

  export async function ask(input: {
    type: Info['type']
    title: Info['title']
    pattern?: Info['pattern']
    callId?: Info['callId']
    sessionId: Info['sessionId']
    messageId: Info['messageId']
    metadata: Info['metadata']
    workingDirectory?: string
    userId?: string
    workspaceId?: string
    principal?: Principal
  }): Promise<void> {
    const session = getSession(input.sessionId)
    const targetChannel = channelResolver ? channelResolver(input.sessionId) : 'ipc'
    const info: Info = {
      id: randomUUID(),
      type: input.type,
      pattern: input.pattern,
      sessionId: input.sessionId,
      messageId: input.messageId,
      callId: input.callId,
      title: input.title,
      metadata: input.metadata,
      createdAt: Date.now(),
      workingDirectory: input.workingDirectory,
      targetChannel,
      userId: input.userId,
      workspaceId: input.workspaceId,
      principal: input.principal,
    }

    const equivalent = findEquivalentPending(session, info)
    if (equivalent) {
      log.debug('permission ask coalesced', {
        sessionId: input.sessionId,
        requestId: equivalent.info.id,
        permissionType: info.type,
        pattern: info.pattern,
      })
      return new Promise<void>((resolve, reject) => {
        equivalent.followers.push({ resolve, reject })
        if (info.callId) {
          equivalent.followerCallIds.push(info.callId)
          emitPermissionEvent(input.sessionId, {
            type: SESSION_EVENT_TYPES.PERMISSION_QUEUED,
            requestId: equivalent.info.id,
            toolCallId: info.callId,
            messageId: info.messageId,
          })
        }
      })
    }

    log.debug('permission asked', {
      sessionId: input.sessionId,
      requestId: info.id,
      permissionType: info.type,
      pattern: info.pattern,
      targetChannel,
    })

    try {
      recorder?.onAsked?.(info)
    } catch (error) {
      log.warn('recorder onAsked failed', { requestId: info.id }, error)
    }

    return new Promise<void>((resolve, reject) => {
      const entry: PendingEntry = { info, resolve, reject, followers: [], followerCallIds: [], emitted: false }
      session.pending.set(info.id, entry)
      session.promptOrder.push(info.id)
      emitNextPrompt(input.sessionId, session)
      if (!entry.emitted && info.callId) {
        emitPermissionEvent(input.sessionId, {
          type: SESSION_EVENT_TYPES.PERMISSION_QUEUED,
          requestId: info.id,
          toolCallId: info.callId,
          messageId: info.messageId,
        })
      }
    })
  }

  export function respond(input: {
    sessionId: string
    permissionId: string
    response: Response
    rejectReason?: string
  }): boolean {
    const session = getSession(input.sessionId)
    const pending = session.pending.get(input.permissionId)

    if (!pending) {
      log.warn('no pending request', { sessionId: input.sessionId, requestId: input.permissionId })
      return false
    }

    const response = input.response

    log.debug('permission responded', { sessionId: input.sessionId, requestId: input.permissionId, response })

    if (response === 'reject') {
      settlePendingReject(session, pending, new RejectedError(
        input.sessionId,
        input.permissionId,
        pending.info.callId,
        pending.info.metadata,
        input.rejectReason,
      ))
      emitNextPrompt(input.sessionId, session)
      return true
    }

    settlePendingResolve(session, pending, response)

    if (
      response === 'workdir' &&
      pending.info.workingDirectory &&
      PermissionGrants.isGrantableType(pending.info.type)
    ) {
      PermissionGrants.addGrant({
        scope: 'workspace',
        type: pending.info.type,
        pattern: pending.info.pattern ?? pending.info.type,
        workspaceRoot: pending.info.workingDirectory,
        userId: pending.info.userId,
        workspaceId: pending.info.workspaceId,
        createdFrom: {
          messageId: pending.info.messageId,
          toolCallId: pending.info.callId,
          title: pending.info.title,
        },
        metadata: pending.info.metadata,
      })
      for (const other of Array.from(session.pending.values())) {
        if (other.info.workingDirectory === pending.info.workingDirectory) {
          const otherGrant = PermissionGrants.matchGrant({
            type: other.info.type,
            pattern: other.info.pattern,
            sessionId: input.sessionId,
            workspaceRoot: other.info.workingDirectory,
            userId: other.info.userId,
            workspaceId: other.info.workspaceId,
          })
          if (otherGrant) {
            settlePendingResolve(session, other)
          }
        }
      }
    }

    if (response === 'session') {
      PermissionGrants.addGrant({
        scope: 'session',
        type: pending.info.type,
        pattern: pending.info.pattern ?? pending.info.type,
        sessionId: input.sessionId,
        userId: pending.info.userId,
        workspaceId: pending.info.workspaceId,
        createdFrom: {
          messageId: pending.info.messageId,
          toolCallId: pending.info.callId,
          title: pending.info.title,
        },
        metadata: pending.info.metadata,
      })
      for (const other of Array.from(session.pending.values())) {
        const otherGrant = PermissionGrants.matchGrant({
          type: other.info.type,
          pattern: other.info.pattern,
          sessionId: input.sessionId,
          workspaceRoot: other.info.workingDirectory,
          userId: other.info.userId,
          workspaceId: other.info.workspaceId,
        })
        if (otherGrant) {
          settlePendingResolve(session, other)
        }
      }
    }

    emitNextPrompt(input.sessionId, session)
    return true
  }

  export function clearSession(sessionId: string): void {
    const session = sessions.get(sessionId)
    if (!session) return

    for (const pending of Array.from(session.pending.values())) {
      settlePendingReject(session, pending, new RejectedError(
        sessionId,
        pending.info.id,
        pending.info.callId,
        pending.info.metadata,
        'Session cleared',
      ))
    }

    sessions.delete(sessionId)
  }

  export class RejectedError extends Error {
    constructor(
      public readonly sessionId: string,
      public readonly permissionId: string,
      public readonly toolCallId?: string,
      public readonly metadata?: JsonObject,
      public readonly reason?: string,
    ) {
      super(formatPermissionRejectedMessage(reason))
      this.name = 'PermissionRejectedError'
    }
  }
}

export * from './capability-registry.js'
export * from './permission-grants.js'
export * from './permission-policy.js'
export * from './principal.js'
