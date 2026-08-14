<template>
  <label
    class="filter-search"
    :class="{ 'has-value': modelValue.length > 0, 'is-compact': size === 'compact' }"
  >
    <Search
      :size="size === 'compact' ? 13 : 14"
      :stroke-width="1.8"
      class="filter-search-icon"
    />
    <input
      :value="modelValue"
      type="search"
      class="filter-search-input"
      :placeholder="placeholder"
      :aria-label="label"
      @input="emitValue"
    >
    <Button
      v-if="modelValue.length > 0"
      unstyled
      class="filter-search-clear"
      native-type="button"
      :aria-label="clearLabel"
      @click="emit('update:modelValue', '')"
    >
      <X
        :size="size === 'compact' ? 12 : 13"
        :stroke-width="2"
      />
    </Button>
  </label>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { Search, X } from 'lucide-vue-next'

withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  label?: string
  clearLabel?: string
  /**
   * `compact` = 30px 高的控制条尺寸(工作区面板的控制条只有 30px 可用高度)。
   * 默认档一个像素都不动 —— 现存调用点全部落在 `default` 上。
   */
  size?: 'default' | 'compact'
}>(), {
  placeholder: 'Search',
  label: 'Search',
  clearLabel: 'Clear search',
  size: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function emitValue(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<style scoped>
.filter-search {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  height: 34px;
  color: var(--ui-text-muted-fg);
  background: var(--ui-surface-input-bg);
  border: 1px solid var(--ui-border-default-border);
  border-radius: 8px;
  transition: border-color var(--duration-normal) var(--ease-default), box-shadow var(--duration-normal) var(--ease-default), background var(--duration-normal) var(--ease-default);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.03);
}

.filter-search:focus-within {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-focus-border, var(--ui-accent-primary-fg));
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.03),
    0 0 0 1px var(--ui-border-focus-border, var(--ui-accent-primary-fg));
}

.filter-search-icon {
  flex: 0 0 auto;
  margin-left: 10px;
  pointer-events: none;
}

.filter-search-input {
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 10px 0 7px;
  border: none;
  outline: none;
  color: var(--ui-text-primary-fg);
  background: transparent;
  font: inherit;
  font-size: 12.5px;
}

.filter-search.has-value .filter-search-input {
  padding-right: 30px;
}

.filter-search-input::-webkit-search-cancel-button {
  appearance: none;
}

.filter-search-input::placeholder {
  color: var(--ui-text-muted-fg);
}

.filter-search-clear {
  position: absolute;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  padding: 0;
  border: none;
  border-radius: 6px;
  color: var(--ui-text-muted-fg);
  background: transparent;
  cursor: pointer;
}

.filter-search-clear:hover {
  color: var(--ui-text-primary-fg);
  background: var(--ui-state-hover-bg);
}

/* ---- compact:30px 控制条档 ---- */
.filter-search.is-compact {
  height: 30px;
  border-radius: var(--radius-sm);
}

.filter-search.is-compact .filter-search-icon {
  margin-left: 8px;
}

.filter-search.is-compact .filter-search-input {
  padding: 0 8px 0 6px;
  font-size: 12px;
}

.filter-search.is-compact.has-value .filter-search-input {
  padding-right: 26px;
}

.filter-search.is-compact .filter-search-clear {
  right: 4px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
}
</style>
