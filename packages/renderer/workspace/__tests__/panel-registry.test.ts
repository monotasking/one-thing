/**
 * 面板注册表 —— 收编手抄清单之后,这里是那份清单唯一的守卫。
 *
 * 断言的重点不是"内容对不对",而是**别处不许再抄一份**:三个消费方
 * (App.vue / Sidebar.vue / RightWorkbenchPanel.vue)都必须从这里派生。
 *
 * 第三位从 `MediaPanel.vue` 换成了 `RightWorkbenchPanel.vue`(P1):那个自带
 * 顶部导航的全屏工作区容器已拆除,六个面板改成右侧工作台的「工作区域」页签,
 * 于是"面板清单"的读者也换了一个人 —— 换人不换规矩。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BUILTIN_WORKSPACE_PANELS,
  WORKSPACE_NAV_PANELS,
  findWorkspacePanel,
  isWorkspacePanelId,
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

describe('workspace panel registry', () => {
  it('keeps the panels the shell had before the refactor, in the same order', () => {
    // 前六条是迁移当天的原班人马,顺序即呈现顺序;`trajectory`(主线 E1)是
    // 之后**追加**的第七条 —— 新面板一律往后加,不插队。
    expect(BUILTIN_WORKSPACE_PANELS.map(panel => panel.id)).toEqual([
      'media', 'agents', 'tasks', 'music', 'practice', 'archive', 'trajectory',
    ])
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
    for (const panel of BUILTIN_WORKSPACE_PANELS) {
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
    expect(WORKSPACE_NAV_PANELS.map(panel => panel.id)).toEqual([
      'media', 'agents', 'tasks', 'music', 'practice', 'archive', 'trajectory',
    ])
  })

  it('puts every inPanelNav panel — including nav-only ones — in the shared nav list', () => {
    // ⋯ 菜单与面板内导航吃同一份。archive 与 practice 都是 nav-only 的历史产物,
    // 此前在主窗口**没有任何入口**。
    const ids = WORKSPACE_NAV_PANELS.map(panel => panel.id)
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

  it('gives every panel a label and an icon so no consumer has to invent one', () => {
    for (const panel of BUILTIN_WORKSPACE_PANELS) {
      expect(panel.label, panel.id).toBeTruthy()
      expect(panel.icon, panel.id).toBeTruthy()
      expect(findWorkspacePanel(panel.id)).toBe(panel)
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
})
