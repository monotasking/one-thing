<template>
  <Container
    as="aside"
    main-as="div"
    class="right-workbench"
    surface="panel"
    body-class="right-workbench-body"
    main-class="right-workbench-main"
    full-height
    overflow="hidden"
    main-overflow="hidden"
    @keydown.esc="pickerOpen = false"
  >
    <!-- 页签选择器(波 4):锚在 Tabs 的 "+" 钮上,坐标 / 翻转 / 视口钳制 /
         外点 / Esc 由 Popover 内核给。此前它是画在工作台里的绝对定位面
         (`top: 38px; right: 8px`),而工作台是 `overflow: hidden` —— 面板窄时
         这张 220px 的选择器会被自己的容器切掉。 -->
    <Popover
      :open="pickerOpen && openTabs.length > 0"
      :anchor="tabAddEl"
      placement="bottom-end"
      :offset="6"
      surface="elevated"
      class="workbench-tab-picker-surface"
      :close-on="PICKER_CLOSE_ON"
      @update:open="value => (pickerOpen = value)"
    >
      <div
        class="workbench-tab-picker"
        @mousedown.stop
      >
        <template
          v-for="option in availableTabOptions"
          :key="option.key"
        >
          <!-- 两个域之间画一道分隔:上面是这次会话的工具,下面是跨会话的工作区
               面板。与页签条上那道竖线说的是同一件事。 -->
          <div
            v-if="option.key === firstWorkspaceOptionKey && hasSessionOption"
            class="picker-separator"
            role="separator"
          />
          <Button
            unstyled
            class="picker-option"
            :style="workbenchToolStyle(option.categorySlot)"
            @click="onPickOption(option)"
          >
            <component
              :is="option.icon"
              :size="15"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span>{{ option.title }}</span>
          </Button>
        </template>
      </div>
    </Popover>

    <Button
      v-if="!openTabs.length"
      unstyled
      class="workbench-close is-floating"
      aria-label="Close workbench"
      @click="$emit('close')"
    >
      <X
        :size="14"
        :stroke-width="2"
        aria-hidden="true"
      />
    </Button>

    <Tabs
      v-if="openTabs.length"
      ref="tabsRef"
      v-model="activeTabId"
      class="right-workbench-tabs"
      addable
      @tab-add="togglePicker"
      @tab-remove="closeWorkbenchTab"
    >
      <template #actions>
        <Button
          unstyled
          class="workbench-close"
          aria-label="Close workbench"
          @click="$emit('close')"
        >
          <X
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </Button>
      </template>

      <TabPane
        v-for="tab in openTabs"
        :key="tab.id"
        :name="tab.id"
        :label="tab.title"
        :closable="isTabClosable(tab)"
        :order="tab.type === 'workspace' ? 1 : 0"
        lazy
      >
        <template #label>
          <span
            class="workbench-tab-label"
            :class="{
              'has-fixed-label': FIXED_LABEL_TABS.has(tab.type),
              'is-workspace-tab': tab.type === 'workspace',
              'is-segment-start': tab.id === segmentStartTabId,
            }"
            :style="workbenchToolStyle(tabCategorySlot(tab.type))"
          >
            <component
              :is="tabIconFor(tab)"
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
            <span>{{ tabDisplayTitle(tab) }}</span>
            <!-- 状态点:有没有,不是几个(计数一律不显示)。只有这间房的固定
                 页签才画 —— 它说的是"这间房现在有事",别的页签没有这回事。 -->
            <i
              v-if="tabDot(tab)"
              class="workbench-tab-dot"
              :class="`is-${tabDot(tab)}`"
              aria-hidden="true"
            />
          </span>
        </template>

        <EditorWorkbench
          v-if="tab.type === 'files' || tab.type === 'file'"
          :workspace-root="tab.workspaceRoot || workspaceRoot"
          :initial-file-path="tab.filePath"
          :active="activeTabId === tab.id"
          @open-file="openFile"
        />

        <GoalReviewWorkbench
          v-else-if="tab.type === 'review'"
          :key="`${tab.id}-${tab.reviewNonce ?? 0}`"
          :session-id="tab.sessionId || sessionId"
          @open-file="openFile"
          @objective-resolved="(objective) => renameReviewTab(tab.id, objective)"
        />

        <TerminalView
          v-else-if="tab.type === 'terminal' && tab.terminalId"
          class="workbench-terminal"
          :terminal-id="tab.terminalId"
          @restarted="(newId) => handleTerminalRestarted(tab.id, newId)"
        />

        <!-- WebContentsView 是**原生层**:DOM 被 display:none 藏起来它照样画在
             最上面,所以收不收由右栏自己的展开态说了算(页签之间的切换由
             `active` 管)。 -->
        <BrowserPanel
          v-else-if="tab.type === 'browser' && canUseEmbeddedBrowser"
          :active="activeTabId === tab.id"
          :revealed="props.revealed"
        />

        <!-- 看板 = 既有的 `CollabBoardPanel`:预算 / 冻结 / **群 folder** 都在它
             身上,而群 folder 那颗按钮正是 `collab-open-folder` 的发端(走查 F2)。
             它自己顺着当前会话解析房间,所以不吃 prop。 -->
        <CollabBoardPanel v-else-if="tab.type === 'board'" />

        <!-- 这间房的调度页(D8 §4.2):租约 / 举手 / 裁决 / 时间轴。 -->
        <RoomSchedulePanel
          v-else-if="tab.type === 'schedule'"
          :key="`schedule-${tab.sessionId || ''}`"
          :room-session-id="tab.sessionId || ''"
          :initial-filter="tab.scheduleFilter || ''"
          :landing-nonce="tab.scheduleNonce ?? 0"
        />

        <!-- 调度**总览**(D8 §4.5):四个必答问题里的第三个 ——「整个系统在忙
             什么」。它不属于任何一间房,所以是 picker 里可加的一条,与上面那条
             按房的「调度」各是各的。 -->
        <SchedulingOverviewWorkbench
          v-else-if="tab.type === 'scheduling'"
          @open-session="openSessionTab"
          @open-agent="(agentId: string) => openAgentTab(agentId)"
        />

        <!-- 线程是**两层**:这间房的执行会话列表 → 选中 → 该会话详情
           (详情是 `ThreadChatDetail` = 既有聊天 UI,由这层壳就地渲染,不新开页签)。

           **不挂 `:key`**:这一格的房 id 会被子组件的 `focus` 回填(只带一条执行
           会话进来时由 `collab.roomSessionId` 现查),挂 key 就会在回填的那一拍
           把自己重建掉。里面两层的落座本来就是 watch 出来的,不需要重建。

           `grouped` 跟着"知不知道房"走:知道房才画协调器状态条与分段(那两样
           都以房为单位),而状态条正是「去看这间房的调度页」那颗红点的发端。 -->
        <RoomThreadsWorkbench
          v-else-if="tab.type === 'thread'"
          :room-session-id="tab.sessionId || ''"
          :focus-session-id="tab.threadSessionId || ''"
          :grouped="!!tab.sessionId"
          :back-to="tab.sessionId ? '线程' : undefined"
          @focus="(payload) => setThreadFocus(tab.id, payload)"
          @open-file="openFile"
          @title-resolved="(title) => renameThreadTab(tab.id, title)"
        />

        <MembersWorkbench
          v-else-if="tab.type === 'members'"
          :key="`members-${tab.sessionId || ''}`"
          :session-id="tab.sessionId || ''"
          :focus-agent-id="tab.memberAgentId || ''"
          :focus-tab="tab.detailTab || null"
          @focus="(agentId) => setMembersFocus(tab.id, agentId)"
          @open-session="openSessionTab"
          @open-file="openFile"
          @open-thread="openThread"
        />

        <!-- 「这个人」的页签:房外的人(直聊助理 / 已退休同事)落在这里。 -->
        <AgentSpace
          v-else-if="tab.type === 'agent'"
          :agent-id="tab.agentId || ''"
          :initial-tab="tab.detailTab || null"
          @open-session="openSessionTab"
          @open-file="openFile"
          @open-thread="openThread"
        />

        <!-- 插件面板作为工作台 tab(H1)。内容渲染**复用**既有 PluginPanelHost
             的双形态(描述树 / webview),右栏不新造渲染。面板对象顺着当前插件
             清单现查 —— 停用/卸载后 `pluginPanelFor` 落空,那条 tab 也已被
             `watch(pluginPanels)` 关掉(拆除即关,见下)。 -->
        <PluginPanelHost
          v-else-if="tab.type === 'plugin' && pluginPanelFor(tab)"
          :panel="pluginPanelFor(tab)!"
        />

        <!-- ── 工作区域(右域):内置面板 ───────────────────────────────────
             P1 之前它们住在 `MediaPanel.vue` —— 一个自带顶部导航、把聊天区整个
             盖住的全屏容器。那个容器已经拆除:面板改成工作台的一条页签,于是
             「一边看面板一边看会话」第一次成立,而且切会话不再把面板关掉。
             `TabPane lazy` 就是从前那份手工 `mountedNavs` keep-alive 的等价物。

             K1(内核收缩):这里从前是**一条按 panelId 逐个点名的 v-else-if 链**
             —— 加一个面板就要回到这个文件补一格,而"补漏一格"正是面板注册表
             当初被建出来要根治的失效模式(只是从清单挪到了分发)。现在组件、
             要注入的上下文、宿主接哪几个事件全部写在 descriptor 上,工作台
             不再需要知道有哪几个面板。

             prop / 事件按**声明**给:无脑全给会把 `active` 落进不声明它的面板的
             attrs(根节点上凭空多个属性),无条件绑 `@close` 会让根组件(多数
             面板的根是 PanelShell)自己发的同名事件穿透上来关错页签。 -->
        <component
          :is="workspacePanelEntry(tab)?.component"
          v-else-if="tab.type === 'workspace' && workspacePanelEntry(tab)?.component"
          v-bind="workspacePanelContext(tab)"
          @close="onWorkspacePanelClose(tab)"
          @jump-to-source="onWorkspacePanelJumpToSource(tab, $event)"
        />

        <!-- iframe fallback: apps/web host has no WebContentsView -->
        <section
          v-else-if="tab.type === 'browser'"
          class="workbench-browser"
        >
          <form
            class="browser-toolbar"
            @submit.prevent="navigateBrowser"
          >
            <Globe2
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
            <input
              v-model="browserInput"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="localhost:3000"
            >
            <Button
              unstyled
              class="browser-go"
              native-type="submit"
              :disabled="!browserInput.trim()"
            >
              <ArrowRight
                :size="14"
                :stroke-width="2"
                aria-hidden="true"
              />
            </Button>
          </form>
          <iframe
            v-if="browserUrl"
            class="browser-frame"
            :src="browserUrl"
            title="Workbench browser"
          />
          <div
            v-else
            class="workbench-empty-state compact"
          >
            Open a local page
          </div>
        </section>
      </TabPane>
    </Tabs>

    <div
      v-else
      class="workbench-empty-state empty-root"
    >
      <div class="workbench-empty-copy">
        <span class="workbench-empty-title">Workbench</span>
        <span class="workbench-empty-hint">Open a tool alongside the chat.</span>
      </div>
      <Button
        v-for="option in availableTabOptions"
        :key="option.key"
        unstyled
        class="empty-action"
        :style="workbenchToolStyle(option.categorySlot)"
        @click="onPickOption(option)"
      >
        <component
          :is="option.icon"
          :size="15"
          :stroke-width="2"
          aria-hidden="true"
        />
        <span>{{ option.title }}</span>
      </Button>
    </div>
  </Container>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from 'vue'
