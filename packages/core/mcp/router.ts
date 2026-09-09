import type { JsonObject, JsonSchemaObject } from '../json.js'
import { MCP_DEFAULT_FLAT_TOOL_THRESHOLD, type MCPToolCallResult, type MCPToolInfo } from './types.js'
import { isMCPRouterToolId, MCP_ROUTER_TOOL_ID, type MCPToolIdentity } from './tool-id-registry.js'

export type MCPModelFacingToolDefinition = {
  description: string
  parameters: Array<{ name: string; type: string; description: string; required?: boolean; enum?: string[] }>
  parameterSchema?: JsonSchemaObject
}

export type MCPFunctionRef = {
  id: string
  serverId: string
  serverName: string
  toolName: string
  description?: string
  inputSchema: MCPToolInfo['inputSchema']
}

export interface MCPRouterInput {
  function?: string
  server?: string
}

export interface MCPToolsCatalogOptions {
  generatedAt?: Date | string
  getServerName?: (serverId: string) => string | undefined
}

export type MCPToolsCatalogWritePlan =
  | { action: 'skip'; generated: false; reason: 'mcp-disabled' | 'no-tools'; toolCount: number }
  | { action: 'write'; generated: true; content: string; toolCount: number }

export interface MCPRouterToolSetting {
  enabled: boolean
  autoExecute?: boolean
}

export type MCPToolsForAISkipReason = 'mcp-disabled' | 'no-tools' | 'router-disabled'

export interface MCPToolsForAIOptions {
  enabled: boolean
  mcpTools: MCPToolInfo[]
  toolsSettings?: Record<string, MCPRouterToolSetting>
  routerToolId?: string
  routerDefinition?: MCPModelFacingToolDefinition
  /**
   * Hybrid flat-mode threshold (决策点 #1): at or below this many tools the
   * model sees each tool as its own definition and the router is hidden;
   * above it only the router is exposed. `0` = always router; undefined =
   * `MCP_DEFAULT_FLAT_TOOL_THRESHOLD`.
   */
  flatThreshold?: number
  /** Sanitized model-facing ids per tool (from the tool-id registry). */
  toolIds?: Map<MCPToolInfo, string>
}

export type MCPToolExposureMode = 'flat' | 'router' | 'none'

export interface MCPToolExposure {
  mode: MCPToolExposureMode
  skipReason?: MCPToolsForAISkipReason
}

/**
 * The single mode decision for hybrid exposure (roadmap 决策点 #1). Every
 * surface — model-facing tool list, registration plan, catalog planning —
 * resolves through here so they can never disagree about which mode we are
 * in. Modes are MUTUALLY EXCLUSIVE: flat hides the router, router hides the
 * flat tools.
 */
export function resolveMCPToolExposure(input: {
  enabled: boolean
  toolCount: number
  flatThreshold?: number
}): MCPToolExposure {
  if (!input.enabled) {
    return { mode: 'none', skipReason: 'mcp-disabled' }
  }
  if (input.toolCount === 0) {
    return { mode: 'none', skipReason: 'no-tools' }
  }
  const threshold = input.flatThreshold ?? MCP_DEFAULT_FLAT_TOOL_THRESHOLD
  if (threshold > 0 && input.toolCount <= threshold) {
    return { mode: 'flat' }
  }
  return { mode: 'router' }
}

/**
 * One flat-exposure model-facing definition: the tool describes itself
 * (parameters + full JSON schema), no router wrapper.
 */
export function mcpToolToModelFacingDefinition(mcpTool: MCPToolInfo): MCPModelFacingToolDefinition {
  const required = mcpTool.inputSchema.required || []
  const parameters: MCPModelFacingToolDefinition['parameters'] = []
  if (mcpTool.inputSchema.properties) {
    for (const [name, schema] of Object.entries(mcpTool.inputSchema.properties)) {
      const jsonType = Array.isArray(schema.type)
        ? schema.type.find(type => type !== 'null')
        : schema.type
      const enumValues = Array.isArray(schema.enum)
        ? schema.enum.filter((item): item is string => typeof item === 'string')
        : undefined
      parameters.push({
        name,
        type: typeof jsonType === 'string' ? jsonType : 'object',
        description: typeof schema.description === 'string' ? schema.description : '',
        required: required.includes(name),
        ...(enumValues && enumValues.length > 0 ? { enum: enumValues } : {}),
      })
    }
  }
  return {
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    parameters,
    parameterSchema: mcpTool.inputSchema as JsonSchemaObject,
  }
}

