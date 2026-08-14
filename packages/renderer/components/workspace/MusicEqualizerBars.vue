<template>
  <span
    class="eq-bars"
    :class="{ 'is-still': !animated }"
    aria-hidden="true"
  >
    <span class="eq-bar" />
    <span class="eq-bar" />
    <span class="eq-bar" />
  </span>
</template>

<script setup lang="ts">
/**
 * MusicEqualizerBars —— 队列里"正在放的就是这一行"的 12px 槽位标记。
 *
 * 为什么是三根动条而不是一个 ▶ 图标:队列行的首列槽位跨面板对齐(Agents 放状态点、
 * Media 放扩展名徽章、这里放序号),那一格里放图标会和序号抢视觉重量;三根起伏的
 * 条既占同样的格子,又只有"当前这行"才动 —— 动的那一行就是答案,不需要第二种标记。
 *
 * `animated=false`(暂停)时条子留在原高不再起伏:暂停是**有当前曲目但没在走**,
 * 把标记整个撤掉会让人以为队列换了头。`prefers-reduced-motion` 同理静止。
 */
withDefaults(defineProps<{
  /** 播放中才起伏;暂停传 false(条子保留,只是不动)。 */
  animated?: boolean
}>(), {
  animated: true,
})
</script>

<style scoped>
.eq-bars {
  display: inline-flex;
  align-items: flex-end;
  justify-content: center;
  gap: 1.5px;
  width: 12px;
  height: 12px;
}

.eq-bar {
  flex: 1;
  min-width: 0;
  border-radius: 1px;
  background: var(--ui-accent-primary-fg);
  transform-origin: bottom;
  animation: eq-rise 900ms var(--ease-default, ease-in-out) infinite alternate;
}

/* 三根不同起点 + 不同相位,才像一段音乐而不是一台节拍器。 */
.eq-bar:nth-child(1) {
  height: 60%;
  animation-delay: -600ms;
}

.eq-bar:nth-child(2) {
  height: 100%;
  animation-delay: -300ms;
}

.eq-bar:nth-child(3) {
  height: 40%;
}

@keyframes eq-rise {
  from {
    transform: scaleY(0.35);
  }

  to {
    transform: scaleY(1);
  }
}

.eq-bars.is-still .eq-bar {
  animation: none;
  transform: scaleY(0.7);
}

@media (prefers-reduced-motion: reduce) {
  .eq-bar {
    animation: none;
  }
}
</style>
