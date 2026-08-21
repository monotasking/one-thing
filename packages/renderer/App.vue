<template>
  <!-- Settings Window Mode -->
  <SettingsPage v-if="isSettingsWindow" />

  <!-- Image Preview Window Mode -->
  <ImagePreviewWindow v-else-if="isImagePreviewWindow" />

  <!-- Search Everywhere Window Mode -->
  <SearchWindow v-else-if="isSearchWindow" />

  <!-- Todo / Plan Window Mode -->
  <TodoPlanWindow v-else-if="isTodoPlanWindow" />

  <!-- Hidden Voice Runtime Window Mode -->
  <VoiceRuntimeWindow v-else-if="isVoiceRuntimeWindow" />

  <!-- Main App Mode -->
  <ErrorBoundary v-else-if="appReady">
    <!-- 插件氛围层(G2 —— 全窗动画覆盖,内容之上、浮层之下)。只挂主窗聊天面:
         辅助窗口(设置/搜索/todo)不挂氛围层。position:fixed + pointer-events:none,
         DOM 位置不影响铺放。key 绑 pluginId:换一层氛围 = 换一代 iframe。 -->
    <PluginAmbientLayer
      v-if="activeAmbient"
      :key="activeAmbient.pluginId"
      :entry-url="activeAmbient.entryUrl"
    />
    <!-- 插件背景层(G 期,L2.5;2026-08-10 起铺**整窗**)。挂在窗口根、
         position:fixed z0,主窗 body 自己画着不透明的 --ui-surface-app-bg,
         图铺不满(contain/透明图)时露出的是应用底色,不是桌面。
         纯静态绘制:不做 rAF、不做过渡(透明窗掉帧判例)。 -->
    <div
      v-if="pluginBackgroundActive"
      class="app-background-layer"
      :style="pluginBackgroundStyle"
    />
    <!-- 三栏树在 `components/shell/AppShell.vue`(L5)。App 这一侧只剩窗口模式
         分发、插件背景/氛围层、事件路由与空间切换 —— 布局是这四件事里唯一
         可以被单独看懂的一块,它的输入只有协调器那几个数。 -->
    <AppShell
      ref="appShellRef"
      v-model:sidebar-width="sidebarWidth"
      :sidebar-min-width="MIN_SIDEBAR_WIDTH"
      :sidebar-max-width="shellLayout.sidebarMaxWidth"
      :sidebar-docked="sidebarDockedVisible"
      :sidebar-resizing="sidebarResizing"
      :chat-min-width="CHAT_MIN_WIDTH"
      :workbench-mounted="workbenchMounted"
      :workbench-revealed="workbenchRevealed"
      :workbench-visible="workbenchVisible"
      :workbench-panel-width="workbenchPanelWidth"
      :workbench-min-width="shellLayout.workbenchMinWidth"
      :workbench-max-width="shellLayout.workbenchMaxWidth"
      :workbench-slide-width="shellLayout.workbenchWidth"
      @sidebar-resize-start="handleSidebarResizeStart"
      @sidebar-resize-end="handleSidebarResizeEnd"
      @workbench-resize-start="inspectorResizing = true"
      @workbench-resize-end="handleInspectorResizeEnd"
      @update:workbench-panel-width="handleInspectorPanelSizeUpdate"
    >
      <!-- 全仓**唯一**一个 `<Sidebar>`(L4)。浮层态不是第二个实例,而是同一个
           实例加 `.floating` 后 `position: fixed` 覆盖出去,左栏 SplitterPanel
           同时收成 0 宽(`:collapsed`)—— 于是滚动位置、展开的分组、搜索框里
           打了一半的字在浮层⇄停靠之间天然保留(双实例时代做不到)。
           `position: fixed` 不被 `.splitter-panel` 的 `overflow: hidden` 裁:
           链路上没有任何祖先带 transform/contain,浮层的包含块仍是视口。 -->
      <template #sidebar>
        <Sidebar
          :collapsed="false"
          :floating="sidebarFloating"
          :floating-closing="sidebarFloatingClosing"
          :no-transition="sidebarNoTransition"
          :width="sidebarWidth"
          @open-settings="openSettingsWindow"
          @toggle-collapse="handleSidebarToggle"
          @open-search="openSearch"
          @create-new-chat="createNewChat"
          @toggle-media-panel="openWorkspacePanel('media')"
          @open-workspace-panel="openWorkspacePanel"
          @select-session="selectSidebarSession"
          @request-floating-keep-open="keepFloatingSidebarOpen"
          @request-floating-close="closeFloatingSidebar"
        />
      </template>

      <template #main>
        <Container
          as="div"
          main-as="div"
          class="app-main-region"
          body-class="app-main-body"
          main-class="app-main-content-region"
          full-height
          :main-flex="'1 1 0'"
          overflow="hidden"
          main-overflow="hidden"
        >
          <!-- 主区只剩会话。工作区面板(Media/Agents/Tasks/…)已迁进右侧
               工作台成为「工作区域」页签(P1),那个把聊天整个盖住的全屏
               容器随之退役 —— 于是"一边看面板一边看会话"第一次成立。
               这一层壳留着:它是壁纸体系登记在案的四处区域根之一
               (wallpaper.css `html.has-wallpaper .workspace-view-stack`)。 -->
          <div class="workspace-view-stack">
            <ChatContainer
              ref="chatContainerRef"
              class="workspace-view workspace-view-chat"
              :sidebar-collapsed="sidebarStowed"
              :sidebar-floating="sidebarFloating"
              :show-hover-trigger="sidebarStowed && !sidebarFloating"
              :is-inspector-open="inspectorOpen"
              :reserve-sidebar-actions="reserveSidebarActions"
              :layout-transitioning="sidebarActionAnimating || inspectorResizing"
              @toggle-sidebar="handleSidebarToggle"
              @open-search="openSearch"
              @create-new-chat="createNewChat"
              @show-floating-sidebar="handleTriggerEnter"
              @hide-floating-sidebar="handleTriggerLeave"
              @toggle-inspector="inspectorOpen = !inspectorOpen"
              @open-outline="openOutlineInRightWorkbench"
              @open-file="openFileInRightWorkbench"
              @review-goal="openGoalReviewInRightWorkbench"
            />
          </div>
        </Container>
      </template>

      <template #workbench>
        <RightWorkbenchPanel
          ref="rightWorkbenchRef"
          :session-id="sessionsStore.currentSessionId"
          :workspace-root="currentWorkspaceRoot"
          :workspace-roots="currentWorkspaceRoots"
          :revealed="workbenchRevealed"
          @close="inspectorOpen = false"
          @jump-to-source="handleWorkbenchJumpToSource"
        />
      </template>

      <template #content-overlays>
        <VoiceOverlay />
        <VoiceCallPanel />
      </template>

      <!-- Old search overlay removed — replaced by Search Everywhere window -->
    </AppShell>
  </ErrorBoundary>

  <!-- Evals incident workbench (full-screen overlay). Rendered OUTSIDE the
       window-mode branches: the entry button lives in the Settings window,
       which renders the SettingsPage branch — an overlay confined to the
       main-app branch would never appear there. -->
  <EvalsWorkbench v-if="evalsWorkbenchStore.open" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue'
