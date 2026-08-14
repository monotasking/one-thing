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
    <div
      v-if="sidebarFloating || sidebarFloatingClosing"
      class="app-floating-sidebar-host"
    >
      <!-- Floating sidebar overlay backdrop -->
      <!--      <div-->
      <!--        v-if="sidebarFloating"-->
      <!--        :class="['sidebar-floating-backdrop', { closing: sidebarFloatingClosing }]"-->
      <!--        @click="closeFloatingSidebar"-->
      <!--      ></div>-->

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
    </div>

    <Splitter
      class="app-shell"
      :class="{ 'is-sidebar-resizing': sidebarResizing }"
      :gap="0"
      :resizer-size="1"
      :resizer-hit-size="12"
      @resize-start="handleSidebarResizeStart"
      @resize-end="handleSidebarResizeEnd"
    >
      <SplitterPanel
        v-if="sidebarDockedVisible"
        v-model:size="sidebarWidth"
        as="aside"
        class="app-left-sidebar-region"
        size-unit="px"
        :min="MIN_SIDEBAR_WIDTH"
        :max="MAX_SIDEBAR_WIDTH"
      >
        <Sidebar
          :collapsed="false"
          :floating="false"
          :floating-closing="false"
          :no-transition="sidebarNoTransition"
          :width="sidebarWidth"
          @open-settings="openSettingsWindow"
          @toggle-collapse="handleSidebarToggle"
          @open-search="openSearch"
          @create-new-chat="createNewChat"
          @toggle-media-panel="openWorkspacePanel('media')"
          @open-workspace-panel="openWorkspacePanel"
          @select-session="selectSidebarSession"
        />
      </SplitterPanel>

      <!-- 折叠 = 整条侧栏卸下来(classic 与 workbench 同一套语义)。
           方案三曾在 workbench 下把折叠画成一条 46px 的 rail,2026-07-31 撤掉:
           macOS 的三颗交通灯横跨到窗口左起 ~70px,比 rail 还宽,于是黄绿两颗
           压在聊天区上、横跨那条竖分隔线;顶栏又按"顶到窗口左缘"死留 84px,
           没扣掉左边这 46px,标题被平白推远一截。左上角因此永远对不齐。
           五个类别入口在收起态由顶栏那组按钮 + 浮层侧栏(hover 左缘)承接。 -->

      <!-- Main Content - No Header -->
      <SplitterPanel
        flex
        class="app-shell-main-region"
        :resizable="sidebarDockedVisible"
      >
        <div
          ref="appContentRef"
          class="app-content"
        >
          <Splitter
            ref="contentSplitterRef"
            class="app-content-splitter"
            :gap="0"
            :resizer-size="1"
            :resizer-hit-size="12"
            @resize-start="inspectorResizing = true"
            @resize-end="handleInspectorResizeEnd"
          >
            <SplitterPanel
              v-model:size="mainWorkspacePanelSize"
              :min="52"
              :resizable="inspectorVisible"
            >
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
                    :sidebar-collapsed="sidebarCollapsed"
                    :sidebar-floating="sidebarFloating"
                    :show-hover-trigger="sidebarCollapsed && !sidebarFloating"
                    :is-inspector-open="inspectorOpen"
                    :reserve-sidebar-actions="reserveSidebarActions"
                    :layout-transitioning="sidebarActionAnimating"
                    @toggle-sidebar="handleSidebarToggle"
                    @open-search="openSearch"
                    @create-new-chat="createNewChat"
                    @show-floating-sidebar="handleTriggerEnter"
                    @hide-floating-sidebar="handleTriggerLeave"
                    @toggle-inspector="inspectorOpen = !inspectorOpen"
                    @open-file="openFileInRightWorkbench"
                    @review-goal="openGoalReviewInRightWorkbench"
                  />
                </div>
              </Container>
            </SplitterPanel>

            <!-- Collapsed (not unmounted) when hidden: the panel slides shut
                 symmetrically and workbench tab state survives toggles. The
                 slide wrapper freezes content at the expanded width so the
                 panel edge clips it instead of reflowing tabs every frame. -->
            <SplitterPanel
              v-if="workbenchMounted"
              as="aside"
              class="app-right-sidebar-region"
              :size="inspectorPanelSize"
              :min="inspectorMinPanelSize"
              :max="48"
              :collapsed="!workbenchRevealed"
              @update:size="handleInspectorPanelSizeUpdate"
            >
              <div
                class="workbench-slide"
                :style="workbenchSlideStyle"
              >
                <RightWorkbenchPanel
                  ref="rightWorkbenchRef"
                  :session-id="sessionsStore.currentSessionId"
                  :workspace-root="currentWorkspaceRoot"
                  :workspace-roots="currentWorkspaceRoots"
                  :revealed="workbenchRevealed"
                  @close="inspectorOpen = false"
                  @jump-to-source="handleWorkbenchJumpToSource"
                />
              </div>
            </SplitterPanel>
          </Splitter>

          <VoiceOverlay />
          <VoiceCallPanel />
        </div>
      </SplitterPanel>

      <!-- Old search overlay removed — replaced by Search Everywhere window -->
    </Splitter>
  </ErrorBoundary>

  <!-- Evals incident workbench (full-screen overlay). Rendered OUTSIDE the
       window-mode branches: the entry button lives in the Settings window,
       which renders the SettingsPage branch — an overlay confined to the
       main-app branch would never appear there. -->
  <EvalsWorkbench v-if="evalsWorkbenchStore.open" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useThemeStore } from '@/stores/themes'
