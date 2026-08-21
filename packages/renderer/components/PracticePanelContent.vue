<template>
  <!-- Practice 视图。P4 换成六面板共享骨架:PanelShell 控制条 / LedgerGroupHeader 分组头 /
       带 3px 进度条的 44px 账线行 / 26px 状态条。参数表单与账页 `<table>` 原样保留,
       只是各自收进一个分组里。底色住在工作台的 `surface="panel"` 面里。 -->
  <PanelShell
    class="practice-panel"
    :busy="practiceStore.isRunning"
    :padded="false"
  >
    <template #controls>
      <div class="practice-controls">
        <FilterSearchInput
          v-model="searchQuery"
          size="compact"
          class="practice-search"
          placeholder="搜索练习记录"
          label="搜索练习记录"
          clear-label="清除搜索"
        />
        <PanelPrimaryAction
          :disabled="practiceStore.isRunning"
          @click="startPractice"
        >
          {{ practiceStore.isRunning ? '进行中' : '开始练习' }}
        </PanelPrimaryAction>
      </div>
    </template>

    <div class="practice-scroll">
      <!-- 参数:配置形态的交互默认收起 —— 面板首屏该是"发生了什么",不是"怎么设" -->
      <section class="practice-group">
        <LedgerGroupHeader
          sticky
          collapsible
          label="参数"
          :collapsed="paramsCollapsed"
          @update:collapsed="paramsCollapsed = $event"
        />
        <div
          v-show="!paramsCollapsed"
          class="params"
        >
          <div class="param-row">
            <span class="param-name">凯格尔</span>
            <span class="param-body">
              收 <input
                class="num"
                :value="kegelConfig.holdSec"
                @change="onKegelParam('holdSec', $event)"
              >″
              · 放 <input
                class="num"
                :value="kegelConfig.relaxSec"
                @change="onKegelParam('relaxSec', $event)"
              >″
              · 每组 <input
                class="num"
                :value="kegelConfig.reps"
                @change="onKegelParam('reps', $event)"
              > 次
              · <input
                class="num"
                :value="kegelConfig.sets"
                @change="onKegelParam('sets', $event)"
              > 组
              · 组间息 <input
                class="num num-wide"
                :value="kegelConfig.setRestSec"
                @change="onKegelParam('setRestSec', $event)"
              >″
            </span>
          </div>
          <div class="param-note">
            数字点击就地修改,立即生效;下次开始即按新参数
          </div>
          <div class="param-row">
            <span class="param-name">番茄</span>
            <span class="param-body">
              时长 <input
                class="num"
                :value="pomodoroConfig.minutes"
                @change="onPomodoroMinutes($event)"
              >′
              · 分类
              <span
                v-for="cat in pomodoroConfig.categories"
                :key="cat"
                class="cat-chip"
              >
                {{ cat }}
                <span
                  v-if="pomodoroConfig.categories.length > 1"
                  class="cat-remove"
                  @click="removeCategory(cat)"
                >×</span>
              </span>
              <input
                v-model="newCategory"
                class="cat-add"
                placeholder="+ 新分类"
                spellcheck="false"
                @keydown.enter.prevent="addCategory"
                @blur="addCategory"
              >
            </span>
          </div>
          <div class="param-row">
            <span class="param-name">音效</span>
            <span class="param-body">
              <span
                class="sound-toggle"
                :class="{ off: !soundEnabled }"
                @click="toggleSound"
              >♪ {{ soundEnabled ? '开' : '关' }}</span>
              <span class="param-dim">相位提示音(与菜单里的开关同一个)</span>
            </span>
          </div>
        </div>
      </section>

      <!-- 最近条目:44px 账线行 —— 副行是完成度进度条,行尾是右对齐 mono 计数列 -->
      <section
        v-if="entryRows.length > 0"
        class="practice-group"
      >
        <LedgerGroupHeader
          sticky
          label="最近条目"
          :count="entryRows.length"
        />
        <PanelLedgerRow
          v-for="entry in entryRows"
          :key="entry.id"
          class="entry-row"
          :label="entry.title"
        >
          <template #meta>
            <!-- 有比例的记录画进度条,没有的(手记锻炼)退回时间戳文字 —— 一条
                 永远填满或永远空着的进度条比没有进度条更误导。 -->
            <span
              v-if="entry.ratio !== null"
              class="pp-progress"
              role="presentation"
            >
              <span
                class="pp-progress-fill"
                :class="{ 'is-warning': !entry.complete }"
                :style="{ width: `${Math.round(entry.ratio * 100)}%` }"
              />
            </span>
            <span
              v-else
              class="entry-stamp"
            >{{ entry.stamp }}</span>
          </template>
          <template #trail>
            <span
              class="entry-count"
              :class="{ 'is-faint': entry.ratio === null }"
            >{{ entry.count }}</span>
          </template>
        </PanelLedgerRow>
      </section>

      <!-- 账页:真 `<table>` 原样保留,粒度切换收进分组头的 trailing 槽 -->
      <section class="practice-group">
        <LedgerGroupHeader
          sticky
          label="账页"
        >
          <template #trailing>
            <SegmentedPill
              v-model="granularityModel"
              class="gran-switch"
              :options="GRANULARITY_OPTIONS"
              aria-label="账页粒度"
            />
          </template>
        </LedgerGroupHeader>

        <div class="ledger-scroll">
          <table class="ledger">
            <thead>
              <tr>
                <th class="date">
                  {{ granularity === 'day' ? '日期' : granularity === 'week' ? '周' : '月份' }}
                </th>
                <th>凯格尔</th>
                <th>番茄</th>
                <th>锻炼</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.key"
                :class="{ empty: row.empty }"
              >
                <td class="date">
                  {{ row.key }}
                </td>
                <td>{{ row.kegel }}</td>
                <td>{{ row.pomodoro }}</td>
                <td>{{ row.exercise }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p
        v-if="allEmpty"
        class="empty-note"
      >
        还没有任何记录 —— 点右上角「开始练习」起一组,或在聊天里告诉 AI 你刚练了什么。
      </p>
    </div>

    <template #status>
      <span class="status-text">{{ statusText }}</span>
    </template>
  </PanelShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { PracticeLedgerRecord, PracticeSummaryGranularity, PracticeSummaryResult } from '@/types'
import { practiceApi } from '@/platform/practice-client'
import { usePracticeStore } from '@/stores/practice'
import FilterSearchInput from '@/components/common/FilterSearchInput.vue'
import SegmentedPill from '@/components/common/SegmentedPill.vue'
import LedgerGroupHeader from '@/components/workspace/LedgerGroupHeader.vue'
import PanelLedgerRow from '@/components/workspace/PanelLedgerRow.vue'
import PanelPrimaryAction from '@/components/workspace/PanelPrimaryAction.vue'
import PanelShell from '@/components/workspace/PanelShell.vue'

const props = defineProps<{ active?: boolean }>()

const practiceStore = usePracticeStore()
const { lastSettled, config, soundEnabled } = storeToRefs(practiceStore)

const searchQuery = ref('')
const paramsCollapsed = ref(true)

// ── 参数区 ──

const FALLBACK_KEGEL = { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true }
const FALLBACK_POMODORO = { minutes: 25, categories: ['学习', '看视频', '写作', '其他'] }

const kegelConfig = computed(() => config.value?.kegel ?? FALLBACK_KEGEL)
const pomodoroConfig = computed(() => config.value?.pomodoro ?? FALLBACK_POMODORO)
const newCategory = ref('')

function onKegelParam(key: 'holdSec' | 'relaxSec' | 'reps' | 'sets' | 'setRestSec', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || value < 0) return
  void practiceStore.saveConfig({ kegel: { [key]: Math.round(value) } })
}

