import type { CorePluginAPIState } from './api-state.js'
import { toLogger, type CompatLogger } from '../logging/index.js'
import { describeToolPromptContributionProblem } from '../engine/prompt-fragments.js'
import {
  clampPluginBackgroundParamsPatch,
  describePluginRuntimeBackgroundImageProblem,
  type PluginBackgroundParamsPatch,
} from './background.js'
import { deepFreezeCorePluginValue } from './freeze.js'
import {
  PLUGIN_NOTIFY_SOUNDS,
  normalizePluginNotifySound,
  type PluginNotifyOptions,
  type PluginNotifySound,
} from './notify-sound.js'
import { PluginStorageError, type CorePluginMessageStateStore, type CorePluginStorage } from './storage.js'
import { getPluginFilesFaultLane } from './storage-files.js'
import type {
  CorePluginFileEntry,
  CorePluginFiles,
  CorePluginFilesOptions,
  CorePluginFilesReadOptions,
  CorePluginFilesUsage,
} from './storage-files.js'
import {
  PLUGIN_PANEL_INIT_ACTION,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_RENDER_ACTION,
  isReservedPluginPanelAction,
  type CorePluginPanelContext,
  type CorePluginPanelRegistration,
} from './panel.js'
import {
  PLUGIN_LAYOUT_GESTURE_WINDOW_MS,
  PLUGIN_UI_INVOKE_ACTION,
  PLUGIN_UI_RENDER_ACTION,
  hasFreshUiActionGesture,
  isReservedPluginUiAction,
  isUiAnchor,
  isUiDrawerRenderState,
  noteUiActionGesture,
  uiSlotAddress,
  uiSlotSurfaceId,
  type CorePluginUiSlotContext,
  type CorePluginUiSlotRegistration,
  type PluginLayoutResult,
  type PluginLayoutVerb,
} from './ui-anchor.js'
import {
  PLUGIN_PERMISSION_INPUT_INTERCEPT,
  type PluginInputInterceptHandler,
} from './input-intercept.js'
import {
  PLUGIN_PERMISSION_TOOLCALL_INTERCEPT,
  type PluginToolCallInterceptHandler,
} from './tool-call-intercept.js'
import {
  PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT,
  type PluginToolResultInterceptHandler,
} from './tool-result-intercept.js'
import {
  PLUGIN_PERMISSION_SESSIONS_PEEK,
  PLUGIN_PERMISSION_SESSIONS_POST,
  PLUGIN_PERMISSION_SESSIONS_TRIGGER,
  pluginDeliveryStartsTurn,
  resolvePluginDelivery,
  type PluginSendMessageOptions,
  type PluginSendMessageResult,
  type PluginSessionPeek,
  type PluginSessionPeekLite,
} from './sessions.js'
import {
  PLUGIN_PERMISSION_LLM_COMPLETE,
  PluginLlmError,
  normalizePluginLlmMessages,
  type PluginLlmCompleteOptions,
  type PluginLlmCompleteResult,
} from './llm.js'
import type { CorePluginStatusPart, CorePluginStatusRegistry } from './status.js'
import { pluginScope, type PluginFailureScope } from './policy.js'
import {
  assertPluginPayloadSerializable,
  normalizePluginRequestAction,
  type CorePluginRequestContext,
  type CorePluginRequestHandler,
} from './request-channel.js'
import { assertCorePluginToolExecutionMode } from './tool-execution-mode.js'
import {
  PLUGIN_PERMISSION_SEARCH_PROVIDE,
  type CorePluginSearchProviderRegistration,
} from './search-provider.js'
import {
  PLUGIN_DEEPLINK_ACTION_NAME_PATTERN,
  PLUGIN_PERMISSION_DEEPLINK_HANDLE,
  pluginDeepLinkAddress,
  type CorePluginDeepLinkActionRegistration,
} from './deep-link.js'
import {
  PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN,
  PLUGIN_PERMISSION_CREDENTIAL_STRATEGY,
  pluginCredentialStrategyPolicy,
  type CorePluginCredentialStrategyRegistration,
} from './credential-strategy.js'
import type {
  CorePluginToolContext,
  CorePluginToolDefinition,
  CorePluginToolResult,
} from './types.js'

/** @deprecated 统一为 `Logger`(§8.3 区 ①);过渡期仍收老鸭子形状。 */
export type CorePluginAPILogger = CompatLogger

export interface CorePluginAPIHost<
  TTool extends { name: string },
  TEventHandler extends (...args: any[]) => any,
  TPromptContextProvider,
  TBeforeContextCompactHook,
  TAfterAssistantResponseHook,
  TSkillRootProvider,
> {
  registerTool(pluginId: string, toolId: string, tool: TTool): void
  subscribeEvent(pluginId: string, eventType: string, handler: TEventHandler): () => void
  steer(pluginId: string, sessionId: string, content: string): void
  followUp(pluginId: string, sessionId: string, content: string): void
  /**
   * `sound` 是 M1 追加的**可选**第四参:core 已归一到枚举成员('none' = 不出声)。
   * 老宿主实现不读它就是今天的行为,加法不破坏任何既有调用点。
   */
  notify(pluginId: string, message: string, level: 'info' | 'warn' | 'error', sound?: PluginNotifySound): void
  registerPromptContextProvider(pluginId: string, id: string, provider: TPromptContextProvider): () => void
  registerBeforeContextCompactHook(pluginId: string, id: string, hook: TBeforeContextCompactHook): () => void
  registerAfterAssistantResponseHook(pluginId: string, id: string, hook: TAfterAssistantResponseHook): () => void
  /**
   * 发送前拦截链的登记口(N2)—— 第一个**干预型**钩子。
   *
   * 与 lifecycle 钩子同构:core 只做声明门与登记,链的次序 / 预算 / fail-open /
   * 熔断闸全在注册表(`CorePluginInputInterceptRegistry`),挂点在装配层的引擎。
   * 宿主没接这条线(headless / server 不跑插件)时 `api.interceptInput` 报错并
   * 拒绝注册,而不是静默假装注册成功 —— 那正是 pi 的死订阅。
   */
  registerInputInterceptHook?(pluginId: string, id: string, handler: PluginInputInterceptHandler): () => void
  /**
   * 工具调用拦截链的登记口(N4)—— 第二个**干预型**钩子。
   *
   * 与 `registerInputInterceptHook` 同构:core 只做声明门与登记,链的次序 /
   * 预算 / fail-closed / 熔断闸全在注册表(`CorePluginToolCallInterceptRegistry`),
   * 挂点在工具执行的唯一必经点。宿主没接这条线时 `api.interceptToolCall` 报错
   * 并拒绝注册 —— 在一条安全链上,"以为自己装了守卫其实没装"是最坏的结局。
   */
  registerToolCallInterceptHook?(pluginId: string, id: string, handler: PluginToolCallInterceptHandler): () => void
  /**
   * 工具结果改写链的登记口(N5)—— 第三个**干预型**钩子,`interceptToolCall` 的
   * fail-open 镜像。与 `registerToolCallInterceptHook` 同构:core 只做声明门与登记,
   * 链的次序 / 预算 / fail-open / 熔断闸全在注册表
   * (`CorePluginToolResultInterceptRegistry`),挂点在工具执行**之后**、结果回模型
   * 之前的对称位置。宿主没接这条线时 `api.interceptToolResult` 报错并拒绝注册。
   */
  registerToolResultInterceptHook?(pluginId: string, id: string, handler: PluginToolResultInterceptHandler): () => void
  registerSkillRoot(pluginId: string, provider: TSkillRootProvider): () => void
  invalidateSkillsCache?(): void | Promise<void>
  /**
   * 插件自定义事件出口。事件名由宿主统一加 `plugin:<pluginId>:` 前缀 ——
   * 命名空间不由插件自己保证,否则两个插件迟早撞名。
   */
  emitPluginEvent?(pluginId: string, eventName: string, payload: unknown): void
  /** 面板主动刷新的投递口(R5)——走既有的 plugin:notification 轨。 */
  emitPanelRefresh?(pluginId: string, panelId: string): void
  /**
   * 布局动词的投递口(I 期)——同样走既有的 plugin:notification 轨
   * (kind: 'layout'),不开第二条 IPC 家族。
   *
   * **不接 = `unsupported`**:CLI daemon 与 headless server 没有窗口,那里
   * "开合侧栏"不是失败,是不存在。core 据此回结构化拒绝,不抛错、不计熔断。
   * 手势闸在 core 判完才会走到这里 —— 宿主不必再判一次。
   */
  applyLayoutVerb?(pluginId: string, verb: PluginLayoutVerb, panelId?: string): void
  /**
   * 流状态的投递口(R6)——走既有的 `content:part` 会话事件。
   *
   * 宿主负责把它接到会话总线上;core 只管账与清扫语义。
   */
  emitPluginStatus?(pluginId: string, sessionId: string, part: CorePluginStatusPart): void
  /** 有被合并窗压住的状态变化 —— 宿主据此排一次 trailing flush。 */
  notePluginStatusPending?(): void
  /**
   * IM 连接器注册表的转发口(R7)。返回退订函数。
   *
   * 宿主注入;core 不认识渠道。开放下一个注册表时照抄这一行 + 在策略表里加条目。
   */
  registerIMConnector?(pluginId: string, connector: unknown): (() => void) | undefined
  /**
   * 搜索供给方注册表的转发口(M2)。返回退订函数。
   *
   * 宿主注入;core 不做并发/超时/熔断(那些要认识健康账本与搜索聚合器,住在
   * 装配层)。开放模式照抄 registerIMConnector 那一行 + 策略表加条目。
   */
  registerSearchProvider?(
    pluginId: string,
    registration: CorePluginSearchProviderRegistration,
  ): (() => void) | undefined
  /**
   * 深链动作注册表的转发口(H4)。返回退订函数。
   *
   * 宿主注入;core 不认识 URL scheme、不认识窗口,也不做超时/熔断(那些要认识
   * 健康账本与确认门,住在装配层 + Electron 宿主)。开放模式照抄
   * registerIMConnector 那一行 + 策略表加条目。
   */
  registerDeepLinkAction?(
    pluginId: string,
    registration: CorePluginDeepLinkActionRegistration & { name: string },
  ): (() => void) | undefined
  /**
   * 凭证策略注册表的转发口(批 E)。返回退订函数。
   *
   * 宿主注入;core 不认识空间、不认识凭证池、更不认识账本(超时 / 熔断 /
   * 脱敏投影 / 用量聚合全在装配层)。开放模式照抄 registerIMConnector 那一行 +
   * 策略表加条目。
   */
  registerCredentialStrategy?(
    pluginId: string,
    registration: CorePluginCredentialStrategyRegistration & { name: string },
  ): (() => void) | undefined
  /**
   * 插件自有配置的访问面(R3)。
   *
   * 宿主全权管理存储与校验;插件只读快照 —— 没有 registerSettings,
   * schema 的唯一事实源是 manifest 的 contributes.settings.schema。
   */
  getPluginConfig?(pluginId: string): Record<string, unknown>
  onPluginConfigChange?(
    pluginId: string,
    callback: (config: Record<string, unknown>) => void,
  ): () => void
  /**
   * 背景层运行期调参的落点(G 期,L2.5)。
   *
   * core 只做门控与钳制;"记在哪、什么时候广播"是宿主的事(装配层把它记进
   * 内存态并发一条 catalog-changed,renderer 照既有路径重拉清单)。
   * 宿主没接这条线(headless / server)时是安静的 no-op。
   */
  updatePluginBackground?(pluginId: string, patch: PluginBackgroundParamsPatch): void
  /**
   * 跨会话投递的落点(N1)。
   *
   * core 只做**声明门 + 矩阵判定 + 结果整形**;"目标忙不忙""起一轮走哪条命令"
   * "循环闸怎么记账"全在装配层 —— 那些事实住在产品层(引擎的活跃流、会话存储)。
   * 宿主没接这条线(headless / server)时 api.sendMessage 回 `unsupported`,
   * 而不是静默假装成功。
   */
  sendMessage?(
    pluginId: string,
    sessionId: string,
    content: string,
    options: PluginSendMessageOptions,
  ): Promise<PluginSendMessageResult>
  /** 单会话压缩快照(N1)。会话不存在回 null。 */
  peekSession?(pluginId: string, sessionId: string): Promise<PluginSessionPeek | null>
  /** 全会话 peek-lite(无 lastMessage),按 updatedAt 降序。 */
  listSessions?(pluginId: string): Promise<PluginSessionPeekLite[]>
  /**
   * 受管 LLM 调用的落点(N7-b)。
   *
   * 宿主做**受管三要素**(计费 `source = plugin:<id>` + 硬超时 + 配额)与 provider
   * 解析(复用宿主自己拿 provider+apiKey 的同一条路径);core 只做声明门 + 输入校验。
   * 插件永远拿不到 apiKey / registry。宿主没接这条线(headless / server)时
   * `api.llm.complete` 抛 `PluginLlmError('unsupported')`,而不是静默假装成功。
   */
  llmComplete?(pluginId: string, options: PluginLlmCompleteOptions): Promise<PluginLlmCompleteResult>
}

