<template>
  <header
    ref="headerRef"
    :class="['session-header', { 'with-traffic-lights': showSidebarToggle, 'media-panel-open': mediaPanelOpen }]"
  >
    <!-- Left: traffic lights reserved + 会话标题 -->
    <div class="session-header-left">
      <!-- 侧栏收起时,三颗操作按钮住在这里 —— 是 .session-header(drag)的真实
           子孙,所以按钮自己的 no-drag 才挖得动洞,不再需要按坐标预留一块死区。
           左边这段只是给交通灯让位的普通盒子,不带 app-region,自然回退到 drag。 -->
      <div
        :class="[
          'topbar-sidebar-actions-slot',
          {
            reserved: showSidebarToggle || reserveSidebarActions,
            'media-panel-open': mediaPanelOpen,
          },
        ]"
      >
        <div
          class="topbar-traffic-lights-space"
          aria-hidden="true"
        />
        <SidebarActionGroup
          v-if="showSidebarToggle || reserveSidebarActions"
          :sidebar-visible="false"
          variant="topbar"
          @toggle-sidebar="emit('toggleSidebar')"
          @open-search="emit('openSearch')"
          @create-new-chat="emit('createNewChat')"
        />
      </div>

      <!-- 会话标题。多页签退役后这里只有一条会话(U1),双击改名 —— 沿用页签时代
           的那套交互,只是宿主从 TabItem 换成了这一行。 -->
      <div class="session-title-wrap">
        <input
          v-if="renaming"
          ref="renameInputRef"
          v-model="renameDraft"
          class="session-title-input"
          type="text"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        >
        <button
          v-else
          type="button"
          class="session-title"
          :class="{ 'is-cold': isCold }"
          @dblclick="startRename"
        >
          <AgentAvatar
            v-if="agentDisplay"
            class="session-title-avatar"
            aria-hidden="true"
            :avatar="agentDisplay.avatar"
            :avatar-image="agentDisplay.avatarImage"
            :size="18"
          />
          <span class="session-title-text">{{ displayName }}</span>
        </button>
        <!-- 改名入口。标题本身是 drag 区(拖窗要吃掉鼠标事件,双击到不了这里),
             所以给一颗 hover 才现身的小笔;桌面上双击 = 系统的标题栏缩放。 -->
        <button
          v-if="!renaming"
          type="button"
          class="session-title-rename"
          aria-label="Rename session"
          @click.stop="startRename"
        >
          <Pencil :size="12" />
        </button>
      </div>

      <div
        class="session-header-drag-spacer"
        aria-hidden="true"
      />
    </div>

    <!-- Right: action buttons. Unfocused split panels collapse to just the
         title; clicking anywhere in a panel focuses it. Focused panels degrade
         by tier: full → mid (no agent selector) → slim (single ⋯ menu).

         房 / 私聊走的是 `RoomHeader`,不是这一条 —— 成员条、看板、房设置、
         dm 身份块随 U1 一起从这里拿掉了(它们在这里恒不可达:本组件只在
         `kind !== 'room'` 时挂载)。 -->
    <div class="session-header-right">
      <AgentSelector
        v-if="showAgentSelector && sessionId"
        :session-id="sessionId"
      />
      <span
        v-if="showAgentSelector && sessionId"
        class="header-tick"
        aria-hidden="true"
      />

      <Tooltip
        v-if="showActionButtons && isBranchSession"
        text="Back to parent chat"
        position="bottom"
      >
        <Button
          unstyled
          class="header-btn back-btn"
          aria-label="Back to parent chat"
          @click="emit('goToParent')"
        >
          <ArrowLeft
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <Tooltip
        v-if="showActionButtons && showSplitButton"
        text="Split view"
        position="bottom"
      >
        <Button
          unstyled
          class="header-btn"
          aria-label="Split view"
          @click="emit('split')"
        >
          <Columns2
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <Tooltip
        v-if="showActionButtons && canClose"
        text="Equalize panels"
        position="bottom"
      >
        <Button
          unstyled
          class="header-btn"
          aria-label="Equalize panels"
          @click="emit('equalize')"
        >
          <Equal
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <!-- 关掉这一格。`canClose` 就是「屏幕上还有别的格子」,所以只有分栏之后
           才出现 —— 独栏没有可关的东西(窗口去留归 ⌘W / 主进程菜单)。 -->
      <Tooltip
        v-if="showActionButtons && canClose"
        text="Close panel"
        position="bottom"
      >
        <Button
          unstyled
          class="header-btn"
          aria-label="Close panel"
          @click="emit('close')"
        >
          <X
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <!-- L3:这颗钮从前开合的是第四列大纲栏,现在它开右栏的 Contents 页签
           —— 大纲只剩右栏一个落点,按钮也就只剩"带我去"这一个语义(没有
           "收起"这回事:那归右栏自己的关闭钮)。 -->
      <Tooltip
        v-if="showActionButtons"
        text="Contents"
        position="bottom"
      >
        <Button
          unstyled
          class="header-btn outline-toggle"
          aria-label="Contents"
          @click="emit('openOutline')"
        >
          <AlignLeft
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <Tooltip
        v-if="showActionButtons"
        text="Show workbench"
        position="bottom"
      >
        <Button
          unstyled
          :class="['header-btn', 'inspector-toggle', { hidden: isInspectorOpen }]"
          aria-label="Show workbench"
          @click="emit('toggleInspector')"
        >
          <PanelRightOpen
            :size="14"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>

      <div
        v-if="showOverflowMenu"
        ref="moreRef"
        class="header-more"
      >
        <Tooltip
          text="More actions"
          position="bottom"
        >
          <Button
            unstyled
            class="header-btn"
            aria-label="More actions"
            @click="toggleMoreMenu"
          >
            <Ellipsis
              :size="14"
              :stroke-width="2"
            />
          </Button>
        </Tooltip>
      </div>
    </div>

    <!-- slim 档的 ⋯ 菜单,锚在按钮下方 -->
    <ContextMenu
      :show="moreOpen"
      :x="moreAnchor.x"
      :y="moreAnchor.y"
      :items="overflowItems"
      @select="onOverflowSelect"
      @close="moreOpen = false"
    />
  </header>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  AlignLeft,
  ArrowLeft,
  Columns2,
  Ellipsis,
  Equal,
  PanelRightOpen,
  Pencil,
  X,
} from 'lucide-vue-next'
import AgentSelector from './AgentSelector.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import SidebarActionGroup from '@/components/sidebar/SidebarActionGroup.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/context-menu'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { isAgentExecutionSession, resolveAgentSessionDisplay } from '@/utils/agent-sessions'

