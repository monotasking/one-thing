/**
 * 插件 UI **锚点**(R5.x-a)—— 宿主 UI 中允许插件嵌入的具名位置。
 *
 * 三条裁决落在这里:
 *  1. **锚点清单是宿主编译期常量,插件不能发明锚点。** 插件说"我要
 *     `composer.above`"宿主才知道往哪渲染;插件自造锚点名 = 宿主不知道在哪画。
 *     (对照:VS Code 的 contribution points 同样是宿主定义集合。)
 *  2. **锚点块 = 描述树**(复用 panel.ts 的协议/校验/渲染),与工作区面板同一套
 *     通道、同一套熔断账。"UI 永不执行插件代码"不因锚点而松动 —— 锚点是
 *     "渲染位置"的扩展,不是"执行模型"的扩展。
 *  3. **命名空间即契约**:锚点块走 `ui:render:<anchor>:<id>` /
 *     `ui:action:<anchor>:<id>` 请求通道,`ui:` 是宿主保留前缀(与 `panel:` 同规),
 *     插件不得自行注册该前缀下的 handler。
 *
 * 设计文档:docs/design/plugin-ui/plugin-ui-anchors-2026-08.md。
 */
import type {
  CorePluginPanelContext,
  PluginPanelActionResult,
  PluginPanelTree,
} from './panel.js'

// ── 锚点清单(单一事实源) ───────────────────────

/**
 * 锚点的形态轴(分类学 v2 §9.1 的 **kind** 轴)。
 *
 *  - `block`:**常显块** —— 内容始终渲染在位(composer.above / chat.status-bar /
 *    message.footer)。
 *  - `trigger`:**触发式** —— 平时只有宿主画的入口(菜单项 / 图标钮,形态由
 *    address 决定),点击才按需渲染内容弹层;关弹层即销毁。
 *
 * **kind 由宿主锚点表决定,不是插件声明的**(§9.1 拍板):插件说"我要进
 * message.actions",宿主知道那是 trigger 位。因此 `contributes.uiSlots` 的
 * 条目形状不变 —— 还是 `{ anchor, id, label }`。
 */
export type UiAnchorKind = 'block' | 'trigger'

export interface UiAnchorCapacity {
  /** 常显块 / 触发式(§9.1 kind 轴)。呈现权在宿主,插件零参与。 */
  kind: UiAnchorKind
  /**
   * 该锚点最多容纳几个插件块(trigger 锚点则是几个入口)。
   * 跨插件按全局规范顺序截断(见 ui-anchor-registry),插件内按 manifest 声明顺序。
   * **加载失败的块不计入**(折叠为聚合指示,健康插件不被挤掉)。
   */
  maxBlocks: number
  /**
   * 单块最大高度(px)。宿主用它做溢出裁剪与滚动。
   * trigger 锚点上它说的是**弹层内容**的最大高度 —— 入口是宿主原语,没有高度可言。
   * 抽屉块(drawer)上它说的是**半收档**的高度 —— 展开档看 `expandedMaxHeight`。
   */
  maxHeight: number
  /**
   * 该锚点是否支持**抽屉形态**(F 期)。
   *
   * 抽屉不是新 kind:它是 `block` 在某些锚点上的**能力扩展** —— 同一个块,
   * 宿主多画一组开合钮,三态(展开/半收/全收)由宿主持有。只有声明了
   * `drawer: true` 的块才拿到这组钮;其余块的形态一字不变(定高 maxHeight)。
   *
   * 不给 = 该锚点上的 `drawer` 声明**被忽略**(投影层标 drawerIgnored,不拒载)——
   * 与未知锚点降级同规:多宿主/版本偏斜下"这个宿主的这个位置没有抽屉"不是
   * 代码错误。
   */
  drawer?: boolean
  /** 抽屉展开档的高度预算(px);超出在块内滚动。仅 `drawer: true` 的锚点有意义。 */
  expandedMaxHeight?: number
  /**
   * 单块最大宽度(px)。**只有横向受限的锚点**才给(今天 = composer.aside 的
   * 两翼:它占的是输入框的边距空间,再宽就把输入框顶窄了)。不给 = 宽度由
   * 挂点的常规布局决定(横条上是内容宽,弹层里是弹层宽)。
   */
  maxWidth?: number
  /**
   * 该锚点是否**分侧**(I 期,composer.aside)。
   *
   * 分侧不是新 kind,也不是新 cardinality 值:它说的是同一个 address 上有两个
   * 互不相干的席位(左/右),`maxBlocks` 因此读作**每侧**的容量而不是总量。
   * 插件在 `contributes.uiSlots[].side` 里点名要哪一侧(缺省 right);同侧的
   * 第二条声明按容量截断(走既有 truncated 那条路,设置页说"锚点已满")。
   *
   * 不给 = 该锚点上的 `side` 声明**被忽略**(投影层标 sideIgnored,不拒载)——
   * 与 drawer 同规:多宿主/版本偏斜下"这个宿主的这个位置不分侧"不是代码错误。
   */
  sided?: boolean
  /** 推荐的描述树根节点形态(提示,不强制)。 */
  rootHint?: 'row' | 'stack' | 'any'
}