import { ArrowRight, ClipboardList, FileText, Files, GitCompare, Globe2, ListTree, Radar, Terminal, UserRound, Users, X } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Container from '@/components/common/Container.vue'
import Popover from '@/components/common/Popover.vue'
import Tabs from '@/components/common/Tabs.vue'
import TabPane from '@/components/common/TabPane.vue'
import EditorWorkbench from '@/components/editor/EditorWorkbench.vue'
import TerminalView from '@/components/terminal/TerminalView.vue'
import BrowserPanel from './browser/BrowserPanel.vue'
import CollabBoardPanel from './CollabBoardPanel.vue'
import SchedulingOverviewWorkbench from './SchedulingOverviewWorkbench.vue'
import GoalReviewWorkbench from './GoalReviewWorkbench.vue'
import MembersWorkbench from './MembersWorkbench.vue'
import AgentSpace from '@/components/agents/AgentSpace.vue'
import RoomThreadsWorkbench from './RoomThreadsWorkbench.vue'
import RoomSchedulePanel from './RoomSchedulePanel.vue'
import PluginPanelHost from '@/components/plugins/PluginPanelHost.vue'
// K1:七个面板本体的 import 随内容分发一起搬进了 `panel-registry`
// —— 工作台不再逐个点名,组件从 descriptor 上取。
import {
  PLUGIN_PANEL_ICON,
  findWorkspacePanel,
  parsePluginPanelNavId,
  pluginPanelNavId,
  usePluginWorkspacePanels,
  useWorkspaceFeaturePanels,
  type WorkspaceNavId,
  type WorkspacePanelEntry,
} from '@/workspace/panel-registry'
import type { PluginWorkspacePanel } from '@/workspace/plugin-panel-types'
import { useEditorWorkspace } from '@/composables/useEditorWorkspace'
import { useTerminalsStore } from '@/stores/terminals'
import { useAgentsStore, type AgentDetailTab } from '@/stores/agents'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspaceStore } from '@/stores/workspace'
import { useChatStore } from '@/stores/chat'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { isUserDmRoom } from '@onething/runtime/collab'
import { hasRunningRoomThread } from './room-threads'
import { hasRoomBoardAwaiting } from './room-board'
import { OPEN_ROOM_SCHEDULE_EVENT, type OpenRoomScheduleDetail } from './room-schedule'
import {
  buildRoomFixedTabs,
  pickRoomFixedTab,
  resolveRoomPanelTarget,
  ROOM_TAB_LABELS,
  type RoomFixedTab,
  type RoomFixedTabType,
  type RoomPanelTarget,
  type RoomTabDot,
} from './room-tabs'
import type { TabPaneName } from '@/components/common/tabs'
import type { ContextVariable } from '@/types'
import { platformApi } from '@/platform'

type WorkbenchTabType = 'files' | 'file' | 'terminal' | 'browser' | 'review' | 'board' | 'thread' | 'members' | 'agent' | 'schedule' | 'scheduling' | 'plugin' | 'workspace'

interface WorkbenchTab {
  id: string
  type: WorkbenchTabType
  title: string
  filePath?: string
  workspaceRoot?: string
  /**
   * review / thread / members tabs only: the session this tab is bound to.
   * thread tabs 上这一格是**房间会话**(列表层的地基),不是那次执行 ——
   * 执行会话在 `threadSessionId`。
   */
  sessionId?: string
  /** thread tabs only: 下钻到的那条执行会话('' = 停在列表层)。 */
  threadSessionId?: string
  /** members tabs only: the member whose space page is drilled into ('' = 列表)。 */
  memberAgentId?: string
  /** agent tabs only: 这一页是谁的空间。 */
  agentId?: string
  /** agent / members tabs only: 进来先停在哪一面。 */
  detailTab?: AgentDetailTab | null
  /** review tabs only: bumped to force a refetch on reopen. */
  reviewNonce?: number
  /** terminal tabs only: the PTY instance rendered by this tab. */
  terminalId?: string
  /** schedule tabs only: 时间轴过滤('' = 全部;死信红点跳过来时是 'dead-letter')。 */
  scheduleFilter?: string
  /** schedule tabs only: 每收到一次落座指令 +1 —— 同一个过滤器也要能重放。 */
  scheduleNonce?: number
  /** plugin tabs only(H1):这一格渲染哪个插件的哪个面板(复用 PluginPanelHost 双形态)。 */
  pluginId?: string
  /**
   * plugin tabs(H1):面板 id(与 manifest 的 contributes.panels[].id 一致)。
   * workspace tabs(P1):内置工作区面板的 nav id(media / agents / …),
   * 取自 `panel-registry` —— 这一格就是这条页签的**单例键**。
   */
  panelId?: string
}

const props = withDefaults(defineProps<{
  sessionId: string
  workspaceRoot?: string
  workspaceRoots?: string[]
  /** Whether the workbench panel is expanded — drives embedded-browser view visibility. */
  revealed?: boolean
}>(), {
  revealed: true,
})

const emit = defineEmits<{
  close: []
  /** Media 的「跳到来源消息」——落点在 App.vue(它持有 ChatContainer 的 ref)。 */
  'jump-to-source': [payload: { sessionId: string; messageId: string }]
}>()

// ── 这一面对着哪一间房 ────────────────────────────────────────────────────
//
// 右栏只有**一套**面板系统:工作台页签。进房时它多备一组固定页签(线程 / 成员 /
// 看板 / 调度),其余照旧按需加(Files/Terminal/Browser/文件/评审/空间…)。
// 判定是一个纯函数(`resolveRoomPanelTarget`),这里只把当前会话喂给它。
//
// 勘误(2026-08-04):这里从前是"两形态"分岔 —— 房里画 `RoomBackstagePanel`,
// 其余画页签。两套并存的代价是房里**够不着页签那一层**,往页签里加的东西在房里
// 永远看不见(走查 F2 的群 folder 就是这么丢的)。背台已整体退役。
const sessionsStore = useSessionsStore()
const currentSession = computed(() =>
  sessionsStore.sessions.find(session => session.id === props.sessionId))

const roomTarget = computed<RoomPanelTarget>(() => resolveRoomPanelTarget({
  session: currentSession.value,
  // 形态判定单一收口:`isUserDmRoom` 是产品层纯规则(人数即形态),不自写第二份。
  isUserDm: session => isUserDmRoom(session.room),
}))

/**
 * 四枚状态点(有没有,不是几个)。
 *
 * store 是**在这里现取**的:没有房时整块 computed 根本不求值,于是直聊/工程面
 * 下这个面板照旧不碰 chat / collabBoard 两个 store(它们各自拖着一棵大树)。
 */
const roomSignals = computed(() => {
  const roomSessionId = roomTarget.value.roomSessionId
  if (!roomSessionId) return {}

  const chatStore = useChatStore()
  const collabBoardStore = useCollabBoardStore()
  const room = sessionsStore.sessions.find(item => item.id === roomSessionId)?.room

  return {
    threadsRunning: hasRunningRoomThread({
      roomSessionId,
      sessions: sessionsStore.sessions,
      isRunning: sessionId => chatStore.isSessionGenerating(sessionId),
    }),
    boardAwaiting: hasRoomBoardAwaiting({
      tasks: collabBoardStore.boardFor(roomSessionId)?.tasks ?? [],
      awaitingPermission: workSessionId => collabBoardStore.hasPendingAsk(workSessionId),
    }),
    // 成员点 = 有成员的私聊未读。翻译只有一步(agent → TA 的私聊房),未读判定
    // 仍是 store 那一处 `isUnreadSession` —— 与侧栏联系人行同一条链路。
    membersUnread: (room?.memberAgentIds ?? []).some(agentId => {
      const dmRoom = sessionsStore.findUserDmRoom(agentId)
      return !!dmRoom && sessionsStore.isUnreadSession(dmRoom.id)
    }),
    scheduleFaulted: (collabBoardStore.coordinatorFor(roomSessionId)?.deadLetterCount ?? 0) > 0,
  }
})

