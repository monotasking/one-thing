<template>
  <div class="chat-container-wrapper">
    <!-- Hover trigger for floating sidebar -->
    <div
      v-if="showHoverTrigger"
      class="sidebar-hover-trigger"
      @mouseenter="$emit('show-floating-sidebar')"
      @mouseleave="$emit('hide-floating-sidebar')"
    />

    <div
      ref="chatPanelsRootRef"
      class="chat-panels"
    >
      <Container
        main-class="chat-panels-main"
        full-height
        overflow="hidden"
        main-overflow="hidden"
      >
        <!-- Empty state when nothing is open -->
        <div
          v-if="!workspaceStore.hasAnySession"
          class="empty-state"
        >
          <div class="empty-state-content">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <h3>No Active Chat</h3>
            <p>Start a new conversation to begin</p>
            <Button
              unstyled
              class="new-chat-btn"
              @click="createNewSession"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Chat
            </Button>
          </div>
        </div>
        <!-- Chat panels whenever anything is open. Keyed off the workspace
             store (not currentSessionId): tab/panel state lives in the store,
             so this v-if flipping only toggles the view, never the state. -->
        <PanelTree
          v-if="workspaceStore.hasAnySession"
          class="chat-panels-tree"
          :node="workspaceStore.root"
          :active-leaf-id="workspaceStore.activeLeafId"
          :total-leaf-count="workspaceStore.leaves.length"
          :first-leaf-id="workspaceStore.leaves[0]?.id ?? ''"
          :reveal-sidebar-toggle="revealSidebarToggle"
          :media-panel-open="mediaPanelOpen"
          :is-inspector-open="isInspectorOpen"
          :reserve-sidebar-actions="reserveSidebarActions"
          :layout-transitioning="layoutTransitioning"
          :register-panel-ref="setPanelRef"
          @panel-event="handlePanelEvent"
        />
      </Container>
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { computed, ref, nextTick } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { platformApi } from '@/platform'
import { sessionsApi } from '@/platform/sessions-client'
import ChatWindow from '@/components/chat/ChatWindow.vue'
import PanelTree from '@/components/chat/PanelTree.vue'
import Container from '@/components/common/Container.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { SplitDirection } from '@/stores/workspace-tree'
import type { PanelEvent } from '@/components/chat/panel-event'

const props = defineProps<{
  sidebarCollapsed?: boolean
  sidebarFloating?: boolean
  showHoverTrigger?: boolean
  mediaPanelOpen?: boolean
  isInspectorOpen?: boolean
  reserveSidebarActions?: boolean
  layoutTransitioning?: boolean
}>()

const emit = defineEmits<{
  'toggle-sidebar': []
  'open-search': []
  'create-new-chat': []
  'show-floating-sidebar': []
  'hide-floating-sidebar': []
  'toggle-inspector': []
  /** 顶栏那颗「Contents」钮 —— 落点是右栏的 outline 页签(L3)。 */
  'open-outline': []
  'open-file': [filePath: string]
  'review-goal': [sessionId: string]
}>()

const sessionsStore = useSessionsStore()
const chatStore = useChatStore()

// Panel refs for focusing input, keyed by leaf id
const panelRefs = ref<Record<string, InstanceType<typeof ChatWindow> | null>>({})

function setPanelRef(id: string, el: unknown) {
  panelRefs.value[id] = el as InstanceType<typeof ChatWindow> | null
}

// Only the first (leftmost/topmost) leaf reserves titlebar space for the
// collapsed-sidebar toggle button.
const revealSidebarToggle = computed(() => !!props.sidebarCollapsed && !props.sidebarFloating)

// Split tree + tabs live in the workspace store (single owner, persisted as
// one tree); this component is a view over it.
const workspaceStore = useWorkspaceStore()

/*
 * 大纲栏(ChatSidePanel)这一列在 L3 整条退役:它的四段搬进右栏会话域的两条
 * 页签(Contents / Context),于是这里既不再有 `Container` 的 sidebar 插槽,
 * 也不再有 `chatSidePanelWidth` / `chatSideCollapsed` / outlineTarget 那条
 * 五层 prop 链。大纲轨的宿主改由 `composables/useOutlineRail.ts` 那枚模块级
 * ref 登记,聊天面每一格自己按"轮不轮得到我"去取(见 ChatWindow.vue)。
 */
