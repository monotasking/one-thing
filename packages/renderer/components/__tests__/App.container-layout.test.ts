import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readRendererFile(relativePath: string) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8')
}

describe('App container layout', () => {
  it('uses Splitter for the app shell and both sidebars', () => {
    const app = readRendererFile('App.vue')

    expect(app).toContain("import Container from '@/components/common/Container.vue'")
    expect(app).toContain("import Splitter from '@/components/common/Splitter.vue'")
    expect(app).toContain("import SplitterPanel from '@/components/common/SplitterPanel.vue'")
    expect(app).toContain("import RightWorkbenchPanel from '@/components/workbench/RightWorkbenchPanel.vue'")
    expect(app).not.toContain("import SidebarResizeHandle from '@/components/sidebar/SidebarResizeHandle.vue'")
    expect(app).toContain('class="app-shell"')
    expect(app).toContain(':class="{ \'is-sidebar-resizing\': sidebarResizing }"')
    expect(app).toContain('v-if="sidebarDockedVisible"')
    expect(app).toContain('v-model:size="sidebarWidth"')
    expect(app).toContain('class="app-left-sidebar-region"')
    expect(app).toContain('size-unit="px"')
    expect(app).toContain(':min="MIN_SIDEBAR_WIDTH"')
    expect(app).toContain(':max="MAX_SIDEBAR_WIDTH"')
    expect(app).toContain('flex\n        class="app-shell-main-region"')
    expect(app).toContain('class="app-shell-main-region"')
    expect(app).toContain(':resizable="sidebarDockedVisible"')
    expect(app).toContain('@resize-start="handleSidebarResizeStart"')
    expect(app).toContain('@resize-end="handleSidebarResizeEnd"')
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
    expect(app).toContain('--app-sidebar-transition-duration: var(--duration-slow)')
    expect(app).toContain('--app-sidebar-transition-ease: var(--ease-default)')
    expect(app).toContain('animating it relayouts the full message list every frame')
    // 侧栏操作按钮不再是跨分支的 fixed 浮层:Chromium 只让 drag 元素的子孙用
    // no-drag 挖洞,浮层挖不动,才逼出了顶栏那块按坐标预留的死区。按钮现在住在
    // 各自的 drag 宿主里(展开→SidebarHeader,收起→TabBar / MediaPanel 头)。
    expect(app).not.toContain('app-sidebar-actions')
    expect(app).not.toContain('SIDEBAR_ACTION_COLLAPSED_LEFT')
    expect(app).not.toContain('transition: inline-size var(--app-sidebar-transition-duration) var(--app-sidebar-transition-ease)')
    expect(app).not.toContain('transition: left var(--app-sidebar-transition-duration) var(--app-sidebar-transition-ease)')
    expect(app).not.toContain('flex-basis 0.3s')
    expect(app).toContain('.app-shell.is-sidebar-resizing :deep(.app-left-sidebar-region)')
    expect(app).toContain('class="app-content"')
    expect(app).toContain('class="app-content-splitter"')
    expect(app).toContain('@resize-start="inspectorResizing = true"')
    expect(app).toContain('@resize-end="handleInspectorResizeEnd"')
    expect(app).toContain('v-model:size="mainWorkspacePanelSize"')
    expect(app).toContain(':resizable="inspectorVisible"')
    expect(app).toContain(':size="inspectorPanelSize"')
    expect(app).toContain(':collapsed="!workbenchRevealed"')
    expect(app).toContain('@update:size="handleInspectorPanelSizeUpdate"')
    expect(app).toContain('class="app-right-sidebar-region"')
    expect(app).toContain('class="workbench-slide"')
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
    /* 右栏尺寸存的是百分比、地板是像素,所以**每次读都要重新收敛** ——
       只在写入时 clamp 的话,窗口一变窄存着的百分比就跌破 250px 地板。 */
    expect(app).toContain('const storedInspectorPanelSize = ref(clampInspectorPanelSize(')
    expect(app).toContain('const inspectorPanelSize = computed({')
    expect(app).toContain('localStorage.getItem(\'inspectorPanelSize\')')
    expect(app).not.toContain('function handleInspectorPixelResize(width: number)')
    expect(app).toContain('function handleInspectorResizeEnd()')
    expect(app).toContain('localStorage.setItem(\'inspectorPanelSize\', String(inspectorPanelSize.value))')
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

    // The side panel (Outline/System prompt/Todo/Variables) moved up to
    // ChatContainer.vue: one shared instance for the whole split-panel
    // workspace instead of one per ChatWindow. ChatWindow only reflects the
    // shared collapsed/available state in its tab bar toggle and forwards
    // whichever outline-rail-target it's handed (null unless it's the
    // currently focused panel).
    expect(chatWindow).not.toContain("import ChatSidePanel from './ChatSidePanel.vue'")
    expect(chatWindow).not.toContain('<ChatSidePanel')
    expect(chatWindow).not.toContain('sidebar-position="right"')
    expect(chatWindow).not.toContain('#sidebar')
    expect(chatWindow).not.toContain('const CHAT_SIDE_PANEL_COLLAPSED_WIDTH = 0')
    expect(chatWindow).not.toContain('outlineTargetChange')
    expect(chatWindow).toContain('sidePanelAvailable?: boolean')
    expect(chatWindow).toContain('sidePanelCollapsed?: boolean')
    expect(chatWindow).toContain(':side-panel-available="sidePanelAvailable"')
    expect(chatWindow).toContain(':side-panel-collapsed="sidePanelCollapsed"')
    expect(chatWindow).toContain(':outline-rail-target="outlineRailTarget"')
    expect(chatWindow).toContain('emit(\'toggleSidePanel\')')

    const chatContainer = readRendererFile('components/ChatContainer.vue')
    expect(chatContainer).toContain("import ChatSidePanel from '@/components/chat/ChatSidePanel.vue'")
    expect(chatContainer).toContain("import Container from '@/components/common/Container.vue'")
    expect(chatContainer).toContain('sidebar-position="right"')
    expect(chatContainer).toContain(':sidebar-width="chatSidePanelWidth"')
    expect(chatContainer).toContain('v-if="sidePanelVisible"')
    // 侧栏的可见性口径没变(可用 或 未收起);R1 之后多一道房面闸 ——
    // 房 / 私聊新面上没有 ChatSidePanel(§8.2),直聊与 classic 一个字节不变。
    expect(chatContainer).toContain('(sidePanelAvailable.value || !sidePanelCollapsed.value)')
    expect(chatContainer).toContain('!activeLeafOnRoomSurface.value &&')
    expect(chatContainer).toContain('const CHAT_SIDE_PANEL_COLLAPSED_WIDTH = 0')
    expect(chatContainer).toContain('@outline-target-change="handleSideOutlineTargetChange"')
    expect(chatContainer).toContain('@toggle-collapsed="toggleSidePanelCollapsed"')
    expect(chatContainer).toContain("case 'toggleSidePanel':")
    expect(chatContainer).toContain('activeLeafSession')
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

    expect(app).toContain('@request-floating-close="closeFloatingSidebar"')
    expect(app).toContain('@request-floating-keep-open="keepFloatingSidebarOpen"')
    expect(app).toContain('let floatingCloseTimer: ReturnType<typeof setTimeout> | null = null')
    expect(app).toContain('let floatingCooldownTimer: ReturnType<typeof setTimeout> | null = null')
    expect(app).toContain('function keepFloatingSidebarOpen()')
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

    expect(app).toContain('const MIN_INSPECTOR_PANEL_SIZE = 22')
    expect(app).toContain('const MAX_INSPECTOR_PANEL_SIZE = 48')
    expect(app).toContain('const DEFAULT_INSPECTOR_PANEL_SIZE = 32')
    expect(app).toContain('const currentWorkspaceRoots = computed')
    expect(app).toContain('const currentWorkspaceRoot = computed')
    /**
     * 右栏下限改成「22% 与 250px 取大」(设计稿 right-panel.html:最窄 250px 是
     * 硬指标)。原来只有百分比下限,620px 的窗口里右栏只剩 136px,行被压成
     * 「I..」「服...」—— 真机走查看到的正是这个。
     */
    expect(app).toContain('return Math.min(MAX_INSPECTOR_PANEL_SIZE, Math.max(inspectorMinPanelSize.value, size))')
    expect(app).toContain('const MIN_INSPECTOR_PANEL_PX = 250')
    expect(app).toContain(':min="inspectorMinPanelSize"')
    expect(app).toContain(':max="48"')
    expect(app).not.toContain(':min-width="inspectorMinWidth"')
    expect(app).not.toContain(':max-width="inspectorMaxWidth"')
    expect(app).not.toContain('const MIN_INSPECTOR_PANEL_WIDTH = 320')
    expect(app).not.toContain('const MAX_INSPECTOR_PANEL_WIDTH = 720')

    expect(workbench).toContain("import Container from '@/components/common/Container.vue'")
    expect(workbench).toContain("import Tabs from '@/components/common/Tabs.vue'")
    expect(workbench).toContain("import TabPane from '@/components/common/TabPane.vue'")
    expect(workbench).toContain("import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'")
    expect(workbench).toContain("import { useEditorWorkspace } from '@/composables/useEditorWorkspace'")
    expect(workbench).toContain("type WorkbenchTabType = 'files' | 'file' | 'terminal' | 'browser'")
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

    expect(app).toContain(':layout-transitioning="sidebarActionAnimating"')
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

  it('routes outline into the side panel while trail remains in the message panel', () => {
    const messageList = readRendererFile('components/chat/MessageList.vue')
    const userRail = readRendererFile('components/chat/UserMessageNavRail.vue')
    const assistantRail = readRendererFile('components/chat/AssistantMessageNavRail.vue')
    const sidePanel = readRendererFile('components/chat/ChatSidePanel.vue')
    const sessionHeader = readRendererFile('components/chat/SessionHeader.vue')
    const todoProgress = readRendererFile('components/chat/TodoProgressPanel.vue')

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

    expect(sidePanel).toContain('ref="outlineHostRef"')
    expect(sidePanel).toContain('class="chat-side-esec chat-side-outline-section"')
    expect(sidePanel).toContain('class="chat-side-esec chat-side-system-section"')
    expect(sidePanel).toContain('class="chat-side-esec chat-side-todo-section"')
    expect(sidePanel).toContain("emit('outlineTargetChange', props.collapsed ? null : outlineHostRef.value)")
    expect(sidePanel).not.toContain('chat-side-panel-toggle')
    expect(sidePanel).toContain('background: transparent;')
    expect(sidePanel).toContain('.chat-side-panel.collapsed')
    expect(sidePanel).toContain('padding: 0;')
    expect(sessionHeader).toContain('sidePanelAvailable?: boolean')
    expect(sessionHeader).toContain('sidePanelCollapsed?: boolean')
    expect(sessionHeader).toContain('class="header-btn side-panel-toggle"')
    expect(sessionHeader).not.toContain('v-if="sidePanelAvailable"')
    expect(sessionHeader).toContain("toggleSidePanel: []")
    expect(sidePanel).toContain('<TodoProgressPanel')
    expect(sidePanel).toContain("window.addEventListener('todo-plan:toggle-card', handleTodoToggleCard)")
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
    expect(workbench).toContain('WORKSPACE_NAV_PANELS')
    // 清单从注册表派生,不是手抄一份 id 数组。
    expect(workbench).toContain('WORKSPACE_NAV_PANELS.map(panel => ({')
    expect(workbench).toContain('lazy')
    expect(workbench).toContain("tab.type === 'workspace' && tab.panelId === 'agents'")
    expect(workbench).toContain('<MediaPanelContent')
    expect(workbench).toContain('<ArchivedChatsContent')
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
