/**
 * 工作区面板注册表 —— 面板存在感的**单一事实来源**。
 *
 * 在这之前,同一份清单被手抄在 ≥6 处,并且已经漂移出真实缺陷:
 *  - `MediaPanel.vue` 的联合多出 `'archive'`,别处的联合都没有它;
 *  - 侧栏的 `workspaceActions` 漏了 `practice` —— 那个面板于是只能靠一条
 *    window 事件进入,图标入口根本不存在;
 *  - soul-memory 退役期间的工作树里,`Sidebar.vue` 的 props 联合与同文件的本地
 *    联合一度不同步(一边删了 `'memory'`,另一边还留着)。**这一条的审计对象是
 *    当时未提交的工作树**:在本文件落库的那个基线上两个联合都还含 `'memory'`。
 *    记它是因为它示范了同一种失效模式 —— 手抄清单在删除时同样会漏。
 *
 * 手抄清单的问题不是"重复",是**漏一个就等于把一个面板弄没**,而且编译器不会
 * 提醒。所以这里定义一次,别处一律派生。
 *
 * ── K1(内核收缩,2026-08-14)──────────────────────────────────────────────
 *
 * 这里从"静态 builtin 数组 + 插件面板另存一份 ref"升级成**一张可注册、可注销的
 * 注册表**(`docs/design/kernel-shrink-builtin-plugins-2026-08.md` §2 K1):
 *
 *  - `registerWorkspacePanel(descriptor)` 返回**注销函数**,与 K0 的 disposer
 *    语义同规 —— 注销 = 那个面板从「+」清单、侧栏 ⋯ 菜单、页签图标查询里一起
 *    消失,不留半条死路径;
 *  - 内置面板与插件面板走**同一条注册路径**(同一个数组、同一套顺序、同一个
 *    重复 id 判据),差别只剩下 `kind` 这一格:内置面板带一个**真组件**
 *    (D1 的"可信 by construction"),插件面板带一条 manifest 记录(由
 *    `PluginPanelHost` 的描述树 / webview 双形态渲染 —— 安全线是"宿主不执行
 *    **不可信**代码",不是"不执行插件代码");
 *  - 内容分发因此从工作台里那条 `v-else-if` 硬编码链搬到了 descriptor 上
 *    (`component` + `context` + `emits`)——工作台不再需要知道有哪几个面板。
 *
 * **K1 不迁任何功能**:七个内置面板仍在本文件里集中注册,组件仍是静态 import
 * (打包行为与从前逐字相同)。K2/K3 迁移时才把各自的 `registerWorkspacePanel`
 * 调用搬进各 feature 模块。
 *
 * ── 注册时机:模块求值即注册(与 app 层的"import 零副作用"纪律不同域)──────
 *
 * `@onething/app` 那一层禁止 import 副作用,因为它有一条显式装配序列
 * (`createOnethingBackend`),顺序问题必须留在那一处可读。renderer **没有**
 * 装配序列 —— 组件树自己就是装配,谁先 import 由打包器决定。所以这一层的合法
 * 形态正好相反:**模块求值时注册**,于是"import 到了就一定可用"。
 * 别把那条纪律搬过来用错域:两边守的不是同一件事。
 */
import { computed, shallowRef, type Component, type ComputedRef } from 'vue'
import { Puzzle } from 'lucide-vue-next'
import {
  Activity,
  Archive,
  Bot,
  CalendarClock,
  Images,
  Radio,
  Route,
} from 'lucide-vue-next'
import MediaPanelContent from '@/components/MediaPanelContent.vue'
import AgentsPanelContent from '@/components/AgentsPanelContent.vue'
import SchedulerPanelContent from '@/components/SchedulerPanelContent.vue'
import MusicPanelContent from '@/components/MusicPanelContent.vue'
import PracticePanelContent from '@/components/PracticePanelContent.vue'
import ArchivedChatsContent from '@/components/ArchivedChatsContent.vue'
import TrajectoryPanelContent from '@/components/TrajectoryPanelContent.vue'

