<template>
  <!-- Tasks 视图。P4 换成六面板共享骨架:PanelShell 控制条 / LedgerGroupHeader 分组头 /
       38px mono 时间列的 44px 账线行 / 26px 状态条。**只换壳** —— 右侧详情、Dialog
       编辑器、运行历史抽屉一行没动。底色住在工作台的 `surface="panel"` 面里。 -->
  <PanelShell
    class="tasks-panel"
    :busy="loading"
    :scroll="false"
    :padded="false"
  >
    <template #controls>
      <div class="tasks-controls">
        <FilterSearchInput
          v-model="searchQuery"
          size="compact"
          class="tasks-search"
          placeholder="搜索任务"
          label="搜索任务"
          clear-label="清除搜索"
        />
        <Select
          v-model="enabledFilterModel"
          class="tasks-filter"
          :options="ENABLED_FILTER_OPTIONS"
          aria-label="按启用状态筛选"
          fit-input-width
        />
        <PanelPrimaryAction @click="startCreate">
          新建
        </PanelPrimaryAction>
      </div>
    </template>

    <div class="tasks-body">
      <ErrorNote
        v-if="error"
        class="ledger-error"
        :message="error"
      />

      <div
        class="tasks-layout"
        :class="{ 'detail-active': taskDetailActive }"
      >
        <section class="task-list">
          <div class="task-ledger">
            <p
              v-if="loading && tasks.length === 0"
              class="ledger-note"
            >
              正在读取定时任务…
            </p>
            <p
              v-else-if="taskGroups.length === 0"
              class="ledger-note"
            >
              {{ tasks.length === 0 ? '还没有定时任务' : '没有匹配的任务' }}
            </p>

            <section
              v-for="group in taskGroups"
              :key="group.key"
              class="task-group"
            >
              <LedgerGroupHeader
                sticky
                class="task-list-title"
                :label="group.label"
                :count="group.tasks.length"
              />
              <PanelLedgerRow
                v-for="task in group.tasks"
                :key="task.id"
                class="task-row"
                :label="task.name || task.id"
                :meta="taskMetaLine(task)"
                :active="selectedTaskId === task.id"
                :muted="!task.enabled"
                role="button"
                tabindex="0"
                @click="selectTask(task.id)"
                @keydown.enter.prevent="selectTask(task.id)"
                @keydown.space.prevent="selectTask(task.id)"
              >
                <!-- 首列固定槽位:38px mono 下次运行时刻。推不出来就是一条破折号,
                     不留空 —— 空槽会让整列的对齐看起来是坏的。 -->
                <template #lead>
                  <span class="task-time">{{ nextRunLabel(task) }}</span>
                </template>
                <template #label-extra>
                  <span :class="['task-status', taskStatusClass(task)]">{{ taskStatusLabel(task) }}</span>
                </template>
                <template #trail>
                  <span
                    class="task-toggle"
                    @click.stop
                    @keydown.stop
                  >
                    <Switch
                      variant="pill"
                      size="mini"
                      :model-value="task.enabled"
                      :disabled="actionId === task.id || task.inFlight"
                      :aria-label="`${task.name || task.id} ${task.enabled ? '已启用 — 点击停用' : '已停用 — 点击启用'}`"
                      @update:model-value="value => toggleTaskEnabled(task, value)"
                    />
                  </span>
                </template>
              </PanelLedgerRow>
            </section>
          </div>
        </section>

        <section
          v-if="selectedTask"
          class="task-detail"
        >
          <div class="detail-header-nav">
            <button
              class="text-action"
              type="button"
              @click="taskDetailActive = false"
            >
              back
            </button>
            <span class="detail-nav-title">Task Details</span>
          </div>

          <section class="task-detail-head">
            <div class="task-overview">
              <span class="overview-kicker">{{ selectedTask.kind === 'agent' ? 'Agent task' : 'Plugin task' }}{{ selectedTask.readonly ? ' · Read only' : '' }}</span>
              <h3>
                {{ selectedTask.name || selectedTask.id }}
              </h3>
              <p
                v-if="selectedTask.promptPreview || selectedTask.prompt"
                class="overview-prompt"
              >
                {{ selectedTask.promptPreview || selectedTask.prompt }}
              </p>
            </div>

            <div class="overview-actions">
              <button
                class="text-action"
                type="button"
                :disabled="actionId === selectedTask.id || selectedTask.inFlight"
                @click="runNow(selectedTask.id)"
              >
                run now
              </button>
              <button
                v-if="!selectedTask.readonly"
                class="text-action"
                type="button"
                @click="startEdit(selectedTask)"
              >
                edit
              </button>
              <button
                v-if="!selectedTask.readonly"
                class="text-action is-danger"
                type="button"
                @click="deleteTask(selectedTask.id)"
              >
                delete
              </button>
            </div>
          </section>

          <div class="detail-ledger">
            <section class="detail-summary-strip">
              <div class="meta-line">
                <span class="meta-label">Status</span>
                <strong :class="['meta-value', 'summary-status', taskStatusClass(selectedTask)]">{{ taskStatusLabel(selectedTask) }}</strong>
              </div>
              <div class="meta-line">
                <span class="meta-label">Next Run</span>
                <strong class="meta-value">{{ formatShortDate(selectedTask.nextRunAt) }}</strong>
              </div>
              <div class="meta-line">
                <span class="meta-label">Runs</span>
                <strong class="meta-value">{{ taskRunCountLabel(selectedTask) }}</strong>
              </div>
            </section>

            <section class="runtime-section">
              <h4 class="group-header">
                <span>Runtime</span>
                <span class="group-value">{{ formatSchedule(selectedTask.schedule) }}</span>
              </h4>

              <dl class="runtime-grid">
                <div class="meta-line">
                  <dt class="meta-label">
                    Next Run
                  </dt>
                  <dd class="meta-value">
                    {{ formatShortDate(selectedTask.nextRunAt) }}
                  </dd>
                </div>
                <div class="meta-line">
                  <dt class="meta-label">
                    Last Run
                  </dt>
                  <dd class="meta-value">
                    {{ formatShortDate(selectedTask.lastRunAt) }}
                  </dd>
                </div>
                <div class="meta-line">
                  <dt class="meta-label">
                    Runs
                  </dt>
                  <dd class="meta-value">
                    {{ taskRunCountLabel(selectedTask) }}
                  </dd>
                </div>
                <div class="meta-line">
                  <dt class="meta-label">
                    Owner
                  </dt>
                  <dd class="meta-value">
                    {{ taskOwnerLabel(selectedTask) }}
                  </dd>
                </div>
              </dl>
            </section>

            <section class="history-section">
              <button
                class="history-toggle group-header"
                type="button"
                @click="toggleHistory"
              >
                <span>Run history</span>
                <span class="toggle-state">{{ historyOpen ? 'hide' : 'show' }}</span>
              </button>

              <div
                v-if="historyOpen"
                class="history-drawer"
              >
                <div class="section-title">
                  <span>Recent runs</span>
                  <button
                    class="text-action"
                    type="button"
                    :disabled="runsLoading"
                    @click="loadRuns(selectedTask.id)"
                  >
                    refresh
                  </button>
                </div>

                <p
                  v-if="runsLoading"
                  class="ledger-note"
                >
                  loading run history…
                </p>
                <p
                  v-else-if="runs.length === 0"
                  class="ledger-note"
                >
                  no run history yet
                </p>
                <div
                  v-else
                  class="runs-ledger"
                >
                  <button
                    v-for="run in runs"
                    :key="run.runId || `${run.taskId}-${run.startedAt}`"
                    class="run-row"
                    :class="{ 'is-active': selectedRun?.runId === run.runId }"
                    type="button"
                    @click="selectedRun = selectedRun?.runId === run.runId ? null : run"
                  >
                    <span :class="['run-status', run.status]">{{ run.status }}</span>
                    <span class="run-date">{{ formatShortDate(run.startedAt) }}</span>
                    <span class="run-duration">{{ formatDuration(run.durationMs) }}</span>
                  </button>
                </div>
              </div>
            </section>

            <article
              v-if="historyOpen && selectedRun"
              class="run-detail"
            >
              <div class="section-title">
                <span>Run detail</span>
                <button
                  v-if="selectedRun.sessionId"
                  class="text-action"
                  type="button"
                  @click="openRunSession(selectedRun.sessionId)"
                >
                  open session
                </button>
              </div>
              <ErrorNote
                v-if="selectedRun.error"
                class="ledger-error"
                :message="selectedRun.error"
              />
              <p
                v-if="selectedRun.resultPreview"
                class="result-preview"
              >
                {{ selectedRun.resultPreview }}
              </p>

              <div
                v-if="selectedRun.toolCalls?.length"
                class="subsection"
              >
                <span class="subsection-title">Tools</span>
                <div
                  v-for="tool in selectedRun.toolCalls"
                  :key="tool.id"
                  class="trace-row"
                >
                  <span class="trace-title">{{ tool.toolName }}</span>
                  <small>{{ tool.status }} · {{ formatDuration(tool.durationMs) }}</small>
                  <code>{{ tool.argumentsPreview }}</code>
                </div>
              </div>

              <div class="subsection">
                <span class="subsection-title">Timeline</span>
                <div
                  v-for="item in selectedRun.timeline || []"
                  :key="item.id"
                  class="trace-row"
                >
                  <span class="trace-title">{{ item.title }}</span>
                  <small>{{ formatShortDate(item.timestamp) }}{{ item.status ? ` · ${item.status}` : '' }}</small>
                  <code v-if="item.detail">{{ item.detail }}</code>
                </div>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>

    <Dialog
      :open="editing"
      variant="paper"
      :width="480"
      :title="editingId ? 'Edit task' : 'Create task'"
      :auto-focus="false"
      :style="taskEditorVars"
      @update:open="value => { if (!value) cancelEdit() }"
    >
      <template #header-extra>
        <button
          class="text-action"
          type="button"
          :disabled="saving"
          @click="cancelEdit"
        >
          close
        </button>
      </template>

      <div
        ref="editorDialogRef"
        class="task-editor-body"
      >
        <label>
          <span>Name</span>
          <input
            v-model="form.name"
            class="field"
            type="text"
            aria-label="Task name"
            placeholder="Morning news brief"
          >
        </label>

        <div class="editor-field">
          <span>Agent</span>
          <!-- 定时任务的执行者是一个激活目标(agent-domain-model.md §3.2):
               已退休的 agent 不能被选中,否则到点了那条任务只会空转。
               kind 不在这里筛 —— service agent 有自己的后台日程。 -->
          <Select
            v-bind="SHEET_SELECT"
            :model-value="form.agentId"
            :options="agentOptions"
            aria-label="Task agent"
            @update:model-value="form.agentId = String($event ?? '')"
          />
        </div>

        <label>
          <span>Task</span>
          <textarea
            v-model="form.prompt"
            class="field textarea"
            aria-label="Task prompt"
            placeholder="Check the morning AI news and summarize the top 5 items with links."
          />
        </label>

        <div class="schedule-grid">
          <div class="editor-field">
            <span>Schedule</span>
            <Select
              v-bind="SHEET_SELECT"
              :model-value="form.scheduleMode"
              :options="SCHEDULE_MODE_OPTIONS"
              aria-label="Task schedule"
              @update:model-value="form.scheduleMode = String($event ?? '') as ScheduleMode"
            />
          </div>

          <label v-if="form.scheduleMode === 'daily' || form.scheduleMode === 'weekly'">
            <span>Time</span>
            <input
              v-model="form.time"
              class="field"
              type="time"
              aria-label="Task time"
            >
          </label>

          <div
            v-if="form.scheduleMode === 'weekly'"
            class="editor-field"
          >
            <span>Day</span>
            <Select
              v-bind="SHEET_SELECT"
              :model-value="form.dayOfWeek"
              :options="DAY_OF_WEEK_OPTIONS"
              aria-label="Task day"
              @update:model-value="form.dayOfWeek = String($event ?? '')"
            />
          </div>

          <label v-if="form.scheduleMode === 'interval'">
            <span>Every minutes</span>
            <input
              v-model.number="form.intervalMinutes"
              class="field"
              type="number"
              aria-label="Task interval minutes"
              min="1"
              step="1"
            >
          </label>

          <label v-if="form.scheduleMode === 'cron'">
            <span>Cron</span>
            <input
              v-model="form.cron"
              class="field is-mono"
              type="text"
              aria-label="Task cron"
              placeholder="0 9 * * *"
            >
          </label>

          <label v-if="form.scheduleMode !== 'interval'">
            <span>Timezone</span>
            <input
              v-model="form.timezone"
              class="field"
              type="text"
              aria-label="Task timezone"
              placeholder="System"
            >
          </label>
        </div>

        <label>
          <span>Working directory</span>
          <input
            v-model="form.workingDirectory"
            class="field is-mono"
            type="text"
            aria-label="Task working directory"
            placeholder="Optional"
          >
        </label>

        <div class="checkbox-row">
          <Switch
            variant="ledger"
            :model-value="form.enabled"
            aria-label="Enabled"
            @update:model-value="form.enabled = Boolean($event)"
          />
          <span>Enabled</span>
        </div>
      </div>

      <template #actions>
        <button
          class="text-action"
          type="button"
          :disabled="saving"
          @click="cancelEdit"
        >
          cancel
        </button>
        <button
          class="text-action is-primary"
          type="button"
          :disabled="saving"
          @click="saveTask"
        >
          {{ saving ? 'saving…' : editingId ? 'save changes' : 'create task' }}
        </button>
      </template>
    </Dialog>

    <template #status>
      <span class="status-text">{{ statusText }}</span>
      <button
        class="text-action tasks-refresh"
        type="button"
        :disabled="loading"
        @click="() => loadAll()"
      >
        刷新
      </button>
    </template>
  </PanelShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch, type CSSProperties } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import Dialog from '@/components/common/Dialog.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import FilterSearchInput from '@/components/common/FilterSearchInput.vue'
