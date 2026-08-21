import fs from 'node:fs'
import net from 'node:net'
import process from 'node:process'
import type { Socket } from 'node:net'
import type {
  DaemonEvent,
  DaemonRequest,
  DaemonResponse,
  DaemonStatus,
} from '@shared/cli/protocol.js'
import { StoreLock, LockConflictError, formatCliLockConflict } from '@shared/backend/store-lock.js'
import { getCliRuntimePaths, ensureRuntimeDirs, assertSupportedPlatform } from './paths.js'
import { NdjsonReader, encodeFrame } from './ndjson.js'
import { HeadlessBackend } from '@onething/backend/headless/backend.js'
import { configureLogging, getLogger, shutdownAppLogging } from '@onething/backend/logging/index.js'

interface DaemonServerOptions {
  storePath?: string
}

interface ClientRecord {
  id: string
  socket: Socket
}

export class DaemonServer {
  private readonly log = getLogger('daemon')
  private readonly paths
  private readonly backend = new HeadlessBackend()
  private readonly clients = new Map<Socket, ClientRecord>()
  private readonly startedAt = Date.now()
  private server: net.Server | null = null
  private lock: StoreLock | null = null
  private acceptingStreams = true

  constructor(private readonly options: DaemonServerOptions = {}) {
    this.paths = getCliRuntimePaths(options.storePath)
  }

