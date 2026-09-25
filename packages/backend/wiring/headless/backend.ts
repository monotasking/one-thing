import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  CollabRoomBudgetsPatch,
  CollabRoomUpdatePatch,
  PermissionMode,
} from '@shared/ipc.js'
import type {
  ActiveStreamInfo,
  AskOutputEvent,
  AskRequest,
  AskResult,
  DaemonStreamEvent,
  ProviderSummary,
  SessionSummary,
  ToolSummary,
} from '@shared/cli/protocol.js'
import {
  listOnethingHeadlessProviderModels,
  listOnethingHeadlessProviderSummaries,
  listOnethingHeadlessSessionSummaries,
  listOnethingHeadlessToolSummaries,
  setOnethingHeadlessPermissionMode,
  updateOnethingHeadlessToolSetting,
  upsertOnethingHeadlessProviderConfig,
  useOnethingHeadlessProvider,
} from '@onething/runtime/headless/index'
import { createOnethingBackend, type OnethingBackend, type OnethingBackendOptions } from '../../backend.js'
import {
  createSession,
  getCurrentSessionId,
  getSession,
  getSessionsList,
  renameSession,
  saveSettings,
  setCurrentSessionId,
  updateSessionArchived,
  updateSessionModel,
  updateSessionPermissionMode,
  updateSessionPin,
  updateSessionWorkingDirectory,
} from '../../store.js'
// 建房走 app 层那一本规则书。直接指到 room-create 而不是 collab 桶:这条口是
// 同步的,而桶会把协调器整棵树一起拉起来 —— 邻居们的 `await import` 就是为了
// 避开那件事。room-create 只依赖 store 与 agents,两者本来就已经在了。
import { ensureCollabGroupRoom } from '../collab/room-create.js'
import { getSettings } from '../../stores/settings.js'
import { toolkitCatalogToolDefinitions } from '@onething/runtime/toolkit/catalog-projection.wiring'
import { getEventBus, getStreamChannel } from '../../events/index.js'
import { collectSessionCascadeDeleteIds } from '@onething/core/session'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { sessionReads } from '../../session/reads.js'
import { getStreamEngine } from '../engine/index.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { localUserPrincipal } from '@onething/core/permission'
import { markHostUnattended } from '@onething/runtime/permissions/unattended'
import type { Principal } from '@onething/core/permission'
import {
  serializeOutcome,
  serializeReadOutcome,
  serializeSpec,
} from '../../rpc/domains/resources.js'
import type {
  ListResourcesResponse,
  ResourceOutcomeView,
  ResourceReadView,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import type { BindableOnethingStreamSender } from '@onething/runtime/stream-sender'

type EmitStreamEvent = (event: DaemonStreamEvent) => void

class HeadlessSender extends EventEmitter implements BindableOnethingStreamSender {
  isDestroyed(): boolean {
    return false
  }

  send(): void {
    // The daemon observes EventBus and StreamChannel directly.
  }
}

interface ActiveStreamRecord extends ActiveStreamInfo {
  resolve: (result: AskResult) => void
  reject: (error: Error) => void
  emit: EmitStreamEvent
  permissionTimers: Map<string, NodeJS.Timeout>
  unsubs: Array<() => void>
}

export class HeadlessBackend {
  private started = false
  /**
   * A2:daemon 持有装配产物本身。从前这里只有一个 `started` 布尔,关机靠
   * 下面那张**手抄**的清单 —— 抄漏了八件(RPC 域、协作、外部执行体、
   * 插件、Interaction、账本广播、两个启动期定时器),而没有任何一道门看得见
   * 它抄漏了。现在关机就是 `backend.dispose()`,清单归装配层一处。
   */
  private backend: OnethingBackend | null = null
  private sender = new HeadlessSender()
  private activeStreams = new Map<string, ActiveStreamRecord>()
  private activeStreamBySession = new Map<string, string>()

  get ownedBackend(): OnethingBackend {
    if (!this.backend) throw new Error('Headless backend is not started')
    return this.backend
  }

  async start(options: { storePath?: string; logging?: OnethingBackendOptions['logging'] } = {}): Promise<void> {
    if (this.started) return

    /*
     * K4-d:**这台进程上没有人可以答一张权限卡**,守护进程自己说这一句。
     *
     * 下面 `startPermissionTimeout` 那条既有的 60 秒自动拒只接在 `chat.ask` 的活流
     * 上;经 daemon / `onething mcp` 桥进来的资源 `do` 没有流,卡会一直挂着(K4-c
     * 留账 1)。声明之后,`system` 主体的 ask 由 `permission-policy.ts` 的
     * `unattendedHostBridge` 在 60 秒后经 `Permission.respond` 答掉。
     *
     * 声明**先于**装配:装配途中(`mcpAcp: true` 会真的把 MCP 拉起来)万一有人问
     * 权限,那时也已经没人能答。装配失败就地收回,免得一台没起来的后端在进程里
     * 留下一句「无人值守」。成功之后交给 `own()` —— 关机清单归装配层一处,这里不
     * 再多记一个字段(A2 那条:手抄的清单会抄漏)。
     */
    const releaseUnattendedHost = markHostUnattended('cli-daemon')
    try {
      this.backend = await createOnethingBackend({
        owner: 'daemon',
        storePath: options.storePath,
        logging: options.logging,
        /*
         * A1:宿主能力一次交清。CLI daemon 除了下载目录之外一件宿主能力都没有
         * (它没有窗口、没有托盘、没有 Keychain 身份),十四个 `null` 就是这里的
         * 事实清单(数目随表长:B3 加了 `terminal` 与 `localTrust` 两格)。
         * `storePath: {}` 与从前从不调 `configureStorePathHost` 时的缺省逐字相同。
         */
        host: {
          storePath: {},
          sandbox: {
            getPath(name) {
              if (name === 'downloads') return path.join(os.homedir(), 'Downloads')
              if (name === 'home') return os.homedir()
              return os.homedir()
            },
          },
          auth: null,
          logging: null,
          shell: null,
          voice: null,
          terminal: null,
          // CLI daemon 不分发 RPC(它走自己那套 NDJSON 命令),没有"可信的 HTTP
          // 调用方"这回事 —— 六个信任判据在它这里一条都到不了。
          localTrust: null,
          speechOutput: null,
          dialog: null,
          skillsEnvironment: null,
          todoPlan: null,
          scratchpad: null,
          plugins: null,
          gateway: null,
          settings: null,
          evals: null,
          mcp: null,
        },
        toolRegistry: 'headless',
        sessionSkills: true,
        mcpAcp: true,
        // Multi-agent rooms work headless too: the sender below is bound, so
        // the coordinator's hasCommandTarget gate passes and drives flow.
        collab: true,
        sender: this.sender,
      })
    } catch (error) {
      releaseUnattendedHost()
      throw error
    }
    this.backend.own(releaseUnattendedHost, 'unattendedHost')
    this.started = true
  }

  async shutdown(reason = 'daemon shutdown'): Promise<void> {
    for (const stream of this.activeStreams.values()) {
      stream.status = reason === 'daemon restart' ? 'restarting' : 'aborting'
      stream.emit({
        streamId: stream.streamId,
        sessionId: stream.sessionId,
        event: reason === 'daemon restart'
          ? { type: 'error', code: 'DAEMON_RESTART', message: 'Stream interrupted: daemon restarted' }
          : { type: 'done', stopReason: 'aborted' },
      })
    }
    // 关机的全部内容就是这一行:清单由 `assemble` 途中的 `own()` 登记,
    // 顺序是登记逆序(引擎收流 → 外部执行体 → MCP/ACP → 插件 → 子进程/终端 →
    // 引擎 → 权限 → 会话层 → 事件系统 → 两次落盘)。daemon 起 `mcpAcp: true`,
    // 所以 MCP/ACP 那一步在装配层那一份里是真的会跑的。
    await this.backend?.requestShutdown(reason)
    this.backend = null
    this.activeStreams.clear()
    this.activeStreamBySession.clear()
    this.started = false
  }

  getActiveStreams(): ActiveStreamInfo[] {
    return Array.from(this.activeStreams.values()).map(stream => ({
      streamId: stream.streamId,
      sessionId: stream.sessionId,
      ownerClientId: stream.ownerClientId,
      promptPreview: stream.promptPreview,
      startedAt: stream.startedAt,
      status: stream.status,
    }))
  }

  abortStream(streamId: string): boolean {
    const stream = this.activeStreams.get(streamId)
    if (!stream) return false
    stream.status = 'aborting'
    return getStreamEngine().abort(stream.sessionId, 'CLI active abort')
  }

  async ask(request: AskRequest, ownerClientId: string, emit: EmitStreamEvent): Promise<AskResult> {
    const sessionId = this.resolveSessionId(request.sessionId)
    const streamId = randomUUID()
    const promptPreview = request.prompt.replace(/\s+/g, ' ').trim().slice(0, 120)

    return new Promise<AskResult>((resolve, reject) => {
      const record: ActiveStreamRecord = {
        streamId,
        sessionId,
        ownerClientId,
        promptPreview,
        startedAt: Date.now(),
        status: 'running',
        resolve,
        reject,
        emit,
        permissionTimers: new Map(),
        unsubs: [],
      }

      const cleanup = () => this.cleanupStream(streamId)
      record.unsubs.push(
        getStreamChannel().subscribe(sessionId, chunk => {
          if (chunk.type === 'text-delta') {
            emit({ streamId, sessionId, event: { type: 'text_delta', text: chunk.text } })
          } else if (chunk.type === 'reasoning-delta') {
            emit({ streamId, sessionId, event: { type: 'reasoning_delta', text: chunk.reasoning } })
          }
        }),
        getEventBus().onAny(sessionId, envelope => {
          const event = envelope.event
          switch (event.type) {
            case SESSION_EVENT_TYPES.TOOL_CALL:
              emit({
                streamId,
                sessionId,
                event: {
                  type: 'tool_use',
                  id: event.toolCall.id,
                  name: event.toolCall.toolName,
                  input: event.toolCall.arguments,
                },
              })
              break
            case SESSION_EVENT_TYPES.TOOL_RESULT:
              emit({
                streamId,
                sessionId,
                event: {
                  type: 'tool_result',
                  id: event.toolCall.id,
                  content: event.toolCall.result ?? event.toolCall.error ?? null,
                  isError: event.toolCall.status === 'failed' || Boolean(event.toolCall.error),
                },
              })
              break
            case SESSION_EVENT_TYPES.PERMISSION_REQUEST:
              if (event.targetChannel !== 'cli') break
              emit({
                streamId,
                sessionId,
                event: {
                  type: 'permission',
                  id: event.requestId,
                  description: event.title,
                  options: ['once', 'session', 'workdir', 'reject'],
                },
              })
              this.startPermissionTimeout(record, event.requestId)
              break
            case SESSION_EVENT_TYPES.STREAM_COMPLETE: {
              const stopReason = event.data?.aborted ? 'aborted' : event.data?.error ? 'error' : 'end_turn'
              emit({ streamId, sessionId, event: { type: 'done', stopReason, usage: event.data?.usage } })
              resolve({ streamId, sessionId, stopReason })
              cleanup()
              break
            }
            case SESSION_EVENT_TYPES.STREAM_ERROR:
              emit({ streamId, sessionId, event: { type: 'error', code: 'STREAM_ERROR', message: event.data.error } })
              resolve({ streamId, sessionId, stopReason: 'error' })
              cleanup()
              break
            case SESSION_EVENT_TYPES.STREAM_ABORTED:
              emit({ streamId, sessionId, event: { type: 'done', stopReason: 'aborted' } })
              resolve({ streamId, sessionId, stopReason: 'aborted' })
              cleanup()
              break
          }
        }, 'CLI daemon stream'),
      )

      this.activeStreams.set(streamId, record)
      this.activeStreamBySession.set(sessionId, streamId)

      getEventBus().emit(sessionId, {
        type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
        channel: 'cli',
        content: request.prompt,
        source: request.source || 'cli',
      }).catch(error => {
        emit({
          streamId,
          sessionId,
          event: { type: 'error', code: 'STREAM_START_FAILED', message: errorMessage(error) },
        })
        reject(error instanceof Error ? error : new Error(String(error)))
        cleanup()
      })
    })
  }

  async retryLast(sessionId: string, ownerClientId: string, emit: EmitStreamEvent): Promise<AskResult> {
    const lastAssistant = sessionReads.lastMessageOfRole(sessionId, 'assistant')
    if (!lastAssistant) throw new Error('No assistant message to retry')

    const streamId = randomUUID()
    return new Promise<AskResult>((resolve, reject) => {
      const record: ActiveStreamRecord = {
        streamId,
        sessionId,
        ownerClientId,
        promptPreview: 'retry last assistant message',
        startedAt: Date.now(),
        status: 'running',
        resolve,
        reject,
        emit,
        permissionTimers: new Map(),
        unsubs: [],
      }
      const cleanup = () => this.cleanupStream(streamId)
      record.unsubs.push(
        getStreamChannel().subscribe(sessionId, chunk => {
          if (chunk.type === 'text-delta') emit({ streamId, sessionId, event: { type: 'text_delta', text: chunk.text } })
          if (chunk.type === 'reasoning-delta') emit({ streamId, sessionId, event: { type: 'reasoning_delta', text: chunk.reasoning } })
        }),
        getEventBus().onAny(sessionId, envelope => {
          if (envelope.event.type === SESSION_EVENT_TYPES.STREAM_COMPLETE) {
            emit({ streamId, sessionId, event: { type: 'done', stopReason: envelope.event.data?.aborted ? 'aborted' : 'end_turn' } })
            resolve({ streamId, sessionId, stopReason: envelope.event.data?.aborted ? 'aborted' : 'end_turn' })
            cleanup()
          } else if (envelope.event.type === SESSION_EVENT_TYPES.STREAM_ERROR) {
            emit({ streamId, sessionId, event: { type: 'error', code: 'STREAM_ERROR', message: envelope.event.data.error } })
            resolve({ streamId, sessionId, stopReason: 'error' })
            cleanup()
          }
        }, 'CLI daemon retry'),
      )
      this.activeStreams.set(streamId, record)
      this.activeStreamBySession.set(sessionId, streamId)
      getEventBus().emit(sessionId, {
        type: SESSION_COMMAND_TYPES.RETRY_MESSAGE,
        messageId: lastAssistant.id,
      }).catch(error => {
        reject(error instanceof Error ? error : new Error(String(error)))
        cleanup()
      })
    })
  }

  respondToPermission(sessionId: string, requestId: string, decision: 'once' | 'session' | 'workdir' | 'reject'): void {
    const streamId = this.activeStreamBySession.get(sessionId)
    if (streamId) {
      const stream = this.activeStreams.get(streamId)
      const timer = stream?.permissionTimers.get(requestId)
      if (timer) clearTimeout(timer)
      stream?.permissionTimers.delete(requestId)
    }
    void getEventBus().emit(sessionId, {
      type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
      channel: 'cli',
      requestId,
      decision,
    })
  }

  listSessions(): SessionSummary[] {
    return listOnethingHeadlessSessionSummaries(getSessionsList())
  }

  newSession(name = 'CLI Chat'): ChatSession {
    const sessionId = randomUUID()
    const session = createSession(sessionId, name)
    setCurrentSessionId(sessionId)
    return session
  }

  useSession(sessionId: string): ChatSession {
    const session = getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    setCurrentSessionId(sessionId)
    return session
  }

  showSession(sessionId?: string): ChatSession {
    const resolved = this.resolveSessionId(sessionId)
    const session = getSession(resolved)
    if (!session) throw new Error(`Session not found: ${resolved}`)
    return session
  }

  renameSession(sessionId: string, name: string): void {
    renameSession(sessionId, name)
  }

  pinSession(sessionId: string, pinned: boolean): void {
    updateSessionPin(sessionId, pinned)
  }

  archiveSession(sessionId: string, archived: boolean): void {
    updateSessionArchived(sessionId, archived, archived ? Date.now() : null)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const layer = this.ownedBackend.sessionLayer
    const ids = layer.access.resolveAll(DESKTOP_RPC_CONTEXT,
      collectSessionCascadeDeleteIds(getSessionsList(), sessionId), 'delete')
    await layer.deletion.delete(sessionId, ids, targets => {
      layer.access.resolveAll(DESKTOP_RPC_CONTEXT, targets, 'delete')
    })
  }

  // ── 资源:读 / 做 / 看(原子 K4-b,`docs/design/atom-2026-09.md` §4 「CLI」一行)──

  /*
   * 四只转发口,加起来做**两件事**:铸主体、把调用交给 `backend.resources`,
   * 然后按 RPC 域那三只 `serialize*` 投一次影。
   *
   * ## 主体:缺省 `localUserPrincipal()`,可由调用方顶掉(K4-c)
   *
   * CLI 是**本机进程** —— 它拿的是 `<store>/run/daemon.sock`(0600)上的一条连接,
   * 能连上就已经是这台机器上的那个人。这与 `rpc/principal.ts` 第一条判据
   * (`isHostLocallyTrusted()` → `localUserPrincipal()`)说的是同一句话,只是
   * daemon 走的不是 HTTP 面、没有 `RpcDispatchContext` 可问,所以不复用那只函数
   * (复用它得先给它编一个假 context —— 那是把「谁在做」变成一次伪造练习)。
   *
   * **那条理由对 MCP 出口不成立**(K4-c,`onething mcp`):连 socket 的仍然是这台
   * 机器上的人,下指令的却是外面那个 agent。所以读 / 做的最后一格是可选的
   * `principal`,由调用方顶掉缺省值;`apps/cli/src/daemon-server.ts` 的
   * `readOptionalSystemPrincipal` 只让它是 `system` 一支,`user` / `agent` 当场拒 ——
   * 判据放在被调用的那一侧,改一行桥绕不过去。
   *
   * ## 投影复用 RPC 域那三只
   *
   * §4 那张表要求每个出口都是**同一份自述的投影**。两份手抄的投影早晚在某一格上
   * 分岔,而没有任何一道门会红 —— 所以这里 import 的是 `rpc/domains/resources.ts`
   * 导出的同一批函数,不是抄一份。
   *
   * ## 发起坐标缺席
   *
   * `sessionId` 是**发起坐标**,不是操作对象。`onething resource do session:<id> rename`
   * 不是从任何一条会话里发起的,拿 ref 里那条顶上就是 K1 留账那个病(审计读成
   * 「A 自己改了自己」)。`--session` 给了才带 —— 那是「我这次是替某条会话做的」。
   */

  listResources(): ListResourcesResponse {
    return {
      schemes: this.ownedBackend.resources.registry
        .list()
        .map(spec => ({ scheme: spec.scheme, title: spec.title })),
    }
  }

  describeResource(scheme: string): SerializedResourceSpec {
    const spec = this.ownedBackend.resources.registry.get(scheme)
    // 抛而不是回 null,与 RPC 域逐字同一条:「没有这种资源」与「有,但它什么都
    // 不能做」是两件事,后者是一份空表。NDJSON 那一层把它折成 `{type:'error'}`。
    if (!spec) throw new Error(`No resource is registered for scheme: ${scheme}`)
    return serializeSpec(spec)
  }

  async readResource(
    ref: string,
    name: string,
    query: Record<string, unknown> = {},
    sessionId?: string,
    principal: Principal = localUserPrincipal(),
  ): Promise<ResourceReadView> {
    const outcome = await this.ownedBackend.resources.read(ref, name, query, {
      principal,
      ...(sessionId ? { sessionId } : {}),
    })
    return serializeReadOutcome(outcome)
  }

  async doResource(
    ref: string,
    op: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    principal: Principal = localUserPrincipal(),
  ): Promise<ResourceOutcomeView> {
    const outcome = await this.ownedBackend.resources.do(ref, op, params, {
      principal,
      ...(sessionId ? { sessionId } : {}),
    })
    return serializeOutcome(outcome)
  }

  // ── Collab (multi-agent rooms) — docs/design/multi-agent-collab.md ──

  collabRoomNew(input: {
    name: string
    memberAgentIds: string[]
    pmAgentId?: string
    workingDirectory?: string
    permissionMode?: PermissionMode
    dailyCostUSD?: number
  }): ChatSession {
    // 建房的规则书只有一本(app/collab/room-create.ts)。daemon 这一口从前抄了
    // 一份删节版 —— 少了退休拒收,于是 CLI 能建出一间桌面端改都改不动的房。
    const created = ensureCollabGroupRoom(input.name || 'Room', {
      memberAgentIds: input.memberAgentIds ?? [],
      pmAgentId: input.pmAgentId,
      budgets: { dailyCostUSD: input.dailyCostUSD },
    }, { sessionId: randomUUID() })
    if (!created.success || !created.session) {
      throw new Error(created.error || 'Failed to create room')
    }
    const session = created.session
    if (input.workingDirectory) updateSessionWorkingDirectory(session.id, input.workingDirectory)
    if (input.permissionMode) updateSessionPermissionMode(session.id, input.permissionMode)
    return getSession(session.id) ?? session
  }

  collabRoomList(): Array<{ id: string; name: string; memberAgentIds: string[]; pmAgentId?: string; frozen?: boolean }> {
    return (getSessionsList() as Array<ChatSession & { kind?: string }>)
      .filter(meta => meta.kind === 'room')
      .map(meta => ({
        id: meta.id,
        name: meta.name,
        memberAgentIds: meta.room?.memberAgentIds ?? [],
        pmAgentId: meta.room?.pmAgentId,
        frozen: meta.room?.frozen,
      }))
  }

  async collabSend(roomSessionId: string, content: string): Promise<{ ok: true }> {
    const session = getSession(roomSessionId)
    if (session?.kind !== 'room') throw new Error(`Not a room session: ${roomSessionId}`)
    await getEventBus().emit(roomSessionId, {
      type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
      content,
      source: 'text',
    } as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
    return { ok: true }
  }

  async collabBoard(roomSessionId: string): Promise<unknown> {
    const { loadCollabBoard } = await import('../collab/board-store.js')
    return loadCollabBoard(roomSessionId)
  }

  /** 预算 patch 直接吃 shared 的那一份类型 —— 本地再抄一遍就是漂移的起点。 */
  async collabSetBudgets(
    roomSessionId: string,
    budgets: CollabRoomBudgetsPatch,
  ): Promise<{ ok: boolean }> {
    const { setCollabRoomBudgets } = await import('../collab/index.js')
    return { ok: setCollabRoomBudgets(roomSessionId, budgets) }
  }

  /**
   * Team settings over the daemon (W6): same app-layer path as the IPC.
   *
   * 整体透传,与 IPC 那一口同一条纪律。手抄版在这里少了三个字段(响应模式三件套),
   * 于是「同一个 app 层函数」在两条路上其实收到的是两种 patch。
   */
  async collabRoomUpdate(
    input: CollabRoomUpdatePatch & { roomSessionId: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const { setCollabRoomConfig } = await import('../collab/index.js')
    const { roomSessionId, ...patch } = input
    const result = setCollabRoomConfig(roomSessionId, patch)
    if (!result.success) throw new Error(result.error || 'Failed to update room')
    return { ok: true }
  }

  collabTranscript(roomSessionId: string, limit = 30): Array<{ role: string; agentId?: string; content: string }> {
    const session = getSession(roomSessionId)
    if (session?.kind !== 'room') throw new Error(`Not a room session: ${roomSessionId}`)
    return sessionReads.listMessages(roomSessionId).messages
      .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
      .slice(-limit)
      .map(message => ({
        role: message.role,
        ...(message.agentId ? { agentId: message.agentId } : {}),
        content: message.content,
      }))
  }

  sessionCwd(sessionId: string | undefined, cwd?: string | null): string | undefined {
    const resolved = this.resolveSessionId(sessionId)
    if (cwd !== undefined) {
      updateSessionWorkingDirectory(resolved, cwd)
    }
    return getSession(resolved)?.workingDirectory
  }

  sessionModel(sessionId: string | undefined, provider: string, model: string): void {
    updateSessionModel(this.resolveSessionId(sessionId), provider, model)
  }

  listProviders(): ProviderSummary[] {
    return listOnethingHeadlessProviderSummaries(getSettings())
  }

  updateProvider(providerId: string, update: Partial<{ enabled: boolean; apiKey: string; baseUrl: string; model: string; selectedModels: string[] }>): ProviderSummary {
    const settings = getSettings()
    const summary = upsertOnethingHeadlessProviderConfig(
      settings,
      providerId,
      update,
      () => ({
        ...createDefaultSettings().ai.providers.custom,
        model: update.model || '',
        selectedModels: [],
      }),
    )
    saveSettings(settings)
    return summary
  }

  useProvider(providerId: string, model?: string): ProviderSummary {
    const settings = getSettings()
    const summary = useOnethingHeadlessProvider(settings, providerId, model)
    saveSettings(settings)
    return summary
  }

  providerModels(providerId: string): string[] {
    return listOnethingHeadlessProviderModels(getSettings(), providerId)
  }

  listTools(): ToolSummary[] {
    // "有哪些工具"由目录回答(设计文档 §10.2-④)。呈现一个字不改 ——
    // `listOnethingHeadlessToolSummaries` 是同一个投影,换的只是入参的来源。
    return listOnethingHeadlessToolSummaries(toolkitCatalogToolDefinitions() ?? [])
  }

  setTool(toolId: string, update: { enabled?: boolean; autoExecute?: boolean }): void {
    const settings = getSettings()
    updateOnethingHeadlessToolSetting(settings, toolId, update)
    saveSettings(settings)
  }

  setPermissionMode(mode: PermissionMode): AppSettings {
    const settings = getSettings()
    setOnethingHeadlessPermissionMode(settings, mode)
    saveSettings(settings)
    return settings
  }

  private resolveSessionId(sessionId?: string): string {
    if (sessionId && getSession(sessionId)) return sessionId
    const current = getCurrentSessionId()
    if (current && getSession(current)) return current
    return this.newSession().id
  }

  private startPermissionTimeout(stream: ActiveStreamRecord, requestId: string): void {
    if (stream.permissionTimers.has(requestId)) return
    const timer = setTimeout(() => {
      stream.permissionTimers.delete(requestId)
      this.respondToPermission(stream.sessionId, requestId, 'reject')
    }, 60_000)
    timer.unref?.()
    stream.permissionTimers.set(requestId, timer)
  }

  private cleanupStream(streamId: string): void {
    const stream = this.activeStreams.get(streamId)
    if (!stream) return
    for (const timer of stream.permissionTimers.values()) clearTimeout(timer)
    for (const unsub of stream.unsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // Best effort cleanup.
      }
    }
    this.activeStreams.delete(streamId)
    if (this.activeStreamBySession.get(stream.sessionId) === streamId) {
      this.activeStreamBySession.delete(stream.sessionId)
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
