/**
 * 插件 API 建造的输入与上下文:宿主要给的那张端口表(`CorePluginAPIHost`)、建一只插件 API 的选项
 * (`CreateCorePluginAPIOptions`),以及由它们建出来、五只建造件(`plugin-api-build-*.ts`)共用的上下文。
 *
 * 从 `plugin-api-builder.ts` 拆出(大文件拆分批 2,2026-10-04)。两个形状原样搬来;`plugin-api-builder.ts`
 * 照旧以同样的名字交出它们(那只文件的深键与导出不动)。它们住在这里、不住 `plugin-api-types.ts`:那只文件是
 * 插件代码看见的 `api` 形状,这两个是建造者从宿主那里拿的东西,与上下文连成一件事。
 */
import type { CorePluginAPIState } from './plugin-api-state.js'
import { toLogger, type CompatLogger } from '@onething/backend/logging'
import {
  type PluginBackgroundParamsPatch,
  type PluginLayoutVerb,
  pluginScope,
  type PluginFailureScope,
  type CorePluginRequestHandler,
  type CorePluginSearchProviderRegistration,
  type CorePluginCredentialStrategyRegistration,
} from '@onething/backend/plugin-contract'
import type { PluginNotifySound } from '@shared/plugins/notify-sound.js'
import {
  PluginStorageError,
  type CorePluginMessageStateStore,
  type CorePluginStorage,
} from './plugin-storage.js'
import { getPluginFilesFaultLane, type CorePluginFiles } from './plugin-storage-files.js'
import type { PluginInputInterceptHandler } from './plugin-input-intercept.js'
import type { PluginToolCallInterceptHandler } from './plugin-tool-call-intercept.js'
import type { PluginToolResultInterceptHandler } from './plugin-tool-result-intercept.js'
import {
  PLUGIN_PERMISSION_SESSIONS_PEEK,
  type PluginSendMessageOptions,
  type PluginSendMessageResult,
  type PluginSessionPeek,
  type PluginSessionPeekLite,
} from './plugin-sessions.js'
import type { PluginLlmCompleteOptions, PluginLlmCompleteResult } from './plugin-llm.js'
import type { CorePluginStatusPart, CorePluginStatusRegistry } from './plugin-status.js'
import type { CorePluginDeepLinkActionRegistration } from '@onething/backend/deeplink'
import type { ResourceEvent, ReadOutcome as ReadOutcomeValue } from '@onething/backend/resource'
import type { Outcome as OutcomeValue } from '@onething/backend/toolkit'
import type { Logger } from '@onething/backend/logging'

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
  /**
   * 原子三个动词的落点(K4-b)。**三个都可缺席** —— 缺席 = 这台宿主没有资源内核
   * (headless / server / 测试替身),core 据此回结构化拒绝而不是静默假装成功。
   *
   * core 在这一层只做三件事:晚到闸、声明门、把地址原样递下去。**主体、超时、
   * 熔断、命名空间许可一个字都不在这里** —— 它们各自要认识的东西(`Principal` 的
   * 铸法、内核的 `ResourceCallOptions`、健康账本)全住在装配层,与
   * `registerDeepLinkAction` / `llmComplete` 逐字同一条分工。
   *
   * 特别地:core **不解析 `ref`**。地址语法归 `packages/shared/resource/ref.ts`,而这只
   * 插件面连一个 scheme 名都不该认识(§2 不变量 3 在插件出口上的同一句话)。
   */
  readResource?(
    pluginId: string,
    ref: string,
    name: string,
    query: Record<string, unknown>,
  ): Promise<ReadOutcomeValue>
  doResource?(
    pluginId: string,
    ref: string,
    op: string,
    params: Record<string, unknown>,
  ): Promise<OutcomeValue>
  /** 返回退订函数。前缀非法时**抛** —— 见 `api.resources.watch` 的注释。 */
  watchResources?(
    pluginId: string,
    prefix: string,
    listener: (event: ResourceEvent) => void,
  ): () => void
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
  disposeCallbacks?: Array<() => void | Promise<void>>
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
/**
 * 一组插件 API 的类型参数,打成一个包,好让上下文与五只建造件只带一个类型参数。各格与 `createCorePluginAPI`
 * 的同名类型参数一一对应(`api` = `TApi`、`tool` = `TTool` ……),约束也照抄。
 */
