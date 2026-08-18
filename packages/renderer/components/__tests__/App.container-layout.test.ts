import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readRendererFile(relativePath: string) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

describe('App container layout', () => {
  it('uses Splitter for the app shell and both sidebars', () => {
    const app = readRendererFile('App.vue')
    /* L5:三栏树整棵搬进 `components/shell/AppShell.vue`(P8)。App 只剩窗口模式
       分发、插件背景/氛围层、事件路由、空间切换 —— 分栏原语因此也只在 AppShell
       里 import。 */
    const shell = readRendererFile('components/shell/AppShell.vue')

    expect(app).toContain("import Container from '@/components/common/Container.vue'")
    expect(app).toContain("import AppShell from '@/components/shell/AppShell.vue'")
    expect(app).not.toContain("import Splitter from '@/components/common/Splitter.vue'")
    expect(app).not.toContain("import SplitterPanel from '@/components/common/SplitterPanel.vue'")
    expect(shell).toContain("import Splitter from '@/components/common/Splitter.vue'")
    expect(shell).toContain("import SplitterPanel from '@/components/common/SplitterPanel.vue'")
    expect(app).toContain("import RightWorkbenchPanel from '@/components/workbench/RightWorkbenchPanel.vue'")
    expect(app).not.toContain("import SidebarResizeHandle from '@/components/sidebar/SidebarResizeHandle.vue'")
    // 三个插槽是 AppShell 与外界的全部接口。
    expect(shell).toContain('<slot name="sidebar" />')
    expect(shell).toContain('<slot name="main" />')
    expect(shell).toContain('<slot name="workbench" />')
    expect(app).toContain('<template #sidebar>')
    expect(app).toContain('<template #main>')
    expect(app).toContain('<template #workbench>')
    expect(shell).toContain('class="app-shell"')
    expect(shell).toContain(':class="{ \'is-sidebar-resizing\': sidebarResizing }"')
    /* L4:左栏 region **常驻 DOM** —— 浮层态改成收成 0 宽(`:collapsed`),
       而不是把整条侧栏连同它的实例一起卸掉。`v-if` 那一版每次浮层进出都重挂
       一次 `<Sidebar>`,滚动位置与展开的分组必然丢。 */
    expect(shell).not.toContain('v-if="sidebarDocked"')
    expect(shell).toContain(':collapsed="!sidebarDocked"')
    expect(app).toContain('v-model:sidebar-width="sidebarWidth"')
    expect(shell).toContain('class="app-left-sidebar-region"')
    expect(shell).toContain('size-unit="px"')
    expect(app).toContain(':sidebar-min-width="MIN_SIDEBAR_WIDTH"')
    /* 上限归布局协调器(L2):拖到头也得给聊天列留 480px,所以它随窗宽/右栏走,
       不再是一个写死的 500。产品上限 500 仍在,只是收进了 `sidebarMaxWidth`。 */
    expect(app).toContain(':sidebar-max-width="shellLayout.sidebarMaxWidth"')
    expect(shell).toContain('flex\n      class="app-shell-main-region"')
    expect(shell).toContain('class="app-shell-main-region"')
    expect(shell).toContain(':resizable="sidebarDocked"')
    expect(app).toContain('@sidebar-resize-start="handleSidebarResizeStart"')
    expect(app).toContain('@sidebar-resize-end="handleSidebarResizeEnd"')
    expect(app).toContain('const sidebarResizing = ref(false)')
    expect(app).toContain('const sidebarDockedVisible = computed')
    expect(app).not.toContain('sidebarPanelSizeFromWidth')
    expect(app).not.toContain('sidebarWidthFromPanelSize')
    expect(app).not.toContain('const sidebarPanelSize = ref')
    expect(app).not.toContain('const appMainPanelSize = computed')
    expect(app).not.toContain('watch(sidebarPanelSize')
    expect(app).not.toContain("const appLeftSidebarFlex = '0 0 auto'")
    expect(app).not.toContain('const appLeftSidebarRegionStyle = computed')
    expect(app).not.toContain(':sidebar-style="appLeftSidebarRegionStyle"')
    expect(shell).toContain('--app-sidebar-transition-duration: var(--duration-slow)')
    expect(shell).toContain('--app-sidebar-transition-ease: var(--ease-default)')
    expect(shell).toContain('animating it relayouts the full message list every frame')
    // 侧栏操作按钮不再是跨分支的 fixed 浮层:Chromium 只让 drag 元素的子孙用
    // no-drag 挖洞,浮层挖不动,才逼出了顶栏那块按坐标预留的死区。按钮现在住在
    // 各自的 drag 宿主里(展开→SidebarHeader,收起→TabBar / MediaPanel 头)。
    expect(app).not.toContain('app-sidebar-actions')
    expect(app).not.toContain('SIDEBAR_ACTION_COLLAPSED_LEFT')
    expect(app).not.toContain('transition: inline-size var(--app-sidebar-transition-duration) var(--app-sidebar-transition-ease)')
    expect(app).not.toContain('transition: left var(--app-sidebar-transition-duration) var(--app-sidebar-transition-ease)')
    expect(app).not.toContain('flex-basis 0.3s')
    expect(shell).toContain('.app-shell.is-sidebar-resizing :deep(.app-left-sidebar-region)')
    expect(shell).toContain('class="app-content"')
    expect(shell).toContain('class="app-content-splitter"')
    expect(app).toContain('@workbench-resize-start="inspectorResizing = true"')
    expect(app).toContain('@workbench-resize-end="handleInspectorResizeEnd"')
    /* 尺寸模型统一成 px(L1):中栏 flex 吃剩余,右栏才是那个被拖的定宽列。
       百分比时代的 `mainWorkspacePanelSize`(= 100 − 右栏%)随之退役。 */
    expect(app).not.toContain('mainWorkspacePanelSize')
    expect(app).toContain(':chat-min-width="CHAT_MIN_WIDTH"')
    expect(shell).toContain(':min="chatMinWidth"')
    expect(shell).toContain(':resizable="workbenchVisible"')
    expect(shell).toContain(':size="workbenchPanelWidth"')
    expect(shell).toContain(':collapsed="!workbenchRevealed"')
    expect(app).toContain('@update:workbench-panel-width="handleInspectorPanelSizeUpdate"')
    expect(shell).toContain('class="app-right-sidebar-region"')
    expect(shell).toContain('class="workbench-slide"')
    expect(app).toContain('<RightWorkbenchPanel')
    expect(app).toContain('ref="rightWorkbenchRef"')
    expect(app).toContain(':workspace-root="currentWorkspaceRoot"')
    expect(app).toContain(':workspace-roots="currentWorkspaceRoots"')
    expect(app).toContain('@open-file="openFileInRightWorkbench"')
    expect(app).toContain('const rightWorkbenchRef = ref<InstanceType<typeof RightWorkbenchPanel> | null>(null)')
    /* Media 的「跳到来源消息」落在 App:只有这一层同时握着 ChatContainer 的 ref
       和搜索 deeplink 那条已成熟的 jumpToMessage。 */
    expect(app).toContain('@jump-to-source="handleWorkbenchJumpToSource"')
    expect(app).toContain('await chatContainerRef.value?.jumpToMessage?.(payload.sessionId, payload.messageId)')
    expect(app).toContain('async function openFileInRightWorkbench(filePath: string)')
    expect(app).toContain('await rightWorkbenchRef.value?.openFile(filePath)')
    expect(app).not.toContain('class="inspector-resize-handle"')
    expect(app).not.toContain('edge="left"')
    expect(app).not.toContain('@resize="handleInspectorPixelResize"')
    /* L1:右栏改 px 之后,百分比时代那三件 hack 全部退场 —— 量分栏容器宽的
       ResizeObserver、px→% 的下限换算、"每次读都重新 clamp"的 computed。
       下限直接就是 250,clamp 只在 layoutPrefs store 里做一次。 */
    expect(app).not.toContain('storedInspectorPanelSize')
    expect(app).not.toContain('inspectorPanelSize')
    expect(app).not.toContain('inspectorMinPanelSize')
    expect(app).not.toContain('contentSplitterWidth')
    expect(app).not.toContain('function clampInspectorPanelSize')
    expect(app).not.toContain('function handleInspectorPixelResize(width: number)')
    expect(app).toContain('function handleInspectorResizeEnd()')
    expect(app).toContain('layoutPrefs.setWorkbenchWidth(workbenchPanelWidth.value)')
    // 布局偏好只有 layoutPrefs store 一个读写点;App.vue 不再裸写 localStorage。
    expect(app).not.toContain("localStorage.setItem('sidebarWidth'")
    expect(app).not.toContain("localStorage.setItem('sidebarCollapsed'")
    expect(app).not.toContain("localStorage.getItem('sidebarWidth'")
    expect(app).not.toContain('const INSPECTOR_SIDEBAR_WIDTH')
    expect(app).not.toContain('const appRightSidebarRegionStyle = computed')
    expect(app).not.toContain(':sidebar-style="appRightSidebarRegionStyle"')
    expect(app).not.toContain('sidebar-position="right"')
    expect(app).toContain('class="app-main-region"')
    expect(app).toContain('body-class="app-main-body"')
    expect(app).toContain('main-class="app-main-content-region"')
    /* P1:主区只剩会话。工作区面板迁进右侧工作台成为「工作区域」页签,那个
       把聊天整个盖住的全屏容器(MediaPanel)连同 App 这一侧的 `activeWorkspacePanel`
       状态一起退役 —— 于是"每条切会话的路径都得记得关面板"这件事也一起没了。
       壳留着:它是壁纸体系登记在案的四处区域根之一。 */
    expect(app).toContain('class="workspace-view-stack"')
    expect(app).toContain('class="workspace-view workspace-view-chat"')
    // 钉的是**代码**不是散文:注释里还会提这段历史(它正是这条判决的理由)。
    expect(app).not.toContain("import MediaPanel from")
    expect(app).not.toContain('<MediaPanel')
    expect(app).not.toContain('activeWorkspacePanel.value')
    expect(app).not.toContain('workspacePanelOpen')
    expect(app).not.toContain('activeWorkspaceView')
    expect(app).not.toContain('workspace-view-panel')
    // 入口全部改走工作台的 expose(展开右栏 + 落座那一格)。
    expect(app).toContain('async function openWorkspacePanel(panel: WorkspacePanel)')
    expect(app).toContain('rightWorkbenchRef.value?.openWorkspaceTab(panel)')
  })

  it('uses Container for the chat main header and content regions', () => {
    const app = readRendererFile('App.vue')
    const chatWindow = readRendererFile('components/chat/ChatWindow.vue')

    expect(chatWindow).toContain("import Container from '@/components/common/Container.vue'")
    expect(chatWindow).toContain('class="chat"')
    expect(chatWindow).toContain('body-class="chat-body"')
    expect(chatWindow).toContain('main-class="chat-main-region"')
    expect(chatWindow).not.toContain('footer-class="chat-footer-region"')
    expect(chatWindow).toContain('<template #header>')
    expect(chatWindow).not.toContain('<template #footer>')
    expect(chatWindow).toContain('class="tab-content"')
    expect(chatWindow).toContain('ref="chatFooterRef"')
    expect(chatWindow).toContain(':footer-target="chatFooterRef"')
    expect(chatWindow).toContain('outlineRailTarget')
    expect(chatWindow).not.toContain('border-left')

    /* L3:大纲栏(Contents/System prompt/Todo/Variables)整条退役 —— 四段进了
       右栏会话域的两条页签。ChatWindow 这一侧因此只剩两件事:顶栏那颗
       「Contents」钮的转发,以及**自己**从共享 ref 上取大纲轨宿主
       (聚焦的那一格才取得到),而不是接一条从 ChatContainer 传下来的 prop。 */
    expect(chatWindow).not.toContain("import ChatSidePanel from './ChatSidePanel.vue'")
    expect(chatWindow).not.toContain('<ChatSidePanel')
    expect(chatWindow).not.toContain('sidebar-position="right"')
    expect(chatWindow).not.toContain('#sidebar')
    expect(chatWindow).not.toContain('outlineTargetChange')
    expect(chatWindow).not.toContain('sidePanelAvailable?: boolean')
    expect(chatWindow).not.toContain('sidePanelCollapsed?: boolean')
    expect(chatWindow).toContain("import { useOutlineRail } from '@/composables/useOutlineRail'")
    expect(chatWindow).toContain('const outlineRailTarget = resolveOutlineRailTarget(() => props.panelFocused !== false)')
    expect(chatWindow).toContain(':outline-rail-target="outlineRailTarget"')
    expect(chatWindow).toContain('emit(\'openOutline\')')

    const chatContainer = readRendererFile('components/ChatContainer.vue')
    expect(chatContainer).toContain("import Container from '@/components/common/Container.vue'")
    // 第四列没了:Container 不再开 sidebar 插槽,也不再有那条五层 outlineTarget 链。
    expect(chatContainer).not.toContain("import ChatSidePanel")
    expect(chatContainer).not.toContain('sidebar-position="right"')
    expect(chatContainer).not.toContain(':sidebar-width=')
    expect(chatContainer).not.toContain('sidePanelVisible')
    expect(chatContainer).not.toContain('setChatSideSupported')
    expect(chatContainer).not.toContain('const CHAT_SIDE_PANEL_MIN_WINDOW_WIDTH')
    expect(chatContainer).not.toContain('chatResizeObserver')
    expect(chatContainer).not.toContain('outline-target-change')
    expect(chatContainer).not.toContain('chatSideOutlineTarget')
    // 顶栏那颗钮改成"去右栏开 Contents 页签"的一条转发。
    expect(chatContainer).toContain("case 'openOutline':")
    expect(chatContainer).toContain("emit('open-outline')")
    expect(app).toContain('async function openOutlineInRightWorkbench()')
    expect(app).toContain("rightWorkbenchRef.value?.openWorkbenchTab('outline')")
  })

  it('keeps docked sidebar content fixed while the outer container animates', () => {
    const sidebar = readRendererFile('components/sidebar/Sidebar.vue')

    expect(sidebar).toContain("'--sidebar-docked-width': `${props.width}px`")
    expect(sidebar).toContain('width: var(--sidebar-docked-width)')
    expect(sidebar).toContain('min-width: var(--sidebar-docked-width)')
    expect(sidebar).toContain('max-width: var(--sidebar-docked-width)')
    expect(sidebar).toContain('.sidebar.floating .sidebar-content')
    /* 折叠 = 整块淡出,两种壳同一套语义(2026-07-31 撤掉 workbench 的 rail 折叠:
       交通灯比 rail 宽,左上角对不齐)。判定收在 `contentHidden` 里。 */
    expect(sidebar).toContain(':aria-hidden="contentHidden"')
    expect(sidebar).toContain('props.collapsed && !props.floating')
    expect(sidebar).not.toContain('v-show="showContent"')
    expect(sidebar).not.toContain('const showContent = computed')
    expect(sidebar).not.toContain('width: collapsed.value')
    expect(sidebar).not.toContain('maxWidth: collapsed.value')
    expect(sidebar).not.toContain('width 0.3s cubic-bezier')
    expect(sidebar).not.toContain('max-width 0.3s cubic-bezier')
    expect(sidebar).not.toContain('<SidebarResizeHandle')
    expect(sidebar).not.toContain("import SidebarResizeHandle from './SidebarResizeHandle.vue'")
  })

  it('keeps floating sidebar width and close behavior tied to the sidebar component', () => {
    const app = readRendererFile('App.vue')
    const sidebar = readRendererFile('components/sidebar/Sidebar.vue')

    const floatingSidebar = readRendererFile('composables/useFloatingSidebar.ts')

    expect(app).toContain('@request-floating-close="closeFloatingSidebar"')
    expect(app).toContain('@request-floating-keep-open="keepFloatingSidebarOpen"')
    /* L4:四个裸 timer 与那枚 cooldown 布尔整台搬进 `useFloatingSidebar`。
       App 只认三枚布尔 + 几个回调,清场也归时序机自己(`onScopeDispose`)。 */
    expect(app).toContain("import { useFloatingSidebar } from '@/composables/useFloatingSidebar'")
    expect(app).toContain('} = useFloatingSidebar()')
    expect(app).not.toContain('let floatingCloseTimer')
    expect(app).not.toContain('let floatingCooldownTimer')
    expect(app).not.toContain('let sidebarToggleTimer')
    expect(app).not.toContain('const floatingCooldown = ref')
    expect(app).not.toContain('const floatingShowTimer = ref')
    expect(floatingSidebar).toContain('let showTimer: ReturnType<typeof setTimeout> | null = null')
    expect(floatingSidebar).toContain('let closeTimer: ReturnType<typeof setTimeout> | null = null')
    expect(floatingSidebar).toContain('let closeCooldownTimer: ReturnType<typeof setTimeout> | null = null')
    expect(floatingSidebar).toContain('let toggleTimer: ReturnType<typeof setTimeout> | null = null')
    expect(floatingSidebar).toContain('function keepOpen()')
    expect(app).not.toContain('@mouseleave="handleSidebarMouseLeave"')
    expect(app).not.toContain('function handleSidebarMouseLeave')
    expect(app).not.toContain('sidebarFloating.value ? 280 : 0')

    expect(sidebar).toContain('@mouseenter="handleMouseEnter"')
    expect(sidebar).toContain('@mouseleave="handleMouseLeave"')
    expect(sidebar).toContain("'request-floating-keep-open': []")
    expect(sidebar).toContain("'request-floating-close': []")
    expect(sidebar).toContain("emit('request-floating-keep-open')")
    expect(sidebar).toContain("emit('request-floating-close')")
    expect(sidebar).toContain('--sidebar-floating-safe-zone: 36px')
    expect(sidebar).toContain('+ var(--sidebar-floating-safe-zone)')
    expect(sidebar).toContain('width: var(--sidebar-docked-width);')
    expect(sidebar).toContain('pointer-events: auto;')
    expect(sidebar).not.toContain('width: 300px !important')
    expect(sidebar).not.toContain('max-width: 300px !important')
  })

  it('keeps titlebar reservation width changes discrete during sidebar toggle', () => {
    const header = readRendererFile('components/chat/SessionHeader.vue')

    expect(header).toContain('Width changes stay discrete to avoid')
    expect(header).toContain('transition: none;')
    expect(header).not.toContain('width var(--app-sidebar-transition-duration, 0.3s)')
    expect(header).not.toContain('padding-left var(--app-sidebar-transition-duration, 0.3s)')
    expect(header).not.toContain('var(--app-sidebar-transition-ease, cubic-bezier(0.4, 0, 0.2, 1))')
    expect(header).not.toContain('width 0.3s cubic-bezier')
    expect(header).not.toContain('padding-left 0.3s cubic-bezier')
  })

  it('uses the right workbench with dynamic tabs and the shared file layout components', () => {
    const app = readRendererFile('App.vue')
    const workbench = readRendererFile('components/workbench/RightWorkbenchPanel.vue')
    const editor = readRendererFile('components/editor/EditorWorkbench.vue')

    expect(app).toContain('const currentWorkspaceRoots = computed')
    expect(app).toContain('const currentWorkspaceRoot = computed')
    /**
     * 右栏尺寸自 L1 起是 **px**:下限 250(设计稿 right-panel.html 的硬指标)、
     * 上限由协调器按预算给。百分比那一套(22 / 48 / 32 三个数 + px→% 换算)整套
     * 退役 —— 它当年之所以存在,只是因为右栏和侧栏用了两种单位。
     */
    expect(readRendererFile('components/shell/AppShell.vue')).toContain('size-unit="px"')
    expect(app).toContain(':workbench-min-width="shellLayout.workbenchMinWidth"')
    expect(app).toContain(':workbench-max-width="shellLayout.workbenchMaxWidth"')
    expect(app).not.toContain('MIN_INSPECTOR_PANEL_SIZE')
    expect(app).not.toContain('MAX_INSPECTOR_PANEL_SIZE')
    expect(app).not.toContain('DEFAULT_INSPECTOR_PANEL_SIZE')
    expect(app).not.toContain('MIN_INSPECTOR_PANEL_PX')
    expect(app).not.toContain(':min-width="inspectorMinWidth"')
    expect(app).not.toContain(':max-width="inspectorMaxWidth"')
    expect(app).not.toContain('const MIN_INSPECTOR_PANEL_WIDTH = 320')
    expect(app).not.toContain('const MAX_INSPECTOR_PANEL_WIDTH = 720')

    expect(workbench).toContain("import Container from '@/components/common/Container.vue'")
    expect(workbench).toContain("import Tabs from '@/components/common/Tabs.vue'")
    expect(workbench).toContain("import TabPane from '@/components/common/TabPane.vue'")
    expect(workbench).toContain("import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'")
    expect(workbench).toContain("import { useEditorWorkspace } from '@/composables/useEditorWorkspace'")
    expect(workbench).toContain("type WorkbenchTabType = 'outline' | 'context' | 'files' | 'file' | 'terminal' | 'browser'")
    expect(workbench).toContain('addable')
    expect(workbench).toContain('closable')
    expect(workbench).toContain('@tab-add="togglePicker"')
    expect(workbench).toContain(':initial-file-path="tab.filePath"')
    expect(workbench).toContain('@open-file="openFile"')
    expect(workbench).toContain('async function openFile(filePath: string)')
    expect(workbench).toContain("type: 'file'")
    expect(workbench).toContain('title: basename(filePath)')
    expect(workbench).toContain('await editorWorkspace.openFile(filePath)')
    // App drives the panel through these; pinning the names (not the whole
    // block) keeps the contract without freezing its formatting.
    expect(workbench).toContain('defineExpose({')
    expect(workbench).toMatch(/defineExpose\(\{[^}]*\bopenFile,/)
    expect(workbench).toMatch(/defineExpose\(\{[^}]*\bopenGoalReview,/)
    // Real PTY terminal: the panel renders TerminalView per terminal instance;
    // the old one-shot executeTool('bash') fake terminal must stay dead.
    expect(workbench).toContain("import TerminalView from '@/components/terminal/TerminalView.vue'")
    expect(workbench).toContain(':terminal-id="tab.terminalId"')
    expect(workbench).toContain('terminalsStore.createTerminal')
    expect(workbench).not.toContain("platformApi.executeTool(")
    expect(workbench).toContain('<iframe')
    expect(workbench).not.toContain('Session Lens')
    expect(workbench).not.toContain('lastModel')

    expect(editor).toContain("import Container from '@/components/common/Container.vue'")
    expect(editor).toContain("import Breadcrumb from '@/components/common/Breadcrumb.vue'")
    expect(editor).toContain("import Splitter from '@/components/common/Splitter.vue'")
    expect(editor).toContain("import SplitterPanel from '@/components/common/SplitterPanel.vue'")
    expect(editor).toContain('<Breadcrumb')
    expect(editor).toContain('overflow: hidden;')
    expect(editor).toContain('overflow-x: auto;')
    expect(editor).toContain('font-size: 12px;')
    expect(editor).toContain(':deep(.app-breadcrumb__list)')
    expect(editor).toContain('flex-wrap: nowrap;')
    expect(editor).toContain('white-space: nowrap;')
    expect(editor).toContain(':deep(.app-breadcrumb-item.is-last)')
    expect(editor).toContain('const parts: Array<{ label: string; path: string }> = []')
    expect(editor).not.toContain('{ label: basename(normalizedRoot), path: normalizedRoot }')
    expect(editor).toContain('const editorPanelSize = ref(62)')
    expect(editor).toContain('const explorerPanelSize = ref(38)')
    expect(editor).toContain(':min="28"')
    expect(editor).toContain(':max="58"')
    expect(editor).not.toContain('<EditorTabStrip')
    expect(editor).not.toContain("import EditorTabStrip from './EditorTabStrip.vue'")
    expect(editor).toContain('const explorerCollapsed = ref(false)')
    expect(editor).toContain("@click=\"explorerCollapsed = !explorerCollapsed\"")
    expect(editor).toContain('v-if="!explorerCollapsed"')
    expect(editor).toContain(':resizable="!explorerCollapsed"')
    expect(editor).toContain('class="editor-panel"')
    expect(editor).toContain('class="explorer-panel"')
    expect(editor).toContain('<FileExplorer')
    expect(editor).toContain(':workspace-root="workspaceRoot"')
    expect(editor).not.toContain('initialFilePath: string')
    expect(editor).not.toContain("return [{ label: 'Workspace', path: 'workspace' }]")
    expect(editor).not.toContain('basename(root || activePath)')
  })

  it('defers expensive message-list measurements during sidebar layout transitions', () => {
    const app = readRendererFile('App.vue')
    const chatContainer = readRendererFile('components/ChatContainer.vue')
    const chatWindow = readRendererFile('components/chat/ChatWindow.vue')
    const chatPanel = readRendererFile('components/chat/ChatPanel.vue')
    const messageList = readRendererFile('components/chat/MessageList.vue')

    /* 左栏动画与工作台拖拽都在改聊天列宽度 —— 两者共用同一面闸门。
       第三项 `workbenchSlideAnimating` 随 L1 退役:折叠动画期间内容由 CSS
       冻结在 `--workbench-width` 上被面板边缘裁切,不再逐帧重排,那面闸门也就
       没有对应的开销要挡了(顺带拆掉一个 280ms 的定时器)。 */
    expect(app).toContain(':layout-transitioning="sidebarActionAnimating || inspectorResizing"')
    expect(app).not.toContain('workbenchSlideAnimating')
    expect(app).not.toContain('workbenchSlideStyle')
    expect(chatContainer).toContain(':layout-transitioning="layoutTransitioning"')
    expect(chatContainer).toContain('<div class="chat-container-wrapper">')
    expect(chatContainer).not.toContain('sidebar-collapsed')
    expect(chatContainer).not.toContain('transition: padding-left')
    expect(chatWindow).toContain(':layout-transitioning="layoutTransitioning"')
    expect(chatPanel).toContain(':layout-transitioning="props.layoutTransitioning"')
    expect(chatPanel).toContain(':outline-rail-target="props.outlineRailTarget"')
    expect(chatPanel).toContain('layoutTransitioning?: boolean')
    expect(chatPanel).toContain('outlineRailTarget?: HTMLElement | null')
    expect(chatPanel).toContain('function runLayoutFollowLoop()')
    expect(chatPanel).toContain('function stopLayoutFollowLoop()')
    expect(chatPanel).not.toContain('deferChatPanelMeasurementDuringTransition')
    expect(chatPanel).not.toContain('deferredLayoutMeasureTimer')
    expect(chatPanel).toContain('return [composerContainerRef.value].filter')
    expect(chatPanel).toContain('pendingComposerResizeHeight = getResizeEntryBlockSize(entry)')
    expect(chatPanel).toContain("composerResizeObserver.observe(composer, { box: 'border-box' })")
    expect(messageList).toContain('layoutTransitioning?: boolean')
    expect(messageList).toContain('outlineRailTarget?: HTMLElement | null')
    expect(messageList).toContain('function deferLayoutMeasurementDuringTransition(): boolean')
    expect(messageList).toContain('function cancelPendingLayoutMeasurementFrames()')
    expect(messageList).toContain('cancelPendingLayoutMeasurementFrames()')
    expect(messageList).toContain('if (deferLayoutMeasurementDuringTransition()) return')
    expect(messageList).toContain('deferredLayoutMeasurementRefresh = false')
    expect(messageList).toContain('deferredLayoutMeasurementTimer = setTimeout')
    expect(messageList).toContain('}, 700)')
    expect(messageList).toContain('deferredLayoutMeasurementFollowupTimer = setTimeout')
    expect(messageList).toContain('left: 50%;')
    expect(messageList).not.toContain('left: var(--chat-content-column-center, 50%);')
  })

  it('routes outline into the right workbench while trail remains in the message panel', () => {
    const messageList = readRendererFile('components/chat/MessageList.vue')
    const userRail = readRendererFile('components/chat/UserMessageNavRail.vue')
    const assistantRail = readRendererFile('components/chat/AssistantMessageNavRail.vue')
    /* L3:大纲栏那一列退役,四段落在右栏的两条会话域页签上,段落组件随之搬进
       `components/workbench/`。这一组用例跟着搬,不跟着删。 */
    const outlineTab = readRendererFile('components/workbench/OutlineWorkbench.vue')
    const contextTab = readRendererFile('components/workbench/SessionContextWorkbench.vue')
    const outlineRail = readRendererFile('composables/useOutlineRail.ts')
    const workbench = readRendererFile('components/workbench/RightWorkbenchPanel.vue')
    const sessionHeader = readRendererFile('components/chat/SessionHeader.vue')
    const todoProgress = readRendererFile('components/workbench/TodoProgressPanel.vue')

    expect(messageList).toContain('<Teleport')
    expect(messageList).toContain(':to="props.outlineRailTarget || \'body\'"')
    expect(messageList).toContain(':disabled="!useSideOutlineRail"')
    expect(messageList).toContain('v-if="useSideOutlineRail && hasAssistantOutlineNav"')
    expect(messageList).toContain('placement="side"')
    expect(messageList).toContain('<UserMessageNavRail')
    expect(messageList).toContain('<AssistantMessageNavRail')
    expect(messageList).toContain('v-if="hasUserNavTrail"')
    expect(messageList).toContain(':panel-available="hasNavPanelRoom"')
    expect(messageList).toContain('placement="overlay"')
    expect(messageList).toContain('const useSideOutlineRail = computed(() => Boolean(props.outlineRailTarget))')

    expect(userRail).toContain("placement?: 'overlay' | 'side'")
    expect(userRail).toContain("placement: 'overlay'")
    expect(userRail).toContain('.user-nav-rail.placement-side')
    expect(userRail).toContain('v-if="!isSidePlacement && panelAvailable && effectiveOpen"')
    expect(userRail).toContain('const effectiveOpen = computed(() => isSidePlacement.value || isOpen.value)')
    expect(userRail).not.toContain('props.panelAvailable && !isAutoPanelDismissed.value')
    expect(assistantRail).toContain("placement?: 'overlay' | 'side'")
    expect(assistantRail).toContain("placement: 'overlay'")
    expect(assistantRail).toContain('.assistant-nav-rail.placement-side')
    expect(assistantRail).toContain("import Scrollbar from '@/components/common/Scrollbar.vue'")
    expect(assistantRail).toContain('v-if="isSidePlacement"')
    expect(assistantRail).toContain('class="assistant-nav-side-scroll"')
    expect(assistantRail).toContain('class="assistant-nav-side-list"')
    expect(assistantRail).toContain(':data-assistant-nav-index="marker.navIndex"')
    expect(assistantRail).toContain('function scrollActiveSideMarkerIntoView()')
    expect(assistantRail).toContain("behavior: 'smooth'")
    expect(assistantRail).toContain('v-if="!isSidePlacement && showScrollThumb"')
    expect(assistantRail).toContain('v-if="!isSidePlacement && hasPreviousPage"')
    expect(assistantRail).toContain('v-if="!isSidePlacement && panelAvailable && effectiveOpen"')

    // 宿主登记在模块级 ref 上(一处写、一处读),不再是五层 prop 透传。
    expect(outlineTab).toContain('ref="outlineHostRef"')
    expect(outlineTab).toContain('class="outline-rail-host"')
    expect(outlineTab).toContain("import { releaseOutlineRailHost, setOutlineRailHost } from '@/composables/useOutlineRail'")
    expect(outlineTab).toContain('setOutlineRailHost(outlineHostRef.value)')
    expect(outlineTab).toContain('releaseOutlineRailHost(outlineHostRef.value)')
    expect(outlineRail).toContain('export function setOutlineRailHost')
    expect(outlineRail).toContain('export function releaseOutlineRailHost')
    // 两条会话域页签排在 files 之前(会话的事在前,机器的事在后)。
    expect(workbench).toContain("{ type: 'outline', title: 'Contents', icon: AlignLeft, categorySlot: 3 }")
    expect(workbench).toContain("{ type: 'context', title: 'Context', icon: Braces, categorySlot: 4 }")
    expect(workbench.indexOf("type: 'outline'")).toBeLessThan(workbench.indexOf("type: 'files'"))
    expect(workbench).toContain('<OutlineWorkbench')
    expect(workbench).toContain('<SessionContextWorkbench')
    expect(workbench).toContain("@jump-to-source=\"payload => emit('jump-to-source', payload)\"")
    // 三段落在 Context 页签上,呼吸(聚焦段长开)原样保留。
    expect(contextTab).toContain('class="sctx-sec sctx-system-section"')
    expect(contextTab).toContain('class="sctx-sec sctx-todo-section"')
    expect(contextTab).toContain('class="sctx-sec sctx-variables-section"')
    expect(contextTab).toContain('<TodoProgressPanel')
    expect(contextTab).toContain("window.addEventListener('todo-plan:toggle-card', handleTodoToggleCard)")
    // 顶栏那颗钮只剩"带我去 Contents 页签"一个语义(开合归右栏自己)。
    expect(sessionHeader).not.toContain('sidePanelAvailable?: boolean')
    expect(sessionHeader).not.toContain('sidePanelCollapsed?: boolean')
    expect(sessionHeader).toContain('class="header-btn outline-toggle"')
    expect(sessionHeader).toContain("openOutline: []")
    expect(todoProgress).toContain('platformApi.getTodoPlan')
    expect(todoProgress).toContain('platformApi.onTodoPlanChanged')
    expect(todoProgress).toContain('parseTasks')
    expect(todoProgress).toContain('flex: 1 1 auto;')
  })

  it('lets workspace loading states fill the media view', () => {
    // 容器(MediaPanel.vue)已拆;这些几何断言跟着 media 视图本体走。
    const mediaPanel = readRendererFile('components/MediaPanelContent.vue')

    expect(mediaPanel).toContain('.media-panel-content {\n  position: relative;\n  flex: 1 1 auto;\n  width: 100%;\n  height: 100%;\n  min-width: 0;\n  min-height: 0;')
    // 钉的是**选择器**,不是散文 —— 注释里还会提这段历史。
    expect(mediaPanel).not.toMatch(/^\s*\.[\w.-]*mode-(main|side)/m)
    expect(mediaPanel).not.toContain('`mode-${mode}`')
    // P2 起"控制条 / 内容 / 26px 状态条"这三层归 PanelShell,视图不再自铺
    // `.content-body` 的伸缩几何 —— 这条守卫跟着改钉**用的是骨架**,
    // 外加两种空态屏与"忙碌只在状态条"(spinner 归 PanelShell,内容区永远是骨架块)。
    expect(mediaPanel).toContain('<PanelShell')
    expect(mediaPanel).toContain(':padded="false"')
    expect(mediaPanel).toContain('<PanelSkeleton')
    expect(mediaPanel).toContain('.empty-state {')
    expect(mediaPanel).toContain('empty-state is-filtered')
    expect(mediaPanel).not.toContain('LoadingSpinner')
  })

  /**
   * 「访问过的面板留在挂载态」这件事从前由 MediaPanel 的手工 `mountedNavs`
   * keep-alive 实现;P1 之后它是 `TabPane lazy` 的自带语义(`v-if=hasRendered`
   * + `v-show=isActive`),所以这条守卫改钉工作台那一侧的等价物:
   * 页签 lazy、面板本体从注册表派生、六条各挂各的本体。
   */
  it('keeps workspace panels mounted once visited — now via lazy tab panes', () => {
    const workbench = readRendererFile('components/workbench/RightWorkbenchPanel.vue')

    expect(workbench).toContain("from '@/workspace/panel-registry'")
    expect(workbench).toContain('useWorkspaceFeaturePanels')
    // 清单从注册表派生,不是手抄一份 id 数组。
    expect(workbench).toContain('workspaceFeaturePanels.value.map(panel => ({')
    expect(workbench).toContain('lazy')
    // K1:内容分发也从注册表取 —— 工作台里那条按 panelId 逐个点名的
    // `v-else-if` 链已经拆掉,面板本体挂在 descriptor 的 `component` 上。
    expect(workbench).toContain("tab.type === 'workspace' && workspacePanelEntry(tab)?.component")
    expect(workbench).not.toContain('<MediaPanelContent')
    const registry = readRendererFile('workspace/panel-registry.ts')
    expect(registry).toContain("import MediaPanelContent from '@/components/MediaPanelContent.vue'")
    expect(registry).toContain("import ArchivedChatsContent from '@/components/ArchivedChatsContent.vue'")
    // 段边界只有一处维护点。
    expect(workbench).toContain('function insertTab(tab: WorkbenchTab): void')
    expect(workbench).toContain(":order=\"tab.type === 'workspace' ? 1 : 0\"")
  })

  it('drives sidebar panels and sessions through one Menu active index', () => {
    const app = readRendererFile('App.vue')
    const sidebar = readRendererFile('components/sidebar/Sidebar.vue')
    const sessionList = readRendererFile('components/sidebar/SessionList.vue')

    // Sessions flow through the Menu; workspace panels emit
    // open-workspace-panel directly. That used to come off the flat bottom
    // icon dock — it now comes off the rail's ⋯ menu (the dock retired with
    // the classic shell, 2026-08-05), but the one-way edge is the same.
    expect(sidebar).not.toContain("import MenuItem from '@/components/common/MenuItem.vue'")
    expect(sidebar).toContain(':active-index="activeSidebarIndex"')
    expect(sidebar).toContain('@menu-select="handleSidebarMenuSelect"')
    expect(sidebar).toContain("emit('open-workspace-panel', action.id)")
    expect(sidebar).toContain("return `session:${sessionId}`")
    expect(sidebar).toContain("'select-session': [sessionId: string]")
    expect(sidebar).not.toContain('@session-click')
    expect(sidebar).not.toContain(':class="{ active: activeWorkspacePanel === action.id }"')

    expect(sessionList).toContain("import AppMenu from '@/components/common/Menu.vue'")
    expect(sessionList).toContain("import SubMenu from '@/components/common/SubMenu.vue'")
    expect(sessionList).toContain('<AppMenu')
    expect(sessionList).toContain(':model-value="activeIndex"')
    expect(sessionList).toContain("emit('menu-select', index)")
    expect(sessionList).toContain('item-as="div"')
    expect(sessionList).toContain('raw')
    expect(sessionList).not.toContain('CollapseGroup')
    expect(sessionList).not.toContain('CollapsePanel')

    expect(app).toContain('@select-session="selectSidebarSession"')
    expect(app).toContain('@open-workspace-panel="openWorkspacePanel"')
    expect(app).toContain('async function selectSidebarSession(sessionId: string)')
    /* 切会话**不再关工作区面板**(P1 刻意的行为变化:右域跨会话保持)。
       从前每一条切会话的路径都得记着 `activeWorkspacePanel = null`,漏一条就是
       "面板卡在那儿" —— 现在压根没有这个状态可漏。 */
    expect(app).toContain('  await sessionsStore.switchSession(sessionId)')
    expect(app).not.toContain('activeWorkspacePanel.value = null')
  })
})