export interface MCPToolsForAIResult {
  tools: Record<string, MCPModelFacingToolDefinition>
  shouldRememberTools: boolean
  skipReason?: MCPToolsForAISkipReason
}

export interface MCPRegisteredToolLike {
  id: string
}

export interface MCPToolRegistrationPlan {
  toolIdsToUnregister: string[]
  shouldGenerateCatalog: boolean
  shouldExposeRouter: boolean
  /** Resolved hybrid exposure mode (决策点 #1) — flat hides the router. */
  mode?: MCPToolExposureMode
  toolCount: number
  logMessage?: string
}

export type MCPRouterActionResult =
  | { kind: 'handled'; result: MCPToolCallResult }
  | { kind: 'call'; ref: MCPFunctionRef; args: JsonObject }

export interface MCPRouterActionOptions {
  onPartialResult?: (text: string, phase: string) => void
}

export function buildMCPToolsForAI(options: MCPToolsForAIOptions): MCPToolsForAIResult {
  const tools: Record<string, MCPModelFacingToolDefinition> = {}
  const routerToolId = options.routerToolId ?? MCP_ROUTER_TOOL_ID

  const exposure = resolveMCPToolExposure({
    enabled: options.enabled,
    toolCount: options.mcpTools.length,
    flatThreshold: options.flatThreshold,
  })
  if (exposure.mode === 'none') {
    return { tools, shouldRememberTools: false, skipReason: exposure.skipReason }
  }

  const routerSetting = options.toolsSettings?.[routerToolId]
  if (routerSetting && !routerSetting.enabled) {
    return { tools, shouldRememberTools: false, skipReason: 'router-disabled' }
  }

  // Flat mode: each tool is its own model-facing definition, keyed by the
  // same sanitized ids the execution path parses (`mcp_<server>_<tool>`).
  if (exposure.mode === 'flat') {
    for (const mcpTool of options.mcpTools) {
      const toolId = options.toolIds?.get(mcpTool) ?? `mcp:${mcpTool.serverId}:${mcpTool.name}`
      tools[toolId] = mcpToolToModelFacingDefinition(mcpTool)
    }
    return { tools, shouldRememberTools: true }
  }

  tools[routerToolId] = options.routerDefinition ?? getMCPRouterDefinition()
  return {
    tools,
    shouldRememberTools: true,
  }
}

interface FuzzyMatchTarget<T> {
  item: T
  text: string
}

