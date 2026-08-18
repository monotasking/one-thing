<template>
  <Splitter
    v-if="node.type === 'split'"
    :direction="node.orientation"
    :gap="1"
    class="panel-tree-splitter"
  >
    <SplitterPanel
      v-for="child in node.children"
      :key="child.id"
      v-model:size="child.size"
      :min="12"
    >
      <PanelTree
        :node="child"
        :active-leaf-id="activeLeafId"
        :total-leaf-count="totalLeafCount"
        :first-leaf-id="firstLeafId"
        :reveal-sidebar-toggle="revealSidebarToggle"
        :media-panel-open="mediaPanelOpen"
        :is-inspector-open="isInspectorOpen"
        :reserve-sidebar-actions="reserveSidebarActions"
        :layout-transitioning="layoutTransitioning"
        :register-panel-ref="registerPanelRef"
        @panel-event="$emit('panelEvent', $event)"
      />
    </SplitterPanel>
  </Splitter>

  <ChatWindow
    v-else
    :ref="el => registerPanelRef(node.id, el)"
    :panel-id="node.id"
    :can-close="totalLeafCount > 1"
    :show-sidebar-toggle="node.id === firstLeafId && revealSidebarToggle"
    :media-panel-open="mediaPanelOpen"
    :is-inspector-open="isInspectorOpen"
    :reserve-sidebar-actions="node.id === firstLeafId && reserveSidebarActions"
    :layout-transitioning="layoutTransitioning"
    :panel-focused="totalLeafCount === 1 || node.id === activeLeafId"
    :show-practice-strip="node.id === firstLeafId"
    @pointerdown.capture="$emit('panelEvent', { type: 'focus', leafId: node.id })"
    @split="$emit('panelEvent', { type: 'openSplitSearch', leafId: node.id })"
    @close="$emit('panelEvent', { type: 'closePanel', leafId: node.id })"
    @equalize="$emit('panelEvent', { type: 'equalize', leafId: node.id })"
    @split-with-branch="(sessionId: string) => $emit('panelEvent', { type: 'splitWithBranch', leafId: node.id, sessionId })"
    @toggle-sidebar="$emit('panelEvent', { type: 'toggleSidebar', leafId: node.id })"
    @open-search="$emit('panelEvent', { type: 'openSearch', leafId: node.id })"
    @create-new-chat="$emit('panelEvent', { type: 'createNewChat', leafId: node.id })"
    @toggle-inspector="$emit('panelEvent', { type: 'toggleInspector', leafId: node.id })"
    @open-file="(filePath: string) => $emit('panelEvent', { type: 'openFile', leafId: node.id, filePath })"
    @review-goal="(sessionId: string) => $emit('panelEvent', { type: 'reviewGoal', leafId: node.id, sessionId })"
    @switch-session="(sessionId: string) => $emit('panelEvent', { type: 'switchSession', leafId: node.id, sessionId })"
    @split-drop="(payload: { direction: SplitDirection; sessionId: string; sourcePanelId: string }) => $emit('panelEvent', { type: 'splitDrop', leafId: node.id, ...payload })"
    @open-outline="$emit('panelEvent', { type: 'openOutline', leafId: node.id })"
  />
</template>

<script setup lang="ts">
import Splitter from '@/components/common/Splitter.vue'
import SplitterPanel from '@/components/common/SplitterPanel.vue'
import ChatWindow from './ChatWindow.vue'
import type { SplitDirection, WorkspaceNode } from '@/stores/workspace-tree'
import type { PanelEvent } from './panel-event'

defineOptions({ name: 'PanelTree' })

defineProps<{
  node: WorkspaceNode
  activeLeafId: string
  totalLeafCount: number
  firstLeafId: string
  revealSidebarToggle?: boolean
  mediaPanelOpen?: boolean
  isInspectorOpen?: boolean
  reserveSidebarActions?: boolean
  layoutTransitioning?: boolean
  registerPanelRef: (id: string, el: unknown) => void
}>()

defineEmits<{
  panelEvent: [payload: PanelEvent]
}>()
</script>

<style scoped>
.panel-tree-splitter {
  display: flex;
  flex: 1;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Splitting/closing a panel changes flex-basis/flex-grow, which forces a
   synchronous layout recalc on every animation frame — with heavy panel
   content (virtualized message lists, box-shadow panels) that visibly
   janks. A snappy, non-animated resize reads better here than the stutter. */
.panel-tree-splitter :deep(.splitter-panel) {
  transition: none;
}

/* 墨线:面板间的分隔线常驻可见一道极细的线,而不是一条空白的宽间隔带。
   Splitter 自带的 hover/active 态(变 currentColor)已经够用,这里只补默认态。 */
.panel-tree-splitter :deep(.splitter-resizer-line) {
  background: color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}
</style>
