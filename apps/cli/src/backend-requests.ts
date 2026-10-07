/**
 * CLI 的方法表:每个 `onething` 子命令用到的方法,各自落到后端的哪条(或哪两条)RPC(第④步批 3,
 * `docs/design/two-process-2026-10.md` §1.3 那张 38 个方法的对照表就是这只文件)。
 *
 * 从前这些方法是 unix socket 上的 NDJSON 请求,守护进程在自己进程里直接调各功能;现在 CLI 是后端的 HTTP 客户端,
 * 每一条都是 `POST /api/rpc` 上的一个域方法(`client.api(router)`),流式回答走 `GET /api/events`
 * (`backend-ask-stream.ts`)。三类不是一一对应的,写在各自那一格上:
 *  - **两步组合**:`session.new` = `sessions.create` + `sessions.switch`(从前守护进程建完就设为当前会话);
 *    `provider.*` / `tools.set` / `permission.mode.set` = `settings.getSettings` → 改一格 → `settings.saveSettings`
 *    (改哪一格的三只纯函数在 `cli-projections.ts`;HTTP 上读回来的设置是脱敏的,存回去时后端用盘上的真值补齐
 *    敏感键,所以「只改一格」不会把钥匙洗掉);`collab.roomNew` = `sessions.create(kind: 'room')` + 两条改格。
 *  - **「当前会话」**:没给 `--session` 时用 `appState.get` 的 `currentSessionId`,它不在了就新建一条
 *    (与守护进程的 `resolveSessionId` 同一条次序)。
 *  - **活流的坐标**:后端按会话记活流,`active.list` 的 `streamId` 就是会话 id(`active abort <id>` 照旧能用)。
 *
 * 资源那四支的主体:缺省是本机用户(HTTP 面按本机信任铸);`onething mcp` 那条桥递 `system` 主体时,这一发改用一只
 * 带 `X-Onething-Acting-System` 请求头的传输(只能降、不能升,判据在后端那一侧)。
 *
 * 交出:`createBackendRequester`(方法表本身)、`httpTransportFactory`(真 HTTP 传输,测试换成内存替身)。
 */
import { createHttpTransport, createOnethingClient, type OnethingClient, type Transport } from '@onething/backend-client'
import { ACTING_SYSTEM_HEADER } from '@shared/ipc/rpc.js'
import { appStateRouter } from '@shared/ipc/app-state.js'
import { chatRouter } from '@shared/ipc/chat.js'
import { collabRouter } from '@shared/ipc/collab.js'
import { resourcesRouter } from '@shared/ipc/resources.js'
import { sessionCommandRouter } from '@shared/ipc/session-command.js'
import { sessionsRouter } from '@shared/ipc/sessions.js'
import { settingsRouter } from '@shared/ipc/settings.js'
import { toolsRouter } from '@shared/ipc/tools.js'
import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import type { ChatSession, SessionMeta } from '@shared/ipc/chat.js'
import type { PermissionMode } from '@shared/ipc/tools.js'
import type { SessionCommand } from '@shared/events/index.js'
import {
  listCliProviderModels,
  listCliProviderSummaries,
  listCliSessionSummaries,
  listCliToolSummaries,
  setCliPermissionMode,
  updateCliToolSetting,
  upsertCliProviderConfig,
  useCliProvider,
} from './cli-projections.js'
import { runSessionTurn, type AskEventSink } from './backend-ask-stream.js'
import type { CliMethod, ResourceCallPrincipal } from './cli-protocol.js'
import type { LiveBackend } from './backend-connect.js'

export interface BackendRequester {
  request<TData = unknown>(method: CliMethod, params?: unknown, onEvent?: AskEventSink): Promise<TData>
  close(): void
}

/** 造一只传输;`actingSystem` 给了 = 这一只替那个系统组件发起。 */
export type TransportFactory = (actingSystem?: string) => Transport

/** 连真后端:发现文件里的地址与 token。 */
export function httpTransportFactory(backend: Pick<LiveBackend, 'baseUrl' | 'token'>): TransportFactory {
  return actingSystem => createHttpTransport({
    baseUrl: backend.baseUrl,
    ...(backend.token ? { token: backend.token } : {}),
    ...(actingSystem ? { headers: { [ACTING_SYSTEM_HEADER]: encodeURIComponent(actingSystem) } } : {}),
  })
}

type Params = Record<string, unknown> | undefined

