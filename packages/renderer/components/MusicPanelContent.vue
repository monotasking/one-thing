<template>
  <!-- Music 视图本体。P4b 换成六面板共享骨架:PanelShell(控制条 / 分组内容 /
       状态条)+ LedgerGroupHeader 分组头;状态条那一格换成 44px 播放条 —— 六面板
       里唯一的例外(设计稿 Turn 5)。底色不在这里画,它住在工作台的 panel 面里。 -->
  <div class="music-panel-content">
    <PanelShell
      :padded="false"
      :status-flush="Boolean(nowPlaying)"
    >
      <template #controls>
        <!-- 搜索框**就是**点歌入口:队列是 DJ 排的,人要插一首歌时想的是"搜一下",
             不是"找一个叫点歌的按钮"。回车搜,结果落在下面的内联列表里。
             右槽空着 —— 图纸那颗「专注」筛选在这个面板没有对应的数据。 -->
        <FilterSearchInput
          v-model="requestQuery"
          size="compact"
          class="music-search"
          placeholder="搜索曲目,回车点歌"
          label="搜索曲目"
          @keydown.enter.prevent="doSearch"
        />
      </template>

      <div class="music-scroll">
        <div
          v-if="requestFeedback || searchResults.length > 0"
          class="request-results-block"
        >
          <p
            v-if="requestFeedback"
            class="request-feedback"
          >
            {{ requestFeedback }}
          </p>
          <div
            v-if="searchResults.length > 0"
            class="request-results"
          >
            <button
              v-for="(record, index) in searchResults"
              :key="index"
              type="button"
              class="request-result u-focus-ring"
              :class="{ 'is-grey': record.playFlag === false }"
              :disabled="record.playFlag === false || requesting"
              @click="pick(record)"
            >
              <span class="request-result-title">{{ record.title }}<template v-if="record.artist"> - {{ record.artist }}</template></span>
              <span
                v-if="record.playFlag === false"
                class="grey-badge"
              >版权受限</span>
            </button>
          </div>
        </div>

        <!-- 播放队列。✕ 是最强的口味信号(记为 skipped,DJ 下一批会绕开),
             ⏫ 把它提到下一首,行可以拖着重排 —— 三件事原样保留。 -->
        <section class="music-block">
          <LedgerGroupHeader
            label="播放队列"
            :count="programme.length"
          />
          <p
            v-if="programme.length === 0"
            class="block-empty"
          >
            节目单空着——DJ 会在低水位时自动补歌。
          </p>
          <div
            v-for="(entry, index) in programme"
            :key="entry.encryptedId"
            class="queue-row"
            :class="{
              'is-grey': entry.playFlag === false,
              'is-current': isCurrentEntry(entry),
              'is-drop-target': dropIndex === index,
            }"
            draggable="true"
            @dragstart="onDragStart(index, $event)"
            @dragover.prevent="dropIndex = index"
            @dragleave="dropIndex === index && (dropIndex = null)"
            @drop.prevent="onDrop(index)"
            @dragend="onDragEnd"
          >
            <!-- 首列 12px 槽跨面板对齐:这里是序号,当前播放那行换成均衡器动条。 -->
            <span class="queue-slot">
              <MusicEqualizerBars
                v-if="isCurrentEntry(entry)"
                :animated="nowPlaying?.status === 'playing'"
              />
              <span
                v-else
                class="queue-index"
              >{{ index + 1 }}</span>
            </span>

            <span class="queue-body">
              <span class="queue-title">{{ entry.title }}<span
                v-if="entry.playFlag === false"
                class="grey-badge"
              >版权受限</span></span>
              <span
                v-if="entrySubtitle(entry)"
                class="queue-sub"
              >{{ entrySubtitle(entry) }}</span>
            </span>

            <span class="queue-actions">
              <button
                type="button"
                class="queue-btn u-focus-ring"
                aria-label="下一首就放"
                :disabled="index === 0"
                @click="act({ kind: 'promote', encryptedId: entry.encryptedId })"
              >⏫</button>
              <button
                type="button"
                class="queue-btn u-focus-ring"
                aria-label="不想听(DJ 会避开这类)"
                @click="act({ kind: 'remove', encryptedId: entry.encryptedId })"
              >✕</button>
            </span>
          </div>
        </section>

        <!-- 电台本身的账:原来是一个带框 fieldset,收进分组之后和队列、编排记录
             同一种秩序 —— 面板里只剩一种"块"。 -->
        <section class="music-block">
          <LedgerGroupHeader label="电台" />
          <div class="station-row">
            <span class="station-key">状态</span>
            <span class="station-value">{{ stationStatus }}</span>
          </div>
          <div
            v-if="radio.intent"
            class="station-row"
          >
            <span class="station-key">本台</span>
            <span class="station-value">{{ radio.intent }}</span>
          </div>
          <div class="station-row">
            <span class="station-key">节目单</span>
            <span class="station-value">剩 {{ radio.programmeLength }} 首<template v-if="radio.upNext"> · 接下来:{{ radio.upNext }}</template></span>
          </div>
          <div
            v-if="radio.lastError"
            class="station-row station-error"
          >
            <span class="station-key">⚠</span>
            <span class="station-value">{{ radio.lastError }}</span>
          </div>
        </section>

        <!-- DJ 的编排会话:点开在主聊天区打开 —— 整件事的意义就是复用聊天 UI。 -->
        <section class="music-block">
          <LedgerGroupHeader
            label="编排记录"
            :count="radioSessions.length"
          />
          <p
            v-if="radioSessions.length === 0"
            class="block-empty"
          >
            还没有电台会话——在对话里说「放点歌,一直放着」就会开台。
          </p>
          <button
            v-for="session in radioSessions"
            :key="session.id"
            type="button"
            class="session-row u-focus-ring"
            :class="{ 'is-current': session.id === sessionsStore.currentSessionId }"
            @click="openSession(session.id)"
          >
            <span class="session-name">{{ session.name || '电台' }}</span>
            <span class="session-time">{{ sessionClock(session.updatedAt) }}</span>
          </button>
        </section>
      </div>

      <template #status>
        <MusicPlayerBar
          v-if="nowPlaying"
          :track-title="nowPlaying.title || '未知曲目'"
          :subtitle="nowPlayingNote"
          :playing="nowPlaying.status === 'playing'"
          :progress-ratio="musicStore.progressRatio"
          :time-label="timeLabel"
          :disabled="commandBusy"
          @prev="run('prev')"
          @toggle="run(nowPlaying.status === 'playing' ? 'pause' : 'resume')"
          @next="run('next')"
        />
        <!-- 没有当前曲目时播放条退化成一行普通状态文案:一条画着 0% 进度、
             按下去什么都不会发生的播放条比没有更糟。 -->
        <span
          v-else
          class="idle-status"
        >{{ idleStatus }}</span>
      </template>
    </PanelShell>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { MusicCommand, MusicProgrammeActionRequest, MusicProgrammeEntryDTO, MusicSearchRecordDTO } from '@/types'
