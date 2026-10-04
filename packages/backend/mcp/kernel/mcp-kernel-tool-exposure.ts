/**
 * MCP 工具怎样摆给模型看:工具少时逐个平铺(每只工具一份自己的定义),多了只露一只路由器工具(混合阈值,
 * 决策点 #1);以及据此算出的注册 / 撤销计划。三处读模式的地方(给模型的工具表、注册计划、目录计划)都经
 * `resolveMCPToolExposure` 判,所以不会各判各的。
 *
 * 路由器工具本身(它的定义、它的 search / find / list / describe / call 动作、函数目录与执行)在
 * `mcp-kernel-router.ts`;这里只决定「露不露它」。从那只文件原样搬来(大文件拆分批 2,2026-10-04):
 * 加一个路由器动作只改那一只,改平铺规则只改这一只。
 */
import type { JsonSchemaObject } from '@shared/json.js'
import {
  MCP_DEFAULT_FLAT_TOOL_THRESHOLD,
  type MCPToolInfo,
} from '@shared/mcp/types.js'
import { MCP_ROUTER_TOOL_ID } from './mcp-kernel-tool-id-registry.js'
import { getMCPRouterDefinition, type MCPModelFacingToolDefinition } from './mcp-kernel-router.js'

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
