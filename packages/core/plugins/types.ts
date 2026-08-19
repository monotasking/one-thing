import type { PluginInputInterceptHandler } from './input-intercept.js'
import type { CoreToolPromptContribution } from '../engine/prompt-fragments.js'
import type { PluginToolCallInterceptHandler } from './tool-call-intercept.js'
import type { PluginToolResultInterceptHandler } from './tool-result-intercept.js'
import type { CorePluginRequestHandler } from './request-channel.js'
import type { CorePluginStorage } from './storage.js'
import type { PluginNotifyOptions } from './notify-sound.js'
import type { CorePluginToolExecutionMode } from './tool-execution-mode.js'
import type { CorePluginPanelRegistration } from './panel.js'
import type { CorePluginUiSlotRegistration, PluginLayoutResult } from './ui-anchor.js'
import type { CorePluginSearchProviderRegistration } from './search-provider.js'
import type { CorePluginCredentialStrategyRegistration } from './credential-strategy.js'
import type { CorePluginDeepLinkActionRegistration } from './deep-link.js'
import type {
  PluginSendMessageOptions,
  PluginSendMessageResult,
  PluginSessionPeek,
  PluginSessionPeekLite,
} from './sessions.js'
import type { PluginLlmCompleteOptions, PluginLlmCompleteResult } from './llm.js'

/**
 * 声明先于代码(设计文档 §4.2 宪法第 3 条)。
 *
 * `contributes` 是插件的**静态存在感**:宿主只读清单就能知道它会贡献什么,
 * 一行插件代码都不必执行。R2 只建类型与解析/校验/透出管道 —— 消费者在
 * R3(settings)与 R5(panels)。今天先立住形状,后面几期才不用回头改协议。
 *
 * 全段必须 JSON-可序列化(宪法第 2 条):它就住在 plugin.json 里。
 */
export interface PluginContributionCommand {
  name: string
  description?: string
  usage?: string
}

export interface PluginContributionPanel {
  id: string
  label: string
  icon?: string
  /**
   * 面板的呈现形态(C 期,L3)。缺省 `descriptor` —— 老 manifest 一个字不改。
   *
   * `webview`:内容由插件静态根内的 `entry` HTML 提供,跑在 sandbox iframe
   * (opaque origin + CSP + postMessage-only)里。插件的**逻辑代码仍在 main 进程**,
   * iframe 里只有静态文件 —— webview 换的是"一块 UI 长什么样",不是执行模型。
   */
  view?: 'descriptor' | 'webview'
  /**
   * webview 面板的入口 HTML,**静态根内的相对路径**(仅 view: 'webview' 必填)。
   * 必须是相对路径、无 `..`、无 scheme、以 .html 结尾;非法即丢弃该 panel
   * 并在清单投影里标出来(与未知锚点同规:降级不拒载)。
   */
  entry?: string
}

/**
 * 锚点块(R5.x):插件在宿主 UI 具名锚点上的一块嵌入式 UI。
 *
 * 与面板同规:静态存在感(id/label/anchor)在这里声明,运行期的
 * `registerUiSlot` 只绑 render/onAction。命名不叫 `ui` ——
 * `contributes.settings.ui`(设置项 UI hint)已经占了这个词的另一种含义。
 */
export interface PluginContributionUiSlot {
  /**
   * 必须是宿主锚点清单中的一员。
   *
   * **未知锚点不拒绝加载**:该条 contribution 被丢弃并在清单投影标记
   * `unsupported`(设置页可见),插件其余能力照常 —— 多宿主与版本偏斜下
   * "宿主不认识这个锚点"不是代码错误,不该吃 registration 熔断(阈值 1)。
   */
  anchor: string
  id: string
  label: string
  /**
   * 消息作用域状态的生命期声明(见 plugin-message-state-2026-08.md):
   *  - `'persistent'`:插件消息态落盘 + 启动水合(重启后老消息仍有内容);
   *  - `'ephemeral'`(默认):纯内存,插件卸载即丢。
   *
   * 这是**闸门声明**,不是元数据:插件有任一 slot 声明 persistent,
   * 宿主才给它的 message-state 落盘。loader 只校验形状(必须是字符串);
   * 未知值(未来新生命期)在闸门处天然读成非持久 —— 与未知锚点同规。
   */
  lifetime?: 'persistent' | 'ephemeral'
  /**
   * 抽屉形态(F 期)—— **仅在开了抽屉能力的锚点上有效**(今天只有
   * `composer.above`)。声明它,宿主就在块壳右侧画一组开合钮,块进入三态:
   * 展开(整块,高度预算 240px,块内滚动)/ 半收(单行摘要,即老形态)/
   * 全收(退位到 S 状态带一枚 chip)。render ctx 随之带 `drawerState`
   * (只有前两档会拉 render)。
   *
   * 其它锚点上声明它:**该字段被忽略**并在清单投影标 `drawerIgnored`,
   * 插件照常加载 —— 与未知锚点降级同规(版本偏斜下"这个宿主的这个位置没有
   * 抽屉"不是代码错误)。未声明的块形态一字不变(定高,无开合钮)。
   */
  drawer?: boolean
  /**
   * 落在哪一侧(I 期)—— **仅在分侧锚点上有效**(今天只有 `composer.aside`
   * 的输入框两翼)。缺省 `'right'`。每侧只有 1 个席位,同侧的第二条声明按
   * 容量截断(设置页说"锚点已满"),不是加载错误。
   *
   * 不分侧的锚点上声明它:**该字段被忽略**并在清单投影标 `sideIgnored`,
   * 插件照常加载 —— 与 `drawer` 降级同规。
   */
  side?: 'left' | 'right'
}