function onPomodoroMinutes(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value) || value <= 0) return
  void practiceStore.saveConfig({ pomodoro: { minutes: Math.round(value) } })
}

function addCategory(): void {
  const name = newCategory.value.trim()
  if (!name || pomodoroConfig.value.categories.includes(name)) {
    newCategory.value = ''
    return
  }
  void practiceStore.saveConfig({ pomodoro: { categories: [...pomodoroConfig.value.categories, name] } })
  newCategory.value = ''
}

function removeCategory(cat: string): void {
  const remaining = pomodoroConfig.value.categories.filter(item => item !== cat)
  if (remaining.length === 0) return
  void practiceStore.saveConfig({ pomodoro: { categories: remaining } })
}

function toggleSound(): void {
  void practiceStore.saveConfig({ kegel: { sound: !soundEnabled.value } })
}

/** 控制条的主按钮起的是凯格尔——它是唯一一个不需要先选分类就能开始的练习。 */
function startPractice(): void {
  if (practiceStore.isRunning) return
  void practiceStore.startKegel()
}

const granularity = ref<PracticeSummaryGranularity>('day')
const summary = ref<PracticeSummaryResult | null>(null)
/**
 * 状态条的「今日 / 连续」只有在**日**粒度上才算得出来,而账页的粒度是用户自己切的。
 * 所以按日的那份摘要单独取一份,不跟着账页走。
 */
const daySummary = ref<PracticeSummaryResult | null>(null)
const recent = ref<PracticeLedgerRecord[]>([])