/** 这间房该有哪几条固定页签(格数只由形态决定,与内容无关)。 */
const roomFixedTabs = computed<RoomFixedTab[]>(() => (
  roomTarget.value.roomSessionId
    ? buildRoomFixedTabs({ isDm: roomTarget.value.isDm, signals: roomSignals.value })
    : []
))

/**
 * 页签上那颗点。只有**绑着当前这间房**的固定页签才画 —— 一条绑着别的房的
 * 线程页签(从直聊里点活卡片进来的)不该替这间房报信号。
 */
function tabDot(tab: WorkbenchTab): RoomTabDot | null {
  const roomSessionId = roomTarget.value.roomSessionId
  if (!roomSessionId || tab.sessionId !== roomSessionId) return null
  return roomFixedTabs.value.find(fixed => fixed.type === tab.type)?.dot ?? null
}

/** 房的固定页签组(单例、固定短标签、不可从 picker 加)。 */
const ROOM_FIXED_TAB_TYPES = new Set<WorkbenchTabType>(['thread', 'members', 'board', 'schedule'])

/** 固定短标签(不参与截断):房的四条 + 调度总览。 */
const FIXED_LABEL_TABS = new Set<WorkbenchTabType>(['thread', 'members', 'board', 'schedule', 'scheduling'])

const tabOptions: Array<{
  type: WorkbenchTabType
  title: string
  icon: Component
  categorySlot: number
}> = [
  { type: 'files', title: 'Files', icon: Files, categorySlot: 5 },
  { type: 'terminal', title: 'Terminal', icon: Terminal, categorySlot: 6 },
  { type: 'browser', title: 'Browser', icon: Globe2, categorySlot: 7 },
  { type: 'board', title: '看板', icon: ClipboardList, categorySlot: 8 },
  // 调度总览与看板同一条能力闸(collabRooms):没有房间就没有调度可看。
  // 叫「调度总览」而不是「调度」:房的固定组里已经有一条按房的「调度」,两条
  // 同名页签并排时用户分不出哪条是哪条 —— 总览是跨房的那一本。
  { type: 'scheduling', title: '调度总览', icon: Radar, categorySlot: 8 },
]

const pickerOpen = ref(false)
/** 选择器锚在 Tabs 的 "+" 钮上(Tabs 把它 expose 出来,见那里的注)。 */
const tabsRef = ref<{ addButtonRef: HTMLElement | null } | null>(null)
const tabAddEl = computed(() => tabsRef.value?.addButtonRef ?? null)
/** 冻结:prop 身份每渲染一次就换会让内核白跑一遍绑定。 */
const PICKER_CLOSE_ON = Object.freeze({ esc: true, outside: true, scroll: false })
const openTabs = ref<WorkbenchTab[]>([])
const activeTabId = ref('')
const filesWorkspaceRoot = ref('')
const variableWorkspaceRoots = ref<string[]>([])
const noteWorkspaceRoots = ref<string[]>([])
const browserInput = ref('localhost:3000')
const browserUrl = ref('')
const terminalsStore = useTerminalsStore()
// Per-access read so host-stubbing tests keep working.
const canUseTerminal = computed(() => platformApi.capabilities.terminal)
const canUseEmbeddedBrowser = computed(() => platformApi.capabilities.embeddedBrowser)
const canUseCollabRooms = computed(() => platformApi.capabilities.collabRooms)

// 插件面板清单(H1):与主工作区 MediaPanel 吃**同一份**(usePluginWorkspacePanels)。
// 停用/卸载的插件会从这份清单里消失 —— 「+」菜单的插件条随之消失,已开的插件
// tab 由下方 watch 关掉(拆除即关)。
const pluginPanels = usePluginWorkspacePanels()

interface WorkbenchTabOption {
  /** 唯一键(静态项 = type;面板项 = nav id / plugin:<id>:<panel>)。 */
  key: string
  type: WorkbenchTabType
  title: string
  icon: Component
  categorySlot: number
  /** 哪个域 —— 「+」菜单据此在两段之间画分隔,与页签条上那道竖线同一件事。 */
  domain: 'session' | 'workspace'
  /** 插件项才有 —— 点击时据此开一个 plugin tab。 */
  pluginId?: string
  /** 面板项才有:插件面板 id,或内置工作区面板的 nav id。 */
  panelId?: string
}

/**
 * 插件贡献的面板 —— 「+」菜单里可加的那几条。
 *
 * **不按 `placements` 过滤(P1)**:主工作区容器已经拆除,工作台是面板唯一的
 * 落点,再按声明过滤等于让缺省 `['workspace']` 的插件面板一个入口都不剩。
 * (`placements` 仍有一个真消费者 —— 插件布局动词的自荐闸,见 panel-registry。)
 * 图标由宿主统一给(Puzzle),UI 不执行插件代码。
 */
const workbenchPluginOptions = computed<WorkbenchTabOption[]>(() =>
  pluginPanels.value.map(panel => ({
    key: pluginPanelNavId(panel.pluginId, panel.panelId),
    type: 'plugin' as const,
    title: panel.label,
    icon: PLUGIN_PANEL_ICON,
    categorySlot: 5,
    domain: 'workspace' as const,
    pluginId: panel.pluginId,
    panelId: panel.panelId,
  })),
)

/**
 * 内置工作区面板 —— 右域那几条,清单**从注册表派生**(手抄一份就是下一次漂移
 * 的起点,那正是注册表存在的理由)。已经开着的不再列:它们是单例,列出来只会
 * 让人以为能开第二个。
 *
 * K1 起这份清单是**响应式**的:注册表可注册可注销,注销一个面板等于它从这条
 * 「+」清单里消失。从前它是一个编译期常量数组,注销这回事根本表达不出来。
 */
const workspaceFeaturePanels = useWorkspaceFeaturePanels()

const workspacePanelOptions = computed<WorkbenchTabOption[]>(() =>
  workspaceFeaturePanels.value.map(panel => ({
    key: workspaceTabId(panel.id),
    type: 'workspace' as const,
    title: panel.label,
    icon: panel.icon,
    categorySlot: 5,
    domain: 'workspace' as const,
    panelId: panel.id,
  })),
)

const sessionTabOptions = computed<WorkbenchTabOption[]>(() =>
  tabOptions
    .filter(option =>
      (option.type !== 'terminal' || canUseTerminal.value) &&
      ((option.type !== 'board' && option.type !== 'scheduling') || canUseCollabRooms.value))
    .map(option => ({ ...option, key: option.type, domain: 'session' as const })),
)

const availableTabOptions = computed<WorkbenchTabOption[]>(() => {
  const openKeys = new Set(openTabs.value.map(tab => tab.id))
  return [
    ...sessionTabOptions.value,
    // 单例且已经开着的面板从清单里撤掉(图纸规则③)。
    ...workspacePanelOptions.value.filter(option => !openKeys.has(option.key)),
    ...workbenchPluginOptions.value.filter(option => !openKeys.has(option.key)),
  ]
})

const hasSessionOption = computed(() => sessionTabOptions.value.length > 0)
const firstWorkspaceOptionKey = computed(
  () => availableTabOptions.value.find(option => option.domain === 'workspace')?.key ?? '',
)

/** 「+」菜单/空态里点了一条:面板项开面板页签,其余走既有 addWorkbenchTab。 */
function onPickOption(option: WorkbenchTabOption): void {
  if (option.type === 'plugin' && option.pluginId && option.panelId) {
    openPluginTab(option.pluginId, option.panelId, option.title)
    return
  }
  if (option.type === 'workspace' && option.panelId) {
    openWorkspaceTab(option.panelId)
    return
  }
  addWorkbenchTab(option.type)
}

/** 当前这个 plugin tab 对应的面板对象(顺着活清单现查,复用 PluginPanelHost 双形态)。 */
function pluginPanelFor(tab: WorkbenchTab): PluginWorkspacePanel | undefined {
  return pluginPanels.value.find(
    panel => panel.pluginId === tab.pluginId && panel.panelId === tab.panelId,
  )
}

/**
 * 开(或聚焦)一个插件面板 tab(H1)。
 *
 * **单例**:同一个 `pluginId+panelId` 只有一条 tab(照 addWorkbenchTab 的去重先例)。
 * tab id = nav id(`plugin:<id>:<panel>`),与 `terminal-<id>` 同一手法。
 *
 * v1 持久化边界(裁决 D):**不跨重启持久化** —— 右侧工作台的 openTabs 本就是
 * 组件本地态,任何 tab 都不写进重启恢复层,plugin tab 自然随进程消失,重启后
 * 用户从「+」菜单重开。"插件已卸载"的占位/降级是独立一期,这里先把能开能用能关
 * 跑通。同一次会话内切走切回照常在(它就在这个响应式数组里)。
 */
function openPluginTab(pluginId: string, panelId: string, title: string): void {
  const id = pluginPanelNavId(pluginId, panelId)
  const existing = openTabs.value.find(tab => tab.id === id)
  if (existing) {
    activeTabId.value = existing.id
    return
  }
  const tab: WorkbenchTab = { id, type: 'plugin', title, pluginId, panelId }
  insertTab(tab)
  activeTabId.value = tab.id
}

// ── 双域页签:会话域(左)/ 工作区域(右)──────────────────────────────────
//
// 右域是**跨会话**的那一半:工作区面板不随会话切换重置,也不再被会话切换关掉
// (从前每一条切会话的路径都强制 `activeWorkspacePanel = null`)。左域照旧。

/** 工作区面板的页签 id —— 与 `plugin:<id>:<panel>` 同一手法,id 即单例键。 */
function workspaceTabId(panelId: WorkspaceNavId): string {
  return `workspace:${panelId}`
}

