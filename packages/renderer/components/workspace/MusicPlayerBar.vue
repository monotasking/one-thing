<template>
  <div class="music-player-bar">
    <!-- 顶上那 2px 是**进度**,不是分隔线:它压在状态条的上边框位置,所以走过的
         部分一眼就能从整条的宽度里读出来,不用额外一行数字。 -->
    <div
      class="mpb-progress"
      role="progressbar"
      aria-label="播放进度"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="progressPercent"
    >
      <span
        class="mpb-progress-fill"
        :style="{ width: `${progressPercent}%` }"
      />
    </div>

    <div class="mpb-row">
      <button
        type="button"
        class="mpb-icon u-focus-ring"
        aria-label="上一首"
        :disabled="disabled"
        @click="emit('prev')"
      >
        <SkipBack
          :size="15"
          :stroke-width="1.8"
        />
      </button>

      <!-- 唯一一枚实心件:26px 圆盘。播放/暂停是这条里唯一"每次都要点中"的动作,
           其余两个是偶尔的 —— 让它在墨线里成为唯一的实心块就够指路了。 -->
      <button
        type="button"
        class="mpb-toggle u-focus-ring"
        :aria-label="playing ? '暂停' : '播放'"
        :disabled="disabled"
        @click="emit('toggle')"
      >
        <component
          :is="playing ? Pause : Play"
          :size="12"
          :stroke-width="2"
        />
      </button>

      <button
        type="button"
        class="mpb-icon u-focus-ring"
        aria-label="下一首"
        :disabled="disabled"
        @click="emit('next')"
      >
        <SkipForward
          :size="15"
          :stroke-width="1.8"
        />
      </button>

      <span class="mpb-track">
        <span class="mpb-title">{{ trackTitle }}</span>
        <span
          v-if="subtitle"
          class="mpb-subtitle"
        > · {{ subtitle }}</span>
      </span>

      <span class="mpb-time">{{ timeLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * MusicPlayerBar —— 44px 常驻播放条,住在 PanelShell 的 `status` 槽里
 * (设计稿 Turn 5:六面板共用 26px 状态条,Music 是唯一的例外 —— 它换成这条)。
 *
 * 它是**纯呈现件**:不认识 musicStore,时间文案与进度比都由调用方算好传进来。
 * 面板里的这条和 composer 那条(MusicStatusBar)是两套形态、同一份数据,把 store
 * 关在外面才不会变成"两个地方各自去问播放器"。
 */
import { computed } from 'vue'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  /** 曲名。刻意不叫 `title` —— 那个名字在模板里会被 ui-gate 当成原生 tooltip 属性。 */
  trackTitle: string
  /** 曲名后面那截(歌手 / 点歌标注);没有就整段不画。 */
  subtitle?: string
  /** 正在放 = 显示暂停键。 */
  playing?: boolean
  /** 0–1。 */
  progressRatio?: number
  /** mono 时间,如 `2:46 / 8:09`。 */
  timeLabel?: string
  /** 命令在途时锁住三个键,免得连点排队。 */
  disabled?: boolean
}>(), {
  subtitle: '',
  playing: false,
  progressRatio: 0,
  timeLabel: '',
  disabled: false,
})

const emit = defineEmits<{
  prev: []
  toggle: []
  next: []
}>()

const progressPercent = computed(() => {
  const ratio = Number.isFinite(props.progressRatio) ? props.progressRatio : 0
  return Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10
})
</script>

<style scoped>
.music-player-bar {
  position: relative;
  width: 100%;
  min-width: 0;
}

.mpb-progress {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ui-border-default-border);
}

.mpb-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--ui-accent-primary-fg);
  transition: width var(--duration-fast) var(--ease-default);
}

.mpb-row {
  display: flex;
  align-items: center;
  gap: 11px;
  height: 44px;
  padding: 0 14px;
  min-width: 0;
}

.mpb-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ui-text-secondary-fg);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: color var(--duration-fast) var(--ease-default);
}

.mpb-icon:hover:not(:disabled) {
  color: var(--ui-text-primary-fg);
}

.mpb-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ui-text-primary-fg);
  color: var(--ui-text-inverse-fg);
  cursor: pointer;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.mpb-toggle:hover:not(:disabled) {
  opacity: 0.86;
}

.mpb-icon:disabled,
.mpb-toggle:disabled {
  opacity: 0.4;
  cursor: default;
}

.mpb-track {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: var(--ui-text-secondary-fg);
}

.mpb-subtitle {
  color: var(--ui-text-faint-fg);
}

.mpb-time {
  flex: none;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-faint-fg);
}
</style>
