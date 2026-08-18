/**
 * 插件系统的两张**策略表**(R7)。
 *
 * 一张管"运行期失败该罚多重",一张管"注册表被拆掉时正在用它的东西怎么办"。
 * 它们放在一起,是因为它们犯的是同一种错:**判据一旦撒在各个上报点上,就必然
 * 漂移**。这条战役里同一个病出现过五次(熔断计数按插件还是按 scope、transient
 * 的两类、终止事件名单、白名单的补集写法、以及 R7 自己第一版的 scope 反查守卫),
 * 每一次的修法都是同一句话:把判据收进一张表,并让"漏登记"变红。
 *
 * **"变红"必须靠类型,不能只靠正则。** R7 第一版用正则反查源码里的 scope 字面量,
 * 结果它只认两种写法 × 五个硬编码文件,`npm-install` 这个真实 scope 就从缝里
 * 漏了过去,而断言 `literals.size > 5` 永远是绿的 —— 一条自己失效了却看不出来的
 * 守卫。现在 scope 是**带品牌的类型**,只能由下面的工厂产出:写裸字符串在
 * typecheck 就红,正则只当兜底。
 */
import {
  PLUGIN_PANEL_INIT_ACTION,
  PLUGIN_PANEL_INVOKE_ACTION,
  PLUGIN_PANEL_RENDER_ACTION,
} from './panel.js'
import { PLUGIN_UI_INVOKE_ACTION, PLUGIN_UI_RENDER_ACTION } from './ui-anchor.js'
import { CORE_PLUGIN_FAILURE_THRESHOLD } from './runtime-guard-constants.js'

// ── scope 的类型化构造 ──────────────────────────

declare const PLUGIN_SCOPE_BRAND: unique symbol

/**
 * 失败车道的地址。
 *
 * 品牌类型:只能由 `pluginScope.*` 工厂产出。任何裸字符串传进上报口都会在
 * typecheck 失败 —— 这就是"新增 scope 必须在表里有条目"的执行点。
 */
export type PluginFailureScope = string & { readonly [PLUGIN_SCOPE_BRAND]: true }

const brand = (value: string): PluginFailureScope => value as PluginFailureScope

/**
 * 全部合法 scope 的构造口。
 *
 * 加一种失败面 = 在这里加一个工厂 + 在 `classifyPluginScope` 里归族 + 在
 * `PLUGIN_SEVERITY_TABLE` 里给规则。少任何一步,要么 typecheck 红,要么
 * "每个工厂的产出都能归族"那条测试红。
 */
export const pluginScope = {
  promptContext: (providerId: string) => brand(`promptContext:${providerId}`),
  beforeContextCompact: (hookId: string) => brand(`beforeContextCompact:${hookId}`),
  afterAssistantResponse: (hookId: string) => brand(`afterAssistantResponse:${hookId}`),
  /** 生命周期钩子的通用入口(宿主已有 scope 前缀时用它)。 */
  lifecycleHook: (scope: string, hookId: string) => brand(`${scope}:${hookId}`),
  event: (eventType: string) => brand(`event:${eventType}`),
  eventEmit: (eventName: string) => brand(`events.emit:${eventName}`),
  /** 插件自有请求通道。面板请求请用 panelRender / panelAction。 */
  request: (action: string) => brand(`request:${action}`),
  panelRender: (panelId: string) => brand(`request:${PLUGIN_PANEL_RENDER_ACTION}:${panelId}`),
  panelAction: (panelId: string) => brand(`request:${PLUGIN_PANEL_INVOKE_ACTION}:${panelId}`),
  /** 锚点块请求(R5.x)。address = `<anchor>:<id>`;render/action 折叠为同一 surface。 */
  uiSlotRender: (address: string) => brand(`request:${PLUGIN_UI_RENDER_ACTION}:${address}`),
  uiSlotAction: (address: string) => brand(`request:${PLUGIN_UI_INVOKE_ACTION}:${address}`),
  /**
   * 发送前拦截(N2)。带 hookId —— 一个插件可以注册多条拦截,连败要分得清是
   * 哪一条在坏;降级则聚合到同一个 surface(见 describePluginSurface)。
   */
  inputIntercept: (hookId: string) => brand(`inputIntercept:${hookId}`),
  /**
   * 工具调用拦截(N4)。与 inputIntercept 同形(带 hookId 记账、按 surface 降级),
   * 但**自成一族**:那一族的罚则理由写着"失败对用户完全无害",而这一族的失败
   * 会挡住一次工具执行 —— 同一条罚则文案不能同时为两种代价辩护。
   */
  toolCallIntercept: (hookId: string) => brand(`toolCallIntercept:${hookId}`),
  /**
   * 工具结果改写(N5)。与 toolCallIntercept 同形(带 hookId 记账、按 surface 降级),
   * 但**自成一族**:它 fail-open(失败 = 放行原结果,无害),罚则理由与
   * toolCallIntercept(fail-closed,失败会挡一次工具)必须分开写 —— 同一条罚则
   * 文案不能同时为两种代价辩护。
   */
  toolResultIntercept: (hookId: string) => brand(`toolResultIntercept:${hookId}`),
  storage: (operation: string) => brand(`storage.${operation}`),
  /**
   * 深链动作(H4)。address = `plugin:<pluginId>:<name>` —— 一个插件可以注册多个
   * 动作,连败要分得清是哪一个在坏,降级也只停那一个(整条 `onething://` 的门
   * 不因此关上)。
   */
  deepLinkAction: (address: string) => brand(`deepLink:${address}`),
  settingsChange: () => brand('settings:onChange'),
  steer: () => brand('steer'),
  followUp: () => brand('followUp'),
  /**
   * 跨会话投递(N1)。与 steer / followUp 同族 —— 它就是那两条队列的上层门面,
   * 外加"目标空闲则起一轮"这一格;失败同样是后台的,用户只会觉得"它没反应"。
   */
  sendMessage: () => brand('sendMessage'),
  /** 注册期违规:未声明的面板 id、抢占保留命名空间、连接器没有 id …… */
  registration: (what: string) => brand(`register:${what}`),
  /** 某条 IM 渠道的运行期失败。带 connector id —— 用户要知道是哪条渠道坏了。 */
  connector: (connectorId: string) => brand(`connector:${connectorId}`),
  /**
   * 搜索供给方(M2)的运行期失败。带 providerId —— 一个插件可注册多个供给方,
   * 连败要分得清是哪一个在坏;降级则折成同一个 `search:<id>` surface。
   */
  searchProvide: (providerId: string) => brand(`searchProvide:${providerId}`),
  /**
   * 凭证轮换策略(批 E)的运行期失败。address = `plugin:<id>:<name>`(也就是落进
   * credentials.json 的 policy 取值)—— 一个插件可注册多个策略,连败要分得清是
   * 哪一个在坏;降级则折成同一个 `credential-strategy:<policy>` surface。
   */
  credentialStrategy: (policy: string) => brand(`credentialStrategy:${policy}`),
} as const