/**
 * 段边界的**唯一**维护点。
 *
 * 工作区页签恒在尾段,会话域页签插在它们之前 —— 到处 `push` 的话,先开 Media
 * 再开 Files 就把两个域搅在一起,分隔线也就无处可画。页签**条**的次序另有一套
 * (注册次序),由 `TabPane :order` 与这里的数组次序对齐(见 `tabs.ts` 的注)。
 */
function insertTab(tab: WorkbenchTab): void {
  const tabs = openTabs.value
  if (tab.type === 'workspace') {
    openTabs.value = [...tabs, tab]
    return
  }
  const boundary = tabs.findIndex(item => item.type === 'workspace')
  if (boundary === -1) {
    openTabs.value = [...tabs, tab]
    return
  }
  openTabs.value = [...tabs.slice(0, boundary), tab, ...tabs.slice(boundary)]
}

/** 右域第一条(两域都非空时才画分隔线 —— 图纸规则①)。 */
const segmentStartTabId = computed(() => {
  const boundary = openTabs.value.findIndex(tab => tab.type === 'workspace')
  if (boundary <= 0) return ''
  return openTabs.value[boundary].id
})

/**
 * 关闭钮的三档口径:
 *  · 房的固定页签(线程/成员/看板/调度)**不可关** —— 格数由房的形态决定,
 *    关掉一条只会让 `ensureRoomTabs` 下一拍再补回来,那不是关闭是闪烁;
 *  · 工作区页签只在**选中时**露出 ✕(图纸规则②:关闭钮只出现在选中的右域页签);
 *  · 其余会话域页签照旧可关(能力不减)。
 */
function isTabClosable(tab: WorkbenchTab): boolean {
  if (ROOM_FIXED_TAB_TYPES.has(tab.type)) return false
  if (tab.type === 'workspace') return activeTabId.value === tab.id
  return true
}

/**
 * 打开(或聚焦)一个工作区面板页签。侧栏「⋯」菜单、`toggle-media-panel`、三条
 * window 事件全部落在这里 —— 从前它们落在 App 的 `activeWorkspacePanel` 上。
 *
 * 内置 id 与插件 nav id 都收:调用方(侧栏菜单)吃的是同一份
 * `useWorkspaceNavEntries()`,两种 id 混在一条清单里,分流该由这里做。
 */
function openWorkspaceTab(panelId: WorkspaceNavId): void {
  pickerOpen.value = false

  const plugin = parsePluginPanelNavId(String(panelId))
  if (plugin) {
    const panel = pluginPanels.value.find(
      item => item.pluginId === plugin.pluginId && item.panelId === plugin.panelId,
    )
    if (!panel) return
    openPluginTab(panel.pluginId, panel.panelId, panel.label)
    return
  }

  const panel = findWorkspacePanel(String(panelId))
  if (!panel) return

  const id = workspaceTabId(panel.id)
  const existing = openTabs.value.find(tab => tab.id === id)
  if (existing) {
    activeTabId.value = existing.id
    return
  }
  const tab: WorkbenchTab = { id, type: 'workspace', title: panel.label, panelId: panel.id }
  insertTab(tab)
  activeTabId.value = tab.id
}

/** 这个工作区面板此刻是不是选中的那一格(todo-plan 的 hide/toggle 要问)。 */
function isWorkspaceTabActive(panelId: WorkspaceNavId): boolean {
  return activeTabId.value === workspaceTabId(panelId)
}

// ── 内置面板的内容分发(K1)────────────────────────────────────────────────
//
// 从前这里是一条按 panelId 逐个点名的 `v-else-if` 链:加一个面板要回到工作台
// 补一格,漏一格就是"面板开得出页签、里面一片空白"。现在只有一条通用分发:
// 组件、要注入的上下文、宿主接哪几个事件都写在 descriptor 上。

/** 这条工作区页签对应的注册表条目(顺着活注册表现查 —— 注销即落空)。 */
function workspacePanelEntry(tab: WorkbenchTab): WorkspacePanelEntry | undefined {
  if (tab.type !== 'workspace' || !tab.panelId) return undefined
  return findWorkspacePanel(tab.panelId)
}

/**
 * 宿主注入的渲染上下文 —— **只给面板声明过的那几格**。
 *
 * 无脑全给的代价是可观察的:`active` 落进不声明这个 prop 的面板会变成它根节点
 * 上的一个 `active="true"` 属性(attrs 透传)。声明制让"这个面板要什么"写在
 * 它自己的 descriptor 上,而不是靠工作台记得。
 */
function workspacePanelContext(tab: WorkbenchTab): Record<string, unknown> {
  const entry = workspacePanelEntry(tab)
  if (!entry?.context?.includes('active')) return {}
  return { active: activeTabId.value === tab.id }
}

/**
 * 面板要求关掉自己那一格(Agents 的「私聊」开出去之后就这么收场)。
 *
 * 判据是**声明**而不是"收到了这个事件":多数面板的根节点是 `PanelShell`,
 * 一个不发 close 的面板照样可能让根组件的同名事件透上来,那时候关页签是错的。
 */
function onWorkspacePanelClose(tab: WorkbenchTab): void {
  if (!workspacePanelEntry(tab)?.emits?.includes('close')) return
  closeWorkbenchTab(tab.id)
}

/**
 * Media 的「跳到来源消息」。
 *
 * 落点是 `chatContainerRef.jumpToMessage(sessionId, messageId)` —— 那条链整个
 * 在 App.vue 手里(它持有 ChatContainer 的 ref,并且已经为搜索 deeplink 走过
 * 一遍 switchSession + loadMessagesAround)。这一层只做**中继**:再冒一级,
 * 不自己去找 ChatContainer,也**不关**工作台(跳转与面板可见性无关)。
 */
function onWorkspacePanelJumpToSource(
  tab: WorkbenchTab,
  payload: { sessionId: string; messageId: string },
): void {
  if (!workspacePanelEntry(tab)?.emits?.includes('jump-to-source')) return
  emit('jump-to-source', payload)
}

let variableRequestId = 0

const NOTE_ROOT_VARIABLE_NAMES = new Set(['user_note_dir', 'work_note_dir'])

const editorWorkspace = useEditorWorkspace()
const configuredWorkspaceRoots = computed(() => uniquePaths([
  ...variableWorkspaceRoots.value,
  ...(props.workspaceRoots || []),
  props.workspaceRoot,
]))
const workspaceRoot = computed(() => filesWorkspaceRoot.value || configuredWorkspaceRoots.value[0] || '')

// ── 房的固定页签组:备齐 / 落座 ────────────────────────────────────────────

/**
 * 这间房该有哪几条页签 —— **只问形态,不读信号**。
 *
 * 与 `roomFixedTabs`(带状态点的那份)刻意分开:备齐与落座是结构问题,不该
 * 顺手把 chat / collabBoard 两个 store 拖进来(它们只为那四颗点服务)。
 */
const roomTabShape = computed<RoomFixedTab[]>(() => (
  roomTarget.value.roomSessionId ? buildRoomFixedTabs({ isDm: roomTarget.value.isDm }) : []
))

/**
 * 进房 = 把这间房的固定页签备齐,并让它们排在最前面。
 *
 * **格数只由房的形态决定,与内容无关**:一条线程都没有的房照样有「线程」页签
 * —— 从前"按需才开"的代价是真机上根本看不到线程(空的是内容,不是入口)。
 *
 * 每一条都是**单例**:换房是换靶子(重绑房 id、回列表层),不是再开一页 ——
 * 逛三间房不该攒出三条「线程」。私聊房没有看板,从群房切进去时那一条随之撤掉,
 * 不留一条对不上号的。
 */
function ensureRoomTabs(target: RoomPanelTarget): void {
  if (!target.roomSessionId) return

  const fixed = buildRoomFixedTabs({ isDm: target.isDm })
  const wanted = new Set<WorkbenchTabType>(fixed.map(item => item.type))

  // 这间房的形态里没有的那条(私聊房的看板)撤掉,不留一条对不上号的。
  const dropped = openTabs.value.filter(
    tab => ROOM_FIXED_TAB_TYPES.has(tab.type) && !wanted.has(tab.type),
  )
  const next = openTabs.value.filter(tab => !dropped.includes(tab))

  // 缺的按固定次序补在**会话域那一段的末尾**(工作区页签恒在其后,与 `insertTab`
  // 同一条边界)。**不重排已有页签** —— 页签条的次序是注册次序(`Tabs.vue` 的
  // pane 注册表),重排数组也搬不动它,只会让两处次序对不上;两个域之间的次序
  // 由 `TabPane :order` 显式说,那是段与段,不是段内。
  for (const spec of fixed) {
    let tab = next.find(item => item.type === spec.type)
    if (!tab) {
      tab = { id: spec.type, type: spec.type, title: spec.label }
      const boundary = next.findIndex(item => item.type === 'workspace')
      if (boundary === -1) next.push(tab)
      else next.splice(boundary, 0, tab)
    }
    tab.title = spec.label
    tab.sessionId = target.roomSessionId
    // 换房回**列表层**:自动备齐时系统并不知道你想看哪一次执行,替你挑一条
    // 塞满整面等于替你做了选择。私聊房的「空间」例外 —— 那一页天然就是那个人。
    if (spec.type === 'thread') tab.threadSessionId = ''
    if (spec.type === 'members') tab.memberAgentId = target.isDm ? target.dmAgentId : ''
    if (spec.type === 'schedule') tab.scheduleFilter = ''
  }

  openTabs.value = next

  if (!activeTabId.value || dropped.some(tab => tab.id === activeTabId.value)) {
    activeTabId.value = next.find(tab => tab.type === 'thread')?.id || next[0]?.id || ''
  }
}

/**
 * 外部入口的落座。这间房没有这一条(私聊房请求看板)就**原地不动**并回报
 * false —— 宁可不动,也不要把人甩到一个 TA 没要的视图上。
 */