import { getLogger } from '@/services/log'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspaceStore, type WorkspaceHydrationSource } from '@/stores/workspace'
import type { PersistedSessionReadMarks } from '@/stores/session-read-marks'
import { useSpacesStore } from '@/stores/spaces'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useThemeStore } from '@/stores/themes'
import { useVoiceStore } from '@/stores/voice'
import { useShortcuts } from '@/composables/useShortcuts'
import { resolveInspectorDefaultOpen } from '@/composables/useInspectorDefault'
import { MIN_SIDEBAR_WIDTH, useLayoutPrefsStore } from '@/stores/layoutPrefs'
import { CHAT_MIN_WIDTH, useShellLayout } from '@/composables/useShellLayout'
import { useFloatingSidebar } from '@/composables/useFloatingSidebar'
import { Sidebar } from '@/components/sidebar'
import AppShell from '@/components/shell/AppShell.vue'
import ChatContainer from '@/components/ChatContainer.vue'
import Container from '@/components/common/Container.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import SettingsPage from '@/components/SettingsPage.vue'
import ImagePreviewWindow from '@/components/ImagePreviewWindow.vue'
import RightWorkbenchPanel from '@/components/workbench/RightWorkbenchPanel.vue'
import SearchWindow from '@/components/search/SearchWindow.vue'
import TodoPlanWindow from '@/components/TodoPlanWindow.vue'
import VoiceRuntimeWindow from '@/components/voice/VoiceRuntimeWindow.vue'
import VoiceOverlay from '@/components/voice/VoiceOverlay.vue'
import VoiceCallPanel from '@/components/voice/VoiceCallPanel.vue'
import EvalsWorkbench from '@/components/evals/EvalsWorkbench.vue'
import { useEvalsWorkbenchStore } from '@/stores/evalsWorkbench'
import { useOverlayPresenceStore } from '@/stores/overlayPresence'
import { useBrowserStore } from '@/stores/browser'
import { useDoubleShift } from '@/composables/useDoubleShift'
import { ensureCacheReady as ensureMarkdownCacheReady } from '@/components/chat/message/markdownRenderCache'
import { platformApi } from '@/platform'
import { appStateApi } from '@/platform/app-state-client'
import { toast } from '@/composables/useToast'
import { getToolFilePath } from '@/stores/helpers/tool-step-view'
import {
  isImagePath,
  setReferenceHost,
  type ReferenceFilePosition,
  type ReferenceHost,
} from '@/references'
import { useCollabBoardStore } from '@/stores/collabBoard'
import {
  pluginPanelHasPlacement,
  usePluginWorkspacePanels,
  workspacePanelWindowEvent,
  type WorkspaceNavId,
} from '@/workspace/panel-registry'
import {
  AGENT_OPEN_WORKSPACE_EVENT,
  AGENT_OPEN_SPACE_EVENT,
  useAgentsStore,
  type AgentOpenSpaceDetail,
} from '@/stores/agents'
import {
  COLLAB_TAG_OPEN_AGENT_EVENT,
  COLLAB_TAG_OPEN_CARD_EVENT,
  COLLAB_TAG_OPEN_FILE_EVENT,
  registerCollabMentionResolver,
  registerCollabTagVerifier,
} from '@/composables/collabInlineTags'
import {
  usePluginBackground,
  usePluginBackgroundActive,
} from '@/workspace/background-registry'
import { usePluginAmbient } from '@/workspace/ambient-registry'
import PluginAmbientLayer from '@/components/plugins/PluginAmbientLayer.vue'
import { resolveDeliverablePath } from '@/components/workbench/collab-board-card'
import { OPEN_MEMBERS_EVENT, type OpenMembersDetail } from '@/components/workbench/room-members'

// Detect auxiliary windows from the hash. Keep it reactive because dev HMR
// and BrowserWindow reuse can change the hash after App has already mounted.
const currentHash = ref(window.location.hash)
const isSettingsWindow = computed(() => currentHash.value.startsWith('#/settings'))
const isImagePreviewWindow = computed(() => currentHash.value.startsWith('#/image-preview'))
const isSearchWindow = computed(() => currentHash.value.startsWith('#/search'))
const isTodoPlanWindow = computed(() => currentHash.value.startsWith('#/todo-plan'))
const isVoiceRuntimeWindow = computed(() => currentHash.value.startsWith('#/voice-runtime'))
const isAuxiliaryWindow = computed(() =>
  isSettingsWindow.value ||
  isImagePreviewWindow.value ||
  isSearchWindow.value ||
  isTodoPlanWindow.value ||
  isVoiceRuntimeWindow.value
)

function syncCurrentHash() {
  currentHash.value = window.location.hash
}

const sessionsStore = useSessionsStore()
const workspaceStore = useWorkspaceStore()
// ⌘1..9 切空间要按列表序取 id(批 B5)。
const spacesStore = useSpacesStore()
const collabBoardStore = useCollabBoardStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const themeStore = useThemeStore()
const voiceStore = useVoiceStore()
/* 布局偏好(L0)与布局协调器(L2)—— 四列的尺寸/开合从此各有一个唯一来源:
   **偏好**在 store 里(落盘),**实际**由 `shellLayout` 按窗宽预算算出来(不落盘)。 */
const layoutPrefs = useLayoutPrefsStore()
const {
  layout: shellLayout,
  setWorkbenchRequested,
  observeShellWidth,
} = useShellLayout()

const appReady = ref(false)
const evalsWorkbenchStore = useEvalsWorkbenchStore()
const overlayPresenceStore = useOverlayPresenceStore()
// ⌘T/⌘W 路由要问它：面板自己的 DOM 是不是当前操作的那块（见 stores/browser.ts）。
const browserStore = useBrowserStore()
// Full-screen modal overlays float above the embedded browser's native view;
// register them so BrowserPanel hides the view while they're open (§8.2).
watch(() => evalsWorkbenchStore.open, open => overlayPresenceStore.setOverlay('evals', open))
const chatContainerRef = ref<InstanceType<typeof ChatContainer> | null>(null)
/* `.app-shell` / `.app-content` 两个元素归 AppShell 画,App 只从它 expose 的口
   取回来:一处挂协调器那唯一的 ResizeObserver,一处给搜索窗当居中锚点。 */
const appShellRef = ref<InstanceType<typeof AppShell> | null>(null)
const appShellElement = computed(() => appShellRef.value?.shellElement ?? null)
const appContentElement = computed(() => appShellRef.value?.contentElement ?? null)

/**
 * 插件背景层(G 期,L2.5)。
 *
 * 层的**数值**(opacity / blur / 图 URL)是数据不是样式字面量 —— 它们由插件
 * 声明、宿主钳制,不可能事先写进 token 表,所以内联是唯一诚实的写法。
 * 铺放方式则映射成两个枚举出来的 CSS 值,不接受插件传任何 CSS 片段。
 */
const pluginBackground = usePluginBackground()
const pluginBackgroundActive = usePluginBackgroundActive()

/**
 * 氛围层(G2 —— 全窗动画覆盖)。
 *
 * 注册表(`ambient-registry`)收的是**主进程裁决出的 winner**(全窗只有一层);
 * 用户主权在**这里**叠加,而不是在裁决里 —— 这样关总闸能**当场**撤层,不必等
 * 一次清单重拉:
 *  - 总闸 `settings.plugins.ambientEnabled === false` → 一键全关;
 *  - 赢家的插件在 `ambientMutedPluginIds` 里 → 单独关掉它这一层。
 * 两者都是响应式 app settings,改一下 computed 立刻重算,层随之挂/撤。
 */
const pluginAmbient = usePluginAmbient()
const activeAmbient = computed(() => {
  const layer = pluginAmbient.value
  if (!layer) return null
  const preferences = settingsStore.settings.plugins
  if (preferences?.ambientEnabled === false) return null
  if (preferences?.ambientMutedPluginIds?.includes(layer.pluginId)) return null
  return layer
})
const pluginBackgroundStyle = computed<Record<string, string>>(() => {
  const layer = pluginBackground.value
  if (!layer) return {}
  const style: Record<string, string> = {
    '--plugin-background-image': `url("${layer.imageUrl}")`,
    '--plugin-background-dark-image': `url("${layer.darkImageUrl}")`,
    opacity: String(layer.opacity),
  }
  if (layer.fit === 'tile') {
    style.backgroundRepeat = 'repeat'
    style.backgroundSize = 'auto'
  } else {
    style.backgroundRepeat = 'no-repeat'
    style.backgroundSize = layer.fit
  }
  // blur 只在插件真的要了它的时候才加:filter 会把这一层提成独立合成层,
  // 半径为 0 的模糊仍然要付那笔代价,而它什么也没做。
  if (layer.blur > 0) style.filter = `blur(${layer.blur}px)`
  return style
})

/**
 * 壁纸模式的**作用域根**:`html.has-wallpaper`(样式全文在 `styles/wallpaper.css`)。
 *
 * 为什么挂在 documentElement 而不是 `.app-shell` / `.app-content`:菜单、popover、
 * 下拉、会话预览卡、@ 面板全部 `Teleport to="body"`,它们是 `.app-shell` 的**兄弟**,
 * 挂在 shell 上的选择器(哪怕加了 `:deep`)永远够不着 —— 上一轮那条治浮层侧栏的
 * 规则就是这么变成死码的。根类一挂,今天的浮层和明天任何新 teleport 面都自然进入
 * 体系,不必再逐个补作用域。
 *
 * 只主窗挂:辅助窗口(设置 / 搜索 / todo / 图片预览 / 语音运行时)不铺壁纸,而且
 * 它们各自是独立 BrowserWindow —— 这里的 `isAuxiliaryWindow` 判的就是本窗身份。
 */
