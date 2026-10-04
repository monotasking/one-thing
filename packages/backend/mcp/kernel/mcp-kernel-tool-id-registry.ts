import type { JsonObject } from '@shared/json.js'
import type { MCPServerState, MCPToolInfo } from '@shared/mcp/types.js'

export const MCP_ROUTER_TOOL_ID = 'mcp_search'
export const LEGACY_MCP_ROUTER_TOOL_ID = 'tool_function'

export interface MCPToolIdentity {
  serverId: string
  toolName: string
}

export interface MCPToolIdRegistryOptions<
  TTool extends MCPToolInfo = MCPToolInfo,
  TServerState extends Pick<MCPServerState, 'config' | 'tools'> = Pick<MCPServerState, 'config' | 'tools'>,
> {
  tools?: TTool[]
  serverStates?: TServerState[]
  getServerName?: (serverId: string) => string | undefined
}

export function isMCPRouterToolId(toolId: string): boolean {
  return toolId === MCP_ROUTER_TOOL_ID || toolId === LEGACY_MCP_ROUTER_TOOL_ID
}

export function sanitizeMCPToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function isMCPToolId(toolId: string): boolean {
  return isMCPRouterToolId(toolId) || toolId.startsWith('mcp:') || toolId.startsWith('mcp_')
}

export class CoreMCPToolIdRegistry<
  TTool extends MCPToolInfo = MCPToolInfo,
  TServerState extends Pick<MCPServerState, 'config' | 'tools'> = Pick<MCPServerState, 'config' | 'tools'>,
> {
  private sanitizedToOriginalMap = new Map<string, MCPToolIdentity>()

  clear(): void {
    this.sanitizedToOriginalMap.clear()
  }

  rememberTools(
    mcpTools: TTool[],
    getServerName?: (serverId: string) => string | undefined,
  ): Map<TTool, string> {
    this.clear()
    const toolIds = this.getToolIds(mcpTools, getServerName)
    for (const [tool, toolId] of toolIds) {
      this.sanitizedToOriginalMap.set(toolId, {
        serverId: tool.serverId,
        toolName: tool.name,
      })
    }
    return toolIds
  }

  getToolIds(
    mcpTools: TTool[],
    getServerName?: (serverId: string) => string | undefined,
  ): Map<TTool, string> {
    const baseIds = new Map<TTool, string>()
    const counts = new Map<string, number>()

    for (const tool of mcpTools) {
      const serverPrefix = this.getServerToolNamePrefix(tool.serverId, getServerName)
      const toolName = sanitizeMCPToolName(tool.name)
      const baseId = `mcp_${serverPrefix}_${toolName}`
      baseIds.set(tool, baseId)
      counts.set(baseId, (counts.get(baseId) || 0) + 1)
    }

    const ids = new Map<TTool, string>()
    for (const tool of mcpTools) {
      const baseId = baseIds.get(tool)!
      if ((counts.get(baseId) || 0) <= 1) {
        ids.set(tool, baseId)
        continue
      }

      const serverPrefix = this.getServerToolNamePrefix(tool.serverId, getServerName)
      const serverId = sanitizeMCPToolName(tool.serverId)
      const toolName = sanitizeMCPToolName(tool.name)
      ids.set(tool, `mcp_${serverPrefix}_${serverId}_${toolName}`)
    }

    return ids
  }

  getToolId(
    mcpTool: TTool,
    getServerName?: (serverId: string) => string | undefined,
  ): string {
    return this.getToolIds([mcpTool], getServerName).get(mcpTool)!
  }

  parseToolId(
    toolId: string,
    options: MCPToolIdRegistryOptions<TTool, TServerState> = {},
  ): MCPToolIdentity | null {
    if (isMCPRouterToolId(toolId)) return null

    const mapped = this.sanitizedToOriginalMap.get(toolId)
    if (mapped) return mapped

    if (toolId.startsWith('mcp:')) {
      const parts = toolId.slice(4).split(':')
      if (parts.length >= 2) {
        return {
          serverId: parts[0],
          toolName: parts.slice(1).join(':'),
        }
      }
    }

    if (toolId.startsWith('mcp_') && options.tools) {
      const toolIds = this.getToolIds(options.tools, options.getServerName)
      for (const tool of options.tools) {
        if (toolIds.get(tool) === toolId) {
          return {
            serverId: tool.serverId,
            toolName: tool.name,
          }
        }
      }
    }

    if (toolId.startsWith('mcp_')) {
      const parts = toolId.slice(4).split('_')
      if (parts.length >= 2) {
        return {
          serverId: parts[0],
          toolName: parts.slice(1).join('_'),
        }
      }
    }

    return null
  }

  findToolIdByShortName(
    shortName: string,
    args?: JsonObject,
    options: MCPToolIdRegistryOptions<TTool, TServerState> = {},
  ): string | null {
    const sanitizedInput = sanitizeMCPToolName(shortName)

    for (const [fullId, original] of this.sanitizedToOriginalMap.entries()) {
      if (original.toolName === shortName) {
        return fullId
      }

      if (sanitizeMCPToolName(original.toolName) === sanitizedInput) {
        return fullId
      }
    }

    if (args && Object.keys(args).length > 0 && options.serverStates && options.tools) {
      for (const state of options.serverStates) {
        if (
          state.config.name === shortName ||
          sanitizeMCPToolName(state.config.name) === sanitizedInput
        ) {
          const matchingTool = this.findToolByParameters(state.tools as TTool[], args)
          if (matchingTool) {
            const toolIds = this.getToolIds(options.tools, options.getServerName)
            const matchingMCPTool = options.tools.find(tool =>
              tool.serverId === matchingTool.serverId && tool.name === matchingTool.name
            )
            if (matchingMCPTool) {
              return toolIds.get(matchingMCPTool) || this.getToolId(matchingMCPTool, options.getServerName)
            }
          }
        }
      }
    }

    return null
  }

  private getServerToolNamePrefix(
    serverId: string,
    getServerName?: (serverId: string) => string | undefined,
  ): string {
    const serverName = getServerName?.(serverId)?.trim()
    const sanitizedName = serverName ? sanitizeMCPToolName(serverName) : ''
    return sanitizedName || sanitizeMCPToolName(serverId)
  }

  private findToolByParameters(tools: TTool[], args: JsonObject): TTool | null {
    const argNames = Object.keys(args)

    let bestMatch: TTool | null = null
    let bestScore = 0

    for (const tool of tools) {
      if (!tool.inputSchema.properties) continue

      const toolParams = Object.keys(tool.inputSchema.properties)
      const matchCount = argNames.filter(name => toolParams.includes(name)).length

      if (matchCount > bestScore) {
        bestScore = matchCount
        bestMatch = tool
      }
    }

    return bestMatch
  }
}
