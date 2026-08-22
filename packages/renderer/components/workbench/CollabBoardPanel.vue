<template>
  <section class="board-panel">
    <header class="board-header">
      <Select
        class="board-room-select"
        size="small"
        teleported
        fit-input-width
        :model-value="selectedRoomId"
        :options="roomOptions"
        aria-label="选择群聊房间"
        @update:model-value="selectedRoomId = String($event ?? '')"
      />
      <div
        v-if="selectedRoomId"
        class="board-header-actions"
      >
        <Tooltip :text="view === 'deliverables' ? '回到看板' : '按任务查看交付物文件'">
          <button
            type="button"
            class="board-view-toggle"
            :class="{ 'is-active': view === 'deliverables' }"
            @click="toggleView"
          >
            交付物<span
              v-if="deliverableCount > 0"
              class="board-view-count"
            >{{ deliverableCount }}</span>
          </button>
        </Tooltip>
        <Tooltip
          v-if="!editingBudget"
          text="点击修改日预算(0 = 不限)"
        >
          <button
            type="button"
            class="board-budget"
            @click="startEditBudget"
          >
            预算 {{ budgetLabel }}
          </button>
        </Tooltip>
        <input
          v-else
          ref="budgetInputRef"
          v-model.number="budgetDraft"
          class="board-budget-input"
          type="number"
          min="0"
          step="0.5"
          @keydown.enter="commitBudget"
          @keydown.esc="editingBudget = false"
          @blur="commitBudget"
        >
        <Tooltip
          v-if="roomFolder"
          :text="roomFolder"
        >
          <button
            type="button"
            class="board-budget"
            @click="openRoomFolder"
          >
            群 folder
          </button>
        </Tooltip>
        <button
          type="button"
          class="board-freeze"
          :class="{ 'is-frozen': isFrozen }"
          @click="toggleFrozen"
        >
          {{ isFrozen ? '已暂停 · 点击恢复' : '全部暂停' }}
        </button>
      </div>
    </header>

    <div
      v-if="hint"
      class="board-hint"
    >
      {{ hint }}
    </div>

    <div
      v-if="!selectedRoomId"
      class="board-empty"
    >
      还没有群聊房间——先在侧栏「群聊」区建一个。
    </div>

    <div
      v-else-if="view === 'deliverables'"
      class="board-deliverables"
    >
      <div
        v-if="deliverableGroups.length === 0"
        class="board-empty"
      >
        {{ deliverablesEmptyText }}
      </div>
      <div
        v-for="group in deliverableGroups"
        :key="group.taskId"
        class="deliverable-group"
      >
        <div class="deliverable-task">
          {{ group.title }}
        </div>
        <button
          v-for="file in group.files"
          :key="file"
          type="button"
          class="deliverable-file"
          :aria-label="fileTitle(file)"
          @click="openDeliverable(file)"
        >
          <span class="deliverable-name">{{ fileParts(file).name }}</span>
          <span
            v-if="fileParts(file).dir"
            class="deliverable-dir"
          >{{ fileParts(file).dir }}</span>
        </button>
      </div>
    </div>

    <div
      v-else
      class="board-columns"
    >
      <div
        v-for="column in columns"
        :key="column.status"
        class="board-column"
      >
        <div class="board-column-title">
          {{ column.label }}
          <span class="board-column-count">{{ tasksBy(column.status).length }}</span>
        </div>
        <div
          v-for="task in tasksBy(column.status)"
          :key="task.id"
          class="board-card-slot"
          :class="{ 'is-focused': task.id === highlightedTaskId }"
          :data-task-id="task.id"
          @contextmenu.prevent="openMenu($event, task)"
        >
          <button
            type="button"
            class="board-card"
            @click="openWorkSession(task)"
          >
            <span class="board-card-title">{{ task.title }}</span>
            <span
              v-if="task.status === 'blocked' && task.blockReason"
              class="board-card-note"
            >{{ task.blockReason }}</span>
            <span
              v-if="task.status === 'done'"
              class="board-card-note"
            >{{ evidenceLabel(task) }}</span>
            <span class="board-card-meta">
              <span
                v-if="task.assigneeAgentId"
                class="board-card-assignee"
                :class="{ 'is-retired': isAgentRetired(task.assigneeAgentId) }"
              >
                <AgentAvatar
                  class="board-card-mark"
                  :avatar="agentAvatar(task.assigneeAgentId)"
                  :avatar-image="agentAvatarImage(task.assigneeAgentId)"
                  :size="12"
                />
                {{ agentName(task.assigneeAgentId) }}
              </span>
              <span
                v-if="task.rejections > 0"
                class="board-card-reject"
              >打回×{{ task.rejections }}</span>
              <span
                v-if="task.status === 'blocked' && (task.haltedCount ?? 0) >= 1"
                class="board-card-reject"
              >受阻×{{ task.haltedCount }}</span>
              <span
                v-if="boardStore.hasPendingAsk(task.workSessionIds[task.workSessionIds.length - 1])"
                class="board-card-ask"
              >⚠ 等待授权</span>
              <span
                v-if="task.workSessionIds.length > 0"
                class="board-card-open"
              >现场 ↗</span>
            </span>
          </button>
          <button
            type="button"
            class="board-card-more"
            aria-label="卡片操作"
            @click.stop="openMenu($event, task)"
          >
            ⋯
          </button>
          <!-- 交付物(W17):文件行是可点的,所以必须留在卡片 button 之外 -->
          <div
            v-if="cardFiles(task).length > 0"
            class="board-card-files"
          >
            <button
              v-for="file in cardFiles(task)"
              :key="file"
              type="button"
              class="deliverable-file is-card"
              :aria-label="fileTitle(file)"
              @click.stop="openDeliverable(file)"
            >
              {{ fileParts(file).name }}
            </button>
            <span
              v-if="deliverables(task).length > cardFiles(task).length"
              class="board-card-files-more"
            >+{{ deliverables(task).length - cardFiles(task).length }}</span>
          </div>
        </div>
      </div>
    </div>

    <ContextMenu
      :show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @select="runMenuAction"
      @close="closeMenu"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { CollabTask, CollabTaskStatus } from '@shared/ipc.js'
