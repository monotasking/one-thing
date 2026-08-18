<template>
  <section
    class="todo-progress-panel"
    aria-label="AI todo progress"
  >
    <div class="todo-progress-head">
      <div class="todo-progress-title">
        <ListChecks
          :size="14"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <span>{{ documentTitle }}</span>
      </div>
      <span
        v-if="totalCount > 0"
        class="todo-progress-count"
      >
        {{ doneCount }}/{{ totalCount }}
      </span>
    </div>

    <div
      v-if="loading && !snapshot"
      class="todo-progress-state"
    >
      Loading
    </div>

    <div
      v-else-if="error"
      class="todo-progress-state is-error"
    >
      {{ error }}
    </div>

    <div
      v-else-if="!todoDocument || totalCount === 0"
      class="todo-progress-state todo-progress-empty"
    >
      No AI todo yet
    </div>

    <template v-else>
      <div class="todo-progress-meter">
        <span
          class="todo-progress-meter-fill"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>

      <div
        v-if="currentTask"
        class="todo-progress-current"
      >
        <span class="todo-progress-current-label">Current</span>
        <span class="todo-progress-current-text">{{ currentTask.text }}</span>
      </div>

      <div
        v-else
        class="todo-progress-current is-complete"
      >
        <CheckCircle2
          :size="14"
          :stroke-width="2.2"
          aria-hidden="true"
        />
        <span>All tasks complete</span>
      </div>

      <div class="todo-progress-sections">
        <section
          v-for="section in sections"
          :key="section.title"
          class="todo-progress-section"
        >
          <div class="todo-progress-section-head">
            <span class="todo-progress-section-title">{{ section.title }}</span>
            <span class="todo-progress-section-count">
              {{ doneInSection(section) }}/{{ section.tasks.length }}
            </span>
          </div>
          <div class="todo-progress-tasks">
            <div
              v-for="task in section.tasks"
              :key="`${section.title}-${task.lineIndex}`"
              class="todo-progress-task"
              :class="{ done: task.done, doing: isCurrentTask(task) }"
            >
              <span>{{ task.text }}</span>
              <i
                class="todo-progress-task-leader"
                aria-hidden="true"
              />
              <span class="todo-progress-task-state">{{ task.done ? '讫' : '…' }}</span>
            </div>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { CheckCircle2, ListChecks } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ParsedTask, TaskSection } from '@/components/chat/todo-plan-utils'
import type { TodoPlanChangedPayload, TodoPlanDocument, TodoPlanSnapshot } from '@/types'
import { groupTasksBySection, parseTasks, titleFromMarkdown } from '@/components/chat/todo-plan-utils'
import { platformApi } from '@/platform'

const props = withDefaults(defineProps<{
  sessionId?: string
}>(), {
  sessionId: undefined,
})

const emit = defineEmits<{
  progressChange: [progress: { done: number, total: number, currentText: string }]
}>()

const snapshot = ref<TodoPlanSnapshot | null>(null)
const loading = ref(false)
const error = ref('')
let cleanupChanged: (() => void) | null = null

const todoDocument = computed<TodoPlanDocument | null>(() => snapshot.value?.sessionAiTodo ?? null)
const documentTitle = computed(() => {
  const document = todoDocument.value
  if (!document) return 'AI Todo'
  return titleFromMarkdown(document.content, document.title || 'AI Todo')
})
const tasks = computed(() => parseTasks(todoDocument.value?.content || ''))
const sections = computed(() => groupTasksBySection(tasks.value))
const totalCount = computed(() => tasks.value.length)
const doneCount = computed(() => tasks.value.filter(task => task.done).length)
const currentTask = computed(() => tasks.value.find(task => !task.done) || null)
const progressPercent = computed(() => {
  if (totalCount.value === 0) return 0
  return Math.round((doneCount.value / totalCount.value) * 100)
})

function doneInSection(section: TaskSection) {
  return section.tasks.filter(task => task.done).length
}

function isCurrentTask(task: ParsedTask) {
  return !task.done && currentTask.value?.lineIndex === task.lineIndex
}

function applyDocument(document: TodoPlanDocument) {
  snapshot.value = {
    directory: snapshot.value?.directory || '',
    userNotes: snapshot.value?.userNotes || [],
    sessionAiTodo: document,
  }
}

function shouldRefreshChanged(data: TodoPlanChangedPayload) {
  if (data.scope === 'global-user' || data.scope === 'all') return true
  if (data.scope === 'session-ai-todo') {
    return Boolean(props.sessionId) && data.sessionId === props.sessionId
  }
  return false
}

