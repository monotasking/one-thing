<template>
  <div
    class="ledger-group-header"
    :class="{ 'is-sticky': sticky, 'is-collapsible': collapsible, 'is-collapsed': collapsed }"
  >
    <button
      v-if="collapsible"
      type="button"
      class="lgh-toggle u-focus-ring"
      :aria-expanded="!collapsed"
      @click="toggle"
    >
      <span
        class="lgh-sign"
        aria-hidden="true"
      >{{ collapsed ? '+' : '−' }}</span>
      <span class="lgh-label">{{ label }}</span>
    </button>
    <span
      v-else
      class="lgh-label"
    >{{ label }}</span>

    <span
      class="lgh-rule"
      aria-hidden="true"
    />

    <span
      v-if="hasCount"
      class="lgh-count"
    >{{ count }}</span>

    <slot name="trailing" />
  </div>
</template>

<script setup lang="ts">
/**
 * LedgerGroupHeader —— 账线分组头:uppercase 标签 + 一根拉通到底的 1px 线 + mono 计数。
 * 六个工作区面板共用一份(Archive 的可折叠、Scheduler 的右对齐取值、Agents 的纯标签
 * 三种既有写法都能由它表达),不再各写各的。
 *
 * 两处刻意的形状:
 *  · 折叠钮只包住 ± 号与标签,**不包**拉通线和 `trailing` 槽 —— 槽里常放按钮,
 *    button 套 button 是非法嵌套,也会把右侧动作变成"点了就折叠";
 *  · sticky 底走 `--panel-shell-bg`(由 PanelShell 声明)而不是直接吃区域面 token:
 *    区域面自绘归 Surface 档位管(ui-system §4 surface-literal),这里只是借它的值
 *    做一枚遮挡底。脱离 PanelShell 使用时 fallback 到 panel 面。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  label: string
  /** 右侧 mono 计数;`undefined` / 空串不渲染,`0` 会渲染。 */
  count?: string | number
  /** 吸顶。用在长列表(Media 的日期分组)里。 */
  sticky?: boolean
  /** 标签变成 ± 折叠钮。 */
  collapsible?: boolean
  collapsed?: boolean
}>(), {
  count: undefined,
  sticky: false,
  collapsible: false,
  collapsed: false,
})

const emit = defineEmits<{
  'update:collapsed': [value: boolean]
}>()

const hasCount = computed(() => props.count !== undefined && props.count !== '')

function toggle() {
  emit('update:collapsed', !props.collapsed)
}
</script>

<style scoped>
.ledger-group-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 0 6px;
}

.ledger-group-header.is-sticky {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel-shell-bg, var(--ui-surface-panel-bg));
}

.lgh-toggle {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: var(--radius-xs);
}

.lgh-sign {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 1;
  color: var(--ui-text-faint-fg);
  transition: color var(--duration-fast) var(--ease-default);
}

.lgh-toggle:hover .lgh-sign,
.lgh-toggle:hover .lgh-label {
  color: var(--ui-text-secondary-fg);
}

.lgh-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg);
  transition: color var(--duration-fast) var(--ease-default);
}

.lgh-rule {
  flex: 1;
  height: 1px;
  background: var(--ui-border-subtle-border);
}

.lgh-count {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  font-variant-numeric: tabular-nums;
}
</style>
