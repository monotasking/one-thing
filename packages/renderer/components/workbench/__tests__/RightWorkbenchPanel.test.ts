// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// C2:`trajectory` 从 feature 模块注册,名册只在启动入口 `main.ts` 被 import。
// 单测不跑 main.ts,所以「+」清单要覆盖到它就得在这里手动重现那一行。
import '@/features'
import RightWorkbenchPanel from '../RightWorkbenchPanel.vue'

const mocks = vi.hoisted(() => ({
  editorWorkspace: {
    setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  },
  // variables 域已迁到通用 RPC 通道(P4c):面板引的是壳外客户端,不再是
  // platformApi 上的 listVariables。
  variablesApi: {
    list: vi.fn(),
  },
  // 空壳:只为让 `platformApi` 解析到 electron 分支(推送订阅走 `?.`,
  // 缺席即 no-op)。本文件用到的域面全部走壳外客户端。
  electronAPI: {} as Record<string, unknown>,
  // terminal 域已迁到通用 RPC 通道(P4 终态批 D2):面板经 store 用的是壳外客户端
  // `@/platform/terminal-client`,不再是 platformApi 上的 listTerminals/createTerminal。
  terminalApi: {
    list: vi.fn(),
    create: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    attach: vi.fn(),
    ack: vi.fn(),
  },
}))

vi.mock('@/composables/useEditorWorkspace', () => ({
  useEditorWorkspace: () => mocks.editorWorkspace,
}))

vi.mock('@/platform/terminal-client', () => ({ terminalApi: mocks.terminalApi }))

vi.mock('@/platform/variables-client', () => ({ variablesApi: mocks.variablesApi }))

// 大纲页签会去问会话目录(P4c 第五批起走 `sessions` RPC 域)。本文件的契约是
// 「页签怎么开怎么关」,不是目录内容 —— 桩掉传输面,免得跑去真的打 rpcInvoke。
vi.mock('@/platform/sessions-client', () => ({
  sessionsApi: { getSegments: async () => ({ success: true, segments: [] }) },
}))

// The real TerminalView opens an xterm instance — meaningless (and crash-prone)
// under happy-dom. The panel contract is just "render a view for terminalId".
vi.mock('@/components/terminal/TerminalView.vue', () => ({
  default: {
    name: 'TerminalView',
    props: ['terminalId'],
    template: '<div class="mock-terminal-view">{{ terminalId }}</div>',
  },
}))

// The real thread panel pulls the chat/sessions stores and the whole StepsPanel
// tree; the panel contract here is just "render a thread view for sessionId".
vi.mock('../ThreadChatDetail.vue', () => ({
  default: {
    name: 'ThreadChatDetail',
    props: ['sessionId'],
    emits: ['openFile', 'titleResolved'],
    template: `
      <div class="mock-thread-workbench">
        {{ sessionId }}
        <button class="mock-thread-title" @click="$emit('titleResolved', '换核验证')">title</button>
      </div>
    `,
  },
}))

// 插件面板作为 workbench tab(H1)。真 PluginPanelHost 会在挂载时打
// platformApi.pluginRequest 拉描述树 —— 这里的契约只是"plugin tab 渲染
// PluginPanelHost 并把面板对象喂进去",所以桩成一个显式的可断言标记。
vi.mock('@/components/plugins/PluginPanelHost.vue', () => ({
  default: {
    name: 'PluginPanelHost',
    props: ['panel'],
    template: '<div class="mock-plugin-panel-host">{{ panel.pluginId }}:{{ panel.panelId }}</div>',
  },
}))

// 六个工作区面板本体各拖着一整棵 store 树(media / agents / scheduler / music /
// practice / archive)。这一层的契约只是"workspace 页签渲染对应的面板本体",
// 所以桩成可断言的标记。
function workspacePanelStub(name: string) {
  return {
    default: {
      name,
      props: ['active'],
      // `jump-to-source` 只有 Media 会发,但桩共用一份 —— 多声明一个不改变行为。
      emits: ['close', 'jump-to-source'],
      template: `<div class="mock-workspace-panel" data-panel="${name}"><button class="mock-panel-close" @click="$emit('close')">x</button></div>`,
    },
  }
}
vi.mock('@/components/MediaPanelContent.vue', () => workspacePanelStub('media'))
vi.mock('@/components/AgentsPanelContent.vue', () => workspacePanelStub('agents'))
vi.mock('@/components/SchedulerPanelContent.vue', () => workspacePanelStub('tasks'))
vi.mock('@/components/MusicPanelContent.vue', () => workspacePanelStub('music'))
vi.mock('@/components/PracticePanelContent.vue', () => workspacePanelStub('practice'))
vi.mock('@/components/ArchivedChatsContent.vue', () => workspacePanelStub('archive'))

