import { toJsonSchemaObject, type JsonSchemaObject, type JsonValue } from '../json.js'
import type { MCPToolInfo } from './types.js'
import { MCP_ROUTER_TOOL_ID } from './tool-id-registry.js'
import { getMCPRouterDefinition, type MCPModelFacingToolDefinition } from './router.js'

export type CoreMCPToolParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array'

export interface CoreMCPToolParameter {
  name: string
  type: CoreMCPToolParameterType
  description: string
  required?: boolean
  enum?: string[]
  default?: JsonValue
}

export type CoreMCPJsonSchemaValidationKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'json'

export interface CoreMCPJsonSchemaValidationPlan {
  kind: CoreMCPJsonSchemaValidationKind
  description?: string
  required: boolean
  enumValues?: string[]
  items?: CoreMCPJsonSchemaValidationPlan
  properties?: Record<string, CoreMCPJsonSchemaValidationPlan>
  /**
   * Explicit downgrade markers (P2-3): the spec widened schemas to arbitrary
   * JSON Schema 2020-12 + `$ref`, and this planner only understands the
   * flat subset. Unsupported constructs used to degrade SILENTLY (a `$ref`
   * or `anyOf` became a plain `string`); now they are named here so the
   * tool definition can tell the model validation is loose instead of
   * dropping the constraint on the floor.
   */
  caveats?: string[]
}

export interface CoreMCPToolDefinition {
  id: string
  name: string
  description: string
  parameters: CoreMCPToolParameter[]
  parameterSchema?: JsonSchemaObject
  enabled: boolean
  autoExecute: boolean
  /**
   * @deprecated R4b —— 概念已退役。权限只认 `Intent.effects`(见
   * `packages/core/toolkit/effects.ts` 的策略表);这个字段活着只是因为契约与
   * 渲染层还在读它,它的值由 `app/toolkit/guard-projection.ts` 从 `spec.effects`
   * **派生**。没有任何工具作者再写它,也没有任何判定读它做决定。
   */
  permissionGuard?: 'safe' | 'sandboxed' | 'internal-check' | 'permission-gated' | 'external'
  executionMode?: 'parallel' | 'sequential'
  renderKind?: 'text' | 'bash' | 'diff' | 'file' | 'search' | 'image' | 'custom'
  category: 'builtin' | 'custom'
  icon?: string
  source?: 'builtin' | 'plugin' | 'mcp'
}

export function jsonSchemaStringEnum(schema: JsonSchemaObject): string[] | undefined {
  const values = Array.isArray(schema.enum)
    ? schema.enum.filter((item): item is string => typeof item === 'string')
    : []
  return values.length > 0 ? values : undefined
}

export function jsonSchemaDescription(schema: JsonSchemaObject): string {
  return typeof schema.description === 'string' ? schema.description : ''
}

export function jsonSchemaDefault(schema: JsonSchemaObject): JsonValue | undefined {
  const value = schema.default
  return value === undefined ? undefined : value
}

export function mapJsonSchemaToolParameterType(
  jsonType: string | string[] | undefined,
): CoreMCPToolParameterType {
  if (Array.isArray(jsonType)) {
    const nonNull = jsonType.find(type => type !== 'null')
    return mapJsonSchemaToolParameterType(nonNull)
  }

  switch (jsonType) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
    default:
      return 'object'
  }
}

function jsonSchemaPrimaryType(schema: JsonSchemaObject): string {
  return Array.isArray(schema.type)
    ? schema.type.find(type => type !== 'null') || 'string'
    : schema.type || 'string'
}

/** Constructs this planner cannot faithfully map (see caveats on the plan). */
function jsonSchemaCaveats(schema: JsonSchemaObject): string[] | undefined {
  const caveats: string[] = []
  const record = schema as Record<string, unknown>
  if (typeof record.$ref === 'string') caveats.push(`$ref (${record.$ref}) not resolved`)
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not'] as const) {
    if (record[keyword] !== undefined) caveats.push(`${keyword} collapsed to the loose plan`)
  }
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter(type => type !== 'null')
    if (nonNull.length > 1) {
      caveats.push(`union type [${nonNull.join(', ')}] treated as ${nonNull[0]}`)
    }
  }
  return caveats.length > 0 ? caveats : undefined
}