/**
 * 每个锚点的容量语义 —— **单一事实源**:锚点 id 的字面量联合从这里派生
 * (`keyof typeof UI_ANCHOR_CAPACITY`),UI_ANCHORS 的值反过来受它约束
 * (`satisfies`):任何一边漏配/多配/拼错都在 typecheck 变红。
 *
 * 注:设计文档初稿的 `UiAnchorId` 品牌类型 + `Record<品牌字面量, …>` 方案在
 * 实施时被否 —— TS 对品牌交叉键的映射类型**不做键集合校验**(漏键/多键都不红,
 * 实测),用普通字面量联合才能拿到真正的类型级钉住。
 */
export const UI_ANCHOR_CAPACITY = {
  /**
   * 输入框上方横条(composer-stack 顶部)。单行,最多 3 块。
   *
   * **唯一支持抽屉形态的锚点**(F 期):声明 `drawer: true` 的块由宿主多画一组
   * 开合钮,三态 —— 展开(240px 预算,块内滚动)/ 半收(32px 单行,即老形态)/
   * 全收(退位到 S 带一枚 chip)。未声明的块保持原样。
   */
  'composer.above': {
    kind: 'block', maxBlocks: 3, maxHeight: 32, drawer: true, expandedMaxHeight: 240, rootHint: 'row',
  },
  /** 聊天面底部状态条(ChatPanel 内,MessageList 之下)。横向,每块 icon+短文本。 */
  'chat.status-bar': { kind: 'block', maxBlocks: 8, maxHeight: 24, rootHint: 'row' },
  /**
   * 每条消息尾部(MessageItem 的 .message-footer,时间戳与操作行之间)。
   * 第一个**消息级**锚点:宿主按消息实例挂载,render ctx 额外带 messageId
   * (插件据此把状态按消息对号入座);只挂 assistant 消息。单行小字。
   */
  'message.footer': { kind: 'block', maxBlocks: 6, maxHeight: 24, rootHint: 'row' },
  /**
   * 每条 assistant 消息的 ⋯ 更多菜单(MessageActions 的 more-menu)。
   * **第一个触发式锚点**:入口是宿主画的菜单项(manifest label 直排),
   * 点击才拉树、画进弹层;关弹层即销毁。render ctx 与 message.footer 同款
   * (带 messageId)—— per-item 的"重内容"只能走这条路(§9.2 per-item 铁律)。
   */
  'message.actions': { kind: 'trigger', maxBlocks: 3, maxHeight: 320, rootHint: 'stack' },
  /**
   * 输入框工具条右侧按钮带(InputBox 的 .toolbar-right,附件按钮之前)。
   * 触发式:入口是一枚图标钮(Tooltip 显示 manifest label),点击开弹层。
   * 会话级 ctx(带 sessionId,不带 messageId)。
   */
  'composer.actions': { kind: 'trigger', maxBlocks: 3, maxHeight: 320, rootHint: 'stack' },
  /**
   * 输入框**两翼**(InputBox 的 .composer-anchor,左右各一条竖窄带,占的是
   * 输入框居中留下的边距空间)。I 期第一个**分侧**锚点:`sided: true` 让
   * `maxBlocks: 1` 读作**每侧 1 块**,插件用 `contributes.uiSlots[].side`
   * (`'left' | 'right'`,缺省 right)点名要哪一侧,同侧第二条按容量截断。
   *
   * 宽 ≤ 48px、高 ≤ 输入框(壳与输入框同排,超出块内裁切)。窄窗**整侧隐藏**
   * ——边距摆不下两翼时它是第一个该让路的东西(阈值见 §9.2 与 InputBox 的
   * `@media`)。语义:**只放辅助性内容**,核心功能不许只住这里(会被窄窗吃掉)。
   */
  'composer.aside': {
    kind: 'block', maxBlocks: 1, maxHeight: 160, maxWidth: 48, sided: true, rootHint: 'stack',
  },
  /**
   * 输入框**正下方**横条(composer-stack 底部,输入框与面板下沿之间)。
   * 输入的**后勤带**:与 composer.above 的"上下文带"上下分工 —— 上面放
   * "这一轮带着什么"(草稿上下文),下面放"发出去之后会怎样"(提示、配额、
   * 状态)。2 块 / 每块 ≤ 24px、宽随输入框;**无降级**(纵向恒在,不吃窄窗)。
   */
  'composer.below': { kind: 'block', maxBlocks: 2, maxHeight: 24, rootHint: 'row' },
} as const satisfies Record<string, UiAnchorCapacity>