/** 呈现提示:不给则由 schema 推导控件。 */
export interface PluginContributionSettingsUiHint {
  label?: string
  hint?: string
  /** 覆盖由 schema 推导出的控件;超出宿主控件集的值会被拒。 */
  control?: string
}

export interface PluginContributionSettings {
  title?: string
  /**
   * JSON Schema(不是 zod)—— 过线皆 JSON Schema,zod 只是插件侧书写糖。
   *
   * **它是这个插件配置的唯一事实源**(R3 裁决):没有运行期 registerSettings。
   * 宿主只读清单就能渲染配置区、校验、填默认值,一行插件代码都不执行 ——
   * 于是**未启用的插件也能配**。
   */
  schema?: Record<string, unknown>
  ui?: Record<string, PluginContributionSettingsUiHint>
}

/**
 * 主题 token 覆盖(B 期,L2)。
 *
 * 键是**既有主题 token 路径**(产品层 `CSS_VAR_MAP` 的键),值是颜色字面量。
 * 只允许覆盖既有 token,不允许新增 —— 新增 token 就是全局 CSS 注入的变体
 * (表达力文档 §3.2 的红线)。
 *
 * 键的合法性 core 判不了(主题表在产品层,core 不吃产品层),所以这里只校验
 * **形状**;键不在表里 / 值不过颜色白名单的条目在投影层被丢弃并标记,
 * **不拒载、不计熔断**(与未知锚点同规)。
 *
 * **同一张表里还有第二种地址**(批 3b):以 `--ot-` 开头的键是**表面旋钮**
 * (浓度 / 模糊半径这类连续量),值形如 `"45%"` / `"6px"`,不是颜色。
 * token 路径永远不以 `--` 起头,两个地址空间在语法上不可能撞车,所以没有第二个
 * manifest 字段。旋钮同样由产品层判(`themes/knobs.ts`:前缀放行 + 按后缀定类型
 * + 按类型钳制区间),core 这边一样只管形状。越界值会被**钳到边界**而不是丢弃。
 */
/**
 * 背景/材质层(G 期,L2.5 —— 表达力文档 §3.3.5)。
 *
 * `image` / `darkImage` 是**包内相对路径**(相对 `contributes.webviewRoot`,
 * 缺省 `webview/`),由 C 期的 `onething-plugin://` 协议服务 —— 那条协议只服务
 * 已启用插件的静态根,于是"背景图"不需要打开任意 URL 这个红线。
 *
 * 三个旋钮 opacity / blur / fit 是**枚举出来的**,不是 CSS 片段。判据与裁决
 * 全在 `background.ts`;非法声明**丢弃 background 并在投影里标记**(不拒载)。
 */
export interface PluginContributionThemeBackground {
  image: string
  darkImage?: string
  opacity?: number
  blur?: number
  fit?: 'cover' | 'contain' | 'tile'
}

export interface PluginContributionTheme {
  /**
   * token 覆盖。**可选** —— G 期起 `contributes.theme` 可以只声明 background
   * 而一个 token 都不覆盖(把它留成必填等于逼作者写一个空对象)。
   */
  overrides?: Record<string, string>
  /** 背景/材质层(G 期,L2.5)。 */
  background?: PluginContributionThemeBackground
  /**
   * 皮肤包(H3)—— token 表达不了的**形**,以枚举档位的方式开放。
   *
   * 键是宿主开放的旋钮名,值是该旋钮的**档位名**(不是 CSS 值):插件永远碰不到
   * CSS 值,宿主查表把档位翻成变量。所以这里没有、也不需要任何值的消毒 ——
   * 这与 `overrides` 收自由颜色字符串是两种安全模型。
   *
   * 旋钮/档位的唯一事实源是主题层的 `SKIN_TIER_VALUES`(core 吃不到主题模块,
   * 所以这里只标形状)。不认识的旋钮、枚举外的档位一律**丢弃该键并在投影里
   * 标记**,不是拒载(与未知锚点、token 覆盖同规)。
   */
  skin?: Record<string, string>
}

