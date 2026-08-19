import type { JsonArray, JsonObject, JsonValue } from '../json.js'
import { toLogger } from '../logging/index.js'
import {
  callMCPToolWithTimeout,
  connectMCPClientWithAdapters,
  createMCPServerState,
  disconnectMCPClientWithAdapters,
  getMCPPromptMessages,
  markMCPServerError,
  readMCPResource,
  refreshMCPClientCapabilities,
  runMCPConnectedClientOperation,
  updateMCPClientConfigWithAdapters,
  type CoreMCPLogger,
  type CoreMCPClientOperations,
  type CoreMCPRefreshCapabilitiesResult,
  type UpdateMCPClientConfigAdapters,
} from './client-state.js'
import type {
  MCPConnectionStatus,
  MCPServerConfig,
  MCPServerState,
  MCPToolCallResult,
} from './types.js'

export interface CoreMCPClientRuntimeAdapters<TClient extends CoreMCPClientOperations, TTransport>
  extends UpdateMCPClientConfigAdapters<TClient, TTransport> {
  /**
   * Report that a live connection dropped on its own (process died, stream
   * closed, transport error). Core cannot detect this itself — only the host
   * knows the transport's shape — so it hands the host a callback to fire.
   *
   * Called at most once per connection; core rewires it on every reconnect.
   */
  observeDisconnect?(client: TClient, transport: TTransport, onDisconnect: () => void): void
}

/**
 * Backoff between automatic reconnect attempts, in ms. The last value repeats
 * until the attempt budget runs out.
 */
export const MCP_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const
export const MCP_RECONNECT_MAX_ATTEMPTS = 10

export interface CoreMCPClientRuntimeOptions<TClient extends CoreMCPClientOperations, TTransport> {
  config: MCPServerConfig
  adapters: CoreMCPClientRuntimeAdapters<TClient, TTransport>
  getBaseEnv?: () => Record<string, string | undefined>
  toolCallTimeoutMs?: number
  logger?: CoreMCPLogger
  /** Automatic reconnect after an unexpected drop. Default: on. */
  autoReconnect?: boolean
  /** Injected for tests; defaults to setTimeout. */
  scheduleReconnect?: (run: () => void, delayMs: number) => { cancel: () => void }
}

export class CoreMCPClientRuntime<TClient extends CoreMCPClientOperations, TTransport> {
  private client: TClient | null = null
  private transport: TTransport | null = null
  private _state: MCPServerState
  private readonly adapters: CoreMCPClientRuntimeAdapters<TClient, TTransport>
  private readonly getBaseEnv: () => Record<string, string | undefined>
  private readonly toolCallTimeoutMs: number
  /** Serializes tool calls against this server; see callTool. */
  private toolCallQueue: Promise<void> = Promise.resolve()
  private readonly autoReconnect: boolean
  private readonly scheduleReconnect: (run: () => void, delayMs: number) => { cancel: () => void }
  private pendingReconnect: { cancel: () => void } | null = null
  private reconnectAttempts = 0
  /** Set while an intentional disconnect is in flight, so it is not retried. */
  private closingIntentionally = false