/** 锚点 id 的字面量联合 —— 由容量表派生,不另写一份。
 *
 * 命名约定:`<区域>.<槽位>`,全小写(composer.above / chat.status-bar),
 * 与审计文档的候选清单(composer.dock / sidebar.menu / chat.header …)同规。
 *
 * 新增一个锚点要动**五处**(治理见设计文档 §9.4):本表、UI_ANCHORS、
 * renderer 侧挂点组件、拆除快照测试、§9.2 全量地址地图。 */
export type UiAnchor = keyof typeof UI_ANCHOR_CAPACITY

/**
 * 宿主支持的锚点清单(具名常量面)。值必须出自容量表的键集合 ——
 * `satisfies` 让拼错/自造锚点在 typecheck 就红。
 */
export const UI_ANCHORS = {
  composerAbove: 'composer.above',
  statusBar: 'chat.status-bar',
  messageFooter: 'message.footer',
  messageActions: 'message.actions',
  composerActions: 'composer.actions',
  composerAside: 'composer.aside',
  composerBelow: 'composer.below',
} as const satisfies Record<string, UiAnchor>

/** 这个字符串是不是宿主认识的锚点。未知锚点的处置见 loader/投影层(降级,不拒绝)。 */
export function isUiAnchor(value: string): value is UiAnchor {
  return value in UI_ANCHOR_CAPACITY
}

/**
 * 锚点的 kind —— 未知锚点返回 undefined(调用方按"不渲染"处置)。
 * 宿主据此决定入口形态;插件永远不问这个问题。
 */
export function uiAnchorKind(anchor: string): UiAnchorKind | undefined {
  return isUiAnchor(anchor) ? UI_ANCHOR_CAPACITY[anchor].kind : undefined
}

/** 触发式锚点判定(宿主挂点用;协议上 trigger 与 block 走同一套通道)。 */
export function isTriggerUiAnchor(anchor: string): boolean {
  return uiAnchorKind(anchor) === 'trigger'
}

// ── 分侧锚点(I 期,composer.aside) ────────────

/** 两翼的两个席位。左右各是一个**独立**的容量池。 */
export type UiSlotSide = 'left' | 'right'

/**
 * 没点名时落哪一侧。
 *
 * 选 right 而不是 left:输入框右侧已经是"动作侧"(工具条、发送钮),辅助
 * 指示落在同一侧读起来是一条视线;left 留给显式点名的插件。
 */
export const UI_SLOT_DEFAULT_SIDE: UiSlotSide = 'right'