/**
 * 宿主愿意注入的**渲染上下文键**。
 *
 * 只给面板**声明过**的那几格 —— 无脑全给会把 `active` 落进不声明这个 prop 的
 * 面板的 attrs,于是它的根节点上凭空多出一个 `active="true"` 属性(那就是一处
 * 可观察的 UI 变化)。清单短是刻意的:这是原语(「这一格是不是选中的那一格」),
 * 不是给某个面板开的洞。
 */
export type WorkspacePanelContextKey = 'active'

/**
 * 宿主愿意**接住**的面板事件。
 *
 * 同样按声明接:没声明就不接。这不只是洁癖 —— 面板的根节点往往是另一个组件
 * (多数面板的根是 `PanelShell`),无条件绑 `@close` 会让根组件自己发的同名
 * 事件穿透上来,把用户没要求关的页签关掉。
 */
export type WorkspacePanelEmitName = 'close' | 'jump-to-source'

export interface WorkspacePanelDescriptor {
  id: string
  label: string
  icon: Component
  /** 出现在工作区面板顶部的导航条。 */
  inPanelNav: boolean
  /**
   * 深在组件树里、够不着 emit 链的地方用的 window 事件入口。
   * 收编进注册表是为了让"这个面板有几条进入路径"这件事有地方可查。
   */
  windowEvent?: string
  /**
   * 面板本体(K1)。工作台从这里取组件,不再有 `v-else-if` 链。
   *
   * 这一格由**信任状态**决定,不由出身决定(D1:信任是唯一的轴)。今天填得起
   * 它的只有第一方 feature —— 它的可信是**构造性**的(本仓库内、随应用一起
   * 构建签名,今天的内置功能本来就是任意代码)。第三方插件目前一律是 D1 的
   * **不可信档**,这一格为空,由 `PluginPanelHost` 的描述树 / webview 渲染。
   *
   * "为空"的判据是**没被授信**,不是"它是插件":D1 的第二档(用户逐插件显式
   * 授信的第三方)拿的是同样的完整表达力,授信落地在 K4。所以别把这里读成
   * "插件永远不能有组件" —— 那正是 K1 要拆掉的出身论。
   */
  component?: Component
  /** 这个面板要宿主注入哪几格渲染上下文。 */
  context?: readonly WorkspacePanelContextKey[]
  /** 这个面板会往宿主发哪几个事件。 */
  emits?: readonly WorkspacePanelEmitName[]
}

/** 面板出身:第一方 feature / 插件贡献。表达力的差别只由这一格说。 */
export type WorkspacePanelKind = 'feature' | 'plugin'

export interface WorkspacePanelEntry extends WorkspacePanelDescriptor {
  kind: WorkspacePanelKind
  /** 插件面板才有:那条 manifest 投影(`PluginPanelHost` 吃的就是它)。 */
  plugin?: PluginContributedPanel
}

/**
 * 内置面板的声明。
 *
 * 顺序即注册顺序即呈现顺序(侧栏菜单与「+」清单都按它排)。
 *
 * `as const` 不是装饰:`WorkspacePanelId` 是从这里抽出来的**字面量联合**,
 * 少了它 `id: string` 会把联合拓宽回 `string`,`openWorkspaceTab('meida')`
 * 拼错一个名字就再也不报错了 —— 注册表化不等于放弃类型。
 */
const BUILTIN_WORKSPACE_PANELS = [
  {
    id: 'media',
    label: 'Media',
    icon: Images,
    inPanelNav: true,
    component: MediaPanelContent,
    emits: ['jump-to-source'],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    inPanelNav: true,
    // Agent 空间页:群聊气泡、dm 房头够不着 openWorkspacePanel 的 emit 链。
    windowEvent: 'agents:open-workspace',
    component: AgentsPanelContent,
    // 「私聊」/「TA 的群聊」开出去的会话落在主区,面板只需关掉自己那一格。
    emits: ['close'],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: CalendarClock,
    inPanelNav: true,
    windowEvent: 'todo-plan:web-window-action',
    component: SchedulerPanelContent,
    context: ['active'],
  },
  {
    id: 'music',
    label: 'Music',
    icon: Radio,
    inPanelNav: true,
    component: MusicPanelContent,
  },
  {
    id: 'practice',
    label: 'Practice',
    icon: Activity,
    inPanelNav: true,
    windowEvent: 'practice:open-workspace',
    component: PracticePanelContent,
    context: ['active'],
  },
  {
    id: 'archive',
    label: 'Archived Chats',
    icon: Archive,
    inPanelNav: true,
    component: ArchivedChatsContent,
  },
  {
    // 轨迹(主线 E1):会话事件日志的第二投影。聊天里的工具卡片够不着
    // openWorkspacePanel 的 emit 链,所以和 practice / agents 同款走 window 事件。
    id: 'trajectory',
    label: '轨迹',
    icon: Route,
    inPanelNav: true,
    windowEvent: 'trajectory:open-workspace',
    component: TrajectoryPanelContent,
  },
] as const satisfies readonly WorkspacePanelDescriptor[]

