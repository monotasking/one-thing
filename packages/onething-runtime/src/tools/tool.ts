import { z } from 'zod'
import type {
  JsonObject,
  JsonValue,
} from '@onething/core'
import type { ToolEffect, ToolPreview } from '@onething/core/tools'
import type { Principal } from '@onething/core/permission'
import type { CoreToolPromptContribution } from '@onething/core/engine'

type JsonObjectProperty = JsonValue | undefined
interface JsonSchemaObject extends JsonObject {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaObject>
  items?: JsonSchemaObject
  required?: string[]
  enum?: JsonValue[]
}

export type ToolMetadata = object
export type ToolExecutionMode = 'parallel' | 'sequential'
export type ToolRenderShell = 'default' | 'self'
export type ToolRenderKind = 'text' | 'bash' | 'diff' | 'file' | 'search' | 'image' | 'custom'

export interface ToolResultContentPart {
  type: 'text' | 'image' | 'file'
  text?: string
  data?: string
  mimeType?: string
  path?: string
}

export interface CanonicalToolResult<TDetails = JsonObject | undefined> {
  content: ToolResultContentPart[]
  details?: TDetails
  terminate?: boolean
}

export type ToolPartialResultUpdate<TDetails = JsonObject | undefined> = CanonicalToolResult<TDetails>