/**
 * **显示标签**,不是判决车道。
 *
 * 加载期错误(依赖装不上、entry import 失败)走 `markLoadError`:它把原因写进
 * 健康态供设置页显示,**从不进 `recordFailure`** —— 不计连败、不触发罚则。
 * 所以严重度表里没有它们的家族。
 *
 * 之所以单独一族而不是塞进 `pluginScope`:R7 第一版把 `install` 当成判决车道
 * 放进了表,阈值 1 / disable-plugin,而它永远不生效 —— 一条纯死规则。
 * 更糟的是当时的守卫判据是"工厂被调用过",对这种"调用了但不进判决路径"的死法
 * 完全失明。两套词汇分开,这种事在类型上就说得清了。
 */
export const pluginLoadLabel = {
  /**
   * entry import 失败。
   *
   * **当前零生产调用者**:manager 的加载失败路径直接写 `CorePluginInfo.error`,
   * 健康态那侧什么也不知道。留着这个标签是为了让将来接线时有一个现成的名字,
   * 而不是让读者以为它已经在用 —— 如实记在这里,免得又变成一条看不出来的死码。
   */
  entry: () => brand('entry'),
} as const

// ── 表一:失败严重度 ────────────────────────────

/**
 * 罚则。
 *
 * - `disable-plugin`:整体禁用。用于**每轮都跑**的东西 —— 它坏了会拖垮全应用,
 *   禁用是较小的伤害。
 * - `degrade-surface`:只把出问题的那一个界面停掉,插件的工具/命令/提示词/
 *   定时任务照常。用于**用户主动触发**的东西。
 *
 * `degrade-surface` **不是"少罚一点"**:被降级的界面会在请求通道上被短路,
 * 后续调用直接返回带原因的错误,不再进插件。少了这一步,降级等于取消熔断
 * (R7 第一版就是这样 —— 必败的面板 action 照常一次次跑满 30s 预算)。
 */
/**
 * 降级界面的半开间隔。
 *
 * 有人在旁边点按钮的界面(面板)靠显式重试恢复(bypassDegraded);没人看着的
 * 界面(IM 渠道)只能靠时间 —— 没有等价物的话,解除降级的唯一路径是投递成功,
 * 而闸就在投递之前,那是一扇**单向的死门**。
 */
export const PLUGIN_SURFACE_PROBE_INTERVAL_MS = 60_000

export type PluginFailureRemedy = 'disable-plugin' | 'degrade-surface'

/**
 * **持久化上的语义分叉(有意为之,记录在案)。**
 *
 * `disable-plugin` 的结果会落盘(enabled:false + 原因),重启后仍然生效 ——
 * 因为它改的是用户可见的启停开关,不落盘就成了"一个用户没关过、又没有任何解释
 * 的关闭"。
 *
 * `degrade-surface` **不落盘**:它是一次运行期的自我保护,重启等于一次全新的
 * 尝试机会。一个因为网络抖动降级的面板不该在重启后仍然是灰的,而"重启试试"
 * 恰恰是用户遇到界面异常时的第一反应 —— 让它有效比让它一致更重要。
 */