/**
 * 内置面板 id 的类型。
 *
 * 保持字面量联合而不是退化成 `string`:`openWorkspaceTab` 拼错一个名字仍然要在
 * 编译期被抓住 —— 注册表化不等于放弃类型。运行期注册进来的面板(插件面板、
 * K2 之后从 feature 模块注册的面板)编译期列不出来,走下面更宽的 `WorkspaceNavId`。
 */
export type WorkspacePanelId = (typeof BUILTIN_WORKSPACE_PANELS)[number]['id']

// ── 注册表本体 ────────────────────────────────────────────────────────────

/**
 * `shallowRef` 而不是 `ref`:这份清单里装着 Vue 组件与图标组件,深响应式会把
 * 它们逐个包进 Proxy(组件对象不是数据)。整条清单永远**整体替换**,浅层就够。
 */
const registeredPanels = shallowRef<readonly WorkspacePanelEntry[]>([])

function registerPanelEntry(entry: WorkspacePanelEntry): () => void {
  // 重复 id 直接抛(对齐 K0 判例):静默后来者胜 = 一个面板被另一个悄悄顶掉,
  // 而"面板不见了"正是这张注册表当初被建出来要根治的失效模式。
  if (registeredPanels.value.some(item => item.id === entry.id)) {
    throw new Error(`Workspace panel "${entry.id}" is already registered`)
  }
  registeredPanels.value = [...registeredPanels.value, entry]

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    registeredPanels.value = registeredPanels.value.filter(item => item !== entry)
  }
}

/**
 * 注册一个工作区面板,返回**注销函数**(K0 disposer 语义)。
 *
 * 注销之后这个面板从「+」清单、侧栏 ⋯ 菜单、页签图标查询里一起消失;再注册
 * 一次即恢复(排在当前清单末尾 —— 注册顺序就是清单顺序,没有第二套排序)。
 * 注销函数**幂等**:调两次不会连坐删掉后来同 id 的那一条。
 */
export function registerWorkspacePanel(descriptor: WorkspacePanelDescriptor): () => void {
  return registerPanelEntry({ ...descriptor, kind: 'feature' })
}

/** 注册表快照(全部面板,注册顺序)。测试与 `dump-features` 类诊断用。 */
export function workspacePanelRegistrySnapshot(): readonly WorkspacePanelEntry[] {
  return registeredPanels.value
}

/**
 * 内置面板(`kind: 'feature'`)按注册顺序 —— 呈现顺序的事实源。
 *
 * 插件面板不在这一份里:它们的页签走 `PluginPanelHost`(描述树 / webview),
 * 与带真组件的第一方面板不是同一条渲染路径。两者在**清单**上并列
 * (`useWorkspaceNavEntries`),在**渲染**上不并列。
 */
function featurePanels(): WorkspacePanelEntry[] {
  return registeredPanels.value.filter(panel => panel.kind === 'feature')
}

/** 导航条上的内置面板(响应式)。 */
export function useWorkspaceFeaturePanels(): ComputedRef<WorkspacePanelEntry[]> {
  return computed(() => featurePanels().filter(panel => panel.inPanelNav))
}

/**
 * 按 id 找一个**内置**面板。
 *
 * 刻意不搜插件面板:调用方(页签图标、window 事件、`openWorkspaceTab` 的内置
 * 分支)要的都是"带真组件的那一种"。插件 nav id 在 `openWorkspaceTab` 里先被
 * `parsePluginPanelNavId` 分流走,到不了这里。
 */
