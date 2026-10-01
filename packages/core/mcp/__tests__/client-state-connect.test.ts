import { describe, expect, it } from 'vitest'
import {
  connectMCPClientWithAdapters,
  createMCPServerState,
  disconnectMCPClientWithAdapters,
} from '../client-state.js'
import type { MCPServerConfig } from '@shared/mcp/types.js'

function stdioConfig(): MCPServerConfig {
  return {
    id: 'server-1',
    name: 'Server 1',
    transport: 'stdio',
    command: 'noop',
    enabled: true,
  }
}

function fakeAdapters(protocolVersion?: string) {
  return {
    createTransport: () => ({ fake: 'transport' }),
    createClient: () => ({ fake: 'client' }),
    connectClient: async () => {},
    refreshCapabilities: async () => ({ tools: [], resources: [], prompts: [] }),
    getNegotiatedProtocolVersion: () => protocolVersion,
    closeClient: async () => {},
    closeTransport: async () => {},
  }
}

describe('connectMCPClientWithAdapters protocol version', () => {
  it('records the negotiated protocol version into server state', async () => {
    const result = await connectMCPClientWithAdapters({
      state: createMCPServerState(stdioConfig()),
      client: null,
      transport: null,
      baseEnv: {},
      adapters: fakeAdapters('2026-07-28'),
    })

    expect(result.state.status).toBe('connected')
    expect(result.state.protocolVersion).toBe('2026-07-28')
  })

  it('falls back to the legacy revision a 2025-era server negotiated', async () => {
    const result = await connectMCPClientWithAdapters({
      state: createMCPServerState(stdioConfig()),
      client: null,
      transport: null,
      baseEnv: {},
      adapters: fakeAdapters('2025-11-25'),
    })

    expect(result.state.protocolVersion).toBe('2025-11-25')
  })

  it('clears the protocol version on disconnect', async () => {
    const adapters = fakeAdapters('2026-07-28')
    const connected = await connectMCPClientWithAdapters({
      state: createMCPServerState(stdioConfig()),
      client: null,
      transport: null,
      baseEnv: {},
      adapters,
    })

    const disconnected = await disconnectMCPClientWithAdapters({
      state: connected.state,
      client: connected.client,
      transport: connected.transport,
      adapters,
    })

    expect(disconnected.state.status).toBe('disconnected')
    expect(disconnected.state.protocolVersion).toBeUndefined()
  })
})