  async start(): Promise<void> {
    assertSupportedPlatform()
    ensureRuntimeDirs(this.paths)
    removeStaleSocket(this.paths.socketPath)

    this.lock = new StoreLock({ storePath: this.paths.storePath })
    try {
      await this.lock.acquire('daemon')
    } catch (error) {
      if (error instanceof LockConflictError) {
        throw new Error(formatCliLockConflict(error.holder, this.paths.storePath))
      }
      throw error
    }

    fs.writeFileSync(this.paths.pidPath, `${process.pid}\n`)
    await this.backend.start()

    this.server = net.createServer(socket => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.paths.socketPath, () => {
        this.server!.off('error', reject)
        fs.chmodSync(this.paths.socketPath, 0o600)
        resolve()
      })
    })

    this.log.info('daemon listening', { socketPath: this.paths.socketPath, pid: process.pid })
  }

  async stop(reason = 'daemon shutdown'): Promise<void> {
    this.acceptingStreams = false
    for (const client of this.clients.values()) {
      client.socket.end()
    }
    await new Promise<void>(resolve => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    this.server = null
    await this.backend.shutdown(reason)
    this.lock?.release()
    this.lock = null
    safeUnlink(this.paths.socketPath)
    safeUnlink(this.paths.pidPath)
  }

  private handleConnection(socket: Socket): void {
    const client: ClientRecord = { id: randomClientId(), socket }
    this.clients.set(socket, client)

    const reader = new NdjsonReader<DaemonRequest>(
      request => this.handleRequest(client, request),
      error => this.write(socket, errorResponse('0', 'ERR_BAD_REQUEST', error.message)),
    )
    socket.on('data', chunk => reader.push(chunk))
    socket.on('end', () => reader.end())
    socket.on('close', () => this.clients.delete(socket))
    socket.on('error', () => this.clients.delete(socket))
  }

  private handleRequest(client: ClientRecord, request: DaemonRequest): void {
    void this.dispatch(client, request)
      .then(data => this.write(client.socket, { id: request.id, type: 'result', data }))
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof Error && error.name.startsWith('ERR_') ? error.name : 'ERR_BAD_REQUEST'
        this.write(client.socket, errorResponse(request.id, code, message))
      })
  }

  private async dispatch(client: ClientRecord, request: DaemonRequest): Promise<unknown> {
    switch (request.method) {
      case 'daemon.health':
        return { ok: true, pid: process.pid }
      case 'daemon.status':
        return this.status()
      case 'daemon.prepareRestart':
        return this.prepareRestart(Boolean((request.params as { force?: boolean } | undefined)?.force))
      case 'daemon.shutdown':
        setImmediate(() => void this.stop('daemon shutdown').then(() => process.exit(0)))
        return { ok: true }
      case 'chat.ask': {
        if (!this.acceptingStreams) throw namedError('ERR_DAEMON_RESTART', 'Daemon is restarting')
        const params = request.params as { prompt?: string; sessionId?: string; yes?: boolean } | undefined
        if (!params?.prompt?.trim()) throw namedError('ERR_VALIDATION', 'Prompt is required')
        return this.backend.ask(
          { prompt: params.prompt, sessionId: params.sessionId, yes: params.yes, source: 'cli' },
          client.id,
          event => this.write(client.socket, { id: request.id, type: 'event', event } satisfies DaemonEvent),
        )
      }
      case 'chat.retryLast': {
        const params = request.params as { sessionId?: string } | undefined
        if (!params?.sessionId) throw namedError('ERR_VALIDATION', 'sessionId is required')
        return this.backend.retryLast(
          params.sessionId,
          client.id,
          event => this.write(client.socket, { id: request.id, type: 'event', event } satisfies DaemonEvent),
        )
      }
      case 'permission.respond': {
        const params = request.params as { sessionId?: string; requestId?: string; decision?: 'once' | 'session' | 'workdir' | 'reject' } | undefined
        if (!params?.sessionId || !params.requestId || !params.decision) {
          throw namedError('ERR_VALIDATION', 'sessionId, requestId, and decision are required')
        }
        this.backend.respondToPermission(params.sessionId, params.requestId, params.decision)
        return { ok: true }
      }
      case 'active.list':
        return this.backend.getActiveStreams()
      case 'active.abort': {
        const params = request.params as { streamId?: string } | undefined
        if (!params?.streamId) throw namedError('ERR_VALIDATION', 'streamId is required')
        return { aborted: this.backend.abortStream(params.streamId) }
      }
      case 'session.list':
        return this.backend.listSessions()
      case 'session.new':
        return this.backend.newSession((request.params as { name?: string } | undefined)?.name)
      case 'session.use':
        return this.backend.useSession(requiredString(request.params, 'sessionId'))
      case 'session.show':
        return this.backend.showSession((request.params as { sessionId?: string } | undefined)?.sessionId)
      case 'session.rename':
        this.backend.renameSession(requiredString(request.params, 'sessionId'), requiredString(request.params, 'name'))
        return { ok: true }
      case 'session.pin':
        this.backend.pinSession(requiredString(request.params, 'sessionId'), Boolean((request.params as { pinned?: boolean }).pinned))
        return { ok: true }
      case 'session.archive':
        this.backend.archiveSession(requiredString(request.params, 'sessionId'), Boolean((request.params as { archived?: boolean }).archived))
        return { ok: true }
      case 'session.delete':
        this.backend.deleteSession(requiredString(request.params, 'sessionId'))
        return { ok: true }
      case 'session.cwd': {
        const params = request.params as { sessionId?: string; cwd?: string | null } | undefined
        return { cwd: this.backend.sessionCwd(params?.sessionId, Object.prototype.hasOwnProperty.call(params || {}, 'cwd') ? params?.cwd ?? null : undefined) }
      }
      case 'collab.roomNew':
        return this.backend.collabRoomNew(request.params as Parameters<typeof this.backend.collabRoomNew>[0])
      case 'collab.roomList':
        return this.backend.collabRoomList()
      case 'collab.send':
        return this.backend.collabSend(
          requiredString(request.params, 'roomSessionId'),
          requiredString(request.params, 'content'),
        )
      case 'collab.board':
        return this.backend.collabBoard(requiredString(request.params, 'roomSessionId'))
      case 'collab.setBudgets':
        return this.backend.collabSetBudgets(
          requiredString(request.params, 'roomSessionId'),
          request.params as { dailyCostUSD?: number; maxChain?: number },
        )
      case 'collab.roomUpdate':
        return this.backend.collabRoomUpdate({
          ...(request.params as Record<string, unknown>),
          roomSessionId: requiredString(request.params, 'roomSessionId'),
        } as Parameters<typeof this.backend.collabRoomUpdate>[0])
      case 'collab.transcript':
        return this.backend.collabTranscript(
          requiredString(request.params, 'roomSessionId'),
          (request.params as { limit?: number } | undefined)?.limit,
        )
      case 'session.model':
        this.backend.sessionModel(requiredString(request.params, 'sessionId'), requiredString(request.params, 'provider'), requiredString(request.params, 'model'))
        return { ok: true }
      case 'provider.list':
        return this.backend.listProviders()
      case 'provider.use':
        return this.backend.useProvider(requiredString(request.params, 'providerId'), (request.params as { model?: string }).model)
      case 'provider.enable':
        return this.backend.updateProvider(requiredString(request.params, 'providerId'), { enabled: Boolean((request.params as { enabled?: boolean }).enabled) })
      case 'provider.configure': {
        const params = request.params as { providerId?: string; apiKey?: string; baseUrl?: string; model?: string; selectedModels?: string[] } | undefined
        if (!params?.providerId) throw namedError('ERR_VALIDATION', 'providerId is required')
        return this.backend.updateProvider(params.providerId, params)
      }
      case 'provider.models':
        return this.backend.providerModels(requiredString(request.params, 'providerId'))
      case 'tools.list':
        return this.backend.listTools()
      case 'tools.set': {
        const params = request.params as { toolId?: string; enabled?: boolean; autoExecute?: boolean } | undefined
        if (!params?.toolId) throw namedError('ERR_VALIDATION', 'toolId is required')
        this.backend.setTool(params.toolId, params)
        return { ok: true }
      }
      case 'permission.mode.set':
        return this.backend.setPermissionMode(requiredString(request.params, 'mode') as never)
      default:
        throw namedError('ERR_METHOD_NOT_FOUND', `Unknown daemon method: ${request.method}`)
    }
  }

  private async prepareRestart(force: boolean): Promise<{ ok: true }> {
    const active = this.backend.getActiveStreams()
    if (active.length > 0 && !force) {
      throw namedError('ERR_VALIDATION', `Cannot restart: ${active.length} active stream(s). Use --force to interrupt them.`)
    }
    this.acceptingStreams = false
    if (force) {
      setImmediate(() => void this.stop('daemon restart').then(() => process.exit(0)))
      return { ok: true }
    }
    const deadline = Date.now() + 10_000
    while (this.backend.getActiveStreams().length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (this.backend.getActiveStreams().length > 0) {
      this.acceptingStreams = true
      throw namedError('ERR_TIMEOUT', 'Timed out waiting for active streams to finish')
    }
    setImmediate(() => void this.stop('daemon restart').then(() => process.exit(0)))
    return { ok: true }
  }

  private status(): DaemonStatus {
    return {
      pid: process.pid,
      storePath: this.paths.storePath,
      socketPath: this.paths.socketPath,
      logPath: this.paths.logPath,
      startedAt: this.startedAt,
      acceptingStreams: this.acceptingStreams,
      activeStreams: this.backend.getActiveStreams(),
      platform: 'unix-socket',
    }
  }

  private write(socket: Socket, frame: DaemonResponse | DaemonEvent): void {
    if (socket.destroyed) return
    socket.write(encodeFrame(frame))
  }
}