export interface PluginSeverityRule {
  threshold: number
  remedy: PluginFailureRemedy
  /** 写给人看的一句话:为什么是这个罚则。 */
  rationale: string
}

/**
 * scope 家族 —— 每一个都必须在下面的表里有条目,并且**必须有真实生产者**。
 *
 * 加一个家族而忘了加规则 = typecheck 失败(Record 少键)。
 * 加一个没有生产者的家族 = "表里停放死规则"那条测试失败 —— R7 第一版的 `entry`
 * 家族就是这样一条死规则(加载失败全写进 CorePluginInfo.error,从不进熔断账),
 * 而最能证明"降级而非禁用"这条拍板的 `connector` 家族当时也是死的。
 */
export const PLUGIN_SCOPE_FAMILIES = [
  'prompt-context',
  'lifecycle-hook',
  'event-handler',
  'event-emit',
  'ui-request',
  'plugin-request',
  'storage',
  'settings-change',
  'conversation-control',
  'input-intercept',
  'toolcall-intercept',
  'toolresult-intercept',
  'registration',
  'connector',
  'search-provide',
  'deep-link',
  'credential-strategy',
] as const

export type PluginScopeFamily = (typeof PLUGIN_SCOPE_FAMILIES)[number]

/**
 * 默认阈值。
 *
 * 与 `CORE_PLUGIN_FAILURE_THRESHOLD` 是同一个数字 —— 后者是 R1 立的常量,这里
 * 引它而不是再写一份(R7 第一版写了第二份,于是 tracker 的 `threshold` 选项被
 * 表静默架空成了死配置)。
 */