export interface CreateCorePluginAPIOptions<
  TTool extends { name: string },
  TEventHandler extends (...args: any[]) => any,
  TCommand,
  TPromptContextProvider,
  TBeforeContextCompactHook,
  TAfterAssistantResponseHook,
  TSkillRootProvider,
  TStore,
  TScheduler,
> {
  pluginId: string
  store: TStore
  /** 插件数据目录访问面(R4);路径/序列化守卫在 core 的 storage.ts。 */
  storage?: CorePluginStorage
  /**
   * 消息作用域状态存储(plugin-message-state-2026-08)。宿主按 manifest 的
   * lifetime 声明决定落盘(persistent)还是纯内存(ephemeral);不给 =
   * 本宿主没有消息态面,`api.storage.message()` 调用处抛(与 storage 缺席同规)。
   */
  messageState?: CorePluginMessageStateStore
  /**
   * F1 受管文件树(`api.storage.files`)。宿主注入;不给 = 本宿主没有这条线,
   * 调用处抛(与 storage / messageState 缺席同规:诚实降级,不假装成功)。
   */
  files?: CorePluginFiles
  /**
   * manifest 里声明过的面板 id(R5)。
   * registerWorkspacePanel 拿它做匹配 —— 声明先于代码,清单是权威。
   */
  declaredPanelIds?: string[]
  /**
   * 其中哪些是 **webview 形态**的面板(C 期,`contributes.panels[].view === 'webview'`)。
   *
   * 它决定 render 挂到哪个 action 名上:webview 面板的返回值是**初始化数据**
   * 而不是描述树,于是走 `panel:init:<id>`(通道守卫按前缀判定,不必反查形态)。
   * 不传 = 全是描述树面板(headless / 测试替身的自然缺省)。
   */
  declaredWebviewPanelIds?: string[]
  /**
   * manifest 里声明过的锚点块(R5.x)。
   * registerUiSlot 拿它做(anchor, id) 匹配 —— 与面板同一条"声明先于代码"。
   */
  declaredUiSlots?: Array<{ anchor: string; id: string }>
  /**
   * manifest 是否声明了 `contributes.theme.background`(G 期,L2.5)。
   *
   * `api.theme.updateBackground` 的**门控** —— 声明先于代码,与面板 id / 锚点块
   * 同一条规矩。缺省 false:没声明就调不动(headless / 测试替身的自然缺省)。
   */
  declaredBackground?: boolean
  /**
   * manifest 的 `contributes.permissions` 原文(N1)。
   *
   * 这是 `api.sendMessage` / `api.sessions.*` / `api.isIdle` 的**声明门** ——
   * 与面板 id / 锚点块 / 背景层同一条"声明先于代码"。缺省空:没声明就调不动
   * (headless / 测试替身的自然缺省)。未知的权限名一律**忽略**(向前兼容),
   * 只有被消费的那三个枚举参与判定。
   */
  declaredPermissions?: readonly string[]
  /**
   * 状态账本(R6)。宿主注入**同一个实例**给所有插件 —— 清扫按会话进行,
   * 每插件一本账就扫不干净。不注入时 api.status 是安静的 no-op(headless)。
   */
  statusRegistry?: CorePluginStatusRegistry
  scheduler: TScheduler
  disposeCallbacks?: Array<() => void>
  host: CorePluginAPIHost<
    TTool,
    TEventHandler,
    TPromptContextProvider,
    TBeforeContextCompactHook,
    TAfterAssistantResponseHook,
    TSkillRootProvider
  >
  logger?: CorePluginAPILogger
  /**
   * 运行期失败上报(事件 handler 抛错、steer/followUp/notify 抛错)。
   * 宿主拿它做失败计数熔断 —— 在这之前这些错只进 console,插件卡片永远 Active。
   */
  onPluginFailure?(input: { pluginId: string; scope: string; error: unknown }): void
  /**
   * 运行期成功上报,清同 scope 的连败账。
   * 事件 handler 是高频路径,这个回调必须零 IO 纯内存。
   */
  onPluginSuccess?(input: { pluginId: string; scope: string }): void
}

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
  const { pluginId, store, scheduler, host } = options
  const logger = toLogger(options.logger)
  // **签名收口**:scope 是品牌类型,只能由 pluginScope.* 工厂产出。
  // 写裸字符串在这里就编译不过 —— 这是"新增 scope 必须登记"的执行点,
  // 正则反查只当兜底(R7 第一版只有正则,npm-install 就那样漏了过去)。
  const reportFailure = (scope: PluginFailureScope, error: unknown): void => {
    options.onPluginFailure?.({ pluginId, scope, error })
  }
  const reportSuccess = (scope: PluginFailureScope): void => {
    options.onPluginSuccess?.({ pluginId, scope })
  }

  const unsubs: Array<() => void> = []
  const commands = new Map<string, TCommand>()
  const toolIds: string[] = []
  const skillRootUnsubs: Array<() => void> = []
  const promptContextUnsubs: Array<() => void> = []
  const lifecycleUnsubs: Array<() => void> = []
  const disposeCallbacks = options.disposeCallbacks ?? []

  // 晚到注册闸。
  //
  // entry(api) 超时之后宿主会把这份 state 拆掉,但那个 promise 并没有被取消 ——
  // 十分钟后它恢复过来照样能调 api.registerTool,而这份 state 已经不在
  // pluginStates 里,disposeAll() 永远摸不到它:那个工具就是个永久孤儿。
  // 置位后所有注册入口 no-op,并按插件归因 warn 一次。
  const requireStorage = (): CorePluginStorage => {
    if (!options.storage) {
      throw new Error(`Plugin "${pluginId}" has no storage surface on this host`)
    }
    return options.storage
  }
  const requireMessageState = (): CorePluginMessageStateStore => {
    if (!options.messageState) {
      throw new Error(`Plugin "${pluginId}" has no message-state surface on this host`)
    }
    return options.messageState
  }
  const requireFiles = (): CorePluginFiles => {
    if (!options.files) {
      throw new PluginStorageError(
        'unavailable',
        `Plugin "${pluginId}" has no managed file surface on this host`,
      )
    }
    return options.files
  }
  /**
   * 存储失败进熔断账,然后**继续抛给插件** —— 路径穿越这类错误必须让插件
   * 当场知道自己写错了,静默吞掉只会让它以为写成功了。
   *
   * scope 按**操作**分车道(`storage.writeJson` / `storage.readJson` / …),
   * 与 `request:<action>` 同一个先例:单车道会让 exists 的成功不断清掉
   * writeJson 的连败,插件级混计的假阴性会在 scope 内原样复现。
   */
  /**
   * **状态性拒绝不进熔断账**(2026-08-12,真机事故:memory-wiki 未配置外部根,
   * 注入面每轮 readText 一次 `not-configured` —— 插件自己接得干干净净,熔断账
   * 却已先记一笔,「全新安装还没配置」这个正常状态攒几轮就把插件熔断了)。
   *
   * 界线画在**谁的问题**上:`not-configured` 说的是「用户还没选目录」——不是
   * 插件的过错,把它记成失败等于"装了还没配置就该被杀"。而路径穿越(invalid-name)、
   * 未声明权限(not-declared)、超配额(quota)都是**插件侧的行为**,照记 ——
   * 与既有判例一致("books a traversal attempt into the breaker ledger")。
   * 状态性拒绝照样**抛**(调用方必须知道),照样打日志(warn 不是 error),只是不计数。
   *
   * **豁免面按车道判,不按 code 一刀切**(2026-08-12 补全):`not-configured` 只是
   * 状态性拒绝里最先被抓到的那一个,同一批还有 —— 用户把外部根里的文件 chmod 成
   * 不可读(`io`)、手编到 9MB(`quota`)、把 `index.md` 换成一个目录
   * (`invalid-name`)。这三条同样每 30s 复现一次,90 秒就能把插件熔断,而插件
   * 什么都没做错。
   *
   * 但同一个 code 在**家目录**里说的是另一件事(那是宿主发给插件的沙盒,里面的
   * 状态只可能是插件自己造的),按 code 豁免会连"路径穿越"一起放走。所以归属
   * 判定留在 `storage-files.ts` 抛错的那一侧(只有它知道寻址的是哪个根,也只有它
   * 知道这一条是路径判据还是文件状态),这里只读结论:`user` 车道 = 用户地盘的
   * 状态,抛而不记账。
   */
  const STORAGE_STATE_REFUSALS = new Set(['not-configured'])
  const withStorageFailureReport = <T>(what: string, run: () => T): T => {
    const scope = pluginScope.storage(what)
    try {
      const result = run()
      options.onPluginSuccess?.({ pluginId, scope })
      return result
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      const stateRefusal = (typeof code === 'string' && STORAGE_STATE_REFUSALS.has(code))
        || getPluginFilesFaultLane(error) === 'user'
      if (stateRefusal) {
        const label = typeof code === 'string' ? code : 'state'
        logger.debug(`[Plugin:${pluginId}] storage.${what} refused (${label}) — state refusal, not counted`)
        throw error
      }
      logger.error(`[Plugin:${pluginId}] storage.${what} failed:`, undefined, error)
      reportFailure(scope, error)
      throw error
    }
  }
  /**
   * 拆除之后的存储语义:**写面抛、读面退化**。
   *
   * 写面静默 no-op 是"假装写成功了",插件会以为数据落盘了;读面抛则会让
   * teardown 竞速里的一次无害读取把插件炸掉。dir() 归入写面 —— 它会建目录,
   * 而且返回 '' 会让插件的 path.join 落进进程 CWD。
   */
  const rejectDisposedWrite = (what: string): void => {
    // **onDispose 期间放行。** 插件最自然的收尾写法就是在 onDispose 里存盘;
    // 拒掉它等于让插件静默丢数据,而且报的错("插件已拆除")还会误导排查方向。
    if (state.disposing) return
    if (!state.disposed) return
    const error = new PluginStorageError(
      'unavailable',
      `Plugin "${pluginId}" was disposed; storage.${what} is no longer available`,
    )
    rejectLateCall(`storage.${what}`)
    throw error
  }

  const requestHandlers = new Map<string, CorePluginRequestHandler>()
  const configUnsubs: Array<() => void> = []

  const state: CorePluginAPIState<TApi, TCommand> = {
    api: undefined as unknown as TApi,
    unsubs,
    commands,
    requestHandlers,
    toolIds,
    skillRootUnsubs,
    promptContextUnsubs,
    lifecycleUnsubs,
    configUnsubs,
    disposeCallbacks,
    disposed: false,
  }
  let lateWarned = false
  const rejectLateCall = (what: string): boolean => {
    if (!state.disposed) return false
    if (!lateWarned) {
      lateWarned = true
      logger.error(
        `[Plugin:${pluginId}] Ignoring "${what}" after dispose — the plugin resumed past its teardown `
        + '(entry timeout or a late async callback). Further late calls are silently dropped.',
        undefined,
      )
    }
    return true
  }

  /**
   * manifest 声明过的权限(N1)。Set 而不是数组:门是逐次调用现查的热路径。
   * 未知的权限名照收不误 —— 只有被消费的那几个枚举参与判定(向前兼容)。
   */
  const declaredPermissions = new Set(options.declaredPermissions ?? [])

  /**
   * 读面的声明门。与写面同规:报错 + 拒绝,**不计熔断**(作者写错 manifest 不该
   * 连坐整个插件)。读面拒绝时回"空",而不是抛 —— 一次快照读取失败不该炸掉
   * 插件的整条执行路径。
   */
  const requireSessionsPeek = (what: string): boolean => {
    if (rejectLateCall(what)) return false
    if (declaredPermissions.has(PLUGIN_PERMISSION_SESSIONS_PEEK)) return true
    logger.error(
      `[Plugin:${pluginId}] ${what} requires "${PLUGIN_PERMISSION_SESSIONS_PEEK}" in `
      + 'contributes.permissions (plugin.json).',
      undefined,
    )
    return false
  }

  /**
   * 布局动词的**唯一**闸(I 期)。
   *
   * 三条判据按代价排序,全部是**规则拒绝**,一条都不计熔断 ——
   * 与声明门同规:插件没坏,是规则不让它这么干。
   *
   *  1. 拆除之后的晚到调用:静默丢(rejectLateCall 已经记过一条日志);
   *  2. 宿主没接这条线(CLI daemon / headless server 没有窗口):`unsupported`;
   *  3. 不在手势窗口里:`gesture-required`。
   *
   * 治理为什么是手势而不是 manifest 权限:一句"我要能开合侧栏"用户读不出
   * 它会在**什么时候**动;而"你刚点了它、它才动得了"是用户当场就能验证的
   * 因果 —— 把授权从一次性的申报挪到每一次的互动。
   */
  async function runLayoutVerb(
    verb: PluginLayoutVerb,
    panelId?: string,
  ): Promise<PluginLayoutResult> {
    if (rejectLateCall(`ui.${verb}`)) {
      return { ok: false, error: 'unsupported', reason: 'plugin was torn down' }
    }
    if (!host.applyLayoutVerb) {
      return { ok: false, error: 'unsupported', reason: 'this host has no window layout' }
    }
    if (!hasFreshUiActionGesture(pluginId)) {
      logger.error(
        `[Plugin:${pluginId}] ui.${verb} was refused: layout verbs only work within `
        + `${PLUGIN_LAYOUT_GESTURE_WINDOW_MS}ms of the user interacting with one of your `
        + 'ui slots (gesture anchoring). Call it from a ui slot onAction, not on a timer.',
        undefined,
      )
      return {
        ok: false,
        error: 'gesture-required',
        reason: `no user gesture on this plugin within ${PLUGIN_LAYOUT_GESTURE_WINDOW_MS}ms`,
      }
    }
    try {
      host.applyLayoutVerb(pluginId, verb, panelId)
      return { ok: true }
    } catch (error) {
      // 投递失败是**宿主侧**的故障,不是规则拒绝 —— 但也不该炸掉插件:
      // 与 notify 同规,记一条日志、回一份失败结果。
      logger.error(`[Plugin:${pluginId}] ui.${verb} failed:`, undefined, error)
      return { ok: false, error: 'unsupported', reason: 'host refused the layout command' }
    }
  }

  async function peekSessionForPlugin(sessionId: string): Promise<PluginSessionPeek | null> {
    if (!requireSessionsPeek('sessions.peek')) return null
    const targetId = String(sessionId ?? '').trim()
    if (!targetId || !host.peekSession) return null
    try {
      const peek = await host.peekSession(pluginId, targetId)
      return peek ? deepFreezeCorePluginValue(peek) : null
    } catch (error) {
      logger.error(`[Plugin:${pluginId}] sessions.peek error:`, undefined, error)
      return null
    }
  }

  const api = {
    id: pluginId,

    registerTool(tool: TTool): void {
      if (rejectLateCall('registerTool')) return
      const toolId = `plugin:${pluginId}:${tool.name}`
      try {
        // N3:并发声明是**这一个工具**的注册前提。非法值拒注册它一个
        // (插件其余的面照常),而不是静默降级成屏障 —— 降级安全,但作者
        // 把 'parallel' 拼错之后永远看不到任何线索。
        assertCorePluginToolExecutionMode(
          (tool as { executionMode?: unknown }).executionMode,
          tool.name,
        )
        // Same rule for the prompt it brings: an illegal declaration rejects
        // this one tool, loudly, instead of a silently mangled system prompt.
        const promptProblem = describeToolPromptContributionProblem(
          (tool as { prompt?: unknown }).prompt,
        )
        if (promptProblem) {
          throw new Error(`Tool "${tool.name}": ${promptProblem}`)
        }
        host.registerTool(pluginId, toolId, tool)
        if (!toolIds.includes(toolId)) {
          toolIds.push(toolId)
        }
        logger.debug(`[Plugin:${pluginId}] Registered tool: ${tool.name}`)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] Failed to register tool "${tool.name}":`, undefined, error)
      }
    },

    on(eventType: string, handler: TEventHandler): () => void {
      if (rejectLateCall('on')) return () => {}
      const scope = pluginScope.event(eventType)
      const onHandlerError = (error: unknown): void => {
        logger.error(`[Plugin:${pluginId}] Event handler error (${eventType}):`, undefined, error)
        reportFailure(scope, error)
      }
      const wrappedHandler = ((...args: unknown[]) => {
        // 事件面**不**在 dispose 窗口里放行:拆除中的插件不该再被喂新事件。
        // 放行的只有写面(storage / store),那是为了让 onDispose 能存盘。
        if (state.disposed) {
          // 拆除之后到达的事件不再进插件 —— 见 CorePluginAPIState.disposed。
          return
        }
        try {
          const result = handler(...args)
          if (result instanceof Promise) {
            result.then(() => reportSuccess(scope), onHandlerError)
          } else {
            reportSuccess(scope)
          }
        } catch (error) {
          onHandlerError(error)
        }
      }) as TEventHandler

      const unsub = host.subscribeEvent(pluginId, eventType, wrappedHandler)
      unsubs.push(unsub)
      return unsub
    },

    steer(sessionId: string, content: string): void {
      if (rejectLateCall('steer')) return
      try {
        host.steer(pluginId, sessionId, content)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] steer error:`, undefined, error)
        reportFailure(pluginScope.steer(), error)
      }
    },

    followUp(sessionId: string, content: string): void {
      if (rejectLateCall('followUp')) return
      try {
        host.followUp(pluginId, sessionId, content)
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] followUp error:`, undefined, error)
        reportFailure(pluginScope.followUp(), error)
      }
    },

    /**
     * 跨会话信使(N1)—— 三态投递矩阵,不是布尔。
     *
     *  - `{triggerTurn:true}`:目标空闲 → 起一轮;忙 → 降级为 steer。**不抛错**,
     *    结果里 `delivered` 如实说走了哪一格,`targetWasBusy` 说为什么。
     *  - `{triggerTurn:false}` / 缺省:持久化 + 显示,不起轮(fail-closed)。
     *  - `{deliverAs}`:显式选既有队列;`nextTurn` 诚实映射到 follow-up
     *    (引擎没有第三条队列,见 PLUGIN_DELIVER_AS_NOTES)。
     *
     * 声明门与循环闸的**拒绝都回结构化 reason**:插件感知得到自己被拒了。
     * 门本身不计熔断 —— 那是作者写错了 manifest,不该为一次笔误连坐整个插件
     * (与 theme.updateBackground 同规)。
     */
    async sendMessage(
      sessionId: string,
      content: string,
      options: PluginSendMessageOptions = {},
    ): Promise<PluginSendMessageResult> {
      if (rejectLateCall('sendMessage')) {
        return { ok: false, reason: 'unsupported', detail: 'plugin was disposed' }
      }
      const targetId = String(sessionId ?? '').trim()
      if (!targetId) return { ok: false, reason: 'unknown-session', detail: 'sessionId is required' }
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, reason: 'empty-content', detail: 'content must be a non-empty string' }
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_SESSIONS_POST)) {
        logger.error(
          `[Plugin:${pluginId}] sendMessage requires "${PLUGIN_PERMISSION_SESSIONS_POST}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page shows it to the user.',
          undefined,
        )
        return { ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_POST }
      }
      // 可能起轮的那一格要**额外**一档声明。判据是矩阵在最坏情况下的结果:
      // 目标此刻的忙闲由宿主说了算,但"空闲时会起轮"这件事在这里就已经确定。
      if (
        pluginDeliveryStartsTurn(resolvePluginDelivery(options, false))
        && !declaredPermissions.has(PLUGIN_PERMISSION_SESSIONS_TRIGGER)
      ) {
        logger.error(
          `[Plugin:${pluginId}] sendMessage({triggerTurn:true}) requires `
          + `"${PLUGIN_PERMISSION_SESSIONS_TRIGGER}" in contributes.permissions — starting a model turn `
          + 'spends the user\'s tokens, so it is its own declaration.',
          undefined,
        )
        return { ok: false, reason: 'not-declared', detail: PLUGIN_PERMISSION_SESSIONS_TRIGGER }
      }
      if (!host.sendMessage) {
        return { ok: false, reason: 'unsupported', detail: 'this host has no session delivery surface' }
      }
      const scope = pluginScope.sendMessage()
      try {
        const result = await host.sendMessage(pluginId, targetId, content, options ?? {})
        reportSuccess(scope)
        return result
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] sendMessage error:`, undefined, error)
        reportFailure(scope, error)
        return {
          ok: false,
          reason: 'error',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },

    /**
     * 感知快照(N1,架构图 §4 的修正)。
     *
     * 「A 知道 B 在干什么」是一个**压缩快照动词**,不是一条事件流:agent 想看
     * 才调,一句话级。事件流是给插件代码在 main 进程消化的,不进模型上下文。
     * 返回值全部来自现成内存态(零新统计),深冻结 + JSON-可序列化。
     */
    sessions: {
      peek: peekSessionForPlugin,
      async list(): Promise<PluginSessionPeekLite[]> {
        if (!requireSessionsPeek('sessions.list')) return []
        if (!host.listSessions) return []
        try {
          return deepFreezeCorePluginValue(await host.listSessions(pluginId))
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] sessions.list error:`, undefined, error)
          return []
        }
      },
    },

    /**
     * `peek().state === 'idle'` 的便捷函数(pi 的 `ctx.isIdle()`)。
     * 读不到会话 = false:"不知道"绝不能被当成"可以随便打扰"。
     */
    async isIdle(sessionId: string): Promise<boolean> {
      return (await peekSessionForPlugin(sessionId))?.state === 'idle'
    },

    /**
     * 受管 LLM 调用(N7-b)—— "插件从搬运升到判断"的钥匙。
     *
     * 与 pi 的裸 `ctx.modelRegistry.complete()` 的关键差异:插件拿不到 apiKey /
     * registry,只交出 messages、拿回 text。**受管三要素**(计费 `source=plugin:<id>`
     * + 硬超时 + 配额)全在宿主实现里;core 这一层只做:
     *  - **声明门**:manifest 没声明 `llm:complete` → 抛 `not-declared`,**不计熔断**
     *    (manifest 笔误不该连坐整个插件,与 sendMessage / interceptInput 同规);
     *  - **输入校验**:messages 非空且形状合法,否则抛 `invalid-input`;
     *  - **诚实降级**:宿主没接这条线 → 抛 `unsupported`,不假装成功。
     *
     * 失败(provider / 超时 / 配额 / 校验)一律**抛给插件**自己 catch。在
     * beforeContextCompact 钩子里没 catch 时,N7-a 的 fail-open 兜底回落宿主自压。
     */
    llm: {
      async complete(options: PluginLlmCompleteOptions): Promise<PluginLlmCompleteResult> {
        if (rejectLateCall('llm.complete')) {
          throw new PluginLlmError('unsupported', 'plugin was disposed')
        }
        if (!declaredPermissions.has(PLUGIN_PERMISSION_LLM_COMPLETE)) {
          logger.error(
            `[Plugin:${pluginId}] llm.complete requires "${PLUGIN_PERMISSION_LLM_COMPLETE}" in `
            + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
            + 'can make AI model calls on its behalf (uses tokens).',
            undefined,
          )
          throw new PluginLlmError('not-declared', PLUGIN_PERMISSION_LLM_COMPLETE)
        }
        if (!host.llmComplete) {
          throw new PluginLlmError('unsupported', 'this host has no managed LLM surface')
        }
        // 抛 invalid-input(纯校验),在把请求交给宿主之前。
        const messages = normalizePluginLlmMessages((options ?? {}).messages)
        return host.llmComplete(pluginId, {
          messages,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          signal: options?.signal,
        })
      },
    },

    registerCommand(name: string, options: TCommandOptions): void {
      if (rejectLateCall('registerCommand')) return
      const fullName = name.startsWith('/') ? name : `/${name}`
      commands.set(fullName, { name: fullName, ...options } as unknown as TCommand)
      logger.debug(`[Plugin:${pluginId}] Registered command: ${fullName}`)
    },

    registerPromptContextProvider(id: string, provider: TPromptContextProvider): void {
      if (rejectLateCall('registerPromptContextProvider')) return
      const unsub = host.registerPromptContextProvider(pluginId, id, provider)
      promptContextUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered prompt context provider: ${id}`)
    },

    beforeContextCompact(id: string, hook: TBeforeContextCompactHook): void {
      if (rejectLateCall('beforeContextCompact')) return
      const unsub = host.registerBeforeContextCompactHook(pluginId, id, hook)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered beforeContextCompact hook: ${id}`)
    },

    afterAssistantResponse(id: string, hook: TAfterAssistantResponseHook): void {
      if (rejectLateCall('afterAssistantResponse')) return
      const unsub = host.registerAfterAssistantResponseHook(pluginId, id, hook)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered afterAssistantResponse hook: ${id}`)
    },

    /**
     * 发送前拦截(N2)——**拦截族**的第一个成员。
     *
     * 它刻意**不是** `api.on('input')`:观察族(`api.on`)的返回值今天被忽略,
     * 把一个"返回值被消费"的点混进同一个函数,作者永远搞不清自己 return 的东西
     * 到底算不算数;而裸 string 订阅名拼错就是 pi 那条静默死订阅。两个家族从
     * 类型上分开之后,这两个问题一起消失:拦截点是函数名,拼错编译不过。
     *
     * 声明门:`contributes.permissions` 要有 `input:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(与 sendMessage / theme.updateBackground 同规:
     * 那是作者写错了 manifest,不该为一次笔误连坐整个插件)。
     */
    interceptInput(id: string, handler: PluginInputInterceptHandler): void {
      if (rejectLateCall('interceptInput')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_INPUT_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptInput requires "${PLUGIN_PERMISSION_INPUT_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). It is the most sensitive declaration there is — '
          + 'the install page tells the user this plugin can rewrite or handle their messages.',
          undefined,
        )
        return
      }
      if (!host.registerInputInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptInput is not available on this host (no send pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerInputInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered input interceptor: ${id}`)
    },

    /**
     * 工具调用拦截(N4)——**拦截族**的第二个成员,也是第一个 fail-closed 的。
     *
     * handler 返回 `{action:'allow'|'block'|'rewrite'}`(或什么都不返回 = allow),
     * 多插件按全局规范顺序链式:rewrite 逐个累积参数,第一个 block 短路后续。
     * 改写后的参数**要过工具自己的校验**,过不了当作 block。
     *
     * 抛错 / 超时 / 返回值读不懂 = **阻断这一次调用**(与 interceptInput 相反),
     * 因为这里的默认动作是执行一个带副作用的工具。连败到阈值后这个插件的拦截面
     * 被降级掉,之后它的调用一律放行 —— 一个坏插件挡得住三次,瘫痪不了应用。
     *
     * 声明门:`contributes.permissions` 要有 `toolcall:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(manifest 笔误不该连坐整个插件,与 N1/N2 同规)。
     */
    interceptToolCall(id: string, handler: PluginToolCallInterceptHandler): void {
      if (rejectLateCall('interceptToolCall')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_TOOLCALL_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolCall requires "${PLUGIN_PERMISSION_TOOLCALL_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
          + 'can inspect, block, or rewrite tool calls before they run.',
          undefined,
        )
        return
      }
      if (!host.registerToolCallInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolCall is not available on this host (no tool pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerToolCallInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered tool-call interceptor: ${id}`)
    },

    /**
     * 工具结果改写(N5)——**拦截族**的第三个成员,`interceptToolCall` 的 fail-open
     * 镜像。它挂在工具执行**之后**、结果回模型之前的对称位置。
     *
     * handler 返回 `{action:'keep'|'replace'}`(或什么都不返回 = keep),多插件按
     * 全局规范顺序链式:replace 逐个累积(后手看到前手改写后的结果)。没有 block、
     * 没有短路 —— 结果已经产生,只有改写。content 是纯文本(不过 schema,只有
     * 长度上限),isError 可翻转(脱敏场景)。
     *
     * 抛错 / 超时 / 返回值读不懂 = **保留原结果**(fail-open,与 interceptToolCall
     * 相反),因为结果早已产生、改写失败无害。连败到阈值后这个插件的改写面被降级掉。
     *
     * 声明门:`contributes.permissions` 要有 `toolresult:intercept`。未声明 = 报错 +
     * 拒绝注册,**不计熔断**(manifest 笔误不该连坐整个插件,与 N1/N2/N4 同规)。
     * 它是最敏感的声明之一 —— 装前确认页会念成人话:该插件能读到并改写所有工具的
     * 输出(含文件内容与命令输出)。
     */
    interceptToolResult(id: string, handler: PluginToolResultInterceptHandler): void {
      if (rejectLateCall('interceptToolResult')) return
      if (!declaredPermissions.has(PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT)) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolResult requires "${PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT}" in `
          + 'contributes.permissions (plugin.json). The install page tells the user this plugin '
          + 'can read and rewrite tool results before the model sees them, including file contents '
          + 'and command output.',
          undefined,
        )
        return
      }
      if (!host.registerToolResultInterceptHook) {
        logger.error(
          `[Plugin:${pluginId}] interceptToolResult is not available on this host (no tool pipeline).`,
          undefined,
        )
        return
      }
      const unsub = host.registerToolResultInterceptHook(pluginId, id, handler)
      lifecycleUnsubs.push(unsub)
      logger.debug(`[Plugin:${pluginId}] Registered tool-result interceptor: ${id}`)
    },

    registerSkillRoot(provider: TSkillRootProvider): void {
      if (rejectLateCall('registerSkillRoot')) return
      const unsub = host.registerSkillRoot(pluginId, provider)
      skillRootUnsubs.push(unsub)
      Promise.resolve(host.invalidateSkillsCache?.()).catch(() => undefined)
      logger.debug(`[Plugin:${pluginId}] Registered skill root provider`)
    },

    /**
     * 统一请求通道的插件侧登记口(设计文档 §5 R2)。
     *
     * handler 拿到的 ctx 带 requestId / abortSignal / progress —— 与宿主工具
     * 执行上下文同构,长任务从第一天就有取消与中间态。
     */
    registerRequestHandler(action: string, handler: CorePluginRequestHandler): void {
      if (rejectLateCall('registerRequestHandler')) return
      const normalized = normalizePluginRequestAction(action)
      if (!normalized) {
        logger.error(`[Plugin:${pluginId}] registerRequestHandler needs a non-empty action`, undefined)
        return
      }
      // `panel:` 与 `ui:` 是宿主保留的命名空间。不挡的话,插件可以直接登记
      // `panel:render:<id>` / `ui:render:<anchor>:<id>` 顶掉宿主装好的那层 ——
      // 一条 replacing 日志之后,一棵没校验过的树就直通 renderer 了。
      // 这与"未声明的面板 id"同一性质,所以同款处理:报错 + 计熔断,不注册。
      if (isReservedPluginPanelAction(normalized) || isReservedPluginUiAction(normalized)) {
        logger.error(
          `[Plugin:${pluginId}] registerRequestHandler("${normalized}") is refused: the "panel:" and "ui:" `
          + 'action namespaces belong to the host. Use registerWorkspacePanel() / registerUiSlot() instead.',
          undefined,
        )
        reportFailure(pluginScope.registration('RequestHandler'), new Error(`reserved action "${normalized}"`))
        return
      }
      if (requestHandlers.has(normalized)) {
        logger.error(`[Plugin:${pluginId}] Duplicate request handler for action "${normalized}" (replacing)`, undefined)
      }
      requestHandlers.set(normalized, handler)
      logger.debug(`[Plugin:${pluginId}] Registered request handler: ${normalized}`)
    },

    settings: {
      /**
       * **有意不带 disposed 闩**:读配置没有破坏性(不注册、不落盘、不发事件),
       * 拆除之后一个晚到的读取最多拿到一份过期快照。给它加闩只会让插件在
       * teardown 竞速里拿到 undefined 而崩,收益为负。
       */
      get<T = Record<string, unknown>>(): T {
        // 深冻结快照,不是活引用:浅冻结只挡住顶层赋值,
        // `get().tags.push('x')` 照样能写穿共享的数组(乃至 manifest 里的
        // schema.default 本体)。而且 H 线把插件搬进子进程之后,
        // "同步读一个远端对象"根本不成立 —— 快照语义现在就定死。
        return deepFreezeCorePluginValue({ ...(host.getPluginConfig?.(pluginId) ?? {}) }) as T
      },
      onChange(callback: (config: Record<string, unknown>) => void): () => void {
        if (rejectLateCall('settings.onChange')) return () => {}
        const unsub = host.onPluginConfigChange?.(pluginId, callback) ?? (() => {})
        configUnsubs.push(unsub)
        return unsub
      },
    },

    /**
     * 面板注册 —— 只绑行为,不带存在感。
     *
     * id 必须匹配 manifest 的 contributes.panels:不匹配就报错而不是默默注册一个
     * 谁也进不去的面板(插件侧那句"注册成功了"是最难查的一类假象)。
     * 落地方式是把 render/onAction 挂到统一请求通道上 —— 于是它们免费拿到
     * R2 的超时预算、abort、progress 与 `request:<action>` 熔断账,不另起一套。
     */
    registerWorkspacePanel(registration: CorePluginPanelRegistration): void {
      if (rejectLateCall('registerWorkspacePanel')) return
      const panelId = String(registration?.id ?? '').trim()
      if (!panelId) {
        logger.error(`[Plugin:${pluginId}] registerWorkspacePanel needs an id`, undefined)
        return
      }
      const declared = options.declaredPanelIds ?? []
      if (!declared.includes(panelId)) {
        logger.error(
          `[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") does not match any panel declared in `
          + `contributes.panels (declared: ${declared.length ? declared.join(', ') : 'none'}). `
          + 'Declare it in plugin.json first — the host renders the entry from the manifest.',
          undefined,
        )
        reportFailure(pluginScope.registration('WorkspacePanel'), new Error(`undeclared panel "${panelId}"`))
        return
      }
      if (typeof registration.render !== 'function') {
        logger.error(`[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") needs a render function`, undefined)
        return
      }
      /*
       * webview 面板的 render 挂在**另一个 action 名**上(C 期)。
       *
       * 插件侧的写法不变(还是 `registerWorkspacePanel({ id, render, onAction })`),
       * 变的是 render 的**返回值契约**:webview 面板的内容由静态文件提供,
       * render 交出的是给 iframe 的初始化数据(任意可序列化 JSON),宿主不解释它。
       * 换个 action 名,通道守卫按前缀就知道该用哪套校验 —— 不必反查"这个面板
       * 是哪一种",也就不会有那份反查漂移之后的两类事故。
       *
       * **零代码的纯静态面板是合法的**:manifest 声明 view+entry 就够,
       * 插件完全可以不调 registerWorkspacePanel —— 声明先于代码,宿主凭清单
       * 就能把 iframe 挂起来(renderer 据 requestActions 判断有没有初始化数据可拉)。
       */
      const renderAction = (options.declaredWebviewPanelIds ?? []).includes(panelId)
        ? PLUGIN_PANEL_INIT_ACTION
        : PLUGIN_PANEL_RENDER_ACTION

      // 同一个 id 注册两次:静默覆盖会让"我明明注册了"与"点开是另一个面板"
      // 同时成立,这是最难查的一类。清单里一个 id 就是一个面板,重复即错。
      if (requestHandlers.has(`${renderAction}:${panelId}`)) {
        logger.error(
          `[Plugin:${pluginId}] registerWorkspacePanel("${panelId}") was already registered; `
          + 'one manifest panel id binds exactly one implementation.',
          undefined,
        )
        reportFailure(pluginScope.registration('WorkspacePanel'), new Error(`duplicate panel "${panelId}"`))
        return
      }

      const panelContext = (ctx: CorePluginRequestContext): CorePluginPanelContext => ({
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
        // 主动刷新走**通知通道**而不是 progress:progress 只在请求在飞期间有效
        // (R2 已裁决 abort/settle 之后一律丢弃),而真实的刷新几乎都发生在
        // 请求之外(日志文件变了、定时器到点了)。复用既有通知轨,不另开一条
        // (§5.2 第 4 条:R5 需要投递面时用现成的)。
        refresh: () => host.emitPanelRefresh?.(pluginId, panelId),
      })

      // 形状校验不在这里做:通道层(manager.handleRequest)对所有 panel:* 结果
      // 统一执行,包装可以被绕开而通道不能。这里只做包装自己的事。
      requestHandlers.set(`${renderAction}:${panelId}`, (_payload, ctx) =>
        registration.render(panelContext(ctx)))

      requestHandlers.set(`${PLUGIN_PANEL_INVOKE_ACTION}:${panelId}`, async (payload, ctx) => {
        if (!registration.onAction) return { refresh: false }
        const input = (payload ?? {}) as { actionId?: unknown; payload?: unknown }
        const actionId = String(input.actionId ?? '')
        if (!actionId) throw new Error(`Panel "${panelId}" received an action without an actionId`)
        const result = await registration.onAction({ actionId, payload: input.payload }, panelContext(ctx))
        return result ?? { refresh: false }
      })

      logger.debug(`[Plugin:${pluginId}] Registered workspace panel: ${panelId}`)
    },

    /**
     * 锚点块注册(R5.x)—— 与 registerWorkspacePanel 同构,只绑行为。
     *
     * (anchor, id) 必须匹配 manifest 的 contributes.uiSlots;render 返回的是同一套
     * 描述树协议(块只是"小面板",协议不因位置而分叉)。落地方式同样是把
     * render/onAction 挂到统一请求通道上(`ui:render:<anchor>:<id>` /
     * `ui:action:<anchor>:<id>`),免费继承超时预算、abort、progress 与熔断账。
     */
    registerUiSlot(registration: CorePluginUiSlotRegistration): void {
      if (rejectLateCall('registerUiSlot')) return
      const slotAnchor = String(registration?.anchor ?? '').trim()
      const slotId = String(registration?.id ?? '').trim()
      if (!slotAnchor || !slotId) {
        logger.error(`[Plugin:${pluginId}] registerUiSlot needs an anchor and an id`, undefined)
        return
      }
      // 未知锚点在这里是**代码错误**(与 manifest 层的"降级为 unsupported"不同:
      // 到了注册期,插件在代码里指名道姓要一个宿主没有的位置,没有歧义可容)。
      if (!isUiAnchor(slotAnchor)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotAnchor}") is refused: unknown anchor. `
          + 'Anchors are a host-defined set (UI_ANCHORS); a plugin cannot invent one.',
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`unknown anchor "${slotAnchor}"`))
        return
      }
      const declared = options.declaredUiSlots ?? []
      if (!declared.some(slot => slot.anchor === slotAnchor && slot.id === slotId)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotId}") does not match any ui slot declared in `
          + `contributes.uiSlots for anchor "${slotAnchor}" (declared: ${
            declared.length ? declared.map(slot => `${slot.anchor}/${slot.id}`).join(', ') : 'none'
          }). Declare it in plugin.json first — the host renders the block from the manifest.`,
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`undeclared ui slot "${slotId}"`))
        return
      }
      if (typeof registration.render !== 'function') {
        logger.error(`[Plugin:${pluginId}] registerUiSlot("${slotId}") needs a render function`, undefined)
        return
      }
      const address = uiSlotAddress(slotAnchor, slotId)
      if (requestHandlers.has(`${PLUGIN_UI_RENDER_ACTION}:${address}`)) {
        logger.error(
          `[Plugin:${pluginId}] registerUiSlot("${slotId}") was already registered; `
          + 'one manifest ui slot id binds exactly one implementation.',
          undefined,
        )
        reportFailure(pluginScope.registration('UiSlot'), new Error(`duplicate ui slot "${slotId}"`))
        return
      }

      const slotContext = (ctx: CorePluginRequestContext): CorePluginUiSlotContext => ({
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
        // 与面板同一条通知轨:panelId 字段带 `ui:<anchor>:<id>` 形式的 surface id,
        // renderer 按它与块对号入座。
        refresh: () => host.emitPanelRefresh?.(pluginId, uiSlotSurfaceId(slotAnchor, slotId)),
        anchor: slotAnchor,
        sessionId: null,
      })
      /** sessionId 由调用方(renderer)随 payload 传入 —— 宿主在会话切换时重拉。 */
      const withSession = (base: CorePluginUiSlotContext, payload: unknown): CorePluginUiSlotContext => {
        const raw = (payload as { sessionId?: unknown } | undefined)?.sessionId
        // messageId 同理(消息级锚点):宿主按消息实例挂载时随 payload 传入,
        // 会话级锚点不带这个字段。
        const rawMessageId = (payload as { messageId?: unknown } | undefined)?.messageId
        // drawerState 同理(抽屉块,F 期):宿主按当前档随 payload 传入,插件
        // 据此返回不同的树。只认会渲染的两档 —— 'collapsed' 与任何未知值都
        // 读成"不带这个字段",非抽屉块看到的 ctx 一字不变(append-only)。
        const rawDrawerState = (payload as { drawerState?: unknown } | undefined)?.drawerState
        return {
          ...base,
          sessionId: typeof raw === 'string' && raw ? raw : null,
          ...(typeof rawMessageId === 'string' && rawMessageId ? { messageId: rawMessageId } : {}),
          ...(isUiDrawerRenderState(rawDrawerState) ? { drawerState: rawDrawerState } : {}),
        }
      }

      requestHandlers.set(`${PLUGIN_UI_RENDER_ACTION}:${address}`, (payload, ctx) =>
        registration.render(withSession(slotContext(ctx), payload)))

      requestHandlers.set(`${PLUGIN_UI_INVOKE_ACTION}:${address}`, async (payload, ctx) => {
        // **手势锚定的记账点**(I 期):宿主把一次用户点击派发给了这个插件。
        // 记在 onAction 之前,插件才能在 onAction 里同步地请求布局动词。
        // 记的是"用户刚刚在跟这个插件互动",不是"哪一次互动" —— 因此
        // 连没登记 onAction 的块也照记:用户确实点了它。
        noteUiActionGesture(pluginId)
        if (!registration.onAction) return { refresh: false }
        const input = (payload ?? {}) as { actionId?: unknown; payload?: unknown }
        const actionId = String(input.actionId ?? '')
        if (!actionId) throw new Error(`Ui slot "${slotId}" received an action without an actionId`)
        const result = await registration.onAction(
          { actionId, payload: input.payload },
          withSession(slotContext(ctx), payload),
        )
        return result ?? { refresh: false }
      })

      logger.debug(`[Plugin:${pluginId}] Registered ui slot: ${address}`)
    },

    events: {
      /**
       * 发一条命名空间事件。投递名 = `plugin:<pluginId>:<name>`,
       * 任何插件都能用 api.on 订阅它。payload 过线,必须 JSON-可序列化。
       */
      emit(eventName: string, payload?: unknown): void {
        if (rejectLateCall('events.emit')) return
        const name = String(eventName || '').trim()
        if (!name) {
          logger.error(`[Plugin:${pluginId}] events.emit needs a non-empty event name`, undefined)
          return
        }
        try {
          assertPluginPayloadSerializable(payload, `plugin event "${name}" payload`)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] events.emit rejected:`, undefined, error)
          reportFailure(pluginScope.eventEmit(name), error)
          return
        }
        try {
          host.emitPluginEvent?.(pluginId, name, payload)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] events.emit failed:`, undefined, error)
          reportFailure(pluginScope.eventEmit(name), error)
        }
      },
    },

    onDispose(callback: () => void): void {
      if (rejectLateCall('onDispose')) return
      disposeCallbacks.push(callback)
    },

    store,
    /**
     * 目录访问面。路径穿越与序列化守卫在 createCorePluginStorage 里(它会抛),
     * 这一层只加两件宿主的事:disposed 闩 + 把失败记进熔断账(scope `storage`)。
     */
    storage: {
      dir(): string {
        rejectDisposedWrite('dir')
        return withStorageFailureReport('dir', () => requireStorage().dir())
      },
      readJson<T = unknown>(name: string, fallback?: T): T | undefined {
        if (state.disposed && !state.disposing) {
          rejectLateCall('storage.readJson')
          return fallback
        }
        return withStorageFailureReport('readJson', () => requireStorage().readJson<T>(name, fallback))
      },
      writeJson(name: string, value: unknown): void {
        rejectDisposedWrite('writeJson')
        withStorageFailureReport('writeJson', () => requireStorage().writeJson(name, value))
      },
      exists(name: string): boolean {
        if (state.disposed && !state.disposing) {
          rejectLateCall('storage.exists')
          return false
        }
        return withStorageFailureReport('exists', () => requireStorage().exists(name))
      },
      /**
       * 消息作用域状态(plugin-message-state-2026-08)。**坐标随调用递交** ——
       * 宿主在这一刻收到 (sessionId, messageId),结构性归账,零语义解释。
       * 读写语义与 KV 同规:写面抛(配额/不可序列化)、拆除闩、熔断分车道。
       */
      /**
       * F1 受管文件树。`api.storage.files.readText('candidates/2026-08.jsonl')`
       *
       * 与 KV / message-state 同一套宿主纪律,一条不多一条不少:
       *  - **拆除闩**:写面在拆除后静默丢弃(不重建被归档的家目录),读面退化;
       *  - **熔断分车道**:`storage.files.<动词>` 各记各的账,免得 exists 的成功
       *    不断把 writeText 的连败清掉;
       *  - **错误继续抛**:路径穿越 / 配额 / 未声明外部根都要让插件当场知道 ——
       *    静默吞掉只会让它以为写成功了,而记忆已经断流。
       *
       * 判据、原子写、O_APPEND、配额记账全在 `storage-files.ts`(它会抛),
       * 这一层不重复任何一条。
       */
      files: {
        readText(relPath: string, fileOptions?: CorePluginFilesReadOptions): string | undefined {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.readText')
            return undefined
          }
          return withStorageFailureReport('files.readText', () =>
            requireFiles().readText(relPath, fileOptions))
        },
        writeText(relPath: string, content: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.writeText')
          withStorageFailureReport('files.writeText', () =>
            requireFiles().writeText(relPath, content, fileOptions))
        },
        appendText(relPath: string, content: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.appendText')
          withStorageFailureReport('files.appendText', () =>
            requireFiles().appendText(relPath, content, fileOptions))
        },
        list(relDir?: string, fileOptions?: CorePluginFilesOptions): CorePluginFileEntry[] {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.list')
            return []
          }
          return withStorageFailureReport('files.list', () =>
            requireFiles().list(relDir, fileOptions))
        },
        exists(relPath: string, fileOptions?: CorePluginFilesOptions): boolean {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.exists')
            return false
          }
          return withStorageFailureReport('files.exists', () =>
            requireFiles().exists(relPath, fileOptions))
        },
        remove(relPath: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.remove')
          withStorageFailureReport('files.remove', () =>
            requireFiles().remove(relPath, fileOptions))
        },
        usage(): CorePluginFilesUsage {
          return withStorageFailureReport('files.usage', () => requireFiles().usage())
        },
      },
      message(sessionId: string, messageId: string) {
        return {
          readJson<T = unknown>(fallback?: T): T | undefined {
            if (state.disposed && !state.disposing) {
              rejectLateCall('storage.message.readJson')
              return fallback
            }
            return withStorageFailureReport('message.readJson', () =>
              requireMessageState().readJson<T>(sessionId, messageId, fallback))
          },
          writeJson(value: unknown): void {
            rejectDisposedWrite('message.writeJson')
            withStorageFailureReport('message.writeJson', () =>
              requireMessageState().writeJson(sessionId, messageId, value))
          },
          exists(): boolean {
            if (state.disposed && !state.disposing) {
              rejectLateCall('storage.message.exists')
              return false
            }
            return withStorageFailureReport('message.exists', () =>
              requireMessageState().exists(sessionId, messageId))
          },
        }
      },
    },
    scheduler,
    /**
     * 流状态(R6)。
     *
     * 纳入 disposed 闩:插件被拆除之后再 show 一条状态,等于在一个没人再会来
     * 清扫的账上挂东西 —— 停用之后气泡里多出一个永远转圈的指示器,而它的主人
     * 已经不在了。
     */
    status: {
      show(sessionId: string, status: { id: string; label: string }): void {
        if (rejectLateCall('status.show')) return
        const registry = options.statusRegistry
        if (!registry) return
        // 地址与账本键用**同一份** trim 过的值:一边 trim 一边不 trim 的话,
        // 状态会 show 到一个地址、clear 到另一个,谁也撤不下来。
        const address = String(sessionId ?? '').trim()
        const part = registry.show({
          pluginId,
          sessionId: address,
          id: String(status?.id ?? ''),
          label: String(status?.label ?? ''),
        })
        // null 表示"不必投递":被拒(不合法/不在流内/超配额)或纯粹没变化(频控)。
        // 一律不抛 —— 一个写错 label 的插件不该让它正在跑的那次调用失败。
        if (!part) {
          // 被合并窗压住的变化要让宿主排一次补发,否则最终状态会丢。
          host.notePluginStatusPending?.()
          return
        }
        host.emitPluginStatus?.(pluginId, address, part)
      },
      clear(sessionId: string, id: string): void {
        if (rejectLateCall('status.clear')) return
        const registry = options.statusRegistry
        if (!registry) return
        const address = String(sessionId ?? '').trim()
        const part = registry.clear({ pluginId, sessionId: address, id: String(id ?? '') })
        if (!part) return
        host.emitPluginStatus?.(pluginId, address, part)
      },
    },

    /**
     * IM 连接器(R7 试点)。
     *
     * 三件宿主的事都在这里:disposed 闩(拆除之后再注册 = 往一个没人再会来清扫的
     * 表里塞东西)、退订函数收进 disposeCallbacks(插件不调也能拆干净)、
     * 失败进熔断账(scope `connector`,策略表判为 degrade-surface —— 一条渠道
     * 坏掉不该放大成插件故障)。
     */
    registerIMConnector(connector: { id?: unknown }): () => void {
      if (rejectLateCall('registerIMConnector')) return () => {}
      const rawId = String(connector?.id ?? '').trim()
      if (!rawId) {
        logger.error(`[Plugin:${pluginId}] registerIMConnector needs a connector with an id`, undefined)
        // 注册期违规是**代码错误**,与未声明的 panel id 同构 —— 归 registration
        // 家族(阈值 1),不是运行期的 connector 家族。
        reportFailure(pluginScope.registration('IMConnector'), new Error('connector without an id'))
        return () => {}
      }
      // 命名空间与 registerTool 同构:插件不能占用一个全局 id,更不能顶掉别人的。
      const connectorId = `plugin:${pluginId}:${rawId}`
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerIMConnector?.(pluginId, { ...connector, id: connectorId })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerIMConnector("${connectorId}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('IMConnector'), error)
        return () => {}
      }
      if (!unregister) {
        // 宿主没接这条线(headless / server / CLI daemon —— §6 方案 A 下只有
        // 桌面宿主执行插件)。如实告诉插件它被忽略了,而不是假装成功。
        logger.debug(`[Plugin:${pluginId}] IM connectors are not available on this host; "${connectorId}" was ignored`)
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister IM connector "${connectorId}":`, undefined, error)
        }
      }
      // 插件自己不调 release 也能拆干净 —— 拆除语义不建立在插件守规矩上。
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered IM connector: ${connectorId}`)
      return release
    },

    /**
     * 搜索供给方(M2)。三件宿主的事,与 registerIMConnector 同构:
     *  - **声明门**:manifest 没声明 `search:provide` 就拒绝 —— 报错 + 返回 noop,
     *    **不计熔断**(那是作者写错了 manifest,与 sendMessage / interceptInput 同规:
     *    一次笔误不该连坐整个插件);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净。
     *
     * 并发 / 超时 / 熔断都在装配层的聚合器(它才认识健康账本);core 只做门控与
     * 转发。宿主没接这条线(headless / server / CLI daemon —— §6 方案 A)时如实
     * 告诉插件它被忽略了,而不是假装成功。
     */
    registerSearchProvider(registration: CorePluginSearchProviderRegistration): () => void {
      if (rejectLateCall('registerSearchProvider')) return () => {}
      const providerId = String(registration?.id ?? '').trim()
      const label = String(registration?.label ?? '').trim()
      if (!providerId || !label || typeof registration?.search !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerSearchProvider needs { id, label, search() }`,
          undefined,
        )
        reportFailure(pluginScope.registration('SearchProvider'), new Error('malformed search provider'))
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_SEARCH_PROVIDE)) {
        logger.error(
          `[Plugin:${pluginId}] registerSearchProvider requires "${PLUGIN_PERMISSION_SEARCH_PROVIDE}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page tells the user '
          + 'this plugin can contribute results to Search Everywhere.',
          undefined,
        )
        return () => {}
      }
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerSearchProvider?.(pluginId, { ...registration, id: providerId, label })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerSearchProvider("${providerId}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('SearchProvider'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Search providers are not available on this host; "${providerId}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister search provider "${providerId}":`, undefined, error)
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered search provider: ${providerId}`)
      return release
    },

    /**
     * 深链动作(H4)。第三个既有宿主动词面,五件事与前两个同构:
     *  - **形状**:`{ name, title, handler }` 三件全要,name 限 `[a-z0-9-]+` ——
     *    它要进 URL 路径,松一点就得在解析侧补一堆转义;
     *  - **声明门**:manifest 没声明 `deeplink:handle` 就拒绝 —— 报错 + 返回 noop,
     *    **不计熔断**(manifest 笔误不该连坐整个插件,与 sessions:* / search:provide 同规);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净;
     *  - **命名空间**:全局地址由宿主拼(`plugin:<id>:<name>`),插件抢不到别人的格子。
     *
     * 确认门、超时、熔断都在宿主侧(它们要认识窗口与健康账本);core 只做门控与
     * 转发。宿主没接这条线(headless / server / CLI daemon —— 它们连 URL scheme
     * 都没有)时如实告诉插件它被忽略了,而不是假装成功。
     */
    registerDeepLinkAction(registration: CorePluginDeepLinkActionRegistration): () => void {
      if (rejectLateCall('registerDeepLinkAction')) return () => {}
      const name = String(registration?.name ?? '').trim()
      const title = String(registration?.title ?? '').trim()
      if (!name || !title || typeof registration?.handler !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction needs { name, title, handler() }`,
          undefined,
        )
        reportFailure(pluginScope.registration('DeepLinkAction'), new Error('malformed deep link action'))
        return () => {}
      }
      if (!PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test(name)) {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction("${name}") — the name must match `
          + `${PLUGIN_DEEPLINK_ACTION_NAME_PATTERN} (it goes into a URL path).`,
          undefined,
        )
        reportFailure(pluginScope.registration('DeepLinkAction'), new Error(`illegal action name: ${name}`))
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_DEEPLINK_HANDLE)) {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction requires "${PLUGIN_PERMISSION_DEEPLINK_HANDLE}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page tells the user '
          + 'this plugin can be invoked by onething:// links from outside the app.',
          undefined,
        )
        return () => {}
      }
      const address = pluginDeepLinkAddress(pluginId, name)
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerDeepLinkAction?.(pluginId, { ...registration, name, title })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerDeepLinkAction("${address}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('DeepLinkAction'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Deep links are not available on this host; "${address}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister deep link action "${address}":`, undefined, error)
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered deep link action: ${address}`)
      return release
    },

    /**
     * 凭证轮换策略(批 E)。第四个既有宿主动词面,五件事与前三个同构:
     *  - **形状**:`{ name, title, select }` 三件全要,name 限 `[a-z0-9-]+` ——
     *    它要进 `credentials.json` 的 `policy` 字段并被人眼读;
     *  - **声明门**:manifest 没声明 `credentials:strategy` 就拒绝 —— 报错 + 返回
     *    noop,**不计熔断**(manifest 笔误不该连坐整个插件,与 sessions:* /
     *    search:provide / deeplink:handle 同规);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净;
     *  - **命名空间**:policy 取值由宿主拼(`plugin:<id>:<name>`),插件抢不到
     *    别人的格子,也抢不到 `single` / `priority-failover` / `round-robin`
     *    这三个内置名(它们不含冒号,拼不出来)。
     *
     * 脱敏投影、超时预算、熔断降级、用量聚合都在装配层(它才认识凭证池与账本);
     * core 只做门控与转发。宿主没接这条线(headless / server / CLI daemon ——
     * 它们只有默认空间,没有凭证池)时如实告诉插件它被忽略了,而不是假装成功。
     */
    registerCredentialStrategy(
      registration: CorePluginCredentialStrategyRegistration,
    ): () => void {
      if (rejectLateCall('registerCredentialStrategy')) return () => {}
      const name = String(registration?.name ?? '').trim()
      const title = String(registration?.title ?? '').trim()
      if (!name || !title || typeof registration?.select !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy needs { name, title, select() }`,
          undefined,
        )
        reportFailure(
          pluginScope.registration('CredentialStrategy'),
          new Error('malformed credential strategy'),
        )
        return () => {}
      }
      if (!PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test(name)) {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy("${name}") — the name must match `
          + `${PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN} (it is stored as the pool's policy value).`,
          undefined,
        )
        reportFailure(
          pluginScope.registration('CredentialStrategy'),
          new Error(`illegal strategy name: ${name}`),
        )
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_CREDENTIAL_STRATEGY)) {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy requires `
          + `"${PLUGIN_PERMISSION_CREDENTIAL_STRATEGY}" in contributes.permissions (plugin.json). `
          + 'Declare it first — the install page tells the user this plugin can choose which of '
          + 'their credentials a workspace uses (it never sees the key itself).',
          undefined,
        )
        return () => {}
      }
      const policy = pluginCredentialStrategyPolicy(pluginId, name)
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerCredentialStrategy?.(pluginId, { ...registration, name, title })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerCredentialStrategy("${policy}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('CredentialStrategy'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Credential strategies are not available on this host; `
          + `"${policy}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(
            `[Plugin:${pluginId}] Failed to unregister credential strategy "${policy}":`,
            undefined, error,
          )
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered credential strategy: ${policy}`)
      return release
    },

    /**
     * 外观面(G 期,L2.5)。今天只有背景层这一格。
     *
     * 三道闸,顺序有意义:
     *  1. **拆除闩** —— 停用之后再调,等于往一张已经撤掉的层上写参数;
     *  2. **声明门** —— manifest 没声明 background 就没有可调的东西。记一条 error
     *     日志然后拒绝,**不计熔断**:开一个熔断面意味着一次笔误能连坐整个插件,
     *     而这条调用本身没有任何副作用可言(与未声明的 panel id 不同 —— 那个会
     *     留下一个画不出来的入口);
     *  3. **图源门**(B 期,用户壁纸)—— `image` 只收 `storage:` 寻址。非法
     *     图源**拒掉整条调用**而不是丢一个字段:插件明说了"把背景换成这张",
     *     半条命令(换了透明度没换图)比什么也不做更难解释。同样不计熔断 ——
     *     它是作者写错了寻址,与未声明 background 同规;
     *  4. **钳制** —— 越界数字钳进区间、未知 fit 忽略。用户拖滑杆的结果不该
     *     把控件卡住。
     */
    theme: {
      updateBackground(patch: PluginBackgroundParamsPatch): void {
        if (rejectLateCall('theme.updateBackground')) return
        if (!options.declaredBackground) {
          logger.error(
            `[Plugin:${pluginId}] theme.updateBackground requires contributes.theme.background in plugin.json`,
            undefined,
          )
          return
        }
        const requestedImage = (patch as { image?: unknown } | null | undefined)?.image
        // `null` 是**撤回**,不是一个坏图源:它绕过图源门(没有图可判),
        // 背景回落 manifest 声明的缺省图(darkImage 一并恢复)。
        // `undefined` 仍然是"这次不动 image" —— 两者不能合流,否则一个漏写的
        // 可选字段会静默把用户选的壁纸撤掉。
        if (requestedImage !== undefined && requestedImage !== null) {
          const problem = describePluginRuntimeBackgroundImageProblem(requestedImage)
          if (problem) {
            logger.error(`[Plugin:${pluginId}] theme.updateBackground rejected: ${problem}`, undefined)
            return
          }
        }
        const clamped = clampPluginBackgroundParamsPatch(patch)
        // 空补丁不广播:插件传了一堆非法值,等于什么也没说。
        if (!Object.keys(clamped).length) return
        try {
          host.updatePluginBackground?.(pluginId, clamped)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] theme.updateBackground failed:`, undefined, error)
        }
      },
    },

    ui: {
      /**
       * 静默横幅 + 可选提示音(M1)。
       *
       * 第二参有两种长相,**加法而不是改法**:
       * - `notify(msg)` / `notify(msg, 'warn')` —— 老签名,逐字节等价于从前(不出声);
       * - `notify(msg, { level: 'warn', sound: 'chime' })` —— 新形态。
       *
       * sound 缺省 `'none'`;名字不在 `PLUGIN_NOTIFY_SOUNDS` 里就降级 none 并记一条
       * 日志(不抛错 —— 一个错音名不该把这条通知整个打掉)。真正决定响不响的是
       * 宿主:静音开关与限频闸都在装配层,core 这里只做形状归一。
       */
      notify(message: string, levelOrOptions: 'info' | 'warn' | 'error' | PluginNotifyOptions = 'info'): void {
        if (rejectLateCall('ui.notify')) return
        const isOptions = typeof levelOrOptions === 'object' && levelOrOptions !== null
        const level = (isOptions ? levelOrOptions.level : levelOrOptions) ?? 'info'
        const normalized = normalizePluginNotifySound(isOptions ? levelOrOptions.sound : undefined)
        if (normalized.unknown) {
          logger.error(
            `[Plugin:${pluginId}] ui.notify: unknown sound ${JSON.stringify(
              (levelOrOptions as PluginNotifyOptions).sound,
            )} — falling back to silence. Allowed: ${PLUGIN_NOTIFY_SOUNDS.join(', ')}`,
          )
        }
        try {
          host.notify(pluginId, message, level, normalized.sound)
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] notify error:`, undefined, error)
        }
      },

      /**
       * 布局动词(I 期)。两个动词共用一条闸,闸在 `runLayoutVerb` 里 ——
       * 两处各写一遍判据就是两份口径的开始。
       */
      toggleSidebar(): Promise<PluginLayoutResult> {
        return runLayoutVerb('toggle-sidebar')
      },
      openWorkbench(panelId?: string): Promise<PluginLayoutResult> {
        const target = String(panelId ?? '').trim()
        return runLayoutVerb('open-workbench', target || undefined)
      },
    },
  } as unknown as TApi

  state.api = api
  return { api, state }
}
