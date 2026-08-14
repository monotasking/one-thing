// @vitest-environment happy-dom
//
// K1 之后注册表里挂着**真组件**(内置面板的本体),import 它就等于 import 那
// 七棵组件树 —— 它们的模块求值要 `document`(theme store 开局就读 documentElement)。
// 与 `ui-drawer-state.test.ts` 同规:这一层本来就是 renderer 的东西。
/**
 * 面板注册表 —— 收编手抄清单之后,这里是那份清单唯一的守卫。
 *
 * 断言的重点不是"内容对不对",而是**别处不许再抄一份**:三个消费方
 * (App.vue / Sidebar.vue / RightWorkbenchPanel.vue)都必须从这里派生。
 *
 * 第三位从 `MediaPanel.vue` 换成了 `RightWorkbenchPanel.vue`(P1):那个自带
 * 顶部导航的全屏工作区容器已拆除,六个面板改成右侧工作台的「工作区域」页签,
 * 于是"面板清单"的读者也换了一个人 —— 换人不换规矩。
 *
 * K1(内核收缩,2026-08-14)之后清单不再是一个编译期数组,而是**注册表快照**:
 * 断言跟着改问注册表,内容一格没变。多出来的是"可注销"这件事本身能不能被
 * 验证 —— 注销一个面板,它必须从每一条入口一起消失;再注册回来必须原样恢复。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Puzzle } from 'lucide-vue-next'
import {
  findWorkspacePanel,
  isWorkspacePanelId,
  registerWorkspacePanel,
  setPluginWorkspacePanels,
  usePluginWorkspacePanels,
  useWorkspaceFeaturePanels,
  useWorkspaceNavEntries,
  workspacePanelRegistrySnapshot,
  workspacePanelWindowEvent,
  type WorkspaceNavId,
  type WorkspacePanelId,
} from '../panel-registry'

// 相对本文件定位,不是相对 cwd:vitest 从仓库根跑是约定而不是保证,
// 换个工作目录这些读文件的断言会变成一片 ENOENT,而不是一条清晰的失败。
const RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readRendererFile(relativePath: string): string {
  return readFileSync(join(RENDERER_ROOT, relativePath), 'utf-8')
}

const CONSUMERS = [
  'App.vue',
  'components/sidebar/Sidebar.vue',
  'components/workbench/RightWorkbenchPanel.vue',
] as const

/** 内置面板的 id,注册顺序即呈现顺序。 */
const BUILTIN_IDS = ['media', 'agents', 'tasks', 'music', 'practice', 'archive', 'trajectory']

function featureIds(): string[] {
  return workspacePanelRegistrySnapshot()
    .filter(panel => panel.kind === 'feature')
    .map(panel => panel.id)
}

