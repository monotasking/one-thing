<template>
  <section
    class="session-context"
    aria-label="Session context"
  >
    <section
      class="sctx-sec sctx-system-section"
      :class="{ focus: focusedSection === 'system' }"
      @mouseenter="scheduleFocus('system')"
      @mouseleave="cancelScheduledFocus"
    >
      <div class="sctx-sum">
        <button
          type="button"
          class="sctx-sum-main"
          :aria-expanded="focusedSection === 'system'"
          @click="setFocus('system')"
        >
          <span class="sctx-sum-title">System prompt</span>
          <span
            class="sctx-leader"
            aria-hidden="true"
          />
          <span class="sctx-sum-live">{{ systemSummary }}</span>
        </button>
        <Tooltip
          v-if="focusedSection === 'system'"
          text="Refresh system prompt"
        >
          <button
            type="button"
            class="sctx-icon-button"
            aria-label="Refresh system prompt"
            :disabled="systemPromptRefreshing || !props.sessionId || isDraftSession"
            @click.stop="refreshSystemPromptPanel"
          >
            <RefreshCw
              :size="14"
              :class="{ spinning: systemPromptRefreshing }"
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      </div>
      <div class="sctx-body">
        <SystemPromptPanel
          v-if="!isDraftSession"
          ref="systemPromptPanelRef"
          :session-id="props.sessionId"
          :working-directory="session?.workingDirectory || ''"
          :agent-id="session?.agentId"
          :last-provider="session?.lastProvider"
          :last-model="session?.lastModel"
          @summary-change="systemSummary = $event"
        />
        <div
          v-else
          class="sctx-draft-state"
        >
          System prompt will appear after the chat starts.
        </div>
      </div>
    </section>

    <!-- Todo 段是**读数 + 入口**,不是第二个编辑器:清单本身由 Todo 窗 /
         「任务」工作区页签编辑(08-16 草稿纸并入 Todo 窗之后那里是唯一的写入
         口),这里只画进度并把人送过去。 -->
    <section
      v-if="showTodoProgressPanel"
      class="sctx-sec sctx-todo-section"
      :class="{ focus: focusedSection === 'todo' }"
      @mouseenter="scheduleFocus('todo')"
      @mouseleave="cancelScheduledFocus"
    >
      <div class="sctx-sum">
        <button
          type="button"
          class="sctx-sum-main"
          :aria-expanded="focusedSection === 'todo'"
          @click="setFocus('todo')"
        >
          <span class="sctx-sum-title">Todo</span>
          <span
            class="sctx-leader"
            aria-hidden="true"
          />
          <span class="sctx-sum-live">{{ todoSummary }}</span>
        </button>
        <Tooltip
          v-if="focusedSection === 'todo'"
          text="Open the tasks panel"
        >
          <button
            type="button"
            class="sctx-icon-button"
            aria-label="Open the tasks panel"
            @click.stop="openTasksPanel"
          >
            <SquareArrowOutUpRight
              :size="14"
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      </div>
      <div class="sctx-body">
        <TodoProgressPanel
          :session-id="props.sessionId"
          @progress-change="todoProgress = $event"
        />
      </div>
    </section>

    <section
      v-if="!isDraftSession"
      class="sctx-sec sctx-variables-section"
      :class="{ focus: focusedSection === 'variables' }"
      @mouseenter="scheduleFocus('variables')"
      @mouseleave="cancelScheduledFocus"
    >
      <div class="sctx-sum">
        <button
          type="button"
          class="sctx-sum-main"
          :aria-expanded="focusedSection === 'variables'"
          @click="setFocus('variables')"
        >
          <span class="sctx-sum-title">Variables</span>
          <span
            class="sctx-leader"
            aria-hidden="true"
          />
          <span class="sctx-sum-live">{{ variablesSummary }}</span>
        </button>
      </div>
      <div class="sctx-body">
        <VariablesPanel
          :session-id="props.sessionId"
          @summary-change="variablesSummary = $event"
        />
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
/**
 * 右栏「Context」页签(会话域)—— 外壳布局收敛 L3。
 *
 * 承自 `components/chat/ChatSidePanel.vue` 的后三段(System prompt / Todo /
 * Variables),连同它那套**呼吸**:三段同显,聚焦的一段长开,其余压成一行活
 * 摘要 —— 一条会话的"上下文"本就该一眼看全,而不是三个各自折叠的抽屉。
 *
 * 与大纲栏时代的两处出入:
 *  · 段落组件(SystemPromptPanel / TodoProgressPanel / VariablesPanel)随本期
 *    一起搬进 `components/workbench/` —— 它们只服务这一个宿主;
 *  · Todo 段只读:编辑归 Todo 窗 /「任务」页签,这里给的是进度与一个入口。
 */
