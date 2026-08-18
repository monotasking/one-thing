<template>
  <Transition name="s-chip">
    <!-- data-ambient-anchor:氛围层地标(L0)。chip 在场即可落雪,离场即缺席
         —— 惰性 attribute,零逻辑。 -->
    <StatusChip
      v-if="runningJobs.length > 0 || isCompacting"
      class="background-jobs-chip"
      data-ambient-anchor="status.chip"
      label="后台任务"
      :flyout-width="280"
      aria-live="polite"
    >
      <template v-if="runningJobs.length > 0">
        <span
          class="chip-glyph"
          aria-hidden="true"
        >⚙</span>
        <span class="chip-num">{{ runningJobs.length }}</span>
        <span>{{ runningJobs.length === 1 ? 'job' : 'jobs' }}</span>
      </template>
      <!-- C6:压缩是同一类「会话级后台作业」,所以它是这枚 chip 的一行,
           而不是第二枚 chip。没有任务时 chip 只为它出场。 -->
      <template v-if="isCompacting">
        <span
          class="chip-glyph"
          aria-hidden="true"
        >⟳</span>
        <span>Compacting</span>
        <span
          v-if="compactProgress"
          class="chip-num"
        >{{ compactProgress.chunk }}/{{ compactProgress.totalChunks }}</span>
      </template>

      <!-- 展开态就是原来的整行内容:逐 job + 端口 + 停止 + 刷新,
           一个交互都没降级(composer-bands §3.2)。 -->
      <template #flyout>
        <div class="background-jobs-bar">
          <div
            v-if="isCompacting"
            class="compact-row"
          >
            <span class="status-dot is-working" />
            <span class="summary-text">
              Compacting context…<template v-if="compactProgress"> {{ compactProgress.chunk }}/{{ compactProgress.totalChunks }}</template>
            </span>
          </div>

          <div
            v-if="runningJobs.length > 0"
            class="jobs-summary"
          >
            <span class="status-dot" />
            <span class="summary-text">
              {{ runningJobs.length }} background {{ runningJobs.length === 1 ? 'service' : 'services' }} running
            </span>
            <Button
              unstyled
              class="refresh-btn"
              native-type="button"
              :disabled="loading"
              @click.stop="loadJobs"
            >
              Refresh
            </Button>
          </div>

          <div
            v-if="runningJobs.length > 0"
            class="jobs-list"
          >
            <div
              v-for="job in runningJobs"
              :key="job.id"
              class="job-chip"
            >
              <span class="job-command">{{ compactCommand(job.command) }}</span>
              <span
                v-if="job.ports?.length"
                class="job-ports"
              >
                :{{ job.ports.join(', :') }}
              </span>
              <Button
                unstyled
                class="job-stop"
                native-type="button"
                @click.stop="stopJob(job.id)"
              >
                Stop
              </Button>
            </div>
          </div>
        </div>
      </template>
    </StatusChip>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 后台任务 —— S 状态带成员(docs/design/composer-bands-2026-08.md §3.2)。
 *
 * E 期只换形态:收起态是 `⚙ N jobs` 的 chip,展开态是原来的整行内容整体
 * 搬进浮层。`v-if running > 0` 的显隐语义与轮询逐字不变。
 *
 * C6(2026-08-14):上下文压缩并入**这枚既有 chip**,不新起一个状态条
 * (docs/design/context-compact-capability-2026-08.md §C6)。它与后台任务是
 * 同一类东西:会话级的、在后台跑的、用户只需知道"在跑/跑到哪儿"的作业。
 * 失败不在这里呈现 —— 那归消息卡片(ContextCompactPanel),状态条不做错误态。
 */
import Button from '@/components/common/Button.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { platformApi } from '@/platform'
import { useChatStore } from '@/stores/chat'

interface BackgroundJobView {
  id: string
  command: string
  cwd: string
  status: 'running' | 'exited' | 'killed' | 'unknown'
  childPids: number[]
  ports?: number[]
  logPath?: string
}

const props = defineProps<{
  /** 压缩是**按会话**的状态,所以这枚 chip 需要知道自己在哪个会话里。 */
  sessionId?: string
}>()

const chatStore = useChatStore()

const jobs = ref<BackgroundJobView[]>([])
const loading = ref(false)
let refreshTimer: ReturnType<typeof setInterval> | undefined

const runningJobs = computed(() => jobs.value.filter(job => job.status === 'running'))

const isCompacting = computed(
  () => !!props.sessionId && chatStore.isSessionCompacting(props.sessionId),
)

const compactProgress = computed(
  () => (props.sessionId ? chatStore.getSessionCompactProgress(props.sessionId) : null),
)

function compactCommand(command: string): string {
  const normalized = command.replace(/\s+/g, ' ').trim()
  return normalized.length > 36 ? `${normalized.slice(0, 33)}…` : normalized
}

async function loadJobs() {
  loading.value = true
  try {
    const result = await platformApi.listBackgroundJobs()
    jobs.value = (result.jobs ?? []) as BackgroundJobView[]
  } finally {
    loading.value = false
  }
}

async function stopJob(jobId: string) {
  await platformApi.stopBackgroundJob(jobId)
  await loadJobs()
}

onMounted(() => {
  void loadJobs()
  refreshTimer = setInterval(() => void loadJobs(), 5000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<style scoped>
/* 收起态的字形:壳只管外形,语义符号归成员自己。 */
.chip-glyph {
  font-size: 11px;
  line-height: 1;
  opacity: 0.9;
}

.status-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-status-success-fg);
}

/* 压缩在跑:同一颗点,换一档语义色。不做 spinner —— 状态带里只有静态标记。 */
.status-dot.is-working {
  background: var(--ui-accent-primary-fg);
}

.compact-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-weight: 600;
}

.background-jobs-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--ui-text-primary-fg);
  font-size: 12px;
}

.jobs-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-weight: 600;
}

.summary-text {
  flex: 1;
  min-width: 0;
}

.jobs-list {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  min-width: 0;
}

.job-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 70%, transparent);
  border-radius: var(--radius-xs);
  background: var(--ui-surface-app-bg);
}

.job-command {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
}

.job-ports {
  color: var(--ui-accent-primary-fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.job-stop,
.refresh-btn {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 70%, transparent);
  border-radius: var(--radius-xs);
  padding: 2px 8px;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font-size: 11px;
  transition:
    color var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.job-stop:hover {
  color: var(--ui-status-danger-fg);
  border-color: var(--ui-status-danger-fg);
}

.refresh-btn:hover:not(:disabled) {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