const props = defineProps<{
  sessionId?: string
  panelId?: string
  sessionName?: string
  /** null = cache membership unknown (no marking); Set = evicted sessions get the cold mark. */
  cachedSessionIds: Set<string> | null
  isBranchSession: boolean
  showSidebarToggle: boolean
  mediaPanelOpen?: boolean
  showSplitButton: boolean
  canClose: boolean
  isInspectorOpen?: boolean
  reserveSidebarActions?: boolean
  /** False for split panels that don't own focus: only the title stays. */
  panelFocused?: boolean
}>()

const emit = defineEmits<{
  renameSession: [sessionId: string, name: string]
  toggleSidebar: []
  openSearch: []
  createNewChat: []
  goToParent: []
  split: []
  close: []
  equalize: []
  toggleInspector: []
  /** 顶栏那颗「Contents」钮 —— 落点是右栏的 outline 页签(L3)。 */
  openOutline: []
}>()

// ── 标题 ────────────────────────────────────────────────────────────────────
//
// Agent 执行会话(W20)显示 agent 头像章 + agent **现名**,而不是会话文件里
// 冻结的「[执行] 小李」。懒取 store:本组件的单测不挂 pinia。
const agentDisplay = computed<{ name: string; avatar: string; avatarImage?: string } | null>(() => {
  if (!props.sessionId) return null
  try {
    const session = useSessionsStore().sessions.find(item => item.id === props.sessionId)
    if (!isAgentExecutionSession(session)) return null
    return resolveAgentSessionDisplay(session!, useAgentsStore().agents)
  } catch {
    return null
  }
})

const displayName = computed(() => agentDisplay.value?.name || props.sessionName || 'New Chat')

/** 会话被逐出内存缓存 —— 沿用页签时代的冷标记(null = 不知道,就不标)。 */
const isCold = computed(() =>
  !!props.sessionId && props.cachedSessionIds !== null && !props.cachedSessionIds.has(props.sessionId),
)

const renaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

function startRename() {
  if (!props.sessionId) return
  renameDraft.value = props.sessionName || ''
  renaming.value = true
  void nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function cancelRename() {
  renaming.value = false
}

function commitRename() {
  if (!renaming.value) return
  const next = renameDraft.value.trim()
  renaming.value = false
  if (next && next !== (props.sessionName || '') && props.sessionId) {
    emit('renameSession', props.sessionId, next)
  }
}

// 换会话时把改名态收掉:输入框不该跟着停在下一条会话上。
watch(() => props.sessionId, () => { renaming.value = false })

// ── 阶梯降级 ────────────────────────────────────────────────────────────────
//
// full(全按钮)→ mid(收起 agent 选择器)→ slim(动作组折进一粒 ⋯ 菜单)。
// 阈值与页签时代同值:标题本身是弹性的,兜住的仍是按钮组那条底线。
const MID_WIDTH = 560
const SLIM_WIDTH = 400
const RESERVED_EXTRA = 160

const headerRef = ref<HTMLElement | null>(null)
const headerWidth = ref(Number.POSITIVE_INFINITY)
let headerResizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return
  if (headerRef.value) {
    headerResizeObserver = new ResizeObserver((entries) => {
      headerWidth.value = entries[0]?.contentRect.width ?? Number.POSITIVE_INFINITY
    })
    headerResizeObserver.observe(headerRef.value)
  }
})