function normalizeFuzzy(value: string): string {
  return value.toLowerCase().replace(/[_\-/.:]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function acronym(value: string): string {
  return normalizeFuzzy(value)
    .split(' ')
    .filter(Boolean)
    .map(part => part[0])
    .join('')
}

function sequentialScore(query: string, text: string): number {
  let score = 0
  let cursor = 0
  let lastIndex = -1

  for (const char of query) {
    const index = text.indexOf(char, cursor)
    if (index === -1) return 0
    score += lastIndex === index - 1 ? 2 : 1
    cursor = index + 1
    lastIndex = index
  }

  return score / Math.max(text.length, 1)
}

function fuzzyScore(query: string | undefined, text: string): number {
  const q = normalizeFuzzy(query || '')
  if (!q) return 1

  const t = normalizeFuzzy(text)
  if (!t) return 0
  if (t === q) return 100
  if (t.startsWith(q)) return 80 - Math.min(t.length - q.length, 40)
  if (t.includes(q)) return 60 - Math.min(t.indexOf(q), 30)

  const initials = acronym(t)
  if (initials && initials.startsWith(q)) return 45

  const compactQuery = q.replace(/\s+/g, '')
  const compactText = t.replace(/\s+/g, '')
  const seq = sequentialScore(compactQuery, compactText)
  return seq > 0 ? 20 + seq * 20 : 0
}

function fuzzyFilter<T>(
  items: Array<FuzzyMatchTarget<T>>,
  query?: string,
  limit = 50,
): T[] {
  const q = query?.trim()
  return items
    .map(target => ({
      item: target.item,
      score: fuzzyScore(q, target.text),
    }))
    .filter(result => !q || result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(result => result.item)
}

export function truncateMCPDescription(desc: string, maxLength: number = 100): string {
  if (!desc) return ''
  if (desc.length <= maxLength) return desc
  return desc.slice(0, maxLength - 3) + '...'
}

export function getMCPFunctionRefs(
  mcpTools: MCPToolInfo[],
  getServerName: (serverId: string) => string | undefined = () => undefined,
): MCPFunctionRef[] {
  const counts = new Map<string, number>()
  for (const tool of mcpTools) {
    counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
  }

  return mcpTools.map(tool => {
    const serverName = getServerName(tool.serverId)?.trim() || tool.serverId
    return {
      id: (counts.get(tool.name) || 0) > 1 ? `${serverName}/${tool.name}` : tool.name,
      serverId: tool.serverId,
      serverName,
      toolName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }
  })
}

export function findMCPFunctionRef(
  refs: MCPFunctionRef[],
  input?: MCPRouterInput,
): MCPFunctionRef | null {
  const functionName = input?.function?.trim()
  if (!functionName) return null

  const server = input?.server?.trim().toLowerCase()
  const matches = refs.filter(ref => {
    const functionMatches = ref.id === functionName || ref.toolName === functionName
    if (!functionMatches) return false
    if (!server) return true
    return ref.serverId.toLowerCase() === server || ref.serverName.toLowerCase() === server
  })

  if (matches.length === 1) return matches[0]
  return matches.find(ref => ref.id === functionName) || null
}

export function listMCPFunctions(refs: MCPFunctionRef[], query?: string): string {
  const normalizedQuery = query?.trim()
  const matches = normalizedQuery
    ? fuzzyFilter(
        refs.map(ref => ({
          item: ref,
          text: `${ref.id} ${ref.toolName} ${ref.serverName} ${ref.description || ''}`,
        })),
        normalizedQuery,
      )
    : [...refs].sort((a, b) => a.id.localeCompare(b.id))

  if (matches.length === 0) {
    return normalizedQuery
      ? `No MCP tools matched query "${query}".`
      : 'No MCP tools are currently available.'
  }

  return matches.map(ref => {
    const summary = ref.description ? ` — ${truncateMCPDescription(ref.description, 120)}` : ''
    const server = ref.id === ref.toolName ? '' : ` (${ref.serverName})`
    return `- ${ref.id}${server}${summary}`
  }).join('\n')
}

export function describeMCPFunction(ref: MCPFunctionRef): string {
  const lines = [
    `MCP tool: ${ref.id}`,
    `Server: ${ref.serverName}`,
    `Original tool name: ${ref.toolName}`,
    `Description: ${ref.description || 'No description available'}`,
    '',
    'Input schema:',
    JSON.stringify(ref.inputSchema, null, 2),
  ]
  return lines.join('\n')
}

/**
 * Human-readable rendering of MCP content, for previews and progress lines.
 *
 * Binary parts are summarised, never serialized: `JSON.stringify` on an image
 * part inlines its entire base64 payload, which is how screenshots from MCP
 * servers used to end up as hundreds of KB of text.
 *
 * This is NOT the path model-visible results take — those keep their original
 * parts (see executeMCPBridgeTool).
 */
export function mcpContentToString(content: MCPToolCallResult['content']): string {
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (item.type === 'text') return item.text ?? ''
        // A resource part carrying text IS its readable content.
        if (item.type === 'resource' && typeof item.text === 'string') return item.text
        // A resource link is readable as a link: name + uri beats a JSON blob.
        if (item.type === 'resource_link') {
          const label = item.name || item.uri || 'resource'
          return `[resource_link: ${label}${item.uri && item.name ? ` (${item.uri})` : ''}]`
        }
        const where = item.uri ? ` ${item.uri}` : ''
        return `[${item.type}${item.mimeType ? `: ${item.mimeType}` : ''}${where}]`
      })
      .join('\n')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

export function getMCPRouterDefinition(): MCPModelFacingToolDefinition {
  return {
    description: 'Search available MCP tools, inspect a tool schema, or call a selected MCP tool. Use action="search" or action="find" with query text when choosing a tool.',
    parameters: [
      { name: 'action', type: 'string', description: 'One of: search, find, list, describe, call.', required: true, enum: ['search', 'find', 'list', 'describe', 'call'] },
      { name: 'tool', type: 'string', description: 'MCP tool identifier returned by action=search/find/list. Required for describe and call.' },
      { name: 'function', type: 'string', description: 'Legacy alias for tool. Supported for older calls.' },
      { name: 'arguments', type: 'object', description: 'Arguments object for action=call.' },
      { name: 'server', type: 'string', description: 'Optional server name or id to disambiguate duplicate function names.' },
      { name: 'query', type: 'string', description: 'Search text for action=search or action=find. Optional for action=list.' },
    ],
    parameterSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'find', 'list', 'describe', 'call'],
          description: 'Use "search" or "find" to fuzzy-search MCP tools, "list" to show available tools, "describe" to inspect one tool schema, or "call" to execute one tool.',
        },
        function: {
          type: 'string',
          description: 'Legacy alias for tool. Supported for older calls.',
        },
        tool: {
          type: 'string',
          description: 'MCP tool identifier returned by action=search/find/list. Required for describe and call.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments object for action=call.',
          additionalProperties: true,
        },
        server: {
          type: 'string',
          description: 'Optional server name or id to disambiguate duplicate function names.',
        },
        query: {
          type: 'string',
          description: 'Fuzzy search text for action=search or action=find. Optional for action=list.',
        },
      },
      required: ['action'],
    },
  }
}

