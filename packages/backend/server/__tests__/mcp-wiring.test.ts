/**
 * The engine's MCP bridge is hard-bound to the @onething/backend singleton manager.
 * The HTTP layer therefore MUST operate on that same instance for the default
 * owner — a server-local manager connects servers the model never sees, and
 * nothing about that failure is visible: the UI shows "connected", the tool
 * list populates, and only the model comes up empty.
 *
 * This pins the invariant, not the implementation: add a server through the
 * runtime facade and assert the app singleton (what the engine reads) sees it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, StreamChannel } from '@onething/core'
import { MCPManager as appMCPManager } from '@onething/runtime/mcp/index.wiring'
import {
  createMCPServerState,
  markMCPServerConnected,
  type MCPClientLike,
  type MCPServerConfig,
  type MCPServerState,
} from '@onething/core/mcp'
import { createDevelopmentOnethingServerRuntime, type OnethingServerRuntime } from '../runtime.js'

function createStubMCPClient(config: MCPServerConfig): MCPClientLike {
  let state: MCPServerState = createMCPServerState(config)
  return {
    get state() { return state },
    get status() { return state.status },
    async connect() {
      state = markMCPServerConnected({
        ...state,
        tools: [{ name: 'stub_tool', serverId: config.id, inputSchema: { type: 'object' } }],
      })
    },
    async disconnect() { state = { ...state, status: 'disconnected', tools: [] } },
    async updateConfig(next) { state = { ...state, config: next } },
    async callTool() { return { success: true } },
    async readResource() { return { success: true } },
    async getPrompt() { return { success: true } },
    async refreshCapabilities() {},
  }
}

describe('server MCP wiring', () => {
  let runtime: OnethingServerRuntime | undefined
  let storePath: string | undefined
  let previousStorePath: string | undefined

  afterEach(async () => {
    await runtime?.shutdown()
    runtime = undefined
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
    previousStorePath = undefined
    if (storePath) rmSync(storePath, { recursive: true, force: true })
    storePath = undefined
  })

  it('routes the default owner through the app singleton the engine reads', async () => {
    storePath = mkdtempSync(join(tmpdir(), 'onething-mcp-wiring-'))
    // The @onething/backend path layer resolves its root from this env var, not
    // from the runtime's storePath option. Without pinning it the app-layer
    // side effects of this test (notably the generated tools catalog) land in
    // the developer's real ~/.onething.
    previousStorePath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storePath

    runtime = await createDevelopmentOnethingServerRuntime({
      storePath,
      // persistsMessages: true is what selects the app-subsystem path.
      createBackend: async () => ({
        eventBus: new EventBus() as never,
        streamChannel: new StreamChannel() as never,
        persistsMessages: true,
        abortSession() {},
        async shutdown() {},
      }),
      enableMCPConnections: true,
      mcpClientFactory: createStubMCPClient,
    })

    const added = await runtime.runtime.mcp?.addServer({
      id: 'wiring-1',
      name: 'Wiring',
      transport: 'stdio',
      enabled: true,
      command: 'node',
    })
    expect(added?.success).toBe(true)

    // The assertion that matters: the singleton the engine's bridge reads has
    // the tool. Asserting via the HTTP facade instead would have passed even
    // while the model saw nothing.
    expect(appMCPManager.getAllTools().map(tool => tool.name)).toContain('stub_tool')
  })
})