import { RefreshCw, SquareArrowOutUpRight } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useSessionsStore } from '@/stores/sessions'
import Tooltip from '@/components/common/Tooltip.vue'
import SystemPromptPanel from './SystemPromptPanel.vue'
import TodoProgressPanel from './TodoProgressPanel.vue'
import VariablesPanel from './VariablesPanel.vue'
import { workspacePanelWindowEvent } from '@/workspace/panel-registry'

type SectionId = 'system' | 'todo' | 'variables'

interface TodoProgressSummary {
  done: number
  total: number
  currentText: string
}

const props = withDefaults(defineProps<{
  sessionId?: string
}>(), {
  sessionId: undefined,
})

const FOCUS_STORAGE_KEY = 'workbenchContextSection'
const HOVER_FOCUS_DELAY_MS = 140

/**
 * Sections that may be restored from storage; 'system' is the fallback.
 * Declared here rather than beside readStoredFocus because that runs during
 * setup, before a const further down the file has initialised.
 */
const RESTORABLE_SECTIONS: readonly SectionId[] = ['system', 'todo', 'variables']

const settingsStore = useSettingsStore()
const sessionsStore = useSessionsStore()

const systemPromptPanelRef = ref<InstanceType<typeof SystemPromptPanel> | null>(null)
const systemPromptRefreshing = ref(false)
const focusedSection = ref<SectionId>(readStoredFocus())
const systemSummary = ref('')
const todoProgress = ref<TodoProgressSummary | null>(null)
const variablesSummary = ref('')
let hoverFocusTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 会话本体在这里**现查**,不再由外层一格一格透传下来(工作台只知道
 * `sessionId`)。工作目录 / agent / 上次用的模型全是 SystemPromptPanel 计算
 * 刷新键要的东西,它们的事实源本来就是这个 store。
 */
const session = computed(() => props.sessionId ? sessionsStore.getSessionItem(props.sessionId) : null)

const todoEnabled = computed(() => settingsStore.settings.general?.todoPlan?.enabled !== false)
const isDraftSession = computed(() => props.sessionId ? sessionsStore.isNewChatDraftId(props.sessionId) : false)
const showTodoProgressPanel = computed(() => todoEnabled.value && !isDraftSession.value)

const todoSummary = computed(() => {
  const progress = todoProgress.value
  if (!progress || progress.total === 0) return ''
  if (progress.done >= progress.total) return `${progress.done}/${progress.total} · complete`
  if (!progress.currentText) return `${progress.done}/${progress.total}`
  return `${progress.done}/${progress.total} · ${progress.currentText}`
})

function readStoredFocus(): SectionId {
  const stored = localStorage.getItem(FOCUS_STORAGE_KEY)
  // Derived from SectionId rather than listed inline: a hand-written chain
  // silently drops any section added later.
  return RESTORABLE_SECTIONS.includes(stored as SectionId) ? (stored as SectionId) : 'system'
}

function setFocus(section: SectionId) {
  cancelScheduledFocus()
  if (focusedSection.value === section) return
  focusedSection.value = section
  localStorage.setItem(FOCUS_STORAGE_KEY, section)
}

function scheduleFocus(section: SectionId) {
  if (focusedSection.value === section) return
  cancelScheduledFocus()
  hoverFocusTimer = setTimeout(() => {
    hoverFocusTimer = null
    setFocus(section)
  }, HOVER_FOCUS_DELAY_MS)
}

