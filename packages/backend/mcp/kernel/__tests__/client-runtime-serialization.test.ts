import { describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig, MCPToolCallResult } from '@shared/mcp/types.js'

const pendingResolvers: Array<(result: MCPToolCallResult) => void> = []
const callLog: string[] = []

vi.mock('../mcp-kernel-client-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mcp-kernel-client-state.js')>()
  return {
    ...original,
    runMCPConnectedClientOperation: (_client: unknown, operation: (client: unknown) => Promise<unknown>) =>
      operation({}),
    callMCPToolWithTimeout: (_client: unknown, toolName: string) => {
      callLog.push(`start:${toolName}`)
      return new Promise<MCPToolCallResult>(resolve => {
        pendingResolvers.push(result => {
          callLog.push(`end:${toolName}`)
          resolve(result)
        })
      })
    },
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

describe('CoreMCPClientRuntime tool call serialization', () => {
  it('runs same-server tool calls one at a time, in order', async () => {
    const runtime = createRuntime()

    const first = runtime.callTool('tool-a', {})
    const second = runtime.callTool('tool-b', {})
    await settled()

    // Second call must not start while the first is in flight.
    expect(callLog).toEqual(['start:tool-a'])

    pendingResolvers.shift()?.({ success: true, content: [] })
    await first
    await settled()

    expect(callLog).toEqual(['start:tool-a', 'end:tool-a', 'start:tool-b'])

    pendingResolvers.shift()?.({ success: true, content: [] })
    await second
    expect(callLog).toEqual(['start:tool-a', 'end:tool-a', 'start:tool-b', 'end:tool-b'])
  })

  it('a failed call does not block the next queued call', async () => {
    const runtime = createRuntime()
    callLog.length = 0
    pendingResolvers.length = 0

    const first = runtime.callTool('tool-a', {})
    const second = runtime.callTool('tool-b', {})
    await settled()

    pendingResolvers.shift()?.({ success: false, error: 'boom' })
    await expect(first).resolves.toMatchObject({ success: false })
    await settled()

    expect(callLog).toContain('start:tool-b')
    pendingResolvers.shift()?.({ success: true, content: [] })
    await expect(second).resolves.toMatchObject({ success: true })
  })
})
