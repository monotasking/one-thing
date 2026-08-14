<template>
  <Popover
    :open="open"
    :anchor="anchor"
    trigger="manual"
    placement="bottom-start"
    surface="menu"
    :offset="8"
    :z-layer="zLayer"
    :z-offset="zOffset"
    transition="none"
  >
    <div
      class="slash-menu"
      role="listbox"
      aria-label="插入块"
    >
      <button
        v-for="(item, index) in items"
        :key="item.id"
        type="button"
        role="option"
        class="slash-item"
        :class="{ 'is-active': index === activeIndex }"
        :aria-selected="index === activeIndex"
        @mousedown.prevent
        @mouseenter="emit('update:activeIndex', index)"
        @click="emit('select', item.id)"
      >
        <component
          :is="ICONS[item.id]"
          class="slash-icon"
          :size="15"
          :stroke-width="1.75"
        />
        <span class="slash-label">{{ item.label }}</span>
        <span class="slash-hint">{{ item.hint }}</span>
      </button>
    </div>
  </Popover>
</template>

<script setup lang="ts">
/**
 * 斜杠菜单的**呈现层**——纯受控:开不开、选中第几条、有哪些条,全由引擎侧的
 * `useSlashMenu` 说了算,这里一个 ref 都不持有。
 *
 * `closeOn` 一个都不开(Popover 的缺省):关闭时机归编辑器(打空格、删掉 `/`、
 * Esc),不归浮层。让 Popover 自己接管 outside-click 会与编辑器里的点击选区打架。
 */
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import Popover from '@/components/common/Popover.vue'
import type { FloatingZLayer } from '@/composables/floating/useFloatingLayer'
import type { SlashCommandId, SlashCommandItem } from './slash-commands'

withDefaults(defineProps<{
  open: boolean
  anchor: { x: number, y: number }
  items: SlashCommandItem[]
  activeIndex: number
  /**
   * 宿主所在的层级档。缺省是普通锚定浮层那一档;活在悬浮垫(`--z-sidebar` 档)
   * 里的两个引擎要传 `sidebar` + 一个正偏移,否则菜单会掉到垫子后面去。
   */
  zLayer?: FloatingZLayer
  zOffset?: number
}>(), {
  zLayer: 'dropdown',
  zOffset: 0,
})

const emit = defineEmits<{
  select: [id: SlashCommandId]
  'update:activeIndex': [index: number]
}>()

const ICONS: Record<SlashCommandId, Component> = {
  'heading-1': Heading1,
  'heading-2': Heading2,
  'heading-3': Heading3,
  'bullet-list': List,
  'ordered-list': ListOrdered,
  'task-list': ListTodo,
  'blockquote': Quote,
  'code-block': Code,
  'horizontal-rule': Minus,
  'image': ImageIcon,
}
</script>

<style scoped>
.slash-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 208px;
  max-height: 264px;
  overflow-y: auto;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--radius-xs, 4px);
  background: transparent;
  color: var(--ui-text-primary-fg);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.slash-item:hover,
.slash-item.is-active {
  background: var(--ui-state-hover-bg);
}

.slash-icon {
  flex: 0 0 auto;
  color: var(--ui-text-muted-fg);
}

.slash-label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
}

.slash-hint {
  flex: 0 0 auto;
  color: var(--ui-text-faint-fg);
  font-size: 11px;
  white-space: nowrap;
}
</style>