export interface PluginContributionActivation {
  /** 懒激活的触发条件;R2 只解析不消费。 */
  events?: string[]
}

/**
 * 氛围层(G2 —— 全窗动画覆盖)。
 *
 * `entry` 是**包内相对路径**(相对 `contributes.webviewRoot`,缺省 `webview/`),
 * 由 C 期的 `onething-plugin://` 协议服务,跑在一块内容之上、`pointer-events:none`
 * 的 sandbox iframe 里。判据与裁决全在 `ambient.ts`;非法声明**丢弃 ambient 并在
 * 投影里标记**(不拒载)。装前披露:`draws animated effects over the window`。
 */
export interface PluginContributionAmbient {
  entry: string
}

export interface PluginContributes {
  commands?: PluginContributionCommand[]
  panels?: PluginContributionPanel[]
  uiSlots?: PluginContributionUiSlot[]
  theme?: PluginContributionTheme
  /** 氛围层(G2 —— 全窗动画覆盖,内容之上)。 */
  ambient?: PluginContributionAmbient
  /**
   * webview 面板的静态资源根,**相对插件的 `dirPath`**(代码区,npm 形态即
   * `plugins/node_modules/<pkg>/`)。缺省 `webview`。
   *
   * 刻意**不是**家目录 `plugins/<id>/`:家目录是数据区(config/kv/storage),
   * 随包分发的静态资产跟着代码走。`onething-plugin://` 只服务这个根之内的文件,
   * 规范化 + realpath 复核之后仍须落在根内。
   */
  webviewRoot?: string
  settings?: PluginContributionSettings
  permissions?: string[]
  activation?: PluginContributionActivation
}

export interface PluginManifest {
  name: string
  version: string
  description?: string
  entry?: string
  author?: string
  /** 语义化版本下界;低于它的宿主拒绝加载(R2 起真正生效)。 */
  minAppVersion?: string
  contributes?: PluginContributes
}

/**
 * 插件来源。
 *
 * - `builtin` = 与 app 同一份构建;
 * - `user` = `~/.onething/plugins/` 的 npm 账本插件(有 plugin.json + package.json);
 * - `local` = 轻通道:`~/.onething/plugins-dev/<name>.ts|js` 单文件脚本,无 manifest、
 *   无 package.json、不进市场、不参与更新。能力面靠"没有声明就没有能力"自动收窄
 *   (见 `scanLocalPluginFiles` 与装配层的窄化 API)。
 */
export type PluginSource = 'builtin' | 'user' | 'local'

export interface CorePluginDefinition<TEntry = unknown> {
  id: string
  source?: PluginSource
  manifest: PluginManifest
  dirPath: string
  entryPath: string
  entry?: TEntry
  enabled: boolean
  error?: string
  /**
   * 扫描期就判定的"不该加载"原因:非法 contributes、minAppVersion 不满足。
   * 置位后 manager 直接把插件放进 error 态,**不执行任何插件代码** ——
   * 声明层的问题不该等到运行期才发作。
   */
  loadBlockedReason?: string
}

/**
 * 落盘的运行期健康。
 *
 * 只存"为什么"这一半:enabled:false 本来就持久化,但原因纯在内存里,重启之后
 * 插件就变成了"无因禁用"——用户看到一个自己没关过的开关是关的,没有任何解释。
 * 连败计数不落盘:它是本次进程的观察,跨重启累加没有意义。
 */
export interface PersistedPluginHealth {
  status: 'degraded' | 'disabled'
  lastError?: string
  lastErrorScope?: string
  lastErrorAt?: number
  disabledReason?: string
}

export interface PluginSettings {
  enabled?: Record<string, boolean>
  health?: Record<string, PersistedPluginHealth>
  /**
   * 插件自有配置,与 enabled/health 平级住在同一个 plugin-settings 文件里。
   *
   * 存的是**原始值**;读取路径做校验 + 默认值填充,写入路径做校验 + 剥未知键。
   * 存量非法值回退默认并 warn(zod .catch 语义)—— 不发明迁移框架。
   */
  config?: Record<string, Record<string, unknown>>
}

export interface CorePluginStoreData {
  [key: string]: unknown
}

export type PluginPermissionGuard =
  | 'safe'
  | 'sandboxed'
  | 'internal-check'
  | 'permission-gated'
  | 'external'