const WALLPAPER_ROOT_CLASS = 'has-wallpaper'
watch(
  () => pluginBackgroundActive.value && !isAuxiliaryWindow.value,
  on => {
    document.documentElement.classList.toggle(WALLPAPER_ROOT_CLASS, on)
  },
  { immediate: true }
)
onUnmounted(() => {
  // 根类挂在 App 之外的元素上,组件卸载不会带走它 —— 必须显式清理,否则热更新/
  // 窗口复用时会留下一层永不生效来源的样式开关。
  document.documentElement.classList.remove(WALLPAPER_ROOT_CLASS)
})
const rightWorkbenchRef = ref<InstanceType<typeof RightWorkbenchPanel> | null>(null)
/** 插件面板清单(H1 投影)—— 布局动词按它把 panelId 解成一个真面板。 */
const pluginWorkspacePanels = usePluginWorkspacePanels()
const inspectorOpen = computed({
  get: () => chatStore.inspectorOpen,
  set: (val) => { chatStore.inspectorOpen = val }
})

/* C0 的 workbench↔classic 外壳回滚闸已于 2026-08-05 整套退役(D2 / U0),它的
   根属性 `data-shell-mode` 与 CSS 门也随 U0b 一起删干净了 —— 外壳只有一套。 */

/* 右栏开合的持久化(W-Q2)。落点自 L0 起统一在 `layoutPrefs` store(单 key
   `onething.layout.v1`),旧的裸 `localStorage['inspectorOpen']` 由 store 首次读时
   迁移并删除 —— App.vue 这一侧不再自己碰 localStorage。 */

/**
 * 右栏初值(W-Q2:≥1400px 默认展开,否则默认收起但入口保留)。
 *
 * 「默认」不是「强制」:存过的用户选择永远胜出,手动收起的人不会每次被弹开。
 */
let inspectorDefaultApplied = false
function applyInspectorDefaultOnce() {
  if (inspectorDefaultApplied) return
  inspectorDefaultApplied = true
  if (isAuxiliaryWindow.value) return
  inspectorOpen.value = resolveInspectorDefaultOpen({
    viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    stored: layoutPrefs.workbenchOpen,
  })
}

/* 之后的每一次开合(手动点、⌘ 面板、代码里打开某个文件)都记账:下次启动
   照用户上次留下的样子,而不是把窗宽默认值再算一遍。 */
watch(inspectorOpen, open => {
  if (!inspectorDefaultApplied || isAuxiliaryWindow.value) return
  layoutPrefs.setWorkbenchOpen(open)
})

/* 侧栏宽度/折叠的**唯一**落点是 layoutPrefs store(L0);这里只是它的读写门面。
   clamp 也只在 store 里做一次 —— App.vue 从前那份 `clampSidebarWidth` 已删。 */
const sidebarWidth = computed({
  get: () => layoutPrefs.sidebarWidth,
  set: (width: number) => { layoutPrefs.sidebarWidth = width },
})
const sidebarResizing = ref(false)

// 面板 id 从注册表派生 —— 这条联合原先是 ≥6 处手抄之一。
/**
 * 工作区面板的 nav id。
 *
 * 从 `OpenableWorkspacePanelId` 放宽到 `WorkspaceNavId`:⋯ 菜单覆盖全部
 * inPanelNav 面板,而 nav-only 的内置面板(archive / practice)与插件面板
 * 按老类型根本进不了这条链 —— 那正是它们当年没有入口的原因。
 */
type WorkspacePanel = WorkspaceNavId
type TodoPlanWebWindowActionDetail = {
  action?: 'open' | 'hide' | 'toggle' | 'pin'
}

// 事件名从注册表取:面板"有几条进入路径"这件事现在有唯一一处可查
// (deep components reach App through a window event —— 与 todo-plan 同款)。
const TODO_PLAN_WEB_WINDOW_EVENT = workspacePanelWindowEvent('tasks')
const PRACTICE_OPEN_WORKSPACE_EVENT = workspacePanelWindowEvent('practice')
const TRAJECTORY_OPEN_WORKSPACE_EVENT = workspacePanelWindowEvent('trajectory')

/**
 * 工作区面板的入口(P1 起全部落在右侧工作台上)。
 *
 * 从前这些面板是**主区的另一半** —— 一置位,`MediaPanel` 就把聊天整个盖住,
 * 而且每一条切会话的路径都得记着把它关掉(漏一条就是"面板卡在那儿")。
 * 现在它们是工作台的一条页签:展开右栏 + 落座那一格,于是
 * **切会话不再关面板**(右域跨会话保持,是刻意的行为变化),App 这一侧也不再
 * 存"当前哪个面板"这个状态 —— 唯一事实在工作台的 openTabs 里。
 */
async function openWorkspacePanel(panel: WorkspacePanel) {
  if (sidebarFloating.value) {
    closeFloatingSidebar()
  }
  workspacePanelRequested.value = true
  inspectorOpen.value = true
  /* 首次打开时右栏是**这几拍才挂载**的(mount → nextTick → reveal 两段),
     一个 nextTick 不一定等得到那个 ref —— 等不到就等于这条入口在"右栏还没开过"
     的那一次静默失效。 */
  for (let tick = 0; tick < 3 && !rightWorkbenchRef.value; tick += 1) await nextTick()
  rightWorkbenchRef.value?.openWorkspaceTab(panel)
}

function handlePracticeOpenWorkspace() {
  if (isAuxiliaryWindow.value) return
  void openWorkspacePanel('practice')
}

/* Agent 空间页(agent-im-chat-ui.md C3):群聊气泡、dm 房头深在组件树里,够不到
   openWorkspacePanel 的 emit 链,所以走与 practice 同款的 window 事件。要看的
   agent 与 tab 意图已经由 store 的 `openAgentSpace` 寄存好,这里只管展开面板。 */

function handleAgentOpenWorkspace() {
  if (isAuxiliaryWindow.value) return
  void openWorkspacePanel('agents')
}

/* 轨迹面板(主线 E1):聊天里的工具卡片点「检查」时,要看的那一笔已经由
   `requestTrajectoryInspect` 寄存进 one-shot handoff,这里只管把页签开出来 ——
   与 practice / agents 同款。 */
function handleTrajectoryOpenWorkspace() {
  if (isAuxiliaryWindow.value) return
  void openWorkspacePanel('trajectory')
}

/**
 * todo-plan 的 open / hide / toggle 落在工作台上。
 *
 * 「关」现在的意思是**收起右栏**(工作台整条折叠),而不是卸掉那条页签 ——
 * 页签是用户自己开的,替 TA 关掉等于下次还得再找一遍;而且只有当 tasks 就是
 * 当前那一格时才收,不然收的是别人的面。
 */
function handleTodoPlanWebWindowAction(event: Event) {
  if (isAuxiliaryWindow.value) return
  const detail = (event as CustomEvent<TodoPlanWebWindowActionDetail>).detail
  const tasksShowing = () =>
    inspectorOpen.value && !!rightWorkbenchRef.value?.isWorkspaceTabActive('tasks')
  switch (detail?.action) {
    case 'open':
      void openWorkspacePanel('tasks')
      break
    case 'hide':
      if (tasksShowing()) inspectorOpen.value = false
      break
    case 'toggle':
      if (tasksShowing()) inspectorOpen.value = false
      else void openWorkspacePanel('tasks')
      break
    case 'pin':
      break
  }
}

async function selectSidebarSession(sessionId: string) {
  if (sidebarFloating.value) {
    closeFloatingSidebar()
  }
  await sessionsStore.switchSession(sessionId)
}

function openSettingsWindow() {
  platformApi.openSettingsWindow()
}


// Setup global keyboard shortcuts
useShortcuts({
  onNewChat: () => {
    if (isAuxiliaryWindow.value) return
    createNewChat()
  },
  onToggleSidebar: () => {
    if (isAuxiliaryWindow.value) return
    handleSidebarToggle()
  },
  onFocusInput: () => {
    if (isAuxiliaryWindow.value) return
    chatContainerRef.value?.focusInput()
  },
  onOpenSettings: () => {
    if (isAuxiliaryWindow.value) return
    platformApi.openSettingsWindow()
  },
  onSearchEverywhere: () => {
    if (isAuxiliaryWindow.value) return
    openSearch()
  },
  onToggleTodoPlanWindow: () => {
    platformApi?.toggleTodoPlanWindow?.({
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
    })
  },
  onToggleTodoPlan: () => {
    if (isAuxiliaryWindow.value) return
    window.dispatchEvent(new CustomEvent('todo-plan:toggle-card'))
  },
  /**
   * ⌘1..9 切空间(批 B5)。这里只改"当前空间"这一个值 —— 换分栏树、重载项目
   * 名册、校正激活会话全挂在 Sidebar 对 `currentSpaceId` 的那条 watch 上,
   * 与点色点走的是同一条路。
   */
  onSelectSpace: (index: number) => {
    if (isAuxiliaryWindow.value) return
    const target = spacesStore.spaces[index]
    if (target) spacesStore.switchTo(target.id)
  },
})


