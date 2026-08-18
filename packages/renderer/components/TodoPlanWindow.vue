<template>
  <main class="todo-plan-window">
    <TodoPlanPanel standalone />
  </main>
</template>

<script setup lang="ts">
import TodoPlanPanel from './chat/TodoPlanPanel.vue'
</script>

<style scoped>
/* 窗底 = 形态轨所在的那一层(退后的一档),主区那张更亮的面由 TodoPlanPanel 画。
   两级关系全部从 `--ui-surface-*` 派生,深色主题下"退后/浮起"的方向自动反过来
   仍然成立 —— 硬写两个暖色只在浅色主题里像话。 */
.todo-plan-window {
  --todo-window-radius: 22px;
  --todo-window-bg: color-mix(
    in srgb,
    color-mix(in srgb, var(--ui-surface-elevated-bg) 92%, var(--ui-surface-note-bg, var(--color-warning-bg)) 8%) 86%,
    var(--ui-surface-app-bg) 14%
  );

  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
  border-radius: var(--todo-window-radius);
  background: var(--todo-window-bg);
  isolation: isolate;
}

:deep(.todo-plan-panel) {
  position: absolute;
  inset: 0;
  width: 100vw;
  height: 100vh !important;
  min-height: 0;
  border: 0;
  border-radius: var(--todo-window-radius);
  background: var(--todo-window-bg);
  box-shadow: none;
  backdrop-filter: none;
}

</style>