/** 这个锚点分不分侧(今天只有 composer.aside)。 */
export function supportsUiSlotSide(anchor: string): boolean {
  return isUiAnchor(anchor) && capacityOf(anchor).sided === true
}

/** 过线的 side 是不是两个合法值之一(未知值一律读成"没声明")。 */
export function isUiSlotSide(value: unknown): value is UiSlotSide {
  return value === 'left' || value === 'right'
}

/**
 * 一条声明**实际**落在哪一侧。
 *
 * 不分侧的锚点返回 `undefined`(它没有"侧"这个概念);分侧锚点上未声明或
 * 声明了未知值 → 缺省侧。这是判据本体:投影层与 renderer 都问它,不各判各的。
 */
export function resolveUiSlotSide(anchor: string, declared: unknown): UiSlotSide | undefined {
  if (!supportsUiSlotSide(anchor)) return undefined
  return isUiSlotSide(declared) ? declared : UI_SLOT_DEFAULT_SIDE
}

/** 声明了 side 但锚点不分侧 —— 投影层据此标记(设置页可解释),不拒载。 */
export function isIgnoredUiSlotSideDeclaration(anchor: string, declared: unknown): boolean {
  return declared !== undefined && !supportsUiSlotSide(anchor)
}

/** 分侧锚点上单块的宽度预算(px);不分侧的锚点没有这个数。 */
export function uiSlotMaxWidth(anchor: string): number | undefined {
  return isUiAnchor(anchor) ? capacityOf(anchor).maxWidth : undefined
}

// ── 布局动词与手势锚定(I 期) ────────────────

/**
 * 插件可以请求的两件**布局**事:开合左栏、打开右工作台。
 *
 * 它们和其余 API 面有一个本质区别:**没有可申报的权限门**。"能不能开合侧栏"
 * 不是一种数据访问,写在 manifest 里也只是一句"我想要",用户看不出它会在
 * 什么时候动。于是治理不走声明门,走**手势锚定**:动词只在用户刚刚点过这个
 * 插件的东西之后的一小段时间里有效。
 */
export type PluginLayoutVerb = 'toggle-sidebar' | 'open-workbench'

/** 拒绝的两种理由 —— **都是规则拒绝,不是插件故障**,一律不计熔断。 */
export type PluginLayoutRejection =
  /** 窗外调用:用户没有刚刚点过这个插件的东西。 */
  | 'gesture-required'
  /** 这个宿主没有布局这回事(CLI daemon / headless server 没有窗口)。 */
  | 'unsupported'

/**
 * 结构化结果 —— 与 N1 的 sendMessage 同规:**从不抛错**,回一份带理由的结果。
 * 插件必须**感知得到**自己被拒了以及为什么,否则它只会以为"开出去了"。
 */
export interface PluginLayoutResult {
  ok: boolean
  error?: PluginLayoutRejection
  reason?: string
}

/**
 * 手势窗口(ms)。
 *
 * 5 秒:够一次"点了块里的按钮 → 宿主拉 onAction → 插件算完 → 请求开工作台"
 * 的往返(含一次网络/磁盘读),又短到用户不会把几分钟后突然跳出来的面板
 * 与自己刚才那一下联系不起来。
 */
export const PLUGIN_LAYOUT_GESTURE_WINDOW_MS = 5_000

/**
 * 每个插件最近一次收到 `ui:action` 派发的时刻。
 *
 * 记在**主进程**(core 与装配层同进程):renderer 侧记账的话,一个多窗口
 * 的宿主会有几份互相不认识的账,而"用户点过没有"是一件全局事实。
 * 只记一个时间戳,不记是哪个块 —— 手势锚定要回答的问题是"用户刚刚在跟这个
 * 插件互动吗",不是"是哪一次互动"。
 */
const uiActionGestures = new Map<string, number>()

/** 宿主派发了一次 `ui:action` —— 由 api-builder 的块 action 包装层调用。 */
export function noteUiActionGesture(pluginId: string, now: number = Date.now()): void {
  if (!pluginId) return
  uiActionGestures.set(pluginId, now)
}