// Persist sidebar collapsed state and control traffic lights visibility
const sidebarCollapsed = computed({
  get: () => layoutPrefs.sidebarCollapsed,
  set: (collapsed: boolean) => { layoutPrefs.setSidebarCollapsed(collapsed) },
})
/**
 * 侧栏「不在停靠位上」—— 用户折叠的,**或**预算把它挤成浮层的(L2 降级第 4 步)。
 *
 * 呈现层(hover 触发区、顶栏留位、房头缩进)一律读它而不是 `sidebarCollapsed`:
 * 那一枚是**偏好**,窄窗自动收起时它不该被改写,否则窗宽恢复后侧栏回不来。
 */
const sidebarStowed = computed(() => !shellLayout.value.sidebarDocked)
/* 浮层侧栏的四段时序(hover 延迟 / 关闭动画 / 关闭后冷却 / toggle 后冷却)整台
   搬进 `useFloatingSidebar`(L4)。App 这一侧只剩三枚布尔与几个回调 —— 从前这里
   躺着四个裸 timer、一枚 cooldown 布尔,以及 onUnmounted 里四段清场代码。 */
const {
  floating: sidebarFloating,
  closing: sidebarFloatingClosing,
  noTransition: sidebarNoTransition,
  actionAnimating: sidebarActionAnimating,
  triggerEnter: handleTriggerEnter,
  triggerLeave: handleTriggerLeave,
  keepOpen: keepFloatingSidebarOpen,
  close: closeFloatingSidebar,
  notifyToggled: notifySidebarToggled,
  reset: resetFloatingSidebar,
} = useFloatingSidebar()
const sidebarDockedVisible = computed(() =>
  !sidebarStowed.value && !sidebarFloating.value && !sidebarFloatingClosing.value
)

/**
 * 交通灯探出侧栏多少 —— 房头(RoomHeader)据此缩进,免得内容压在灯下面。
 *
 * macOS 的三颗灯横跨到窗口左起约 70px。旧壳(TabBar)一直有一块死板的 70px
 * 保留位;房面是 R1 新写的,漏了这块 —— 侧栏一收,房头就顶到窗口左上角
 * (真机走查发现)。这里仍然按侧栏**当前实际宽度**算而不是抄那个死数:折叠时
 * 侧栏整条卸下(占 0,灯全探出来),展开时灯完全落在侧栏内(探出 0)。
 *
 * 写成根变量而不是逐层透传 prop:App 是唯一知道侧栏当前实际宽度的人,而
 * 需要它的 RoomHeader 在三层之下。
 */
const TRAFFIC_LIGHTS_SPAN = 70
const sidebarOccupiedWidth = computed(
  () => sidebarDockedVisible.value ? sidebarWidth.value : 0,
)
const trafficLightsOverhang = computed(
  () => Math.max(0, TRAFFIC_LIGHTS_SPAN - sidebarOccupiedWidth.value),
)

watch(trafficLightsOverhang, (px) => {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--shell-lights-overhang', `${px}px`)
}, { immediate: true })

const reserveSidebarActions = ref(layoutPrefs.sidebarCollapsed)
function handleSidebarResizeStart() {
  sidebarResizing.value = true
}

function handleSidebarResizeEnd() {
  layoutPrefs.setSidebarWidth(sidebarWidth.value)
  sidebarResizing.value = false
}
/**
 * 右栏从前**只**在"有一个会话"时才挂:它那时装的全是会话的东西(文件/终端/
 * 线程/看板)。P1 之后它还装**跨会话**的工作区面板 —— 于是"一个会话都没开"
 * (空工作区)时它不能再一律不挂,否则侧栏「⋯」里的六个面板在那个状态下
 * 一个都点不开(从前它们是主区的全屏面板,与有没有会话无关)。
 *
 * 这个开关是**单向**的,与 `workbenchMounted` 同型:要过一次工作区面板,右栏
 * 就一直是"可显示"的,收起与否照旧由 `inspectorOpen` 说了算。
 */
const workspacePanelRequested = ref(false)
const inspectorVisible = computed(() =>
  inspectorOpen.value && (Boolean(sessionsStore.currentSessionId) || workspacePanelRequested.value))
/* 运行时闸灌给协调器;右栏**实际**显不显示由预算说了算(窄窗会把它临时收起,
   而 `inspectorOpen` 这枚偏好一个字节不动 —— 窗宽一恢复它自己弹回来)。 */
watch(inspectorVisible, requested => setWorkbenchRequested(requested), { immediate: true })
const workbenchVisible = computed(() => shellLayout.value.workbenchVisible)
function normalizeRootPath(root?: string | null): string {
  if (!root) return ''
  const trimmed = root.trim()
  if (trimmed === '/') return '/'
  return trimmed.replace(/\/+$/, '')
}