import { useVoiceStore } from '@/stores/voice'
import { useShortcuts } from '@/composables/useShortcuts'
import { resolveInspectorDefaultOpen } from '@/composables/useInspectorDefault'
import { Sidebar } from '@/components/sidebar'
import ChatContainer from '@/components/ChatContainer.vue'
import Container from '@/components/common/Container.vue'
import Splitter from '@/components/common/Splitter.vue'
import SplitterPanel from '@/components/common/SplitterPanel.vue'
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
const collabBoardStore = useCollabBoardStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()
const themeStore = useThemeStore()
const voiceStore = useVoiceStore()

const appReady = ref(false)
const evalsWorkbenchStore = useEvalsWorkbenchStore()
const overlayPresenceStore = useOverlayPresenceStore()
// ⌘T/⌘W 路由要问它：面板自己的 DOM 是不是当前操作的那块（见 stores/browser.ts）。
const browserStore = useBrowserStore()
// Full-screen modal overlays float above the embedded browser's native view;
// register them so BrowserPanel hides the view while they're open (§8.2).
watch(() => evalsWorkbenchStore.open, open => overlayPresenceStore.setOverlay('evals', open))
const chatContainerRef = ref<InstanceType<typeof ChatContainer> | null>(null)
const appContentRef = ref<HTMLElement | null>(null)

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

/* 右栏开合的持久化(W-Q2)。沿用右栏自己既有的那套 —— `inspectorPanelSize`
   就住在 localStorage —— 而不是另开一条 appState 字段。 */
const INSPECTOR_OPEN_STORAGE_KEY = 'inspectorOpen'

function readStoredInspectorOpen(): boolean | null {
  try {
    const raw = localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // localStorage 不可用(隐私模式 / 测试夹具):当作没存过,走窗宽默认值。
  }
  return null
}

function writeStoredInspectorOpen(open: boolean): void {
  try {
    localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, String(open))
  } catch {
    // 存不下就算了:下次启动退回按窗宽的默认值,不影响本次使用。
  }
}

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
    stored: readStoredInspectorOpen(),
  })
}

/* 之后的每一次开合(手动点、⌘ 面板、代码里打开某个文件)都记账:下次启动
   照用户上次留下的样子,而不是把窗宽默认值再算一遍。 */
watch(inspectorOpen, open => {
  if (!inspectorDefaultApplied || isAuxiliaryWindow.value) return
  writeStoredInspectorOpen(open)
})

// Sidebar width (persisted)
const MIN_SIDEBAR_WIDTH = 200
const MAX_SIDEBAR_WIDTH = 500

function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return 300
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

const sidebarWidth = ref(clampSidebarWidth(parseInt(localStorage.getItem('sidebarWidth') || '300', 10)))
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
})


