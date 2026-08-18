/**
 * R3a 家族基类 —— `ExternalTool` / `PluginTool` / `McpTool`(§4 的第十族)。
 *
 * 尺子⑥ 的兑现点:**注册表里只有一种工具**。插件工具与 MCP 工具今天各自是一条
 * 独立分支(`app/plugins/api.ts` 把插件 def 包成 `Tool.define`,MCP 在
 * `core/engine/direct-tool-execution.ts` 里是 `isMCPTool → buildMCPPermissionPlan
 * → executeMCPTool` 一整支 if),对 Catalog / Surface / Runner / Authorizer 来说
 * 它们现在只是两个普通的 `Tool` 子类。
 *
 * **插件的对外契约一个字不改**(§9):`api.registerTool(def)` 收的仍是
 * `{ name, description, parameters, execute, executionMode?, prompt? }`,插件不需要
 * 理解 plan/apply。映射发生在这里。
 *
 * 失败隔离(超时 / 上报 / 断路器计数)收在这一族一处。**默认不设超时** ——
 * 今天 `executeCorePluginTool` 与 `executeMCPTool` 都没有工具级的表,凭空加一个
 * 会让一批本来跑得完的调用开始失败;端口留着,由装配层按 R2b 的判据决定。
 */

import { Intent, makeEffect, Tool } from '@onething/core/toolkit'
import type {
  Effect,
  JsonSchema,
  PlanContext,
  PrepareEnv,
  Preview,
  Result,
  RunContext,
  ToolSpec,
} from '@onething/core/toolkit'
import { toJsonObject, type JsonObject } from '@onething/core'
import type { CoreToolPromptContribution } from '@onething/core/engine'
import type { z } from 'zod'
import { defineInput } from '../contract.js'

/** 失败隔离的上报口。形状与 `app/plugins/health.ts` 的两个回调同构。 */
export interface ExternalToolReporter {
  onFailure?(input: { toolId: string; scope: string; error: unknown }): void
  onSuccess?(input: { toolId: string; scope: string }): void
}

export interface ExternalToolIsolation {
  readonly reporter?: ExternalToolReporter
  /** 工具级超时。**缺省不设** —— 见文件头。 */
  readonly timeoutMs?: number
}

export abstract class ExternalTool<In, Payload = In> extends Tool<In, Payload> {
  protected readonly isolation: ExternalToolIsolation

  constructor(isolation: ExternalToolIsolation = {}) {
    super()
    this.isolation = isolation
  }

  /**
   * 跑一段外部代码:可选的超时子作用域 + 成败上报。
   *
   * 超时用 `ctx.abort.child({ timeoutMs })` 而不是自己 `setTimeout`:它到点抛的是
   * `ToolTimeoutError`,归因与"用户按了停止"分得开(见 `core/toolkit/outcome.ts`)。
   */
  protected async isolate<T>(
    ctx: RunContext,
    scope: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.isolation.timeoutMs
    const view = timeoutMs === undefined ? ctx.abort : ctx.abort.child({ timeoutMs })
    try {
      const value = await view.race(run(view.signal))
      this.isolation.reporter?.onSuccess?.({ toolId: this.spec.id, scope })
      return value
    } catch (error) {
      this.isolation.reporter?.onFailure?.({ toolId: this.spec.id, scope, error })
      throw error
    }
  }
}

// ── 插件工具 ────────────────────────────────────────────────────────────────

/**
 * 插件工具的执行面。形状与 `core/plugins/api-builder.ts` 的
 * `CorePluginHostToolContext` / `CorePluginHostToolResult` 逐字同构 —— 装配层把
 * `executeCorePluginTool` 直接接进来,产品层不认识插件运行时。
 */
export interface PluginToolHostResult {
  title: string
  output: string
  metadata: object
  terminate?: boolean
}

export interface PluginToolHostContext {
  sessionId: string
  messageId: string
  toolCallId?: string
  agentId?: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  metadata?(input: { title?: string; metadata?: Partial<object> }): void
}

export interface PluginToolDefinitionLike {
  name: string
  description: string
  /** 插件写的 zod schema。契约层照旧只认 zod。 */
  parameters: unknown
  executionMode?: 'parallel' | 'sequential'
  prompt?: CoreToolPromptContribution
}

export interface PluginToolAdapters {
  /** 注册进目录用的 id(`api.registerTool` 那一侧算好的,含插件命名空间)。 */
  readonly toolId: string
  readonly definition: PluginToolDefinitionLike
  /**
   * 装配层递进来的 `executeCorePluginTool` 门面。
   *
   * 参数与宿主 ctx 分开递,与 `executeCorePluginTool(tool, args, hostContext)`
   * 的签名同形 —— 把 args 折进 ctx 会让插件运行时那一侧多一次解包。
   */
  execute(args: JsonObject, ctx: PluginToolHostContext): Promise<PluginToolHostResult>
  readonly isolation?: ExternalToolIsolation
}