import Select from '@/components/common/Select.vue'
import type { SelectOptionLike } from '@/components/common/select'
import Switch from '@/components/common/Switch.vue'
import LedgerGroupHeader from '@/components/workspace/LedgerGroupHeader.vue'
import PanelLedgerRow from '@/components/workspace/PanelLedgerRow.vue'
import PanelPrimaryAction from '@/components/workspace/PanelPrimaryAction.vue'
import PanelShell from '@/components/workspace/PanelShell.vue'
import { useConfirm } from '@/composables/useConfirm'

/** The editor fills the viewport height it is given, like the old dialog did. */
const taskEditorVars: CSSProperties = {
  '--app-dialog-max-height': 'calc(100% - 40px)',
  '--app-dialog-body-display': 'flex',
  // The scroll (and its custom scrollbar skin) stays on `.task-editor-body`,
  // so Dialog's body is a plain flex shell with no padding of its own.
  '--app-dialog-body-padding': '0',
  '--app-dialog-body-overflow': 'hidden',
} as CSSProperties
import type {
  SchedulerRunDetailDTO,
  SchedulerSchedule,
  SchedulerTaskSnapshotDTO,
} from '@/types'
import { platformApi } from '@/platform'

const agentsStore = useAgentsStore()
const { confirm } = useConfirm()
const TASK_LOAD_TIMEOUT_MS = 10000