export const PLUGIN_SEVERITY_TABLE: Record<PluginScopeFamily, PluginSeverityRule> = {
  // ── 每轮都跑的:坏了拖垮全应用,禁用是较小的伤害 ──
  'prompt-context': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: '每次发消息都跑;坏了每一轮对话都受影响,而用户看不到任何错误态。',
  },
  'lifecycle-hook': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: 'beforeContextCompact / afterAssistantResponse 每轮都跑,同上。',
  },
  'event-handler': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: '事件订阅是高频后台路径,失败完全不可见 —— 熔断存在的原始理由。',
  },
  'event-emit': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: '同上;而且发不出去的自定义事件会让别的插件静默失联。',
  },
  storage: {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: '写不进盘的插件继续跑只会积累更多不一致;停下来比带病运行安全。',
  },
  'settings-change': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: '配置推送失败意味着插件在用一份过期配置工作,而没人会发现。',
  },
  'conversation-control': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'disable-plugin',
    rationale: 'steer / followUp / sendMessage 直接改对话走向,失败是后台的,用户只会觉得"它没反应"。',
  },
  registration: {
    threshold: 1,
    remedy: 'disable-plugin',
    rationale: '注册期违规(未声明的面板 id、抢占保留命名空间、连接器没有 id)是'
      + '**代码错误**,不是运行期抖动,重试没有意义 —— 阈值 1,第一次就算数。',
  },
  // ── 干预型钩子:坏了要停掉这一个干预面,但绝不能连坐掉发消息 ──
  'input-intercept': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '发送前拦截(N2)是 fail-open 的:抛错 / 超时当作 continue,消息照常发出。'
      + '连败三次说明这条拦截在持续坏,再让它每次消耗 1.5s 预算只是在给每一次发送'
      + '加延迟 —— 停掉**这一个干预面**,插件的工具/命令/面板/定时任务全部照常。'
      + '整体禁用在这里是错的罚则:拦截失败对用户完全无害(他的消息发出去了),'
      + '为一个无害的失败面砍掉插件的全部能力是把小故障放大成大故障。'
      + '与 IM 渠道同规:没有"用户点重试"这种逃生口(闸在拦截口,拦截被跳过就'
      + '永远不会成功),所以它靠时间半开(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
  'toolcall-intercept': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '工具调用拦截(N4)是 fail-closed 的:抛错 / 超时 / 返回值读不懂一律'
      + '**阻断这一次调用**,因为默认动作是执行一个带副作用的工具,而我们无法确认'
      + '它该不该跑。于是这一族的降级罚则承担的是与 input-intercept 相反的职责:'
      + '它是这条链**唯一的逃生口**。连败三次说明这个拦截在持续坏,再让它每次'
      + '挡掉一个工具就是让一个坏插件瘫痪整个应用 —— 停掉**这一个干预面**之后'
      + '它不再参与判定,工具照常执行(单次 fail-closed、熔断后 fail-open)。'
      + '仍然不是整体禁用:插件的工具/命令/面板/定时任务与它的判断力无关。'
      + '半开同样靠时间(闸在拦截口,被跳过的插件永远不会有一次成功可记)。',
  },
  'toolresult-intercept': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '工具结果改写(N5)是 fail-open 的,与 toolcall-intercept 恰好相反:'
      + '结果早已产生,改写器抛错 / 超时只会让**模型看到未经改写的原始结果**,'
      + '工作流一步不断。它挂在工具执行之后、结果回模型之前,是 toolcall-intercept '
      + '在同一个函数里的镜像下手。连败三次说明这条改写在持续坏,再让它每次消耗 '
      + '2s 预算只是在给每一次工具结果加延迟 —— 停掉**这一个改写面**,插件的'
      + '工具/命令/面板/定时任务全部照常。整体禁用在这里是错的罚则:改写失败'
      + '对工作流无害(模型拿到了原结果),为一个无害的失败面砍掉插件全部能力是'
      + '把小故障放大成大故障。没有"用户点重试"的逃生口,靠时间半开'
      + '(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
  // ── 用户主动触发的:失败当场可见,不该连坐 ──
  'ui-request': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '面板动作是用户刚点下、当场看到错误态与重试按钮的 —— "运行期失败'
      + '不可见"这个前提不成立。面板只在打开时跑,失败自限于一个界面,'
      + '不该连坐掉插件的工具/命令/提示词/定时任务。降级后该面板的请求在'
      + 'manager.handleRequest 上被短路,不再一次次跑满超时预算。',
  },
  'plugin-request': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '插件自有请求同样是用户触发形态(UI 发起、当场看到结果),与面板同族;'
      + '同样在通道上被短路,所以不存在"取消了熔断"的问题。',
  },
  connector: {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '一条 IM 渠道坏掉只影响那条渠道;桌面端的会话与工具照常可用,'
      + '整体禁用会把渠道故障放大成插件故障。surface 带 connector id,'
      + '插件注册了多条渠道时用户能看出是哪一条。'
      + '闸不在请求通道上,而在 connector-registry 的投递口 —— 渠道投递不走那条通道。'
      + '没有"用户点重试"这种逃生口,所以它靠时间半开(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
  'search-provide': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '一个搜索供给方超时或抛错只影响它自己那一组结果:内置搜索与别的供给方'
      + '照常出结果,整体禁用会把一次搜索抖动放大成插件故障。这是键入延迟敏感路径,'
      + '连败三次说明这个供给方在持续坏,再让它每次吃满超时预算只是在给每一次键入'
      + '加卡顿 —— 停掉**这一个供给方**,插件的工具/命令/面板/定时任务照常。'
      + '闸不在请求通道上,而在聚合器调用供给方之前;没有"用户点重试"这种逃生口'
      + '(下一次键入还是会跳过它),所以它靠时间半开(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
  'deep-link': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '一个深链动作抛错 / 超时只影响那一个动作:`onething://ask` 与插件的其余'
      + '动作照常,整体禁用会把一个入口故障放大成插件故障。它与 ui-request 同族气质'
      + '(用户刚按下确认、当场看得到结果),但闸不在请求通道上,而在派发口 —— '
      + '降级之后确认卡上那一条**变灰而不是消失**(与触发式锚点同规:说得清"它'
      + '暂时不在",而不是让用户以为自己记错了)。没有"用户点重试"的逃生口,'
      + '靠时间半开(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
  'credential-strategy': {
    threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
    remedy: 'degrade-surface',
    rationale: '一个凭证策略超时或抛错只影响"这次挑哪把钥匙"这一个判断,而这个判断'
      + '**从来就有一个可用的默认答案**(内置 priority-failover)—— 整体禁用会把一次'
      + '挑选抖动放大成插件故障;更糟的是它坐在起流的关键路径上,升级成 disable-plugin '
      + '等于让一个坏策略能挡住用户发消息。所以罚则只能是降级:停掉**这一个策略**,'
      + '该空间的凭证改由内置 failover 挑,插件的工具/命令/面板照常。闸不在请求通道上,'
      + '而在装配层的策略调用口 —— 降级后连 handler 都不调,省掉每一次起流白等一个'
      + '超时预算。面板上那一项**变灰而不是消失**(与触发式锚点、深链动作同规),'
      + '用户存下的 policy 字段也原样保留 —— 插件回来自动生效。没有"用户点重试"的'
      + '逃生口,靠时间半开(PLUGIN_SURFACE_PROBE_INTERVAL_MS)。',
  },
}

/**
 * scope 字符串 → 家族。
 *
 * 顺序重要:`request:panel:*` 必须排在 `request:*` 前面。返回 null 表示"这个
 * scope 不在任何家族里" —— 品牌类型已经让裸字符串进不来,这里的 null 只可能
 * 出现在工厂加了却忘了归族的情况,由测试逐个工厂产出反查。
 */