function uniqueRootPaths(roots: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const root of roots) {
    const normalized = normalizeRootPath(root)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

const currentWorkspaceRoots = computed(() => {
  const session = sessionsStore.currentSession
  return uniqueRootPaths([
    session?.workingDirectory,
    ...(session?.workingDirectoryRoots || []),
  ])
})
const currentWorkspaceRoot = computed(() => currentWorkspaceRoots.value[0] || '')
/**
 * 右栏的尺寸模型:**px**(L1)。
 *
 * 从前它是百分比,于是需要三件 hack 才能守住"最窄 250px"这条设计稿硬指标:
 * 一个量分栏容器宽的 ResizeObserver、一段 px→% 的下限换算、一份"每次读都重新
 * clamp"的 computed(只在写入时 clamp 会被窗口变窄绕过)。三件现在全没了 ——
 * 下限直接就是 250,上限由协调器按预算给(`shellLayout.workbenchMaxWidth`)。
 *
 * `workbenchPanelWidth` 是**拖拽期间的活值**:分栏器每帧回吐一次,松手才提交进
 * store。因此落盘只发生一次,`--workbench-width` 也只写一次(AppShell 在
 * `.app-content` 上写它)。
 */
const workbenchPanelWidth = ref(shellLayout.value.workbenchWidth)
const inspectorResizing = ref(false)

/* 预算改了宽度(窗口变窄 → 收窄到 250)或用户在别处改了偏好时同步活值;
   拖拽中不同步,免得把用户正在拖的那一帧顶回去。 */
watch(() => shellLayout.value.workbenchWidth, width => {
  if (inspectorResizing.value) return
  workbenchPanelWidth.value = width
})

/* 折叠动画的冻结宽(`--workbench-width`)由 AppShell 从 `workbenchSlideWidth`
   算并写在 `.app-content` 上 —— 一次写入、不每帧。 */

// Mount the workbench panel on first open, then keep it mounted so closing
// only collapses it (animated) and its tab/terminal state is preserved.
// First open mounts collapsed and expands a frame later so the slide-in
// transition runs from width 0.
const workbenchMounted = ref(false)
const workbenchRevealed = ref(false)
watch(workbenchVisible, async visible => {
  if (visible && !workbenchMounted.value) {
    workbenchMounted.value = true
    await nextTick()
    // Flush layout so the collapsed style is committed as the transition's
    // starting state; otherwise the panel pops in at partial width.
    void appContentElement.value?.offsetWidth
    workbenchRevealed.value = workbenchVisible.value
    return
  }
  workbenchRevealed.value = visible
}, { immediate: true })

// The splitter reports size 0 for the collapsed panel; ignore it so the
// stored width survives close/reopen.
function handleInspectorPanelSizeUpdate(size: number) {
  if (!workbenchVisible.value) return
  workbenchPanelWidth.value = size
}

/* 全仓唯一一处量外壳宽的 ResizeObserver(L2)。协调器要的是**外壳总宽**,
   四列的预算都从这一个数派生 —— 从前 App.vue 量分栏容器、ChatContainer 又量
   聊天区,两个数各自定义各自的阈值,谁也不知道对方。 */
let disposeShellWidthObserver: (() => void) | null = null
watch(appShellElement, element => {
  disposeShellWidthObserver?.()
  disposeShellWidthObserver = observeShellWidth(element)
}, { flush: 'post' })
onUnmounted(() => {
  disposeShellWidthObserver?.()
  disposeShellWidthObserver = null
})

function handleInspectorResizeEnd() {
  inspectorResizing.value = false
  layoutPrefs.setWorkbenchWidth(workbenchPanelWidth.value)
}

/**
 * 「跳到来源消息」的落点(Media 面板 → 工作台中继 → 这里)。
 *
 * 复用搜索 deeplink 那条已成熟的路:`jumpToMessage` 自己处理 leaf 安置、
 * switchSession 与 `loadMessagesAround`。跳不到(消息已删/会话没了)时**静默** ——
 * 菜单那一侧已经把空 id 的项禁掉了,再弹一句错话只是噪音。工作台**不关**:
 * 跳转与右栏可见性是两件事。
 */
async function handleWorkbenchJumpToSource(payload: { sessionId: string; messageId: string }) {
  if (!payload?.sessionId || !payload?.messageId) return
  await chatContainerRef.value?.jumpToMessage?.(payload.sessionId, payload.messageId)
}

/**
 * 顶栏那颗「Contents」钮(L3):展开右栏 + 落座 outline 页签。
 *
 * 与 `openWorkspacePanel` 同一副骨架(它落的是工作区域那一半),差别只在这条
 * 开的是**会话域**的页签,因此不置 `workspacePanelRequested` —— 有会话本来就够
 * 让右栏可显示了。首开时右栏是"这几拍才挂载"的,所以同样要等那个 ref。
 */
async function openOutlineInRightWorkbench() {
  if (isAuxiliaryWindow.value) return
  inspectorOpen.value = true
  for (let tick = 0; tick < 3 && !rightWorkbenchRef.value; tick += 1) await nextTick()
  rightWorkbenchRef.value?.openWorkbenchTab('outline')
}

async function openFileInRightWorkbench(filePath: string, position?: ReferenceFilePosition) {
  if (!filePath) return
  inspectorOpen.value = true
  await nextTick()
  await rightWorkbenchRef.value?.openFile(filePath, position)
}

/**
 * 消息引用的宿主(docs/design/message-references-2026-08.md §3)。
 *
 * `references/` 不认识 workbench / 浏览器 store / platformApi —— 它只有一张动作
 * 表,宿主在这里把动作接到**既有**的入口上。多宿主差异也收在这里:web 没有内置
 * 浏览器,`openUrl` 直接退化成新标签页。
 */
function createReferenceHost(): ReferenceHost {
  return {
    openFile: (path, position) => openFileInRightWorkbench(path, position),
    openUrl: async (url) => {
      if (!platformApi.capabilities.embeddedBrowser) {
        await platformApi.openExternal(url)
        return
      }
      // 先把浏览器面板亮出来并等它完成 hydrate,再建 tab —— 反过来的话 BrowserPanel
      // 挂载时看到的 store 还是空的,会自己再开一个空 tab 盖在上面。
      // 每次点开新 tab 并前置:点消息里的链接是"看一眼",不该覆盖正在看的页面。
      inspectorOpen.value = true
      await nextTick()
      rightWorkbenchRef.value?.openWorkbenchTab('browser')
      await browserStore.ensureLoaded()
      const tabId = await browserStore.openTab(url)
      if (tabId) await browserStore.selectTab(tabId)
    },
    openExternal: url => void platformApi.openExternal(url),
    revealPath: path => void platformApi.revealPath(path),
    openFolder: path => openFolderInRightWorkbench(path),
    openImage: (path, fileUrl) => void platformApi.openImagePreview(fileUrl, path.split('/').pop() || path),
    statPath: async (path) => {
      const res = await platformApi.statPath(path).catch(() => null)
      if (!res?.success) return { exists: false, isDirectory: false, isImage: false }
      return {
        exists: true,
        isDirectory: res.type === 'directory',
        isImage: isImagePath(res.path || path),
        // `~` 由主进程展开,渲染端没有 home。
        path: res.path || undefined,
      }
    },
    // 相对路径 / 裸文件名的候选:① 会话的每个工作目录根;② 本会话里工具(write/edit/
    // read)碰过、且以该相对路径结尾的文件 —— 模型说"我生成了 `summary.md`"时,
    // 它指的几乎总是自己刚写的那个。候选顺序即优先级,open.ts 逐个 stat。
    resolveRelative: (path) => {
      const rel = path.replace(/^\.\//, '')
      const candidates: string[] = []
      for (const root of currentWorkspaceRoots.value) {
        candidates.push(`${root.replace(/\/+$/, '')}/${rel}`)
      }
      const sessionId = sessionsStore.currentSessionId
      if (sessionId) {
        const messages = chatStore.getSessionState(sessionId).messages.value
        const suffix = `/${rel}`
        // 后写的在前:同名文件以最近一次为准。
        for (let i = messages.length - 1; i >= 0; i--) {
          for (const step of messages[i].steps || []) {
            const filePath = step.toolCall ? getToolFilePath(step.toolCall, null, null, step) : ''
            if (filePath && (filePath === rel || filePath.endsWith(suffix)) && !candidates.includes(filePath)) {
              candidates.push(filePath)
            }
          }
        }
      }
      return candidates
    },
    notify: (message, type) => {
      if (type === 'error') toast.error(message)
      else toast.info(message)
    },
  }
}

async function openGoalReviewInRightWorkbench(sessionId: string) {
  if (!sessionId) return
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openGoalReview(sessionId)
}

/**
 * 右栏线程直达入口(工作台式外壳 C3,docs/design/im-workbench-layout.md §3 W4)。
 *
 * 与看板/文件夹入口同一条 window 事件解耦线路:派事件的地方(左栏活卡片、中栏
 * 活动线的「展开 →」)离右栏都隔着好几层,不该为了开一个 tab 一路透传 ref。
 */
async function openThreadInRightWorkbench(workSessionId: string, title?: string) {
  if (!workSessionId) return
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openThread(workSessionId, title)
}

/**
 * 右栏「成员」/ 空间页入口(R2)。三处派发共用这一条:房头成员堆、say 署名
 * 头像、私聊房面的默认落座。`agentId` 非空就直接停在空间页(下钻层,不占 tab 位)。
 */
async function openMembersInRightWorkbench(detail: OpenMembersDetail) {
  if (!detail.sessionId) return
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openMembers(detail.sessionId, detail.agentId, detail.title)
}

/**
 * 「打开这个人的空间」的唯一落点(agent-space-workbench.md P1)。
 *
 * 分流一句话:**够得着房就在房里下钻,够不着才单开一个页签**。
 *  - 当前会话所属的房里有这个人 → 成员 tab 内下钻(空间页不占 tab 位,样板铁律);
 *  - 直聊里的助理、已退休的同事、房外的人 → 以 TA 命名的 `agent` 页签。
 *
 * 两条都不再展开全屏 Agents 管理页 —— 点一下头像不该把正在看的会话面顶掉。
 */
async function openAgentSpaceInRightWorkbench(detail: AgentOpenSpaceDetail) {
  const agentId = detail?.agentId
  if (!agentId) return

  const active = sessionsStore.sessions.find(session => session.id === workspaceStore.activeSessionId)
  const roomSessionId = active?.kind === 'room' ? active.id : active?.collab?.roomSessionId || ''
  const room = roomSessionId
    ? sessionsStore.sessions.find(session => session.id === roomSessionId)?.room
    : undefined
  const isMember = !!room && (room.memberAgentIds?.includes(agentId) || room.pmAgentId === agentId)

  inspectorOpen.value = true
  await nextTick()
  if (isMember && roomSessionId) {
    // 单成员房(私聊)没有"成员"这回事 —— 那一格就叫「空间」。
    const title = (room?.memberAgentIds?.length ?? 0) > 1 ? '成员' : '空间'
    rightWorkbenchRef.value?.openMembers(roomSessionId, agentId, title)
    return
  }
  rightWorkbenchRef.value?.openAgentTab(agentId, detail.tab ?? null)
}

// 群聊房间头部的看板直达入口(window 事件解耦:TabBar 深处 → 这里)
/**
 * 房面进房 → 右栏备齐三 tab(线程 / 成员 / 看板)并落在线程上。
 *
 * 样板 final.html 的右栏是三 tab 常驻;实施时为了不出现两条右栏,复用了这根
 * App 级的 workbench,代价是那三条一条都不常驻 —— 真机上"看不到线程"。
 * 这里补齐:进房就把它们开好。右栏本身也一并打开(否则备齐了也看不见)。
 */
/* 具名 handler + onUnmounted 清理:匿名箭头既取不下来,HMR 一热更就重复注册,
   一条事件会开出两个线程页签(真机走查抓到)。 */
function handleRoomWorkbench(event: Event) {
  void openRoomWorkbench((event as CustomEvent).detail)
}

async function openRoomWorkbench(detail: { roomSessionId: string; workSessionId?: string; dmAgentId?: string }) {
  if (!detail?.roomSessionId) return
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openRoomTabs(detail.roomSessionId, detail.workSessionId, { dmAgentId: detail.dmAgentId })
}

async function openBoardInRightWorkbench() {
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openBoard()
}

/**
 * 行内 `<card>` / `<file>` 标签的验真与点击(collab-team-v2 §6.1)。
 *
 * 验真器在这里注册,是因为只有 App 层同时够得着看板镜像、会话表和 platformApi;
 * 渲染那一侧(composables/collabInlineTags)对这三样一无所知,没人注册时所有
 * 标签停在纯文本态 —— 验真链路挂掉的后果是"点不动",不是"点了跳错地方"。
 */
function roomWorkingDirectoryForTags(): string | undefined {
  const active = sessionsStore.sessions.find(session => session.id === workspaceStore.activeSessionId)
  if (!active) return undefined
  const roomId = active.kind === 'room' ? active.id : active.collab?.roomSessionId
  if (!roomId) return active.workingDirectory
  return sessionsStore.sessions.find(session => session.id === roomId)?.workingDirectory
}

function registerCollabTags() {
  // @提及 pill 的第二拍(im-message §A):只回答"这位同事现在什么颜色"。
  // 查无此人返回 null —— 那一枚就停在中性文字上,点不动。
  registerCollabMentionResolver({
    resolveAgent(agentId) {
      const found = agentsStore.agents.find(agent => agent.id === agentId)
      return found ? { color: found.color } : null
    },
  })
  registerCollabTagVerifier({
    verifyCard(id) {
      const found = collabBoardStore.findTask(id)
      return found ? { id: found.task.id, title: found.task.title, status: found.task.status } : null
    },
    async verifyFile(path) {
      const absolute = resolveDeliverablePath(path, roomWorkingDirectoryForTags())
      if (!absolute) return null
      try {
        const stat = await platformApi.statPath(absolute)
        return stat?.success && stat.type === 'file' ? { absolutePath: absolute } : null
      } catch {
        return null
      }
    },
  })
}

/** 群 folder 的文件树入口(collab-team-v2 §7):走既有 files 页签,换个根。 */
async function openFolderInRightWorkbench(root: string) {
  inspectorOpen.value = true
  await nextTick()
  await rightWorkbenchRef.value?.openFolder(root)
}

async function focusCardInRightWorkbench(taskId: string) {
  if (!collabBoardStore.focusTask(taskId)) return
  inspectorOpen.value = true
  await nextTick()
  rightWorkbenchRef.value?.openBoard()
}

/**
 * 插件布局动词的落点(I 期,`api.ui.toggleSidebar` / `api.ui.openWorkbench`)。
 *
 * 手势闸(5s 窗口)与 unsupported 都在**主进程**判完了 —— 到这里的每一条都是
 * 已经放行的命令,renderer 不再判第二遍(判两遍 = 两份口径,多窗口下还会各判
 * 一次)。这里只做一件事:把动词接到侧栏/右栏**既有**的那两个动作上。
 *
 * 辅助窗口(设置/搜索/todo)没有这套布局,直接忽略。
 */
async function handlePluginLayout(event: Event) {
  if (isAuxiliaryWindow.value) return
  const detail = (event as CustomEvent<{ verb?: string; panelId?: string; pluginId?: string }>).detail
  if (detail?.verb === 'toggle-sidebar') {
    handleSidebarToggle()
    return
  }
  if (detail?.verb !== 'open-workbench') return
  inspectorOpen.value = true
  if (!detail.panelId) return
  await nextTick()
  // 面板 tab 走 H1 既有的打开路径。**只认自己的面板、只认声明了 workbench 位的
  // 那些**:插件不能借这条动词把别人的面板顶到前台。标题从清单现取,不信
  // 插件传来的字(入口文案永远来自 manifest 投影)。
  const panel = pluginWorkspacePanels.value.find(item =>
    item.pluginId === detail.pluginId
    && item.panelId === detail.panelId
    && pluginPanelHasPlacement(item, 'workbench'))
  if (panel) rightWorkbenchRef.value?.openPluginTab(panel.pluginId, panel.panelId, panel.label)
}

onMounted(() => {
  // 引用宿主只有一份 —— 辅助窗口(设置/搜索/todo)不装,它们没有右栏可落。
  if (!isAuxiliaryWindow.value) setReferenceHost(createReferenceHost())
  window.addEventListener('onething:plugin-layout', handlePluginLayout)
  window.addEventListener('onething:collab-open-board', () => { void openBoardInRightWorkbench() })
  window.addEventListener('onething:room-workbench', handleRoomWorkbench)
  window.addEventListener('onething:collab-open-folder', event => {
    const root = (event as CustomEvent<{ root?: string }>).detail?.root
    if (root) void openFolderInRightWorkbench(root)
  })
  // C3 契约(左栏活卡片 / 中栏活动线共用,形状不许改):
  //   CustomEvent<{ workSessionId: string; title?: string; taskId?: string }>
  window.addEventListener('onething:open-thread', event => {
    const detail = (event as CustomEvent<{ workSessionId?: string; title?: string }>).detail
    if (detail?.workSessionId) void openThreadInRightWorkbench(detail.workSessionId, detail.title)
  })
  window.addEventListener(OPEN_MEMBERS_EVENT, event => {
    const detail = (event as CustomEvent<OpenMembersDetail>).detail
    if (detail?.sessionId) void openMembersInRightWorkbench(detail)
  })
  window.addEventListener(COLLAB_TAG_OPEN_CARD_EVENT, event => {
    const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId
    if (taskId) void focusCardInRightWorkbench(taskId)
  })
  window.addEventListener(COLLAB_TAG_OPEN_FILE_EVENT, event => {
    const filePath = (event as CustomEvent<{ filePath?: string }>).detail?.filePath
    if (filePath) void openFileInRightWorkbench(filePath)
  })
  // 点 @提及 pill → 那位同事的空间(与头像/署名同一个落点)。
  window.addEventListener(COLLAB_TAG_OPEN_AGENT_EVENT, event => {
    const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId
    if (agentId) void openAgentSpaceInRightWorkbench({ agentId })
  })
  // 点头像 → 右栏(P1)。三处头像与侧栏右键「打开空间」都派这一条。
  window.addEventListener(AGENT_OPEN_SPACE_EVENT, event => {
    const detail = (event as CustomEvent<AgentOpenSpaceDetail>).detail
    if (detail?.agentId) void openAgentSpaceInRightWorkbench(detail)
  })
  registerCollabTags()
})

// Handle sidebar toggle - if floating, just close floating mode
function handleSidebarToggle() {
  if (sidebarFloating.value) {
    closeFloatingSidebar()
    return
  }
  const nextCollapsed = !sidebarCollapsed.value

  // Animate sidebar width and top-bar reservation as complementary offsets.
  // This keeps the tab strip from being pushed twice during expand.
  reserveSidebarActions.value = nextCollapsed
  sidebarCollapsed.value = nextCollapsed
  // 340ms 的动画窗口 + hover 冷却归时序机(L4)。
  notifySidebarToggled()
}

/* Close floating mode when the sidebar is docked again.
   跟的是 `sidebarStowed`(偏好 ∪ 预算)而不是偏好本身:窄窗把侧栏挤成浮层时,
   顶栏也得照样留出那颗按钮的位置。 */
watch(sidebarStowed, (stowed) => {
  if (!sidebarActionAnimating.value) {
    reserveSidebarActions.value = stowed
  }
  if (!stowed) {
    resetFloatingSidebar()
  }
})

/* 折叠偏好的落盘归 layoutPrefs store;这里只剩交通灯。 */
watch([sidebarStowed, sidebarFloating], () => {
  // Auxiliary windows own their chrome behavior. Todo/Notes uses native hover-only buttons.
  if (isSettingsWindow.value || isImagePreviewWindow.value || isSearchWindow.value || isTodoPlanWindow.value) return
  // Always show traffic lights since sidebar strip is always visible
  platformApi?.setWindowButtonVisibility?.(true).catch(() => {
    // Handler may not be registered yet during initial load
  })
}, { immediate: true })


// Search Everywhere — open via IPC (toolbar button + double shift). Hosts
// without desktop windows (web) have no search surface; the toolbar button is
// hidden there and the shortcut must not fire a silent no-op.
function openSearch() {
  if (!platformApi.capabilities.desktopWindows) return
  platformApi.toggleSearchWindow()
}

// Report the content area rect (sidebar excluded) so the main process can
// center the Search Everywhere window on the chat area instead of the full
// window width.
let searchAnchorObserver: ResizeObserver | null = null
let searchAnchorReportTimer: ReturnType<typeof setTimeout> | null = null

function reportSearchAnchor() {
  const el = appContentElement.value
  if (!el || typeof platformApi.setSearchWindowAnchor !== 'function') return
  const rect = el.getBoundingClientRect()
  void platformApi
    .setSearchWindowAnchor({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    .catch(() => {})
}

function scheduleSearchAnchorReport() {
  if (searchAnchorReportTimer) clearTimeout(searchAnchorReportTimer)
  searchAnchorReportTimer = setTimeout(() => {
    searchAnchorReportTimer = null
    reportSearchAnchor()
  }, 150)
}

function setupSearchAnchorObserver() {
  const el = appContentElement.value
  if (!el || typeof ResizeObserver === 'undefined') return
  searchAnchorObserver = new ResizeObserver(() => scheduleSearchAnchorReport())
  searchAnchorObserver.observe(el)
  reportSearchAnchor()
}

// Double Shift to open search (only in main window)
if (!isSettingsWindow.value && !isImagePreviewWindow.value && !isSearchWindow.value && !isVoiceRuntimeWindow.value) {
  useDoubleShift(() => openSearch())
}

// Open a temporary New Chat UI. A real session is created only when the user sends the first message.
async function createNewChat() {
  sessionsStore.openNewChatDraft('New Chat')
  await nextTick()
  chatContainerRef.value?.focusInput?.()
}

// 已读水位的"人在不在场"信号(agent-im-dm.md P4)。在场 = 屏幕上的会话算读过;
// 离场时来的消息照常攒成未读,回来那一刻一次性清掉。判定本身在 sessions store,
// 这里只负责把宿主的前后台事实喂进去。
function handleWindowFocused() {
  sessionsStore.setWindowFocused(true)
}

function handleWindowBlurred() {
  sessionsStore.setWindowFocused(false)
}

function handleVisibilityChange() {
  sessionsStore.setWindowFocused(document.visibilityState === 'visible')
}

/**
 * 通知点击 → 打开那间房(agent-dm-user.md §4.3)。
 *
 * 落焦之后水位会自然转已读(`markVisibleSessionsRead` 挂在 focus 上),所以
 * 这里只负责把页签打开,一个字的水位逻辑都不写。
 */
async function openSessionFromNotification(sessionId: string): Promise<void> {
  if (!sessionId) return
  workspaceStore.openSession(sessionId)
  await sessionsStore.switchSession(sessionId)
}

let unsubscribeNotifyActivate: (() => void) | null = null
const log = getLogger('renderer.app')
const perfLog = getLogger('renderer.perf')

let unsubscribeSettingsChanged: (() => void) | null = null
let unsubscribeMenuNewChat: (() => void) | null = null
let unsubscribeMenuCloseChat: (() => void) | null = null
let unsubscribeMenuNewBrowserTab: (() => void) | null = null
let unsubscribeSearchAction: (() => void) | null = null

onMounted(async () => {
  perfLog.debug('renderer mounted', { sincePageLoadMs: Math.round(performance.now()) })
  window.addEventListener('hashchange', syncCurrentHash)
  window.addEventListener('focus', handleWindowFocused)
  window.addEventListener('blur', handleWindowBlurred)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener(TODO_PLAN_WEB_WINDOW_EVENT, handleTodoPlanWebWindowAction)
  window.addEventListener(PRACTICE_OPEN_WORKSPACE_EVENT, handlePracticeOpenWorkspace)
  window.addEventListener(AGENT_OPEN_WORKSPACE_EVENT, handleAgentOpenWorkspace)
  window.addEventListener(TRAJECTORY_OPEN_WORKSPACE_EVENT, handleTrajectoryOpenWorkspace)

  const markdownCacheReady = ensureMarkdownCacheReady().catch((e) => {
    log.warn('markdown cache init failed', {}, e)
  })
  const appStateReady = appStateApi.get({}).catch((e) => {
    log.warn('app state restore failed', {}, e)
    return null
  })

  // Load independent startup data in parallel. Voice is intentionally
  // initialized in the background so microphone state never blocks first paint.
  await Promise.all([
    sessionsStore.loadSessions(),
    settingsStore.loadSettings(),
  ])
  applyInspectorDefaultOnce()
  void voiceStore.initialize().catch((e) => {
    log.warn('voice init failed', {}, e)
  })

  // Initialize theme system (must be after settings load)
  await themeStore.initialize()

  // Restore the workspace (tabs + split layout + focus) from saved app state.
  // Must run after loadSessions: hydration validates every tab against the
  // session list. The initial session activation follows from the restored
  // active tab.
  const appState = await appStateReady
  // `workspace` / `sessionReadMarks` 在传输契约上是不透明载荷(形状归渲染层,
  // 见 `@shared/ipc/app-state.ts` 的文件头)—— 收窄就在这一处,两个 store 各自
  // 还会再校验一遍结构。
  workspaceStore.hydrate(appState as WorkspaceHydrationSource | null)
  const restoredSessionId = workspaceStore.activeSessionId
  if (restoredSessionId) {
    await sessionsStore.switchSession(restoredSessionId)
  }
  if (appState?.sidebarCollapsed !== undefined) {
    layoutPrefs.setSidebarCollapsed(appState.sidebarCollapsed)
    reserveSidebarActions.value = appState.sidebarCollapsed
  }

  // 已读水位(docs/design/agent-im-dm.md P4)。必须排在工作区恢复之后:剪枝要对着
  // 会话列表,而"屏幕上是哪几个会话"要等分栏树立起来才有答案 —— 恢复出来的那个
  // 页签用户正看着,不该带着上次的红点回来。
  //
  // 只有主窗口灌水位,因此也只有主窗口落盘(未灌 = 不写)。设置/搜索这些副窗口
  // 同样收得到全量 session 事件,却一个会话都"看不见" —— 让它们跟着写,就是拿一份
  // 只涨不消的 inbound 去盖掉主窗口刚推进的 readAt,红点会诈尸。
  if (!isAuxiliaryWindow.value) {
    sessionsStore.hydrateReadMarks(
      appState?.sessionReadMarks as PersistedSessionReadMarks | undefined,
    )
    // dock 墨点与通知点击同样只由主窗口驱动 —— 与水位「只主窗口 hydrate/落盘」
    // 同一条纪律:副窗口收得到全量事件却看不见任何会话,让它们也画徽标就是
    // 两扇窗抢着写同一个 dock。
    unsubscribeNotifyActivate = platformApi.notify?.onActivate(({ sessionId }) => {
      void openSessionFromNotification(sessionId)
    }) ?? null
    watch(
      () => sessionsStore.unreadSessionIds.size > 0,
      hasUnread => { void platformApi.notify?.setBadge(hasUnread) },
      { immediate: true },
    )
  }

  appReady.value = true
  perfLog.debug('session interactive', { sincePageLoadMs: Math.round(performance.now()) })
  void markdownCacheReady

  // Anchor element mounts with the main-app branch after appReady flips.
  await nextTick()
  setupSearchAnchorObserver()

  // Listen for settings changes from other windows (e.g., settings window)
  unsubscribeSettingsChanged = platformApi.onSettingsChanged((newSettings) => {
    log.debug('settings changed in another window')

    void (async () => {
      // Update settings and apply appearance through the same path used by
      // local saves and system theme changes.
      await settingsStore.applyAppearanceFromSettings(newSettings, {
        refreshSystemTheme: newSettings.theme === 'system',
      })

      // Per-window model metadata cache: the Settings window may have just
      // refreshed or added models. `settings.selectedModels` is synced via
      // this broadcast, but `providerModels` (the capabilities/metadata Map)
      // is local to each renderer. Drop it so the next model picker open
      // re-fetches — main has a disk cache, so the round-trip is cheap.
      settingsStore.clearModelsCache()

      // Re-build `availableProviders` from the new settings so custom providers
      // added in the Settings window appear in the main window immediately.
      settingsStore.loadProviders().catch((err) => {
        log.warn('provider refresh after settings change failed', {}, err)
      })
    })().catch((err) => {
      log.warn('settings change apply failed', {}, err)
    })
  })

  // Listen for menu shortcuts
  unsubscribeMenuNewChat = platformApi.onMenuNewChat(() => {
    createNewChat()
  })

  // ⌘W 恢复 macOS 标准语义 = 关窗口(U2,product-two-forms-chatgpt-shell.md D5)。
  // 会话没有"关闭"这回事 —— 它不是文档,退场只有归档 / 删除。
  //
  // 内嵌浏览器是本 app 里唯一还有真页签的面,所以它先要:主进程已经处理过
  // "内嵌页面本身有焦点"那一档,走到这里说明焦点在我们自己的 DOM 里
  // (omnibox / 起始页 / 页签抽屉)。
  unsubscribeMenuCloseChat = platformApi.onMenuCloseChat(() => {
    if (browserStore.panelFocused) {
      void browserStore.closeActiveTab()
      return
    }
    void platformApi.closeWindow().catch(() => {})
  })

  // Cmd+T is the browser's alone: outside the browser panel it does nothing
  // rather than quietly duplicating New Chat (⌘N).
  unsubscribeMenuNewBrowserTab = platformApi.onMenuNewBrowserTab?.(() => {
    if (browserStore.panelFocused) void browserStore.newTab()
  }) ?? null

  // Listen for search action execution from Search Everywhere window
  unsubscribeSearchAction = platformApi.onSearchAction(async (actionId: string) => {
    if (actionId.startsWith('insert-prompt:')) {
      const promptId = actionId.replace('insert-prompt:', '')
      chatContainerRef.value?.insertPromptReference?.(promptId)
      chatContainerRef.value?.focusInput?.()
      return
    }
    if (actionId.startsWith('switch-session:')) {
      const sessionId = actionId.replace('switch-session:', '')
      await sessionsStore.switchSession(sessionId)
      return
    }
    if (actionId.startsWith('split-panel:')) {
      const payload = actionId.slice('split-panel:'.length)
      const separatorIndex = payload.indexOf(':')
      if (separatorIndex > 0) {
        const panelId = payload.slice(0, separatorIndex)
        const sessionId = payload.slice(separatorIndex + 1)
        chatContainerRef.value?.splitPanel?.(panelId, sessionId)
      }
      return
    }
    if (actionId.startsWith('open-file:')) {
      const filePath = actionId.replace('open-file:', '')
      await openFileInRightWorkbench(filePath)
      return
    }
    if (actionId.startsWith('jump-message:')) {
      const payload = actionId.replace('jump-message:', '')
      const separatorIndex = payload.indexOf(':')
      if (separatorIndex >= 0) {
        const sessionId = payload.slice(0, separatorIndex)
        const messageId = payload.slice(separatorIndex + 1)
        await chatContainerRef.value?.jumpToMessage?.(sessionId, messageId)
      }
      return
    }
    switch (actionId) {
      case 'new-chat': await createNewChat(); break
      case 'open-settings': openSettingsWindow(); break
      case 'toggle-sidebar': handleSidebarToggle(); break
      case 'toggle-inspector': inspectorOpen.value = !inspectorOpen.value; break
      case 'close-chat': {
        const id = sessionsStore.currentSessionId
        if (id) await sessionsStore.deleteSession(id)
        break
      }
      case 'focus-input':
        chatContainerRef.value?.focusInput?.()
        break
    }
  })

})

onUnmounted(() => {
  if (!isAuxiliaryWindow.value) setReferenceHost(null)
  window.removeEventListener('onething:plugin-layout', handlePluginLayout)
  window.removeEventListener('onething:room-workbench', handleRoomWorkbench)
  window.removeEventListener('hashchange', syncCurrentHash)
  window.removeEventListener('focus', handleWindowFocused)
  window.removeEventListener('blur', handleWindowBlurred)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener(TODO_PLAN_WEB_WINDOW_EVENT, handleTodoPlanWebWindowAction)
  window.removeEventListener(PRACTICE_OPEN_WORKSPACE_EVENT, handlePracticeOpenWorkspace)
  window.removeEventListener(AGENT_OPEN_WORKSPACE_EVENT, handleAgentOpenWorkspace)
  window.removeEventListener(TRAJECTORY_OPEN_WORKSPACE_EVENT, handleTrajectoryOpenWorkspace)

  if (unsubscribeNotifyActivate) {
    unsubscribeNotifyActivate()
    unsubscribeNotifyActivate = null
  }
  if (unsubscribeSettingsChanged) {
    unsubscribeSettingsChanged()
  }
  if (unsubscribeMenuNewChat) {
    unsubscribeMenuNewChat()
  }
  if (unsubscribeMenuCloseChat) {
    unsubscribeMenuCloseChat()
  }
  if (unsubscribeMenuNewBrowserTab) {
    unsubscribeMenuNewBrowserTab()
  }
  if (unsubscribeSearchAction) {
    unsubscribeSearchAction()
  }
  if (searchAnchorObserver) {
    searchAnchorObserver.disconnect()
    searchAnchorObserver = null
  }
  if (searchAnchorReportTimer) {
    clearTimeout(searchAnchorReportTimer)
    searchAnchorReportTimer = null
  }
  // 浮层侧栏那四个 timer 的清场归时序机自己(`onScopeDispose`)。
})

// Theme is managed by settingsStore.applyTheme() which correctly resolves 'system' to 'light'/'dark'
// Do NOT directly set settings.theme to data-theme as 'system' is not a valid DOM value
</script>

<style scoped>
/*
 * 插件背景层(G 期,L2.5)。
 *
 * **铺的是主内容区,不是整窗** —— 这是实现中实测出来的取舍,记在这里:
 * 每一块 UI 都自带不透明底色(`--ui-surface-app-bg` / `--ui-surface-chat-bg` /
 * `--ui-surface-sidebar-bg`),一张画在最底下的图会被逐层盖死。要让它露出来,
 * 上面的面必须让路;而"让哪些面让路"如果开成全局规则,就是一次不可控的
 * 底色改造(左栏、工作台、浮层、菜单全在射程内)。
 * 于是这里**逐条枚举**,而且只枚举主内容区那一列的三层:
 *   `.app-content` → `.app-main-region` → ChatContainer 根 + ChatWindow 的
 *   `--chat-surface`(它本来就是为覆盖而设的局部变量)。
 * 左栏与右侧工作台保留自己的底色 —— 它们是"面板"语义,读文字的地方,
 * 背景图在那里只会降低可读性。
 *
 * `.app-shell` 的底色一个字不动:主窗在 mac 上是 transparent:true,
 * 把最外层弄透明就是让桌面直接透上来。
 */
.app-background-layer {
  /* 2026-08-10 起铺整窗(fixed):用户预期壁纸盖住 header 与侧栏,不只主内容区。
     挂在窗口根、z0;app-shell 激活时透明让位(body 的 --ui-surface-app-bg
     仍是不透明兜底,mac 透明窗不会漏桌面)。 */
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  /* 深浅两张图。data-theme 由 settings store 解析成 light/dark 后写死在 html 上
     （'system' 永远不会落到 DOM 上），所以这条选择器不需要 prefers-color-scheme。 */
  background-image: var(--plugin-background-image);
  background-position: center center;
  /* 纯静态:不加 transition/animation。透明窗上的逐帧合成就是掉帧本身。 */
  transition: none;
}

html[data-theme='dark'] .app-background-layer {
  background-image: var(--plugin-background-dark-image);
}

/* ══════════════════════════════════════════════════════════════════════════
   壁纸模式的表面覆盖规则**不在这里** —— 它们住在 `styles/wallpaper.css`。
   ──────────────────────────────────────────────────────────────────────────
   2026-08-10 第四轮把作用域根从 `.app-shell.has-plugin-background` /
   `.app-content.has-plugin-background` 迁到了根类 `html.has-wallpaper`
   (由本文件的 watch 挂/摘,见 script 段)。原因只有一个:菜单 / popover /
   下拉 / 会话预览卡全部 `Teleport to="body"`,是 `.app-shell` 的**兄弟**,挂在
   shell 上的 scoped 选择器永远够不着它们 —— 旧文件里那条
   `.app-shell.has-plugin-background :deep(.sidebar.floating .sidebar-content)`
   就是这么变成死码的(浮层侧栏同样在 shell 之外)。
   根类一挂,今天的浮层和明天任何新 teleport 面都自然进入体系。

   六级分级表、六个旋钮、CSS 环坑判例(为什么快照层是 `body`)、性能红线
   (backdrop-filter 只许上浮层)全部写在 `styles/wallpaper.css` 的文件头注里,
   新面进树先去那里定级。本文件只留背景层元素本身。
   ════════════════════════════════════════════════════════════════════════ */
.app-main-region {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ui-surface-app-bg);
}

.workspace-view-stack {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-surface-app-bg);
}

.workspace-view {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

/* `.sidebar-floating-backdrop` 与它的 `fadeOut` 关键帧在 L4 删除:那份 markup
   自 2026 年初起就是注释掉的死码,规则跟着躺了半年。浮层侧栏不铺遮罩 —— 它靠
   hover 进出,一层吃点击的遮罩只会让"扫过左缘顺手点聊天区"这件事失灵。 */

/* `.agent-dialog-overlay` / `.agent-dialog-container` were removed in P2: the
   markup they styled (CustomAgentDialog) had already been deleted, leaving a
   hand-rolled modal skeleton with no modal. New dialogs use
   `components/common/Dialog.vue`. */
</style>
