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
 */
import { computed, ref, type Component, type ComputedRef, type Ref } from 'vue'
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

export interface WorkspacePanelDefinition {
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
}

/**
 * 内置面板。
 *
 * 顺序即呈现顺序(侧栏菜单与面板导航条都按它排)。
 */
export const BUILTIN_WORKSPACE_PANELS = [
  { id: 'media', label: 'Media', icon: Images, inPanelNav: true },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    inPanelNav: true,
    // Agent 空间页:群聊气泡、dm 房头够不着 openWorkspacePanel 的 emit 链。
    windowEvent: 'agents:open-workspace',
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: CalendarClock,
    inPanelNav: true,
    windowEvent: 'todo-plan:web-window-action',
  },
  { id: 'music', label: 'Music', icon: Radio, inPanelNav: true },
  {
    id: 'practice',
    label: 'Practice',
    icon: Activity,
    inPanelNav: true,
    windowEvent: 'practice:open-workspace',
  },
  {
    id: 'archive',
    label: 'Archived Chats',
    icon: Archive,
    inPanelNav: true,
  },
  {
    // 轨迹(主线 E1):会话事件日志的第二投影。聊天里的工具卡片够不着
    // openWorkspacePanel 的 emit 链,所以和 practice / agents 同款走 window 事件。
    id: 'trajectory',
    label: '轨迹',
    icon: Route,
    inPanelNav: true,
    windowEvent: 'trajectory:open-workspace',
  },
] as const satisfies readonly WorkspacePanelDefinition[]

/**
 * 派生清单的元素类型。
 *
 * 刻意**不**标成 `WorkspacePanelDefinition[]`:那个接口的 `id: string` 会把
 * `as const` 保住的字面量重新拓宽回 `string`,`activeWorkspacePanel` 拼错名字
 * 就又不报错了 —— 收编手抄清单不等于放弃类型。
 */
export type WorkspacePanelEntry = (typeof BUILTIN_WORKSPACE_PANELS)[number]

/** 面板导航条(含只能内部切的成员)。 */
export const WORKSPACE_NAV_PANELS: readonly WorkspacePanelEntry[] =
  BUILTIN_WORKSPACE_PANELS.filter(panel => panel.inPanelNav)

/**
 * 面板 id 的类型。
 *
 * 保持字面量联合而不是退化成 `string`:`activeWorkspacePanel` 拼错一个名字
 * 仍然要在编译期被抓住 —— 收编手抄清单不等于放弃类型。
 */
export type WorkspacePanelId = (typeof BUILTIN_WORKSPACE_PANELS)[number]['id']

export function isWorkspacePanelId(value: unknown): value is WorkspacePanelId {
  return typeof value === 'string' && BUILTIN_WORKSPACE_PANELS.some(panel => panel.id === value)
}

export function findWorkspacePanel(id: string): WorkspacePanelEntry | undefined {
  return BUILTIN_WORKSPACE_PANELS.find(panel => panel.id === id)
}

/**
 * 某个面板的 window 事件入口名。
 *
 * 事件名的**事实源**仍在各自的产生方(例如 agents 的常量在 stores/agents.ts),
 * 注册表只是把"这个面板还有一条 window 事件入口"这件事记下来 —— 收编的是
 * 可发现性,不是所有权。
 */
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

const pluginPanels: Ref<PluginContributedPanel[]> = ref([])

export function setPluginWorkspacePanels(panels: PluginContributedPanel[]): void {
  pluginPanels.value = panels
}

export function usePluginWorkspacePanels(): Ref<PluginContributedPanel[]> {
  return pluginPanels
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
 */
export function useWorkspaceNavEntries(): ComputedRef<WorkspaceNavEntry[]> {
  return computed(() => [
    ...WORKSPACE_NAV_PANELS.map(panel => ({
      id: panel.id as WorkspaceNavId,
      label: panel.label,
      icon: panel.icon,
    })),
    ...pluginPanels.value.map(panel => ({
      id: pluginPanelNavId(panel.pluginId, panel.panelId) as WorkspaceNavId,
      label: panel.label,
      icon: PLUGIN_PANEL_ICON,
    })),
  ])
}

export function workspacePanelWindowEvent(id: WorkspacePanelId): string {
  const panel = findWorkspacePanel(id) as WorkspacePanelDefinition | undefined
  if (!panel?.windowEvent) throw new Error(`Workspace panel "${id}" has no window event entry`)
  return panel.windowEvent
}