/** 现在还在这个插件的手势窗口里吗。 */
export function hasFreshUiActionGesture(pluginId: string, now: number = Date.now()): boolean {
  const last = uiActionGestures.get(pluginId)
  return last !== undefined && now - last >= 0 && now - last <= PLUGIN_LAYOUT_GESTURE_WINDOW_MS
}

/**
 * 拆除面:插件停用/卸载即清账(不传 pluginId = 全清,测试用)。
 *
 * 留着的话"停用 → 立刻启用"会带回上一条生命周期里的手势,一个刚装回来的
 * 插件能在用户什么都没点的情况下先弹一次工作台。
 */
export function forgetUiActionGestures(pluginId?: string): void {
  if (pluginId === undefined) uiActionGestures.clear()
  else uiActionGestures.delete(pluginId)
}

// ── 抽屉形态(F 期) ─────────────────────────

/**
 * 抽屉的三态。**宿主持有**,插件只在 render ctx 上看到能渲染的那两档
 * (`collapsed` 不拉 render —— 块根本不渲染)。
 */
export type UiDrawerState = 'expanded' | 'peek' | 'collapsed'

/** 会拉 render 的两档 —— ctx.drawerState 的取值域。 */
export type UiDrawerRenderState = Exclude<UiDrawerState, 'collapsed'>

/** 抽屉的默认档:半收(= F 期之前的老形态,单行摘要)。 */
export const UI_DRAWER_DEFAULT_STATE: UiDrawerState = 'peek'

/**
 * 容量表的**宽化**读法。
 *
 * `as const satisfies` 把每个键钉成了字面量对象类型,可选字段(drawer /
 * expandedMaxHeight)在没写它的那几个键上压根不存在 —— 直接点属性 typecheck
 * 就红。走这个口子读,拿到的是接口本身。
 */
function capacityOf(anchor: UiAnchor): UiAnchorCapacity {
  return UI_ANCHOR_CAPACITY[anchor]
}

/** 这个锚点开不开抽屉能力(今天只有 composer.above)。 */
export function supportsUiDrawer(anchor: string): boolean {
  return isUiAnchor(anchor) && capacityOf(anchor).drawer === true
}

/**
 * 一条 `contributes.uiSlots` 声明**实际**是不是抽屉。
 *
 * 判据两条同时成立:锚点开了抽屉能力 + 该条声明了 `drawer: true`。
 * 其它锚点上的 `drawer` 声明在这里天然读成 false —— 这就是"忽略并投影标记"
 * 的判据本体,投影层与 renderer 都问它,不各判各的。
 */
export function isEffectiveUiDrawerSlot(anchor: string, declaredDrawer: unknown): boolean {
  return declaredDrawer === true && supportsUiDrawer(anchor)
}

/** 声明了 drawer 但锚点不支持 —— 投影层据此标记(设置页可解释),不拒载。 */
export function isIgnoredUiDrawerDeclaration(anchor: string, declaredDrawer: unknown): boolean {
  return declaredDrawer === true && !supportsUiDrawer(anchor)
}

/** 抽屉展开档的高度预算(px);非抽屉锚点回落到 maxHeight。 */
export function uiDrawerExpandedMaxHeight(anchor: string): number | undefined {
  if (!isUiAnchor(anchor)) return undefined
  const capacity = capacityOf(anchor)
  return capacity.expandedMaxHeight ?? capacity.maxHeight
}

/** 过线的 drawerState 是不是"会渲染的那两档"(未知值一律读成 undefined)。 */
export function isUiDrawerRenderState(value: unknown): value is UiDrawerRenderState {
  return value === 'expanded' || value === 'peek'
}

/**
 * 键集合一致性守卫:`UI_ANCHOR_CAPACITY` 的键集合必须等于 `UI_ANCHORS` 的
 * 产出集合。类型层面由 `Record<UiAnchor, …>` 兜住"漏配",这条运行时断言兜住
 * "多配"(加了一个锚点常量却忘了删容量表里的旧键,反之亦然)。
 * 装配期调用一次;测试里逐键反查。
 */