describe('workspace panel registry', () => {
  // 注册表是模块级单例:任何一条用例往里塞的东西都要自己收走,否则下一条
  // 看到的清单就不是它以为的那一份(插件那批同理,统一清空)。
  afterEach(() => {
    setPluginWorkspacePanels([])
  })

  it('keeps the panels the shell had before the refactor, in the same order', () => {
    // 前六条是迁移当天的原班人马,顺序即呈现顺序;`trajectory`(主线 E1)是
    // 之后**追加**的第七条 —— 新面板一律往后加,不插队。
    // K1:清单从"编译期数组字面量"换成注册表快照,内容一格不变。
    expect(featureIds()).toEqual(BUILTIN_IDS)
  })

  it('has no flag left that nobody reads', () => {
    /*
     * `inSidebarMenu` 与 `openable` 都已删除。
     *
     * 前者记录的是历史包袱而不是设计(practice 走 window 事件进入、archive 是
     * 后加的、插件面板是新的),用户实测反馈推翻了那个区分 —— ⋯ 菜单现在覆盖
     * 全部 inPanelNav 面板。后者随之失去唯一消费者(App 的 activeWorkspacePanel
     * 类型),而**留一个没人读的旗子**正是 `mode: 'side'` 那次的病根:
     * 以死枝为前提的条件看起来有意义,实际恒定。
     */
    for (const panel of workspacePanelRegistrySnapshot()) {
      expect(panel, panel.id).not.toHaveProperty('inSidebarMenu')
      expect(panel, panel.id).not.toHaveProperty('openable')
    }
    // 只拦**字段定义形态**(带冒号):接口里再出现 `inSidebarMenu: boolean`
    // 或常量里再出现 `inSidebarMenu: true` 才算旗子复活。解释性注释里提一句
    // 旧旗子名(useWorkspaceNavEntries 的 JSDoc 就写了"此前菜单吃的是
    // inSidebarMenu 过滤后的子集")是历史说明,不是复活 —— 全局 not.toContain
    // 会把历史也误伤,那正是这个守卫自己不该犯的"以死枝为前提"的错。
    const source = readRendererFile('workspace/panel-registry.ts')
    expect(source).not.toContain('inSidebarMenu:')
    expect(source).not.toContain('openable:')
  })

  it('reproduces the panel nav exactly as it was (archive included)', () => {
    expect(useWorkspaceFeaturePanels().value.map(panel => panel.id)).toEqual(BUILTIN_IDS)
  })

  it('puts every inPanelNav panel — including nav-only ones — in the shared nav list', () => {
    // ⋯ 菜单与面板内导航吃同一份。archive 与 practice 都是 nav-only 的历史产物,
    // 此前在主窗口**没有任何入口**。
    const ids = useWorkspaceNavEntries().value.map(entry => entry.id)
    expect(ids).toContain('archive')
    expect(ids).toContain('practice')
    expect(isWorkspacePanelId('archive')).toBe(true)
    expect(isWorkspacePanelId('nope')).toBe(false)
  })

  it('keeps literal completion for builtin ids while accepting runtime plugin ids', () => {
    // 插件面板的 nav id 是运行期字符串(`plugin:<id>:<panel>`),编译期列不出来;
    // `(string & {})` 让内置 id 仍有字面量补全,同时接受插件 id。
    expectTypeOf<WorkspacePanelId>().toExtend<WorkspaceNavId>()
    const builtin: WorkspaceNavId = 'archive'
    const plugin: WorkspaceNavId = 'plugin:ui-demo:demo'
    expect([builtin, plugin]).toHaveLength(2)
  })

  it('records the window-event entries for the panels that have them', () => {
    // 三条 window 事件都与**发射端**交叉验证 —— 注册表记的是别人拥有的名字,
    // 抄错了它自己是不会知道的。
    const agentsStore = readRendererFile('stores/agents.ts')
    expect(agentsStore).toContain(`AGENT_OPEN_WORKSPACE_EVENT = '${workspacePanelWindowEvent('agents')}'`)

    const practiceStrip = readRendererFile('components/chat/PracticeStrip.vue')
    expect(practiceStrip).toContain(`new CustomEvent('${workspacePanelWindowEvent('practice')}')`)

    const webPlatform = readRendererFile('platform/web.ts')
    expect(webPlatform).toContain(`TODO_PLAN_WEB_WINDOW_EVENT = "${workspacePanelWindowEvent('tasks')}"`)

    expect(() => workspacePanelWindowEvent('media')).toThrow()
  })

  it('gives every panel a label, an icon and a body so no consumer has to invent one', () => {
    for (const panel of workspacePanelRegistrySnapshot()) {
      expect(panel.label, panel.id).toBeTruthy()
      expect(panel.icon, panel.id).toBeTruthy()
      expect(findWorkspacePanel(panel.id), panel.id).toBe(panel)
      // K1:内容分发从注册表取,所以"面板本体"是 descriptor 的一格 ——
      // 少一个 component 就是一条开得出页签、里面一片空白的路。
      expect(panel.component, panel.id).toBeTruthy()
    }
  })

  it('leaves no hand-written panel list behind in the three consumers', () => {
    for (const relativePath of CONSUMERS) {
      const source = readRendererFile(relativePath)

      // 形态一:类型联合 `'media' | 'agents' | …`。
      // 不写死顺序也不写死引号 —— 本次收编的漂移里就有换序和 archive 多一项,
      // 只认一种写法的正则抓不住下一次。
      expect(source, `${relativePath}: hand-written panel union`)
        .not.toMatch(/["']media["']\s*\|\s*["']agents["']|["']agents["']\s*\|\s*["']media["']/)

      // 形态二:数组字面量 `['media', 'agents', …]`。
      // navItems / workspaceActions 的漂移(practice 漏掉、archive 多出)正是
      // 这个形态 —— 上一版守卫只查联合,恰好放过了它。
      expect(source, `${relativePath}: hand-written panel array`)
        .not.toMatch(/\[\s*["']media["']\s*,\s*["']agents["']|\[\s*["']agents["']\s*,\s*["']media["']/)

      expect(source, `${relativePath}: must derive from the registry`)
        .toContain("from '@/workspace/panel-registry'")
    }

    // 死成员 'memory' 曾在 Sidebar 的 props 联合里存活了很久。
    expect(readRendererFile('components/sidebar/Sidebar.vue')).not.toContain("'memory' | 'media'")
  })

  /**
   * K1 的第三种手抄形态:**分发**。
   *
   * 清单收编之后工作台里还留着一条按 panelId 逐个点名的 `v-else-if` 链 ——
   * 那同样是一份手抄清单,只是抄的是"谁渲染什么"。漏一格的症状换了个样子
   * (页签开得出、里面一片空白),病根一模一样。
   */
  it('leaves no hand-written panel dispatch behind in the workbench', () => {
    const workbench = readRendererFile('components/workbench/RightWorkbenchPanel.vue')
    for (const id of BUILTIN_IDS) {
      expect(workbench, `workbench still names panel "${id}"`)
        .not.toContain(`tab.panelId === '${id}'`)
    }
    // 分发从 descriptor 上取。
    expect(workbench).toContain(':is="workspacePanelEntry(tab)?.component"')
  })

  // ── 可注册可注销(K0 disposer 语义)────────────────────────────────────

  it('register → unregister → register is a clean round trip', () => {
    const descriptor = {
      id: 'k1-probe',
      label: 'K1 Probe',
      icon: Puzzle,
      inPanelNav: true,
      component: { name: 'K1Probe', template: '<div />' },
    }

    const dispose = registerWorkspacePanel(descriptor)
    expect(featureIds()).toContain('k1-probe')
    expect(findWorkspacePanel('k1-probe')?.label).toBe('K1 Probe')
    expect(useWorkspaceFeaturePanels().value.map(panel => panel.id)).toContain('k1-probe')
    expect(useWorkspaceNavEntries().value.map(entry => entry.id)).toContain('k1-probe')

    // 注销 = 从**每一条**入口一起消失。留下任何一条就是一条死路径:
    // 菜单里点得到、页签开得出、内容取不到。
    dispose()
    expect(featureIds()).toEqual(BUILTIN_IDS)
    expect(findWorkspacePanel('k1-probe')).toBeUndefined()
    expect(useWorkspaceFeaturePanels().value.map(panel => panel.id)).not.toContain('k1-probe')
    expect(useWorkspaceNavEntries().value.map(entry => entry.id)).not.toContain('k1-probe')

    // 再注册即恢复(排在末尾 —— 注册顺序就是清单顺序,没有第二套排序)。
    const disposeAgain = registerWorkspacePanel(descriptor)
    expect(featureIds()).toEqual([...BUILTIN_IDS, 'k1-probe'])
    disposeAgain()
    expect(featureIds()).toEqual(BUILTIN_IDS)
  })

  it('refuses a duplicate id instead of silently letting the newcomer win', () => {
    const descriptor = { id: 'media', label: 'Impostor', icon: Puzzle, inPanelNav: true }
    // 静默后来者胜 = 一个面板被另一个悄悄顶掉,而"面板不见了"正是这张注册表
    // 当初被建出来要根治的失效模式。
    expect(() => registerWorkspacePanel(descriptor)).toThrow(/already registered/)
    expect(findWorkspacePanel('media')?.label).toBe('Media')
  })

  it('has an idempotent disposer — calling it twice never evicts a later namesake', () => {
    const first = registerWorkspacePanel({ id: 'k1-twice', label: 'First', icon: Puzzle, inPanelNav: true })
    first()
    const second = registerWorkspacePanel({ id: 'k1-twice', label: 'Second', icon: Puzzle, inPanelNav: true })
    first() // 第二次调用:必须是 no-op,不能连坐删掉同名的后来者
    expect(findWorkspacePanel('k1-twice')?.label).toBe('Second')
    second()
    expect(findWorkspacePanel('k1-twice')).toBeUndefined()
  })

  // ── 插件面板走同一条注册路径 ──────────────────────────────────────────

  it('registers plugin panels through the same table — builtins first, plugins after', () => {
    const panel = {
      pluginId: 'log-monitor',
      pluginName: 'Log monitor',
      panelId: 'logs',
      label: 'Agent logs',
      loaded: true,
    }
    setPluginWorkspacePanels([panel])

    // 同一张表:插件面板也是一条注册项,只是 kind 不同。
    const snapshot = workspacePanelRegistrySnapshot()
    expect(snapshot.map(item => item.id)).toEqual([...BUILTIN_IDS, 'plugin:log-monitor:logs'])
    expect(snapshot.at(-1)!.kind).toBe('plugin')
    // 插件面板不带真组件 —— 它由 PluginPanelHost 的描述树 / webview 渲染。
    // 判据是**没被授信**(D1 的不可信档),不是"它是插件":用户显式授信过的
    // 第三方拿同样的表达力,那一档随 K4 落地。
    expect(snapshot.at(-1)!.component).toBeUndefined()
    // 载荷原样保留(投影层给什么就是什么)。
    expect(usePluginWorkspacePanels().value).toEqual([panel])

    // 次序:内置在前、插件在后。
    expect(useWorkspaceNavEntries().value.map(entry => entry.id))
      .toEqual([...BUILTIN_IDS, 'plugin:log-monitor:logs'])

    // `findWorkspacePanel` 只答内置面板 —— 插件 nav id 在 openWorkspaceTab 里
    // 早被 parsePluginPanelNavId 分流走,到不了这条查询。
    expect(findWorkspacePanel('plugin:log-monitor:logs')).toBeUndefined()

    // 整批注销:停用一个插件 = 它的入口从每一条清单里消失。
    setPluginWorkspacePanels([])
    expect(workspacePanelRegistrySnapshot().map(item => item.id)).toEqual(BUILTIN_IDS)
    expect(usePluginWorkspacePanels().value).toEqual([])
  })

  it('drops a duplicate plugin nav id instead of throwing the whole list away', () => {
    // 第一方撞名是我们自己的 bug(抛);一个坏 manifest 不该让整块面板清单起不来。
    const panel = { pluginId: 'dup', pluginName: 'Dup', panelId: 'p', label: 'One', loaded: true }
    expect(() => setPluginWorkspacePanels([panel, { ...panel, label: 'Two' }])).not.toThrow()
    expect(usePluginWorkspacePanels().value.map(item => item.label)).toEqual(['One'])
  })
})
