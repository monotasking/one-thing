import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerState, MCPToolInfo } from '../types.js'

const mockMCPManager = vi.hoisted(() => ({
  enabled: true,
  tools: [] as MCPToolInfo[],
  states: new Map<string, MCPServerState>(),
  callTool: vi.fn(),
  settings: { enabled: true, servers: [], flatToolThreshold: 20 as number | undefined },
}))

vi.mock('../manager.js', () => ({
  MCPManager: {
    get isEnabled() {
      return mockMCPManager.enabled
    },
    getAllTools: () => mockMCPManager.tools,
    getServerState: (serverId: string) => mockMCPManager.states.get(serverId),
    getServerStates: () => Array.from(mockMCPManager.states.values()),
    callTool: (serverId: string, toolName: string, args: Record<string, unknown>) =>
      mockMCPManager.callTool(serverId, toolName, args),
    getSettings: () => mockMCPManager.settings,
  },
}))

import { executeMCPTool, getMCPToolsForAI, mcpToolToToolDefinition, parseMCPToolId } from '../bridge.js'

function addMockServer(serverId: string, name: string, tools: Array<Pick<MCPToolInfo, 'name' | 'inputSchema' | 'description'>>): void {
  const mcpTools = tools.map(tool => ({
    ...tool,
    serverId,
  }))

  mockMCPManager.tools.push(...mcpTools)
  mockMCPManager.states.set(serverId, {
    config: {
      id: serverId,
      name,
      transport: 'stdio',
      enabled: true,
    },
    status: 'connected',
    tools: mcpTools,
    resources: [],
    prompts: [],
  })
}

beforeEach(() => {
  mockMCPManager.enabled = true
  mockMCPManager.tools = []
  mockMCPManager.states.clear()
  mockMCPManager.callTool.mockReset()
  mockMCPManager.settings.flatToolThreshold = 20
})

describe('MCP bridge schema conversion', () => {
  it('preserves nested inputSchema on ToolDefinition', () => {
    const tool: MCPToolInfo = {
      serverId: 'server',
      name: 'nested',
      description: 'Nested MCP tool',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Nested items',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: 'Value text' },
              },
              required: ['value'],
            },
          },
        },
        required: ['items'],
      },
    }

    const definition = mcpToolToToolDefinition(tool)

    expect(definition.parameterSchema?.properties?.items).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Value text' },
        },
        required: ['value'],
      },
    })
  })

  it('exposes flat model-facing tool definitions at/below the threshold (决策点 #1)', () => {
    addMockServer('5be43c21-ddfb-4362-ac94-fe19b6fd0458', 'MCP_DOCKER', [
      {
        name: 'brave_web_search',
        description: 'Search with Brave',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ])

    const tools = getMCPToolsForAI(undefined, false)

    // Flat mode: the tool itself, under its sanitized id — no mcp_search.
    expect(Object.keys(tools)).toEqual(['mcp_MCP_DOCKER_brave_web_search'])
    expect(tools.mcp_MCP_DOCKER_brave_web_search.description).toBe('Search with Brave')
    expect(tools.mcp_MCP_DOCKER_brave_web_search.parameterSchema).toMatchObject({
      type: 'object',
      required: ['query'],
    })
  })

  it('falls back to the single router above the threshold (and at threshold 0)', () => {
    addMockServer('MCP_DOCKER', 'Docker', [
      {
        name: 'brave_web_search',
        description: 'Search with Brave',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ])
    mockMCPManager.settings.flatToolThreshold = 0

    const tools = getMCPToolsForAI(undefined, false)

    expect(Object.keys(tools)).toEqual(['mcp_search'])
    expect(JSON.stringify(tools.mcp_search)).not.toContain('brave_web_search')
    expect(tools.mcp_search.parameterSchema?.properties?.action).toMatchObject({
      enum: ['search', 'find', 'list', 'describe', 'call'],
    })
    expect(tools.mcp_search.parameterSchema?.required).toEqual(['action'])
  })

  it('searches, describes, and calls MCP tools through the router', async () => {
    const inputSchema = { type: 'object' as const }
    addMockServer('server-a', 'Search', [{ name: 'query', description: 'Search things', inputSchema }])
    mockMCPManager.callTool.mockResolvedValue({
      success: true,
      content: [{ type: 'text', text: 'ok' }],
    })
    const partials: Array<{ text: string; phase: string }> = []

    const listed = await executeMCPTool('mcp_search', { action: 'search', query: 'qey' }, {
      onPartialResult: (text, phase) => partials.push({ text, phase }),
    })
    const found = await executeMCPTool('mcp_search', { action: 'find', query: 'qey' })
    const described = await executeMCPTool('mcp_search', { action: 'describe', tool: 'query' })
    const called = await executeMCPTool('mcp_search', { action: 'call', tool: 'query', arguments: { q: 'x' } })

    expect(listed.content?.[0]?.text).toContain('query')
    expect(found.content?.[0]?.text).toContain('query')
    expect(partials.map(part => part.phase)).toEqual(['searching', 'ready'])
    expect(partials[1]?.text).toContain('query')
    expect(described.content?.[0]?.text).toContain('"type": "object"')
    expect(called.content?.[0]?.text).toBe('ok')
    expect(mockMCPManager.callTool).toHaveBeenCalledWith('server-a', 'query', { q: 'x' })
  })

  it('keeps the old router name executable for persisted calls', async () => {
    const inputSchema = { type: 'object' as const }
    addMockServer('server-a', 'Search', [{ name: 'query', description: 'Search things', inputSchema }])
    mockMCPManager.callTool.mockResolvedValue({
      success: true,
      content: [{ type: 'text', text: 'ok' }],
    })

    const called = await executeMCPTool('tool_function', { action: 'call', function: 'query', arguments: { q: 'x' } })

    expect(called.content?.[0]?.text).toBe('ok')
    expect(mockMCPManager.callTool).toHaveBeenCalledWith('server-a', 'query', { q: 'x' })
  })

  it('keeps old MCP tool IDs parseable for persisted calls', () => {
    addMockServer('server-a', 'Search', [{ name: 'query', inputSchema: { type: 'object' } }])
    getMCPToolsForAI(undefined, false)

    expect(parseMCPToolId('mcp_Search_query')).toEqual({
      serverId: 'server-a',
      toolName: 'query',
    })
  })
})