export function assertUiAnchorRegistryConsistency(): void {
  const anchors = Object.values(UI_ANCHORS) as string[]
  const capacities = Object.keys(UI_ANCHOR_CAPACITY)
  const missing = anchors.filter(id => !(id in UI_ANCHOR_CAPACITY))
  const extra = capacities.filter(id => !anchors.includes(id as UiAnchor))
  if (missing.length || extra.length) {
    throw new Error(
      `UI anchor registry inconsistency: missing capacity for [${missing.join(', ')}], `
      + `stale capacity for [${extra.join(', ')}]`,
    )
  }
}

// ── 请求通道寻址 ────────────────────────────

/** 请求通道上的两个 action 名 —— 宿主与插件的约定(与 panel:* 同规)。 */
export const PLUGIN_UI_RENDER_ACTION = 'ui:render'
export const PLUGIN_UI_INVOKE_ACTION = 'ui:action'

/** 块地址:`<anchor>:<id>` —— action 与 surface 共用的中段。 */
export function uiSlotAddress(anchorId: string, slotId: string): string {
  return `${anchorId}:${slotId}`
}

/**
 * 块在降级语义里的 surface id:`ui:<anchor>:<id>`。
 *
 * render 与 action 折叠成同一个 surface(describePluginSurface 负责)——
 * 它们是同一块 UI,分开降级会出现"画得出来但点不动"。panel-refresh 通知的
 * panelId 字段也用这个值,renderer 按它与块对号入座。
 */
export function uiSlotSurfaceId(anchorId: string, slotId: string): string {
  return `ui:${uiSlotAddress(anchorId, slotId)}`
}

/** `ui:` 是宿主保留的命名空间 —— 插件不能自己往里登记 handler(与 panel: 同规)。 */
export function isReservedPluginUiAction(action: string): boolean {
  return action.startsWith('ui:')
}

// ── 插件侧注册面 ─────────────────────────────

/**
 * 锚点块的 render/onAction 上下文。
 *
 * 在面板 ctx(requestId / abortSignal / refresh)之上多两个字段,**v1 就带上**:
 *  - `anchor`:插件知道自己在哪个锚点,返回"单行友好"或"整页友好"的树;
 *  - `sessionId`:该块当前所属的会话(宿主在会话切换时重拉 render)。
 *    返回不依赖 sessionId 的树即天然"全局块"。
 *
 * 没有 sessionId,"plan 插件显示当前会话执行状态"在多窗口/多会话下必然显示
 * 错误会话的状态 —— 这是验收判据的硬性依赖,不能推迟到二期再改协议。
 */
export interface CorePluginUiSlotContext extends CorePluginPanelContext {
  readonly anchor: string
  readonly sessionId: string | null
  /**
   * 仅消息级锚点(message.footer 常显块 / message.actions 触发式弹层):
   * 该块所属的消息 id —— 插件据此把状态按消息对号入座(每条消息一个实例)。
   * 会话级锚点不携带。
   */
  readonly messageId?: string | null
  /**
   * 仅抽屉块(F 期,composer.above 上声明了 `drawer: true` 的块):
   * 当前档 —— `'expanded'`(整块)或 `'peek'`(单行摘要)。插件据此返回
   * 不同的树;宿主在切档时重拉 render。
   *
   * **全收档不在取值域里**:全收的块根本不渲染,宿主不会发这次 render。
   * 非抽屉块不携带这个字段(append-only:老块看到的 ctx 一字不变)。
   */
  readonly drawerState?: UiDrawerRenderState
}

export interface CorePluginUiSlotRegistration<
  TTree = PluginPanelTree,
  TResult = PluginPanelActionResult,
> {
  /** 必须是宿主锚点清单中的一员(未知锚点 = 代码错误,registration 熔断)。 */
  anchor: string
  /** 必须与 manifest 的 contributes.uiSlots 里某一项(同 anchor)的 id 一致。 */
  id: string
  render(ctx: CorePluginUiSlotContext): TTree | Promise<TTree>
  onAction?(
    input: { actionId: string; payload?: unknown },
    ctx: CorePluginUiSlotContext,
  ): TResult | void | Promise<TResult | void>
}