export function classifyPluginScope(scope: string): PluginScopeFamily | null {
  if (!scope) return null
  if (scope.startsWith(`request:${PLUGIN_PANEL_RENDER_ACTION}:`)) return 'ui-request'
  if (scope.startsWith(`request:${PLUGIN_PANEL_INVOKE_ACTION}:`)) return 'ui-request'
  // webview 面板的初始化数据(C 期)与 render 同族:同样是用户主动触发、
  // 当场可见的一块 UI,降级不连坐插件其余能力。
  if (scope.startsWith(`request:${PLUGIN_PANEL_INIT_ACTION}:`)) return 'ui-request'
  // 锚点块(R5.x):与面板同一家族 —— 用户主动触发、当场可见,降级不连坐。
  // 必须在通配 `request:` 之前,否则落进 plugin-request 而让 surface 折叠漏接。
  if (scope.startsWith(`request:${PLUGIN_UI_RENDER_ACTION}:`)) return 'ui-request'
  if (scope.startsWith(`request:${PLUGIN_UI_INVOKE_ACTION}:`)) return 'ui-request'
  if (scope.startsWith('request:')) return 'plugin-request'
  if (scope.startsWith('promptContext')) return 'prompt-context'
  if (scope.startsWith('beforeContextCompact') || scope.startsWith('afterAssistantResponse')) return 'lifecycle-hook'
  if (scope.startsWith('events.emit')) return 'event-emit'
  if (scope.startsWith('event:')) return 'event-handler'
  if (scope.startsWith('storage')) return 'storage'
  if (scope.startsWith('settings:')) return 'settings-change'
  if (scope === 'steer' || scope === 'followUp' || scope === 'sendMessage') return 'conversation-control'
  if (scope.startsWith('inputIntercept')) return 'input-intercept'
  if (scope.startsWith('toolCallIntercept')) return 'toolcall-intercept'
  if (scope.startsWith('toolResultIntercept')) return 'toolresult-intercept'
  if (scope.startsWith('register')) return 'registration'
  if (scope.startsWith('connector')) return 'connector'
  // 搜索供给方(M2):必须在 register/connector 之后,`searchProvide` 不与它们撞前缀。
  if (scope.startsWith('searchProvide')) return 'search-provide'
  // 深链动作(H4):同样不与上面任何一个撞前缀 —— `deepLink:` 是它独占的。
  if (scope.startsWith('deepLink:')) return 'deep-link'
  // 凭证策略(批 E):`credentialStrategy:` 与上面任何一个都不撞前缀
  // (`connector` / `register` 都不同头),放最后即可。
  if (scope.startsWith('credentialStrategy:')) return 'credential-strategy'
  return null
}

export interface ResolvedPluginSeverity extends PluginSeverityRule {
  family: PluginScopeFamily | null
  /**
   * 降级时要停掉哪一个界面。
   *
   * 对面板是 `panel:<panelId>`(render 与 action 折成同一个界面 —— 它们本来就是
   * 一块 UI),对普通请求是 `request:<action>`,对渠道是 `connector:<id>`。
   */
  surface?: string
}

/** 未登记的 scope 一律按最保守处理(整体禁用)—— 与 R0–R6 的既有行为一致。 */
const UNCLASSIFIED_RULE: PluginSeverityRule = {
  threshold: CORE_PLUGIN_FAILURE_THRESHOLD,
  remedy: 'disable-plugin',
  rationale: '未登记的 scope:按既有行为整体禁用。品牌类型让它几乎不可能出现。',
}

export function resolvePluginScopeSeverity(scope: string): ResolvedPluginSeverity {
  const family = classifyPluginScope(scope)
  const rule = family ? PLUGIN_SEVERITY_TABLE[family] : UNCLASSIFIED_RULE
  if (rule.remedy !== 'degrade-surface') return { family, ...rule }
  return { family, ...rule, surface: describePluginSurface(scope) }
}

/**
 * 从 scope 里截出"是哪一个界面坏了"。
 *
 * render 与 action 折成同一个 `panel:<id>` —— 它们是同一块 UI,分开降级会出现
 * "画得出来但点不动"这种没人能理解的状态。**代价是恢复必须按 surface 聚合**
 * (见 CorePluginHealthTracker:action 降级后 render 成功也要能解除),
 * 否则会单向卡死。
 */
// 模块级常量:describePluginSurface 被 recordSuccess 的逐车道循环调用,
// 而 recordSuccess 每次发消息、每个事件都跑(它自己的注释强调"快路径必须零分配")。
// 每次现编一个 RegExp 正好违反那条。
// webview 面板的 init 与 render 折进**同一个** `panel:<id>`(C 期):一个面板
// 只有一种形态,两个 action 名只是两份返回值契约 —— surface 不因此分叉,
// 否则 webview 面板的降级会落在一个设置页认不出来的 surface 上。
const PANEL_SURFACE_PATTERN = new RegExp(
  `^request:(?:${PLUGIN_PANEL_RENDER_ACTION}|${PLUGIN_PANEL_INIT_ACTION}|${PLUGIN_PANEL_INVOKE_ACTION}):(.+)$`,
)
// 锚点块同规:render 与 action 折成同一个 `ui:<anchor>:<id>`(R5.x)。
const UI_SLOT_SURFACE_PATTERN = new RegExp(
  `^request:(?:${PLUGIN_UI_RENDER_ACTION}|${PLUGIN_UI_INVOKE_ACTION}):(.+)$`,
)