export function configureDaemonLogging(storePath?: string): ReturnType<typeof configureLogging> {
  return configureLogging({
    fileBaseName: 'daemon',
    src: 'daemon',
    // daemon 是**后台进程**:stdout/stderr 被 spawn 重定向到文件,再 pretty 回显
    // 一份就是同一条记录落两遍。它只写 `daemon.jsonl`。
    consoleEcho: false,
    ...(storePath ? { logDir: getCliRuntimePaths(storePath).logDir } : {}),
  })
}

export async function runDaemonServer(options: DaemonServerOptions = {}): Promise<void> {
  // 第一件事:接上日志(L2)。这之前的行只进内存环 —— 但这之前只有参数解析。
  // `configureLogging` 自带 `installProcessCrashHooks`,所以守护进程的
  // unhandledRejection / uncaughtException 从此有人听(P7)。
  configureDaemonLogging(options.storePath)
  const server = new DaemonServer(options)
  await server.start()
  const shutdown = (reason: string) => {
    void server.stop(reason)
      .finally(() => shutdownAppLogging())
      .finally(() => process.exit(0))
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

function errorResponse(id: string, code: string, message: string): DaemonResponse {
  return { id, type: 'error', error: { code, message } }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function requiredString(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | undefined)?.[key]
  if (typeof value !== 'string' || !value.trim()) throw namedError('ERR_VALIDATION', `${key} is required`)
  return value
}

function randomClientId(): string {
  return `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function removeStaleSocket(socketPath: string): void {
  if (!fs.existsSync(socketPath)) return
  try {
    const socket = net.connect(socketPath)
    socket.once('connect', () => socket.end())
    socket.once('error', () => safeUnlink(socketPath))
  } catch {
    safeUnlink(socketPath)
  }
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Best effort.
  }
}
