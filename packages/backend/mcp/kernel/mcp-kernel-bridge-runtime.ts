import type { JsonObject } from '@shared/json.js'
import {
  buildMCPToolsForAI,
  executeMCPBridgeTool,
  getMCPFunctionRefs as getCoreMCPFunctionRefs,
  getMCPRouterDefinition,
  planMCPToolRegistration,
  planMCPToolsCatalogWrite,
  resolveMCPToolExposure,
  type MCPFunctionRef,
  type MCPModelFacingToolDefinition,
  type MCPRegisteredToolLike,
  type MCPToolsCatalogOptions,
  type MCPToolsCatalogWritePlan,
  type MCPToolsForAIResult,
  type MCPRouterToolSetting,
  type MCPToolRegistrationPlan,
} from './mcp-kernel-router.js'
import { isMCPToolId, CoreMCPToolIdRegistry } from './mcp-kernel-tool-id-registry.js'
import { mcpRouterToCoreToolDefinition, mcpToolToCoreToolDefinition, type CoreMCPToolDefinition } from './mcp-kernel-tool-definition.js'
import type { MCPServerState, MCPToolCallResult, MCPToolInfo } from '@shared/mcp/types.js'

export interface CoreMCPBridgeRuntimeHost {
  isEnabled(): boolean
  getAllTools(): MCPToolInfo[]
  getServerState(serverId: string): Pick<MCPServerState, 'config'> | undefined
  getServerStates(): Array<Pick<MCPServerState, 'config' | 'tools'>>
  callTool(serverId: string, toolName: string, args: JsonObject): Promise<MCPToolCallResult>
  /**
   * Hybrid flat-mode threshold from settings (决策点 #1). Undefined = default
   * (20); 0 = always router.
   */
  getFlatToolThreshold?(): number | undefined
}