export function findWorkspacePanel(id: string): WorkspacePanelEntry | undefined {
  return featurePanels().find(panel => panel.id === id)
}

export function isWorkspacePanelId(value: unknown): value is WorkspacePanelId {
  return typeof value === 'string' && !!findWorkspacePanel(value)
}

/**
 * 某个面板的 window 事件入口名。
 *
 * 事件名的**事实源**仍在各自的产生方(例如 agents 的常量在 stores/agents.ts),
 * 注册表只是把"这个面板还有一条 window 事件入口"这件事记下来 —— 收编的是
 * 可发现性,不是所有权。
 */
export function workspacePanelWindowEvent(id: WorkspacePanelId): string {
  const panel = findWorkspacePanel(id)
  if (!panel?.windowEvent) throw new Error(`Workspace panel "${id}" has no window event entry`)
  return panel.windowEvent
}

// ── 插件贡献的面板(R5) ──────────────────────
//
// 静态存在感来自 manifest 的 `contributes.panels`,所以这份清单可以在**不执行
// 一行插件代码**的前提下装满 —— 启用但加载失败的插件照样有入口,并且能把
// 失败说出来;停用的插件不贡献入口。
// 内置面板是编译期常量,插件面板是运行期数据,两者在导航条上并列。

export interface PluginContributedPanel {
  pluginId: string
  pluginName: string
  panelId: string
  label: string
  /** 插件是否真的活着;停用的插件压根不进这份清单。 */
  loaded: boolean
  /** 呈现形态(C 期):'webview' = sandbox iframe;缺省描述树。 */
  view?: 'descriptor' | 'webview'
  /** webview 面板的入口 HTML(静态根内相对路径)。 */
  entry?: string
  /** 插件登记了 `panel:init:<id>` 吗(纯静态面板没有,合法)。 */
  hasInit?: boolean
  /**
   * 这个面板可以出现在哪些宿主表面(H1)。
   *
   * **勘误(P1,2026-08-13):`'workspace'` 这个落点已经不存在了。**
   * 主工作区容器(`MediaPanel.vue`)随双域页签迁移一并拆除,内置六面板与插件
   * 面板现在都是右侧工作台的一条 tab。声明值保留是因为它写在插件 manifest 里
   * (append-only,改口径等于让已发布的插件失效),但两个值现在**落点相同**:
   * 无论声明什么,面板都进工作台的「+」清单。
   *
   * `pluginPanelHasPlacement` 仍有一个真消费者:插件布局动词
   * (`api.ui.openWorkbench`,App.vue)。那条链路上它是**自荐闸** —— 插件把
   * 自己弹到前台必须先在 manifest 里说过要;而「+」清单是**用户主动找面板**,
   * 按声明过滤只会让缺省的插件面板一个入口都不剩。
   */
  placements?: string[]
}

/** 面板声明的宿主表面(缺省 `['workspace']`,与投影层裁决同一口径)。 */
export function pluginPanelPlacements(panel: Pick<PluginContributedPanel, 'placements'>): string[] {
  return panel.placements && panel.placements.length ? panel.placements : ['workspace']
}

/** 这个面板是否声明了某个宿主表面(缺省只算 workspace)。 */
export function pluginPanelHasPlacement(
  panel: Pick<PluginContributedPanel, 'placements'>,
  placement: string,
): boolean {
  return pluginPanelPlacements(panel).includes(placement)
}

/**
 * 插件面板这一批的注销函数。
 *
 * 插件清单是**整批**来的(一次 `getPlugins()` 投影),所以整批注销、整批重注册
 * —— 走的仍是上面那条 `registerPanelEntry`,插件面板与内置面板因此共用同一套
 * 顺序语义和同一个重复 id 判据。
 */
let pluginPanelDisposers: Array<() => void> = []