export function planJsonSchemaValidation(
  schema: JsonSchemaObject,
  options: { required?: boolean } = {},
): CoreMCPJsonSchemaValidationPlan {
  const description = jsonSchemaDescription(schema) || undefined
  const required = options.required !== false
  const type = jsonSchemaPrimaryType(schema)
  const caveats = jsonSchemaCaveats(schema)
  // A schema whose ONLY signal is an unsupported construct must not pretend
  // to be a plain string (the old default): plan it as passthrough JSON.
  const record = schema as Record<string, unknown>
  const hasUnsupportedShape = schema.type === undefined && (
    record.$ref !== undefined
    || record.anyOf !== undefined
    || record.oneOf !== undefined
    || record.allOf !== undefined
    || record.not !== undefined
  )

  switch (hasUnsupportedShape ? 'json' : type) {
    case 'string':
      return {
        kind: 'string',
        description,
        required,
        enumValues: jsonSchemaStringEnum(schema),
        ...(caveats ? { caveats } : {}),
      }
    case 'number':
    case 'integer':
      return { kind: 'number', description, required, ...(caveats ? { caveats } : {}) }
    case 'boolean':
      return { kind: 'boolean', description, required, ...(caveats ? { caveats } : {}) }
    case 'array':
      return {
        kind: 'array',
        description,
        required,
        items: schema.items ? planJsonSchemaValidation(schema.items) : undefined,
        ...(caveats ? { caveats } : {}),
      }
    case 'object':
      if (!schema.properties) {
        return { kind: 'object', description, required, ...(caveats ? { caveats } : {}) }
      }
      return {
        kind: 'object',
        description,
        required,
        properties: Object.fromEntries(Object.entries(schema.properties).map(([name, childSchema]) => [
          name,
          planJsonSchemaValidation(childSchema, {
            required: (schema.required || []).includes(name),
          }),
        ])),
        ...(caveats ? { caveats } : {}),
      }
    default:
      return { kind: 'json', description, required, ...(caveats ? { caveats } : {}) }
  }
}

export function planMCPInputSchemaValidation(
  inputSchema: Pick<JsonSchemaObject, 'properties' | 'required'>,
): Record<string, CoreMCPJsonSchemaValidationPlan> {
  const required = inputSchema.required || []
  return Object.fromEntries(Object.entries(inputSchema.properties || {}).map(([name, schema]) => [
    name,
    planJsonSchemaValidation(schema, { required: required.includes(name) }),
  ]))
}

export function mcpToolToCoreToolDefinition(mcpTool: MCPToolInfo): CoreMCPToolDefinition {
  const parameters: CoreMCPToolParameter[] = []

  if (mcpTool.inputSchema.properties) {
    const required = mcpTool.inputSchema.required || []

    for (const [name, schema] of Object.entries(mcpTool.inputSchema.properties)) {
      // P2-3: unsupported schema constructs are named in the parameter
      // description instead of silently degrading (a $ref is NOT a string).
      const caveats = jsonSchemaCaveats(schema)
      const baseDescription = jsonSchemaDescription(schema)
      const description = caveats
        ? `${baseDescription ? `${baseDescription} ` : ''}[schema caveat: ${caveats.join('; ')} — validation is loose]`
        : baseDescription
      parameters.push({
        name,
        type: mapJsonSchemaToolParameterType(schema.type),
        description,
        required: required.includes(name),
        enum: jsonSchemaStringEnum(schema),
        default: jsonSchemaDefault(schema),
      })
    }
  }

  return {
    id: `mcp:${mcpTool.serverId}:${mcpTool.name}`,
    name: mcpTool.name,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    parameters,
    parameterSchema: toJsonSchemaObject(mcpTool.inputSchema),
    enabled: true,
    autoExecute: false,
    permissionGuard: 'permission-gated',
    category: 'custom',
    icon: 'mcp',
  }
}

export function mcpRouterToCoreToolDefinition(
  router: MCPModelFacingToolDefinition = getMCPRouterDefinition(),
): CoreMCPToolDefinition {
  return {
    id: MCP_ROUTER_TOOL_ID,
    name: 'MCP Search',
    description: router.description,
    parameters: router.parameters.map(param => ({
      name: param.name,
      type: mapJsonSchemaToolParameterType(param.type),
      description: param.description,
      required: param.required,
      enum: param.enum,
    })),
    parameterSchema: router.parameterSchema,
    enabled: true,
    autoExecute: false,
    permissionGuard: 'permission-gated',
    executionMode: 'sequential',
    renderKind: 'text',
    category: 'custom',
    icon: 'mcp',
    source: 'mcp',
  }
}