export interface WriteMCPToolsCatalogWithAdaptersOptions
  extends Omit<MCPToolsCatalogOptions, 'getServerName'> {
  getCatalogPath(): string
  writeFile(path: string, content: string): void
  logger?: {
    log?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
}

export type WriteMCPToolsCatalogWithAdaptersResult =
  | { status: 'skipped'; plan: MCPToolsCatalogWritePlan }
  | { status: 'written'; path: string; toolCount: number; plan: MCPToolsCatalogWritePlan }
  | { status: 'error'; error: unknown; plan: MCPToolsCatalogWritePlan }

export class CoreMCPBridgeRuntime {
  private toolsCatalogGenerated = false
  private readonly mcpToolIdRegistry = new CoreMCPToolIdRegistry<MCPToolInfo>()

  constructor(private readonly host: CoreMCPBridgeRuntimeHost) {}

  isToolsCatalogGenerated(): boolean {
    return this.toolsCatalogGenerated
  }

  markToolsCatalogGenerated(generated: boolean): void {
    this.toolsCatalogGenerated = generated
  }

  getServerName(serverId: string): string | undefined {
    const serverName = this.host.getServerState(serverId)?.config.name?.trim()
    return serverName || undefined
  }

  getServerDisplayName(serverId: string): string {
    return this.getServerName(serverId) || serverId
  }

  getMCPFunctionRefs(mcpTools: MCPToolInfo[] = this.host.getAllTools()): MCPFunctionRef[] {
    return getCoreMCPFunctionRefs(mcpTools, serverId => this.getServerDisplayName(serverId))
  }

  mcpToolToToolDefinition(mcpTool: MCPToolInfo): CoreMCPToolDefinition {
    return mcpToolToCoreToolDefinition(mcpTool)
  }

  getMCPRouterToolDefinition(): CoreMCPToolDefinition | null {
    if (!this.host.isEnabled() || this.host.getAllTools().length === 0) {
      return null
    }

    return mcpRouterToCoreToolDefinition(getMCPRouterDefinition())
  }

  /**
   * The model-facing MCP tool definitions for THIS turn (决策点 #1 hybrid):
   * at or below the flat threshold each connected tool is its own definition
   * (keyed by the sanitized `mcp_<server>_<tool>` ids the execution path
   * parses); above it the single `mcp_search` router. Modes are mutually
   * exclusive — `resolveMCPToolExposure` is the single decision point.
   */
  getMCPToolDefinitionsForModel(): CoreMCPToolDefinition[] {
    const mcpTools = this.host.getAllTools()
    const exposure = resolveMCPToolExposure({
      enabled: this.host.isEnabled(),
      toolCount: mcpTools.length,
      flatThreshold: this.host.getFlatToolThreshold?.(),
    })
    if (exposure.mode === 'none') return []
    if (exposure.mode === 'router') {
      const router = mcpRouterToCoreToolDefinition(getMCPRouterDefinition())
      return router ? [router] : []
    }

    const toolIds = this.mcpToolIdRegistry.getToolIds(
      mcpTools,
      serverId => this.getServerName(serverId),
    )
    return mcpTools.map(mcpTool => {
      const definition = mcpToolToCoreToolDefinition(mcpTool)
      const toolId = toolIds.get(mcpTool)
      return toolId ? { ...definition, id: toolId } : definition
    })
  }

  planToolsCatalogWrite(options: Omit<MCPToolsCatalogOptions, 'getServerName'> = {}): MCPToolsCatalogWritePlan {
    return planMCPToolsCatalogWrite({
      ...options,
      enabled: this.host.isEnabled(),
      mcpTools: this.host.getAllTools(),
      getServerName: serverId => this.getServerName(serverId),
    })
  }

  writeToolsCatalogWithAdapters(
    options: WriteMCPToolsCatalogWithAdaptersOptions,
  ): WriteMCPToolsCatalogWithAdaptersResult {
    const plan = this.planToolsCatalogWrite(options)

    if (plan.action === 'skip') {
      this.markToolsCatalogGenerated(false)
      return { status: 'skipped', plan }
    }

    try {
      const catalogPath = options.getCatalogPath()
      options.writeFile(catalogPath, plan.content)
      this.markToolsCatalogGenerated(true)
      options.logger?.log?.(`[MCPBridge] Tools catalog generated: ${catalogPath} (${plan.toolCount} tools)`)
      return {
        status: 'written',
        path: catalogPath,
        toolCount: plan.toolCount,
        plan,
      }
    } catch (error) {
      options.logger?.error?.('[MCPBridge] Failed to write tools catalog:', error)
      this.markToolsCatalogGenerated(false)
      return { status: 'error', error, plan }
    }
  }

  buildToolsForAI(
    toolsSettings?: Record<string, MCPRouterToolSetting>,
    routerDefinition?: MCPModelFacingToolDefinition,
  ): MCPToolsForAIResult {
    const mcpTools = this.host.getAllTools()
    const result = buildMCPToolsForAI({
      enabled: this.host.isEnabled(),
      mcpTools,
      toolsSettings,
      routerDefinition,
      flatThreshold: this.host.getFlatToolThreshold?.(),
      toolIds: this.mcpToolIdRegistry.getToolIds(
        mcpTools,
        serverId => this.getServerName(serverId),
      ),
    })

    if (result.shouldRememberTools) {
      this.mcpToolIdRegistry.rememberTools(mcpTools, serverId => this.getServerName(serverId))
    }

    return result
  }

  /**
   * Rebuild the sanitized-id -> {serverId, toolName} map.
   *
   * Must be called whenever the connected tool set changes. It used to happen
   * only inside buildToolsForAI, whose caller became dead when the model-facing
   * tool list moved to getMCPRouterToolDefinition — so in practice the map was
   * always empty and parseToolId/findToolIdByShortName ran on their fallbacks
   * (prefix splitting, parameter-shape guessing) instead of the real mapping.
   */
  /**
   * Which server owns a router-facing tool reference (its `id` or bare name).
   * Used to key permission grants per server.
   */
  resolveServerIdForToolRef(toolRef: string): string | undefined {
    const refs = this.getMCPFunctionRefs()
    const match = refs.find(ref => ref.id === toolRef)
      ?? refs.find(ref => ref.toolName === toolRef)
    return match?.serverId
  }

  rememberToolIds(): void {
    this.mcpToolIdRegistry.rememberTools(
      this.host.getAllTools(),
      serverId => this.getServerName(serverId),
    )
  }

  planToolRegistration(existingTools: MCPRegisteredToolLike[]): MCPToolRegistrationPlan {
    return planMCPToolRegistration({
      enabled: this.host.isEnabled(),
      existingTools,
      mcpTools: this.host.getAllTools(),
      flatThreshold: this.host.getFlatToolThreshold?.(),
    })
  }

  parseMCPToolId(toolId: string): { serverId: string; toolName: string } | null {
    return this.mcpToolIdRegistry.parseToolId(toolId, {
      tools: this.host.getAllTools(),
      getServerName: serverId => this.getServerName(serverId),
    })
  }

  isMCPTool(toolId: string): boolean {
    return isMCPToolId(toolId)
  }

  findMCPToolIdByShortName(shortName: string, args?: JsonObject): string | null {
    return this.mcpToolIdRegistry.findToolIdByShortName(shortName, args, {
      tools: this.host.getAllTools(),
      serverStates: this.host.getServerStates(),
      getServerName: serverId => this.getServerName(serverId),
    })
  }

  async executeMCPTool(
    toolId: string,
    args: JsonObject,
    options: { onPartialResult?: (text: string, phase: string) => void } = {},
  ): Promise<MCPToolCallResult> {
    return executeMCPBridgeTool(toolId, args, {
      refs: this.getMCPFunctionRefs(),
      parseToolId: id => this.parseMCPToolId(id),
      callTool: (serverId, toolName, toolArgs) => this.host.callTool(serverId, toolName, toolArgs),
      onPartialResult: options.onPartialResult,
    })
  }
}