const props = withDefaults(defineProps<{
  active?: boolean
}>(), {
  active: true,
})

function getSchedulerApi() {
  return platformApi
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

// shallowRef: the run/task DTOs carry recursive JsonValue payloads, and
// UnwrapRef over that recursion blows vue-tsc's instantiation depth (TS2589).
// All assignments below replace the whole value, so shallow reactivity is
// equivalent here.
const tasks = shallowRef<SchedulerTaskSnapshotDTO[]>([])
const runs = shallowRef<SchedulerRunDetailDTO[]>([])
const selectedTaskId = ref('')
const selectedRun = shallowRef<SchedulerRunDetailDTO | null>(null)
const historyOpen = ref(false)
const loading = ref(false)
const runsLoading = ref(false)
const saving = ref(false)
const actionId = ref('')
const error = ref('')
const editing = ref(false)
const editingId = ref('')
const editorDialogRef = ref<HTMLElement | null>(null)
const initialized = ref(false)

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''

const taskDetailActive = ref(false)

type ScheduleMode = 'daily' | 'weekly' | 'interval' | 'cron'

/**
 * One spelling of "a dropdown in the task editor".
 *
 * `z-layer="modal"` is load-bearing: the editor is a Dialog at `--z-modal`, so
 * a panel left on the default dropdown stop opens *behind* the sheet it belongs
 * to. `teleported` then keeps it out of `.task-editor-body`'s scroll box.
 */
const SHEET_SELECT = {
  variant: 'underline',
  size: 'small',
  teleported: true,
  fitInputWidth: true,
  zLayer: 'modal',
} as const

const SCHEDULE_MODE_OPTIONS: SelectOptionLike[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' },
]

const DAY_OF_WEEK_OPTIONS: SelectOptionLike[] = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
]

