<template>
  <div
    class="panel-skeleton"
    aria-hidden="true"
  >
    <span
      v-if="header"
      class="panel-skeleton-header"
    />

    <div
      v-if="tiles > 0"
      class="panel-skeleton-grid"
    >
      <span
        v-for="(opacity, index) in tileOpacities"
        :key="`tile-${index}`"
        class="panel-skeleton-tile"
        :style="{ opacity }"
      />
    </div>

    <div
      v-if="rows > 0"
      class="panel-skeleton-rows"
    >
      <span
        v-for="(opacity, index) in rowOpacities"
        :key="`row-${index}`"
        class="panel-skeleton-row"
        :style="{ opacity }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PanelSkeleton —— 首屏加载的**透明度递减**骨架(设计稿 Turn 5 的四态之一)。
 *
 * 递减而不是脉冲:面板唯一允许的忙碌动画是状态条那枚 spinner(见 PanelShell),
 * 内容区再放一个会和它打架。递减的那道坡本身就读作"越往下越不确定",
 * 静止、不闪、reduced-motion 下不用另写分支。
 *
 * 台阶是**算出来的**不是抄死的:设计稿给的 8 块是 .9→.18,行是 .5→.3;
 * 这里按块数在同一对端点之间线性取值,于是 5 块 / 12 块的面板也拿得到同一道坡,
 * 而不是各自手抄一串小数。
 */
import { computed } from 'vue'

const TILE_FROM = 0.9
const TILE_TO = 0.18
const ROW_FROM = 0.5
const ROW_TO = 0.3

const props = withDefaults(defineProps<{
  /** 组头那根 62×9 的圆角条。 */
  header?: boolean
  /** 方瓦块数(网格骨架)。0 = 不画。 */
  tiles?: number
  /** 行骨架条数。0 = 不画。 */
  rows?: number
}>(), {
  header: true,
  tiles: 8,
  rows: 2,
})

function ramp(count: number, from: number, to: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [from]
  const step = (from - to) / (count - 1)
  return Array.from({ length: count }, (_, i) => Number((from - step * i).toFixed(3)))
}

const tileOpacities = computed(() => ramp(props.tiles, TILE_FROM, TILE_TO))
const rowOpacities = computed(() => ramp(props.rows, ROW_FROM, ROW_TO))
</script>

<style scoped>
.panel-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
}

.panel-skeleton-header {
  width: 62px;
  height: 9px;
  border-radius: var(--radius-xs);
  background: var(--ui-surface-input-bg);
}

.panel-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}

.panel-skeleton-tile {
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  background: var(--ui-surface-input-bg);
}

.panel-skeleton-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}

.panel-skeleton-row {
  height: 26px;
  border-radius: var(--radius-xs);
  background: var(--ui-surface-input-bg);
}
</style>
