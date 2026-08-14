<template>
  <ToolStepDetails
    :view="detailView"
    :wrap="true"
  />

  <!-- 「检查」入口(主线 E1)。这条卡片与轨迹面板是同一份事件窗口的两次装配,
       所以入口只做一件事:把 {sessionId, callId} 写进 one-shot handoff 并请求
       开页签,定位交给面板在数据层做。没有 callId(旧消息、合成 step)就不画 ——
       画一个点了没反应的入口比没有入口更糟。 -->
  <div
    v-if="inspectCallId"
    class="tool-inspect-entry"
  >
    <button
      type="button"
      class="tool-inspect-action"
      @click="openInspect"
    >
      检查
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolActivityView } from '@/stores/helpers/tool-activity-view'
import { buildDetailedToolStepView } from '@/stores/helpers/tool-activity-view'
import { requestTrajectoryInspect } from '@/workspace/trajectory-inspect'
import ToolStepDetails from './ToolStepDetails.vue'

const props = withDefaults(defineProps<{
  activity: ToolActivityView
  /** 这条卡片属于哪条会话(线程详情里可能不是当前会话)。 */
  sessionId?: string
}>(), {
  sessionId: '',
})

const detailView = computed(() => buildDetailedToolStepView(props.activity))

const inspectCallId = computed(() => props.activity.step?.toolCallId || '')

function openInspect(): void {
  requestTrajectoryInspect({ sessionId: props.sessionId, callId: inspectCallId.value })
}
</script>

<style scoped>
.tool-inspect-entry {
  display: flex;
  justify-content: flex-end;
  padding: 2px 2px 0;
}

.tool-inspect-action {
  padding: 1px 4px;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.tool-inspect-action:hover {
  color: var(--ui-accent-primary-fg);
}

.tool-inspect-action:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}
</style>