/**
 * 发送前拦截(N2)降级时停掉的界面名。
 *
 * 住在 policy.ts 而不是 input-intercept.ts,是为了避开一条真实的循环:
 * input-intercept 要 `runWithPluginTimeout`(runtime-guard),而 runtime-guard
 * 要 `resolvePluginScopeSeverity`(policy)。surface 名本来就是策略层的词汇。
 */
export const PLUGIN_INPUT_INTERCEPT_SURFACE = 'input-intercept'

/**
 * 工具调用拦截(N4)降级时停掉的界面名。同住 policy.ts,同一条循环理由
 * (tool-call-intercept.ts 要 runtime-guard,runtime-guard 要 policy)。
 */
export const PLUGIN_TOOL_CALL_INTERCEPT_SURFACE = 'toolcall-intercept'

/** N5 的降级界面名(与 pluginScope.toolResultIntercept 的前缀对应)。 */
export const PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE = 'toolresult-intercept'

export function describePluginSurface(scope: string): string {
  const panel = PANEL_SURFACE_PATTERN.exec(scope)
  if (panel) return `panel:${panel[1]}`
  const uiSlot = UI_SLOT_SURFACE_PATTERN.exec(scope)
  if (uiSlot) return `ui:${uiSlot[1]}`
  if (scope.startsWith('request:')) return scope
  if (scope.startsWith('connector')) return scope
  // 发送前拦截(N2):一个插件的**所有**拦截钩子折成同一个界面。
  // 与面板 render/action 折叠同理 —— 用户能理解的是"这个插件不再改我的输入了",
  // 不是"它的第二个钩子被停了而第一个还在"。逐 hookId 的连败账仍然分开记
  // (scope 带 hookId),只有降级的判据聚合。
  if (scope.startsWith('inputIntercept')) return PLUGIN_INPUT_INTERCEPT_SURFACE
  // 工具调用拦截(N4):同理聚合 —— 用户能理解的是"这个插件不再管我的工具了",
  // 而在 fail-closed 这一侧聚合还多一层意义:降级必须一次性移除该插件的**全部**
  // 拦截,否则它剩下的那条钩子会继续挡工具,逃生口只开了一半。
  if (scope.startsWith('toolCallIntercept')) return PLUGIN_TOOL_CALL_INTERCEPT_SURFACE
  // 工具结果改写(N5):同理聚合 —— 一个插件的所有改写钩子折成同一个界面,
  // 用户能理解的是"这个插件不再改我的工具结果了"。
  if (scope.startsWith('toolResultIntercept')) return PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE
  // 搜索供给方(M2):`searchProvide:<id>` 折成 `search:<id>` —— 与
  // pluginSearchProviderSurface 是同一把尺,聚合器据它短路。search 与 onAction
  // 共用同一 surface(一个供给方就是一块界面),降级一起挡。
  if (scope.startsWith('searchProvide:')) return `search:${scope.slice('searchProvide:'.length)}`
  // 深链动作(H4):`deepLink:<address>` 折成 `deeplink:<address>` —— 与
  // pluginDeepLinkSurface 是同一把尺,派发口据它短路(灰掉那一条,不关整扇门)。
  if (scope.startsWith('deepLink:')) return `deeplink:${scope.slice('deepLink:'.length)}`
  // 凭证策略(批 E):`credentialStrategy:<policy>` 折成 `credential-strategy:<policy>`
  // —— 与 pluginCredentialStrategySurface 是同一把尺,策略调用口据它短路(灰掉
  // 那一条策略,不关掉整个凭证池)。
  if (scope.startsWith('credentialStrategy:')) {
    return `credential-strategy:${scope.slice('credentialStrategy:'.length)}`
  }
  return scope
}

// ── 表二:注册表的拆除语义 ──────────────────────

/**
 * 一个注册表被插件占用着、而插件被停用时,正在用它的东西怎么办。
 *
 * - `reject-disable`:拒绝停用。用于**停用即数据损坏**的注册表。
 * - `degrade-to-default`:优雅撤下,调用方**回落宿主默认行为**(调用仍然成功)。
 * - `fail-open`:直接撤下,后续调用报错由调用方自理。
 *
 * 标签必须与实现一致 —— 测试会拿它反过来验行为(声明 degrade-to-default 的,
 * teardown 之后调用必须 resolve 到默认路径而不是 reject)。R7 第一版把
 * im-connector 标成 degrade-to-default 而实现是 throw,而当时的测试只断言
 * "理由字符串长度 > 20",标签与行为完全没有绑定。
 */
export type PluginRegistryTeardown = 'reject-disable' | 'degrade-to-default' | 'fail-open'

