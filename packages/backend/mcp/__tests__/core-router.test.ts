import { describe, expect, it } from 'vitest'
import {
  buildMCPToolsCatalog,
  buildMCPToolsForAI,
  describeMCPFunction,
  executeMCPBridgeTool,
  findMCPFunctionRef,
  getMCPFunctionRefs,
  getMCPRouterDefinition,
  listMCPFunctions,
  mcpContentToString,
  planMCPToolRegistration,
  planMCPToolsCatalogWrite,
  resolveMCPToolExposure,
  resolveMCPRouterAction,
} from '@onething/core/mcp'
import {
  mcpRouterToCoreToolDefinition,
  mcpToolToCoreToolDefinition,
  normalizeMCPContent,
  planMCPInputSchemaValidation,
} from '@onething/core/mcp'
import type { MCPToolInfo } from '@onething/core/mcp'

const tools: MCPToolInfo[] = [
  {
    serverId: 'context7-server',
    name: 'resolve-library-id',
    description: 'Resolve a package name to a Context7 library id.',
    inputSchema: {
      type: 'object',
      required: ['libraryName'],
      properties: {
        libraryName: {
          type: 'string',
          description: 'Package name to resolve.',
        },
      },
    },
  },
  {
    serverId: 'fetch-server',
    name: 'fetch',
    description: 'Fetch a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch.',
        },
      },
    },
  },
]

const serverName = (serverId: string): string | undefined => ({
  'context7-server': 'context7',
  'fetch-server': 'fetch',
})[serverId]