import { shellApi } from '@/platform/shell-domain-client'
import { collabApi } from '@/platform/collab-client'
import { isActiveAgent } from '@shared/ipc'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { AGENT_AVATAR_FALLBACK } from '@/components/common/agent-avatar'
import ContextMenu from '@/components/common/ContextMenu.vue'
import Select from '@/components/common/Select.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import type { SelectOptionLike } from '@/components/common/select'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  BOARD_CARD_FILES_LIMIT,
  BOARD_COLUMNS,
  BOARD_CONFLICT_HINT,
  BOARD_DELIVERABLES_EMPTY_TEXT,
  BOARD_CARD_STOP_WORK_ITEM_ID,
  buildBoardCardAction,
  buildBoardCardMenuItems,
  collectBoardDeliverables,
  countBoardDeliverables,
  formatBoardEvidenceLabel,
  isBoardRevConflict,
  resolveDeliverablePath,
  splitDeliverablePath,
  taskDeliverables,
} from './collab-board-card'

const sessionsStore = useSessionsStore()
const agentsStore = useAgentsStore()
const boardStore = useCollabBoardStore()
const workspaceStore = useWorkspaceStore()

void Promise.resolve(agentsStore.loadAgents()).catch(() => {})

const columns = BOARD_COLUMNS

// 卡片操作(W16)的浮层状态。声明放在前面,好让房间切换的 watch 能复位它们
// —— setup 里的 const 没有提升,晚声明会在 immediate 那一跑里踩 TDZ。
const menu = ref({ show: false, x: 0, y: 0 })
const menuTask = ref<CollabTask | null>(null)
const hint = ref('')

// 交付物视图(W17):同一个面板换视图,不开第二块面板(§3.6)。
const view = ref<'board' | 'deliverables'>('board')
const deliverablesEmptyText = BOARD_DELIVERABLES_EMPTY_TEXT

function closeMenu(): void {
  menu.value = { ...menu.value, show: false }
  menuTask.value = null
}

// 全部房,私聊房也算:单成员 dm 房的看板就是「我交给小李的活」清单
// (agent-im-dm.md §2.2),它有板就该能被选到 —— 这里是「哪些板可看」,
// 不是侧栏那份「群聊列表」。
const rooms = computed(() => sessionsStore.roomSessions)