const GRANULARITY_OPTIONS = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

const granularityModel = computed({
  get: () => granularity.value as string,
  set: (value: string) => {
    granularity.value = value as PracticeSummaryGranularity
  },
})

interface LedgerRow {
  key: string
  kegel: string
  pomodoro: string
  exercise: string
  empty: boolean
}

const allRows = computed<LedgerRow[]>(() => {
  const buckets = summary.value?.buckets ?? []
  return [...buckets].reverse().map((bucket) => {
    const kegel = bucket.kegel.sessions > 0
      ? `${bucket.kegel.sessions} 次 · ${bucket.kegel.reps} rep`
      : '—'
    const pomodoro = bucket.pomodoro.sessions > 0
      ? `${bucket.pomodoro.sessions} 轮 · ${bucket.pomodoro.minutes}′`
      : '—'
    const exercise = bucket.exercise.byName.length > 0
      ? bucket.exercise.byName
        .map(ex => `${ex.key} ${ex.reps > 0 ? `${ex.sets}组${ex.reps}个` : `${ex.durationMin}′`}`)
        .join(' · ')
      : '—'
    return {
      key: bucket.bucketKey,
      kegel,
      pomodoro,
      exercise,
      empty: bucket.records === 0,
    }
  })
})

const rows = computed<LedgerRow[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return allRows.value
  return allRows.value.filter(row =>
    [row.key, row.kegel, row.pomodoro, row.exercise].some(part => part.toLowerCase().includes(query)),
  )
})

interface EntryRow {
  id: string
  title: string
  stamp: string
  /** 完成比例;没有"目标"可比的记录(手记锻炼)是 null,行退回时间戳副行。 */
  ratio: number | null
  complete: boolean
  count: string
}

const allEntryRows = computed<EntryRow[]>(() => recent.value.map((record) => {
  const date = new Date(record.ts)
  const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  if (record.kind === 'kegel' && record.kegel) {
    const { setsDone, setsTarget } = record.kegel
    const target = Math.max(1, setsTarget)
    return {
      id: record.id,
      title: `凯格尔 · ${record.kegel.repsDone} rep`,
      stamp,
      ratio: Math.min(1, setsDone / target),
      complete: setsDone >= setsTarget,
      count: `${setsDone} / ${setsTarget}`,
    }
  }

  if (record.kind === 'pomodoro' && record.pomodoro) {
    const { elapsedMin, minutes, completed } = record.pomodoro
    const target = Math.max(1, minutes)
    return {
      id: record.id,
      title: `番茄 · ${record.name}`,
      stamp,
      ratio: Math.min(1, elapsedMin / target),
      complete: completed,
      count: `${elapsedMin} / ${minutes}`,
    }
  }

  const ex = record.exercise
  const volume = ex?.sets && ex.repsPerSet
    ? `${ex.sets}×${ex.repsPerSet}`
    : ex?.durationMin
      ? `${ex.durationMin}′`
      : '—'
  return {
    id: record.id,
    title: record.name,
    stamp,
    ratio: null,
    complete: true,
    count: volume,
  }
}))

const entryRows = computed<EntryRow[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return allEntryRows.value
  return allEntryRows.value.filter(entry =>
    `${entry.title} ${entry.stamp}`.toLowerCase().includes(query),
  )
})

const allEmpty = computed(() => allRows.value.every(row => row.empty) && allEntryRows.value.length === 0)

/** 连续天数:从最新一天往回数。今天还没练不算断——那只是今天还没到晚上。 */
const streakDays = computed(() => {
  const buckets = daySummary.value?.buckets ?? []
  if (buckets.length === 0) return 0
  let index = buckets.length - 1
  if (buckets[index].records === 0) index -= 1
  let streak = 0
  while (index >= 0 && buckets[index].records > 0) {
    streak += 1
    index -= 1
  }
  return streak
})

const todayRecords = computed(() => {
  const buckets = daySummary.value?.buckets ?? []
  return buckets.length > 0 ? buckets[buckets.length - 1].records : 0
})

const statusText = computed(() => {
  if (practiceStore.isRunning) return '练习进行中…'
  return `今日 ${todayRecords.value} 条 · 连续 ${streakDays.value} 天`
})

async function refresh(): Promise<void> {
  try {
    const [summaryResult, dayResult, recentResult] = await Promise.all([
      practiceApi.summary({ granularity: granularity.value }),
      granularity.value === 'day'
        ? Promise.resolve(null)
        : practiceApi.summary({ granularity: 'day' }),
      practiceApi.recent({ days: 7, limit: 10 }),
    ])
    summary.value = summaryResult
    daySummary.value = dayResult ?? summaryResult
    recent.value = recentResult.records
  } catch {
    // Web build or early startup: leave the panel empty.
  }
}

