<template>
  <div
    class="segmented-pill"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <button
      v-for="(option, index) in options"
      :ref="el => setItemRef(el, index)"
      :key="option.value"
      type="button"
      role="radio"
      class="segmented-pill-item u-focus-ring"
      :class="{ 'is-selected': option.value === modelValue }"
      :aria-checked="option.value === modelValue"
      :tabindex="tabIndexFor(index)"
      @click="select(option.value)"
      @keydown="onKeydown($event, index)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * SegmentedPill —— 值绑定的分段丸(全部 / 上传 / 生成 这类互斥小筛选)。
 *
 * 语义是 radiogroup 而不是一排 button:一组里恰好一个选中,读屏要能读出"3 之 1"。
 * 键盘用 roving tabindex —— 整组只占一个 Tab 停靠点,进组后左右(上下)键换值、
 * Home/End 跳两端,这是 WAI-ARIA radiogroup 的标准手感,别退化成"每段一个 Tab"。
 *
 * 选中段用面色抬起 + 600 字重表达,**不涂主色底**(ui-system:选中态禁 accent 当背景)。
 */
import { computed, nextTick, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'

export interface SegmentedPillOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: SegmentedPillOption[]
  ariaLabel?: string
}>(), {
  ariaLabel: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const itemRefs = ref<(HTMLButtonElement | null)[]>([])

function setItemRef(el: Element | ComponentPublicInstance | null, index: number) {
  itemRefs.value[index] = (el as HTMLButtonElement | null) ?? null
}

const selectedIndex = computed(() => props.options.findIndex(option => option.value === props.modelValue))

/** 没有任何一段命中当前值时,首段接住 Tab —— 否则整组会掉出 Tab 序列。 */
function tabIndexFor(index: number): number {
  if (selectedIndex.value === -1) return index === 0 ? 0 : -1
  return index === selectedIndex.value ? 0 : -1
}

function select(value: string) {
  if (value === props.modelValue) return
  emit('update:modelValue', value)
  emit('change', value)
}

async function moveTo(index: number) {
  const option = props.options[index]
  if (!option) return
  select(option.value)
  await nextTick()
  itemRefs.value[index]?.focus()
}

function onKeydown(event: KeyboardEvent, index: number) {
  const count = props.options.length
  if (count === 0) return

  let target: number | null = null
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % count
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index - 1 + count) % count
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = count - 1

  if (target === null) return
  event.preventDefault()
  void moveTo(target)
}
</script>

<style scoped>
.segmented-pill {
  display: flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-full);
  background: var(--ui-surface-input-bg);
}

.segmented-pill-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 11px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--ui-text-muted-fg);
  font-family: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-default),
    background var(--duration-fast) var(--ease-default);
}

.segmented-pill-item:hover:not(.is-selected) {
  color: var(--ui-text-secondary-fg);
}

.segmented-pill-item.is-selected {
  background: var(--ui-surface-panel-bg);
  color: var(--ui-text-primary-fg);
  font-weight: 600;
}
</style>