const roomOptions = computed<SelectOptionLike[]>(() =>
  rooms.value.map(room => ({ value: room.id, label: room.name })),
)

function defaultRoomId(): string {
  const current = sessionsStore.sessions.find(s => s.id === sessionsStore.currentSessionId)
  if (current?.kind === 'room') return current.id
  if (current?.kind === 'work' && current.collab?.roomSessionId) return current.collab.roomSessionId
  return rooms.value[0]?.id ?? ''
}

const selectedRoomId = ref(defaultRoomId())

watch(rooms, list => {
  if (!selectedRoomId.value && list.length > 0) selectedRoomId.value = list[0].id
})

watch(selectedRoomId, id => {
  // A refusal belongs to the board it came from — carrying it to another room
  // would accuse a board nothing happened to.
  hint.value = ''
  closeMenu()
  // 换房间回到看板:交付物视图是对「这块板」的追问,不该跟着漂到别处。
  view.value = 'board'
  if (id) void boardStore.load(id)
}, { immediate: true })

const board = computed(() => selectedRoomId.value ? boardStore.boardFor(selectedRoomId.value) : undefined)
const selectedRoom = computed(() =>
  sessionsStore.sessions.find(s => s.id === selectedRoomId.value)?.room)
const isFrozen = computed(() => Boolean(selectedRoom.value?.frozen))

// 日预算可配置(0 = 不限;缺省 $5,与协调器默认一致)
const editingBudget = ref(false)
const budgetDraft = ref(5)
const budgetInputRef = ref<HTMLInputElement | null>(null)
const budgetLabel = computed(() => {
  const limit = selectedRoom.value?.budgets?.dailyCostUSD ?? 5
  return limit <= 0 ? '不限' : `$${limit}/日`
})

function startEditBudget(): void {
  budgetDraft.value = selectedRoom.value?.budgets?.dailyCostUSD ?? 5
  editingBudget.value = true
  void nextTick(() => budgetInputRef.value?.focus())
}

/**
 * The two room-wide switches (P1-4). Both used to `.catch(() => {})` and then
 * reload the session list regardless, so a refused write repainted the control
 * back to its old position with nothing said — the user reads that as a UI that
 * ignored the click. Failures now leave a hint line, exactly like the card menu
 * and RoomSettingsDialog do; only a success reloads.
 */
async function commitBudget(): Promise<void> {
  if (!editingBudget.value) return
  editingBudget.value = false
  const value = Number.isFinite(budgetDraft.value) && budgetDraft.value >= 0 ? budgetDraft.value : null
  if (value === null || !selectedRoomId.value) return
  try {
    // 写与回填约定都在 sessions store 的 action 里(架构收敛 C4 §4);
    // 新预算由 `session:collab-updated` 推回来。
    const response = await sessionsStore.setCollabRoomBudgets(selectedRoomId.value, { dailyCostUSD: value })
    if (!response?.success) {
      hint.value = response?.error || '预算没有保存成功'
      return
    }
    hint.value = ''
  } catch (error) {
    hint.value = error instanceof Error ? error.message : String(error)
  }
}

function tasksBy(status: CollabTaskStatus): CollabTask[] {
  return (board.value?.tasks ?? []).filter(task => task.status === status)
}

// 卡上的执行人一律走 displayAgent(域模型 M4):在职/已退休都显示本人身份,
// 查无此人显示墓碑「已注销」。一张老卡指着一个已退休的人是正常现场 —— 板上要
// 认得出是谁做的,这正是"退休不是删除"要保住的读得出的历史。
function agentName(agentId: string): string {
  return agentsStore.displayAgent(agentId).name
}

function agentAvatar(agentId: string): string {
  return agentsStore.displayAgent(agentId).avatar ?? AGENT_AVATAR_FALLBACK
}

function agentAvatarImage(agentId: string): string | undefined {
  return agentsStore.displayAgent(agentId).avatarImage
}

/** 已退休/查无此人 → 卡上的执行人灰显(§3.2 的成员条同一套语义)。 */
function isAgentRetired(agentId: string): boolean {
  return !isActiveAgent(agentsStore.displayAgent(agentId))
}

function openWorkSession(task: CollabTask): void {
  const workSessionId = task.workSessionIds[task.workSessionIds.length - 1]
  if (workSessionId) workspaceStore.openSession(workSessionId)
}