// Persist sidebar collapsed state and control traffic lights visibility
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true')
const sidebarFloating = ref(false)
const sidebarFloatingClosing = ref(false)
const sidebarNoTransition = ref(false) // Disable transition during/after floating
const sidebarDockedVisible = computed(() =>
  !sidebarCollapsed.value && !sidebarFloating.value && !sidebarFloatingClosing.value
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

const reserveSidebarActions = ref(sidebarCollapsed.value)
const sidebarActionAnimating = ref(false)
const floatingCooldown = ref(false) // Prevent re-expansion after toggle
const floatingShowTimer = ref<ReturnType<typeof setTimeout> | null>(null) // Delay before showing floating sidebar
let sidebarToggleTimer: ReturnType<typeof setTimeout> | null = null
let floatingCloseTimer: ReturnType<typeof setTimeout> | null = null
let floatingCooldownTimer: ReturnType<typeof setTimeout> | null = null
function handleSidebarResizeStart() {
  sidebarResizing.value = true
}

function handleSidebarResizeEnd() {
  sidebarWidth.value = clampSidebarWidth(sidebarWidth.value)
  sidebarResizing.value = false
  localStorage.setItem('sidebarWidth', String(sidebarWidth.value))
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
const MIN_INSPECTOR_PANEL_SIZE = 22
const MAX_INSPECTOR_PANEL_SIZE = 48
const DEFAULT_INSPECTOR_PANEL_SIZE = 32

/**
 * 右栏的**像素**下限(设计稿 `right-panel.html`:最窄 250px 是硬指标)。
 *
 * 原来的下限只有百分比 22% —— 窗口一小就破线:620px 的窗口里右栏只剩 136px,
 * 分段器还撑得住,但行被压成「I..」「服...」,信息全没了(真机走查看到的正是这个)。
 * 所以下限改成「22% 与 250px 取大」,再让 max 48% 兜底(极窄窗口下 250px 可能
 * 超过 48%,那时以 48% 为准 —— 中栏也有自己的下限,不能为了右栏把它挤没)。
 */
/* 提前声明:`clampInspectorPanelSize` 在 setup 期就被调用(初始化存档值),
   它经 `inspectorMinPanelSize` 读到这里 —— 声明晚了会 TDZ,整个 App 白屏。 */
const contentSplitterWidth = ref(0)

const MIN_INSPECTOR_PANEL_PX = 250

/* 换算基数必须是**分栏容器**的宽度,不是窗口宽度 —— 这里的百分比是相对
   `contentSplitterRef` 的(窗口还要扣掉左栏)。拿 window.innerWidth 换算会
   算出一个偏小的百分比,地板照样破(真机实测:面板仍只有 203.8px)。
   `contentSplitterWidth` 由 ResizeObserver 维护,天然跟着窗口与左栏变。 */
const inspectorMinPanelSize = computed(() => {
  const base = contentSplitterWidth.value
  const pct = base > 0 ? (MIN_INSPECTOR_PANEL_PX / base) * 100 : MIN_INSPECTOR_PANEL_SIZE
  return Math.min(MAX_INSPECTOR_PANEL_SIZE, Math.max(MIN_INSPECTOR_PANEL_SIZE, pct))
})

function clampInspectorPanelSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_INSPECTOR_PANEL_SIZE
  return Math.min(MAX_INSPECTOR_PANEL_SIZE, Math.max(inspectorMinPanelSize.value, size))
}

const storedInspectorPanelSize = ref(clampInspectorPanelSize(
  Number.parseFloat(localStorage.getItem('inspectorPanelSize') || String(DEFAULT_INSPECTOR_PANEL_SIZE))
))

/**
 * 存的是百分比,而地板是像素 —— 所以**每次读都要重新收敛**,不能只在写入时 clamp。
 * 否则窗口一变窄,存着的 25.5% 在 800px 窗口里就是 204px,250px 的地板形同虚设
 * (真机走查抓到:面板 203.82px,行被压得没法看)。
 */
const inspectorPanelSize = computed({
  get: () => Math.min(
    MAX_INSPECTOR_PANEL_SIZE,
    Math.max(inspectorMinPanelSize.value, storedInspectorPanelSize.value),
  ),
  set: (value: number) => { storedInspectorPanelSize.value = clampInspectorPanelSize(value) },
})
const inspectorResizing = ref(false)

// Mount the workbench panel on first open, then keep it mounted so closing
// only collapses it (animated) and its tab/terminal state is preserved.
// First open mounts collapsed and expands a frame later so the slide-in
// transition runs from width 0.
const workbenchMounted = ref(false)
const workbenchRevealed = ref(false)
watch(inspectorVisible, async visible => {
  if (visible && !workbenchMounted.value) {
    workbenchMounted.value = true
    await nextTick()
    // Flush layout so the collapsed style is committed as the transition's
    // starting state; otherwise the panel pops in at partial width.
    void (contentSplitterRef.value?.$el as HTMLElement | undefined)?.offsetWidth
    workbenchRevealed.value = inspectorVisible.value
    return
  }
  workbenchRevealed.value = visible
}, { immediate: true })

// The splitter reports size 0 for the collapsed panel; ignore it so the
// stored width survives close/reopen.
function handleInspectorPanelSizeUpdate(size: number) {
  if (!inspectorVisible.value) return
  inspectorPanelSize.value = clampInspectorPanelSize(size)
}

const contentSplitterRef = ref<InstanceType<typeof Splitter> | null>(null)
let contentSplitterObserver: ResizeObserver | null = null

watch(contentSplitterRef, splitter => {
  contentSplitterObserver?.disconnect()
  const el = splitter?.$el as HTMLElement | undefined
  if (!el || typeof ResizeObserver === 'undefined') return
  contentSplitterObserver ??= new ResizeObserver(entries => {
    contentSplitterWidth.value = entries[0]?.contentRect.width ?? 0
  })
  contentSplitterObserver.observe(el)
}, { flush: 'post' })

onUnmounted(() => {
  contentSplitterObserver?.disconnect()
  contentSplitterObserver = null
})

// Expanded pixel width of the workbench. While the panel collapses/expands,
// this stays constant (inspectorPanelSize is not written during the
// animation), so the content is clipped by the sliding edge instead of
// being reflowed at every frame.
const workbenchSlideStyle = computed(() => {
  if (!contentSplitterWidth.value) return undefined
  const width = Math.ceil(contentSplitterWidth.value * inspectorPanelSize.value / 100)
  return { width: `${width}px` }
})
const mainWorkspacePanelSize = computed({
  get: () => inspectorVisible.value ? 100 - inspectorPanelSize.value : 100,
  set: (size: number) => {
    if (!inspectorVisible.value) return
    inspectorPanelSize.value = clampInspectorPanelSize(100 - size)
  }
})

function handleInspectorResizeEnd() {
  inspectorResizing.value = false
  localStorage.setItem('inspectorPanelSize', String(inspectorPanelSize.value))
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

async function openFileInRightWorkbench(filePath: string) {
  if (!filePath) return
  inspectorOpen.value = true
  await nextTick()
  await rightWorkbenchRef.value?.openFile(filePath)
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

// Close floating sidebar with animation
function closeFloatingSidebar() {
  if (!sidebarFloating.value || sidebarFloatingClosing.value) return
  if (floatingCloseTimer) {
    clearTimeout(floatingCloseTimer)
    floatingCloseTimer = null
  }
  if (floatingCooldownTimer) {
    clearTimeout(floatingCooldownTimer)
    floatingCooldownTimer = null
  }
  sidebarFloatingClosing.value = true
  sidebarNoTransition.value = true
  floatingCooldown.value = true
  floatingCloseTimer = setTimeout(() => {
    sidebarFloating.value = false
    sidebarFloatingClosing.value = false
    floatingCloseTimer = null
    // Keep transition disabled a bit longer to prevent flash
    floatingCooldownTimer = setTimeout(() => {
      sidebarNoTransition.value = false
      floatingCooldown.value = false
      floatingCooldownTimer = null
    }, 300)
  }, 200) // Match animation duration
}

function keepFloatingSidebarOpen() {
  if (!sidebarFloating.value && !sidebarFloatingClosing.value) return
  if (floatingCloseTimer) {
    clearTimeout(floatingCloseTimer)
    floatingCloseTimer = null
  }
  if (floatingCooldownTimer) {
    clearTimeout(floatingCooldownTimer)
    floatingCooldownTimer = null
  }
  sidebarFloating.value = true
  sidebarFloatingClosing.value = false
  floatingCooldown.value = false
  sidebarNoTransition.value = false
}

// Handle sidebar toggle - if floating, just close floating mode
function handleSidebarToggle() {
  if (sidebarFloating.value) {
    closeFloatingSidebar()
  } else {
    const nextCollapsed = !sidebarCollapsed.value

    // Animate sidebar width and top-bar reservation as complementary offsets.
    // This keeps the tab strip from being pushed twice during expand.
    floatingCooldown.value = true
    sidebarActionAnimating.value = true
    reserveSidebarActions.value = nextCollapsed
    sidebarCollapsed.value = nextCollapsed

    if (sidebarToggleTimer) {
      clearTimeout(sidebarToggleTimer)
    }
    sidebarToggleTimer = setTimeout(() => {
      sidebarActionAnimating.value = false
      floatingCooldown.value = false
      sidebarToggleTimer = null
    }, 340)
  }
}

// Handle hover trigger enter - with delay to avoid accidental triggers
function handleTriggerEnter() {
  // Don't expand if in cooldown period (after toggle or close)
  if (sidebarFloatingClosing.value || floatingCooldown.value) return

  // Clear any existing timer
  if (floatingShowTimer.value) {
    clearTimeout(floatingShowTimer.value)
  }

  // Add 200ms delay before showing floating sidebar
  floatingShowTimer.value = setTimeout(() => {
    sidebarNoTransition.value = true
    sidebarFloating.value = true
    floatingShowTimer.value = null
  }, 200)
}

// Handle hover trigger leave - cancel pending show
function handleTriggerLeave() {
  if (floatingShowTimer.value) {
    clearTimeout(floatingShowTimer.value)
    floatingShowTimer.value = null
  }
}

// Close floating mode when sidebar is expanded permanently
watch(sidebarCollapsed, (collapsed) => {
  if (!sidebarActionAnimating.value) {
    reserveSidebarActions.value = collapsed
  }
  if (!collapsed) {
    sidebarFloating.value = false
  }
})

// Persist sidebar collapsed state and always show traffic lights
watch([sidebarCollapsed, sidebarFloating], ([collapsed]) => {
  localStorage.setItem('sidebarCollapsed', String(collapsed))
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
  const el = appContentRef.value
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
  const el = appContentRef.value
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
let unsubscribeSettingsChanged: (() => void) | null = null
let unsubscribeMenuNewChat: (() => void) | null = null
let unsubscribeMenuCloseChat: (() => void) | null = null
let unsubscribeMenuNewBrowserTab: (() => void) | null = null
let unsubscribeSearchAction: (() => void) | null = null

onMounted(async () => {
  console.info(`[Perf][Startup] renderer-mounted +${Math.round(performance.now())}ms since page load`)
  window.addEventListener('hashchange', syncCurrentHash)
  window.addEventListener('focus', handleWindowFocused)
  window.addEventListener('blur', handleWindowBlurred)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener(TODO_PLAN_WEB_WINDOW_EVENT, handleTodoPlanWebWindowAction)
  window.addEventListener(PRACTICE_OPEN_WORKSPACE_EVENT, handlePracticeOpenWorkspace)
  window.addEventListener(AGENT_OPEN_WORKSPACE_EVENT, handleAgentOpenWorkspace)
  window.addEventListener(TRAJECTORY_OPEN_WORKSPACE_EVENT, handleTrajectoryOpenWorkspace)

  const markdownCacheReady = ensureMarkdownCacheReady().catch((e) => {
    console.warn('[App] markdown cache init failed', e)
  })
  const appStateReady = platformApi.getAppState().catch((e) => {
    console.warn('[App] Failed to restore app state:', e)
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
    console.warn('[App] voice init failed', e)
  })

  // Initialize theme system (must be after settings load)
  await themeStore.initialize()

  // Restore the workspace (tabs + split layout + focus) from saved app state.
  // Must run after loadSessions: hydration validates every tab against the
  // session list. The initial session activation follows from the restored
  // active tab.
  const appState = await appStateReady
  workspaceStore.hydrate(appState)
  const restoredSessionId = workspaceStore.activeSessionId
  if (restoredSessionId) {
    await sessionsStore.switchSession(restoredSessionId)
  }
  if (appState?.sidebarCollapsed !== undefined) {
    sidebarCollapsed.value = appState.sidebarCollapsed
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
    sessionsStore.hydrateReadMarks(appState?.sessionReadMarks)
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
  console.info(`[Perf][Startup] session-interactive +${Math.round(performance.now())}ms since page load`)
  void markdownCacheReady

  // Anchor element mounts with the main-app branch after appReady flips.
  await nextTick()
  setupSearchAnchorObserver()

  // Listen for settings changes from other windows (e.g., settings window)
  unsubscribeSettingsChanged = platformApi.onSettingsChanged((newSettings) => {
    console.log('[App] Settings changed from another window')

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
        console.warn('[App] Failed to refresh providers after settings change:', err)
      })
    })().catch((err) => {
      console.warn('[App] Failed to apply settings change:', err)
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
  if (floatingShowTimer.value) {
    clearTimeout(floatingShowTimer.value)
    floatingShowTimer.value = null
  }
  if (sidebarToggleTimer) {
    clearTimeout(sidebarToggleTimer)
    sidebarToggleTimer = null
  }
  if (floatingCloseTimer) {
    clearTimeout(floatingCloseTimer)
    floatingCloseTimer = null
  }
  if (floatingCooldownTimer) {
    clearTimeout(floatingCooldownTimer)
    floatingCooldownTimer = null
  }
})

// Theme is managed by settingsStore.applyTheme() which correctly resolves 'system' to 'light'/'dark'
// Do NOT directly set settings.theme to data-theme as 'system' is not a valid DOM value
</script>

<style scoped>
.app-shell {
  --app-sidebar-transition-duration: var(--duration-slow);
  --app-sidebar-transition-ease: var(--ease-default);
  /* 区域之间的接缝线。窗口边框不归任何人画 —— 交给系统投影收口。 */
  --app-seam-line: color-mix(in srgb, var(--ui-border-subtle-border) 52%, transparent);

  height: 100%;
  width: 100%;
  /* 判过不接 `surface="app"` 档(自绘 UI 收敛波 6·批 1,2026-08-11)——
     本文件四处区域根(.app-shell / .app-content / .app-main-region /
     .workspace-view-stack)是同一条判决,理由与 G7-1 判 `.sidebar` 不接同型:

     · 非壁纸态迁过来确实零变化(同一枚 token,只是改由档位画);
     · 壁纸态下四处已由 A 级·让位整张透明化(wallpaper.css `html.has-wallpaper
       .app-shell` / `.app-content, .app-main-region, .workspace-view-stack`),
       档位画的底压根到不了眼前 —— 迁移买不到壁纸参与度;
     · 而盖章的**副作用**是真的:B 级通用规则
       `html.has-wallpaper .app-surface[data-surface='app']` 会把
       `--ui-surface-app-bg` 就地稀释成 18% 的纱,并按继承落到整棵子树。
       本波实测这枚 token 在 renderer 里有 **91 处**消费、约 45 个文件,其中
       Link / BorderBox / BreadcrumbItem / Dialog 的
       `box-shadow: 0 0 0 2px var(--ui-surface-app-bg)` 是**焦点环的实色垫底**,
       Progress / RoomSurface 拿它当**反色文字**,todo-popover 拿它当浮层底 ——
       稀释成纱等于焦点环透明、反色文字透明。

     wallpaper.css 的 app 档预写注里那句"第一个住户进档前必须先量一遍它的子树"
     就是这件事;这里是量完的结论。

     ── G8-c 复审(2026-08-11):**判决转正,四根永远具名** ────────────────────
     波 6 留的口子是"等 G8 让 app 档不再是整棵树都在读的那一枚"。G8 复审时认真
     评估过那条路 —— **区域 ink 中介层**:再造一枚 `--ui-region-app-bg:
     var(--ui-surface-app-bg)`,区域根只画中介,B 级只稀释中介、不动原 token,
     91 处消费(焦点环垫底 / 反色文字)就都不受影响。判不做,两条理由:

     · **买不到东西**:这四根在壁纸下是 A 级·让位(整张透明),中介层稀释了也
       画不到眼前 —— 波 6 量的那句"迁移买不到壁纸参与度"对中介层同样成立。
     · **代价不是零风险**:四档要各配一枚中介(app/panel/chat/elevated),每个
       区域根的 CSS 都要改引中介,而"面 token 与中介 token 长得一样、该引哪个"
       这个新坑会长期在场。为一个当前住户为零的收益造两套平行 token,是把
       G7 刚终结的枚举制换成一张更难维护的对照表。

     所以:根级大区**不进档位表**,壁纸下由 A 级·让位承担(那才是它们该有的
     处理 —— 根级大区没有"自己的底色"要保,它们的活是让路)。档位表继续只服务
     "有自己的面、且要被壁纸认出来"的区域根。这条判决与 `.sidebar` 的 G8-b 判决
     (不并档、永久具名)是同一条:**能被档位表收的是面,不是根,也不是态**。 */
  background: var(--ui-surface-app-bg);
}

.app-shell :deep(.app-shell-body),
.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-body),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-body),
.app-shell :deep(.app-main-content-region) {
  min-width: 0;
  min-height: 0;
}

.app-shell :deep(.app-shell-body),
.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-body),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-body),
.app-shell :deep(.app-main-content-region) {
  height: 100%;
}

.app-shell :deep(.app-left-sidebar-region),
.app-shell :deep(.app-right-sidebar-region) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/*
 * 接缝归邻居画,而不是归中间的聊天面板画。
 *
 * 左栏 region 只在 sidebarDockedVisible 时才进 DOM,右栏 region 收起时挂
 * is-collapsed(宽度 0)—— 两者都做到了"邻居不在,线就不在",所以线永远落在
 * 两块内容之间,绝不会跑到窗口边上去跟系统投影叠成一条粗边。
 * 全局 box-sizing: border-box,这 1px 不会把面板挤宽。
 */
.app-shell :deep(.app-left-sidebar-region) {
  border-right: 1px solid var(--app-seam-line);
}

.app-shell :deep(.app-right-sidebar-region:not(.is-collapsed)) {
  border-left: 1px solid var(--app-seam-line);
}

.app-shell :deep(.app-shell-main-region),
.app-shell :deep(.app-content-main-region),
.app-shell :deep(.app-main-content-region) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-shell :deep(.app-left-sidebar-region > .sidebar) {
  flex: 1 1 auto;
  height: 100%;
}

.app-shell :deep(.app-left-sidebar-region) {
  /* Keep layout width discrete; animating it relayouts the full message list every frame. */
  transition: none;
}

.app-shell.is-sidebar-resizing :deep(.app-left-sidebar-region) {
  transition: none;
}

/* Main Content - Full height, horizontal layout */
.app-content {
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--ui-surface-app-bg);
}

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

.app-content-splitter {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.app-right-sidebar-region {
  position: relative;
}

.workbench-slide {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* Hide only after the slide-out finishes; reappear instantly on expand. */
.app-right-sidebar-region.is-collapsed .workbench-slide {
  visibility: hidden;
  transition: visibility 0s linear var(--duration-normal);
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

/* Floating sidebar backdrop */
.sidebar-floating-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: calc(var(--z-sidebar) - 1); /* just below the floating sidebar itself */
  animation: fadeIn 0.2s ease forwards;
  /* Optimize rendering */
  contain: strict;
  will-change: opacity;
}

.sidebar-floating-backdrop.closing {
  animation: fadeOut 0.2s ease forwards;
}

html[data-theme='light'] .sidebar-floating-backdrop {
  background: rgba(0, 0, 0, 0.15);
}

@keyframes fadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}

/* `.agent-dialog-overlay` / `.agent-dialog-container` were removed in P2: the
   markup they styled (CustomAgentDialog) had already been deleted, leaving a
   hand-rolled modal skeleton with no modal. New dialogs use
   `components/common/Dialog.vue`. */
</style>
