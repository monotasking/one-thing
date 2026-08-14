<template>
  <div class="panel-shell">
    <div
      v-if="$slots.controls"
      class="panel-shell-controls"
    >
      <slot name="controls" />
    </div>

    <div
      class="panel-shell-body"
      :class="{ 'is-scroll': scroll, 'is-padded': padded }"
    >
      <slot />
    </div>

    <div
      v-if="hasStatus"
      class="panel-shell-status"
      :class="{ 'is-flush': statusFlush }"
    >
      <span
        v-if="busy"
        class="panel-shell-spinner"
        aria-hidden="true"
      />
      <slot name="status">
        {{ statusText }}
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PanelShell —— 六个工作区面板共享的四层骨架:控制条 / 内容区 / 26px 状态条。
 *
 * 三条约束写在这里,而不是各面板自己抄:
 *  · 控制条与状态条是 `flex: none`,只有内容区伸缩 —— 面板再长也不会把状态条挤出视口;
 *  · 内容区默认自带滚动与左右 14px 留白;自己接管滚动的面板(虚拟列表、内嵌 table)
 *    传 `:scroll="false"` / `:padded="false"` 关掉,而不是在里面套第二层 overflow;
 *  · **spinner 只有这里有**。全面板唯一允许的忙碌指示就是状态条里这枚 11px 环
 *    (设计稿 Turn 5 的裁决:内容区放 spinner 会和骨架屏打架)。别的地方要表达加载,
 *    用透明度递减的骨架块。
 *
 * 状态条高度是**默认值不是硬约束**:`height` 写成 `min-height`,`status` 槽塞进更高的
 * 内容(Music 的 44px 播放条)时整条跟着长高;那种全出血的内容再配 `status-flush`
 * 去掉左右内边距。
 */
import { computed, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  /** 状态条左侧显示 11px 旋转环。全应用唯一允许 spinner 的位置。 */
  busy?: boolean
  /** 状态条默认文案;`status` 槽给了内容就以槽为准。 */
  statusText?: string
  /** 状态条去掉左右 14px 内边距,给全出血的自定义内容(如 44px 播放条)用。 */
  statusFlush?: boolean
  /** 内容区自带纵向滚动。面板自己接管滚动时关掉。 */
  scroll?: boolean
  /** 内容区自带 `0 14px 16px` 留白。内容自己贴边时关掉。 */
  padded?: boolean
}>(), {
  busy: false,
  statusText: '',
  statusFlush: false,
  scroll: true,
  padded: true,
})

const slots = useSlots()

const hasStatus = computed(() => Boolean(slots.status) || props.busy || props.statusText.length > 0)
</script>

<style scoped>
.panel-shell {
  /* sticky 子件(LedgerGroupHeader)要一枚不透明底才能遮住滚过去的内容,
     但区域面的底归 Surface 档位画(ui-system §4 surface-literal)——
     所以这里只**声明**一个变量,不落笔涂底。 */
  --panel-shell-bg: var(--ui-surface-panel-bg);

  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.panel-shell-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 9px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.panel-shell-body {
  flex: 1;
  min-height: 0;
}

.panel-shell-body.is-scroll {
  overflow-y: auto;
}

.panel-shell-body.is-padded {
  padding: 0 14px 16px;
}

.panel-shell-status {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  padding: 0 14px;
  border-top: 1px solid var(--ui-border-subtle-border);
  background: var(--ui-surface-sidebar-bg);
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ui-text-muted-fg);
}

.panel-shell-status.is-flush {
  padding: 0;
}

.panel-shell-spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--ui-border-strong-border);
  border-top-color: var(--ui-accent-primary-fg);
  border-radius: 50%;
  animation: panel-shell-spin 700ms linear infinite;
}

@keyframes panel-shell-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel-shell-spinner {
    animation: none;
  }
}
</style>