import { useMusicStore } from '@/stores/music'
import { useSessionsStore } from '@/stores/sessions'
import FilterSearchInput from './common/FilterSearchInput.vue'
import PanelShell from './workspace/PanelShell.vue'
import LedgerGroupHeader from './workspace/LedgerGroupHeader.vue'
import MusicEqualizerBars from './workspace/MusicEqualizerBars.vue'
import MusicPlayerBar from './workspace/MusicPlayerBar.vue'

const musicStore = useMusicStore()
const sessionsStore = useSessionsStore()

const radio = computed(() => musicStore.radio)
const programme = computed(() => musicStore.programme)
const radioSessions = computed(() => sessionsStore.radioSessions)
const nowPlaying = computed(() => musicStore.nowPlaying)

/* 播放条上的秒数是**插值**出来的(main 几秒才播报一次),所以这条挂着的时候
   得把 store 的时钟点起来;走人就还回去(引用计数在 store 里)。 */
let releaseClock: (() => void) | null = null

onMounted(() => {
  void musicStore.refreshProgramme()
  releaseClock = musicStore.useClock()
})

onBeforeUnmount(() => {
  releaseClock?.()
  releaseClock = null
})

function act(action: MusicProgrammeActionRequest['action']) {
  void musicStore.programmeAction(action)
}

