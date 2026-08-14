<template>
  <!-- Archive 视图。P4 按设计稿(Claude Design «Media Panel», Turn 5 的五兄弟面板段)
       换成六面板共享骨架:PanelShell 控制条 / LedgerGroupHeader 月分组 /
       44px 账线行 / 26px 状态条。底色不在这里画:它住在工作台的 `surface="panel"` 面里。 -->
  <PanelShell
    class="archived-chats-content"
    :busy="sessionsStore.isLoading"
    :padded="false"
  >
    <template #controls>
      <!-- 控制条在窄面板里换行而不是把搜索框压扁:工作台最窄只有 250px,
           一行塞不下"搜索 + 分组丸 + 时间档"。 -->
      <div class="archive-controls">
        <FilterSearchInput
          v-model="searchQuery"
          size="compact"
          class="archive-search"
          placeholder="搜索已归档会话"
          label="搜索已归档会话"
          clear-label="清除搜索"
        />
        <SegmentedPill
          v-model="groupingModeModel"
          class="archive-grouping"
          :options="GROUPING_OPTIONS"
          aria-label="归档会话分组方式"
        />
        <Select
          v-model="timeRangeModel"
          class="archive-range"
          :options="TIME_RANGE_OPTIONS"
          aria-label="按时间筛选"
          fit-input-width
        />
      </div>
    </template>

    <div class="archive-scroll">
      <template v-if="groupedChats.length > 0">
        <section
          v-for="group in groupedChats"
          :key="group.key"
          class="chat-group"
        >
          <LedgerGroupHeader
            sticky
            collapsible
            :label="group.label"
            :count="group.sessions.length"
            :collapsed="collapsedGroups.has(group.key)"
            @update:collapsed="toggleGroup(group.key)"
          />
          <div
            v-show="!collapsedGroups.has(group.key)"
            class="chat-list"
          >
            <PanelLedgerRow
              v-for="session in group.sessions"
              :key="session.id"
              class="chat-row"
              :label="session.name || '未命名会话'"
              :meta="describeSession(session)"
              :active="sessionsStore.currentSessionId === session.id"
              role="button"
              tabindex="0"
              @click="viewChat(session)"
              @keydown.enter.prevent="viewChat(session)"
              @keydown.space.prevent="viewChat(session)"
            >
              <template #trail>
                <span
                  class="row-actions"
                  @click.stop
                >
                  <button
                    type="button"
                    class="row-action is-restore"
                    :aria-label="`恢复 ${session.name || '未命名会话'}`"
                    @click="restoreChat(session)"
                  >
                    <RotateCcw
                      :size="13"
                      :stroke-width="1.8"
                    />
                  </button>
                  <button
                    type="button"
                    class="row-action is-delete"
                    :aria-label="`永久删除 ${session.name || '未命名会话'}`"
                    @click="confirmDelete(session)"
                  >
                    <Trash2
                      :size="13"
                      :stroke-width="1.8"
                    />
                  </button>
                </span>
              </template>
            </PanelLedgerRow>
          </div>
        </section>
      </template>

      <!-- 空态两屏:库空 vs 筛空 —— 后者要能一键退回 -->
      <div
        v-else-if="isLibraryEmpty"
        class="empty-state"
      >
        <span
          class="empty-icon"
          aria-hidden="true"
        >
          <Archive
            :size="20"
            :stroke-width="1.6"
          />
        </span>
        <p class="empty-title">
          还没有归档的会话
        </p>
        <p class="empty-hint">
          删除的会话会先落到这里,恢复之前不会真的消失。
        </p>
      </div>

      <div
        v-else
        class="empty-state"
      >
        <span
          class="empty-icon"
          aria-hidden="true"
        >
          <SearchX
            :size="20"
            :stroke-width="1.6"
          />
        </span>
        <p class="empty-title">
          没有匹配的会话
        </p>
        <Button
          unstyled
          class="text-action is-primary"
          native-type="button"
          @click="clearFilters"
        >
          清除筛选
        </Button>
      </div>
    </div>

    <template #status>
      <span class="status-text">{{ statusText }}</span>
    </template>
  </PanelShell>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Archive, RotateCcw, SearchX, Trash2 } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import FilterSearchInput from '@/components/common/FilterSearchInput.vue'