onMounted(() => {
  void practiceStore.init()
  void refresh()
})
watch(granularity, refresh)
watch(() => props.active, (active) => {
  if (active) void refresh()
})
// A session or quick log just settled: the ledger changed.
watch(lastSettled, () => void refresh())
</script>

<style scoped>
.practice-panel {
  /* `--pp-*` 是这个面板的私有别名。P4 之后它只剩参数区与账页表格在用,
     不再向新写的骨架层扩散 —— 骨架一律直接吃 `--ui-*`。 */
  --pp-ink: var(--ui-text-primary-fg);
  --pp-muted: var(--ui-text-muted-fg);
  --pp-hairline: color-mix(in srgb, var(--ui-border-subtle-border) 60%, transparent);

  min-width: 0;
}

.practice-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.practice-search {
  flex: 1 1 auto;
  min-width: 0;
}

.practice-scroll {
  padding: 0 14px 16px;
}

.practice-group {
  min-width: 0;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 参数区 ── */
.params {
  padding: 2px 0 10px;
}

.param-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 12.5px;
  padding: 4px 0;
}

.param-name {
  width: 52px;
  flex: 0 0 52px;
  font-weight: 600;
  color: var(--pp-ink);
}

.param-body {
  flex: 1;
  color: var(--pp-muted);
  min-width: 0;
}

.param-note {
  font-size: 10.5px;
  color: color-mix(in srgb, var(--pp-muted) 65%, transparent);
  padding: 0 0 4px 64px;
}

.param-dim {
  font-size: 11px;
  color: color-mix(in srgb, var(--pp-muted) 70%, transparent);
  margin-left: 10px;
}

.num {
  width: 2.4ch;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
  color: var(--pp-ink);
  font-size: 12.5px;
  font-family: inherit;
  text-align: center;
  border-bottom: 1px dashed transparent;
}

.num-wide {
  width: 3.2ch;
}

.num:hover,
input.num:focus {
  border-bottom-color: color-mix(in srgb, var(--pp-muted) 60%, transparent);
}

.cat-chip {
  color: var(--pp-ink);
  margin: 0 4px;
  white-space: nowrap;
}

.cat-remove {
  color: color-mix(in srgb, var(--pp-muted) 60%, transparent);
  cursor: pointer;
  margin-left: 2px;
}

.cat-remove:hover {
  color: var(--pp-ink);
}

.cat-add {
  width: 64px;
  border: 1px dashed var(--pp-hairline);
  border-radius: 4px;
  outline: 0;
  background: transparent;
  color: var(--pp-ink);
  font-size: 11px;
  font-family: inherit;
  padding: 0 6px;
  margin-left: 6px;
}

.cat-add::placeholder {
  color: color-mix(in srgb, var(--pp-muted) 55%, transparent);
}

.sound-toggle {
  cursor: pointer;
  color: var(--pp-ink);
}

.sound-toggle.off {
  color: color-mix(in srgb, var(--pp-muted) 55%, transparent);
  text-decoration: line-through;
}

/* ── 最近条目:3px 进度条 + 右对齐 mono 计数列 ── */
.pp-progress {
  position: relative;
  display: block;
  width: 100%;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--ui-surface-input-bg);
  overflow: hidden;
}

.pp-progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: var(--radius-full);
  background: var(--ui-status-success-fg);
  transition: width var(--duration-normal) var(--ease-default);
}

.pp-progress-fill.is-warning {
  background: var(--ui-status-warning-fg);
}

.entry-stamp {
  font-variant-numeric: tabular-nums;
}

.entry-count {
  width: 46px;
  text-align: right;
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--ui-text-muted-fg);
}

.entry-count.is-faint {
  color: var(--ui-text-faint-fg);
}

/* ── 账页 ── */
.gran-switch {
  flex: none;
}

.ledger-scroll {
  overflow-x: auto;
  padding-top: 4px;
}

.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.ledger th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--pp-muted);
  padding: 0 10px 6px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--pp-ink) 40%, transparent);
}

.ledger td {
  padding: 6px 10px 6px 0;
  border-bottom: 1px solid var(--pp-hairline);
  color: var(--pp-ink);
  white-space: nowrap;
}

.ledger .date {
  color: var(--pp-muted);
  font-variant-numeric: tabular-nums;
}

.ledger tr.empty td {
  color: color-mix(in srgb, var(--pp-muted) 45%, transparent);
}

.empty-note {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--pp-muted);
  line-height: 1.7;
  max-width: 36em;
}
</style>