function schemaDescription(schema: JsonSchemaObject): string {
  return typeof schema.description === 'string' ? schema.description : ''
}

export function buildMCPToolsCatalog(
  mcpTools: MCPToolInfo[],
  options: MCPToolsCatalogOptions = {},
): string {
  const generatedAt = options.generatedAt instanceof Date
    ? options.generatedAt.toISOString()
    : options.generatedAt || new Date().toISOString()
  const getServerName = options.getServerName ?? (() => undefined)
  const lines: string[] = [
    '# MCP Tools Catalog',
    '',
    `> Auto-generated on ${generatedAt}`,
    `> Total tools: ${mcpTools.length}`,
    '',
    'This catalog contains detailed documentation for all available MCP tools.',
    'Use the `mcp_search` tool with action=`search`, action=`find`, action=`list`, action=`describe`, or action=`call`.',
    '',
    '---',
    '',
  ]

  const functionRefs = new Map(
    getMCPFunctionRefs(mcpTools, getServerName).map(ref => [`${ref.serverId}:${ref.toolName}`, ref]),
  )

  const toolsByServer = new Map<string, MCPToolInfo[]>()
  for (const tool of mcpTools) {
    const existing = toolsByServer.get(tool.serverId) || []
    existing.push(tool)
    toolsByServer.set(tool.serverId, existing)
  }

  for (const [serverId, tools] of toolsByServer.entries()) {
    const serverName = getServerName(serverId)
    const title = serverName ? `${serverName} (${serverId})` : serverId
    lines.push(`## Server: ${title}`)
    lines.push('')

    for (const tool of tools) {
      const functionId = functionRefs.get(`${tool.serverId}:${tool.name}`)?.id || tool.name

      lines.push(`### ${tool.name}`)
      lines.push('')
      lines.push(`**Function:** \`${functionId}\``)
      lines.push('')
      lines.push(`**Description:** ${tool.description || 'No description available'}`)
      lines.push('')

      if (tool.inputSchema.properties && Object.keys(tool.inputSchema.properties).length > 0) {
        lines.push('**Parameters:**')
        lines.push('')
        lines.push('| Name | Type | Required | Description |')
        lines.push('|------|------|----------|-------------|')

        const required = tool.inputSchema.required || []
        for (const [name, prop] of Object.entries(tool.inputSchema.properties)) {
          const isRequired = required.includes(name) ? '✓' : ''
          const type = prop.type || 'value'
          const desc = schemaDescription(prop).replace(/\|/g, '\\|').replace(/\n/g, ' ')
          lines.push(`| ${name} | ${type} | ${isRequired} | ${desc} |`)
        }
        lines.push('')
      } else {
        lines.push('**Parameters:** None')
        lines.push('')
      }

      lines.push('---')
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function planMCPToolsCatalogWrite(
  input: {
    enabled: boolean
    mcpTools: MCPToolInfo[]
  } & MCPToolsCatalogOptions,
): MCPToolsCatalogWritePlan {
  if (!input.enabled) {
    return {
      action: 'skip',
      generated: false,
      reason: 'mcp-disabled',
      toolCount: input.mcpTools.length,
    }
  }

  if (input.mcpTools.length === 0) {
    return {
      action: 'skip',
      generated: false,
      reason: 'no-tools',
      toolCount: 0,
    }
  }

  return {
    action: 'write',
    generated: true,
    content: buildMCPToolsCatalog(input.mcpTools, {
      generatedAt: input.generatedAt,
      getServerName: input.getServerName,
    }),
    toolCount: input.mcpTools.length,
  }
}

export function planMCPToolRegistration(input: {
  enabled: boolean
  mcpTools: MCPToolInfo[]
  existingTools: MCPRegisteredToolLike[]
  flatThreshold?: number
}): MCPToolRegistrationPlan {
  const toolIdsToUnregister = input.existingTools
    .map(tool => tool.id)
    .filter(id => id.startsWith('mcp:'))

  const exposure = resolveMCPToolExposure({
    enabled: input.enabled,
    toolCount: input.mcpTools.length,
    flatThreshold: input.flatThreshold,
  })

  if (exposure.mode === 'none') {
    return {
      toolIdsToUnregister,
      shouldGenerateCatalog: false,
      shouldExposeRouter: false,
      mode: exposure.mode,
      toolCount: input.mcpTools.length,
    }
  }

  // The catalog file exists to give the model the documentation the ROUTER
  // hides; in flat mode every tool is already self-describing, so writing a
  // second copy would only go stale.
  const isRouter = exposure.mode === 'router'
  return {
    toolIdsToUnregister,
    shouldGenerateCatalog: isRouter,
    shouldExposeRouter: isRouter,
    mode: exposure.mode,
    toolCount: input.mcpTools.length,
    logMessage: isRouter
      ? `[MCPBridge] MCP router ready (${input.mcpTools.length} functions)`
      : `[MCPBridge] MCP flat exposure (${input.mcpTools.length} tools, threshold not exceeded)`,
  }
}

export function resolveMCPRouterReference(
  refs: MCPFunctionRef[],
  args: JsonObject,
): MCPFunctionRef | null {
  return findMCPFunctionRef(refs, {
    function: typeof args.tool === 'string'
      ? args.tool
      : typeof args.function === 'string'
        ? args.function
        : undefined,
    server: typeof args.server === 'string' ? args.server : undefined,
  })
}

/**
 * Coerce the router's `arguments` payload into a tool-call argument object.
 *
 * Models — openai-compatible ones especially — routinely double-encode nested
 * objects as a JSON string. Treating anything non-object as `{}` meant those
 * calls executed the real MCP tool with NO arguments and returned a plausible
 * but wrong result, with nothing anywhere saying the arguments were dropped.
 * Parse what can be parsed; refuse the rest loudly.
 */
function parseRouterArguments(value: unknown): { args: JsonObject } | { error: string } {
  if (value === undefined || value === null) return { args: {} }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return { args: value as JsonObject }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return { args: {} }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as JsonObject }
      }
      return { error: `"arguments" must be an object; got JSON ${Array.isArray(parsed) ? 'array' : typeof parsed}. Send arguments as an object, not a string.` }
    } catch {
      return { error: '"arguments" was a string but is not valid JSON. Send arguments as an object, not a string.' }
    }
  }

  return { error: `"arguments" must be an object; got ${Array.isArray(value) ? 'array' : typeof value}.` }
}