function focusRoomTab(type: RoomFixedTabType): boolean {
  if (!pickRoomFixedTab(type, roomTabShape.value)) return false
  const tab = openTabs.value.find(item => item.type === type)
  if (!tab) return false
  activeTabId.value = tab.id
  return true
}

/**
 * 进房自动备齐 —— **结构性的,不靠事件**。
 *
 * 从前这件事挂在 `onething:room-workbench` 上,漏派一次(或者像背台那样被另一
 * 套面板盖住)用户就看不到线程。现在只要右栏对着一间房,那几条就在。
 */
watch(
  () => {
    const target = roomTarget.value
    return `${target.roomSessionId}|${target.isDm ? 1 : 0}|${target.dmAgentId}`
  },
  () => {
    const target = roomTarget.value
    if (!target.roomSessionId) return
    // 看板/调度那两颗点读的是看板镜像。房面(`RoomSurface`)本来也订,但那两颗点
    // 不该依赖"隔壁组件恰好挂着" —— 订阅是幂等的,这里补一次说清依赖。
    try { useCollabBoardStore().ensureSubscribed() } catch { /* 订阅失败只让点不亮 */ }
    ensureRoomTabs(target)
    focusRoomTab('thread')
  },
  { immediate: true },
)

/**
 * 状态条那颗死信红点的落点(契约见 `room-schedule.ts`)。
 *
 * 走 window 事件而不是逐层 emit:派事件的 `CoordinatorStatusBar` 挂在**线程页**
 * 里,而目标是它隔壁那一页 —— 与 `OPEN_MEMBERS_EVENT` 同一条解耦线路。
 */
function onOpenRoomSchedule(event: Event): void {
  const detail = (event as CustomEvent<OpenRoomScheduleDetail>).detail
  const roomSessionId = detail?.roomSessionId
  if (!roomSessionId || roomSessionId !== roomTarget.value.roomSessionId) return

  ensureRoomTabs(roomTarget.value)
  const tab = openTabs.value.find(item => item.type === 'schedule')
  if (!tab) return
  tab.scheduleFilter = detail.filter || ''
  // 同一个过滤器也要能重放:再点一次红点 = 再带我去一次。
  tab.scheduleNonce = (tab.scheduleNonce ?? 0) + 1
  activeTabId.value = tab.id
}

window.addEventListener(OPEN_ROOM_SCHEDULE_EVENT, onOpenRoomSchedule)
onUnmounted(() => { window.removeEventListener(OPEN_ROOM_SCHEDULE_EVENT, onOpenRoomSchedule) })

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
}

function addWorkbenchTab(type: WorkbenchTabType): void {
  pickerOpen.value = false

  // Terminals are id-per-instance — any number may coexist.
  if (type === 'terminal') {
    void addTerminalTab()
    return
  }

  const existing = openTabs.value.find(tab => tab.type === type)
  if (existing) {
    activeTabId.value = existing.id
    return
  }

  const option = tabOptions.find(item => item.type === type)
  const tab: WorkbenchTab = {
    id: `${type}-${Date.now()}`,
    type,
    title: option?.title || type,
  }
  insertTab(tab)
  activeTabId.value = tab.id
}

async function addTerminalTab(): Promise<void> {
  try {
    const terminalId = await terminalsStore.createTerminal({
      cwd: workspaceRoot.value || undefined,
      sessionId: props.sessionId || undefined,
    })
    adoptTerminalTab(terminalId, { activate: true })
  } catch (error) {
    console.error('[Workbench] Failed to create terminal:', error)
  }
}

function adoptTerminalTab(terminalId: string, options: { activate?: boolean } = {}): void {
  // The mount-time adoption loop can race a user-created terminal (both see it
  // in the store) — dedupe on the tab, but never swallow the activation.
  const existing = openTabs.value.find(tab => tab.terminalId === terminalId)
  if (existing) {
    if (options.activate) activeTabId.value = existing.id
    return
  }
  const descriptor = terminalsStore.terminals.find(t => t.id === terminalId)
  const tab: WorkbenchTab = {
    id: `terminal-${terminalId}`,
    type: 'terminal',
    title: descriptor?.title || 'Terminal',
    terminalId,
  }
  insertTab(tab)
  if (options.activate) activeTabId.value = tab.id
}

/** An exited terminal was restarted from inside the view: swap the PTY id. */
function handleTerminalRestarted(tabId: string, newTerminalId: string): void {
  const tab = openTabs.value.find(item => item.id === tabId)
  if (!tab) return
  tab.terminalId = newTerminalId
}

function tabDisplayTitle(tab: WorkbenchTab): string {
  if (tab.type === 'terminal' && tab.terminalId) {
    const descriptor = terminalsStore.terminals.find(t => t.id === tab.terminalId)
    if (descriptor?.title) return descriptor.title
  }
  /* 改名之后页签跟着改 —— 名字是现查的,不是开页签那一刻的快照。 */
  if (tab.type === 'agent' && tab.agentId) {
    return useAgentsStore().displayAgent(tab.agentId).name || tab.title
  }
  return tab.title
}

function closeWorkbenchTab(name: TabPaneName) {
  const index = openTabs.value.findIndex(tab => tab.id === name)
  if (index === -1) return

  const closing = openTabs.value[index]
  if (closing?.type === 'terminal' && closing.terminalId) {
    void terminalsStore.closeTerminal(closing.terminalId)
  }

  const wasActive = closing?.id === activeTabId.value
  const nextTabs = openTabs.value.filter(tab => tab.id !== name)
  openTabs.value = nextTabs

  if (!wasActive) return
  activeTabId.value = nextTabs[Math.min(index, nextTabs.length - 1)]?.id || ''
}

// PTYs live in the main process and survive renderer reload; re-adopt any
// terminal that has no tab yet so scrollback recovery is reachable.
onMounted(async () => {
  if (!canUseTerminal.value) return
  try {
    await terminalsStore.ensureLoaded()
  } catch {
    return
  }
  for (const descriptor of terminalsStore.terminals) {
    adoptTerminalTab(descriptor.id)
  }
})

/**
 * 页签图标。工作区页签的图标是**那个面板的**(注册表给),不是"工作区"这个
 * 类别的 —— 六个面板并排时按类别发同一枚图标等于没发。
 */
function tabIconFor(tab: WorkbenchTab): Component {
  if (tab.type === 'workspace' && tab.panelId) {
    const panel = findWorkspacePanel(tab.panelId)
    if (panel) return panel.icon
  }
  return tabIcon(tab.type)
}

function tabIcon(type: WorkbenchTabType): Component {
  if (type === 'file') return FileText
  if (type === 'terminal') return Terminal
  if (type === 'browser') return Globe2
  if (type === 'review') return GitCompare
  if (type === 'board') return ClipboardList
  if (type === 'thread') return ListTree
  if (type === 'members') return Users
  if (type === 'agent') return UserRound
  if (type === 'schedule' || type === 'scheduling') return Radar
  if (type === 'plugin') return PLUGIN_PANEL_ICON
  return Files
}

function tabCategorySlot(type: WorkbenchTabType): number {
  if (type === 'plugin' || type === 'workspace') return 5
  if (type === 'terminal') return 6
  if (type === 'browser') return 7
  if (type === 'board') return 8
  if (type === 'review') return 4
  if (type === 'thread') return 3
  if (type === 'members') return 2
  if (type === 'agent') return 2
  if (type === 'schedule' || type === 'scheduling') return 8
  return 5
}

function workbenchToolStyle(categorySlot: number): Record<string, string> {
  return {
    '--workbench-tool-icon-color': `var(--ui-category-${categorySlot}-icon)`,
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '/') return '/'
  return trimmed.replace(/\/+$/, '')
}

function parentDir(filePath: string): string {
  return normalizePath(filePath).split('/').slice(0, -1).join('/') || '/'
}