onBeforeUnmount(() => {
  headerResizeObserver?.disconnect()
  headerResizeObserver = null
})

const tier = computed<'full' | 'mid' | 'slim'>(() => {
  const extra = props.showSidebarToggle || props.reserveSidebarActions ? RESERVED_EXTRA : 0
  if (headerWidth.value < SLIM_WIDTH + extra) return 'slim'
  if (headerWidth.value < MID_WIDTH + extra) return 'mid'
  return 'full'
})

const focused = computed(() => props.panelFocused !== false)
const showAgentSelector = computed(() => focused.value && tier.value === 'full')
const showActionButtons = computed(() => focused.value && tier.value !== 'slim')
const showOverflowMenu = computed(() => focused.value && tier.value === 'slim')

// ── slim 档的 ⋯ 菜单 ────────────────────────────────────────────────────────
const moreRef = ref<HTMLElement | null>(null)
const moreOpen = ref(false)
const moreAnchor = ref({ x: 0, y: 0 })

function toggleMoreMenu() {
  if (moreOpen.value) {
    moreOpen.value = false
    return
  }
  const rect = moreRef.value?.getBoundingClientRect()
  if (rect) moreAnchor.value = { x: rect.left, y: rect.bottom + 6 }
  moreOpen.value = true
}

const overflowItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = []
  if (props.isBranchSession) items.push({ id: 'parent', label: 'Back to parent chat', icon: ArrowLeft })
  if (props.showSplitButton) items.push({ id: 'split', label: 'Split view', icon: Columns2 })
  if (props.canClose) items.push({ id: 'equalize', label: 'Equalize panels', icon: Equal })
  if (props.canClose) items.push({ id: 'close', label: 'Close panel', icon: X })
  items.push({ id: 'outline', label: 'Contents', icon: AlignLeft })
  if (!props.isInspectorOpen) items.push({ id: 'inspector', label: 'Show workbench', icon: PanelRightOpen })
  return items
})

function onOverflowSelect(action: string) {
  switch (action) {
    case 'parent': emit('goToParent'); break
    case 'split': emit('split'); break
    case 'equalize': emit('equalize'); break
    case 'close': emit('close'); break
    case 'outline': emit('openOutline'); break
    case 'inspector': emit('toggleInspector'); break
  }
}

watch(showOverflowMenu, (shown) => {
  if (!shown) moreOpen.value = false
})
</script>

<style scoped>
/* 几何与 drag 语义逐字承自页签时代的 `.tab-bar`:40px 高、整条打底可拖窗、
   底边一条墨线。改的只是左边装什么(一条标题,不是一排页签)。 */
.session-header {
  --ot-active-text: var(--ui-tab-bar-item-active-fg, var(--ui-text-primary-fg));
  --ot-divider: var(--ui-tab-bar-divider-border, color-mix(in srgb, var(--ui-border-subtle-border, var(--ui-border-default-border)) 70%, var(--ui-text-muted-fg)));

  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  padding: 0 10px 0 0;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  background: var(--ui-tab-bar-surface-bg, var(--ui-surface-chat-bg));
  box-shadow: var(--ui-tab-bar-surface-shadow, none);
  /* 整条顶栏打底可拖窗:标题 / 按钮 / agent 选择器各自 no-drag 盖回。
     app-region 只算 content box,所以这些控件的间隙与内边距会回退到这层 drag,
     无需逐块补 spacer —— 空白处皆可拖。 */
  -webkit-app-region: drag;
}

/* 基线墨线 */
.session-header::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 1px;
  background: color-mix(in srgb, var(--ui-tab-bar-divider-border, var(--ui-border-subtle-border)) 32%, transparent);
  pointer-events: none;
  z-index: 0;
}

/*
  Layout-bound sidebar action reservation.
  This slot is always mounted so the header reserves titlebar action space
  after the app layout has settled. Width changes stay discrete to avoid
  relayouting the message list on every sidebar toggle frame.
  Expanded sidebar: slot width 0, panel is pushed by sidebar width.
  Collapsed sidebar: slot reserves titlebar/traffic-light + action-group space.
*/
/* 按钮的宿主。整块不带 app-region:里面只有按钮自己 no-drag,交通灯让位区和
   按钮之间的缝隙都回退到 .session-header 的 drag —— 顶栏空白处处可拖。 */