/**
 * 消息里点了一枚 `<card>` 标签(collab-team-v2 §6.1 点击链路)。
 *
 * 这块面板是被裸实例化的(无 props、无 defineExpose),所以"定位到那张卡"这条
 * 命令经 store 传达。三件事按顺序办:切到卡所在的房间、把视图掰回看板(卡在
 * 交付物视图里根本不在场)、滚过去并高亮一下。
 */
const highlightedTaskId = ref('')
let highlightTimer: ReturnType<typeof setTimeout> | null = null

watch(() => boardStore.focusedTask, async focus => {
  if (!focus) return
  if (selectedRoomId.value !== focus.roomSessionId) selectedRoomId.value = focus.roomSessionId
  view.value = 'board'
  await nextTick()
  const slot = document.querySelector<HTMLElement>(`.board-card-slot[data-task-id="${CSS.escape(focus.taskId)}"]`)
  slot?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  highlightedTaskId.value = focus.taskId
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedTaskId.value = ''
    highlightTimer = null
  }, 2000)
})

async function toggleFrozen(): Promise<void> {
  if (!selectedRoomId.value) return
  const next = !isFrozen.value
  try {
    const response = await sessionsStore.setCollabRoomFrozen(selectedRoomId.value, next)
    if (!response?.success) {
      hint.value = response?.error || (next ? '暂停没有生效' : '恢复没有生效')
      return
    }
    hint.value = ''
    // 冻结开关的新位置由 `session:collab-updated` 推回来(架构收敛 C4 §3/§4)。
  } catch (error) {
    hint.value = error instanceof Error ? error.message : String(error)
  }
}

// ── 卡片操作(W16)────────────────────────────────────────────────────────
// The card menu acts on the card AS THE USER SAW IT: the task is snapshotted
// when the menu opens, so the rev travelling with the action is the one the
// user's eyes were on. Reading it live at click time would let a concurrent
// agent write slip through the optimistic-concurrency check unnoticed.
const menuItems = computed(() => menuTask.value
  ? buildBoardCardMenuItems({
      task: menuTask.value,
      agents: agentsStore.agents,
      memberAgentIds: selectedRoom.value?.memberAgentIds ?? [],
    })
  : [])

function openMenu(event: MouseEvent, task: CollabTask): void {
  menuTask.value = { ...task }
  menu.value = { show: true, x: event.clientX, y: event.clientY }
}

function evidenceLabel(task: CollabTask): string {
  return formatBoardEvidenceLabel(task)
}

// ── 群 folder(collab-team-v2 §7)与交付物(W17)───────────────────────────
/**
 * 群 folder 的绝对路径**由后端答** —— 渲染进程不拼 `<store>/rooms/<id>`。
 *
 * 此前这里读的是房间会话的 `workingDirectory`,而自动分配的 folder 是 app 层
 * 现算的、刻意不落库(`room-folder.ts`:folder = workingDirectory ?? <store>/
 * rooms/<id>)。于是「没人手动设过工作目录」的房 —— 也就是绝大多数房 —— 在
 * 工作台上既看不见「群 folder」按钮,也还原不出交付物的相对路径:群里明明有
 * 文件,工作台却说这儿什么都没有。
 *
 * 改成问一次既有的列目录通道,取它答的 `folder`:那正是同一个定义,配置过
 * 工作目录的房自然也是这个口径(后端本来就先看配置)。
 *
 * 问不到(通道失败 / web 端的 stub)就留空 —— 按钮隐身、交付物退回「只认绝对
 * 路径」,与改动前的降级一致:宁可不给入口,也不给一个点开是别处的入口。
 */
const roomFolder = ref('')

async function loadRoomFolder(roomSessionId: string): Promise<void> {
  roomFolder.value = ''
  if (!roomSessionId) return
  try {
    const response = await collabApi.roomFolderList({ roomSessionId })
    // 迟到的回复不许盖掉已经换过的房。
    if (selectedRoomId.value !== roomSessionId) return
    if (response?.success && response.folder) roomFolder.value = response.folder
  } catch {
    // 读不到 folder 不该让看板出错:按钮隐身就是答案。
  }
}

// 单独一个 watch:folder 是 IO,和看板数据各走各的,一个慢不拖另一个。
watch(selectedRoomId, id => { void loadRoomFolder(id) }, { immediate: true })