function basename(filePath: string): string {
  return normalizePath(filePath).split('/').filter(Boolean).pop() || filePath
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  if (!filePath || !root) return false
  const normalizedPath = normalizePath(filePath)
  const normalizedRoot = normalizePath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function uniquePaths(paths: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (!path) continue
    const normalized = normalizePath(path)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function findContainingRoot(filePath: string, roots: string[]): string {
  return roots.find(root => isPathInsideRoot(filePath, root)) || ''
}

function rootsFromWorkdirVariable(variable?: ContextVariable): string[] {
  if (!variable) return []
  const values = Array.isArray(variable.values) && variable.values.length > 0
    ? variable.values
    : [variable.value]
  return uniquePaths(values)
}

function applyVariableRoots(variables: ContextVariable[]) {
  const workdirVariable = variables.find(variable => variable.name === 'workdir')
  variableWorkspaceRoots.value = rootsFromWorkdirVariable(workdirVariable)
  noteWorkspaceRoots.value = uniquePaths(
    variables
      .filter(variable => NOTE_ROOT_VARIABLE_NAMES.has(variable.name))
      .map(variable => variable.value),
  )
}

async function refreshVariableRoots(): Promise<void> {
  const sessionId = props.sessionId
  if (!sessionId || !platformApi?.listVariables) return

  const requestId = ++variableRequestId
  try {
    const response = await platformApi.listVariables(sessionId)
    if (requestId !== variableRequestId || sessionId !== props.sessionId) return
    if (!response.success || !response.variables) return
    applyVariableRoots(response.variables)
  } catch {
    // Variables are an enhancement for root detection; props still provide the project roots.
  }
}

function resolveFileWorkspaceRoot(filePath: string): string {
  const noteRoot = findContainingRoot(filePath, noteWorkspaceRoots.value)
  if (noteRoot) return noteRoot

  const projectRoot = findContainingRoot(filePath, configuredWorkspaceRoots.value)
  if (projectRoot) return projectRoot

  if (filesWorkspaceRoot.value && isPathInsideRoot(filePath, filesWorkspaceRoot.value)) return filesWorkspaceRoot.value
  return parentDir(filePath)
}

/**
 * One review tab per session rather than a new tab per click. Reopening bumps
 * the nonce, which remounts the pane and refetches — the audit trail keeps
 * growing while a goal runs, so a stale tab would quietly lie.
 */
function openGoalReview(reviewSessionId: string) {
  const existing = openTabs.value.find(
    tab => tab.type === 'review' && tab.sessionId === reviewSessionId,
  )
  if (existing) {
    existing.reviewNonce = (existing.reviewNonce ?? 0) + 1
    activeTabId.value = existing.id
    return
  }

  const tab: WorkbenchTab = {
    id: `review-${Date.now()}-${openTabs.value.length}`,
    type: 'review',
    title: 'Review',
    sessionId: reviewSessionId,
    reviewNonce: 0,
  }
  insertTab(tab)
  activeTabId.value = tab.id
}

/**
 * 右栏「线程」tab(docs/design/im-workbench-layout.md §3 W4,C3-B)。
 *
 * **一个工作台会话最多一个 tab** —— 去重照 `openGoalReview` 的先例(那边按
 * `sessionId` 找既有 review tab),只是这里连 nonce 都不需要:线程面板读的是
 * chat store 里那份消息,活的,不存在"打开时是快照、后来变陈旧"这回事。
 * tab id 直接用会话 id(与 `terminal-${terminalId}` 同一手法),去重再多一道保险。
 *
 * 不进 `tabOptions`:线程必须绑一个会话,picker 里点一下开不出有意义的空线程
 * —— 与 `file` / `review` 同一档,只能从外部入口带着靶子进来。
 */
/**
 * 线程页签(**两层**:这间房的执行会话列表 → 选中 → 该会话详情)。
 *
 * `threadSessionId` 允许为空 —— 一间**还没跑过活**的房同样要有线程页签
 * (样板 final.html 的右栏是三 tab 常驻)。给了靶子就**直接落在详情层**
 * (「展开执行 →」与左栏活卡片本来就知道要看哪一条);只给房就落在**列表层**。
 * 页签 id 因此按"靶子 or 房"取:同一间房不会开出第二条空线程。
 *
 * `sessionId` 存的是**房**(列表层的地基),`threadSessionId` 存的是那次执行。
 * 没带房进来时这一格留空 —— 由 `RoomThreadsWorkbench` 顺着执行会话的
 * `collab.roomSessionId` 现查(禁反解 id),查到再由 `focus` 回填。
 * **不能**沿用上一次的房:那会把另一间房的执行会话挂在错的花名册下面。
 */
function openThread(threadSessionId: string, title?: string, roomSessionId?: string): void {
  // **单例**:线程只有一条页签,换房或换一次执行都是**换靶子**,不是再开一页
  // (逛三间房不该攒三条「线程」)。页签 id 恒为 'thread' —— 从前把靶子编进 id
  // 里,换一次靶子整条页签就重建一次,而里面那两层的落座本来就是 watch 出来的。
  const existing = openTabs.value.find(tab => tab.type === 'thread')

  // 空靶子 + 空房 + 还没有这条页签 = 开不出有意义的线程页(左栏对空串已经拦了
  // 一道,这里是第二道)。已经有这条页签时,空靶子的意思是"回列表层"。
  if (!existing && !threadSessionId && !roomSessionId) return

  const tab: WorkbenchTab = existing
    || { id: 'thread', type: 'thread', title: ROOM_TAB_LABELS.thread }
  tab.title = ROOM_TAB_LABELS.thread
  // 带着一条执行会话进来却没说房 → 把房**清空**,由 `RoomThreadsWorkbench` 顺着
  // `collab.roomSessionId` 现查后回填。沿用上一次的房会把另一间房的执行会话挂在
  // 错的花名册下面。空靶子(回列表层)则保留当前这间房。
  tab.sessionId = roomSessionId || (threadSessionId ? '' : tab.sessionId || '')
  tab.threadSessionId = threadSessionId

  if (!existing) insertTab(tab)
  activeTabId.value = tab.id
}

/**
 * 面板里下钻/返回之后把落点写回 tab —— 关掉再开回来时停在同一层
 * (与 `setMembersFocus` 同一手法)。
 *
 * `roomSessionId` 一并回填:靶子是顺着执行会话查出房间的,查出来就记在 tab 上,
 * 返回列表层才有表可回。回到列表层时页签名换回「线程」——**单例页签换靶子,
 * 不新开**,所以标题也得跟着换回去。
 */
function setThreadFocus(tabId: string, payload: { sessionId: string; roomSessionId: string }): void {
  const tab = openTabs.value.find(item => item.id === tabId)
  if (!tab) return
  tab.threadSessionId = payload.sessionId || ''
  if (payload.roomSessionId) tab.sessionId = payload.roomSessionId
  if (!payload.sessionId) tab.title = ROOM_TAB_LABELS.thread
}

/**
 * 右栏「成员」tab(去复用重构 R2,样板二 · 右栏三态)。
 *
 * **全局只有一个 members tab**,换房是换它的 `sessionId` 而不是再开一个 ——
 * 同一 tab 类型不开出第二个(照 `addWorkbenchTab` 的去重先例);按房去重会在
 * 逛过三间房之后攒出三条一模一样的「成员」页签。
 *
 * `agentId` 非空 = 直接落在那个人的**空间页**(下钻层)。空间页不占 tab 位
 * (样板注明),它是 `MembersWorkbench` 内部的一层视图,所以这里只是把落点
 * 记在 tab 上,而不是开第二个页签。私聊房那一条叫「空间」——一对一没有"成员"
 * 这回事;标题由固定组给,调用方传的 `title` 只在房外那一路(直聊)兜底。
 *
 * 不进 `tabOptions`:成员必须绑一间房,picker 里点一下开不出有意义的空成员表
 * —— 与 `thread` / `review` 同一档,只能从外部入口带着靶子进来。
 */
function openMembers(roomSessionId: string, agentId?: string, title?: string): void {
  if (!roomSessionId) return

  const existing = openTabs.value.find(tab => tab.type === 'members')
  if (existing) {
    existing.sessionId = roomSessionId
    existing.memberAgentId = agentId || ''
    if (title) existing.title = title
    activeTabId.value = existing.id
    return
  }

  const tab: WorkbenchTab = {
    id: 'members',
    type: 'members',
    title: title || ROOM_TAB_LABELS.members,
    sessionId: roomSessionId,
    memberAgentId: agentId || '',
  }
  insertTab(tab)
  activeTabId.value = tab.id
}

/**
 * 「这个人」的页签(agent-space-workbench.md P1)。
 *
 * 房内成员点头像走的是 `openMembers` 的下钻(不占 tab 位);够不到房的那些人
 * —— 直聊里的助理、已退休的同事 —— 才落到这里,一人一页签(id 即 agent id,
 * 同一个人反复点只会聚焦,不会攒页签)。
 *
 * 不进 `tabOptions`:页签必须绑一个人,picker 里点一下开不出有意义的空白页。
 */
function openAgentTab(agentId: string, tab?: AgentDetailTab | null): void {
  if (!agentId) return

  // 在房里就走「成员/空间」页的下钻层,不另开一条 —— `MembersWorkbench` 的下钻
  // 层就是共享的 `AgentSpace`,它不要求这个人在花名册上(房外的人一样落得进去)。
  const room = roomTarget.value
  if (room.roomSessionId) {
    const membersTab = openTabs.value.find(item => item.type === 'members')
    if (membersTab) {
      membersTab.memberAgentId = agentId
      membersTab.detailTab = tab ?? null
      activeTabId.value = membersTab.id
      return
    }
  }

  const title = useAgentsStore().displayAgent(agentId).name || ROOM_TAB_LABELS.space
  const existing = openTabs.value.find(item => item.type === 'agent' && item.agentId === agentId)
  if (existing) {
    existing.title = title
    existing.detailTab = tab ?? null
    activeTabId.value = existing.id
    return
  }

  const created: WorkbenchTab = {
    id: `agent-${agentId}`,
    type: 'agent',
    title,
    agentId,
    detailTab: tab ?? null,
  }
  insertTab(created)
  activeTabId.value = created.id
}

/**
 * 拆除即关(裁决 E):插件停用/卸载后它从 `pluginPanels` 清单里消失,把它对应的
 * workbench tab 立即关掉 —— 与主工作区面板停用同规(MediaPanel 那边把导航拉回
 * media)。熔断降级(R7)自动禁用一个插件时走的也是这条路(清单里没了)。
 *
 * 拆除快照:tab 被移出 openTabs → PluginPanelHost 卸载 → usePluginUiBlock 的
 * onUnmounted 停轮询/弃在飞结果,右栏不留残条也不留在飞请求。
 */
watch(pluginPanels, (panels) => {
  const live = new Set(panels.map(panel => `${panel.pluginId}:${panel.panelId}`))
  const survivors = openTabs.value.filter(
    tab => tab.type !== 'plugin' || live.has(`${tab.pluginId}:${tab.panelId}`),
  )
  if (survivors.length === openTabs.value.length) return
  const activeSurvived = survivors.some(tab => tab.id === activeTabId.value)
  openTabs.value = survivors
  if (!activeSurvived) activeTabId.value = survivors[survivors.length - 1]?.id || ''
})

/** 面板里下钻/返回之后把落点写回 tab —— 关掉再开回来时停在同一层。 */
function setMembersFocus(tabId: string, agentId: string): void {
  const tab = openTabs.value.find(item => item.id === tabId)
  if (!tab) return
  tab.memberAgentId = agentId || ''
}

/**
 * 空间页里的会话行:在**主区**开页签,右栏原地不动
 * (agent-space-workbench.md §2 落点表)。右栏不关也不跳 —— 一边看人,一边看会话。
 */
function openSessionTab(sessionId: string): void {
  if (!sessionId) return
  useWorkspaceStore().openSession(sessionId)
}

/**
 * 线程页签**不跟着会话名改名**。
 *
 * 它是样板右栏常驻三条之一(线程 / 成员 / 看板),标题一长就把自己挤出可视区
 * —— 真机 253px 下激活的正是线程页签,而页签条里只看得见「成员/看板」。
 * 在看哪一次执行由面板头去说(`THREAD <卡名> · N 步 · N 次执行`),那儿有整行
 * 宽度。这个回调保留是为了不改详情层 `ThreadChatDetail` 的对外形状。
 */
function renameThreadTab(_tabId: string, _title: string) {
  /* no-op:标题恒为「线程」 */
}

/** The objective makes a far better tab title than a generic "Review". */
function renameReviewTab(tabId: string, objective: string) {
  const tab = openTabs.value.find(item => item.id === tabId)
  if (!tab) return
  const trimmed = objective.trim().split('\n')[0] || ''
  tab.title = trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed || 'Review'
}

async function openFile(filePath: string) {
  await refreshVariableRoots()
  const root = resolveFileWorkspaceRoot(filePath)
  filesWorkspaceRoot.value = root
  const existing = openTabs.value.find(tab => tab.type === 'file' && tab.filePath === filePath)
  if (existing) {
    existing.title = basename(filePath)
    existing.workspaceRoot = root
    activeTabId.value = existing.id
  } else {
    const tab: WorkbenchTab = {
      id: `file-${Date.now()}-${openTabs.value.length}`,
      type: 'file',
      title: basename(filePath),
      filePath,
      workspaceRoot: root,
    }
    insertTab(tab)
    activeTabId.value = tab.id
  }
  await nextTick()
  await editorWorkspace.setWorkspaceRoot(root).catch(() => {})
  await editorWorkspace.openFile(filePath)
}

watch(activeTabId, id => {
  const tab = openTabs.value.find(item => item.id === id)
  if (tab?.type !== 'file' || !tab.filePath) return
  const root = tab.workspaceRoot || resolveFileWorkspaceRoot(tab.filePath)
  filesWorkspaceRoot.value = root
  void editorWorkspace.setWorkspaceRoot(root)
    .catch(() => {})
    .then(() => editorWorkspace.openFile(tab.filePath!))
})

watch(() => props.sessionId, () => {
  filesWorkspaceRoot.value = ''
  variableWorkspaceRoots.value = []
  noteWorkspaceRoots.value = []
  variableRequestId += 1
  void refreshVariableRoots()
}, { immediate: true })

function normalizeBrowserUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function navigateBrowser() {
  browserUrl.value = normalizeBrowserUrl(browserInput.value)
}

/**
 * 进房:把这间房的固定页签备齐并落在**线程**上。
 *
 * 备齐这件事本身已经由 `roomTarget` 那条 watch 结构性地保证了(只要右栏对着
 * 一间房,那几条就在);这个入口留着是因为它带着房面才知道的东西 ——
 * 私聊房的那个人 —— 而且它同时是"再点一次带我回线程"的重放口。
 *
 * 线程**落在列表层**:自动备齐时系统并不知道你想看哪一次执行,替你挑一条塞满
 * 整面等于替你做了选择。真正"知道要看哪一条"的是中栏「展开执行 →」与左栏活
 * 卡片,它们走 `openThread(workSessionId)` 直接进详情层。
 * 第二个参数(房面顺手算出来的默认工作会话)因此**刻意不用** —— 事件契约不动,
 * 只是右栏不再替用户选。
 */
function openRoomTabs(
  roomSessionId: string,
  _defaultThreadSessionId?: string,
  opts?: { dmAgentId?: string },
): void {
  if (!roomSessionId) return

  ensureRoomTabs({
    roomSessionId,
    isDm: !!opts?.dmAgentId,
    dmAgentId: opts?.dmAgentId || '',
  })
  openThread('', undefined, roomSessionId)
}

/** 群聊头部 / ⋯ 菜单的「看板」直达入口 — 打开(或聚焦)看板页签。 */
function openBoard(): void {
  // 私聊房没有看板:**原地不动**,不把人甩到 TA 没要的视图上。
  if (roomTarget.value.roomSessionId) {
    if (focusRoomTab('board')) return
    if (roomTarget.value.isDm) return
  }
  addWorkbenchTab('board')
}

/**
 * 群 folder 的文件树入口(collab-team-v2 §7)。
 *
 * 走的是既有的 files 页签,只是把根换成这个群的 folder —— 群里放的文档因此
 * 和项目文件用同一套浏览/打开链路,不需要第二种文件浏览器。
 *
 * 走查 F2 的终局:这条链路从前**在房里够不着** —— files 页签画在被房间背台
 * 盖住的那一层,按钮点了、页签开了、用户什么也看不见。背台退役之后它是可达的。
 */
async function openFolder(root: string): Promise<void> {
  if (!root) return
  addWorkbenchTab('files')
  filesWorkspaceRoot.value = root
  await nextTick()
  await editorWorkspace.setWorkspaceRoot(root).catch(() => {})
}

defineExpose({
  openFile,
  openGoalReview,
  openBoard,
  openFolder,
  openThread,
  openRoomTabs,
  openMembers,
  openAgentTab,
  openPluginTab,
  openWorkspaceTab,
  isWorkspaceTabActive,
})
</script>

<style scoped>
/* 台面(Bench):直角实线,框不闭合只留角标。
   活性一律制图黛蓝(theme info 色)。 */
.right-workbench {
  position: relative;
  height: 100%;
  min-width: 0;
  min-height: 0;
  --workbench-accent: var(--ui-status-info-fg, var(--color-info));
  --workbench-line: color-mix(in srgb, var(--ui-border-strong-border) 85%, transparent);
  --workbench-tool-card-bg: var(--ui-surface-elevated-bg);
  --workbench-tool-card-hover-bg: color-mix(
    in srgb,
    var(--workbench-tool-card-bg) 90%,
    var(--workbench-tool-icon-color, var(--ui-accent-primary-fg)) 10%
  );
  --workbench-tool-card-active-bg: color-mix(
    in srgb,
    var(--workbench-tool-card-bg) 87%,
    var(--workbench-tool-icon-color, var(--ui-accent-primary-fg)) 13%
  );
  --workbench-tool-card-border: color-mix(
    in srgb,
    var(--ui-border-default-border) 84%,
    var(--ui-text-muted-fg) 16%
  );
  --workbench-tool-card-hover-border: color-mix(
    in srgb,
    var(--workbench-tool-card-border) 76%,
    var(--workbench-tool-icon-color, var(--ui-accent-primary-fg)) 24%
  );
  --workbench-tool-card-active-border: color-mix(
    in srgb,
    var(--workbench-tool-card-border) 68%,
    var(--workbench-tool-icon-color, var(--ui-accent-primary-fg)) 32%
  );
  /* 台面底色不在这里画了 —— 走 Container 的 `surface="panel"` 档位(G7-1)。
     同一枚 `--ui-surface-panel-bg`,只是改由原语画,并在根上盖 data-surface 章。 */
  color: var(--ui-text-primary-fg);
}

:deep(.right-workbench-body),
:deep(.right-workbench-main) {
  min-width: 0;
  min-height: 0;
}

.workbench-close {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  color: var(--ui-text-muted-fg);
}

/* Empty state has no tab header to host the button, so it floats. */
.workbench-close.is-floating {
  position: absolute;
  z-index: 4;
  top: 7px;
  right: 8px;
}

/* 裸图标钮的 hover 用 8% ink 淡染(主题对称),整块 hover-bg 在这块画线面板上过重 */
.workbench-close:hover {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 8%, transparent);
  color: var(--ui-text-primary-fg);
}

.right-workbench-tabs {
  height: 100%;
}

.right-workbench-tabs :deep(.app-tabs-content) {
  padding: 0;
}

/* 页签条形态「丙 · 正字下划线」(agent-space-workbench.md P4)。
   删掉了基线止点与三边卡尺括号,回到 Tabs.vue 自带的满宽 2px 底线 ——
   工作台的 mono + 括号是给「台面」定的调子,一个人的页上格格不入。
   条更高一档(38px),与面板内那排面签(配置/会话/文件/搜索)拉开层级。 */
.right-workbench-tabs :deep(.app-tabs-tab) {
  min-width: 0;
  padding: 0 13px;
  min-height: 38px;
  font-size: 12.5px;
}

.right-workbench-tabs :deep(.app-tabs-tab.is-active) {
  font-weight: var(--font-weight-semibold, 600);
}

/* 关闭 ✕ 只在活动/悬停时显形,平时不吵。 */
.right-workbench-tabs :deep(.app-tabs-tab .app-tabs-close) {
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.right-workbench-tabs :deep(.app-tabs-tab.is-active .app-tabs-close),
.right-workbench-tabs :deep(.app-tabs-tab:hover .app-tabs-close) {
  opacity: 1;
}

/* 每一格**关在自己的 stacking context 里**(P1 真机走查抓到的相遇性缺陷)。
   面板内容里有自己的 z 分层 —— media 工具条就是 §3 z 表里那条「dropdown+5」
   (105),它比工作台自己的页签选择器(Popover,teleport 到 body,dropdown 档
   100)高。旧架构里这两样**永不共存**(MediaPanel 是盖住聊天的全屏容器,
   workbench 在它旁边),把面板装进 TabPane 之后它们第一次相遇:工具条全局压过
   选择器,选择器下半张被 media 内容盖住,点不动。

   修法是隔离不是加价:pane 一旦是 stacking context,里面的 105 就只在 pane 内
   分层(media 的 kind/source 下拉不 teleport,照旧盖在自己的内容上),对外整格
   按 z-auto 参与根层叠 —— teleport 到 body 的浮层稳稳在上。抬高选择器的 z 是
   军备竞赛:下一个高 z 的面板内容照样赢它。 */
.right-workbench-tabs :deep(.app-tab-pane) {
  height: 100%;
  min-width: 0;
  min-height: 0;
  isolation: isolate;
}

.workbench-tab-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  /* `min-width: 0` 是给**文件名**那种长标签留的:它必须能被截断。 */
  min-width: 0;
  font: inherit;
}

/* 两域之间那道 1px 竖线 —— 只画在右域第一条上,而 `segmentStartTabId` 只在
   左域也非空时才给得出 id(图纸规则①:分隔线只在两域都非空时出现)。
   `-13px` 正好是页签自己的左内边距,于是线落在页签左缘上而不是标签左缘。 */
.workbench-tab-label.is-segment-start::before {
  content: '';
  position: absolute;
  top: 50%;
  left: -13px;
  width: 1px;
  height: 18px;
  margin-top: -9px;
  background: var(--ui-tab-bar-divider-border, var(--ui-border-default-border));
}

/* 线程 / 成员 / 看板这三条是固定短标签(样板 final.html 的常驻三 tab),
   给它们一块地板:右栏一窄,`min-width: 0` 会让页签无下限收缩,中文两个字
   立刻被吃掉一个,真机上显示成「成..」「看..」「线..」。这三条不参与截断,
   宽度不够时由页签条自己横向滚动(它本来就是 overflow: auto)。 */
/* 右栏一窄,页签是**被压扁**的:242px 的右栏里三个页签各 61px,而关闭按钮与
   内边距就吃掉 52px —— 只剩 9px 留给「图标 + 文字」,于是先看到「成..」,再窄
   就只剩图标,最后整条空白。
   给文字加地板治不了这个(9px 且 overflow:hidden 的盒子里,再宽的文字也看不见)。
   真正的修法是**让页签不收缩**:装得下就并排,装不下由页签条横向滚
   (`.app-tabs-nav-scroll` 本来就是 overflow-x: auto)。 */
.right-workbench-tabs :deep(.app-tabs-tab) {
  flex-shrink: 0;
}

/* 固定短标签(线程/成员/看板/调度)不参与截断 —— 文件名那类仍然可以截。 */
.workbench-tab-label.has-fixed-label span {
  min-width: max-content;
  overflow: visible;
  text-overflow: clip;
}

/* 状态点(房间背台退役时一并搬过来的):定宽不缩 —— 它不该跟着标题一起被压扁。
   四档的含义见 `room-tabs.ts`:在跑 / 待你 / 新消息 / 死信。 */
.workbench-tab-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.workbench-tab-dot.is-run {
  background: var(--ui-status-success-fg, var(--color-success));
}

.workbench-tab-dot.is-wait {
  background: var(--ui-status-warning-fg, var(--color-warning));
}

.workbench-tab-dot.is-new {
  background: var(--ui-text-primary-fg);
}

/* 死信:与 wait 分开的一档 —— 等你放行是正常流程的一步,炸了不是。 */
.workbench-tab-dot.is-fault {
  background: var(--ui-status-danger-fg, var(--color-danger));
}

.workbench-tab-label svg,
.picker-option svg,
.empty-action svg {
  flex: 0 0 auto;
  color: var(--workbench-tool-icon-color, currentColor);
  opacity: 0.92;
  transition:
    color var(--duration-normal) var(--ease-default),
    opacity var(--duration-normal) var(--ease-default),
    transform var(--duration-normal) var(--ease-spring);
}

.workbench-tab-label span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 坐标 / 层级 / 外点 / Esc 由 Popover 内核给(锚是 Tabs 的 "+" 钮);面走
   `elevated` 档 + 工作台画线风的方角(实例覆写,见文件末的全局块)。
   这里只剩宽度。删掉的字面投影 `0 14px 34px rgba(0,0,0,.18)` 不跟主题。 */
.workbench-tab-picker {
  width: 220px;
  max-width: min(220px, calc(100vw - 32px));
}

/* 「+」清单里两个域之间的横线 —— 与页签条上那道竖线说的是同一件事。 */
.picker-separator {
  height: 1px;
  margin: 5px 0;
  background: var(--ui-tab-bar-divider-border, var(--ui-border-subtle-border));
}

.right-workbench .picker-option {
  --app-button-fill: transparent;
  --app-button-hover-fill: var(--workbench-tool-card-hover-bg);
  --app-button-hover-border: var(--workbench-tool-card-hover-border);
  --app-button-hover-fg: var(--ui-text-secondary-fg, var(--ui-sidebar-item-hover-fg));
  --app-button-hover-shadow: none;
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border-radius: 0;
  color: var(--ui-text-primary-fg);
  font-size: 12px;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default), box-shadow var(--duration-fast) var(--ease-default);
}