export function setPluginWorkspacePanels(panels: PluginContributedPanel[]): void {
  for (const dispose of pluginPanelDisposers) dispose()
  pluginPanelDisposers = []

  // 同一条 nav id 出现两次(理论上不该有:manifest 里的 panel id 在插件内唯一)
  // 就只收第一条。这里**不抛** —— 一个坏 manifest 不该让整块面板清单起不来;
  // 而 `registerWorkspacePanel` 那条第一方路径照旧抛(第一方撞名是我们自己的 bug)。
  const seen = new Set<string>()
  for (const panel of panels) {
    const id = pluginPanelNavId(panel.pluginId, panel.panelId)
    if (seen.has(id)) continue
    seen.add(id)
    pluginPanelDisposers.push(registerPanelEntry({
      kind: 'plugin',
      id,
      label: panel.label,
      // 图标由宿主统一给(UI 不执行插件代码,也不吃插件给的组件)。
      icon: PLUGIN_PANEL_ICON,
      inPanelNav: true,
      plugin: panel,
    }))
  }
}

export function usePluginWorkspacePanels(): ComputedRef<PluginContributedPanel[]> {
  return computed(() => registeredPanels.value
    .filter((panel): panel is WorkspacePanelEntry & { plugin: PluginContributedPanel } =>
      panel.kind === 'plugin' && !!panel.plugin)
    .map(panel => panel.plugin))
}

/** 导航条上的插件面板 id —— 与内置 id 不会撞:统一加前缀。 */
export function pluginPanelNavId(pluginId: string, panelId: string): string {
  return `plugin:${pluginId}:${panelId}`
}

export function parsePluginPanelNavId(navId: string): { pluginId: string; panelId: string } | null {
  const match = /^plugin:([^:]+):(.+)$/.exec(navId)
  return match ? { pluginId: match[1], panelId: match[2] } : null
}

/** 插件面板在导航条上的图标 —— 宿主统一给,插件不塞组件(UI 不执行插件代码)。 */
export const PLUGIN_PANEL_ICON = Puzzle

/**
 * 工作区面板的 nav id。
 *
 * 比 `WorkspacePanelId` 宽:插件面板的 id 是运行期字符串(`plugin:<id>:<panel>`),
 * 编译期列不出来。`(string & {})` 让内置 id 仍有字面量补全,同时接受插件 id。
 *
 * 这个类型此前手抄在 MediaPanel 里 —— 现在侧栏菜单与面板内导航都要用它,
 * 抄第二份就是下一次漂移的起点。
 */
export type WorkspaceNavId = WorkspacePanelId | (string & {})

export interface WorkspaceNavEntry {
  id: WorkspaceNavId
  label: string
  icon: Component
}

/**
 * 工作区面板的**完整**导航清单:内置的 inPanelNav 成员 + 全部插件面板。
 *
 * 侧栏「⋯」菜单与面板内导航吃的是**同一份** —— 两个入口只是触发方式不同
 * (菜单负责"打开面板并跳过去",面板内导航负责"在已打开的面板之间切"),
 * 呈现的集合必须一致。此前菜单吃的是 `inSidebarMenu` 过滤后的子集,
 * 于是 archive / practice / 全部插件面板在菜单里根本不存在。
 *
 * 次序:**内置在前、插件在后**,各自按注册顺序。这是一条投影规则而不是第二份
 * 清单 —— 插件那一批随时会整批注销重来(见 `setPluginWorkspacePanels`),
 * 让它们的注册时机决定内置面板排在哪儿是把偶然当语义。
 */
export function useWorkspaceNavEntries(): ComputedRef<WorkspaceNavEntry[]> {
  return computed(() => {
    const navPanels = registeredPanels.value.filter(panel => panel.inPanelNav)
    return [
      ...navPanels.filter(panel => panel.kind === 'feature'),
      ...navPanels.filter(panel => panel.kind === 'plugin'),
    ].map(panel => ({
      id: panel.id as WorkspaceNavId,
      label: panel.label,
      icon: panel.icon,
    }))
  })
}

// ── 内置面板的注册(K1:集中在本文件;K2/K3 迁移时搬进各 feature 模块)──────
//
// 模块求值时注册 —— 见文件头"注册时机"那一节:renderer 没有装配序列,
// "import 到了就一定可用"是这一层的正确语义。
for (const descriptor of BUILTIN_WORKSPACE_PANELS) {
  registerWorkspacePanel(descriptor)
}