// 会话域头两条(L3,原大纲栏的四段)。真组件各自拖着 sessions / chat store 与
// SystemPrompt/Variables 面板;这一层的契约只是"页签渲染对应的本体、跳转再冒一级"。
vi.mock('../OutlineWorkbench.vue', () => ({
  default: {
    name: 'OutlineWorkbench',
    props: ['sessionId', 'active'],
    emits: ['jump-to-source'],
    template: `
      <div class="mock-outline-workbench" :data-session="sessionId" :data-active="String(!!active)">
        <button
          class="mock-outline-jump"
          @click="$emit('jump-to-source', { sessionId: 'session-9', messageId: 'message-9' })"
        >jump</button>
      </div>
    `,
  },
}))

vi.mock('../SessionContextWorkbench.vue', () => ({
  default: {
    name: 'SessionContextWorkbench',
    props: ['sessionId'],
    template: '<div class="mock-context-workbench" :data-session="sessionId" />',
  },
}))

vi.mock('@/components/editor/EditorWorkbench.vue', () => ({
  default: {
    name: 'EditorWorkbench',
    props: ['workspaceRoot', 'initialFilePath', 'initialPosition', 'active'],
    emits: ['openFile'],
    template: `
      <div class="mock-editor-workbench" :data-position="initialPosition ? JSON.stringify(initialPosition) : ''">
        {{ workspaceRoot }} {{ initialFilePath }} {{ active }}
        <button class="mock-open-file" @click="$emit('openFile', '/repo/src/b.ts')">open</button>
      </div>
    `,
  },
}))

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('RightWorkbenchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mocks.variablesApi.list.mockResolvedValue({ success: true, variables: [] })
    mocks.terminalApi.list.mockResolvedValue({ success: true, terminals: [] })
    mocks.terminalApi.create.mockResolvedValue({
      success: true,
      terminal: {
        id: 'pty-1',
        title: 'zsh',
        cwd: '/repo',
        shell: '/bin/zsh',
        cols: 80,
        rows: 24,
        createdAt: 0,
      },
    })
    mocks.terminalApi.kill.mockResolvedValue({ success: true })
    Object.defineProperty(window, 'electronAPI', {
      value: mocks.electronAPI,
      configurable: true,
    })
  })

  it('opens files as top-level file tabs named after the file', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })

    await (wrapper.vm as unknown as { openFile: (filePath: string) => Promise<void> })
      .openFile('/repo/src/a.ts')
    await settle()

    expect(wrapper.text()).toContain('a.ts')
    expect(wrapper.text()).not.toContain('Files')
    expect(wrapper.find('.mock-editor-workbench').text()).toContain('/repo /repo/src/a.ts true')
    expect(mocks.editorWorkspace.setWorkspaceRoot).toHaveBeenCalledWith('/repo')
    expect(mocks.editorWorkspace.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
  })

  // docs/design/message-references-2026-08.md §5:行号要透传到编辑器,
  // 并且**文件已经开着时也得重新落点**(去重分支不能把它吃掉)。
  it('threads a line position into the editor, on first open and on reopen', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })
    const panel = wrapper.vm as unknown as {
      openFile: (filePath: string, position?: { line?: number; endLine?: number; col?: number }) => Promise<void>
    }

    await panel.openFile('/repo/src/a.ts', { line: 12, col: 5 })
    await settle()

    expect(wrapper.find('.mock-editor-workbench').attributes('data-position'))
      .toBe(JSON.stringify({ line: 12, col: 5 }))

    // 同一个文件再点一条引用:仍是同一条 tab(不新开),但落点换了。
    await panel.openFile('/repo/src/a.ts', { line: 40, endLine: 44 })
    await settle()

    expect(wrapper.findAll('.mock-editor-workbench')).toHaveLength(1)
    expect(wrapper.find('.mock-editor-workbench').attributes('data-position'))
      .toBe(JSON.stringify({ line: 40, endLine: 44 }))
    expect(mocks.editorWorkspace.openFile).toHaveBeenCalledWith('/repo/src/a.ts')
  })

  it('carries no position when the file is opened without one', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })

    await (wrapper.vm as unknown as { openFile: (filePath: string) => Promise<void> })
      .openFile('/repo/src/a.ts')
    await settle()

    expect(wrapper.find('.mock-editor-workbench').attributes('data-position')).toBe('')
  })

  it('opens files inside additional workdir roots at the project root', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
        workspaceRoots: ['/repo', '/other-repo'],
      },
    })

    await (wrapper.vm as unknown as { openFile: (filePath: string) => Promise<void> })
      .openFile('/other-repo/src/a.ts')
    await settle()

    expect(wrapper.find('.mock-editor-workbench').text()).toContain('/other-repo /other-repo/src/a.ts true')
    expect(mocks.editorWorkspace.setWorkspaceRoot).toHaveBeenCalledWith('/other-repo')
    expect(mocks.editorWorkspace.setWorkspaceRoot).not.toHaveBeenCalledWith('/other-repo/src')
  })

  it('opens note files at the configured note directory', async () => {
    mocks.variablesApi.list.mockResolvedValue({
      success: true,
      variables: [
        { name: 'workdir', value: '/repo', values: ['/repo'], scope: 'session' },
        { name: 'user_note_dir', value: '/notes/user', scope: 'global' },
        { name: 'work_note_dir', value: '', scope: 'global' },
      ],
    })
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
        workspaceRoots: ['/repo'],
      },
    })

    await (wrapper.vm as unknown as { openFile: (filePath: string) => Promise<void> })
      .openFile('/notes/user/daily/today.md')
    await settle()

    expect(wrapper.find('.mock-editor-workbench').text()).toContain('/notes/user /notes/user/daily/today.md true')
    expect(mocks.editorWorkspace.setWorkspaceRoot).toHaveBeenCalledWith('/notes/user')
    expect(mocks.editorWorkspace.setWorkspaceRoot).not.toHaveBeenCalledWith('/notes/user/daily')
  })

  it('opens explorer selections as top-level file tabs', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })

    expect(wrapper.find('.empty-add').exists()).toBe(false)
    await wrapper.findAll('.empty-action').find(button => button.text() === 'Files')!.trigger('click')
    await settle()

    expect(wrapper.text()).toContain('Files')

    await wrapper.find('.mock-open-file').trigger('click')
    await settle()

    expect(wrapper.text()).toContain('b.ts')
    expect(mocks.editorWorkspace.openFile).toHaveBeenCalledWith('/repo/src/b.ts')
  })

  it('maps workbench tool icons to category slots 5 through 7', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })

    const emptyActions = wrapper.findAll('.empty-action')
    expect(emptyActions.find(button => button.text() === 'Files')?.attributes('style')).toContain('--workbench-tool-icon-color: var(--ui-category-5-icon);')
    expect(emptyActions.find(button => button.text() === 'Terminal')?.attributes('style')).toContain('--workbench-tool-icon-color: var(--ui-category-6-icon);')
    expect(emptyActions.find(button => button.text() === 'Browser')?.attributes('style')).toContain('--workbench-tool-icon-color: var(--ui-category-7-icon);')

    await emptyActions.find(button => button.text() === 'Terminal')!.trigger('click')
    await settle()

    expect(wrapper.find('.workbench-tab-label').attributes('style')).toContain('--workbench-tool-icon-color: var(--ui-category-6-icon);')
  })

  it('creates a PTY per terminal tab and renders its view', async () => {
    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })

    await wrapper.findAll('.empty-action').find(button => button.text() === 'Terminal')!.trigger('click')
    await settle()
    await settle()

    expect(mocks.terminalApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', sessionId: 'session-1' }),
    )
    expect(wrapper.find('.mock-terminal-view').text()).toContain('pty-1')
  })

  // ── 右栏线程 tab(C3-B,docs/design/im-workbench-layout.md §3 W4)──────────
  describe('thread tab', () => {
    function mountPanel() {
      return mount(RightWorkbenchPanel, {
        props: { sessionId: 'session-1', workspaceRoot: '/repo' },
      })
    }

    type ThreadApi = { openThread: (sessionId: string, title?: string) => void }

    it('一个工作台会话只开一个 tab —— 再点一次是聚焦不是新开', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as ThreadApi

      vm.openThread('work-1', '换核验证')
      await settle()
      vm.openThread('work-1', '换核验证')
      await settle()

      expect(wrapper.findAll('.mock-thread-workbench')).toHaveLength(1)
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(1)
      expect(wrapper.find('.mock-thread-workbench').text()).toContain('work-1')

      // 换一次执行 = **换靶子**,不是再开一页(样板右栏是三 tab 常驻;
      // 从前按靶子各开一个,逛三间房就攒三条「线程」)。成员页签早就是这个语义。
      vm.openThread('work-2', '元素拾取')
      await settle()
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(1)
      expect(wrapper.find('.mock-thread-workbench').text()).toContain('work-2')
    })

    it('空 workSessionId 不开 tab(左栏对空串已经拦了一道,这里是第二道)', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as ThreadApi).openThread('')
      await settle()
      expect(wrapper.find('.mock-thread-workbench').exists()).toBe(false)
    })

    /**
     * 真机 253px 下改的口径:线程页签**不跟着会话名改名**。
     * 它是常驻三条之一,标题一长就把自己挤出可视区 —— 当时激活的正是线程页签,
     * 而页签条里只看得见「成员/看板」。在看哪一次执行由面板头去说。
     */
    it('会话名解析出来也不改 tab 标题 —— 常驻三条,标题恒为「线程」', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as ThreadApi).openThread('work-1')
      await settle()
      expect(wrapper.find('.workbench-tab-label').text()).toBe('线程')

      await wrapper.find('.mock-thread-title').trigger('click')
      await settle()
      expect(wrapper.find('.workbench-tab-label').text()).toBe('线程')
    })

    /* 「调度」(D8 §4.5 的总览)是 picker 里的第五格:它**不属于任何一间房**,
       所以落点是工具页签而不是房间背台的一格。线程仍然不进 picker —— 它必须绑
       一个房,picker 里点一下开不出有意义的空白页。 */
    it('线程不进 picker / 空态清单 —— 会话域七条 + 工作区域七条', () => {
      const wrapper = mountPanel()
      const labels = wrapper.findAll('.empty-action').map(button => button.text())
      // 前七条是会话域(这次会话的工具;Contents / Context 是 L3 从退役的大纲栏
      // 并进来的两条,排在 Files 之前 —— 它们说的是这条会话本身),后七条是
      // 工作区域(跨会话的面板,清单从 panel-registry 派生)。
      expect(labels).toEqual([
        'Contents', 'Context', 'Files', 'Terminal', 'Browser', '看板', '调度总览',
        'Media', 'Agents', 'Tasks', 'Music', 'Practice', 'Archived Chats', '轨迹',
      ])
      expect(wrapper.text()).not.toContain('线程')
    })

    /* 线程是两层(列表 → 详情)。落在哪一层由入口决定:
       带靶子进来的(「展开执行 →」/ 左栏活卡片)知道要看哪一条 → 详情;
       进房自动备齐不知道 → 列表,替用户挑一条塞满整面是替他做选择。 */
    it('带靶子的入口落详情层,进房自动备齐落列表层 —— 两者共用同一条页签', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as ThreadApi & {
        openRoomTabs: (roomSessionId: string, threadSessionId?: string) => void
      }

      vm.openThread('work-1', '换核验证')
      await settle()
      expect(wrapper.find('.mock-thread-workbench').text()).toContain('work-1')

      // 进房:即便房面顺手算出了一条默认工作会话,右栏也停在列表层
      vm.openRoomTabs('room-1', 'work-1')
      await settle()
      expect(wrapper.find('.mock-thread-workbench').exists()).toBe(false)
      expect(wrapper.find('.threads-empty').exists()).toBe(true)
      expect(wrapper.findAll('.workbench-tab-label').filter(label => label.text() === '线程')).toHaveLength(1)
    })

    it('看板 tab 原地不动(方案 C 不把看板迁全屏)', async () => {
      const wrapper = mountPanel()
      await wrapper.findAll('.empty-action').find(button => button.text() === '看板')!.trigger('click')
      await settle()
      expect(wrapper.find('.workbench-tab-label').text()).toBe('看板')
    })
  })

  // ── 插件面板作为工作台 tab(H1)──────────────────────────────────────────
  describe('plugin tab (H1)', () => {
    async function withPanels(panels: Array<{ pluginId: string; panelId: string; label: string; placements?: string[] }>) {
      const { setPluginWorkspacePanels } = await import('@/workspace/panel-registry')
      setPluginWorkspacePanels(panels.map(panel => ({
        pluginId: panel.pluginId,
        pluginName: panel.pluginId,
        panelId: panel.panelId,
        label: panel.label,
        loaded: true,
        placements: panel.placements,
      })))
    }

    async function clearPanels() {
      const { setPluginWorkspacePanels } = await import('@/workspace/panel-registry')
      setPluginWorkspacePanels([])
    }

    beforeEach(async () => { await clearPanels() })
    afterEach(async () => { await clearPanels() })

    function mountPanel() {
      return mount(RightWorkbenchPanel, { props: { sessionId: 'session-1', workspaceRoot: '/repo' } })
    }

    /**
     * P1 起「+」清单**不按 `placements` 过滤**。
     *
     * 主工作区容器(MediaPanel)已经拆除,工作台是面板唯一的落点 —— 再按声明
     * 过滤,缺省 `['workspace']` 的插件面板就一个入口都不剩。`placements` 仍是
     * 插件布局动词那条链上的自荐闸(App.vue),那是另一回事:自荐要报备,
     * 用户自己找面板不要。
     */
    it('「+」空态清单列出全部插件面板 —— 缺省 workspace 的也在(容器已退役)', async () => {
      await withPanels([
        { pluginId: 'canvas-clock', panelId: 'canvas-clock', label: 'Canvas Clock', placements: ['workspace', 'workbench'] },
        { pluginId: 'note-skills', panelId: 'notes', label: 'Notes' }, // 缺省 workspace-only
      ])
      const wrapper = mountPanel()
      await settle()

      const labels = wrapper.findAll('.empty-action').map(button => button.text())
      expect(labels).toContain('Canvas Clock')
      expect(labels).toContain('Notes')
    })

    it('点一下开一个 plugin tab 并渲染 PluginPanelHost —— 单例,再点是聚焦', async () => {
      await withPanels([
        { pluginId: 'canvas-clock', panelId: 'canvas-clock', label: 'Canvas Clock', placements: ['workbench'] },
      ])
      const wrapper = mountPanel()
      await settle()

      await wrapper.findAll('.empty-action').find(button => button.text() === 'Canvas Clock')!.trigger('click')
      await settle()

      expect(wrapper.find('.mock-plugin-panel-host').text()).toBe('canvas-clock:canvas-clock')
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(1)

      // 同一个 pluginId+panelId 只有一条 tab —— 再开一次是聚焦,不新开
      // (照 addWorkbenchTab 的去重先例)。
      ;(wrapper.vm as unknown as { openPluginTab: (p: string, panel: string, t: string) => void })
        .openPluginTab('canvas-clock', 'canvas-clock', 'Canvas Clock')
      await settle()
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(1)
    })

    it('插件停用/卸载即关它的 tab —— 拆除无残留', async () => {
      await withPanels([
        { pluginId: 'canvas-clock', panelId: 'canvas-clock', label: 'Canvas Clock', placements: ['workbench'] },
      ])
      const wrapper = mountPanel()
      await settle()
      await wrapper.findAll('.empty-action').find(button => button.text() === 'Canvas Clock')!.trigger('click')
      await settle()
      expect(wrapper.find('.mock-plugin-panel-host').exists()).toBe(true)

      // 插件从清单里消失(停用 / 卸载 / 熔断自动禁用走的都是这条)。
      await clearPanels()
      await settle()

      expect(wrapper.find('.mock-plugin-panel-host').exists()).toBe(false)
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(0)
    })

    it('v1 不跨重启恢复 —— 新挂载不自动开任何 plugin tab', async () => {
      await withPanels([
        { pluginId: 'canvas-clock', panelId: 'canvas-clock', label: 'Canvas Clock', placements: ['workbench'] },
      ])
      const wrapper = mountPanel()
      await settle()

      // openTabs 是组件本地态,不写进任何持久层:声明了 workbench 的面板只是
      // 出现在「+」清单里(入口),而不会替用户开出一条 tab。
      expect(wrapper.find('.mock-plugin-panel-host').exists()).toBe(false)
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(0)
    })
  })

  // ── 双域页签:会话域(左)/ 工作区域(右)(P1)──────────────────────────
  describe('workspace tabs (P1 双域)', () => {
    function mountPanel() {
      return mount(RightWorkbenchPanel, { props: { sessionId: 'session-1', workspaceRoot: '/repo' } })
    }

    function stripLabels(wrapper: ReturnType<typeof mountPanel>): string[] {
      return wrapper.findAll('.app-tabs-tab .workbench-tab-label').map(label => label.text())
    }

    /** 「+」清单是 Popover(Teleport 到 body),不在 wrapper 的树里。 */
    function pickerLabels(): string[] {
      return Array.from(document.querySelectorAll('.picker-option'))
        .map(node => (node.textContent || '').trim())
    }

    type WorkspaceApi = {
      openWorkspaceTab: (panelId: string) => void
      isWorkspaceTabActive: (panelId: string) => boolean
      openRoomTabs: (roomSessionId: string) => void
    }

    it('从「+」清单开一个面板 —— 单例,再点是聚焦,开着的从清单里撤掉', async () => {
      const wrapper = mountPanel()
      await wrapper.findAll('.empty-action').find(button => button.text() === 'Media')!.trigger('click')
      await settle()

      expect(wrapper.find('[data-panel="media"]').exists()).toBe(true)
      expect(stripLabels(wrapper)).toEqual(['Media'])

      // 单例:同一个面板再开一次是聚焦
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('media')
      await settle()
      expect(stripLabels(wrapper)).toEqual(['Media'])
      expect((wrapper.vm as unknown as WorkspaceApi).isWorkspaceTabActive('media')).toBe(true)

      // 已经开着的那条从「+」清单里撤掉 —— 它是单例,列出来只会让人以为能开第二个
      await wrapper.find('.app-tabs-add').trigger('click')
      await settle()
      expect(pickerLabels()).not.toContain('Media')
      expect(pickerLabels()).toContain('Agents')
      // 两个域各成一组、各带标题 —— 与页签条上那道竖线说的是同一件事。
      const groupTitles = Array.from(document.querySelectorAll('.picker-group-title')).map(el => el.textContent?.trim())
      expect(groupTitles).toEqual(['本会话', '工作区'])
      wrapper.unmount()
    })

    /**
     * 「跳到来源消息」在这一层只做**中继**:落点是 App.vue(它持着 ChatContainer
     * 的 ref)。这里守两件事 —— 意图确实再冒了一级,以及跳转**不关**工作台。
     */
    it('把 Media 的「跳到来源消息」原样冒给 App,而且不关工作台', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('media')
      await settle()

      const payload = { sessionId: 'session-9', messageId: 'message-9' }
      wrapper.findComponent({ name: 'media' }).vm.$emit('jump-to-source', payload)
      await settle()

      expect(wrapper.emitted('jump-to-source')).toEqual([[payload]])
      expect(wrapper.emitted('close')).toBeUndefined()
      expect(wrapper.find('[data-panel="media"]').exists()).toBe(true)
      wrapper.unmount()
    })

    /**
     * L3:大纲栏并入右栏 —— Contents / Context 是**会话域**的两条页签,
     * 跳转与 Media 共用同一条 `jump-to-source` 中继链(落点是 App)。
     */
    it('Contents / Context 是会话域页签,大纲的跳转走同一条中继链', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as { openWorkbenchTab: (type: string) => void }

      vm.openWorkbenchTab('outline')
      await settle()
      expect(wrapper.find('.mock-outline-workbench').attributes('data-session')).toBe('session-1')
      expect(wrapper.find('.mock-outline-workbench').attributes('data-active')).toBe('true')

      await wrapper.find('.mock-outline-jump').trigger('click')
      expect(wrapper.emitted('jump-to-source')).toEqual([
        [{ sessionId: 'session-9', messageId: 'message-9' }],
      ])
      expect(wrapper.emitted('close')).toBeUndefined()

      vm.openWorkbenchTab('context')
      await settle()
      expect(wrapper.find('.mock-context-workbench').attributes('data-session')).toBe('session-1')
      // 单例:再点一次是聚焦不是新开。
      vm.openWorkbenchTab('outline')
      await settle()
      expect(wrapper.findAll('.mock-outline-workbench')).toHaveLength(1)
      // 两条都在**会话域**(工作区页签恒在其后)。
      const labels = wrapper.findAll('.workbench-tab-label').map(label => label.text())
      expect(labels).toEqual(['Contents', 'Context'])
      wrapper.unmount()
    })

    it('六个内置面板各渲染自己的本体', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as WorkspaceApi
      for (const id of ['media', 'agents', 'tasks', 'music', 'practice', 'archive']) {
        vm.openWorkspaceTab(id)
        await settle()
        expect(wrapper.find(`[data-panel="${id}"]`).exists()).toBe(true)
      }
      expect(stripLabels(wrapper)).toEqual(['Media', 'Agents', 'Tasks', 'Music', 'Practice', 'Archived Chats'])
    })

    it('工作区页签恒在尾段 —— 先开面板后开工具也不搅在一起', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as WorkspaceApi & { openFile: (p: string) => Promise<void> }
      vm.openWorkspaceTab('media')
      await settle()
      await vm.openFile('/repo/src/a.ts')
      await settle()

      // 页签**条**的次序(不是数据数组):后开的会话域页签仍排在面板之前。
      expect(stripLabels(wrapper)).toEqual(['a.ts', 'Media'])
    })

    it('分隔线只在两域都非空时出现', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('media')
      await settle()
      // 只有右域 —— 不画
      expect(wrapper.find('.workbench-tab-label.is-segment-start').exists()).toBe(false)

      await (wrapper.vm as unknown as { openFile: (p: string) => Promise<void> }).openFile('/repo/src/a.ts')
      await settle()

      const marks = wrapper.findAll('.workbench-tab-label.is-segment-start')
      expect(marks).toHaveLength(1)
      expect(marks[0].text()).toBe('Media')
    })

    it('✕ 只在选中的工作区页签上;房的固定页签一条都不可关', async () => {
      const wrapper = mountPanel()
      const vm = wrapper.vm as unknown as WorkspaceApi
      vm.openWorkspaceTab('media')
      vm.openWorkspaceTab('agents')
      await settle()

      const closeByLabel = (label: string) => {
        const tab = wrapper.findAll('.app-tabs-tab')
          .find(item => item.find('.workbench-tab-label').text() === label)!
        return tab.find('.app-tabs-close').exists()
      }
      // 选中的是后开的 Agents
      expect(closeByLabel('Agents')).toBe(true)
      expect(closeByLabel('Media')).toBe(false)

      vm.openWorkspaceTab('media')
      await settle()
      expect(closeByLabel('Media')).toBe(true)
      expect(closeByLabel('Agents')).toBe(false)

      // 房的固定页签:格数由房的形态决定,关掉一条下一拍就被补回来 —— 那不是
      // 关闭是闪烁,所以它们根本没有 ✕。
      vm.openRoomTabs('room-1')
      await settle()
      for (const label of ['线程', '成员', '看板', '调度']) {
        const tab = wrapper.findAll('.app-tabs-tab')
          .find(item => item.find('.workbench-tab-label').text() === label)
        if (tab) expect(tab.find('.app-tabs-close').exists(), label).toBe(false)
      }
    })

    it('会话域的临时页签照旧可关(能力不减)', async () => {
      const wrapper = mountPanel()
      await wrapper.findAll('.empty-action').find(button => button.text() === 'Files')!.trigger('click')
      await settle()
      const tab = wrapper.findAll('.app-tabs-tab')
        .find(item => item.find('.workbench-tab-label').text() === 'Files')!
      expect(tab.find('.app-tabs-close').exists()).toBe(true)
    })

    it('换会话不动工作区页签 —— 右域跨会话保持', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('archive')
      await settle()
      await wrapper.setProps({ sessionId: 'session-2' })
      await settle()
      expect(stripLabels(wrapper)).toEqual(['Archived Chats'])
      expect(wrapper.find('[data-panel="archive"]').exists()).toBe(true)
    })

    it('Agents 面板的 close 关掉的是它自己那一格', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('agents')
      await settle()
      await wrapper.find('[data-panel="agents"] .mock-panel-close').trigger('click')
      await settle()
      expect(wrapper.find('[data-panel="agents"]').exists()).toBe(false)
      expect(wrapper.findAll('.workbench-tab-label')).toHaveLength(0)
    })

    /**
     * 真机走查(web :5174 + Playwright)抓到的相遇性缺陷:Media 页签开着时点
     * 「+」,选择器下半张被 media 工具条盖住,点击被 `.filter-search-input` 截走。
     *
     * 成因是**两条 z 第一次相遇**:media 工具条是 §3 z 表里的「dropdown+5」
     * (105),工作台的页签选择器是 teleport 到 body 的 Popover(dropdown 档,
     * 100)。旧架构里 MediaPanel 是盖住聊天的全屏容器,与工作台永不共存。
     *
     * 修法是**隔离**不是加价:每格 pane 关进自己的 stacking context,里面的 105
     * 只在 pane 内分层,对外整格按 z-auto 参与根层叠。抬高选择器的 z 只是军备
     * 竞赛 —— 下一个高 z 的面板内容照样赢它。
     */
    it('每格 pane 关在自己的 stacking context 里 —— 面板内容不再和 teleport 浮层竞争', async () => {
      const wrapper = mountPanel()
      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('media')
      await settle()
      expect(wrapper.find('.app-tab-pane').exists()).toBe(true)

      const source = readFileSync(
        resolve(process.cwd(), 'packages/renderer/components/workbench/RightWorkbenchPanel.vue'),
        'utf8',
      )
      const start = source.indexOf('.right-workbench-tabs :deep(.app-tab-pane) {')
      expect(start).toBeGreaterThan(-1)
      const rule = source.slice(start, source.indexOf('}', start))
      expect(rule).toContain('isolation: isolate')
    })

    it('openWorkspaceTab 也收插件面板的 nav id —— 侧栏菜单两种 id 混在一条清单里', async () => {
      const { setPluginWorkspacePanels } = await import('@/workspace/panel-registry')
      setPluginWorkspacePanels([
        { pluginId: 'ui-demo', pluginName: 'UI Demo', panelId: 'demo', label: 'UI Demo', loaded: true },
      ])
      const wrapper = mountPanel()
      await settle()

      ;(wrapper.vm as unknown as WorkspaceApi).openWorkspaceTab('plugin:ui-demo:demo')
      await settle()
      expect(wrapper.find('.mock-plugin-panel-host').text()).toBe('ui-demo:demo')

      setPluginWorkspacePanels([])
    })
  })

  it('re-adopts surviving PTYs as tabs on mount (renderer reload recovery)', async () => {
    mocks.terminalApi.list.mockResolvedValue({
      success: true,
      terminals: [
        { id: 'pty-a', title: 'zsh', cwd: '/repo', shell: '/bin/zsh', cols: 80, rows: 24, createdAt: 0 },
        { id: 'pty-b', title: 'node', cwd: '/repo', shell: '/bin/zsh', cols: 80, rows: 24, createdAt: 0 },
      ],
    })

    const wrapper = mount(RightWorkbenchPanel, {
      props: {
        sessionId: 'session-1',
        workspaceRoot: '/repo',
      },
    })
    await settle()
    await settle()

    const labels = wrapper.findAll('.workbench-tab-label')
    expect(labels).toHaveLength(2)
    expect(wrapper.text()).toContain('zsh')
    expect(wrapper.text()).toContain('node')
  })
})