/**
 * 插件工具。
 *
 * **效果是一条 `plugin_exec`,恒 ask。** 旧路的等价物是
 * `permissionGuard: 'permission-gated'`(`app/plugins/api.ts` 写死的,插件填什么
 * 都会被覆盖:"插件不能给自己发免检通行证")。新树里 guard 是派生值,所以那句
 * 话必须由一条效果说出来 —— 用 `mcp` 冒充会在权限账本里把插件写成 MCP 服务器,
 * 所以 R3a 新增了 `plugin_exec` 这一个 kind,同一处给了策略行(ask + barrier)与
 * 派生表的那一格(→ `permission-gated`)。
 */
export class PluginTool extends ExternalTool<JsonObject, JsonObject> {
  readonly spec: ToolSpec
  private readonly adapters: PluginToolAdapters

  constructor(adapters: PluginToolAdapters) {
    super(adapters.isolation ?? {})
    this.adapters = adapters
    const definition = adapters.definition
    this.spec = {
      id: adapters.toolId,
      title: definition.name,
      description: definition.description,
      input: defineInput(definition.parameters as z.ZodType).schema,
      effects: ['plugin_exec'],
      presentation: { kind: 'text', shell: 'default' },
      // N3 的单读者不变:不声明 = 屏障 = 插件工具今天的行为,一字不改。
      concurrency: definition.executionMode ?? 'sequential',
      ...(definition.prompt ? { prompt: definition.prompt } : {}),
    }
  }

  async plan(input: JsonObject, _ctx: PlanContext): Promise<Intent<JsonObject>> {
    return Intent.of({
      effects: [makeEffect('plugin_exec', [this.spec.id], {
        barrier: true,
        metadata: { toolName: this.spec.id, arguments: input },
      })],
      preview: { title: `Run plugin tool: ${this.spec.title}`, metadata: { toolName: this.spec.id } },
      payload: input,
    })
  }

  async apply(intent: Intent<JsonObject>, ctx: RunContext): Promise<Result> {
    const result = await this.isolate(ctx, `tool:${this.spec.id}`, signal =>
      this.adapters.execute(intent.payload, {
        sessionId: ctx.invocation.sessionId,
        messageId: ctx.invocation.messageId ?? '',
        toolCallId: ctx.invocation.callId,
        ...(ctx.invocation.principal.kind === 'agent' ? { agentId: ctx.invocation.principal.agentId } : {}),
        ...(ctx.cwd ? { workingDirectory: ctx.cwd } : {}),
        abortSignal: signal,
        // 旧 ctx.metadata() 的等价出口:一条 annotate 事件。
        metadata: (update: { title?: string; metadata?: Partial<object> }) => {
          ctx.emit({
            type: 'annotate',
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.metadata ? { details: toJsonObject(update.metadata) } : {}),
          })
        },
      }))

    ctx.emit({ type: 'annotate', title: result.title, details: toJsonObject(result.metadata) })
    return {
      content: [{ type: 'text', text: result.output }],
      details: toJsonObject(result.metadata),
      ...(result.terminate ? { terminate: true } : {}),
    }
  }
}

// ── MCP 工具 ────────────────────────────────────────────────────────────────

/** 一个 MCP 工具的对外描述。装配层从 `core/mcp` 的 bridge 拿。 */
export interface McpToolDescription {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 已经是 JSON Schema —— MCP 的契约不由本地生产,所以不过 zod。 */
  readonly parameterSchema?: JsonSchema
}

export interface McpToolBridge {
  /** 懒初始化:连接 + 拉 schema。`prepare()` 唯一的调用点。 */
  describe(toolId: string): Promise<McpToolDescription | undefined> | McpToolDescription | undefined
  execute(
    toolId: string,
    args: JsonObject,
    options: { onPartialResult?(text: string, phase: string): void },
  ): Promise<unknown>
  /** grant 按服务器归属,不按裸工具名。 */
  resolveServerId?(toolRef: string): string | undefined
}

export interface McpToolAdapters {
  readonly toolId: string
  readonly bridge: McpToolBridge
  /** prepare 之前先用得上的那份描述(目录列表里已经有的话)。 */
  readonly initial?: McpToolDescription
  readonly isolation?: ExternalToolIsolation
}

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, required: [] }