function cancelScheduledFocus() {
  if (!hoverFocusTimer) return
  clearTimeout(hoverFocusTimer)
  hoverFocusTimer = null
}

async function refreshSystemPromptPanel() {
  if (systemPromptRefreshing.value || !props.sessionId || isDraftSession.value) return
  systemPromptRefreshing.value = true
  try {
    await systemPromptPanelRef.value?.refreshSnapshot()
  } finally {
    systemPromptRefreshing.value = false
  }
}

/** 「去清单那边」——走既有的工作区面板入口(App 收事件 → 开「任务」页签)。 */
function openTasksPanel() {
  window.dispatchEvent(new CustomEvent(workspacePanelWindowEvent('tasks'), {
    detail: { action: 'open' },
  }))
}

function handleTodoToggleCard() {
  if (!showTodoProgressPanel.value) return
  setFocus('todo')
}

watch(showTodoProgressPanel, (visible) => {
  if (!visible && focusedSection.value === 'todo') setFocus('system')
}, { immediate: true })

watch(isDraftSession, (draft) => {
  if (draft && focusedSection.value === 'variables') setFocus('system')
}, { immediate: true })

watch(() => props.sessionId, () => {
  systemSummary.value = ''
  todoProgress.value = null
  variablesSummary.value = ''
})

onMounted(() => {
  window.addEventListener('todo-plan:toggle-card', handleTodoToggleCard)
})

onUnmounted(() => {
  cancelScheduledFocus()
  window.removeEventListener('todo-plan:toggle-card', handleTodoToggleCard)
})
</script>

<style scoped>
.session-context {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 4px 10px 10px;
  color: var(--ui-text-primary-fg);
}

/* 呼吸:三段同显,聚焦段长开,其余压成一行活摘要。 */
.sctx-sec {
  box-sizing: border-box;
  display: flex;
  flex: 0.0001 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 36px;
  overflow: hidden;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-default-border) 38%, transparent);
  transition: flex-grow var(--duration-slow) var(--ease-default);
}

.sctx-sec:last-of-type {
  border-bottom: 0;
}

.sctx-sec.focus {
  flex-grow: 1;
}

/* An empty section has nothing to breathe open for: it keeps its register
   line even while focused, instead of stretching a blank sheet down the
   column. Emptiness is read from each body's own empty-state marker. */
.sctx-sec.focus:has(.variables-state),
.sctx-sec.focus:has(.sctx-draft-state) {
  flex-grow: 0.0001;
}

.sctx-sum {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  min-height: 34px;
  padding: 8px 4px 8px 2px;
}

.sctx-sum-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.sctx-sum-title {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--ui-text-primary-fg) 82%, var(--ui-text-muted-fg));
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
}

/* 活摘要:未聚焦时是该段最要紧的一句话 */
.sctx-sum-live {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sctx-sec.focus .sctx-sum-live {
  visibility: hidden;
}

/* 点线:题名与摘要之间的引导线 */
.sctx-leader {
  flex: 1 1 auto;
  align-self: center;
  height: 0;
  min-width: 12px;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-strong-border) 85%, transparent);
  transform: translateY(1px);
}

.sctx-body {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-normal) var(--ease-default) var(--duration-fast);
}

.sctx-sec.focus .sctx-body {
  opacity: 1;
  pointer-events: auto;
}

.sctx-icon-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
}

.sctx-icon-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-state-hover-bg) 68%, transparent);
  color: var(--ui-text-primary-fg);
}

.sctx-icon-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.sctx-draft-state {
  display: flex;
  align-items: flex-start;
  min-height: 42px;
  padding: 9px 10px 10px;
  color: var(--ui-text-muted-fg);
  font-size: 12px;
  line-height: 1.35;
}

.spinning {
  animation: sctx-spin 0.8s linear infinite;
}

.sctx-variables-section :deep(.variables-panel) {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 10px;
}

.sctx-todo-section :deep(.todo-progress-panel) {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 10px;
}

.sctx-system-section :deep(.system-prompt-panel) {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .sctx-sec {
    transition: none;
  }

  .sctx-body {
    transition: none;
  }

  .spinning {
    animation: none;
  }
}

@keyframes sctx-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}
</style>