export interface ToolStep {
  id: string
  type: 'skill-read' | 'tool-call' | 'thinking' | 'file-read' | 'file-write' | 'command'
  title: string
  description?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'awaiting-confirmation' | 'cancelled'
  timestamp: number
  turnIndex?: number
  toolCallId?: string
  toolCall?: unknown
  thinking?: string
  result?: string
  partialResult?: ToolPartialResultUpdate
  partialResultIsPartial?: boolean
  summary?: string
  error?: string
  rejected?: boolean
  rejectionReason?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

export interface InitContext {
  agents?: Array<{ id: string; name: string; description: string }>
  workspace?: { id: string; name: string }
  agent?: {
    id: string
    name: string
    permissions?: {
      skill?: Record<string, 'allow' | 'ask' | 'deny'>
    }
  }
  skills?: Array<{
    id: string
    name: string
    description: string
    source: 'user' | 'project' | 'plugin' | 'builtin' | 'custom'
    category?: string
    tags?: string[]
    relatedSkills?: string[]
    platforms?: string[]
    conditions?: {
      fallbackForToolsets?: string[]
      requiresToolsets?: string[]
      fallbackForTools?: string[]
      requiresTools?: string[]
    }
    path: string
    directoryPath: string
    rootPath?: string
    relativePath?: string
    enabled: boolean
    instructions: string
    runtimeContext?: string
    files?: Array<{ name: string; path: string; type: string }>
  }>
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  providerId?: string
  providerConfig?: {
    apiKey: string
    baseUrl?: string
    model: string
  }
}

export interface ToolContext<M extends ToolMetadata = ToolMetadata> {
  sessionId: string
  messageId: string
  toolCallId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  abortSignal?: AbortSignal
  /**
   * Who is running this tool, minted at the engine boundary. Collab tools
   * (say/board/dm/history/notebook) each reverse-look-up an actor from
   * `session.agentId` today; this is the field that lets them share one answer.
   */
  principal?: Principal
  /**
   * 这一回合归属的 agent(F4 身份面)。与 `principal` **不是**一回事:principal 是
   * 被证明过的行动主体(权限判定用,拿不出证明就落到 system),`agentId` 是这一
   * 回合的身份归属 —— 回合入口解析好的 `preparation.agentId`,提示词与插件看到
   * 的是同一个值。判权限只准看 principal;分作用域(插件的 agent scope)看这个。
   */
  agentId?: string
  metadata(input: { title?: string; metadata?: Partial<M> }): void
  updateResult?(input: ToolPartialResultUpdate): void
  onStepStart?: (step: ToolStep) => void
  onStepComplete?: (step: ToolStep) => void
  beforeSideEffect?: () => Promise<void>
  approvedAnalysis?: { effects: ToolEffect[]; preview?: ToolPreview }
}

export interface ToolResult<M extends ToolMetadata = ToolMetadata> {
  title: string
  output: string
  metadata: M
  attachments?: Array<{
    type: 'file' | 'image'
    path: string
    content?: string
    mimeType?: string
  }>
  /**
   * N6:工具结果直接结束 agent loop。为 true 时,这一轮同批工具照常全部跑完
   * (不中断在飞的兄弟工具),但本轮结束后不再请求下一次 LLM —— 优雅收尾,
   * 用于"模型给出结构化终答后无需再多跑一轮"的场景。
   */
  terminate?: boolean
}

export interface ToolInfo<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> {
  id: string
  name: string
  description: string
  category: 'builtin' | 'custom' | 'mcp'
  parameters: P
  enabled?: boolean
  autoExecute?: boolean
  analyze?(args: z.infer<P>, ctx: ToolContext<M>): Promise<{ effects: ToolEffect[]; preview?: ToolPreview }> | { effects: ToolEffect[]; preview?: ToolPreview }
  executionMode?: ToolExecutionMode
  renderShell?: ToolRenderShell
  renderKind?: ToolRenderKind
  permissionGuard?: 'safe' | 'sandboxed' | 'internal-check' | 'permission-gated' | 'external'
  /**
   * The prompt this tool brings with it (guideline bullets, workspace-rule
   * bullets, standalone sections). It travels with the tool: on the surface
   * → injected, off the surface / disabled / unregistered → gone. Static by
   * design — see `CoreToolPromptContribution`.
   */
  prompt?: CoreToolPromptContribution
  execute(args: z.infer<P>, ctx: ToolContext<M>): Promise<ToolResult<M>>
  formatValidationError?(error: z.ZodError): string
}

export type ToolConfig<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> = Omit<ToolInfo<P, M>, 'id'>

export interface ToolInitResult<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> {
  description: string
  parameters: P
  analyze?(args: z.infer<P>, ctx: ToolContext<M>): Promise<{ effects: ToolEffect[]; preview?: ToolPreview }> | { effects: ToolEffect[]; preview?: ToolPreview }
  executionMode?: ToolExecutionMode
  renderShell?: ToolRenderShell
  renderKind?: ToolRenderKind
  execute(args: z.infer<P>, ctx: ToolContext<M>): Promise<ToolResult<M>>
  formatValidationError?(error: z.ZodError): string
}

export interface ToolInfoAsync<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> {
  id: string
  name: string
  category: 'builtin' | 'custom' | 'mcp'
  enabled?: boolean
  autoExecute?: boolean
  permissionGuard?: ToolInfo['permissionGuard']
  executionMode?: ToolExecutionMode
  renderShell?: ToolRenderShell
  renderKind?: ToolRenderKind
  /** Same as `ToolInfo.prompt`; declared up front, not in `init` — the prompt must not wait for I/O. */
  prompt?: CoreToolPromptContribution
  init: (ctx?: InitContext) => Promise<ToolInitResult<P, M>>
  _initialized?: ToolInitResult<P, M>
}

export type ToolInfoUnion<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> = ToolInfo<P, M> | ToolInfoAsync<P, M>

export function isAsyncTool<P extends z.ZodType, M extends ToolMetadata>(
  tool: ToolInfoUnion<P, M>,
): tool is ToolInfoAsync<P, M> {
  return 'init' in tool && typeof tool.init === 'function'
}

export namespace Tool {
  export type Metadata = ToolMetadata
  export type Context<M extends ToolMetadata = ToolMetadata> = ToolContext<M>
  export type Result<M extends ToolMetadata = ToolMetadata> = ToolResult<M>
  export type Info<P extends z.ZodType = z.ZodType, M extends ToolMetadata = ToolMetadata> = ToolInfo<P, M>
  export type InfoAsync<P extends z.ZodType = z.ZodType, M extends ToolMetadata = ToolMetadata> = ToolInfoAsync<P, M>
  export type InfoUnion<P extends z.ZodType = z.ZodType, M extends ToolMetadata = ToolMetadata> = ToolInfoUnion<P, M>
  export type InitResult<P extends z.ZodType = z.ZodType, M extends ToolMetadata = ToolMetadata> = ToolInitResult<P, M>

  export interface AsyncConfig {
    name: string
    category: 'builtin' | 'custom' | 'mcp'
    enabled?: boolean
    autoExecute?: boolean
    permissionGuard?: ToolInfo['permissionGuard']
    executionMode?: ToolExecutionMode
    renderShell?: ToolRenderShell
    renderKind?: ToolRenderKind
    prompt?: CoreToolPromptContribution
  }

