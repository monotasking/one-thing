import type { CorePluginAPIState } from './plugin-api-state.js'
import type {
  CorePluginToolContext,
  CorePluginToolDefinition,
  CorePluginToolResult,
} from './plugin-api-types.js'
import { createPluginApiBuildContext, type CreateCorePluginAPIOptions } from './plugin-api-context.js'
import { buildPluginApiCapabilities } from './plugin-api-build-capabilities.js'
import { buildPluginApiSessions } from './plugin-api-build-sessions.js'
import { buildPluginApiUi } from './plugin-api-build-ui.js'
import { buildPluginApiStorage } from './plugin-api-build-storage.js'
import { buildPluginApiRegistries } from './plugin-api-build-registries.js'

// 宿主端口表与建造选项两个形状住在 `plugin-api-context.ts`(大文件拆分批 2);这只文件的深键
// `./plugin/plugin-api-builder` 照旧以同样的名字交出它们。
export type { CorePluginAPIHost, CorePluginAPILogger, CreateCorePluginAPIOptions } from './plugin-api-context.js'

export interface CorePluginHostToolContext<TMetadata extends object = object> {
  sessionId: string
  messageId: string
  toolCallId?: string
  /** F4:回合归属的 agent(纯透传;见 CorePluginToolContext.agentId)。 */
  agentId?: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  metadata?(input: { title?: string; metadata?: Partial<TMetadata> }): void
}

export interface CorePluginHostToolResult<TMetadata extends object = object> {
  title: string
  output: string
  metadata: TMetadata
  /** N6: end the agent loop after this turn's tools all settle (graceful wrap-up). */
  terminate?: boolean
}

export async function executeCorePluginTool<
  TParameters,
  TArgs,
  TMetadata extends object,
  TPluginContext extends CorePluginToolContext<TMetadata>,
  TResult extends CorePluginToolResult<TMetadata>,
>(
  tool: CorePluginToolDefinition<TParameters, TArgs, TPluginContext, TResult>,
  args: TArgs,
  hostContext: CorePluginHostToolContext<TMetadata>,
): Promise<CorePluginHostToolResult<TMetadata>> {
  const pluginContext = {
    sessionId: hostContext.sessionId,
    messageId: hostContext.messageId,
    toolCallId: hostContext.toolCallId ?? '',
    agentId: hostContext.agentId,
    workingDirectory: hostContext.workingDirectory,
    abortSignal: hostContext.abortSignal,
    metadata(input: { title?: string; metadata?: Partial<TMetadata> }) {
      hostContext.metadata?.(input)
    },
  } as TPluginContext
  const result = await tool.execute(args, pluginContext)
  return {
    title: result.title,
    output: result.output,
    metadata: result.metadata,
    // N6: forward the plugin's terminate signal to the agent-loop consumer.
    ...(result.terminate ? { terminate: true } : {}),
  }
}

/**
 * 建一只插件的 `api` 对象与它的拆除账(`state`)。
 *
 * 拆分前这是一只 1540 行的闭包;现在它只做三件事:建上下文(`plugin-api-context.ts`)、调五只按面分的
 * 建造件(`plugin-api-build-*.ts`)、按**拆分前那只对象字面量的键序**一格一格拼起来。键序照抄而不是
 * `{ ...a, ...b }` 展开:`Object.keys(api)` 的顺序是看得见的,五个面在原来的字面量里是交错排的。
 */
export function createCorePluginAPI<
  TApi,
  TTool extends { name: string },
  TEventHandler extends (...args: any[]) => any,
  TCommand,
  TCommandOptions extends object,
  TPromptContextProvider,
  TBeforeContextCompactHook,
  TAfterAssistantResponseHook,
  TSkillRootProvider,
  TStore,
  TScheduler,
>(
  options: CreateCorePluginAPIOptions<
    TTool,
    TEventHandler,
    TCommand,
    TPromptContextProvider,
    TBeforeContextCompactHook,
    TAfterAssistantResponseHook,
    TSkillRootProvider,
    TStore,
    TScheduler
  >,
): { api: TApi; state: CorePluginAPIState<TApi, TCommand> } {
  type Args = {
    api: TApi
    tool: TTool
    eventHandler: TEventHandler
    command: TCommand
    commandOptions: TCommandOptions
    promptContextProvider: TPromptContextProvider
    beforeContextCompactHook: TBeforeContextCompactHook
    afterAssistantResponseHook: TAfterAssistantResponseHook
    skillRootProvider: TSkillRootProvider
    store: TStore
    scheduler: TScheduler
  }
  const ctx = createPluginApiBuildContext<Args>(options)
  const capabilities = buildPluginApiCapabilities(ctx)
  const sessions = buildPluginApiSessions(ctx)
  const ui = buildPluginApiUi(ctx)
  const storage = buildPluginApiStorage(ctx)
  const registries = buildPluginApiRegistries(ctx)

  const api = {
    id: ctx.pluginId,
    registerTool: capabilities.registerTool,
    on: capabilities.on,
    steer: sessions.steer,
    followUp: sessions.followUp,
    sendMessage: sessions.sendMessage,
    sessions: sessions.sessions,
    isIdle: sessions.isIdle,
    llm: sessions.llm,
    resources: sessions.resources,
    registerCommand: capabilities.registerCommand,
    registerPromptContextProvider: capabilities.registerPromptContextProvider,
    beforeContextCompact: capabilities.beforeContextCompact,
    afterAssistantResponse: capabilities.afterAssistantResponse,
    interceptInput: capabilities.interceptInput,
    interceptToolCall: capabilities.interceptToolCall,
    interceptToolResult: capabilities.interceptToolResult,
    registerSkillRoot: capabilities.registerSkillRoot,
    registerRequestHandler: capabilities.registerRequestHandler,
    settings: storage.settings,
    registerWorkspacePanel: ui.registerWorkspacePanel,
    registerUiSlot: ui.registerUiSlot,
    events: ui.events,
    onDispose: capabilities.onDispose,
    store: storage.store,
    storage: storage.storage,
    scheduler: capabilities.scheduler,
    status: ui.status,
    registerIMConnector: registries.registerIMConnector,
    registerSearchProvider: registries.registerSearchProvider,
    registerDeepLinkAction: registries.registerDeepLinkAction,
    registerCredentialStrategy: registries.registerCredentialStrategy,
    theme: ui.theme,
    ui: ui.ui,
  } as unknown as TApi

  ctx.state.api = api
  return { api, state: ctx.state }
}