describe('core MCP router helpers', () => {
  it('builds searchable refs and resolves exact function names', () => {
    const refs = getMCPFunctionRefs(tools, serverName)

    expect(refs.map(ref => ref.id)).toEqual(['resolve-library-id', 'fetch'])
    expect(findMCPFunctionRef(refs, { function: 'fetch' })?.serverId).toBe('fetch-server')
  })

  it('lists, searches, and describes tools', () => {
    const refs = getMCPFunctionRefs(tools, serverName)

    expect(listMCPFunctions(refs, 'context')).toContain('resolve-library-id')
    expect(describeMCPFunction(refs[0])).toContain('Input schema:')
  })

  it('builds provider-facing router schema and catalog markdown', () => {
    const router = getMCPRouterDefinition()
    const catalog = buildMCPToolsCatalog(tools, {
      generatedAt: '2026-06-25T00:00:00.000Z',
      getServerName: serverName,
    })

    expect(router.parameterSchema?.required).toEqual(['action'])
    expect(catalog).toContain('# MCP Tools Catalog')
    expect(catalog).toContain('## Server: context7 (context7-server)')
    expect(catalog).toContain('| libraryName | string |')
  })

  it('plans MCP input schema validation without Zod in core', () => {
    expect(planMCPInputSchemaValidation({
      required: ['query', 'options'],
      properties: {
        query: {
          type: 'string',
          description: 'Search query.',
          enum: ['vue', 'react'],
        },
        limit: {
          type: 'integer',
        },
        options: {
          type: 'object',
          required: ['includeArchived'],
          properties: {
            includeArchived: { type: 'boolean' },
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    })).toEqual({
      query: {
        kind: 'string',
        description: 'Search query.',
        required: true,
        enumValues: ['vue', 'react'],
      },
      limit: {
        kind: 'number',
        description: undefined,
        required: false,
      },
      options: {
        kind: 'object',
        description: undefined,
        required: true,
        properties: {
          includeArchived: {
            kind: 'boolean',
            description: undefined,
            required: true,
          },
          tags: {
            kind: 'array',
            description: undefined,
            required: false,
            items: {
              kind: 'string',
              description: undefined,
              required: true,
              enumValues: undefined,
            },
          },
        },
      },
    })
  })

  it('plans MCP tools catalog writes in core', () => {
    expect(planMCPToolsCatalogWrite({
      enabled: false,
      mcpTools: tools,
    })).toEqual({
      action: 'skip',
      generated: false,
      reason: 'mcp-disabled',
      toolCount: 2,
    })

    expect(planMCPToolsCatalogWrite({
      enabled: true,
      mcpTools: [],
    })).toEqual({
      action: 'skip',
      generated: false,
      reason: 'no-tools',
      toolCount: 0,
    })

    const plan = planMCPToolsCatalogWrite({
      enabled: true,
      mcpTools: tools,
      generatedAt: '2026-06-25T00:00:00.000Z',
      getServerName: serverName,
    })

    expect(plan).toMatchObject({
      action: 'write',
      generated: true,
      toolCount: 2,
    })
    expect(plan.action === 'write' ? plan.content : '').toContain('## Server: context7 (context7-server)')
  })

  it('plans MCP tool registration side effects in core', () => {
    expect(planMCPToolRegistration({
      enabled: false,
      mcpTools: tools,
      existingTools: [
        { id: 'read' },
        { id: 'mcp:server:old-tool' },
        { id: 'mcp_search' },
      ],
    })).toEqual({
      toolIdsToUnregister: ['mcp:server:old-tool'],
      shouldGenerateCatalog: false,
      shouldExposeRouter: false,
      mode: 'none',
      toolCount: 2,
    })

    // 2 tools ≤ default threshold 20 → flat mode: no router, no catalog.
    expect(planMCPToolRegistration({
      enabled: true,
      mcpTools: tools,
      existingTools: [
        { id: 'mcp:server:old-tool' },
        { id: 'mcp_new_style_tool' },
      ],
    })).toEqual({
      toolIdsToUnregister: ['mcp:server:old-tool'],
      shouldGenerateCatalog: false,
      shouldExposeRouter: false,
      mode: 'flat',
      toolCount: 2,
      logMessage: '[MCPBridge] MCP flat exposure (2 tools, threshold not exceeded)',
    })

    // Threshold 0 pins the pre-hybrid router behavior (catalog included).
    expect(planMCPToolRegistration({
      enabled: true,
      mcpTools: tools,
      existingTools: [{ id: 'mcp:server:old-tool' }],
      flatThreshold: 0,
    })).toEqual({
      toolIdsToUnregister: ['mcp:server:old-tool'],
      shouldGenerateCatalog: true,
      shouldExposeRouter: true,
      mode: 'router',
      toolCount: 2,
      logMessage: '[MCPBridge] MCP router ready (2 functions)',
    })
  })

  it('resolves the hybrid exposure mode boundaries in core (决策点 #1)', () => {
    // Boundary: exactly AT the threshold stays flat; one over flips to router.
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 20, flatThreshold: 20 })).toEqual({ mode: 'flat' })
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 21, flatThreshold: 20 })).toEqual({ mode: 'router' })
    // Undefined threshold applies the default 20.
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 20 })).toEqual({ mode: 'flat' })
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 21 })).toEqual({ mode: 'router' })
    // 0 = always router.
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 1, flatThreshold: 0 })).toEqual({ mode: 'router' })
    // Off / empty stay none.
    expect(resolveMCPToolExposure({ enabled: false, toolCount: 5 })).toEqual({ mode: 'none', skipReason: 'mcp-disabled' })
    expect(resolveMCPToolExposure({ enabled: true, toolCount: 0 })).toEqual({ mode: 'none', skipReason: 'no-tools' })
  })

  it('plans provider-facing MCP router exposure in core', () => {
    expect(buildMCPToolsForAI({
      enabled: false,
      mcpTools: tools,
    })).toEqual({
      tools: {},
      shouldRememberTools: false,
      skipReason: 'mcp-disabled',
    })

    expect(buildMCPToolsForAI({
      enabled: true,
      mcpTools: [],
    })).toEqual({
      tools: {},
      shouldRememberTools: false,
      skipReason: 'no-tools',
    })

    expect(buildMCPToolsForAI({
      enabled: true,
      mcpTools: tools,
      toolsSettings: {
        mcp_search: { enabled: false },
      },
    })).toEqual({
      tools: {},
      shouldRememberTools: false,
      skipReason: 'router-disabled',
    })

    // ≤ threshold (default 20): flat exposure, keyed by sanitized ids.
    const flatPlan = buildMCPToolsForAI({
      enabled: true,
      mcpTools: tools,
    })
    expect(flatPlan.shouldRememberTools).toBe(true)
    expect(Object.keys(flatPlan.tools)).toEqual(tools.map(tool => `mcp:${tool.serverId}:${tool.name}`))
    expect(flatPlan.tools[`mcp:${tools[0]!.serverId}:${tools[0]!.name}`].parameterSchema).toMatchObject({
      type: 'object',
    })

    // Router mode (threshold 0): single router, tools hidden inside.
    const plan = buildMCPToolsForAI({
      enabled: true,
      mcpTools: tools,
      flatThreshold: 0,
    })
    expect(plan.shouldRememberTools).toBe(true)
    expect(Object.keys(plan.tools)).toEqual(['mcp_search'])
    expect(plan.tools.mcp_search.parameterSchema?.required).toEqual(['action'])
  })

  it('maps MCP tools and router definitions to app tool definitions in core', () => {
    const nestedTool = mcpToolToCoreToolDefinition({
      serverId: 'server',
      name: 'nested',
      description: 'Nested MCP tool',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['fast', 'safe'],
            default: 'safe',
            description: 'Execution mode.',
          },
          items: {
            type: 'array',
            description: 'Nested items.',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: 'Value text.' },
              },
              required: ['value'],
            },
          },
        },
        required: ['items'],
      },
    })
    const routerTool = mcpRouterToCoreToolDefinition()

    expect(nestedTool.parameters).toContainEqual({
      name: 'mode',
      type: 'string',
      description: 'Execution mode.',
      required: false,
      enum: ['fast', 'safe'],
      default: 'safe',
    })
    expect(nestedTool.parameterSchema?.properties?.items).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Value text.' },
        },
        required: ['value'],
      },
    })
    expect(routerTool.id).toBe('mcp_search')
    expect(routerTool.executionMode).toBe('sequential')
    expect(routerTool.source).toBe('mcp')
  })

  it('formats MCP content for model-visible output', () => {
    expect(mcpContentToString([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ])).toContain('hello')
  })

  it('normalizes raw MCP SDK content without transport dependencies', () => {
    expect(normalizeMCPContent([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'resource', text: 'file', data: 'xyz', mimeType: 'text/plain' },
      { custom: true },
    ])).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'resource', text: 'file', data: 'xyz', mimeType: 'text/plain' },
      { type: 'text', text: '{"custom":true}' },
    ])

    expect(normalizeMCPContent(undefined)).toBeUndefined()
  })

  it('keeps audio / resource_link / embedded-resource fidelity (P2-3)', () => {
    expect(normalizeMCPContent([
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
      { type: 'resource_link', uri: 'https://example.com/spec.pdf', name: 'Spec', description: 'The spec', mimeType: 'application/pdf' },
      // Spec-shaped embedded resource: nested object, blob payload.
      { type: 'resource', resource: { uri: 'file:///tmp/a.bin', blob: 'Ymlu', mimeType: 'application/octet-stream' } },
      // Spec-shaped embedded resource carrying text.
      { type: 'resource', resource: { uri: 'file:///tmp/a.txt', text: 'inner', mimeType: 'text/plain' } },
    ])).toEqual([
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
      { type: 'resource_link', uri: 'https://example.com/spec.pdf', name: 'Spec', description: 'The spec', mimeType: 'application/pdf' },
      { type: 'resource', uri: 'file:///tmp/a.bin', data: 'Ymlu', mimeType: 'application/octet-stream' },
      { type: 'resource', uri: 'file:///tmp/a.txt', text: 'inner', mimeType: 'text/plain' },
    ])

    // The model-visible rendering stays readable for the new parts.
    const rendered = mcpContentToString([
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
      { type: 'resource_link', uri: 'https://example.com/spec.pdf', name: 'Spec' },
      { type: 'resource', uri: 'file:///tmp/a.bin', data: 'Ymlu', mimeType: 'application/octet-stream' },
      { type: 'resource', uri: 'file:///tmp/a.txt', text: 'inner' },
    ])
    expect(rendered).toContain('[audio: audio/mpeg]')
    expect(rendered).toContain('[resource_link: Spec (https://example.com/spec.pdf)]')
    expect(rendered).toContain('[resource: application/octet-stream file:///tmp/a.bin]')
    expect(rendered).toContain('inner')
  })

  it('resolves router actions without invoking transport', () => {
    const refs = getMCPFunctionRefs(tools, serverName)

    expect(resolveMCPRouterAction({ action: 'search', query: 'fetch' }, refs).kind).toBe('handled')

    const call = resolveMCPRouterAction({
      action: 'call',
      tool: 'fetch',
      arguments: { url: 'https://example.com' },
    }, refs)

    expect(call.kind).toBe('call')
    if (call.kind === 'call') {
      expect(call.ref.serverId).toBe('fetch-server')
      expect(call.args).toEqual({ url: 'https://example.com' })
    }
  })

  it('parses double-encoded router arguments instead of silently dropping them', () => {
    const refs = getMCPFunctionRefs(tools, serverName)

    // Models (openai-compatible ones especially) double-encode nested objects.
    // This used to coerce to {} and run the real tool with no arguments.
    const encoded = resolveMCPRouterAction({
      action: 'call',
      tool: 'fetch',
      arguments: '{"url":"https://example.com"}',
    }, refs)
    expect(encoded.kind).toBe('call')
    if (encoded.kind === 'call') {
      expect(encoded.args).toEqual({ url: 'https://example.com' })
    }

    // Genuinely absent arguments stay a legitimate no-arg call.
    for (const empty of [undefined, null, '']) {
      const noArgs = resolveMCPRouterAction({ action: 'call', tool: 'fetch', arguments: empty }, refs)
      expect(noArgs.kind).toBe('call')
      if (noArgs.kind === 'call') expect(noArgs.args).toEqual({})
    }

    // Unparseable / wrong-shaped arguments must fail loudly, never as {}.
    for (const bad of ['not json', '[1,2]', '"text"', 42]) {
      const rejected = resolveMCPRouterAction({ action: 'call', tool: 'fetch', arguments: bad }, refs)
      expect(rejected.kind).toBe('handled')
      if (rejected.kind === 'handled') {
        expect(rejected.result.success).toBe(false)
        expect(rejected.result.error).toContain('arguments')
      }
    }
  })

  it('passes non-text tool content through the router untouched', async () => {
    const refs = getMCPFunctionRefs(tools, serverName)
    const partials: Array<{ text: string; phase: string }> = []
    const imageContent = [
      { type: 'text' as const, text: 'here is the screenshot' },
      { type: 'image' as const, data: 'AAAABBBBCCCC', mimeType: 'image/png' },
    ]

    const result = await executeMCPBridgeTool('mcp_search', {
      action: 'call',
      tool: 'fetch',
      arguments: {},
    }, {
      refs,
      parseToolId: () => null,
      callTool: async () => ({ success: true, content: imageContent }),
      onPartialResult: (text, phase) => partials.push({ text, phase }),
    })

    // The image part must survive: collapsing it to text lost the picture and
    // inlined its base64 into the transcript.
    expect(result.content).toEqual(imageContent)

    // The preview line stays textual and must NOT carry the payload.
    const preview = partials.find(partial => partial.phase === 'ready')?.text ?? ''
    expect(preview).toContain('here is the screenshot')
    expect(preview).toContain('[image: image/png]')
    expect(preview).not.toContain('AAAABBBBCCCC')

    // `output` is what the agent loop turns into the tool message text. Without
    // it the loop JSON.stringifies the whole result, so the base64 would be
    // billed once as text AND once as the real image part.
    expect(result.output).toContain('here is the screenshot')
    expect(result.output).toContain('[image: image/png]')
    expect(result.output).not.toContain('AAAABBBBCCCC')
  })

  it('executes MCP bridge router and direct tool paths through core adapters', async () => {
    const refs = getMCPFunctionRefs(tools, serverName)
    const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }> = []
    const partials: Array<{ text: string; phase: string }> = []
    const callTool = async (serverId: string, toolName: string, args: Record<string, unknown>) => {
      calls.push({ serverId, toolName, args })
      return {
        success: true,
        content: [{ type: 'text' as const, text: `called ${serverId}/${toolName}` }],
      }
    }

    const routerResult = await executeMCPBridgeTool('mcp_search', {
      action: 'call',
      tool: 'fetch',
      arguments: { url: 'https://example.com' },
    }, {
      refs,
      parseToolId: () => null,
      callTool,
      onPartialResult: (text, phase) => partials.push({ text, phase }),
    })

    expect(routerResult).toEqual({
      success: true,
      content: [{ type: 'text', text: 'called fetch-server/fetch' }],
      // Readable rendering for the agent loop's tool message text.
      output: 'called fetch-server/fetch',
      isError: undefined,
    })
    expect(calls[0]).toEqual({
      serverId: 'fetch-server',
      toolName: 'fetch',
      args: { url: 'https://example.com' },
    })
    expect(partials.map(partial => partial.phase)).toContain('ready')

    const directResult = await executeMCPBridgeTool('mcp_fetch_fetch', { url: 'https://example.com' }, {
      refs,
      parseToolId: () => ({ serverId: 'fetch-server', toolName: 'fetch' }),
      callTool,
    })

    expect(directResult.success).toBe(true)
    expect(calls[1]).toEqual({
      serverId: 'fetch-server',
      toolName: 'fetch',
      args: { url: 'https://example.com' },
    })
  })
})