  export function define<P extends z.ZodType, M extends ToolMetadata = ToolMetadata>(
    id: string,
    config: ToolConfig<P, M>,
  ): ToolInfo<P, M>
  export function define<P extends z.ZodType, M extends ToolMetadata = ToolMetadata>(
    id: string,
    config: AsyncConfig,
    init: (ctx?: InitContext) => Promise<ToolInitResult<P, M>>,
  ): ToolInfoAsync<P, M>
  export function define<P extends z.ZodType, M extends ToolMetadata = ToolMetadata>(
    id: string,
    config: ToolConfig<P, M> | AsyncConfig,
    init?: (ctx?: InitContext) => Promise<ToolInitResult<P, M>>,
  ): ToolInfo<P, M> | ToolInfoAsync<P, M> {
    if (init) {
      return {
        id,
        name: config.name,
        category: config.category,
        enabled: config.enabled ?? true,
        autoExecute: config.autoExecute ?? false,
        permissionGuard: config.permissionGuard,
        executionMode: config.executionMode,
        renderShell: config.renderShell,
        renderKind: config.renderKind,
        prompt: config.prompt,
        init,
      } as ToolInfoAsync<P, M>
    }

    const staticConfig = config as ToolConfig<P, M>
    return {
      id,
      ...staticConfig,
      enabled: staticConfig.enabled ?? true,
      autoExecute: staticConfig.autoExecute ?? false,
    }
  }

  export async function initialize<P extends z.ZodType, M extends ToolMetadata>(
    tool: ToolInfoAsync<P, M>,
    ctx?: InitContext,
  ): Promise<ToolInitResult<P, M>> {
    if (tool._initialized) return tool._initialized
    const result = await tool.init(ctx)
    tool._initialized = result
    return result
  }

  export function getInitialized<P extends z.ZodType, M extends ToolMetadata>(
    tool: ToolInfoAsync<P, M>,
  ): ToolInitResult<P, M> {
    if (!tool._initialized) {
      throw new Error(`Tool "${tool.id}" has not been initialized. Call Tool.initialize() first.`)
    }
    return tool._initialized
  }

  export function resetInit<P extends z.ZodType, M extends ToolMetadata>(
    tool: ToolInfoAsync<P, M>,
  ): void {
    tool._initialized = undefined
  }

  export function validateArgs<P extends z.ZodType>(
    tool: ToolInfo<P>,
    args: JsonValue | undefined,
  ): z.infer<P> {
    return tool.parameters.parse(args)
  }

  export function safeValidateArgs<P extends z.ZodType>(
    tool: ToolInfo<P>,
    args: JsonValue | undefined,
  ): { success: true; data: z.infer<P> } | { success: false; error: z.ZodError } {
    const result = tool.parameters.safeParse(args)
    if (result.success) return { success: true, data: result.data }
    return { success: false, error: result.error }
  }

  export async function execute<P extends z.ZodType, M extends ToolMetadata>(
    tool: ToolInfo<P, M>,
    args: JsonValue | undefined,
    ctx: ToolContext<M>,
  ): Promise<ToolResult<M>> {
    return tool.execute(validateArgs(tool, args), ctx)
  }

  export function noopMetadata(): (input: { title?: string; metadata?: Partial<ToolMetadata> }) => void {
    return () => {}
  }

  export function createTestContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 'test-session',
      messageId: 'test-message',
      metadata: noopMetadata(),
      ...overrides,
    }
  }
}

function jsonSchemaProperties(value: JsonObjectProperty): Record<string, JsonSchemaObject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const properties: Record<string, JsonSchemaObject> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      properties[key] = item as JsonSchemaObject
    }
  }
  return properties
}

function jsonSchemaRequired(value: JsonObjectProperty): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function zodToJsonSchema(schema: z.ZodType): {
  type: 'object'
  properties: Record<string, JsonSchemaObject>
  required: string[]
} {
  try {
    const schemaWithMethod = schema as z.ZodType & { toJSONSchema?: () => JsonObject }
    if (typeof schemaWithMethod.toJSONSchema === 'function') {
      const jsonSchema = schemaWithMethod.toJSONSchema() as JsonObject
      return {
        type: 'object',
        properties: jsonSchemaProperties(jsonSchema.properties),
        required: jsonSchemaRequired(jsonSchema.required),
      }
    }

    console.warn('[zodToJsonSchema] Schema does not have toJSONSchema method')
    return { type: 'object', properties: {}, required: [] }
  } catch (error) {
    console.error('[zodToJsonSchema] Error converting schema:', error)
    return { type: 'object', properties: {}, required: [] }
  }
}