async function loadSnapshot() {
  loading.value = true
  error.value = ''
  try {
    const response = await platformApi.getTodoPlan({
      sessionId: props.sessionId,
    })
    if (!response.success) {
      error.value = response.error || 'Unable to load todo'
      snapshot.value = null
      return
    }
    snapshot.value = response.snapshot || null
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unable to load todo'
    snapshot.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.sessionId,
  () => {
    loadSnapshot()
  },
)

watch(
  [doneCount, totalCount, currentTask],
  () => {
    emit('progressChange', {
      done: doneCount.value,
      total: totalCount.value,
      currentText: currentTask.value?.text || '',
    })
  },
  { immediate: true },
)

onMounted(() => {
  loadSnapshot()
  cleanupChanged = platformApi.onTodoPlanChanged((data) => {
    if (!shouldRefreshChanged(data)) return
    if (data.scope === 'session-ai-todo' && data.document) {
      applyDocument(data.document)
      return
    }
    loadSnapshot()
  })
})

onUnmounted(() => {
  cleanupChanged?.()
})
</script>

<style scoped>
.todo-progress-panel {
  --todo-progress-rule: color-mix(in srgb, var(--ui-border-default-border) 54%, transparent);
  --todo-progress-muted: var(--ui-text-muted-fg);
  --todo-progress-accent: var(--ui-accent-primary-fg);

  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  color: var(--ui-text-primary-fg);
}

.todo-progress-head,
.todo-progress-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.todo-progress-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: color-mix(in srgb, var(--ui-text-primary-fg) 88%, var(--todo-progress-muted));
  font-size: 12px;
  font-weight: 650;
}

.todo-progress-title span,
.todo-progress-section-title,
.todo-progress-current-text,
.todo-progress-task span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.todo-progress-count,
.todo-progress-section-count {
  flex: 0 0 auto;
  color: var(--todo-progress-muted);
  font-size: 11px;
  font-weight: 650;
}

.todo-progress-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 92px;
  color: var(--todo-progress-muted);
  font-size: 12px;
}

.todo-progress-state.is-error {
  color: var(--ui-status-danger-fg);
}

/* 描红:点线基线,做完的一段描成朱砂实线 */
.todo-progress-meter {
  position: relative;
  flex: 0 0 auto;
  height: 0;
  margin: 12px 0;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-default-border) 90%, transparent);
}

.todo-progress-meter-fill {
  position: absolute;
  top: auto;
  bottom: -1.5px;
  left: 0;
  height: 0;
  border-bottom: 1.5px solid var(--todo-progress-accent);
}

.todo-progress-current {
  display: grid;
  gap: 4px;
  padding: 2px 0;
}

.todo-progress-current.is-complete {
  display: flex;
  align-items: center;
  color: color-mix(in srgb, var(--todo-progress-accent) 74%, var(--ui-status-success-fg, var(--todo-progress-accent)) 26%);
  font-size: 12px;
  font-weight: 650;
}

.todo-progress-current-label {
  color: var(--todo-progress-muted);
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
}

.todo-progress-current-text {
  color: var(--ui-text-primary-fg);
  font-size: 12px;
  line-height: 1.35;
}

.todo-progress-sections {
  display: grid;
  flex: 1 1 auto;
  align-content: start;
  gap: 12px;
  min-height: 0;
  margin-top: 12px;
  overflow: auto;
  padding-right: 2px;
}

.todo-progress-section {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.todo-progress-section-title {
  color: color-mix(in srgb, var(--ui-text-primary-fg) 82%, var(--todo-progress-muted));
  font-size: 11.5px;
  font-weight: 650;
}

.todo-progress-tasks {
  display: grid;
  gap: 5px;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}

/* 书目任务行:文字 …… 讫/…。完成的一行,点线描成朱砂。 */
.todo-progress-task {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 18px;
  color: color-mix(in srgb, var(--ui-text-secondary-fg) 90%, var(--todo-progress-muted));
  font-size: 11.5px;
  line-height: 1.3;
}

.todo-progress-task-leader {
  flex: 1 1 auto;
  height: 0;
  min-width: 10px;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-default-border) 85%, transparent);
  transform: translateY(1px);
}

.todo-progress-task-state {
  flex: 0 0 auto;
  color: var(--todo-progress-muted);
  font-size: 10px;
}

.todo-progress-task.done {
  color: var(--todo-progress-muted);
}

.todo-progress-task.done .todo-progress-task-leader {
  border-bottom-style: solid;
  border-bottom-color: var(--todo-progress-accent);
  opacity: 0.45;
}

.todo-progress-task.done .todo-progress-task-state {
  color: var(--todo-progress-accent);
}

.todo-progress-task.doing {
  color: var(--ui-text-primary-fg);
}

.todo-progress-task.doing .todo-progress-task-state {
  color: var(--todo-progress-accent);
}
</style>
