import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import { SESSION_COMMAND_TYPES } from '../events/session-command-types.js'
import { randomUUID } from 'node:crypto'
import type { JsonObject } from '../json.js'
import type { Principal } from './principal.js'
import * as PermissionGrants from './permission-grants.js'
import { getCoreLogger, toLogger, type CompatLogger, type Logger } from '../logging/index.js'

/*
 * 「拒绝那句话」搬去了零依赖叶子 `./rejection-message.js`(§17.8 U1-a)。
 *
 * 这里原样再导出 —— 既有的每一处 import 一字未改;而需要它的**纯件**
 * (`tools/tool-result.ts`,它在投影折叠器的闭包里)改走叶子路径,不再被
 * 这个文件的 `node:crypto` / 传递依赖的 `node:os|path` 拖进 node 闭包。
 */
export {
  DEFAULT_PERMISSION_REJECTED_MESSAGE,
  formatPermissionRejectedMessage,
} from './rejection-message.js'
import { formatPermissionRejectedMessage } from './rejection-message.js'

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
      /** 卡上「始终允许这个应用」这一档的作用面;缺席 = 不画那个键。 */
      alwaysScope?: { scheme: string }
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
    /**
     * 「始终允许这个应用」这一档**能不能出现在卡上**,以及出现时覆盖谁。
     *
     * 缺席 = 这一次没有一个说得清的应用可以许可(裸路径的 `file_write`、一串
     * bash 命令、`capability_change` 这种永不可授权的类)。**壳只读这一格**决定
     * 要不要画那个键 —— 它不自己去解析 pattern 猜命名空间:谁能被许可是一条判定,
     * 判定归后端,壳画的是后端已经算好的答案。
     *
     * 填这一格的唯一地方是 `permission-policy.ts` 拆效果进 ask 的那一处(它手里
     * 同时有 `effect.kind` 与 `effect.resources`)。
     */
    alwaysScope?: AlwaysScope
  }

  /**
   * 一档应用级许可的作用面(2026-09-10 拍板)。
   *
   * 只有一格 `scheme`:一条许可 = **这个项目里** × **这个应用**(命名空间)×
   * **这一类效果**。三个维度里前两个在这里,第三个是 ask 自己的 `type` ——
   * `grantMatches` 要求 type 相等,所以点一次「始终」只覆盖当下这一类效果,换一类
   * 还会再弹。这是有意的:一次点击不该代记一张用户没看过的清单。
   */
  export interface AlwaysScope {
    /** 资源命名空间(= 应用 id)。许可落成 `<scheme>:*`。 */
    scheme: string
  }

  /**
   * - `'once'`   这一次
   * - `'session'` 这条会话里都行(会话级 grant)
   * - `'workdir'` 这个项目里,这一次问到的那些资源都行(工作区级 grant,pattern 照抄)
   * - `'always'`  这个项目里,**这个应用**这一类事都行(工作区级 grant,pattern
   *   `<scheme>:*`;只有 `Info.alwaysScope` 在场时才是一个合法应答)
   * - `'reject'`  不
   */
  export type Response = 'once' | 'session' | 'workdir' | 'always' | 'reject'
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
   *
   * **`reason` 只属于"有人答了"那一支**(S3w 批 6b):`clearSession` 那条路没有
   * 答案 —— 它是 abort / 会话清理**把这条 ask 拆掉**,`'Session cleared'` 是拆除
   * 现场留给等待方的一句内部话,不是判决理由。账本上写成"被拒,理由 X"的话,
   * 投影会照 G6 把 `rejectionReason` 接到那次调用上,而抄本侧那次调用只被收尾
   * 修复写成 `{status:'cancelled', error:'User cancelled'}` —— 两侧从此差
   * 一格。同一件事账本自己已经说清了:`tool/audit.outcome` 是 `'aborted'` 而不是
   * `'denied'`。
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

  /**
   * 一次 pending 的收场**方式**:`answer` = 有人真的答了(理由属于这条答案);
   * `teardown` = 没人答,这条 ask 被拆掉了(abort / 会话清理)。
   *
   * 等待方拿到的 `RejectedError`(含 `message` 与 `reason`)两支**逐字相同** ——
   * 变的只有账本旁听席听到什么:拆除没有理由可记。
   */
  type SettleKind = 'answer' | 'teardown'

  function settlePendingReject(
    session: SessionState,
    entry: PendingEntry,
    error: Error,
    kind: SettleKind = 'answer',
  ): void {
    removePending(session, entry.info.id)
    entry.reject(error)
    for (const follower of entry.followers) follower.reject(error)
    const reason = kind === 'teardown'
      ? undefined
      : error instanceof RejectedError ? error.reason : undefined
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
      ...(info.alwaysScope ? { alwaysScope: info.alwaysScope } : {}),
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
    alwaysScope?: AlwaysScope
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
      ...(input.alwaysScope ? { alwaysScope: input.alwaysScope } : {}),
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

    /*
     * 「始终允许这个应用」只有在这次 ask 真的**认得出一个应用**时才是一个合法
     * 应答,而那一位由后端在 ask 那一刻算好写在 `alwaysScope` 上。答一个卡上根本
     * 画不出来的键 = 一次结构错误的应答:**结构化拒绝**(返回 false,这条 ask 原封
     * 不动地继续挂着),而不是抛 —— `respond` 今天对「没有这条 pending」的答法就是
     * 这个形状,一个想不通的应答不该把调用方炸掉,更不该顺手把它当 `once` 放行。
     *
     * 三条判据缺一不可:
     *  · `alwaysScope` 在场(有一个说得清的应用);
     *  · `workingDirectory` 在场(许可是**项目级**的,没有项目就没有落点 ——
     *    `addGrant` 对 workspace 档缺 root 会抛,那正是这里要挡在前面的东西);
     *  · 类型可授权(`capability_change` 这类永不留存,见 permission-grants.ts)。
     */
    if (response === 'always' && !canGrantAlways(pending.info)) {
      log.warn('always response on a prompt with no application scope, ignored', {
        sessionId: input.sessionId,
        requestId: input.permissionId,
        permissionType: pending.info.type,
      })
      return false
    }

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
      settleNewlyGrantedPending(input.sessionId, session)
    }

    /*
     * **应用级许可**(2026-09-10):`<scheme>:*` 一条,scope 仍然是既有的
     * `workspace` —— 跨项目的「始终」是量级不同的一次改动(grant 的归属维度要多一
     * 层),本单不做,留账在回报里。
     *
     * 与 `'workdir'` 的差别只在 pattern:那一支照抄这次问到的具体资源
     * (`session:<那条会话>`),这一支写整个命名空间(`session:*`)。type 不放宽 ——
     * `grantMatches` 要求相等,所以一次点击 = 一个应用 × 一类效果。
     */
    if (response === 'always') {
      const scope = pending.info.alwaysScope
      if (scope) {
        PermissionGrants.addGrant({
          scope: 'workspace',
          type: pending.info.type,
          pattern: `${scope.scheme}:*`,
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
        settleNewlyGrantedPending(input.sessionId, session)
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
      settleNewlyGrantedPending(input.sessionId, session)
    }

    emitNextPrompt(input.sessionId, session)
    return true
  }

  /** 这张卡上画不画得出「始终允许这个应用」。壳与内核问的是同一句。 */
  function canGrantAlways(info: Info): boolean {
    return Boolean(info.alwaysScope)
      && Boolean(info.workingDirectory)
      && PermissionGrants.isGrantableType(info.type)
  }

  /**
   * 刚落下一条 grant 之后,把**其余还挂着的** ask 顺手结掉 —— 它们要问的事这条
   * 新许可已经答过了,再弹一次就是同一个问题问两遍。
   *
   * 三支(`session` / `workdir` / `always`)共用这一份:判据全在 `matchGrant` 里,
   * 三处各写一遍只会让其中一处有一天忘了跟上匹配算法。
   *
   * `workdir` 那一支从前在这个循环外面还多一道
   * `other.info.workingDirectory === pending.info.workingDirectory` 的前置筛。它筛的
   * 是 `matchGrant` 紧接着就要再判一次的同一件事(而且是**没归一化**的字符串比较,
   * 比 `grantMatches` 里那次 `path.resolve` 之后的比较更严),所以去掉它只会让
   * 「两个写法不同、指同一棵树的路径」也被正确结掉 —— 与 `session` 那一支本来的
   * 行为对齐。
   */
  function settleNewlyGrantedPending(sessionId: string, session: SessionState): void {
    for (const other of Array.from(session.pending.values())) {
      const otherGrant = PermissionGrants.matchGrant({
        type: other.info.type,
        pattern: other.info.pattern,
        sessionId,
        workspaceRoot: other.info.workingDirectory,
        userId: other.info.userId,
        workspaceId: other.info.workspaceId,
      })
      if (otherGrant) {
        settlePendingResolve(session, other)
      }
    }
  }

  /**
   * 拆掉这个会话所有还没答的 ask(`engine.abort` 的最后一步 / 会话清理)。
   *
   * 等待方仍然拿到带 `'Session cleared'` 的 `RejectedError` —— 那句话是给
   * "还在 await 的那半段代码"看的。但账本上这是 `teardown` 不是 `answer`:
   * 没人答过,所以 `permission/answered` **不带 reason**(见 `Recorder` 的注释)。
   */
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
      ), 'teardown')
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