.topbar-sidebar-actions-slot {
  display: flex;
  align-items: center;
  align-self: stretch;
  flex-shrink: 0;
  transition: none;
}

/* 交通灯让位:收起态下顶栏顶到窗口左缘,红绿灯就压在这一段上。 */
.topbar-traffic-lights-space {
  width: 0;
  flex: 0 0 auto;
  align-self: stretch;
}

.topbar-sidebar-actions-slot.reserved .topbar-traffic-lights-space {
  width: 84px;
}

/* 媒体面板打开时顶栏不再顶到窗口左缘,红绿灯压在面板上,这里只留一点呼吸。 */
.topbar-sidebar-actions-slot.reserved.media-panel-open .topbar-traffic-lights-space {
  width: 10px;
}

/* ── Left: 会话标题 ──────────────────── */
.session-header-left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  align-self: stretch;
  position: relative;
  z-index: 1;
}

.session-title-wrap {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
  /* 长标题不许把整条头栏吃掉:封顶,超出省略。 */
  max-width: min(360px, 50%);
  padding: 0 10px 0 12px;
  gap: 4px;
}

.session-title {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ot-active-text);
  cursor: default;
  /* 标题**可拖窗**(2026-08-17 现场:标题一长,头栏左半整块拖不动)。改名走
     旁边那颗小笔,不再靠双击 —— 拖拽区里的鼠标事件被原生层吃掉,双击到不了 DOM。 */
  -webkit-app-region: drag;
}

.session-title-rename {
  appearance: none;
  border: 0;
  padding: 0;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs, 4px);
  background: transparent;
  color: var(--ui-text-muted-fg);
  /* 常显一枚淡笔,不靠 hover:拖拽区里 hover 是否可靠取决于原生层。 */
  opacity: 0.45;
  cursor: pointer;
  transition: opacity var(--duration-fast) var(--ease-default), background-color var(--duration-fast) var(--ease-default);
  -webkit-app-region: no-drag;
}

.session-title-wrap:hover .session-title-rename,
.session-title-rename:focus-visible {
  opacity: 1;
}

.session-title-rename:hover {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
}

.session-title-avatar {
  flex: 0 0 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-title-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 逐出内存缓存的会话:标题退成次要墨(与页签时代的冷标记同义)。 */
.session-title.is-cold .session-title-text {
  color: var(--ui-text-muted-fg);
}

.session-title-input {
  min-width: 0;
  max-width: 320px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-strong-border);
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ui-text-primary-fg);
  outline: none;
  -webkit-app-region: no-drag;
}

.session-header-drag-spacer {
  flex: 1;
  min-width: 24px;
  align-self: stretch;
  -webkit-app-region: drag;
}

/* ── Right: action buttons ───────── */
.session-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 60px;
  flex-shrink: 0;
  gap: 8px;
  padding-left: 14px;
  position: relative;
  z-index: 1;
  /* 不整块 no-drag:否则按钮之间的 gap/内边距也被盖成不可拖。
     交由内部 .header-btn / AgentSelector 各自 no-drag,空隙回退到 drag。 */
}

/* 座标底线(案 A):按钮无底色,悬停变墨并在基线上落一小段点线 */
.header-btn {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  border-radius: 0;
  color: var(--ui-tab-bar-action-fg, var(--ui-text-muted-fg));
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition:
    color var(--duration-fast) var(--ease-default),
    transform var(--duration-fast) var(--ease-default);
}

.header-btn::after {
  content: '';
  position: absolute;
  right: 7px;
  bottom: -6px;
  left: 7px;
  height: 0;
  border-bottom: 1.5px dotted transparent;
  transition: border-color var(--duration-fast) var(--ease-default);
  pointer-events: none;
}

.header-btn:hover {
  color: var(--ui-tab-bar-action-hover-fg, var(--ui-text-primary-fg));
}

.header-btn:hover::after {
  border-bottom-color: color-mix(in srgb, var(--ui-text-muted-fg) 75%, transparent);
}

.header-btn:active {
  transform: translateY(1px);
}

/* 竖刻:agent 与按钮组之间的分隔 */
.header-tick {
  flex: 0 0 auto;
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: color-mix(in srgb, var(--ui-border-strong-border) 85%, transparent);
}

.header-btn.back-btn {
  color: var(--ui-tab-bar-item-active-fg, var(--ui-text-primary-fg));
}

.header-btn.inspector-toggle {
  transition: background var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default),
              opacity var(--duration-slow) var(--ease-default),
              width var(--duration-slow) var(--ease-default),
              margin-left var(--duration-slow) var(--ease-default);
}

.inspector-toggle.hidden {
  width: 0;
  margin-left: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
}

/* ── slim 档:⋯ 溢出菜单 ─────────── */
.header-more {
  position: relative;
}
</style>