export interface CorePluginToolContext<TMetadata = unknown> {
  sessionId: string
  messageId: string
  toolCallId: string
  /**
   * F4 身份面:这一回合归属的 agent(纯透传,零新状态)。
   *
   * 三处身份口(promptContext / 工具 ctx / afterAssistantResponse)看到的是**同一个**
   * 值 —— 回合入口解析出来的那一个,不是各自现查 `session.agentId`(群房里那个
   * 字段会被协调器逐次翻面,现查等于每处各算各的)。
   *
   * 缺省 undefined = 这条会话没绑 agent。插件的作用域公式("自己的 scope + global")
   * 缺席时只剩 global,那是正确的降级。**不可当权限依据**:权限的主体是
   * `Principal`,它有被证明过的来路,这个字段没有。
   */
  agentId?: string
  workingDirectory?: string
  abortSignal?: AbortSignal
  metadata(input: { title?: string; metadata?: Partial<TMetadata> }): void
}

export interface CorePluginToolResult<TMetadata = unknown> {
  title: string
  output: string
  metadata: TMetadata
  /**
   * N6: end the agent loop after this turn's tools all settle. Set true to
   * signal "this is the final answer — do not run another LLM turn".
   */
  terminate?: boolean
}

export interface CorePluginToolDefinition<
  TParameters = unknown,
  TArgs = unknown,
  TContext = CorePluginToolContext,
  TResult = CorePluginToolResult,
> {
  name: string
  description: string
  parameters: TParameters
  execute(args: TArgs, ctx: TContext): Promise<TResult>
  /**
   * @deprecated R4b —— 概念已退役,而且插件填什么都不生效:插件工具的权限由
   * `plugin_exec` 这条效果说出来(恒 ask,"插件不能给自己发免检通行证")。
   * 字段保留是为了不改插件对外契约;宿主收到非 `permission-gated` 的值时只会
   * 打一句 warn。
   */
  permissionGuard?: PluginPermissionGuard
  /**
   * 与同一条 assistant 消息里的兄弟 tool_use 能不能重叠(N3)。
   *
   * `'parallel'` = 声明本工具无共享状态冲突,可与兄弟并发;`'sequential'` =
   * 执行屏障,等前面的落定并挡住后面的(pi 的判例:多个调用抢同一个共享游标);
   * 不声明 = 缺省 = 屏障 = 今天的行为。语义与校验见 `tool-execution-mode.ts`。
   */
  executionMode?: CorePluginToolExecutionMode
  /**
   * The prompt this tool brings with it (guideline bullets / workspace-rule
   * bullets / standalone sections; `CoreToolPromptContribution`). It rides the
   * tool surface: injected when the tool is in the request, gone when the tool
   * is disabled, off-scene, or the plugin is unloaded — no separate registration.
   * Structurally validated at registration; an illegal shape rejects **this
   * one tool** (like `executionMode`), never the whole plugin.
   */
  prompt?: CoreToolPromptContribution
}

