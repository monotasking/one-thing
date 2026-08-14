<template>
  <Button
    type="primary"
    native-type="button"
    class="panel-primary-action"
  >
    <slot />
  </Button>
</template>

<script setup lang="ts">
/**
 * PanelPrimaryAction —— 控制条右槽的 accent 主按钮(设计稿 Turn 5:30px 高、
 * 左右 11px、圆角 7px)。
 *
 * 它**不是**第二套按钮:壳完全是 `Button type="primary"`,这里只把尺寸落到
 * 30px 控制条的档位上 —— Button 的度量全部走自有 CSS 变量,所以改档不需要覆盖
 * 它的任何一条视觉规则(颜色、hover、focus 环、disabled 一律照旧)。
 *
 * `min-width` 归零是刻意的:Button 默认给按钮一条 60~72px 的下限,而控制条右槽
 * 常常只放两个字,下限会把搜索框挤扁。
 *
 * 没有自己的 props / emits:attrs(disabled、@click、aria-*)按 Vue 的单根
 * 透传规则原样落到 Button 上。
 */
import Button from '@/components/common/Button.vue'
</script>

<style scoped>
.panel-primary-action {
  --app-button-height: 30px;
  --app-button-min-width: 0;
  --app-button-padding-x: 11px;
  --app-button-radius: 7px;
  --app-button-font-size: 12px;

  flex: none;
}
</style>
