<template>
  <SettingsSection
    title="Background Bash Jobs"
    description="Long-running services started by background bash commands. Refresh to update process status and ports."
  >
    <SettingsGroup>
      <SettingRow>
        <template #label>
          <span>Running Services</span>
        </template>
        <div class="jobs-actions">
          <Button
            unstyled
            class="btn secondary"
            :disabled="loading"
            @click="loadJobs"
          >
            <RefreshCw
              :class="{ spinning: loading }"
              :size="13"
            />
            <span>{{ loading ? 'Refreshing...' : 'Refresh' }}</span>
          </Button>
        </div>
      </SettingRow>

      <SettingsEmptyState
        v-if="!loading && jobs.length === 0"
        title="No background jobs"
        description="Background bash services will appear here after commands such as `npm run dev &`."
      />

      <div
        v-for="job in jobs"
        :key="job.id"
        class="job-card"
      >
        <div class="job-main">
          <div class="job-title">
            {{ job.command }}
          </div>
          <div class="job-meta">
            <span :class="['status', job.status]">{{ job.status }}</span>
            <span>cwd: {{ job.cwd }}</span>
            <span v-if="job.ports?.length">ports: {{ job.ports.join(', ') }}</span>
            <span v-if="job.childPids?.length">pids: {{ job.childPids.join(', ') }}</span>
          </div>
          <div
            v-if="job.logPath"
            class="job-log"
          >
            log: {{ job.logPath }}
          </div>
        </div>
        <Button
          unstyled
          class="btn danger"
          :disabled="job.status !== 'running'"
          @click="stopJob(job.id)"
        >
          Stop
        </Button>
      </div>
    </SettingsGroup>
  </SettingsSection>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { onMounted, ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import {
  SettingRow,
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
} from './settings-primitives'
import { toolsApi } from '@/platform/tools-client'

interface BackgroundJobView {
  id: string
  command: string
  cwd: string
  status: 'running' | 'exited' | 'killed' | 'unknown'
  childPids: number[]
  ports?: number[]
  logPath?: string
}

const jobs = ref<BackgroundJobView[]>([])
const loading = ref(false)

async function loadJobs() {
  loading.value = true
  try {
    const result = await toolsApi.listBackgroundJobs({ includeInactive: true })
    jobs.value = (result.jobs ?? []) as BackgroundJobView[]
  } finally {
    loading.value = false
  }
}

async function stopJob(jobId: string) {
  await toolsApi.stopBackgroundJob(jobId)
  await loadJobs()
}

onMounted(() => {
  void loadJobs()
})
</script>

<style scoped>
.jobs-actions {
  display: flex;
  justify-content: flex-end;
}

/* Job rows: ledger lines, no card chrome. */
.job-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--settings-rule-soft, var(--ui-border-subtle-border, var(--ui-border-default-border))) 55%, transparent);
  border-radius: 0;
  background: transparent;
}

.job-card:last-child {
  border-bottom: 0;
}

.job-main {
  flex: 1;
  min-width: 0;
}

.job-title {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  color: var(--settings-ink, var(--ui-text-primary-fg));
  word-break: break-all;
}

.job-meta,
.job-log {
  margin-top: 6px;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--settings-ink-3, var(--ui-text-secondary-fg));
}

.job-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.job-log {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  text-transform: capitalize;
  font-weight: 600;
}

.status.running {
  color: var(--ui-status-success-fg, var(--success-color));
}

.status.killed,
.status.exited {
  color: var(--ui-text-secondary-fg);
}

/* Outlined square buttons; danger actions carry a danger line. */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  border: 1px solid var(--settings-rule, var(--ui-border-default-border, var(--border-color)));
  border-radius: 0;
  padding: 5px 10px;
  background: transparent;
  color: var(--settings-ink-2, var(--ui-text-primary-fg));
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.btn:hover:not(:disabled) {
  border-color: var(--settings-ink-3, var(--ui-text-muted-fg));
  color: var(--settings-ink, var(--ui-text-primary-fg));
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.danger {
  border-color: var(--ui-status-danger-border, var(--ui-status-danger-fg));
  color: var(--ui-status-danger-fg, var(--danger-color));
}

.btn.danger:hover:not(:disabled) {
  border-color: var(--ui-status-danger-fg, var(--danger-color));
  color: var(--ui-status-danger-fg, var(--danger-color));
}

.spinning {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
