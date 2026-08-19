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
} from '@onething/runtime/headless'
import { createOnethingBackend } from '../backend.js'
import { flushAllPendingSaves } from '../store.js'
import {
  createSession,
  deleteSession,
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
} from '../store.js'
// 建房走 app 层那一本规则书。直接指到 room-create 而不是 collab 桶:这条口是
// 同步的,而桶会把协调器整棵树一起拉起来 —— 邻居们的 `await import` 就是为了
// 避开那件事。room-create 只依赖 store 与 agents,两者本来就已经在了。
import { ensureCollabGroupRoom } from '../collab/room-create.js'
import { getSettings } from '../stores/settings.js'
import { toolkitCatalogToolDefinitions } from '../toolkit/catalog-projection.js'
import { shutdownEventSystem, getEventBus, getStreamChannel } from '../events/index.js'
import { initializeSessionLayer, shutdownSessionLayer } from '../session/index.js'
import { sessionReads } from '../session/reads.js'
import { shutdownStreamEngine, getStreamEngine } from '../engine/index.js'
import { Permission } from '../permission/index.js'
import { MCPManager, registerMCPTools } from '../mcp/index.js'
import { ACPManager } from '../acp/index.js'
import { killTrackedDetachedChildren } from '../tools/core/bash-executor.js'
import { killAllTerminals } from '../terminal/service.js'
import { createDefaultSettings } from '@shared/defaults/settings.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'

type EmitStreamEvent = (event: DaemonStreamEvent) => void

class HeadlessSender extends EventEmitter {
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
  private sender = new HeadlessSender()
  private activeStreams = new Map<string, ActiveStreamRecord>()
  private activeStreamBySession = new Map<string, string>()

  async start(): Promise<void> {
    if (this.started) return

    await createOnethingBackend({
      sandboxHost: {
        getPath(name) {
          if (name === 'downloads') return path.join(os.homedir(), 'Downloads')
          if (name === 'home') return os.homedir()
          return os.homedir()
        },
      },
      toolRegistry: 'headless',
      sessionSkills: true,
      mcpAcp: true,
      // Multi-agent rooms work headless too: the sender below is bound, so
      // the coordinator's hasCommandTarget gate passes and drives flow.
      collab: true,
      sender: this.sender,
    })
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
    getStreamEngine().abortAll()
    await ACPManager.shutdown()
    await MCPManager.shutdown()
    killTrackedDetachedChildren()
    killAllTerminals() // always a no-op here — the daemon never creates terminals
    shutdownStreamEngine()
    Permission.shutdown()
    shutdownSessionLayer()
    shutdownEventSystem()
    try {
      await flushAllPendingSaves()
    } catch (error) {
      console.error('[Headless] flushAllPendingSaves error:', error)
    }
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

  deleteSession(sessionId: string): void {
    deleteSession(sessionId)
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