export interface CorePluginAPITypeArgs {
  api: unknown
  tool: { name: string }
  eventHandler: (...args: any[]) => any
  command: unknown
  commandOptions: object
  promptContextProvider: unknown
  beforeContextCompactHook: unknown
  afterAssistantResponseHook: unknown
  skillRootProvider: unknown
  store: unknown
  scheduler: unknown
}

type PluginApiOptionsOf<T extends CorePluginAPITypeArgs> = CreateCorePluginAPIOptions<
  T['tool'],
  T['eventHandler'],
  T['command'],
  T['promptContextProvider'],
  T['beforeContextCompactHook'],
  T['afterAssistantResponseHook'],
  T['skillRootProvider'],
  T['store'],
  T['scheduler']
>

/**
 * 建一只插件 API 时五只建造件共用的东西 —— 拆分前它们是 `createCorePluginAPI` 那只闭包里的局部量:
 * 选项与宿主、日志、拆除账(`state` 与它挂着的各张退订表)、声明过的权限,以及那一串共用的闸
 * (晚到闸、存储的写面闸与熔断上报、几个「本宿主有没有这条线」的取用口、会话快照的声明门)。
 * 字段名就是拆分前的局部量名,建造件解构出来照原样用。
 */
export interface PluginApiBuildContext<T extends CorePluginAPITypeArgs> {
  readonly pluginId: string
  readonly options: PluginApiOptionsOf<T>
  readonly host: PluginApiOptionsOf<T>['host']
  readonly store: T['store']
  readonly scheduler: T['scheduler']
  readonly logger: Logger
  readonly state: CorePluginAPIState<T['api'], T['command']>
  readonly unsubs: Array<() => void>
  readonly commands: Map<string, T['command']>
  readonly toolIds: string[]
  readonly skillRootUnsubs: Array<() => void>
  readonly promptContextUnsubs: Array<() => void>
  readonly lifecycleUnsubs: Array<() => void>
  readonly disposeCallbacks: Array<() => void | Promise<void>>
  readonly requestHandlers: Map<string, CorePluginRequestHandler>
  readonly configUnsubs: Array<() => void>
  readonly declaredPermissions: Set<string>
  readonly reportFailure: (scope: PluginFailureScope, error: unknown) => void
  readonly reportSuccess: (scope: PluginFailureScope) => void
  readonly requireStorage: () => CorePluginStorage
  readonly requireMessageState: () => CorePluginMessageStateStore
  readonly requireFiles: () => CorePluginFiles
  readonly withStorageFailureReport: <R>(what: string, run: () => R) => R
  readonly rejectDisposedWrite: (what: string) => void
  readonly rejectLateCall: (what: string) => boolean
  readonly requireSessionsPeek: (what: string) => boolean
}

/**
 * 建上下文。正文是拆分前 `createCorePluginAPI` 开头那一段,一字不差;只是末尾把这些局部量交出去,
 * 而不是留给同一只闭包里的对象字面量。
 */
export function createPluginApiBuildContext<T extends CorePluginAPITypeArgs>(
  options: PluginApiOptionsOf<T>,
): PluginApiBuildContext<T> {
  type TApi = T['api']
  type TCommand = T['command']
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
   * 判定留在 `plugin-storage-files.ts` 抛错的那一侧(只有它知道寻址的是哪个根,也只有它
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

  return {
    pluginId,
    options,
    host,
    store,
    scheduler,
    logger,
    state,
    unsubs,
    commands,
    toolIds,
    skillRootUnsubs,
    promptContextUnsubs,
    lifecycleUnsubs,
    disposeCallbacks,
    requestHandlers,
    configUnsubs,
    declaredPermissions,
    reportFailure,
    reportSuccess,
    requireStorage,
    requireMessageState,
    requireFiles,
    withStorageFailureReport,
    rejectDisposedWrite,
    rejectLateCall,
    requireSessionsPeek,
  }
}