import SegmentedPill from '@/components/common/SegmentedPill.vue'
import Select from '@/components/common/Select.vue'
import type { SelectOptionLike } from '@/components/common/select'
import LedgerGroupHeader from '@/components/workspace/LedgerGroupHeader.vue'
import PanelLedgerRow from '@/components/workspace/PanelLedgerRow.vue'
import PanelShell from '@/components/workspace/PanelShell.vue'
import { useConfirm } from '@/composables/useConfirm'
import { useSessionsStore } from '@/stores/sessions'
import type { ChatSession, ChatMessage } from '@/types'

const sessionsStore = useSessionsStore()
const { confirm } = useConfirm()

const searchQuery = ref('')
const groupingMode = ref<'date' | 'branch'>('date')
const timeRange = ref<TimeRange>('all')
const collapsedGroups = ref<Set<string>>(new Set())

type TimeRange = 'all' | '7d' | '30d' | 'year'

const GROUPING_OPTIONS = [
  { value: 'date', label: '日期' },
  { value: 'branch', label: '分支' },
]

const TIME_RANGE_OPTIONS: SelectOptionLike[] = [
  { value: 'all', label: '全部时间' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'year', label: '今年' },
]

/** 分段丸 / 下拉的 v-model 都是裸 string,这里把它接回各自的字面量联合。 */
const groupingModeModel = computed({
  get: () => groupingMode.value as string,
  set: (value: string) => {
    groupingMode.value = value as 'date' | 'branch'
  },
})

const timeRangeModel = computed({
  get: () => timeRange.value as string,
  set: (value: string) => {
    timeRange.value = value as TimeRange
  },
})

const DAY_MS = 24 * 60 * 60 * 1000

// Session type for archived list (messages may be undefined for optimized loading)
type ArchivedSession = Omit<ChatSession, 'messages'> & { messages?: ChatMessage[] }

interface ChatGroup {
  /** 折叠状态的键。分支模式下同名父会话可能重名,所以键不等于展示标签。 */
  key: string
  label: string
  sessions: ArchivedSession[]
}

function archivedTime(session: ArchivedSession): number {
  return session.archivedAt || session.updatedAt
}

function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedGroups.value = next
}

function clearFilters() {
  searchQuery.value = ''
  timeRange.value = 'all'
}

const archivedSessions = computed<ArchivedSession[]>(() => sessionsStore.archivedSessions)

const isLibraryEmpty = computed(() => archivedSessions.value.length === 0)

const filteredSessions = computed<ArchivedSession[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  const now = Date.now()
  let cutoff = 0
  if (timeRange.value === '7d') cutoff = now - 7 * DAY_MS
  else if (timeRange.value === '30d') cutoff = now - 30 * DAY_MS
  else if (timeRange.value === 'year') cutoff = new Date(new Date().getFullYear(), 0, 1).getTime()

  return archivedSessions.value.filter((session) => {
    if (cutoff && archivedTime(session) < cutoff) return false
    if (!query) return true
    return (session.name || '').toLowerCase().includes(query)
  })
})