const agentOptions = computed<SelectOptionLike[]>(() =>
  agentsStore.activeAgents.map(agent => ({ value: agent.id, label: agent.name })),
)

// ── 控制条:搜索 + 启用状态筛选 ────────────────────────────────────────────

type EnabledFilter = 'all' | 'enabled' | 'disabled'

const ENABLED_FILTER_OPTIONS: SelectOptionLike[] = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已停用' },
]

const searchQuery = ref('')
const enabledFilter = ref<EnabledFilter>('all')

/** Select 的 v-model 是裸 string,这里接回字面量联合。 */
const enabledFilterModel = computed({
  get: () => enabledFilter.value as string,
  set: (value: string) => {
    enabledFilter.value = value as EnabledFilter
  },
})

const filteredTasks = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return tasks.value.filter((task) => {
    if (enabledFilter.value === 'enabled' && !task.enabled) return false
    if (enabledFilter.value === 'disabled' && task.enabled) return false
    if (!query) return true
    const haystack = [
      task.name,
      task.id,
      task.promptPreview,
      task.pluginId,
      task.schedule?.kind === 'cron' ? task.schedule.expr : '',
    ]
    return haystack.some(part => (part || '').toLowerCase().includes(query))
  })
})

/**
 * 分组沿用列表本来就有的那条分界:`loadAll` 一直按 `readonly` 排在前面,
 * 也就是"我写的任务"和"系统内置的任务"两摞。分组头把这条隐含的次序显式画出来,
 * 而**不是**按启用状态分 —— 那一维已经归控制条的筛选下拉了。
 */
const taskGroups = computed(() => {
  const mine = filteredTasks.value.filter(task => !task.readonly)
  const builtin = filteredTasks.value.filter(task => task.readonly)
  return [
    { key: 'mine', label: '我的任务', tasks: mine },
    { key: 'builtin', label: '内置任务', tasks: builtin },
  ].filter(group => group.tasks.length > 0)
})

const form = ref({
  name: '',
  prompt: '',
  agentId: 'default',
  enabled: true,
  scheduleMode: 'daily' as ScheduleMode,
  time: '09:00',
  dayOfWeek: '1',
  intervalMinutes: 60,
  cron: '0 9 * * *',
  timezone: defaultTimezone,
  workingDirectory: '',
})

const selectedTask = computed(() =>
  tasks.value.find(task => task.id === selectedTaskId.value) || null
)

function resetForm(): void {
  form.value = {
    name: '',
    prompt: '',
    agentId: agentsStore.defaultAgent?.id || 'default',
    enabled: true,
    scheduleMode: 'daily',
    time: '09:00',
    dayOfWeek: '1',
    intervalMinutes: 60,
    cron: '0 9 * * *',
    timezone: defaultTimezone,
    workingDirectory: '',
  }
}

function startCreate(): void {
  resetForm()
  editingId.value = ''
  editing.value = true
  historyOpen.value = false
  selectedRun.value = null
  taskDetailActive.value = true
}

function startEdit(task: SchedulerTaskSnapshotDTO): void {
  editingId.value = task.id
  form.value.name = task.name || ''
  form.value.prompt = task.prompt || task.promptPreview || ''
  form.value.agentId = task.agentId || 'default'
  form.value.enabled = task.enabled
  form.value.workingDirectory = task.workingDirectory || ''
  applyScheduleToForm(task.schedule)
  editing.value = true
}

function cancelEdit(): void {
  if (saving.value) return
  editing.value = false
  editingId.value = ''
}

function applyScheduleToForm(schedule?: SchedulerSchedule): void {
  if (!schedule) return
  if (schedule.kind === 'interval') {
    form.value.scheduleMode = 'interval'
    form.value.intervalMinutes = Math.max(1, Math.round(schedule.everyMs / 60000))
    return
  }
  if (schedule.kind === 'cron') {
    const fields = schedule.expr.split(/\s+/)
    form.value.timezone = schedule.timezone || defaultTimezone
    if (fields.length === 5 && fields[2] === '*' && fields[3] === '*') {
      form.value.time = `${fields[1].padStart(2, '0')}:${fields[0].padStart(2, '0')}`
      if (fields[4] === '*') {
        form.value.scheduleMode = 'daily'
        return
      }
      form.value.scheduleMode = 'weekly'
      form.value.dayOfWeek = fields[4]
      return
    }
    form.value.scheduleMode = 'cron'
    form.value.cron = schedule.expr
  }
}