const deliverableGroups = computed(() => collectBoardDeliverables(board.value?.tasks ?? []))
const deliverableCount = computed(() => countBoardDeliverables(board.value?.tasks ?? []))

function toggleView(): void {
  view.value = view.value === 'deliverables' ? 'board' : 'deliverables'
}

function deliverables(task: CollabTask): string[] {
  return taskDeliverables(task)
}

function cardFiles(task: CollabTask): string[] {
  return taskDeliverables(task).slice(0, BOARD_CARD_FILES_LIMIT)
}

function fileParts(file: string): { name: string; dir: string } {
  return splitDeliverablePath(file)
}

/** Hover shows the path the shell would actually open — the stored one if we cannot resolve. */
function fileTitle(file: string): string {
  return resolveDeliverablePath(file, roomFolder.value) || file
}

/**
 * 群 folder 的文件树(collab-team-v2 §7)。
 *
 * 这块面板够不着 RightWorkbenchPanel(它是被裸实例化的),所以和「看板直达」
 * 同一个套路:往 window 上派一个事件,App 层接住并把 files 页签的根换过去。
 */
function openRoomFolder(): void {
  const root = roomFolder.value
  if (!root) return
  window.dispatchEvent(new CustomEvent('onething:collab-open-folder', { detail: { root } }))
}

async function openDeliverable(file: string): Promise<void> {
  const absolute = resolveDeliverablePath(file, roomFolder.value)
  if (!absolute) {
    hint.value = '还没拿到这个群的 folder,无法定位交付物'
    return
  }
  try {
    // Electron hands back '' on success and a message on failure; the web host
    // hands back an unsupported-method object. Both are surfaced as one hint
    // line rather than swallowed — a click that does nothing must say why.
    const result: unknown = await shellApi.openPath({ filePath: absolute })
    hint.value = typeof result === 'string'
      ? result
      : (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string'
          ? (result as { error: string }).error
          : '')
  } catch (error) {
    hint.value = error instanceof Error ? error.message : String(error)
  }
}

async function runMenuAction(itemId: string): Promise<void> {
  const task = menuTask.value
  const roomSessionId = selectedRoomId.value
  closeMenu()
  if (!task || !roomSessionId) return

  // 停止执行不是一次看板写入:它停的是运行时的一条流,卡的收敛与群里的说明
  // 都由主进程那一侧一起办掉(collab-team-v2 §5.1 入口②)。
  if (itemId === BOARD_CARD_STOP_WORK_ITEM_ID) {
    try {
      const response = await boardStore.stopTask(roomSessionId, task.id)
      hint.value = response?.success
        ? (response.stopped ? '' : '这张卡当前没有在跑的执行')
        : (response?.error || '停止失败')
    } catch (error) {
      hint.value = error instanceof Error ? error.message : String(error)
    }
    return
  }

  const action = buildBoardCardAction(itemId, task)
  if (!action) return
  try {
    // 回填(回复带板就当场落账)在 `boardStore.actBoard` 里 —— 一次被拒的写也照样
    // 从真值重画,这才是下面这句冲突提示的底气。
    const response = await boardStore.actBoard(roomSessionId, action)
    hint.value = response?.success
      ? ''
      : isBoardRevConflict(response?.error) ? BOARD_CONFLICT_HINT : (response?.error || '操作失败')
  } catch (error) {
    hint.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<style scoped>
.board-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-border-strong-border);
}

/* P3: the room picker is `<Select>` — the component owns the frame, the fill
   and the caret. Footprint only here.
   `.app-select` qualifies the selector because the component's own rule is
   `width: 100%` at (0,1,0): a bare `.board-room-select` would tie with it and
   the header would hand the picker 60% of the bar no matter how short the room
   name is. `width: auto` restores the native select's shrink-to-fit. */
.app-select.board-room-select {
  width: auto;
  min-width: 120px;
  max-width: 60%;
}

.board-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.board-budget {
  font: inherit;
  font-size: 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--ui-text-muted-fg);
}

.board-budget:hover {
  color: var(--ui-text-primary-fg);
}