export interface PluginRegistryPolicy {
  teardown: PluginRegistryTeardown
  /** 停用时**正在用它的东西**会经历什么 —— 每个注册表开放时必须回答。 */
  inFlight: string
  /** 只在跑插件的宿主生效造成的行为分叉(§6 方案 A)。 */
  hostDivergence: string
  /**
   * 当前是否有**真实生产流量**流经它。
   *
   * 试点期为 false 时必须在这里说清楚 —— 否则文档与报告读起来会像它已经在工作,
   * 而实际上只有契约被验证过。
   */
  hasProductionTraffic: boolean
  /** 生产流量的现状说明。 */
  trafficNote: string
}

/**
 * 已经对插件开放的注册表。
 *
 * **纪律:一次只开一个。**
 *
 * 开放下一个要动的地方(如实列举,不是"两步"):
 *  1. 本表加一条(声明拆除语义、在飞语义、宿主分叉、是否有真实流量);
 *  2. `CorePluginAPI` 加方法 + `CorePluginAPIHost` 加转发口;
 *  3. api-builder 里实现(disposed 闩 + 退订进 disposeCallbacks + 失败进熔断账);
 *  4. app 层 host 对象加转发,必要时给注册表补 ownerPluginId 归属;
 *  5. 拆除快照测试加一行,并确认 C17 那条"转发口 ↔ 开放清单"守卫仍然绿。
 */
export const PLUGIN_OPEN_REGISTRIES = ['im-connector', 'search-provider', 'deep-link-action', 'credential-strategy'] as const

export type PluginOpenRegistry = (typeof PLUGIN_OPEN_REGISTRIES)[number]

export const PLUGIN_REGISTRY_POLICY: Record<PluginOpenRegistry, PluginRegistryPolicy> = {
  'im-connector': {
    // 实事求是:实现就是 fail-open —— sendIMReply 找不到 connector 直接抛,
    // 调用方(OutboundReplyDispatcher)catch 并记 failed。没有"宿主默认渠道"
    // 这种东西,把它标成 degrade-to-default 是在描述一个不存在的回退。
    teardown: 'fail-open',
    inFlight: '停用时退订函数被调用,连接器从注册表摘除;此后 sendIMReply 对该 '
      + 'connector id 抛一个说得清的错误(而不是静默丢消息),由调用方记为投递失败。'
      + '已有会话不受影响 —— 它们的历史与状态都在会话存储里,与连接器无关。',
    hostDivergence: '仅桌面宿主执行插件(§6 方案 A):server 端镜像里插件注册的连接器'
      + '不存在,经该渠道的回复会落到"未注册"错误。',
    hasProductionTraffic: false,
    trafficNote: '**当前无生产流量**:没有内置插件注册连接器,入站 normalizeIncoming '
      + '尚未接线(gateway 走自己的通路,OutboundReplyDispatcher 的 imOrigin 判定'
      + '把 gateway 来源排除在外)。试点验证的是**契约与拆除语义**,不是投递链路。'
      + '把 gateway 出站改走本注册表是下一步,不在 R7 范围内。',
  },
  'search-provider': {
    // 停用即撤下:聚合器不再迭代该供给方,点击一条已撤下供给方的结果回 false ——
    // 说得清地"不在了",不是静默误跳。没有"宿主默认供给方"这种回退,
    // 所以不是 degrade-to-default(那会描述一个不存在的默认路径)。
    teardown: 'fail-open',
    inFlight: '停用时供给方从注册表摘除;此后一次搜索聚合不再迭代它(内置结果与'
      + '其它供给方照常出结果),点击一条它贡献过的结果回 false —— invokePluginSearchAction '
      + '查不到该供给方即不派发,不报错也不误跳。已有会话与内置搜索都不受影响。',
    hostDivergence: '仅桌面宿主执行插件(§6 方案 A):server 端的搜索聚合里没有插件'
      + '供给方(它不装配插件系统),经 /api 的搜索只出内置结果。CLI daemon 压根没有'
      + '搜索窗。',
    hasProductionTraffic: false,
    trafficNote: '**当前无生产流量**:没有内置插件注册搜索供给方,样本 emoji-search '
      + '只构建不安装。验证的是**契约、并发聚合/超时即弃/熔断跳过、拆除语义**,'
      + '真实插件供结果的投递链路待第三方插件安装后。',
  },
  'deep-link-action': {
    // 停用即撤下:派发口查不到该动作,深链落到"这个动作不在了"这条**看得见的**
    // 拒绝上(用户刚点了一个链接,他得到一句回话)。没有"宿主默认动作"这种
    // 回退,所以不是 degrade-to-default —— 那会描述一个不存在的默认路径。
    teardown: 'fail-open',
    inFlight: '停用时退订函数被调用,动作从注册表摘除;此后指向它的 onething:// 链接'
      + '在**确认之前**就被判为"该动作已不可用"(确认卡直接说这句,而不是让用户'
      + '确认一个不会发生的动作)。已经确认、handler 正在跑的那一次不被打断 —— '
      + '它已经是插件自己进程里的一次调用,拆的是入口不是在飞的调用。'
      + '`onething://ask` 与其它插件的动作完全不受影响。',
    hostDivergence: '仅桌面宿主执行插件(§6 方案 A),而深链本身也只有桌面宿主接'
      + '(server 没有 URL scheme,CLI daemon 没有窗口)。两个"只在桌面"叠在一起,'
      + '这条注册表在别的宿主上是不存在而不是降级。',
    hasProductionTraffic: false,
    trafficNote: '**当前无生产流量**:主仓没有内置插件注册深链动作(样例翻译插件'
      + '另派)。`onething://ask` 这个**宿主**动词是真流量,但它不经过本注册表。'
      + '试点验证的是契约、声明门、超时/熔断与拆除语义。',
  },
  'credential-strategy': {
    // 停用即撤下:策略调用口查不到该策略,选择回落内置 priority-failover ——
    // 与前三个不同,**这里真的有一个宿主默认路径**,而且它是选择器本来就在跑的
    // 那一条。所以它是三个标签里唯一一个 `degrade-to-default`:调用仍然成功,
    // 只是挑法换回内置的。把它标成 fail-open 会是在描述一个不存在的失败。
    teardown: 'degrade-to-default',
    inFlight: '停用时退订函数被调用,策略从注册表摘除;此后 selectSpaceCredentialEntry '
      + '对该 policy 取值回落内置 priority-failover(**调用仍然成功**,起流不受影响)。'
      + '正在跑的那一次 select 不被打断,但它的结果会被丢弃 —— 契约里写明了 select '
      + '不得有副作用。**用户空间里的 `policy` 字段一个字节都不改**:那是用户的选择,'
      + '插件回来自动生效;面板上把它画成灰态并注明"策略不可用,正在使用内置 failover"。',
    hostDivergence: '仅桌面宿主执行插件(§6 方案 A):server / CLI daemon 不装配插件系统,'
      + '那里的 `plugin:*` policy 恒回落内置 failover。而且这两个宿主本来就只有默认'
      + '空间(无池),所以这条注册表在它们上面是"不适用"而不是"降级"。',
    hasProductionTraffic: false,
    trafficNote: '**当前无生产流量**:主仓没有内置插件注册凭证策略。验证的是契约、'
      + '脱敏投影、超时/非法返回值回落、熔断降级与拆除语义;真实插件供策略的链路'
      + '待第三方插件安装后。',
  },
}