  constructor(options: CoreMCPClientRuntimeOptions<TClient, TTransport>) {
    this._state = createMCPServerState(options.config)
    this.adapters = {
      ...options.adapters,
      logger: options.adapters.logger ?? options.logger,
      onStateChange: state => {
        this._state = state
        options.adapters.onStateChange?.(state)
      },
    }
    this.getBaseEnv = options.getBaseEnv ?? (() => ({}))
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 60000
    this.autoReconnect = options.autoReconnect ?? true
    this.scheduleReconnect = options.scheduleReconnect ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })
  }

  get state(): MCPServerState {
    return { ...this._state }
  }

  get id(): string {
    return this._state.config.id
  }

  get status(): MCPConnectionStatus {
    return this._state.status
  }

  get currentClient(): TClient | null {
    return this.client
  }

  get currentTransport(): TTransport | null {
    return this.transport
  }

  async connect(): Promise<void> {
    this.cancelPendingReconnect()
    const result = await connectMCPClientWithAdapters({
      state: this._state,
      client: this.client,
      transport: this.transport,
      baseEnv: this.getBaseEnv(),
      adapters: this.adapters,
    })
    this._state = result.state
    this.client = result.client
    this.transport = result.transport
    if (!result.alreadyConnected) {
      this.reconnectAttempts = 0
      this.watchForDisconnect()
    }
  }

  /**
   * Ask the host to tell us when this connection dies on its own.
   *
   * Without this a crashed stdio child (or a dropped SSE stream) left the
   * server sitting in `connected` forever: nothing polls it, so the tools stayed
   * in the catalog and every call failed until the user hit reconnect by hand.
   */
  private watchForDisconnect(): void {
    if (!this.autoReconnect || !this.client || !this.transport) return
    const client = this.client
    const transport = this.transport
    this.adapters.observeDisconnect?.(client, transport, () => {
      // Ignore a drop reported for a connection we already replaced or closed.
      if (this.closingIntentionally) return
      if (this.client !== client) return
      this.handleUnexpectedDisconnect()
    })
  }

  private handleUnexpectedDisconnect(): void {
    const logger = this.adapters.logger
    toLogger(logger).warn(`[MCP:${this.id}] Connection lost`)
    this.client = null
    this.transport = null
    this.adapters.onStateChange?.(markMCPServerError(this._state, 'Connection lost'))

    if (!this._state.config.enabled) return
    this.scheduleNextReconnect()
  }

  private scheduleNextReconnect(): void {
    if (!this.autoReconnect || this.pendingReconnect) return
    if (this.reconnectAttempts >= MCP_RECONNECT_MAX_ATTEMPTS) {
      toLogger(this.adapters.logger).error(
        `[MCP:${this.id}] Giving up after ${MCP_RECONNECT_MAX_ATTEMPTS} reconnect attempts`,
      )
      this.adapters.onStateChange?.(markMCPServerError(
        this._state,
        `Connection lost; ${MCP_RECONNECT_MAX_ATTEMPTS} reconnect attempts failed`,
      ))
      return
    }

    const delayMs = MCP_RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempts, MCP_RECONNECT_DELAYS_MS.length - 1)
    ]
    this.reconnectAttempts += 1
    toLogger(this.adapters.logger).debug(
      `[MCP:${this.id}] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts})`,
    )
    this.pendingReconnect = this.scheduleReconnect(() => {
      this.pendingReconnect = null
      if (!this._state.config.enabled) return
      void this.connect().catch(() => {
        // connect() already recorded the error on the state; keep backing off.
        this.scheduleNextReconnect()
      })
    }, delayMs)
  }

  private cancelPendingReconnect(): void {
    this.pendingReconnect?.cancel()
    this.pendingReconnect = null
  }

  async refreshCapabilities(): Promise<CoreMCPRefreshCapabilitiesResult> {
    if (!this.client) {
      throw new Error('Client not connected')
    }

    const capabilities = await refreshMCPClientCapabilities(
      this.id,
      this.client,
      this.adapters.logger,
    )
    const nextState = {
      ...this._state,
      tools: capabilities.tools,
      resources: capabilities.resources,
      prompts: capabilities.prompts,
    }
    this._state = nextState
    // Go through onStateChange like connect/disconnect do. Mutating _state
    // directly left every state observer on the pre-refresh capability list.
    this.adapters.onStateChange?.(nextState)
    return capabilities
  }

  async callTool(
    toolName: string,
    args: JsonObject,
    options: { timeoutMs?: number } = {},
  ): Promise<MCPToolCallResult> {
    // Tool calls against the same server run one at a time: the agent loop
    // executes tools concurrently, and stdio transports / stateful servers may
    // not tolerate interleaved requests. Different servers (separate runtime
    // instances) still run in parallel. Read paths (readResource/getPrompt)
    // stay unqueued. The per-call timeout starts when the call actually runs,
    // not while it waits in the queue.
    const result = this.toolCallQueue.then(() => this.callToolNow(toolName, args, options))
    this.toolCallQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async callToolNow(
    toolName: string,
    args: JsonObject,
    options: { timeoutMs?: number } = {},
  ): Promise<MCPToolCallResult> {
    const timeoutMs = options.timeoutMs ?? this.toolCallTimeoutMs
    const logger = this.adapters.logger

    return runMCPConnectedClientOperation(this.client, async client => {
      toLogger(logger).debug(`[MCP:${this.id}] Calling tool: ${toolName}`, args)
      // P2-5: hand the SDK our cached definition so a 2026-07-28 Streamable
      // HTTP connection mirrors the spec-required Mcp-Method/Mcp-Name
      // (Mcp-Param-*) headers; legacy connections ignore it.
      const known = this._state.tools.find(tool => tool.name === toolName)
      const result = await callMCPToolWithTimeout(
        client,
        toolName,
        args,
        timeoutMs,
        known
          ? { name: known.name, description: known.description, inputSchema: known.inputSchema }
          : undefined,
        {
          // P3-1: surface task progress in the logs; the poll budget keeps
          // its own default (10 min) independent of the per-call timeout.
          onTaskStatus: (task, pollIndex) => {
            toLogger(logger).debug(`[MCP:${this.id}] Task ${task.taskId} poll #${pollIndex}: ${task.status}${task.statusMessage ? ` — ${task.statusMessage}` : ''}`)
          },
        },
      )
      toLogger(logger).debug(`[MCP:${this.id}] Tool result:`, undefined, result)
      if (!result.success) {
        toLogger(logger).error(`[MCP:${this.id}] Tool call failed:`, undefined, result.error)
      }
      return result
    })
  }

  async readResource(uri: string): Promise<{ success: boolean; content?: JsonValue; error?: string }> {
    return runMCPConnectedClientOperation(this.client, client => readMCPResource(client, uri))
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ success: boolean; messages?: JsonArray; error?: string }> {
    return runMCPConnectedClientOperation(this.client, client => getMCPPromptMessages(client, name, args))
  }

  async disconnect(): Promise<void> {
    // An intentional close must not look like a drop, or we would immediately
    // reconnect a server the user just turned off.
    this.cancelPendingReconnect()
    this.reconnectAttempts = 0
    this.closingIntentionally = true
    try {
      const result = await disconnectMCPClientWithAdapters({
        state: this._state,
        client: this.client,
        transport: this.transport,
        adapters: this.adapters,
      })
      this._state = result.state
      this.client = result.client
      this.transport = result.transport
    } finally {
      this.closingIntentionally = false
    }
  }

  async updateConfig(config: MCPServerConfig): Promise<void> {
    this.cancelPendingReconnect()
    this.reconnectAttempts = 0
    this.closingIntentionally = true
    try {
      const result = await updateMCPClientConfigWithAdapters({
        state: this._state,
        client: this.client,
        transport: this.transport,
        config,
        baseEnv: this.getBaseEnv(),
        adapters: this.adapters,
      })
      this._state = result.state
      this.client = result.client
      this.transport = result.transport
    } finally {
      this.closingIntentionally = false
    }

    // updateConfig reconnects through the shared helper rather than our
    // connect(), so the drop watcher has to be rearmed here too.
    if (this._state.status === 'connected') {
      this.watchForDisconnect()
    }
  }
}