.right-workbench .picker-option:hover {
  background: var(--workbench-tool-card-hover-bg);
  color: var(--ui-text-secondary-fg, var(--ui-sidebar-item-hover-fg));
  box-shadow: none;
}

.right-workbench .picker-option:hover svg,
.right-workbench .picker-option:focus-visible svg,
.right-workbench .empty-action:hover svg,
.right-workbench .empty-action:focus-visible svg {
  color: var(--workbench-tool-icon-color, var(--ui-accent-primary-fg));
  opacity: 1;
  transform: scale(1.1);
}

.right-workbench .picker-option:active {
  --app-button-hover-fill: var(--workbench-tool-card-active-bg);
  --app-button-hover-border: var(--workbench-tool-card-active-border);
  --app-button-hover-shadow: none;
  background: var(--workbench-tool-card-active-bg);
  box-shadow: none;
}

.workbench-empty-state {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted-fg);
  font-size: 13px;
}

/* Empty state reads as a panel with structure, not floating buttons:
   header at the top, tool list rows under it. */
.workbench-empty-state.empty-root {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  padding: 44px 18px 16px;
  box-sizing: border-box;
  counter-reset: wb-tool;
}

.workbench-empty-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.workbench-empty-title {
  color: var(--ledger-label-fg, var(--ui-text-muted-fg));
  font-family: var(--ledger-label-font, var(--font-mono, monospace));
  font-size: var(--ledger-label-size, 10px);
  font-weight: var(--ledger-label-weight, 600);
  letter-spacing: var(--ledger-label-tracking, 0.14em);
  text-transform: uppercase;
}