const chatPanelsRootRef = ref<HTMLElement | null>(null)

// Split goes through the Search Everywhere window: it opens locked to Chats
// with a split intent, and the chosen session comes back via search:action.
function openSplitSearch(leafId: string) {
  void platformApi.toggleSearchWindow({ intent: { type: 'split-panel', panelId: leafId } })
}

// Split a leaf - create a new leaf with the selected session. Public method:
// called by App.vue's Search Everywhere split flow with the legacy
// (leafId, sessionId) signature, so it keeps defaulting to a right split.
// The new leaf becomes active, so the workspace effect switches to (and
// loads) the session.
function splitPanel(leafId: string, sessionId: string) {
  workspaceStore.splitLeaf(leafId, sessionId, 'right')
}

/**
 * 关掉一格分栏。store 拒绝关掉最后一格 —— 工作区永远得留一格在屏幕上(空了就是
 * 空态屏),窗口的去留归 ⌘W / 主进程菜单管。
 *
 * `releasedSessionIds` = 这一格里坐着、且没有别的格子还在显示的会话:草稿直接丢,
 * 正式会话把主进程那份缓存释放掉(承自页签时代的关页签语义)。
 */
async function closePanel(leafId: string) {
  const result = workspaceStore.closeLeaf(leafId)
  if (!result) return
  for (const sessionId of result.releasedSessionIds) {
    if (sessionsStore.isNewChatDraftId(sessionId)) {
      sessionsStore.discardNewChatDraft(sessionId)
    } else {
      await sessionsApi.evictCache({ sessionId }).catch(() => {})
    }
  }
}

async function switchLeafSession(leafId: string, sessionId: string) {
  workspaceStore.openSession(sessionId, { leafId })
}

function handleSplitDrop(leafId: string, sessionId: string, sourcePanelId: string, direction: SplitDirection) {
  const newLeafId = workspaceStore.splitLeaf(leafId, sessionId, direction)
  if (!newLeafId) return
  // The session moved panels: drop its tab in the source leaf only. It is
  // still open (in the new leaf), so no cache eviction is involved.
  workspaceStore.closeSession(sessionId, { onlyLeafId: sourcePanelId })
}

// Every ChatWindow (at any depth in the tree) funnels its events through a
// single `panel-event` bubbled up by PanelTree, tagged with its own leaf id.
function handlePanelEvent(event: PanelEvent) {
  switch (event.type) {
    case 'focus':
      workspaceStore.setActiveLeaf(event.leafId)
      break
    case 'openSplitSearch':
      openSplitSearch(event.leafId)
      break
    case 'closePanel':
      void closePanel(event.leafId)
      break
    case 'equalize':
      workspaceStore.equalizeSiblings(event.leafId)
      break
    case 'splitWithBranch':
      splitPanel(event.leafId, event.sessionId)
      break
    case 'switchSession':
      void switchLeafSession(event.leafId, event.sessionId)
      break
    case 'splitDrop':
      handleSplitDrop(event.leafId, event.sessionId, event.sourcePanelId, event.direction)
      break
    case 'openOutline':
      emit('open-outline')
      break
    case 'toggleSidebar':
      emit('toggle-sidebar')
      break
    case 'openSearch':
      emit('open-search')
      break
    case 'createNewChat':
      emit('create-new-chat')
      break
    case 'toggleInspector':
      emit('toggle-inspector')
      break
    case 'openFile':
      emit('open-file', event.filePath)
      break
    case 'reviewGoal':
      emit('review-goal', event.sessionId)
      break
  }
}

// Create new session from empty state
async function createNewSession() {
  sessionsStore.openNewChatDraft('New Chat')
  await nextTick()
  focusInput()
}

// Focus input of the currently focused panel.
function focusInput() {
  let attempts = 0
  const maxAttempts = 4
  const focus = () => {
    attempts += 1
    const activeLeafId = workspaceStore.activeLeafId
    if (panelRefs.value[activeLeafId]) {
      panelRefs.value[activeLeafId]?.focusInput()
    }
    if (attempts >= maxAttempts) return
    nextTick(() => {
      const scheduleFrame = globalThis.requestAnimationFrame || ((callback: FrameRequestCallback) => window.setTimeout(callback, 0))
      scheduleFrame(focus)
    })
  }
  focus()
}