/** 守护进程年代那句校验话,原样保留(调用方与测试读它)。 */
function required(params: Params, key: string): string {
  const value = params?.[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value
}

/** 多数会话 / 协作的应答是 `{ success, error? }`:失败就抛那一句。 */
function ok<T extends { success: boolean; error?: string }>(response: T, fallback: string): T {
  if (!response.success) throw new Error(response.error || fallback)
  return response
}

/** 建新会话时没给 provider 的那一份缺省(与后端 `createDefaultSettings().ai.providers.custom` 逐格相同)。 */
function defaultProviderConfig(model?: string) {
  return { apiKey: '', baseUrl: '', model: model || '', selectedModels: [] as string[], enabled: false }
}

export function createBackendRequester(createTransport: TransportFactory): BackendRequester {
  const clients = new Map<string, OnethingClient>()
  const clientFor = (actingSystem?: string): OnethingClient => {
    const key = actingSystem ?? ''
    let client = clients.get(key)
    if (!client) {
      client = createOnethingClient({ transport: createTransport(actingSystem) })
      clients.set(key, client)
    }
    return client
  }
  const api = clientFor()
  const sessions = api.api(sessionsRouter)
  const settings = api.api(settingsRouter)
  const commands = api.api(sessionCommandRouter)
  const collab = api.api(collabRouter)

  const emitCommand = (sessionId: string, command: Record<string, unknown>) =>
    commands.emit({ sessionId, command: command as unknown as SessionCommand })

  async function getSession(sessionId: string): Promise<ChatSession | undefined> {
    const response = await sessions.get({ sessionId })
    return response.success ? response.session : undefined
  }

  async function newSession(name = 'CLI Chat'): Promise<ChatSession> {
    const created = ok(await sessions.create({ name }), 'Failed to create session')
    const session = created.session!
    await sessions.switch({ sessionId: session.id })
    return session
  }

  /** 给了且在 → 它;否则当前会话;都没有 → 新建一条(与守护进程同一条次序)。 */
  async function resolveSessionId(sessionId?: unknown): Promise<string> {
    if (typeof sessionId === 'string' && sessionId && await getSession(sessionId)) return sessionId
    const current = (await api.api(appStateRouter).get({})).currentSessionId
    if (current && await getSession(current)) return current
    return (await newSession()).id
  }

  async function readSettings(): Promise<AppSettings> {
    return ok(await settings.getSettings({}), 'Failed to read settings').settings!
  }

  async function writeSettings(next: AppSettings): Promise<AppSettings> {
    return ok(await settings.saveSettings(next), 'Failed to save settings').settings ?? next
  }

  async function roomOf(roomSessionId: string): Promise<ChatSession> {
    const session = await getSession(roomSessionId)
    if ((session as { kind?: string } | undefined)?.kind !== 'room') throw new Error(`Not a room session: ${roomSessionId}`)
    return session!
  }

  /** 资源调用的那只客户端:给了 `system` 主体就换带请求头的那一只,别的主体当场拒(与守护进程年代同一句)。 */
  function resourcesFor(principal: unknown) {
    if (principal === undefined || principal === null) return api.api(resourcesRouter)
    const record = principal as Partial<ResourceCallPrincipal>
    if (record.kind !== 'system' || typeof record.component !== 'string' || !record.component.trim()) {
      throw new Error('principal must be { kind: "system", component: "<name>" } — this door does not mint user or agent principals')
    }
    return clientFor(record.component).api(resourcesRouter)
  }

  /** 一轮流式回答:专用传输接 SSE,发命令,折事件。 */
  function turn(sessionId: string, command: Record<string, unknown>, onEvent?: AskEventSink) {
    return runSessionTurn({
      transport: createTransport(),
      sessionId,
      send: () => emitCommand(sessionId, command),
      ...(onEvent ? { onEvent } : {}),
    })
  }

  const table: Record<CliMethod, (params: Params, onEvent?: AskEventSink) => Promise<unknown>> = {
    // ── 对话 ─────────────────────────────────────────────────────────────
    'chat.ask': async (params, onEvent) => {
      const prompt = typeof params?.prompt === 'string' ? params.prompt : ''
      if (!prompt.trim()) throw new Error('Prompt is required')
      const sessionId = await resolveSessionId(params?.sessionId)
      return turn(sessionId, { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, channel: 'cli', content: prompt, source: 'cli' }, onEvent)
    },
    'chat.retryLast': async (params, onEvent) => {
      const sessionId = required(params, 'sessionId')
      const messages = (await sessions.getMessages({ sessionId })).messages ?? []
      const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')
      if (!lastAssistant) throw new Error('No assistant message to retry')
      return turn(sessionId, { type: SESSION_COMMAND_TYPES.RETRY_MESSAGE, messageId: lastAssistant.id }, onEvent)
    },
    'permission.respond': async params => {
      const sessionId = required(params, 'sessionId')
      const response = await emitCommand(sessionId, {
        type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
        channel: 'cli',
        requestId: required(params, 'requestId'),
        decision: required(params, 'decision'),
      })
      return { ok: response.success }
    },
    'active.list': async () => {
      const response = await api.api(chatRouter).getActiveStreams({})
      return (response.sessionIds ?? []).map(sessionId => ({ streamId: sessionId, sessionId, status: 'running' }))
    },
    'active.abort': async params => ({
      aborted: (await api.api(chatRouter).abortStream({ sessionId: required(params, 'streamId') })).success,
    }),
    // ── 会话 ─────────────────────────────────────────────────────────────
    'session.list': async () => listCliSessionSummaries(ok(await sessions.list({}), 'Failed to list sessions').sessions ?? []),
    'session.new': async params => newSession(typeof params?.name === 'string' && params.name ? params.name : undefined),
    'session.use': async params => {
      const sessionId = required(params, 'sessionId')
      const switched = await sessions.switch({ sessionId })
      if (!switched.success || !switched.session) throw new Error(`Session not found: ${sessionId}`)
      return switched.session
    },
    'session.show': async params => {
      const sessionId = await resolveSessionId(params?.sessionId)
      const session = await getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      return session
    },
    'session.rename': async params => {
      ok(await sessions.rename({ sessionId: required(params, 'sessionId'), newName: required(params, 'name') }), 'Failed to rename session')
      return { ok: true }
    },
    'session.pin': async params => {
      ok(await sessions.updatePin({ sessionId: required(params, 'sessionId'), isPinned: Boolean(params?.pinned) }), 'Failed to pin session')
      return { ok: true }
    },
    'session.archive': async params => {
      const archived = Boolean(params?.archived)
      ok(await sessions.updateArchived({
        sessionId: required(params, 'sessionId'), isArchived: archived, archivedAt: archived ? Date.now() : null,
      }), 'Failed to archive session')
      return { ok: true }
    },
    'session.delete': async params => {
      ok(await sessions.delete({ sessionId: required(params, 'sessionId') }), 'Failed to delete session')
      return { ok: true }
    },
    'session.cwd': async params => {
      const sessionId = await resolveSessionId(params?.sessionId)
      if (params && Object.prototype.hasOwnProperty.call(params, 'cwd')) {
        const cwd = params.cwd
        ok(await sessions.updateWorkingDirectory({ sessionId, workingDirectory: typeof cwd === 'string' ? cwd : null }), 'Failed to set the working directory')
      }
      return { cwd: (await getSession(sessionId))?.workingDirectory }
    },
    'session.model': async params => {
      ok(await sessions.updateModel({
        sessionId: required(params, 'sessionId'), provider: required(params, 'provider'), model: required(params, 'model'),
      }), 'Failed to set the model')
      return { ok: true }
    },
    // ── 服务商、工具、权限模式(设置的两步组合)──────────────────────────
    'provider.list': async () => listCliProviderSummaries(await readSettings()),
    'provider.use': async params => {
      const current = await readSettings()
      const summary = useCliProvider(current, required(params, 'providerId'), typeof params?.model === 'string' ? params.model : undefined)
      await writeSettings(current)
      return summary
    },
    'provider.enable': async params => {
      const current = await readSettings()
      const summary = upsertCliProviderConfig(current, required(params, 'providerId'), { enabled: Boolean(params?.enabled) }, () => defaultProviderConfig() as never)
      await writeSettings(current)
      return summary
    },
    'provider.configure': async params => {
      const providerId = required(params, 'providerId')
      const { providerId: _id, ...update } = params as Record<string, unknown>
      const current = await readSettings()
      const summary = upsertCliProviderConfig(current, providerId, update, () => defaultProviderConfig(update.model as string | undefined) as never)
      await writeSettings(current)
      return summary
    },
    'provider.models': async params => listCliProviderModels(await readSettings(), required(params, 'providerId')),
    'tools.list': async () => listCliToolSummaries(ok(await api.api(toolsRouter).getTools({}), 'Failed to list tools').tools as never ?? []),
    'tools.set': async params => {
      const current = await readSettings()
      updateCliToolSetting(current, required(params, 'toolId'), {
        ...(typeof params?.enabled === 'boolean' ? { enabled: params.enabled } : {}),
        ...(typeof params?.autoExecute === 'boolean' ? { autoExecute: params.autoExecute } : {}),
      })
      await writeSettings(current)
      return { ok: true }
    },
    'permission.mode.set': async params => {
      const current = await readSettings()
      setCliPermissionMode(current, required(params, 'mode') as PermissionMode)
      return writeSettings(current)
    },
    // ── 协作房间 ─────────────────────────────────────────────────────────
    'collab.roomNew': async params => {
      const name = typeof params?.name === 'string' && params.name ? params.name : 'Room'
      const dailyCostUSD = typeof params?.dailyCostUSD === 'number' ? params.dailyCostUSD : undefined
      const created = ok(await sessions.create({
        name,
        kind: 'room',
        room: {
          memberAgentIds: Array.isArray(params?.memberAgentIds) ? params.memberAgentIds as string[] : [],
          ...(typeof params?.pmAgentId === 'string' ? { pmAgentId: params.pmAgentId } : {}),
          budgets: { ...(dailyCostUSD !== undefined ? { dailyCostUSD } : {}) },
        },
      }), 'Failed to create room')
      const session = created.session!
      if (typeof params?.workingDirectory === 'string') {
        ok(await sessions.updateWorkingDirectory({ sessionId: session.id, workingDirectory: params.workingDirectory }), 'Failed to set the working directory')
      }
      if (typeof params?.permissionMode === 'string') {
        ok(await sessions.updatePermissionMode({ sessionId: session.id, permissionMode: params.permissionMode as PermissionMode }), 'Failed to set the permission mode')
      }
      return (await getSession(session.id)) ?? session
    },
    'collab.roomList': async () => ((ok(await sessions.list({}), 'Failed to list sessions').sessions ?? []) as SessionMeta[])
      .filter(meta => meta.kind === 'room')
      .map(meta => ({
        id: meta.id,
        name: meta.name,
        memberAgentIds: meta.room?.memberAgentIds ?? [],
        pmAgentId: meta.room?.pmAgentId,
        frozen: (meta.room as { frozen?: boolean } | undefined)?.frozen,
      })),
    'collab.send': async params => {
      const roomSessionId = required(params, 'roomSessionId')
      await roomOf(roomSessionId)
      ok(await emitCommand(roomSessionId, { type: SESSION_COMMAND_TYPES.SEND_MESSAGE, content: required(params, 'content'), source: 'text' }), 'Failed to send')
      return { ok: true }
    },
    'collab.board': async params => ok(await collab.boardGet({ roomSessionId: required(params, 'roomSessionId') }), 'Failed to read the board').board,
    'collab.setBudgets': async params => {
      const { roomSessionId: _room, ...budgets } = params as Record<string, unknown>
      return { ok: (await collab.roomSetBudgets({ roomSessionId: required(params, 'roomSessionId'), ...budgets })).success }
    },
    'collab.roomUpdate': async params => {
      ok(await collab.roomUpdate({ ...(params as Record<string, unknown>), roomSessionId: required(params, 'roomSessionId') } as never), 'Failed to update room')
      return { ok: true }
    },
    'collab.transcript': async params => {
      const roomSessionId = required(params, 'roomSessionId')
      await roomOf(roomSessionId)
      const limit = typeof params?.limit === 'number' ? params.limit : 30
      return ((await sessions.getMessages({ sessionId: roomSessionId })).messages ?? [])
        .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
        .slice(-limit)
        .map(message => ({ role: message.role, ...(message.agentId ? { agentId: message.agentId } : {}), content: message.content }))
    },
    // ── 资源:读 / 做 / 看(四支通用方法,一个 scheme 名都没有)─────────────
    'resource.list': async () => api.api(resourcesRouter).list({}),
    'resource.describe': async params => api.api(resourcesRouter).describe({ scheme: required(params, 'scheme') }),
    'resource.read': async params => resourcesFor(params?.principal).read({
      ref: required(params, 'ref'),
      name: required(params, 'name'),
      query: (params?.query as Record<string, unknown> | undefined) ?? {},
      ...(typeof params?.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
    }),
    'resource.do': async params => resourcesFor(params?.principal).do({
      ref: required(params, 'ref'),
      op: required(params, 'op'),
      params: (params?.params as Record<string, unknown> | undefined) ?? {},
      ...(typeof params?.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
    }),
  }

  return {
    async request<TData>(method: CliMethod, params?: unknown, onEvent?: AskEventSink): Promise<TData> {
      const handler = table[method]
      if (!handler) throw new Error(`Unknown method: ${method}`)
      return await handler(params as Params, onEvent) as TData
    },
    close() {
      for (const client of clients.values()) client.close()
      clients.clear()
    },
  }
}