export interface CorePluginCommandContext {
  sessionId: string
  cwd?: string
  steer(content: string): void
  followUp(content: string): void
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
  exec(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export interface CorePluginCommandDefinition<TContext = CorePluginCommandContext> {
  name: string
  description?: string
  usage?: string
  handler(args: string, ctx: TContext): Promise<void>
}

export interface CorePluginSchedulerAPI<
  TTaskRegistration,
  TTaskHandle,
  TTaskSnapshot,
  TRunOptions,
  TRunRecord,
> {
  register(task: TTaskRegistration): TTaskHandle
  getStatus(id: string): TTaskSnapshot | undefined
  list(): TTaskSnapshot[]
  refresh(id: string): TTaskSnapshot | undefined
  runNow(id: string, options?: TRunOptions): Promise<TRunRecord>
  setEnabled(id: string, enabled: boolean): TTaskSnapshot | undefined
}

export type CorePluginEventHandler = (envelope: {
  sessionId: string
  sequence: number
  timestamp: number
  event: { type: string; [key: string]: unknown }
}) => Promise<void> | void

export interface CorePluginStore {
  get<T = unknown>(key: string): T | undefined
  set<T = unknown>(key: string, value: T): void
  delete(key: string): void
  keys(): string[]
}

export interface MinimalCorePluginUI {
  /**
   * 静默横幅,可选带一声宿主音效(M1)。
   *
   * 第二参是**重载而不是替换**:`notify(msg, 'warn')` 是老签名,原样保留;
   * `notify(msg, { level, sound })` 是新形态。sound 只能点名
   * `PLUGIN_NOTIFY_SOUNDS` 里的枚举成员 —— 插件不带音频文件,也不能传频率/波形。
   * 缺省不出声;用户可在设置里对单个插件静音或一键全静(静音只掐声音,横幅照旧)。
   */
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
  notify(message: string, options: PluginNotifyOptions): void
  /**
   * 开合左栏(I 期)。
   *
   * **没有 manifest 权限门**:"能不能开合侧栏"不是一种数据访问,申报了用户
   * 也看不出它会在什么时候动。治理走**手势锚定** —— 只在这个插件刚刚收到
   * 一次 `ui:action` 派发之后的 5 秒内有效(`PLUGIN_LAYOUT_GESTURE_WINDOW_MS`)。
   *
   * 窗外调用回 `{ ok: false, error: 'gesture-required' }`,没有窗口的宿主
   * (CLI daemon / headless server)回 `'unsupported'`。**两种都是规则拒绝,
   * 不计熔断**(与声明门同规:插件没坏,是规则不让)。从不抛错。
   */
  toggleSidebar(): Promise<PluginLayoutResult>
  /**
   * 展开右工作台(I 期)。不传 `panelId` = 只展开;传了 = 同时聚焦该插件
   * 声明了 `placements: ['workbench']` 的那个面板 tab(复用 H1 的打开路径)。
   *
   * 手势锚定与错误码同 `toggleSidebar`。
   */
  openWorkbench(panelId?: string): Promise<PluginLayoutResult>
}

/**
 * 流状态面(R6)。
 *
 * 插件唯一一处**出现在对话流里**的界面:一行"我正在做什么"。
 * 生命周期由宿主兜底 —— 忘了 clear、中途抛错、被熔断,状态都会在流结束时被
 * 强制扫掉,不会在用户的对话里永远转圈。
 */
export interface CorePluginStatusAPI {
  /** 挂起一条状态;同一个 id 再来一次是**更新 label**,不是再堆一条。 */
  show(sessionId: string, status: { id: string; label: string }): void
  /** 撤下一条。插件正常路径应当自己调,但不调也不会留下残留。 */
  clear(sessionId: string, id: string): void
}

export interface CorePluginAPI<
  TTool,
  TEventHandler,
  TCommandOptions,
  TPromptContextProvider,
  TBeforeContextCompactHook,
  TAfterAssistantResponseHook,
  TSkillRootProvider,
  TStore,
  TScheduler,
  TUI = MinimalCorePluginUI,
  TRequestHandler = CorePluginRequestHandler,
  TStorage = CorePluginStorage,
  TPanelRegistration = CorePluginPanelRegistration,
  TStatus = CorePluginStatusAPI,
  TIMConnector = unknown,
  TUiSlotRegistration = CorePluginUiSlotRegistration,
  TSearchProviderRegistration = CorePluginSearchProviderRegistration,
  TDeepLinkActionRegistration = CorePluginDeepLinkActionRegistration,
  TCredentialStrategyRegistration = CorePluginCredentialStrategyRegistration,
> {
  readonly id: string
  registerTool(tool: TTool): void
  on(eventType: string, handler: TEventHandler): () => void
  steer(sessionId: string, content: string): void
  followUp(sessionId: string, content: string): void
  /**
   * 跨会话信使(N1)—— **三态投递矩阵**。
   *
   * `steer` / `followUp` 是纯入队:空闲会话不会因为它们起轮。这个函数补的就是
   * 那个洞 —— `{triggerTurn:true}` 让插件能把一个外部事件变成一轮对话。
   *
   * 声明门:`contributes.permissions` 要有 `sessions:post`(投递),会起轮的
   * 那一格还要 `sessions:trigger`。循环闸(跳数上限 + 每(插件,会话)对的频率)
   * 由宿主记账;拒绝一律回结构化 reason,**从不抛错**。
   */
  sendMessage(
    sessionId: string,
    content: string,
    options?: PluginSendMessageOptions,
  ): Promise<PluginSendMessageResult>
  /**
   * 感知快照(N1)。`sessions:peek` 声明门;未声明 = peek 回 null、list 回空。
   *
   * 全部从现成内存态现算(零新统计),正文永不整条出境(preview 硬截 120 字符)。
   */
  sessions: {
    peek(sessionId: string): Promise<PluginSessionPeek | null>
    list(): Promise<PluginSessionPeekLite[]>
  }
  /** `peek().state === 'idle'` 的便捷函数;读不到会话即 false。 */
  isIdle(sessionId: string): Promise<boolean>
  /**
   * 受管 LLM 调用(N7-b)。`llm:complete` 声明门;插件拿不到 apiKey / registry,
   * 只交出 messages、拿回 text。受管三要素(计费 source=plugin:<id> + 硬超时 +
   * 配额)在宿主实现里;失败(未声明 / 无面 / 配额 / 超时 / provider / 校验)
   * 抛结构化 `PluginLlmError`,由插件自己 catch。
   */
  llm: {
    complete(options: PluginLlmCompleteOptions): Promise<PluginLlmCompleteResult>
  }
  registerCommand(name: string, options: TCommandOptions): void
  registerPromptContextProvider(id: string, provider: TPromptContextProvider): void
  beforeContextCompact(id: string, hook: TBeforeContextCompactHook): void
  afterAssistantResponse(id: string, hook: TAfterAssistantResponseHook): void
  /**
   * 发送前拦截(N2)——**干预型**钩子,与上面两个观察型钩子不是一个家族。
   *
   * handler 返回 `{action:'continue'|'transform'|'handled'}`(或什么都不返回
   * = continue),多插件按全局规范顺序链式:transform 逐个累积文本,第一个
   * handled 短路后续、**不起模型轮**(用户消息照常持久化与显示)。
   *
   * 只看真实用户发送:系统内部源(goal / radio / collab / 别的插件的投递)
   * 一律不进链。抛错 / 超时 = 当作 continue(fail-open)—— 消息永远发得出去。
   *
   * 声明门:`contributes.permissions` 要有 `input:intercept`。
   */
  interceptInput(id: string, handler: PluginInputInterceptHandler): void
  /**
   * 工具调用拦截(N4)——**干预型**钩子,失败语义与 `interceptInput` 相反。
   *
   * handler 返回 `{action:'allow'|'block'|'rewrite'}`(或什么都不返回 = allow),
   * 多插件按全局规范顺序链式:rewrite 逐个累积参数(后手看到前手改写后的结果),
   * 第一个 block 短路后续。`block` 的 reason 会作为该工具的错误结果回给模型。
   *
   * 改写后的参数必须过工具既有的参数校验;过不了 = 当作 block(与 pi 不同,
   * 我们不跳校验)。
   *
   * **fail-closed**:抛错 / 超时(2s)/ 返回值读不懂一律阻断这一次调用 ——
   * 这里的默认动作是执行一个带副作用的工具。该插件连败到阈值后拦截面被降级,
   * 之后一律放行(单次 fail-closed、熔断后 fail-open)。
   *
   * 声明门:`contributes.permissions` 要有 `toolcall:intercept`。
   */
  interceptToolCall(id: string, handler: PluginToolCallInterceptHandler): void
  /**
   * 工具结果改写(N5)——**干预型**钩子,失败语义与 `interceptToolCall` 相反、
   * 与 `interceptInput` 相同(fail-open)。它是 `interceptToolCall` 在同一个工具
   * 执行函数里的镜像下手:一个在工具跑之前拦调用,一个在工具跑之后改结果。
   *
   * handler 返回 `{action:'keep'|'replace'}`(或什么都不返回 = keep),多插件按
   * 全局规范顺序链式:replace 逐个累积(后手看到前手改写后的结果)。没有 block、
   * 没有短路 —— 结果已经产生,只有改写没有拦截。`replace` 的 content 是纯文本
   * (不过 schema,只有长度上限),`isError` 可翻转(脱敏:把泄露路径的错误改成
   * 通用错误)。
   *
   * **fail-open**:抛错 / 超时(2s)/ 返回值读不懂一律当作 keep —— 默认动作是
   * 把工具产出的原始结果原样交给模型,无害。该插件连败到阈值后改写面被降级,
   * 之后它的改写被跳过(= 原结果)。
   *
   * 声明门:`contributes.permissions` 要有 `toolresult:intercept`(敏感 —— 它能
   * 读到所有工具输出,含文件内容与命令输出)。
   */
  interceptToolResult(id: string, handler: PluginToolResultInterceptHandler): void
  registerSkillRoot(provider: TSkillRootProvider): void
  /**
   * 统一请求通道:UI 侧 `platformApi.pluginRequest(pluginId, action, payload)`
   * 落到这里。payload 与返回值都必须 JSON-可序列化(宪法第 2 条),
   * 它们过的是一条将来会变成 RPC 的边界。
   */
  registerRequestHandler(action: string, handler: TRequestHandler): void
  /**
   * 声明式工作区面板(R5)。
   *
   * **只绑定行为**:面板的 id/label/icon 声明在 manifest 的 `contributes.panels`,
   * 这里的 id 必须与其中一项一致(不一致直接报错)。宿主凭清单渲染入口,
   * **一行插件代码都不执行** —— 于是"启用了但加载失败"的插件入口仍在,并且能把
   * 失败说出来。**停用的插件不贡献入口**(§5.5 拍板;清单投影按 enabled 过滤)。
   *
   * render 返回的是**纯数据描述树**(禁函数成员);按钮靠 actionId 寻址。
   * render/onAction 经统一请求通道执行,自动获得 R2 的超时预算与
   * `request:<action>` 熔断账。
   */
  registerWorkspacePanel(registration: TPanelRegistration): void
  /**
   * 锚点块(R5.x):在宿主 UI 的具名锚点上嵌一块 UI。
   *
   * 与 registerWorkspacePanel 同构:anchor/id 必须与 manifest 的
   * `contributes.uiSlots` 里某一项一致;render 返回同一套描述树协议,
   * 经同一请求通道执行(自动继承超时预算与熔断账)。ctx 比面板多两个字段:
   * `anchor`(插件知道自己在哪个锚点)与 `sessionId`(当前会话;宿主在会话
   * 切换时重拉 render —— 返回不依赖它的树即"全局块")。
   */
  registerUiSlot(registration: TUiSlotRegistration): void
  /** 插件自定义事件。投递名 = `plugin:<pluginId>:<name>`。 */
  events: {
    emit(eventName: string, payload?: unknown): void
  }
  /**
   * 插件自有配置的**访问面**(R3 裁决:不是注册面)。
   *
   * schema 的唯一事实源是 manifest 的 `contributes.settings.schema`;
   * 这里拿到的是宿主已校验、已填默认值的**冻结快照**(而不是活引用 ——
   * 同步跨进程读取在 H 线硬隔离后不可能成立,快照语义现在就定死)。
   */
  settings: {
    get<T = Record<string, unknown>>(): T
    onChange(callback: (config: Record<string, unknown>) => void): () => void
  }
  /**
   * 外观面的运行期调参(G 期,L2.5)。
   *
   * **仅 manifest 声明了 `contributes.theme.background` 的插件可调** —— 声明先于
   * 代码,和面板/锚点块同一条规矩。没声明就调,记一条 error 日志然后拒绝:
   * 它是作者写错了,但不该为它开一个熔断面(那会让一次笔误连坐整个插件)。
   *
   * partial 收 opacity / blur / fit(钳制:用户拖滑杆的结果不该把控件卡住)
   * 与 `image`(B 期,用户壁纸)。
   *
   * **image 只收 `storage:<相对路径>`** —— 指向用户经 `file-pick` 导进来、由宿主
   * 拷进 `plugins/<id>/storage/` 的那张图。包内换图仍然等于发新版本:一条相对
   * 包根的路径在这里会被拒。非法寻址或文件不存在 = **这一次调用整条被拒**
   * (背景保持原样),不计熔断。
   *
   * **`image: null` = 撤回运行期图**(恢复默认闭环):背景回落 manifest 声明的
   * 缺省图,`darkImage` 一并恢复(接管是成对的,撤销也成对)。`undefined` 仍然
   * 是"这次不动 image" —— 用户把设置里的文件清空时,插件该递的是 `null`。
   *
   * **不持久**:重启后回 manifest 缺省。要记住用户的选择,插件自己在 entry 启动时
   * 读一次 `api.settings.get()` 再调一次 —— 持久归插件,坐标系归宿主。
   */
  theme: {
    updateBackground(patch: {
      opacity?: number
      blur?: number
      fit?: 'cover' | 'contain' | 'tile'
      /** `storage:<相对 storage 根的路径>`;`null` = 撤回;别的前缀一律拒。 */
      image?: string | null
    }): void
  }
  onDispose(callback: () => void): void
  store: TStore
  /**
   * 插件的数据目录(R4)。作用域是**全局 per-plugin**:
   * `<store>/plugin-data/<pluginId>/`,要按 agent 分自己在里面建子结构。
   *
   * name 只接受单段文件名(路径穿越被拒);写入的值必须 JSON-可序列化。
   * 插件的全部落盘足迹 = 这个目录 + plugin-settings 里的三个键 ——
   * 卸载与孤儿归档都建立在这条契约上。
   *
   * **Date 的第三种分叉**:写进这里会落成 ISO 字符串,读回来是 string 不是
   * Date(IPC 的结构化克隆保留 Date、HTTP 的 JSON 变 ISO 串、落盘同样变串)。
   * 要跨面一致,插件自己存时间戳或字符串。
   *
   * 错误一律是 PluginStorageError,带 code:`invalid-name` / `not-serializable`
   * 是"别重试,改代码",`io` / `unavailable` 是"稍后再试"。
   */
  storage: TStorage
  scheduler: TScheduler
  ui: TUI
  /**
   * 流状态(R6):在会话气泡里说一句"我正在做什么"。
   *
   * 投递复用**双端共有的既有轨道**(`content:part` 会话事件):desktop 走
   * IPCBridge,web 走 SSE。措辞上要诚实 —— 轨道属实,但 web 端今天没有生产者
   * (方案 A 下 server 的插件入口全是 noop),真正跑起来要等 H 线。
   *
   * **网关是有意的降级面**:微信/Telegram 这类纯文本渠道不消费 ContentPart,
   * 于是插件状态在那里静默丢失。这是设计选择而不是缺陷 —— 把一行转圈状态翻译成
   * 一条 IM 消息,得到的是刷屏,而状态的价值恰恰在于它会消失。
   */
  status: TStatus
  /**
   * IM 连接器(R7 试点注册表)。
   *
   * 这是插件系统第一个对外开放的**既有注册表**。选它是因为它是候选里唯一自带
   * 退订函数的 —— 形状最适配 onDispose(变量提供者恰恰相反:它至今没有
   * unregister,原方案建议拿它当试点是选反了)。
   *
   * 拆除语义按策略表声明为 **`fail-open`**:插件停用时连接器从注册表摘除,
   * 此后经该 connector 的回复会抛一个说得清的错误(而不是静默丢消息),由调用方
   * 记为投递失败。**没有"回落宿主默认渠道"这种东西** —— 早先这里写的
   * degrade-to-default 是在描述一个不存在的回退(见 policy.ts 同款勘误)。
   * 已有会话不受影响(它们的历史与状态在会话存储里,与连接器无关)。
   *
   * 返回退订函数;插件不调也没关系,dispose 会兜底。
   * **仅桌面宿主执行**(§6 方案 A)。
   */
  registerIMConnector(connector: TIMConnector): () => void
  /**
   * 搜索供给方(M2):往「搜索一切」里投结果。
   *
   * 与 registerIMConnector 同构 —— 是 core 开放的又一个既有宿主动词面。声明门
   * `contributes.permissions` 要有 `search:provide`(装前确认页把它念给用户听)。
   * 结果形状是宿主枚举的**受控子集**(见 PluginSearchResult):插件给不了
   * sessionId / messageId / filePath / type,点击只回到插件自己的 `onAction`。
   *
   * **搜索不等慢插件**:超时 / 抛错的供给方本次直接弃(每个独立超时),不阻塞
   * 内置结果与其它供给方;连败按 `search-provide` 家族降级(停这一个供给方,
   * 不连坐插件其余能力)。返回退订函数;插件不调也没关系,dispose 会兜底。
   * **仅桌面宿主执行**(§6 方案 A)。
   */
  registerSearchProvider(registration: TSearchProviderRegistration): () => void
  /**
   * 深链动作(H4):让 `onething://x/<pluginId>/<action>` 能点名这个插件。
   *
   * 与 registerIMConnector / registerSearchProvider 同构 —— core 开放的第三个
   * 既有宿主动词面。声明门 `contributes.permissions` 要有 `deeplink:handle`
   * (未声明 = 结构化拒绝 + noop,**不计熔断**:那是 manifest 笔误,不该连坐插件)。
   *
   * **确认门在宿主,不在插件**:每一条深链在 handler 被调用之前都要用户看着全文
   * 按确认,插件无从跳过、也无从知道用户拒绝过几次(拒绝对插件是"什么也没发生")。
   * handler 拿到的是 `{ text, params }` —— text 是**数据不是指令**。
   *
   * 返回值只约定 `{ notice? }`(弹一条通知);其余能力靠插件自己的 api,
   * 各自权限各自管。超时 15s、连败按 `deep-link` 家族降级(停这一个动作,
   * 不连坐插件其余能力)。返回退订函数;插件不调也没关系,dispose 会兜底。
   * **仅桌面宿主执行**(§6 方案 A;而且只有桌面宿主注册了 URL scheme)。
   */
  registerDeepLinkAction(registration: TDeepLinkActionRegistration): () => void
  /**
   * 凭证轮换策略(批 E):决定一个空间的一个 provider 下一次用池里的哪条凭证。
   *
   * 与前三个注册表同构 —— core 开放的第四个既有宿主动词面。声明门
   * `contributes.permissions` 要有 `credentials:strategy`(未声明 = 结构化拒绝
   * + noop,**不计熔断**:那是 manifest 笔误,不该连坐插件)。
   *
   * **插件不见钥匙**:`ctx.entries` 是白名单投影(id / label / authType /
   * source / cooldownUntil / usage / lastErrorKind),`apiKey` / `oauthToken` /
   * `baseUrl` 一个字节都不出现;策略交回一个 entry id,宿主拿 id 去取真钥匙。
   *
   * **失效绝不阻塞起流**:超时(2s)/ 抛错 / 返回非法 id,一律回落内置
   * `priority-failover` 并按 `credential-strategy` 家族降级(停这一个策略,
   * 不连坐插件其余能力)。用户在面板里选中的 policy 字段**不被改写** ——
   * 插件回来自动生效。
   *
   * 返回退订函数;插件不调也没关系,dispose 会兜底。
   * **仅桌面宿主执行**(§6 方案 A;server / CLI daemon 只有默认空间,无池)。
   */
  registerCredentialStrategy(registration: TCredentialStrategyRegistration): () => void
}

export type CorePluginEntry<TAPI> = (api: TAPI) => void | Promise<void>