function buildSchedule(): SchedulerSchedule {
  if (form.value.scheduleMode === 'interval') {
    return { kind: 'interval', everyMs: Math.max(1, form.value.intervalMinutes) * 60000 }
  }
  if (form.value.scheduleMode === 'cron') {
    return {
      kind: 'cron',
      expr: form.value.cron.trim(),
      ...(form.value.timezone.trim() ? { timezone: form.value.timezone.trim() } : {}),
    }
  }
  const [hour = '9', minute = '0'] = form.value.time.split(':')
  const day = form.value.scheduleMode === 'weekly' ? form.value.dayOfWeek : '*'
  return {
    kind: 'cron',
    expr: `${Number(minute)} ${Number(hour)} * * ${day}`,
    ...(form.value.timezone.trim() ? { timezone: form.value.timezone.trim() } : {}),
  }
}

async function saveTask(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const payload = {
      name: form.value.name,
      prompt: form.value.prompt,
      agentId: form.value.agentId,
      enabled: form.value.enabled,
      schedule: buildSchedule(),
      workingDirectory: form.value.workingDirectory.trim() || undefined,
    }
    const schedulerApi = getSchedulerApi()
    const response = editingId.value
      ? await schedulerApi.updateSchedulerTask({ id: editingId.value, ...payload })
      : await schedulerApi.createSchedulerTask(payload)
    if (!response.success || !response.task) throw new Error(response.error || 'Failed to save scheduled task')
    editing.value = false
    editingId.value = ''
    await loadAll(response.task.id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function loadAll(nextSelectedId = selectedTaskId.value): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await withTimeout(
      getSchedulerApi().listSchedulerTasks(),
      TASK_LOAD_TIMEOUT_MS,
      'Loading scheduled tasks timed out. Please refresh again.',
    )
    if (!response.success || !response.tasks) throw new Error(response.error || 'Failed to load scheduled tasks')
    tasks.value = response.tasks.sort((a, b) => Number(a.readonly) - Number(b.readonly) || (a.name || a.id).localeCompare(b.name || b.id))
    selectedTaskId.value = tasks.value.find(task => task.id === nextSelectedId)?.id || tasks.value[0]?.id || ''
    if (selectedTaskId.value && historyOpen.value) {
      await loadRuns(selectedTaskId.value)
    } else {
      runs.value = []
      selectedRun.value = null
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadRuns(taskId: string): Promise<void> {
  runsLoading.value = true
  selectedRun.value = null
  runs.value = []
  try {
    const response = await getSchedulerApi().listSchedulerRuns({ taskId, limit: 50 })
    if (!response.success || !response.runs) throw new Error(response.error || 'Failed to load run history')
    runs.value = response.runs
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    runsLoading.value = false
  }
}

async function selectTask(taskId: string): Promise<void> {
  selectedTaskId.value = taskId
  historyOpen.value = false
  selectedRun.value = null
  runs.value = []
  taskDetailActive.value = true
}

async function toggleHistory(): Promise<void> {
  historyOpen.value = !historyOpen.value
  selectedRun.value = null
  if (historyOpen.value && selectedTaskId.value && runs.value.length === 0) {
    await loadRuns(selectedTaskId.value)
  }
}

async function runNow(taskId: string): Promise<void> {
  actionId.value = taskId
  error.value = ''
  try {
    const response = await getSchedulerApi().runSchedulerTaskNow({ id: taskId, force: true })
    if (!response.success) throw new Error(response.error || 'Failed to run task')
    await loadAll(taskId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionId.value = ''
  }
}

async function setEnabled(taskId: string, enabled: boolean): Promise<void> {
  actionId.value = taskId
  error.value = ''
  try {
    const response = await getSchedulerApi().setSchedulerTaskEnabled({ id: taskId, enabled })
    if (!response.success) throw new Error(response.error || 'Failed to update task')
    await loadAll(taskId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    actionId.value = ''
  }
}

async function toggleTaskEnabled(task: SchedulerTaskSnapshotDTO, value: unknown): Promise<void> {
  await setEnabled(task.id, value === true)
}

async function deleteTask(taskId: string): Promise<void> {
  const accepted = await confirm({
    title: 'Delete task',
    message: 'Delete this scheduled task? Existing run history will stay on disk.',
    danger: true,
    confirmText: 'delete',
    variant: 'paper',
  })
  if (!accepted) return
  error.value = ''
  try {
    const response = await getSchedulerApi().deleteSchedulerTask({ id: taskId })
    if (!response.success) throw new Error(response.error || 'Failed to delete task')
    await loadAll('')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function openRunSession(sessionId: string): Promise<void> {
  const schedulerApi = getSchedulerApi()
  await schedulerApi.updateSessionArchived(sessionId, false, null)
  await schedulerApi.switchSession(sessionId)
}

function formatSchedule(schedule?: SchedulerSchedule): string {
  if (!schedule) return 'No schedule'
  if (schedule.kind === 'interval') return `Every ${Math.round(schedule.everyMs / 60000)} min`
  if (schedule.kind === 'at') return `At ${formatMaybeDate(schedule.atMs)}`
  const fields = schedule.expr.split(/\s+/)
  if (fields.length === 5 && fields[2] === '*' && fields[3] === '*') {
    const time = `${fields[1].padStart(2, '0')}:${fields[0].padStart(2, '0')}`
    if (fields[4] === '*') return `Daily ${time}`
    return `Weekly ${time}`
  }
  return schedule.expr
}

function formatMaybeDate(value?: number): string {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

function formatShortDate(value?: number): string {
  if (!value) return 'Never'
  return new Date(value).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(value?: number): string {
  if (!value) return '0s'
  if (value < 1000) return `${value}ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value / 60000)}m`
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 首列 38px mono 时间列:下一次运行的**时刻**,不是完整时间戳。
 * 今天之内给钟点,一周之内给星期,再远给日期 —— 一列里同时排下这三种写法
 * 靠的是它们都不超过四个字符。推不出来(没排期 / 已停用未算出下次)给破折号。
 */
function nextRunLabel(task: SchedulerTaskSnapshotDTO): string {
  if (!task.nextRunAt) return '—'
  const next = new Date(task.nextRunAt)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.floor((next.getTime() - startOfToday) / 86400000)
  if (dayDiff === 0) {
    return `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  }
  if (dayDiff > 0 && dayDiff < 7) return WEEKDAY_LABELS[next.getDay()]
  return `${next.getMonth() + 1}/${next.getDate()}`
}

/** 副行:cron 原文 + 人话周期。cron 之外的排期没有"原文"可给,只留人话。 */
function taskMetaLine(task: SchedulerTaskSnapshotDTO): string {
  const human = formatSchedule(task.schedule)
  const raw = task.schedule?.kind === 'cron' ? task.schedule.expr : ''
  return raw && raw !== human ? `${raw} · ${human}` : human
}

/** 状态条:最近的一次排期 + 还有多久。停用的任务不参与——它不会到点。 */
const statusText = computed(() => {
  if (loading.value && tasks.value.length === 0) return '正在读取定时任务…'
  const upcoming = tasks.value
    .filter(task => task.enabled && typeof task.nextRunAt === 'number' && task.nextRunAt > 0)
    .map(task => task.nextRunAt as number)
    .sort((a, b) => a - b)[0]
  const total = `${filteredTasks.value.length} 个任务`
  if (!upcoming) return `${total} · 无排期`
  const next = new Date(upcoming)
  const clock = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  return `${total} · 下一次 ${clock} · 还有 ${formatCountdown(upcoming - Date.now())}`
})

function formatCountdown(ms: number): string {
  if (ms <= 0) return '不到 1 分钟'
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

function taskRunCountLabel(task: SchedulerTaskSnapshotDTO): string {
  const total = task.successCount + task.failureCount
  if (!total) return 'No runs yet'
  if (!task.failureCount) return `${total} total`
  return `${total} total · ${task.failureCount} failed`
}

function taskLastRunFailed(task: SchedulerTaskSnapshotDTO): boolean {
  return (
    (typeof task.lastRunAt === 'number' && task.lastErrorAt === task.lastRunAt) ||
    task.recentRuns?.[0]?.ok === false
  )
}

function taskStatusLabel(task: SchedulerTaskSnapshotDTO): string {
  if (task.inFlight) return 'Running'
  if (!task.enabled) return 'Disabled'
  if (taskLastRunFailed(task)) return 'Failed'
  if (task.successCount + task.failureCount > 0) return 'Healthy'
  return 'Scheduled'
}

function taskStatusClass(task: SchedulerTaskSnapshotDTO): string {
  if (task.inFlight) return 'running'
  if (!task.enabled) return 'disabled'
  if (taskLastRunFailed(task)) return 'failed'
  if (task.successCount + task.failureCount > 0) return 'healthy'
  return 'scheduled'
}

function taskOwnerLabel(task: SchedulerTaskSnapshotDTO): string {
  if (task.kind === 'plugin') return task.pluginId || 'Plugin'
  // 域模型 M4:署名走 displayAgent —— 一条老任务指着已退休/已删的 agent 时显示
  // 墓碑「已注销」,而不是把一串 id 印在账页上。
  if (!task.agentId) return 'Agent'
  return agentsStore.displayAgent(task.agentId).name
}

watch(editing, async (isEditing) => {
  if (!isEditing) return
  await nextTick()
  const firstField = editorDialogRef.value?.querySelector<HTMLElement>('input, textarea, select, button')
  firstField?.focus()
})

onMounted(async () => {
  await agentsStore.loadAgents().catch(() => undefined)
  resetForm()
  initialized.value = true
  if (props.active) await loadAll()
})

watch(
  () => props.active,
  async (active, wasActive) => {
    if (!active || !initialized.value || active === wasActive) return
    await loadAll()
  },
  { flush: 'post' },
)
</script>

<style scoped>
/*
 * Tasks ledger — 画线风.
 * No background fills, no radii: state lives in the line.
 * One vertical ink rule carries the task register and the detail sheet.
 */
.tasks-panel {
  /* 面板底色不在这里画:它住在工作台的 `surface="panel"` 面里(ui-system §4)。
     `container-type` 留着 —— 窄容器下的堆叠式主从布局是这个面板自己的力学。 */
  container-type: inline-size;
  position: relative;
  min-width: 0;
  max-width: none;
  box-sizing: border-box;
  color: var(--ui-text-primary-fg);
  animation: ledger-fade 0.15s ease;
}

@keyframes ledger-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.tasks-panel,
.tasks-panel * {
  box-sizing: border-box;
}

/* Thin scrollbars, unchanged scroll containers */
.tasks-panel::-webkit-scrollbar,
.task-list::-webkit-scrollbar,
.task-detail::-webkit-scrollbar,
.runs-ledger::-webkit-scrollbar,
.task-editor-body::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.tasks-panel::-webkit-scrollbar-track,
.task-list::-webkit-scrollbar-track,
.task-detail::-webkit-scrollbar-track,
.runs-ledger::-webkit-scrollbar-track,
.task-editor-body::-webkit-scrollbar-track {
  background: transparent;
}

.tasks-panel::-webkit-scrollbar-thumb,
.task-list::-webkit-scrollbar-thumb,
.task-detail::-webkit-scrollbar-thumb,
.runs-ledger::-webkit-scrollbar-thumb,
.task-editor-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 18%, transparent);
}

.tasks-panel::-webkit-scrollbar-thumb:hover,
.task-list::-webkit-scrollbar-thumb:hover,
.task-detail::-webkit-scrollbar-thumb:hover,
.runs-ledger::-webkit-scrollbar-thumb:hover,
.task-editor-body::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 32%, transparent);
}

/* ---- 控制条 ---- */
.tasks-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.tasks-search {
  flex: 1 1 120px;
  min-width: 0;
}

.tasks-filter {
  flex: 0 0 auto;
  min-width: 92px;
}

/* ---- 内容区 ---- */
.tasks-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 10px 14px 12px;
}

/* ---- 状态条 ---- */
.status-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tasks-refresh {
  flex: none;
  font-size: 10.5px;
}

/* ---- shared ledger controls ---- */
.text-action {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--duration-fast) var(--ease-default);
}

.text-action:hover:not(:disabled) {
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

.text-action.is-primary {
  color: var(--ui-accent-primary-fg);
}

.text-action.is-danger:hover:not(:disabled) {
  color: var(--ui-status-danger-fg);
  text-decoration-color: var(--ui-status-danger-fg);
}

.text-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.text-action:focus-visible,
.history-toggle:focus-visible,
.run-row:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 2px;
}

/* ---- errors and notes ---- */
/* positioning only — visuals come from ErrorNote */
.ledger-error {
  margin: 0;
  flex-shrink: 0;
}

.ledger-note {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

/* ---- split layout ---- */
.tasks-layout {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(210px, 0.38fr) minmax(0, 1fr);
  align-items: stretch;
  gap: clamp(16px, 3cqw, 32px);
  position: relative;
  overflow: hidden;
}

.task-list {
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  padding: 4px 6px 16px 0;
  scrollbar-width: thin;
}

.task-detail {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 4px 24px 0;
  scrollbar-width: thin;
}

/* ---- the ledger rule ---- */
/* 列表侧的账页竖线随 44px 账线行一起退休:行自己带下沿线,再挂一根竖线就是两套语汇。 */
.task-ledger {
  min-width: 0;
}

.detail-ledger {
  position: relative;
  padding-left: 16px;
}

.detail-ledger::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: color-mix(in srgb, var(--ui-border-strong-border) 72%, transparent);
}

.detail-ledger {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* ---- group headers: a longer, heavier tick marks the heading ---- */
.group-header {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: var(--font-weight-semibold, 600);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-primary-fg);
}

.group-header::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 50%;
  width: 10px;
  height: 2px;
  background: var(--ui-border-strong-border);
}

.group-header h4,
.group-header h5 {
  margin: 0;
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  letter-spacing: inherit;
  color: inherit;
}

.group-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: var(--font-weight-normal, 400);
  letter-spacing: normal;
  text-transform: none;
  color: var(--ui-text-muted-fg);
}

.task-group {
  min-width: 0;
}

/* ---- 首列:38px mono 时间列 ---- */
.task-time {
  display: inline-block;
  width: 38px;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-status {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--ui-text-muted-fg);
}

.task-status.healthy,
.summary-status.healthy {
  color: var(--ui-status-success-fg, var(--color-success));
}

.task-status.failed,
.summary-status.failed {
  color: var(--ui-status-danger-fg);
}

.task-status.running,
.summary-status.running {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.task-status.scheduled,
.summary-status.scheduled {
  color: var(--ui-text-muted-fg);
}

.task-status.disabled,
.summary-status.disabled {
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

/* 行尾开关:停用的、选中的、以及鼠标停在上面的行常显;其余行让位给内容 */
.task-toggle {
  flex-shrink: 0;
  display: inline-flex;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.task-row:hover .task-toggle,
.task-row:focus-within .task-toggle,
.task-row.is-muted .task-toggle,
.task-row.is-active .task-toggle {
  opacity: 1;
}

/* ---- detail: back nav (stacked mode only) ---- */
.detail-header-nav {
  display: none;
}

.detail-nav-title {
  font-size: 12px;
  font-weight: var(--font-weight-semibold, 600);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-primary-fg);
}

/* ---- detail head ---- */
.task-detail-head {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 20px;
}

.task-overview {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.overview-kicker {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.task-overview h3 {
  margin: 0;
  min-width: 0;
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 17px;
  font-weight: var(--font-weight-semibold, 600);
  line-height: 1.25;
  color: var(--ui-text-primary-fg);
  overflow-wrap: anywhere;
}

.overview-prompt {
  margin: 0;
  max-width: 720px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.overview-actions {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 2px;
}

/* ---- metadata lines (summary + runtime) ---- */
.detail-summary-strip,
.runtime-grid {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.meta-line {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  min-height: 26px;
  padding: 4px 0;
  border-top: 1px solid color-mix(in srgb, var(--ui-tool-border-border, var(--ui-border-subtle-border)) 32%, transparent);
}

.meta-line:first-child {
  border-top: none;
}

.meta-line::before {
  content: '';
  position: absolute;
  left: -13px;
  top: 50%;
  width: 7px;
  height: 1px;
  background: var(--ui-border-strong-border);
  transition: width var(--duration-fast) var(--ease-default), background-color var(--duration-fast) var(--ease-default);
}

.meta-line:hover::before {
  width: 12px;
  background: var(--ui-text-muted-fg);
}

.meta-label {
  flex-shrink: 0;
  min-width: 72px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.meta-value {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: var(--font-weight-normal, 400);
  color: var(--ui-text-primary-fg);
}

/* ---- history ---- */
.history-toggle {
  appearance: none;
  display: flex;
  width: 100%;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.toggle-state {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-weight: var(--font-weight-normal, 400);
  letter-spacing: normal;
  text-transform: none;
  color: var(--ui-text-muted-fg);
  transition: color var(--duration-fast) var(--ease-default);
}

.history-toggle:hover .toggle-state {
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-accent-primary-fg);
}

.history-drawer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-title > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: var(--font-weight-medium, 500);
  color: var(--ui-text-muted-fg);
}

.runs-ledger {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.run-row {
  appearance: none;
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 28px;
  padding: 5px 0;
  background: transparent;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--ui-tool-border-border, var(--ui-border-subtle-border)) 32%, transparent);
  text-align: left;
  cursor: pointer;
}

.run-row:first-child {
  border-top: none;
}

.run-row::before {
  content: '';
  position: absolute;
  left: -13px;
  top: 50%;
  width: 7px;
  height: 1px;
  background: var(--ui-border-strong-border);
  transition: width var(--duration-fast) var(--ease-default), height var(--duration-fast) var(--ease-default), background-color var(--duration-fast) var(--ease-default);
}

.run-row:hover::before {
  width: 12px;
  background: var(--ui-text-muted-fg);
}

.run-row.is-active::before {
  width: 14px;
  height: 2px;
  background: var(--ui-accent-primary-fg);
}

.run-status {
  flex-shrink: 0;
  min-width: 68px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--ui-text-muted-fg);
}

.run-status.succeeded {
  color: var(--ui-status-success-fg, var(--color-success));
}

.run-status.failed,
.run-status.blocked {
  color: var(--ui-status-danger-fg);
}

.run-status.running {
  color: var(--ui-status-warning-fg, var(--color-warning));
}

.run-date {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

.run-row.is-active .run-date,
.run-row:hover .run-date {
  color: var(--ui-text-primary-fg);
}

.run-duration {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

/* ---- run detail ---- */
.run-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* Result excerpt held by a left rule, no filled block */
.result-preview {
  margin: 0;
  padding: 2px 0 2px 10px;
  border-left: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted-fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow-y: auto;
}

.subsection {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.subsection-title {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.trace-row {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 2px 10px;
  border-left: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
}

.trace-title {
  font-size: 12px;
  color: var(--ui-text-primary-fg);
  overflow-wrap: anywhere;
}

.trace-row small {
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.trace-row code {
  min-width: 0;
  max-height: 96px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--ui-text-muted-fg);
}

/* ---- underline inputs: the line is the control ---- */
.field {
  appearance: none;
  min-width: 0;
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 70%, transparent);
  border-radius: 0;
  padding: 3px 0 4px;
  font-size: 12px;
  color: var(--ui-text-primary-fg);
  transition: border-color var(--duration-fast) var(--ease-default);
}

/* `.field` 只落在 input / textarea 上(本文件模板里 7 处 input + 1 处 textarea),
   焦点下沉底线是 caret 场景 —— 裸 :focus 是对的,元素选择器把这件事说明白。 */
.field:hover:not(:disabled),
input.field:focus,
textarea.field:focus {
  outline: none;
  border-bottom-color: var(--ui-accent-primary-fg);
}

.field::placeholder {
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.field.is-mono {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
}


.textarea {
  min-height: 90px;
  line-height: 1.5;
  resize: vertical;
}

/* ---- task editor: the paper shell is `Dialog variant="paper"` since P2 ---- */
.task-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 18px 8px;
  scrollbar-width: thin;
}

/* `.editor-field` is the same column as a `<label>`, for the rows whose control
   is a component (Select/Switch) rather than a labelable element — wrapping one
   in a <label> would make the caption click the component's first inner input. */
.task-editor-body label,
.task-editor-body .editor-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.task-editor-body label > span,
.task-editor-body .editor-field > span {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
}

.schedule-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
  gap: 14px 18px;
  min-width: 0;
}

/* P3: the ink-dot the old `input[type=checkbox]` was restyled into is exactly
   `<Switch variant="ledger">`, which draws (and focuses) itself. Row only. */
.checkbox-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.checkbox-row > span {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
}

/* ---- narrow containers: stacked list/detail with slide ---- */
@container (max-width: 520px) {
  .tasks-layout {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .task-list,
  .task-detail {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transition: transform var(--duration-slow) var(--ease-out);
  }

  .task-list {
    transform: translateX(0);
    z-index: 1;
  }

  .task-detail {
    transform: translateX(100%);
    z-index: 2;
    padding: 4px 2px 24px 0;
    /* 滑上来的详情要一枚不透明底才盖得住底下的列表。区域面自绘归 Surface 档位管
       (ui-system §4),所以借 PanelShell 转手的 `--panel-shell-bg`,不直接吃区域面 token。 */
    background: var(--panel-shell-bg, var(--ui-surface-panel-bg));
  }

  .detail-active .task-list {
    transform: translateX(-20%);
  }

  .detail-active .task-detail {
    transform: translateX(0);
  }

  .detail-header-nav {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-shrink: 0;
    padding: 2px 0 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--ui-tool-border-border, var(--ui-border-subtle-border)) 32%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tasks-panel {
    animation: none;
  }

  .task-list,
  .task-detail {
    transition: none;
  }
}
</style>
