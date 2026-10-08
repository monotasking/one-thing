import { describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig, MCPToolCallResult } from '@shared/mcp/types.js'

const pendingResolvers: Array<(result: MCPToolCallResult) => void> = []

vi.mock('../mcp-kernel-client-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mcp-kernel-client-state.js')>()
  return {
    ...original,
    runMCPConnectedClientOperation: (_client: unknown, operation: (client: unknown) => Promise<unknown>) =>
      operation({}),
    callMCPToolWithTimeout: () =>
      new Promise<MCPToolCallResult>(resolve => { pendingResolvers.push(resolve) }),
  }
})

import { CoreMCPClientRuntime } from '../mcp-kernel-client-runtime.js'

function createRuntime() {
  const config: MCPServerConfig = {
    id: 'server-1',
    name: 'Server 1',
    transport: 'stdio',
    command: 'noop',
    enabled: true,
  } as MCPServerConfig
  return new CoreMCPClientRuntime({
    config,
    adapters: {
      createClient: () => ({}),
      createTransport: () => ({}),
    } as never,
  })
}

async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('CoreMCPClientRuntime in-flight call', () => {
  it('exposes the running call with its caller while it runs, and clears it afterwards', async () => {
    const runtime = createRuntime()
    expect(runtime.inFlightCall).toBeNull()

    const caller = { sessionId: 's1', messageId: 'm1', callId: 'c1', workingDirectory: '/w' }
    const call = runtime.callTool('get_app_state', { app: 'Calculator' }, { caller })
    await settled()

    expect(runtime.inFlightCall).toEqual({ toolName: 'get_app_state', args: { app: 'Calculator' }, caller })

    pendingResolvers.shift()?.({ success: true, content: [] })
    await call
    expect(runtime.inFlightCall).toBeNull()
  })

  it('clears the in-flight call when the call fails', async () => {
    const runtime = createRuntime()
    const call = runtime.callTool('boom', {})
    await settled()
    expect(runtime.inFlightCall).toEqual({ toolName: 'boom', args: {} })

    pendingResolvers.shift()?.({ success: false, error: 'nope' })
    await call
    expect(runtime.inFlightCall).toBeNull()
  })
})