/**
 * 判据与 `core/engine/tool-orchestration.ts` 的 `isMCPRouterToolName` /
 * `isReadOnlyMCPRouterCall` / `resolveMCPPermissionResourceName` /
 * `buildMCPPermissionPlan` **逐字相同**,在这里复制一份而不是 import。
 *
 * 理由与 R2a 决定⑥(`zodToJsonSchema` 搬家)同一条:那四个函数住在 §6 删除清单
 * 覆盖的那棵树里,新树对它的每一条 import 都是一根会在 R4 断掉的绳子。复制的是
 * 三十行纯函数,代价远小于一条跨树依赖。**旧文件一个字未动**。
 */
function isMcpRouterToolName(toolName: string): boolean {
  return toolName === 'mcp_search' || toolName === 'tool_function'
}

export function isReadOnlyMcpRouterCall(toolName: string, args: JsonObject): boolean {
  return isMcpRouterToolName(toolName) && args.action !== 'call'
}

export function resolveMcpPermissionResourceName(toolName: string, args: JsonObject): string {
  const routerResourceName = typeof args.tool === 'string'
    ? args.tool
    : typeof args.function === 'string' ? args.function : undefined
  return isMcpRouterToolName(toolName) && routerResourceName ? routerResourceName : toolName
}

export interface McpPermissionPlan {
  readonly resourceName: string
  readonly effects: Effect[]
  readonly preview: Preview
}

export function buildMcpPermissionPlan(
  toolName: string,
  args: JsonObject,
  options: { resolveServerId?(toolRef: string): string | undefined } = {},
): McpPermissionPlan | null {
  if (isReadOnlyMcpRouterCall(toolName, args)) return null

  const resourceName = resolveMcpPermissionResourceName(toolName, args)
  // Grants are keyed per server, not per bare tool name.
  const serverId = options.resolveServerId?.(resourceName)
  return {
    resourceName,
    effects: [makeEffect('mcp', [serverId ? `mcp:${serverId}:${resourceName}` : resourceName], {
      barrier: true,
      metadata: { toolName, arguments: args },
    })],
    preview: {
      title: `Call MCP tool: ${resourceName}`,
      metadata: { toolName, arguments: args },
    },
  }
}

export class McpTool extends ExternalTool<JsonObject, JsonObject> {
  private readonly adapters: McpToolAdapters
  private description?: McpToolDescription

  constructor(adapters: McpToolAdapters) {
    super(adapters.isolation ?? {})
    this.adapters = adapters
    this.description = adapters.initial
  }

  /** 懒初始化归 Catalog 管(只跑一次、并发安全)。这里只负责拉描述。 */
  async prepare(_env: PrepareEnv = {}): Promise<void> {
    const described = await this.adapters.bridge.describe(this.adapters.toolId)
    if (described) this.description = described
  }

  get spec(): ToolSpec {
    const described = this.description
    return {
      id: this.adapters.toolId,
      title: described?.name ?? this.adapters.toolId,
      description: described?.description ?? '',
      input: described?.parameterSchema ?? EMPTY_SCHEMA,
      effects: ['mcp'],
      presentation: { kind: 'text', shell: 'default' },
      concurrency: 'sequential',
    }
  }

  async plan(input: JsonObject, _ctx: PlanContext): Promise<Intent<JsonObject>> {
    const plan = buildMcpPermissionPlan(this.adapters.toolId, input, {
      ...(this.adapters.bridge.resolveServerId
        ? { resolveServerId: (ref: string) => this.adapters.bridge.resolveServerId?.(ref) }
        : {}),
    })
    // 只读的 router 调用(列目录、查签名)不惊动任何人 —— 与旧路 `null` 计划
    // 那一支逐字一致。
    if (!plan) return Intent.none(input)
    return Intent.of({ effects: plan.effects, preview: plan.preview, payload: input })
  }

  async apply(intent: Intent<JsonObject>, ctx: RunContext): Promise<Result> {
    const args = intent.payload
    const data = await this.isolate(ctx, `mcp:${this.adapters.toolId}`, () =>
      this.adapters.bridge.execute(this.adapters.toolId, args, {
        onPartialResult: (text, phase) => {
          // 旧 `buildMCPPartialResultUpdate` 的形状,逐字保留。
          ctx.emit({
            type: 'partial',
            result: {
              content: [{ type: 'text', text }],
              details: toJsonObject({
                phase,
                toolName: this.adapters.toolId,
                functionName: args.function,
              }),
            },
          })
        },
      }))

    return {
      content: [{ type: 'text', text: mcpResultText(data) }],
      details: toJsonObject(data as object),
    }
  }
}

/**
 * 模型看到的文本。与旧路 `toolResultView` 对 `{ success: true, data }` 的处理
 * 逐字一致:字符串原样、null/undefined 空串、其余 JSON 序列化(序列化炸了退回
 * `String(data)`,绝不抛错)。
 */
export function mcpResultText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data === undefined || data === null) return ''
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}