// --- 点歌 ------------------------------------------------------------------
const requestQuery = ref('')
const searchResults = ref<MusicSearchRecordDTO[]>([])
const requestFeedback = ref('')
const requesting = ref(false)

async function doSearch() {
  const query = requestQuery.value.trim()
  if (!query) return
  requestFeedback.value = '搜索中…'
  searchResults.value = []
  const response = await musicStore.searchSongs(query)
  if (!response.success) {
    requestFeedback.value = response.error ?? '搜索失败'
    return
  }
  searchResults.value = response.records ?? []
  requestFeedback.value = searchResults.value.length === 0 ? `没搜到「${query}」` : ''
}

async function pick(record: MusicSearchRecordDTO) {
  requesting.value = true
  try {
    const query = record.artist ? `${record.title} ${record.artist}` : record.title
    const response = await musicStore.requestSongNext(query)
    if (response.success) {
      requestFeedback.value = `「${response.title ?? query}」将在下一首播出`
      searchResults.value = []
      requestQuery.value = ''
    } else {
      requestFeedback.value = response.error ?? '点歌失败'
    }
  } finally {
    requesting.value = false
  }
}

// --- 队列 ------------------------------------------------------------------

/**
 * 哪一行是"正在放的那首"。曲目 id 在播放器那侧是不透明的,唯一可比的是标题:
 * 优先拿当前曲目的标题,没有(刚开台/暂停在换歌之间)就退回 DJ 记的 on-deck。
 */
const currentTitle = computed(() => nowPlaying.value?.title || musicStore.programmeOnDeck || '')

function isCurrentEntry(entry: MusicProgrammeEntryDTO): boolean {
  return Boolean(currentTitle.value) && entry.title === currentTitle.value
}

/** 副行:节目单条目里没有歌手字段,能说的是 DJ 的口播预览与「点歌」这类标注。 */
function entrySubtitle(entry: MusicProgrammeEntryDTO): string {
  if (entry.say) return `◈ ${entry.say}`
  return entry.note ?? ''
}

const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)

function onDragStart(index: number, event: DragEvent) {
  dragIndex.value = index
  event.dataTransfer?.setData('text/plain', String(index))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDrop(index: number) {
  const from = dragIndex.value
  dropIndex.value = null
  dragIndex.value = null
  if (from === null || from === index) return
  const entry = programme.value[from]
  if (!entry) return
  // The main-side move re-inserts AFTER removing, so dropping below the
  // origin needs no off-by-one correction: toIndex is the final position.
  act({ kind: 'move', encryptedId: entry.encryptedId, toIndex: index })
}

function onDragEnd() {
  dragIndex.value = null
  dropIndex.value = null
}

// --- 播放条 ----------------------------------------------------------------

const commandBusy = ref(false)

async function run(command: MusicCommand) {
  if (commandBusy.value) return
  commandBusy.value = true
  try {
    await musicStore.sendCommand(command)
  } finally {
    commandBusy.value = false
  }
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const timeLabel = computed(() => {
  const duration = nowPlaying.value?.duration
  if (!duration) return clock(musicStore.livePosition)
  return `${clock(musicStore.livePosition)} / ${clock(duration)}`
})

/** 当前曲目在节目单里的那条标注(节目单没有歌手,这是能说的第二行)。 */
const nowPlayingNote = computed(() => {
  const title = nowPlaying.value?.title
  if (!title) return ''
  return programme.value.find(entry => entry.title === title)?.note ?? ''
})

const stationStatus = computed(() => {
  const playing = nowPlaying.value
  if (playing?.status === 'playing') return `播放中「${playing.title ?? '未知曲目'}」`
  if (playing?.status === 'paused') return `已暂停「${playing.title ?? '未知曲目'}」`
  if (radio.value.active) return radio.value.canResume ? '待命(可从状态栏继续)' : '待命(等 DJ 编排)'
  return '关台'
})

/** 没有当前曲目时状态条说的话。 */
const idleStatus = computed(() => {
  if (!radio.value.active) return '电台未开'
  return radio.value.canResume
    ? '电台待命 · 可从状态栏继续'
    : `电台待命 · 节目单剩 ${radio.value.programmeLength} 首`
})

// --- 编排记录 --------------------------------------------------------------

function sessionClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function openSession(sessionId: string) {
  void sessionsStore.switchSession(sessionId)
}
</script>

<style scoped>
.music-panel-content {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.music-search {
  flex: 1;
  min-width: 0;
}

.music-scroll {
  padding: 0 14px 16px;
}

.music-block {
  display: flex;
  flex-direction: column;
}

.block-empty {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

/* ---- 点歌结果 ---- */

.request-results-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
}

.request-feedback {
  margin: 0;
  font-size: 11.5px;
  color: var(--ui-text-muted-fg);
}

.request-results {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-sm);
  max-height: 180px;
  overflow-y: auto;
}

.request-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
  color: var(--ui-text-primary-fg);
  min-width: 0;
  flex-shrink: 0;
}

.request-result:hover:not(:disabled) {
  background: var(--ui-state-hover-bg);
}

.request-result.is-grey,
.request-result:disabled {
  color: var(--ui-text-faint-fg);
  cursor: default;
}

.request-result-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 播放队列(44px 账线行)---- */

.queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 6px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
  min-width: 0;
  cursor: grab;
  flex-shrink: 0;
}

