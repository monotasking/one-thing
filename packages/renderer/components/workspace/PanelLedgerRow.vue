<template>
  <div
    class="panel-ledger-row"
    :class="{ 'is-active': active, 'is-muted': muted }"
  >
    <span
      v-if="$slots.lead"
      class="plr-lead"
    >
      <slot name="lead" />
    </span>

    <span class="plr-body">
      <span class="plr-title-line">
        <span class="plr-title">
          <slot name="label">{{ label }}</slot>
        </span>
        <slot name="label-extra" />
      </span>
      <span
        v-if="hasMeta"
        class="plr-meta"
      >
        <slot name="meta">{{ meta }}</slot>
      </span>
    </span>

    <span
      v-if="$slots.trail"
      class="plr-trail"
    >
      <slot name="trail" />
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * PanelLedgerRow —— 工作区面板的 44px 账线行(设计稿 Turn 5 的行配方)。
 *
 * 标题这一格叫 `label` 而不是 `title`:`title=` 在这个仓库是被 ui:gate 盯着的
 * 原生属性(rule `title-attr`,行级正则分不出组件 prop 和原生 attr),取名 `label`
 * 让三个调用点都不用去动那份豁免名单。
 *
 * 一行四个槽位,次序跨面板对齐,这是「六面板看起来是一套」的主要来源:
 *  · `lead`  = 首列固定槽位(Tasks 的 38px mono 时间列 / Agents 的状态点 / 队列序号),
 *    宽度由**调用方**在槽内容上定,行本身只保证它不参与伸缩;
 *  · 两行体  = 12.5px 标题 + mono 10px 副行(`meta` prop 或同名槽),永远 ellipsis;
 *  · `trail` = 行尾(开关 / hover 才现的操作组 / 右对齐 mono 计数)。
 *
 * 纯呈现件:不定义任何事件。点击、右键、键盘全部由 attrs 落在根元素上
 * (`role="button"` / `tabindex` 也归调用方),免得调用方与它抢语义 ——
 * 与 `MediaFileRow` 同一条纪律。
 *
 * 选中态用左 2px 墨边 + 主色标题,**不涂底**(ui-system §1:账线域选中禁 accent 当背景);
 * `muted` 是"停用/失效"这类降调,只降字色不改结构。
 */
import { computed, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  /** 标题文本;需要富内容时改用同名槽。 */
  label?: string
  /** mono 副行文本;需要富内容(进度条)时改用同名槽。 */
  meta?: string
  /** 当前打开/选中的那一行。 */
  active?: boolean
  /** 降调行(已停用、已失效)。 */
  muted?: boolean
}>(), {
  label: '',
  meta: '',
  active: false,
  muted: false,
})

const slots = useSlots()

const hasMeta = computed(() => Boolean(slots.meta) || props.meta.length > 0)
</script>

<style scoped>
.panel-ledger-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 6px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
  min-width: 0;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.panel-ledger-row:hover {
  background: var(--ui-state-hover-bg);
}

.panel-ledger-row:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: -1px;
}

.panel-ledger-row.is-active {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.panel-ledger-row.is-active .plr-title {
  color: var(--ui-accent-primary-fg);
}

.panel-ledger-row.is-muted .plr-title {
  color: var(--ui-text-faint-fg);
}

.plr-lead {
  flex: none;
  display: inline-flex;
  align-items: center;
}

.plr-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.plr-title-line {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.plr-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ui-text-primary-fg);
}

.plr-meta {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}

.plr-trail {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