function insertPromptReference(promptId: string) {
  const activeLeafId = workspaceStore.activeLeafId
  panelRefs.value[activeLeafId]?.insertPromptReference(promptId)
}

// Open a file in the app-level right workbench.
function openFileTab(filePath: string) {
  emit('open-file', filePath)
}

async function jumpToMessage(sessionId: string, messageId: string) {
  // Prefer a leaf that already shows the session; otherwise seat it in the
  // focused one. Focusing first means the explicit switch below reuses that
  // exact leaf.
  const leaf = workspaceStore.leaves.find(l => l.sessionId === sessionId)
    ?? workspaceStore.activeLeaf
  if (!leaf) return false
  workspaceStore.openSession(sessionId, { leafId: leaf.id })

  if (sessionsStore.currentSessionId !== sessionId) {
    await sessionsStore.switchSession(sessionId)
    await nextTick()
  }
  if (sessionsStore.currentSessionId !== sessionId) return false
  await nextTick()

  const hasLoadedMessage = () => {
    return (chatStore.sessionMessages.get(sessionId) || []).some(message => message.id === messageId)
  }

  if (!hasLoadedMessage()) {
    const loaded = await chatStore.loadMessagesAround(sessionId, messageId)
    if (!loaded) return false
    await nextTick()
  }

  return panelRefs.value[leaf.id]?.scrollToMessage?.(messageId) ?? false
}

// 页签时代那两条快捷键(⌘1..9 切页签、⌘W 关页签)随 U2 一起没了:一格一条会话,
// 关一格走 header 的 ✕ / ⋯ 菜单,⌘W 回归系统的关窗口。
// Expose methods
defineExpose({
  focusInput,
  insertPromptReference,
  openFileTab,
  jumpToMessage,
  splitPanel,
})
</script>

<style scoped>
.chat-container-wrapper {
  flex: 1;
  height: 100%;
  padding: 0;
  background: var(--ui-surface-app-bg);
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
  overflow: hidden;
}

/* Hover trigger for floating sidebar */
.sidebar-hover-trigger {
  position: absolute;
  left: 0;
  top: 40px;
  width: 12px;
  height: calc(100% - 40px);
  -webkit-app-region: no-drag;
  cursor: pointer;
  z-index: var(--z-sticky);
}

.chat-panels {
  flex: 1;
  display: flex;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.chat-panels :deep(.chat-panels-main) {
  display: flex;
  flex: 1 1 0;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-panels-tree {
  flex: 1;
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/*
 * 这两块和 ChatWindow 一样铺满内容区、四边贴死窗口边,所以它们的 border /
 * radius / 投影画的其实是"窗口边框",不是卡片:圆角撞上窗口的直角、外投影被
 * 祖先 overflow:hidden 裁掉、border 又和系统投影叠成一条粗边(而且 84% 比
 * ChatWindow 那条 52% 更深,空状态下窗口边看着比聊天里还重)。
 * 卡片语义在这里没有立足点 —— 只留底色,窗口边交给系统投影收口。
 */
/* Full page container for CreateAgent, etc. */
.full-page-container {
  flex: 1;
  display: flex;
  background: var(--ui-surface-chat-bg);
  overflow: hidden;
}

/* Empty state when no sessions */
.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ui-surface-chat-bg);
  position: relative;
  -webkit-app-region: drag;
  overflow: hidden;
}

.empty-state-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--ui-text-muted-fg);
  text-align: center;
  -webkit-app-region: no-drag;
}

.empty-state-content svg {
  opacity: 0.5;
}

.empty-state-content h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

.empty-state-content p {
  margin: 0;
  font-size: 14px;
}

.new-chat-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 10px 20px;
  background: var(--ui-action-primary-bg, var(--ui-accent-primary-fg));
  color: var(--ui-action-primary-fg, var(--ui-text-inverse-fg));
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  -webkit-app-region: no-drag;
}

.new-chat-btn:hover {
  background: var(--ui-action-primary-hover-bg, var(--ui-action-primary-bg));
  transform: translateY(-1px);
}
</style>
