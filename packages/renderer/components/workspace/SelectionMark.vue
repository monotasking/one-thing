<template>
  <span
    class="selection-mark"
    :class="{ 'is-checked': checked }"
    role="checkbox"
    :aria-checked="checked"
    :aria-label="ariaLabel"
    aria-hidden="false"
  >
    <svg
      v-if="checked"
      class="selection-mark-tick"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M2.5 6.2 4.8 8.5 9.5 3.6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
</template>

<script setup lang="ts">
/**
 * SelectionMark —— 多选模式下画在**内容之上**的 15px 勾选框。
 *
 * 为什么不是 `Checkbox.vue`:那枚原语的语汇是"挂在账线上、上墨加粗的一横"
 * (它自己的注释就写着 "Not a box that fills with colour"),放在一张照片的
 * 左上角完全读不出来 —— 缩略图的底色是任意的,只有一枚**实心反差块**才立得住。
 * 所以这里是另一个物件,不是原语的第二种写法。
 *
 * 它是纯呈现件:自己不接点击(瓦片/行的整个面才是命中区,点在勾上和点在图上
 * 是同一件事),所以画成 `<span role="checkbox">` 而不是 button —— 套一个
 * button 只会在瓦片里多出一个 Tab 停靠点,还要处理"点了两次"。
 *
 * 选中态涂主色底是**允许**的:ui-system 的"选中禁涂底"针对的是列表行(账页语汇
 * 里选中= 左墨边 + 主色字),不针对一枚本来就该被填满的勾选框。
 */
withDefaults(defineProps<{
  checked?: boolean
  ariaLabel?: string
}>(), {
  checked: false,
  ariaLabel: undefined,
})
</script>

<style scoped>
.selection-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex: none;
  border: 1px solid var(--ui-border-strong-border);
  border-radius: var(--radius-xs);
  /* 半透明纸底:压在缩略图上也要看得见框,但不要把图糊掉。 */
  background: color-mix(in srgb, var(--ui-text-inverse-fg) 62%, transparent);
  color: transparent;
  transition:
    background var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.selection-mark.is-checked {
  border-color: var(--ui-accent-primary-fg);
  background: var(--ui-action-primary-bg, var(--ui-accent-primary-fg));
  color: var(--ui-action-primary-fg, var(--ui-text-inverse-fg));
}

.selection-mark-tick {
  width: 11px;
  height: 11px;
}
</style>