.board-budget-input {
  font: inherit;
  font-size: 12px;
  width: 64px;
  padding: 2px 5px;
  border: 1px solid var(--ui-border-strong-border);
  border-radius: 5px;
  background: var(--ui-surface-app-bg);
  color: var(--ui-text-primary-fg);
}

.board-freeze {
  font: inherit;
  font-size: 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--ui-text-muted-fg);
}

/* 视图切换:一行墨灰文字,选中只加深不做胶囊底(§3.6) */
.board-view-toggle {
  font: inherit;
  font-size: 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--ui-text-muted-fg);
}

.board-view-toggle:hover,
.board-view-toggle.is-active {
  color: var(--ui-text-primary-fg);
}

.board-view-count {
  margin-left: 3px;
  opacity: 0.7;
}

.board-freeze.is-frozen {
  color: var(--ui-status-danger-fg);
}

.board-empty {
  padding: 24px 16px;
  font-size: 13px;
  color: var(--ui-text-muted-fg);
}

/* 冲突/失败提示:一行墨灰,不做卡片不做图标(§3.6) */
.board-hint {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.board-columns {
  flex: 1;
  display: flex;
  gap: 8px;
  padding: 10px;
  overflow-x: auto;
  align-items: flex-start;
}

.board-column {
  flex: 0 0 168px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.board-column-title {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--ui-text-muted-fg);
  display: flex;
  justify-content: space-between;
  padding: 0 2px;
  user-select: none;
}

.board-column-count {
  opacity: 0.7;
}

/* 卡片外壳只为放操作入口和交付物行:两者都不能嵌在 .board-card 这个 button 里。 */
.board-card-slot {
  position: relative;
  display: flex;
  flex-direction: column;
}

/* 从消息里点标签跳过来的那张卡:亮一下就退,不留常驻选中态 —— 定位是一次
   动作,不是一种状态。 */
.board-card-slot.is-focused .board-card {
  --board-focus-accent: var(--ui-accent-primary-fg);
  border-color: var(--board-focus-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--board-focus-accent) 18%, transparent);
  transition: box-shadow var(--duration-normal) var(--ease-default), border-color var(--duration-normal) var(--ease-default);
}

.board-card {
  font: inherit;
  text-align: left;
  border: 1px solid var(--ui-border-strong-border);
  border-radius: 6px;
  background: var(--ui-surface-app-bg);
  padding: 7px 8px;
  cursor: pointer;
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

/* 常驻留白而非 hover 时挪位:⋯ 出现不该把标题推走。 */
.board-card-more {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  opacity: 0;
}

.board-card-slot:hover .board-card-more,
.board-card-more:focus-visible {
  opacity: 1;
}

.board-card-more:hover {
  color: var(--ui-text-primary-fg);
}

.board-card-title {
  font-size: 12px;
  padding-right: 16px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* 受阻原因 / 执行证据:同一条墨灰小字,两行截断。 */
.board-card-note {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.board-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

/* 指派人:章 + 名字一行。章跟着 meta 的 11px 走,只有图片头像需要一个盒子。 */
.board-card-assignee {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

/* 执行人已退休/查无此人:压暗。卡还在,人不在了 —— 这张卡需要改派。 */
.board-card-assignee.is-retired {
  opacity: 0.6;
}

.board-card-reject {
  color: var(--ui-status-danger-fg);
}

.board-card-ask {
  color: var(--ui-status-danger-fg);
  font-weight: 600;
}

.board-card-open {
  margin-left: auto;
}

/* ── 交付物(W17)──────────────────────────────────────────────────────── */

/* 卡片下方挂一小串文件名,靠左内缩对齐卡片正文,不再画第二个框。 */
.board-card-files {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 3px 8px 0;
}

.board-card-files-more {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

.deliverable-file {
  font: inherit;
  font-size: 11px;
  text-align: left;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  max-width: 100%;
  color: var(--ui-text-muted-fg);
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.deliverable-file:hover,
.deliverable-file:focus-visible {
  color: var(--ui-text-primary-fg);
}

.deliverable-file.is-card {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-deliverables {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.deliverable-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 任务标题只作分组抬头:一条细墨线压住,不做卡片(§3.6) */
.deliverable-task {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--ui-text-muted-fg);
  padding-bottom: 3px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.deliverable-name {
  color: var(--ui-text-primary-fg);
  flex: 0 0 auto;
}

.deliverable-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>