.queue-row:active {
  cursor: grabbing;
}

.queue-row:hover {
  background: var(--ui-state-hover-bg);
}

/* 正在放的那一行整行抬起 —— 均衡器条只有 12px,单靠它在一屏队列里找不回来。 */
.queue-row.is-current {
  background: var(--ui-state-hover-bg);
}

.queue-row.is-drop-target {
  box-shadow: inset 0 2px 0 var(--ui-accent-primary-fg);
}

.queue-row.is-grey .queue-title {
  color: var(--ui-text-faint-fg);
  text-decoration: line-through;
}

.queue-slot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
}

.queue-index {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-faint-fg);
}

.queue-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.queue-title {
  font-size: 12.5px;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-sub {
  font-size: 10.5px;
  color: var(--ui-text-faint-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grey-badge {
  margin-left: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  letter-spacing: 1px;
  color: var(--ui-text-faint-fg);
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: 2px;
  padding: 0 4px;
}

/* 行尾动作只在 hover 时现身(hover-actions 语义):队列一屏十几行,常驻两颗钮
   会把每一行都变成一个待办。 */
.queue-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.queue-row:hover .queue-actions,
.queue-actions:focus-within {
  opacity: 1;
}

.queue-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: var(--radius-xs);
  color: var(--ui-text-muted-fg);
}

.queue-btn:hover:not(:disabled) {
  color: var(--ui-text-primary-fg);
  background: var(--ui-state-hover-bg);
}

.queue-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* ---- 电台 ---- */

.station-row {
  display: flex;
  gap: 10px;
  min-width: 0;
  padding: 3px 6px;
  font-size: 12.5px;
}

.station-key {
  flex: 0 0 auto;
  min-width: 34px;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  padding-top: 2px;
  color: var(--ui-text-faint-fg);
}

.station-value {
  min-width: 0;
  color: var(--ui-text-primary-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A failure has to read as a failure — this line was grey, indistinguishable
   from the ordinary key/value rows above it. */
.station-error .station-key,
.station-error .station-value {
  color: var(--ui-status-danger-fg);
}

.station-error .station-value {
  white-space: normal;
}

/* ---- 编排记录 ---- */

.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 6px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-xs);
  min-width: 0;
}

.session-row:hover {
  background: var(--ui-state-hover-bg);
}

/* 账页语汇的选中:左墨边 + 主色字,不涂底。 */
.session-row.is-current {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.session-row.is-current .session-name {
  color: var(--ui-text-primary-fg);
}

.session-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--ui-text-muted-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-time {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  font-variant-numeric: tabular-nums;
}

.idle-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