/** 月分组(设计稿:`8 月 (14)`)。跨年的月份带上年份,免得两个「8 月」并排。 */
function groupByMonth(sessions: ArchivedSession[]): ChatGroup[] {
  const currentYear = new Date().getFullYear()
  const buckets = new Map<string, ChatGroup>()

  for (const session of [...sessions].sort((a, b) => archivedTime(b) - archivedTime(a))) {
    const date = new Date(archivedTime(session))
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const key = `${year}-${String(month).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        key,
        label: year === currentYear ? `${month} 月` : `${year} 年 ${month} 月`,
        sessions: [],
      }
      buckets.set(key, bucket)
    }
    bucket.sessions.push(session)
  }

  return [...buckets.values()]
}

// Group sessions by branch relationship
function groupByBranch(sessions: ArchivedSession[]): ChatGroup[] {
  if (sessions.length === 0) return []

  const groups: ChatGroup[] = []

  // First, find all parent sessions (sessions without parentSessionId or whose parent is not archived)
  const parentSessions = sessions.filter((s) => {
    if (!s.parentSessionId) return true
    // Check if parent is also in archived list
    const parentInArchived = sessions.find(p => p.id === s.parentSessionId)
    return !parentInArchived
  })

  // For each parent, create a group with it and its branches
  for (const parent of parentSessions) {
    // Find all branches of this parent (recursively)
    function findBranches(parentId: string): ArchivedSession[] {
      const directBranches = sessions.filter(s => s.parentSessionId === parentId)
      let allBranches: ArchivedSession[] = [...directBranches]
      for (const branch of directBranches) {
        allBranches = allBranches.concat(findBranches(branch.id))
      }
      return allBranches
    }

    groups.push({
      key: parent.id,
      label: parent.name || '未命名会话',
      sessions: [parent, ...findBranches(parent.id)],
    })
  }

  // Sort groups by most recent activity
  groups.sort((a, b) => {
    const aTime = Math.max(...a.sessions.map(archivedTime))
    const bTime = Math.max(...b.sessions.map(archivedTime))
    return bTime - aTime
  })

  return groups
}

const groupedChats = computed<ChatGroup[]>(() => {
  const sessions = filteredSessions.value
  if (sessions.length === 0) return []
  return groupingMode.value === 'branch' ? groupByBranch(sessions) : groupByMonth(sessions)
})

/** 副行:`8 月 6 日 · 92 条消息 · Sonnet 4.5`。缺的段直接不出现,不留占位。 */
function describeSession(session: ArchivedSession): string {
  const parts: string[] = [formatDate(archivedTime(session))]
  if (session.parentSessionId) parts.push(`↳ ${getParentName(session.parentSessionId)}`)
  const messages = session.messages?.length
  if (messages) parts.push(`${messages} 条消息`)
  const branches = getBranchCount(session.id)
  if (branches > 0) parts.push(`${branches} 个分支`)
  if (session.lastModel) parts.push(session.lastModel)
  return parts.join(' · ')
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = date.getFullYear()
  const suffix = year === new Date().getFullYear() ? '' : `${year} 年 `
  return `${suffix}${month} 月 ${day} 日`
}

// Get parent session name
function getParentName(parentId: string): string {
  const parent = sessionsStore.sessions.find(s => s.id === parentId)
  return parent?.name || '父会话'
}

// Get number of branches for a session
function getBranchCount(sessionId: string): number {
  return sessionsStore.sessions.filter(s => s.parentSessionId === sessionId && s.isArchived).length
}

const statusText = computed(() => {
  if (sessionsStore.isLoading) return '正在读取归档…'
  const total = archivedSessions.value.length
  if (total === 0) return '归档为空'
  const shown = filteredSessions.value.length
  const mode = groupingMode.value === 'branch' ? '按分支分组' : '按月份分组'
  if (shown === total) return `共 ${total} 个会话 · ${mode}`
  return `筛出 ${shown} / 共 ${total} 个会话 · ${mode}`
})

// View archived chat (switch to it in ChatWindow)
async function viewChat(session: ArchivedSession) {
  await sessionsStore.switchSession(session.id)
}

// Restore chat from archive
async function restoreChat(session: ArchivedSession) {
  await sessionsStore.restoreSession(session.id)
}

// Confirm and permanently delete chat
async function confirmDelete(session: ArchivedSession) {
  const confirmed = await confirm({
    title: '删除会话',
    message: `永久删除「${session.name || '未命名会话'}」?此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  })
  if (!confirmed) return
  await sessionsStore.permanentlyDeleteSession(session.id)
}
</script>

<style scoped>
.archived-chats-content {
  min-width: 0;
}

.archive-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.archive-search {
  flex: 1 1 140px;
  min-width: 0;
}

.archive-grouping,
.archive-range {
  flex: 0 0 auto;
}

.archive-range {
  min-width: 104px;
}

.archive-scroll {
  padding: 0 14px 16px;
}

.chat-group {
  min-width: 0;
}

.chat-list {
  min-width: 0;
}

/* ---- 行尾操作:hover 才现 ---- */
.row-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.chat-row:hover .row-actions,
.chat-row:focus-visible .row-actions,
.row-actions:focus-within {
  opacity: 1;
}

.row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  /* 静止时一律墨色 —— 破坏性动作不在待机状态喊叫(ui-system §1)。 */
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.row-action:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

.row-action.is-restore:hover {
  background: var(--ui-state-hover-accent-bg);
  color: var(--ui-accent-primary-fg);
}

.row-action.is-delete:hover {
  background: var(--ui-status-danger-bg);
  color: var(--ui-status-danger-fg);
}

/* ---- 空态 ---- */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 24px 0;
  text-align: center;
}

.empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border: 1px dashed var(--ui-border-strong-border);
  border-radius: 10px;
  color: var(--ui-text-faint-fg);
}

.empty-title {
  margin: 0;
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 16px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

.empty-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ui-text-secondary-fg);
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