export function resolveMCPRouterAction(
  args: JsonObject,
  refs: MCPFunctionRef[],
  options: MCPRouterActionOptions = {},
): MCPRouterActionResult {
  const action = typeof args.action === 'string' ? args.action : ''

  if (action === 'search' || action === 'find' || action === 'list') {
    const query = typeof args.query === 'string' ? args.query : undefined
    options.onPartialResult?.(query ? 'Searching MCP tools...' : 'Listing MCP tools...', query ? 'searching' : 'listing')
    const text = listMCPFunctions(refs, query)
    options.onPartialResult?.(text, 'ready')
    return {
      kind: 'handled',
      result: {
        success: true,
        content: [{ type: 'text', text }],
      },
    }
  }

  options.onPartialResult?.('Resolving MCP tool...', 'resolving')
  const ref = resolveMCPRouterReference(refs, args)

  if (!ref) {
    return {
      kind: 'handled',
      result: {
        success: false,
        error: 'MCP tool not found or ambiguous. Use action "search" or "find" to get tool identifiers, then retry with the exact tool value.',
      },
    }
  }

  if (action === 'describe') {
    const text = describeMCPFunction(ref)
    options.onPartialResult?.(text, 'ready')
    return {
      kind: 'handled',
      result: {
        success: true,
        content: [{ type: 'text', text }],
      },
    }
  }

  if (action === 'call') {
    const parsedArguments = parseRouterArguments(args.arguments)
    if ('error' in parsedArguments) {
      return {
        kind: 'handled',
        result: { success: false, error: parsedArguments.error },
      }
    }

    options.onPartialResult?.(`Calling MCP tool: ${ref.id}...`, 'calling')
    return {
      kind: 'call',
      ref,
      args: parsedArguments.args,
    }
  }

  return {
    kind: 'handled',
    result: {
      success: false,
      error: 'Invalid action. Use one of: search, find, list, describe, call.',
    },
  }
}

