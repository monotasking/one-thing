<template>
  <div
    class="media-file-row"
    :class="{ 'is-active': active, 'is-selected': selected }"
    role="button"
    tabindex="0"
  >
    <SelectionMark
      v-if="selectMode"
      :checked="selected"
      :aria-label="asset.fileName"
    />

    <span
      class="mfr-ext"
      aria-hidden="true"
    >{{ extension }}</span>

    <span class="mfr-body">
      <span class="mfr-name">{{ asset.fileName || 'Untitled' }}</span>
      <span class="mfr-meta">{{ meta }}</span>
    </span>

    <span
      class="mfr-source"
      :class="`is-${sourceTone}`"
    >{{ sourceLabel }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * MediaFileRow —— 非图片资产的一行:26×26 扩展名徽章 + 名/元信息两行 + 行尾来源 chip。
 *
 * 抽成组件而不是留在 Media 视图里逐行写:同一形状在多选态、详情打开态、右键态下
 * 有四套 class 组合,内联写法会让 Media 的模板多出一屏;而 P4 的 Archive/Tasks
 * 也要"徽章 + 两行体 + 行尾 chip"这套。它是**纯呈现件** —— 点击/右键/键盘全部
 * 由 attrs 透传落在这个根元素上,行自己不定义事件,免得调用方与它抢语义。
 */
import { computed } from 'vue'
import SelectionMark from './SelectionMark.vue'
import type { MediaAsset } from '@/types'

const props = withDefaults(defineProps<{
  asset: MediaAsset
  /** 副行文本,如 `842 KB · 8 月 9 日` —— 口径归调用方,行不自己造日期格式。 */
  meta: string
  sourceLabel: string
  /** chip 色调:上传 = 纸底静音,生成/工具 = info 状态色。 */
  sourceTone?: 'upload' | 'generated'
  selectMode?: boolean
  selected?: boolean
  /** 详情页当前打开的就是这一行。 */
  active?: boolean
}>(), {
  sourceTone: 'upload',
  selectMode: false,
  selected: false,
  active: false,
})

const extension = computed(() => {
  const name = props.asset.fileName || ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return '—'
  return name.slice(dot + 1).slice(0, 4)
})
</script>

<style scoped>
.media-file-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 6px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
  cursor: pointer;
}

.media-file-row:hover {
  background: var(--ui-state-hover-bg);
}

.media-file-row:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: -1px;
}

/* 详情打开项:账页语汇的选中 —— 左墨边 + 主色字,不涂底(ui-system §1)。 */
.media-file-row.is-active {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.media-file-row.is-active .mfr-name {
  color: var(--ui-accent-primary-fg);
}

.mfr-ext {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  background: var(--ui-surface-input-bg);
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
}

.mfr-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.mfr-name {
  font-size: 12.5px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mfr-meta {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mfr-source {
  flex: none;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  font-size: 10.5px;
  white-space: nowrap;
}

.mfr-source.is-upload {
  background: var(--ui-surface-input-bg);
  color: var(--ui-text-muted-fg);
}

.mfr-source.is-generated {
  background: var(--ui-status-info-bg);
  color: var(--ui-status-info-fg);
}
</style>