.workbench-empty-hint {
  color: var(--ui-text-muted-fg);
  font-size: 12px;
}

.workbench-empty-state.compact {
  height: auto;
  flex: 1 1 auto;
}

/* Ledger rows, not filled cards: numbered entries separated by hairlines —
   the grey card blocks were the most default-looking elements on screen. */
.right-workbench .empty-action {
  --app-button-fill: transparent;
  --app-button-hover-fill: var(--ui-state-hover-bg);
  --app-button-border: transparent;
  --app-button-hover-border: transparent;
  --app-button-hover-fg: var(--ui-text-primary-fg);
  --app-button-shadow: none;
  --app-button-hover-shadow: none;
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 9px;
  min-width: 0;
  padding: 0 4px;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 55%, transparent);
  border-radius: 0;
  color: var(--ui-text-muted-fg);
  background: transparent;
  font-size: 12px;
  transition:
    background var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.right-workbench .empty-action::before {
  counter-increment: wb-tool;
  content: counter(wb-tool, decimal-leading-zero);
  flex: 0 0 auto;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
}

.empty-action span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right-workbench .empty-action:hover {
  border-color: var(--workbench-tool-card-hover-border);
  background: var(--workbench-tool-card-hover-bg);
  color: var(--ui-text-secondary-fg, var(--ui-sidebar-item-hover-fg));
  box-shadow: none;
}

.right-workbench .empty-action:active {
  --app-button-hover-fill: var(--workbench-tool-card-active-bg);
  --app-button-hover-border: var(--workbench-tool-card-active-border);
  --app-button-hover-shadow: none;
  border-color: var(--workbench-tool-card-active-border);
  background: var(--workbench-tool-card-active-bg);
  box-shadow: none;
}

/* 角标裁切线:工作面不闭合成框,只画四只角 */
.workbench-terminal,
.workbench-browser {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 6px;
  background:
    linear-gradient(var(--workbench-line), var(--workbench-line)) top 0 left 10px / 10px 1px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) top 0 left 10px / 1px 10px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) top 0 right 2px / 10px 1px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) top 0 right 2px / 1px 10px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) bottom 2px left 10px / 10px 1px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) bottom 2px left 10px / 1px 10px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) bottom 2px right 2px / 10px 1px no-repeat,
    linear-gradient(var(--workbench-line), var(--workbench-line)) bottom 2px right 2px / 1px 10px no-repeat,
    var(--ui-surface-panel-bg);
}

.browser-toolbar {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--ui-border-default-border);
  background: var(--ui-surface-panel-bg);
}

.browser-toolbar input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 0;
  padding: 0 9px;
  background: var(--ui-surface-app-bg);
  color: var(--ui-text-primary-fg);
  outline: none;
}

.browser-toolbar input:focus {
  border-color: var(--workbench-accent);
}

.browser-go {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  color: var(--ui-text-muted-fg);
}

.browser-go:hover {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 8%, transparent);
  color: var(--ui-text-primary-fg);
}

.browser-toolbar {
  order: -1;
  border-top: 0;
  border-bottom: 1px solid var(--ui-border-default-border);
}

.browser-frame {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  border: 0;
  background: white;
}
</style>

<!-- Popover 的根是 Teleport,拿不到本组件的 scoped 作用域(ui-system.md §1)。 -->
<style>
/* 工作台的画线风:方角。面色 / 边框 / 投影走 `elevated` 档。 */
.workbench-tab-picker-surface {
  --app-popover-radius: 0;
}
</style>