/**
 * Attach the readable rendering of an MCP result before it reaches the agent
 * loop.
 *
 * Exported (K5-a) so the resource-side projection of an MCP server
 * (`backend/wiring/resource/mcp-provider.ts`) renders a call result through the
 * *same* function `executeMCPBridgeTool` uses below. A second rendering would
 * drift, and the shape of that drift is exactly the bug this function exists to
 * prevent.
 *
 * `toolOutputToText` (core/agent-loop/tools.ts) JSON.stringifies any payload
 * that has no `output` string. For a result carrying an image part that meant
 * the base64 was inlined into the tool message text *and* attached again as a
 * real image part — the same bytes charged twice. The summary keeps binary
 * parts as `[image: image/png]` while `content` still carries the real parts.
 */
export function withMCPResultOutputText(result: MCPToolCallResult): MCPToolCallResult {
  if (!result.success) return result
  return { ...result, output: mcpContentToString(result.content) }
}

export async function executeMCPBridgeTool(
  toolId: string,
  args: JsonObject,
  options: MCPRouterActionOptions & {
    refs: MCPFunctionRef[]
    parseToolId: (toolId: string) => MCPToolIdentity | null
    callTool: (serverId: string, toolName: string, args: JsonObject) => Promise<MCPToolCallResult>
  },
): Promise<MCPToolCallResult> {
  if (isMCPRouterToolId(toolId)) {
    const resolvedAction = resolveMCPRouterAction(args, options.refs, options)
    if (resolvedAction.kind === 'handled') return resolvedAction.result

    const result = await options.callTool(
      resolvedAction.ref.serverId,
      resolvedAction.ref.toolName,
      resolvedAction.args,
    )
    if (!result.success) return result

    // Hand the tool's own content back untouched. Collapsing it into a single
    // text part discarded every non-text part: an image came back as
    // JSON.stringify output, so the model never saw the picture and the base64
    // was billed as transcript text. The preview line stays text-only.
    const withOutput = withMCPResultOutputText(result)
    options.onPartialResult?.(withOutput.output ?? '', 'ready')
    return withOutput
  }

  const parsed = options.parseToolId(toolId)
  if (!parsed) {
    return {
      success: false,
      error: `Invalid MCP tool ID: ${toolId}`,
    }
  }

  return withMCPResultOutputText(await options.callTool(parsed.serverId, parsed.toolName, args))
}