export interface PluginDeferredRegistry {
  reason: string
  /** 卡在什么东西上(有明确前置条件时填)。 */
  blockedBy?: string
  /** 什么时候值得重新考虑。 */
  revisitWhen: string
  /** 相关代码位置或文档锚点。 */
  ref: string
}

/**
 * **明确不开**的注册表与理由。
 *
 * 键从 `PLUGIN_DEFERRED_REGISTRY_IDS` 派生,拼错 key 会 typecheck 红 ——
 * 上一版是无类型的 `Record<string, string>`,拼错了谁也不知道。
 */
export const PLUGIN_DEFERRED_REGISTRY_IDS = [
  'ai-provider',
  'variable-provider',
  'permission-capability',
  'post-trigger',
  'background-job',
] as const

export type PluginDeferredRegistryId = (typeof PLUGIN_DEFERRED_REGISTRY_IDS)[number]

export const PLUGIN_DEFERRED_REGISTRIES: Record<PluginDeferredRegistryId, PluginDeferredRegistry> = {
  'ai-provider': {
    reason: '会话正在用一个 provider 时把它抽走,语义最复杂:在飞请求、历史重建、'
      + '模型能力协商都要有答案,而这三件事没有一件是局部的。',
    revisitWhen: '有插件真的需要提供模型接入,而不是为了对称性而开。',
    ref: 'runtime/src/providers/',
  },
  'variable-provider': {
    reason: 'VariableRegistry 至今没有 unregister —— 开放它等于开放一个拆不掉的'
      + '注册表。(原方案建议拿它当第一个试点,恰好选反了:它是五个里唯一拆不掉的。)',
    blockedBy: 'VariableRegistry.unregister 尚不存在',
    revisitWhen: '补上退订面之后。',
    ref: 'runtime/src/variables/registry.ts',
  },
  'permission-capability': {
    reason: 'registerCapability 形状上可开,但它直接扩张安全面。插件还与宿主同进程时'
      + '开放它,等于让插件自己定义自己的权限边界。',
    blockedBy: 'H 线硬隔离(子进程 ext host)',
    revisitWhen: '与 H 线一起设计。',
    ref: 'core/permission/capability-registry.ts',
  },
  'post-trigger': {
    reason: '触发器每轮都跑,属 disable-plugin 那一族;一个坏触发器会拖垮整条回合。',
    revisitWhen: '有"一个坏触发器不拖垮整条回合"的证据之后。',
    ref: 'core/engine/triggers.ts',
  },
  'background-job': {
    reason: '与调度器职责重叠 —— api.scheduler 已经能表达绝大多数需求。',
    revisitWhen: '出现 scheduler 表达不了的真实用例。',
    ref: 'runtime/src/scheduler/',
  },
}
