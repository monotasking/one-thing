<template>
  <!-- 轨迹面板(主线 E1)。事件日志的**第二投影** —— 与聊天区读的是同一份
       事实,装配方式不同:那边是消息,这边是账。骨架照六面板的 PanelShell,
       底色不在这里画(住在工作台的 surface="panel" 面里)。 -->
  <PanelShell
    class="trajectory-panel"
    :busy="loading"
    :padded="false"
    :scroll="false"
  >
    <template #controls>
      <div class="trajectory-controls">
        <span class="trajectory-title">轨迹</span>
        <span
          v-if="groups.length"
          class="trajectory-count"
        >{{ groups.length }} 次请求</span>

        <!-- 条带的两个开关住在控制条里,不占条带自己的高度(条带预算 ~52px)。 -->
        <template v-if="timeline.spans.length">
          <SegmentedPill
            class="timeline-mode"
            :model-value="timelineMode"
            :options="TIMELINE_MODE_OPTIONS"
            aria-label="时间条带的横轴"
            @update:model-value="setTimelineMode"
          />
          <button
            type="button"
            class="trajectory-reload u-focus-ring"
            :aria-expanded="timelineOpen"
            @click="timelineOpen = !timelineOpen"
          >
            {{ timelineOpen ? '收起时间线' : '时间线' }}
          </button>
        </template>

        <button
          type="button"
          class="trajectory-reload u-focus-ring"
          :disabled="loading || !sessionId"
          @click="reload"
        >
          刷新
        </button>
      </div>
    </template>

    <div class="trajectory-split">
      <!-- ── 时间条带(主线 E2)。与 ledger 同一份投影,只是换了个排法:
           左右两栏之上横跨一整行,窄容器下自动压扁。 ────────────────── -->
      <div
        v-if="timeline.spans.length && timelineOpen"
        class="trajectory-timeline"
        @mouseleave="clearHover"
      >
        <div class="timeline-ticks">
          <span
            v-for="tick in timeline.ticks"
            :key="tick.key"
            class="timeline-tick"
            :class="{ 'is-active': tick.groupKey === selectedGroupKey }"
            :style="{ left: percent(tick.offset) }"
          >{{ tick.label }}</span>
        </div>

        <div
          v-for="lane in TIMELINE_LANES"
          :key="lane.id"
          class="timeline-lane"
        >
          <span
            class="lane-name"
            aria-hidden="true"
          >{{ lane.label }}</span>
          <div class="lane-track">
            <!-- 压缩掉的空闲:画成一段虚线记号,压了多久在 tooltip 里说清楚。 -->
            <template v-if="lane.id === 'tools'">
              <span
                v-for="gap in timeline.gaps"
                :key="gap.key"
                class="timeline-gap"
                aria-hidden="true"
                :style="{ left: percent(gap.offset), width: percent(gap.size) }"
                @mouseenter="hoverGap(gap)"
              >⋯</span>
            </template>

            <button
              v-for="span in laneSpans(lane.id)"
              :key="span.key"
              type="button"
              class="timeline-span u-focus-ring"
              :class="[
                `is-${span.kind}`,
                {
                  'is-open': span.open,
                  'is-error': span.isError,
                  'is-active': isSpanActive(span),
                },
              ]"
              :style="{ left: percent(span.offset), width: percent(span.size) }"
              :data-span-key="span.key"
              :aria-label="span.label"
              @click="selectSpan(span)"
              @mouseenter="hoverSpan(span)"
              @focus="hoverSpan(span)"
              @blur="clearHover"
            />
          </div>
        </div>

        <!-- 面板内绝对定位的 tooltip(不 Teleport)。文案在 hover 时才格式化。 -->
        <div
          v-if="tooltipText"
          class="timeline-tooltip"
          role="tooltip"
          :style="{ left: percent(tooltipOffset) }"
        >
          {{ tooltipText }}
        </div>
      </div>

      <!-- ── 左:ledger ────────────────────────────────────────────── -->
      <div
        ref="ledgerRef"
        class="trajectory-ledger"
      >
        <template v-if="groups.length">
          <section
            v-for="group in groups"
            :key="group.key"
            class="trajectory-group"
          >
            <LedgerGroupHeader
              sticky
              :label="groupLabel(group)"
              :count="toolCountOf(group)"
            >
              <template #trailing>
                <button
                  type="button"
                  class="group-open"
                  :class="{ 'is-active': isGroupSelected(group) }"
                  :aria-label="`查看请求 ${group.requestIndex} 的信封`"
                  @click="selectGroup(group)"
                >
                  {{ formatTrajectoryTime(group.startTime) }}
                </button>
              </template>
            </LedgerGroupHeader>

            <div class="trajectory-rows">
              <template
                v-for="row in group.rows"
                :key="row.key"
              >
                <PanelLedgerRow
                  v-if="row.kind === 'tool'"
                  :ref="element => registerRow(row.callId, element)"
                  class="trajectory-row"
                  :label="row.name"
                  :meta="row.argsSummary"
                  :active="isRowSelected(row)"
                  :muted="row.pending"
                  role="button"
                  tabindex="0"
                  :data-call-id="row.callId"
                  @click="selectRow(row)"
                  @keydown.enter.prevent="selectRow(row)"
                  @keydown.space.prevent="selectRow(row)"
                >
                  <template #trail>
                    <span
                      class="row-timing"
                      :class="{ 'is-pending': row.pending, 'is-error': row.isError }"
                    >{{ rowTiming(row) }}</span>
                  </template>
                </PanelLedgerRow>

                <div
                  v-else
                  class="trajectory-tick"
                >
                  <span class="tick-label">{{ row.label }}</span>
                  <span
                    class="tick-rule"
                    aria-hidden="true"
                  />
                  <span class="tick-time">{{ formatTrajectoryTime(row.time) }}</span>
                </div>
              </template>
            </div>
          </section>
        </template>

        <!-- 空态:旧会话没有事件日志是**正常**的,不是坏了。 -->
        <div
          v-else-if="!loading"
          class="trajectory-empty"
        >
          <span
            class="empty-icon"
            aria-hidden="true"
          >
            <Route
              :size="20"
              :stroke-width="1.6"
            />
          </span>
          <p class="empty-title">
            这条会话没有事件记录
          </p>
          <p class="empty-hint">
            事件日志是 2026-08 之后才开始记的,更早的会话没有账很正常。
            新对话一开始就会自动记录,每次请求、每次工具调用都留一行。
          </p>
        </div>
      </div>

      <!-- ── 右:inspector ─────────────────────────────────────────── -->
      <div class="trajectory-inspector">
        <template v-if="selectedGroup">
          <div class="inspector-head">
            <span class="inspector-name">请求 #{{ selectedGroup.requestIndex }}</span>
          </div>
          <dl class="inspector-fields">
            <dt>provider</dt>
            <dd>{{ selectedGroup.provider || '—' }}</dd>
            <dt>model</dt>
            <dd>{{ selectedGroup.model || '—' }}</dd>
            <dt>system</dt>
            <dd>{{ selectedGroup.systemPromptHash || '—' }}</dd>
            <dt>tools</dt>
            <!-- 目录是独立事件,拿不到就说拿不到 —— 与 Schema unavailable 同款。 -->
            <dd v-if="selectedGroup.toolCount !== undefined">
              {{ selectedGroup.toolCount }}
            </dd>
            <dd
              v-else
              class="inspector-unavailable"
            >
              unavailable
            </dd>
            <dt>开始</dt>
            <dd>{{ formatTrajectoryTime(selectedGroup.startTime) || '—' }}</dd>
            <dt>结束</dt>
            <dd>{{ formatTrajectoryTime(selectedGroup.endTime) || '—' }}</dd>
            <dt>stop</dt>
            <dd>{{ selectedGroup.stopReason || '—' }}</dd>
          </dl>

          <!-- token 数在这里,不在主表:宽度留给内容(dsh 判例)。 -->
          <div class="inspector-section">
            <div class="inspector-section-label">
              Usage
            </div>
            <dl
              v-if="selectedGroup.usage"
              class="inspector-fields"
            >
              <dt>input</dt>
              <dd>{{ selectedGroup.usage.inputTokens ?? '—' }}</dd>
              <dt>output</dt>
              <dd>{{ selectedGroup.usage.outputTokens ?? '—' }}</dd>
              <dt>cache read</dt>
              <dd>{{ selectedGroup.usage.cacheReadTokens ?? '—' }}</dd>
              <dt>cache write</dt>
              <dd>{{ selectedGroup.usage.cacheWriteTokens ?? '—' }}</dd>
            </dl>
            <p
              v-else
              class="inspector-unavailable"
            >
              这次请求没有记下 usage
            </p>
          </div>
        </template>

        <template v-else-if="selectedRow">
          <div class="inspector-head">
            <span class="inspector-name">{{ selectedRow.name }}</span>
            <span
              v-if="selectedRow.pending"
              class="inspector-flag"
            >未收尾</span>
            <span
              v-else-if="selectedRow.isError"
              class="inspector-flag is-error"
            >失败</span>
          </div>

          <div
            class="inspector-tabs"
            role="tablist"
          >
            <button
              v-for="tab in INSPECTOR_TABS"
              :key="tab.id"
              type="button"
              role="tab"
              class="inspector-tab"
              :class="{ 'is-active': inspectorTab === tab.id }"
              :aria-selected="inspectorTab === tab.id"
              @click="inspectorTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <div class="inspector-body">
            <template v-if="inspectorTab === 'payload'">
              <pre class="inspector-pre">{{ payloadText }}</pre>
            </template>

            <template v-else-if="inspectorTab === 'result'">
              <p
                v-if="!inspection?.resultPreview"
                class="inspector-unavailable"
              >
                {{ selectedRow.pending ? '还没有结果 —— 这次调用没有配到 tool/result' : '结果为空' }}
              </p>
              <pre
                v-else
                class="inspector-pre"
                :class="{ 'is-error': inspection.isError }"
              >{{ inspection.resultPreview }}</pre>
            </template>

            <template v-else-if="inspectorTab === 'schema'">
              <!-- 拿不到就说拿不到。**绝不**用今天那份 schema 回填历史调用。 -->
              <p
                v-if="!inspection?.schema"
                class="inspector-unavailable"
              >
                Schema unavailable
              </p>
              <template v-else>
                <dl class="inspector-fields">
                  <dt>name</dt>
                  <dd>{{ inspection.schema.name }}</dd>
                </dl>
                <p
                  v-if="inspection.schema.description"
                  class="inspector-desc"
                >
                  {{ inspection.schema.description }}
                </p>
                <pre class="inspector-pre">{{ schemaParametersText }}</pre>
              </template>
            </template>

            <template v-else>
              <dl class="inspector-fields">
                <dt>调用</dt>
                <dd>{{ formatTrajectoryTime(selectedRow.callTime) }}</dd>
                <dt>结果</dt>
                <dd>{{ formatTrajectoryTime(selectedRow.resultTime) || '—' }}</dd>
                <dt>耗时</dt>
                <dd>{{ rowTiming(selectedRow) || '—' }}</dd>
                <dt>seq</dt>
                <dd>{{ selectedRow.callSeq }}</dd>
              </dl>
            </template>
          </div>
        </template>

        <p
          v-else
          class="inspector-idle"
        >
          选一行看它的参数、结果、当时的 schema 与时刻。
        </p>
      </div>
    </div>

    <template #status>
      <span class="status-text">{{ statusText }}</span>
    </template>
  </PanelShell>
</template>

<script setup lang="ts">
/**
 * 轨迹面板(主线 E1)。
 *
 * 数据只有一条来路:`sessionEvents` RPC 域(list / inspectCall)。它没有经过
 * 任何一个壳文件 —— 加这个域的时候 `channels.ts` / `bridge.ts` / `http.ts` /
 * `web.ts` 一个字都没改,这正是主线 T 想证明的那条水位线。
 *
 * 三条呈现纪律:
 * - **主表不显示 token**:宽度留给内容,数字进 inspector(dsh 判例)。
 * - **时长现算**:`result.time − call.time`,不存也不缓存。
 * - **schema 拿不到就写 unavailable**:历史调用解析到的是它当时那份 header,
 *   拿不到时绝不用今天的 schema 冒充。
 */
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { Route } from 'lucide-vue-next'
import type {
  SessionToolCallInspection,
} from '@shared/ipc/session-events.js'
import PanelShell from '@/components/workspace/PanelShell.vue'
import LedgerGroupHeader from '@/components/workspace/LedgerGroupHeader.vue'
import PanelLedgerRow from '@/components/workspace/PanelLedgerRow.vue'
import SegmentedPill from '@/components/common/SegmentedPill.vue'
import { sessionEventsApi } from '@/platform/session-events-client'
import { useSessionsStore } from '@/stores/sessions'
import {
  buildTrajectoryGroups,
  deriveTrajectoryTimeline,
  findTrajectoryToolRow,
  formatTrajectoryDuration,
  formatTrajectoryTime,
  type TrajectoryGroup,
  type TrajectoryLaneId,
  type TrajectoryTimelineGap,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineSpan,
  type TrajectoryToolRow,
} from '@/workspace/trajectory-projection'
import {
  loadTrajectoryTimelineMode,
  saveTrajectoryTimelineMode,
} from '@/workspace/trajectory-timeline-mode'
import {
  takePendingTrajectoryInspect,
  usePendingTrajectoryInspect,
} from '@/workspace/trajectory-inspect'

type InspectorTabId = 'payload' | 'result' | 'schema' | 'timing'

const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTabId; label: string }> = [
  { id: 'payload', label: 'Payload' },
  { id: 'result', label: 'Result' },
  { id: 'schema', label: 'Schema' },
  { id: 'timing', label: 'Timing' },
]

/** 两档横轴。文案说的是**轴是什么**,不是"模式一 / 模式二"。 */
const TIMELINE_MODE_OPTIONS = [
  { value: 'sequence', label: '序号' },
  { value: 'duration', label: '时长' },
]

const TIMELINE_LANES: ReadonlyArray<{ id: TrajectoryLaneId; label: string }> = [
  { id: 'assistant', label: 'AI' },
  { id: 'tools', label: '工具' },
]

const sessionsStore = useSessionsStore()
const pendingInspect = usePendingTrajectoryInspect()

/**
 * 面板跟随当前会话 —— 但 inspect 跳转可以**一次性**把它指到别处:线程详情里
 * 的工具卡片属于另一条执行会话,跟着"当前会话"读只会读到一份没有那笔账的日志。
 * 用户下次切会话时下面那个 watch 把它拉回来。
 */
const sessionId = ref(sessionsStore.currentSessionId || '')
const loading = ref(false)
const errorText = ref('')
const groups = ref<TrajectoryGroup[]>([])
const selectedCallId = ref('')
const selectedGroupKey = ref('')
const inspection = ref<SessionToolCallInspection | null>(null)
const inspectorTab = ref<InspectorTabId>('payload')
const missingNotice = ref('')

/** 条带档位:模块外的一枚 localStorage 记忆,面板起来时读一次。 */
const timelineMode = ref<TrajectoryTimelineMode>(loadTrajectoryTimelineMode())
const timelineOpen = ref(true)
const hoveredSpan = ref<TrajectoryTimelineSpan | null>(null)
const hoveredGap = ref<TrajectoryTimelineGap | null>(null)

const ledgerRef = ref<HTMLElement | null>(null)
const rowElements = new Map<string, HTMLElement>()

/**
 * 条带 = 同一份 `groups` 的第二种排法。布局(0..1 的相对位置)全在投影层里算,
 * 这里只把比例落成 CSS 百分比 —— 面板不量 DOM,条带也就不依赖渲染时机。
 */
const timeline = computed(() => deriveTrajectoryTimeline(groups.value, timelineMode.value))

function laneSpans(lane: TrajectoryLaneId): TrajectoryTimelineSpan[] {
  return timeline.value.spans.filter(span => span.lane === lane)
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(3)}%`
}

function setTimelineMode(value: string): void {
  if (value !== 'sequence' && value !== 'duration') return
  timelineMode.value = value
  saveTrajectoryTimelineMode(value)
}

/** 表选中 → 条带高亮。工具 span 认 callId,assistant 段认组 —— 与点击方向对称。 */
function isSpanActive(span: TrajectoryTimelineSpan): boolean {
  if (span.callId) return span.callId === selectedCallId.value
  return Boolean(selectedGroupKey.value) && span.groupKey === selectedGroupKey.value
}

/** 条带 → 表选中。工具 span 选中那一行并滚过去,assistant 段选中组头。 */
function selectSpan(span: TrajectoryTimelineSpan): void {
  if (span.callId) {
    const located = findTrajectoryToolRow(groups.value, span.callId)
    if (!located) return
    selectRow(located.row)
    void nextTick(() => scrollRowIntoView(span.callId as string))
    return
  }
  const group = groups.value.find(item => item.key === span.groupKey)
  if (group) selectGroup(group)
}

function hoverSpan(span: TrajectoryTimelineSpan): void {
  hoveredGap.value = null
  hoveredSpan.value = span
}

function hoverGap(gap: TrajectoryTimelineGap): void {
  hoveredSpan.value = null
  hoveredGap.value = gap
}

function clearHover(): void {
  hoveredSpan.value = null
  hoveredGap.value = null
}

/**
 * tooltip 文案。
 *
 * 挂在 computed 上而不是每个 span 上预先算好:没有浮出来的时候,这里一次
 * 格式化都不会发生(dsh 判例 —— 一条几百格的条带,预格式化的开销全是白花的)。
 */
const tooltipText = computed(() => {
  const gap = hoveredGap.value
  if (gap) return `空闲 ${formatTrajectoryDuration(gap.skippedMs)}(已压缩)`

  const span = hoveredSpan.value
  if (!span) return ''
  const start = formatTrajectoryTime(span.startTime)
  if (span.endTime === undefined) return `${span.label} · ${start} → 未收尾`
  const end = formatTrajectoryTime(span.endTime)
  return `${span.label} · ${start} → ${end} · ${formatTrajectoryDuration(span.endTime - span.startTime)}`
})

const tooltipOffset = computed(() => {
  const target = hoveredSpan.value ?? hoveredGap.value
  if (!target) return 0
  return target.offset + target.size / 2
})

function registerRow(callId: string, element: Element | ComponentPublicInstance | null): void {
  if (!element) {
    rowElements.delete(callId)
    return
  }
  const el = (element as ComponentPublicInstance).$el ?? element
  if (el instanceof HTMLElement) rowElements.set(callId, el)
}

const selectedRow = computed<TrajectoryToolRow | null>(() => {
  if (!selectedCallId.value) return null
  return findTrajectoryToolRow(groups.value, selectedCallId.value)?.row ?? null
})

const selectedGroup = computed<TrajectoryGroup | null>(() => {
  if (!selectedGroupKey.value) return null
  return groups.value.find(group => group.key === selectedGroupKey.value) ?? null
})

const payloadText = computed(() => {
  const raw = inspection.value?.argumentsRaw ?? ''
  if (!raw) return '(no arguments)'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // 解析不动就原样 —— 模型写坏 JSON 的那一次,原样才是唯一有用的信息。
    return raw
  }
})

const schemaParametersText = computed(() => {
  const parameters = inspection.value?.schema?.parameters
  if (!parameters) return '(no parameters)'
  try {
    return JSON.stringify(parameters, null, 2)
  } catch {
    return String(parameters)
  }
})

const statusText = computed(() => {
  if (loading.value) return '读取事件日志…'
  if (errorText.value) return errorText.value
  if (missingNotice.value) return missingNotice.value
  if (!sessionId.value) return '没有打开的会话'
  const tools = groups.value.reduce((sum, group) => sum + toolCountOf(group), 0)
  return `${groups.value.length} 次请求 · ${tools} 次工具调用`
})

function toolCountOf(group: TrajectoryGroup): number {
  return group.rows.filter(row => row.kind === 'tool').length
}

function groupLabel(group: TrajectoryGroup): string {
  const model = group.model || '未知模型'
  return `#${group.requestIndex} ${model}`
}

function rowTiming(row: TrajectoryToolRow): string {
  if (row.pending || row.resultTime === undefined) return '执行中'
  return formatTrajectoryDuration(row.resultTime - row.callTime)
}

function isRowSelected(row: TrajectoryToolRow): boolean {
  return selectedCallId.value === row.callId
}

function isGroupSelected(group: TrajectoryGroup): boolean {
  return selectedGroupKey.value === group.key
}

function selectGroup(group: TrajectoryGroup): void {
  selectedGroupKey.value = group.key
  selectedCallId.value = ''
  inspection.value = null
}

function selectRow(row: TrajectoryToolRow): void {
  selectedGroupKey.value = ''
  selectedCallId.value = row.callId
  inspectorTab.value = 'payload'
  void loadInspection(row.callId)
}

async function loadInspection(callId: string): Promise<void> {
  inspection.value = null
  if (!sessionId.value) return
  try {
    const response = await sessionEventsApi.inspectCall({ sessionId: sessionId.value, callId })
    // 期间用户又点了别行:丢弃这一次的结果,不覆盖新的选中。
    if (selectedCallId.value !== callId) return
    inspection.value = response.inspection
  } catch (error) {
    if (selectedCallId.value !== callId) return
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

async function load(): Promise<void> {
  const target = sessionId.value
  errorText.value = ''
  if (!target) {
    groups.value = []
    return
  }
  loading.value = true
  try {
    const response = await sessionEventsApi.list({ sessionId: target })
    if (sessionId.value !== target) return
    groups.value = buildTrajectoryGroups(response.events)
  } catch (error) {
    if (sessionId.value !== target) return
    groups.value = []
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (sessionId.value === target) loading.value = false
  }
}

function reload(): void {
  void load()
}

/**
 * 消费一次 inspect 跳转。
 *
 * 定位在**数据层**(`findTrajectoryToolRow`),滚动只是定位之后的装饰;找不到
 * 就明说"这一笔没有事件记录",选中态一律不设。两条路都清 pending —— 取即清。
 */
async function consumePendingInspect(): Promise<void> {
  const request = takePendingTrajectoryInspect()
  if (!request) return

  missingNotice.value = ''
  if (request.sessionId && request.sessionId !== sessionId.value) {
    sessionId.value = request.sessionId
    await load()
  } else if (!groups.value.length) {
    await load()
  }

  const located = findTrajectoryToolRow(groups.value, request.callId)
  if (!located) {
    selectedCallId.value = ''
    selectedGroupKey.value = ''
    inspection.value = null
    missingNotice.value = '该调用无事件记录'
    return
  }

  selectRow(located.row)
  await nextTick()
  scrollRowIntoView(request.callId)
}

/** 滚动只是定位之后的装饰 —— 两个入口(inspect 跳转 / 点条带)共用这一处。 */
function scrollRowIntoView(callId: string): void {
  const element = rowElements.get(callId)
  if (element && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' })
  }
}

watch(
  () => sessionsStore.currentSessionId,
  next => {
    const value = next || ''
    if (value === sessionId.value) return
    sessionId.value = value
  },
)

watch(sessionId, () => {
  selectedCallId.value = ''
  selectedGroupKey.value = ''
  inspection.value = null
  missingNotice.value = ''
  rowElements.clear()
  // hover 记的是上一份投影里的 span 对象,换会话后它指向的账已经不在了。
  clearHover()
  void load()
}, { immediate: true })

// 面板可能是被这次跳转开出来的(挂载时 pending 已经写好),也可能早就开着
// (那就只有这个 watch 会响)。immediate 让两种情形走同一条路。
watch(pendingInspect, value => {
  if (value) void consumePendingInspect()
}, { immediate: true })

defineExpose({ reload })
</script>

<style scoped>
/*
 * 面板根是**面板级容器**。E1 只在 `.trajectory-split` 上开了 container-type,
 * 于是 `@container` 里那条 `.trajectory-split { grid-template-columns }` 查的是
 * 自己的**祖先**容器(容器查询永远向上查,不查自身)—— 上面没有容器时那条规则
 * 一次也没生效过:窄面板下 inspector 的边框换了位,列却没并成一列。根上补一枚
 * 容器把它接住;`.trajectory-split` 自己那枚留着,inspector 仍查它。
 */
.trajectory-panel {
  container-type: inline-size;
  min-width: 0;
}

.trajectory-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.trajectory-title {
  font-size: 12.5px;
  color: var(--ui-text-primary-fg);
}

.trajectory-count {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}

.trajectory-reload {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-xs);
  background: transparent;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.trajectory-reload:hover:not(:disabled) {
  color: var(--ui-accent-primary-fg);
  border-color: var(--ui-accent-primary-fg);
}

.trajectory-reload:disabled {
  opacity: 0.5;
  cursor: default;
}

.trajectory-reload:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

/* 双栏 + 头上一整行条带。窄面板(工作台最窄 250px)下改上下 —— 用容器查询,
   面板宽度与视口无关。 */
.trajectory-split {
  container-type: inline-size;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 0.85fr);
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  height: 100%;
}

@container (max-width: 520px) {
  .trajectory-split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) minmax(0, 1fr);
  }
}

/* ---- 时间条带(E2) ---- */
.trajectory-timeline {
  grid-column: 1 / -1;
  position: relative;
  min-width: 0;
  padding: 5px 14px 6px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.timeline-ticks {
  position: relative;
  height: 11px;
}

/* 组边界只标"这里换了一次请求"。E2 不画时间标尺刻度文字。 */
.timeline-tick {
  position: absolute;
  top: 0;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  line-height: 11px;
  color: var(--ui-text-faint-fg);
  transform: translateX(-1px);
  pointer-events: none;
}

.timeline-tick.is-active {
  color: var(--ui-accent-primary-fg);
}

.timeline-lane {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 14px;
}

.timeline-lane + .timeline-lane {
  margin-top: 3px;
}

.lane-name {
  flex: none;
  width: 20px;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  color: var(--ui-text-faint-fg);
}

.lane-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  border-radius: var(--radius-xs);
}

.timeline-span {
  position: absolute;
  top: 0;
  height: 100%;
  min-width: 2px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: var(--ui-state-hover-raised-bg);
  cursor: pointer;
  transition:
    opacity var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

/* 等待(TTFT)与生成分色 —— 一眼看出"卡在等首 token"还是"真的在写"。 */
.timeline-span.is-wait {
  background: var(--ui-status-info-bg);
  border-color: var(--ui-status-info-border);
}

.timeline-span.is-generate {
  background: var(--ui-status-success-bg);
  border-color: var(--ui-status-success-border);
}

.timeline-span.is-tool {
  border-color: var(--ui-border-strong-border);
}

/* 开区间:没有终点的东西不该画成一根实心块。降调 + 描边,与行上的"执行中"同色。 */
.timeline-span.is-open {
  background: transparent;
  border-style: dashed;
  border-color: var(--ui-status-warning-border);
}

.timeline-span.is-error {
  background: var(--ui-status-danger-bg);
  border-style: solid;
  border-color: var(--ui-status-danger-border);
}

.timeline-span:hover {
  opacity: 0.75;
}

.timeline-span.is-active {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

/* 压缩掉的空闲。不假装那段时间不存在,也不让它把别的 span 挤没。 */
.timeline-gap {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow: hidden;
  border-left: 1px dashed var(--ui-border-subtle-border);
  border-right: 1px dashed var(--ui-border-subtle-border);
  font-size: 9px;
  line-height: 1;
  color: var(--ui-text-faint-fg);
}

/*
 * tooltip 是**面板内**的绝对定位层,不是 Teleport 出去的浮层:它跟着条带滚,
 * 生命周期与条带同生共死,没有第二个坐标系要维护(ui-system:业务组件不自己
 * Teleport)。写在条带的最后一个子元素上,后画的自然压住前面的 span,不用 z-index。
 *
 * 刻意**压在刻度行上而不是浮到条带外**:飘出去就要和 ledger 里的 sticky 组头
 * 比画笔顺序(定位元素按树序画,组头在后 → 组头赢),那就得动 z-index。压在自己
 * 身上一格,是这条规则下唯一不用发明层级的解法 —— 代价是 hover 时挡住组号,
 * 而组号在鼠标停住的那一刻本来就不是要看的东西。
 */
.timeline-tooltip {
  position: absolute;
  top: 0;
  max-width: 92%;
  padding: 3px 7px;
  border: 1px solid var(--ui-surface-tooltip-border);
  border-radius: var(--radius-xs);
  background: var(--ui-surface-tooltip-bg);
  box-shadow: var(--ui-surface-tooltip-shadow);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ui-surface-tooltip-fg);
  transform: translateX(-50%);
  pointer-events: none;
}

.timeline-mode {
  flex: none;
}

/* 窄容器:条带压扁到只剩两条泳道(组号刻度先让位),控制条上的计数让位给档位丸。 */
@container (max-width: 520px) {
  .trajectory-timeline {
    padding: 4px 10px 5px;
  }

  .timeline-ticks {
    display: none;
  }

  .timeline-lane {
    height: 10px;
  }

  .trajectory-count {
    display: none;
  }
}

/* 两栏**显式**落在第二行:条带收起(或空会话根本没有条带)时第一行是 0 高,
   靠自动排布的话它们会掉进 `auto` 行里,把滚动条撑破。 */
.trajectory-ledger {
  grid-row: 2;
  grid-column: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 16px;
}

.trajectory-group {
  min-width: 0;
}

.trajectory-rows {
  min-width: 0;
}

.row-timing {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  font-variant-numeric: tabular-nums;
}

.row-timing.is-pending {
  color: var(--ui-status-warning-fg);
}

.row-timing.is-error {
  color: var(--ui-status-danger-fg);
}

.group-open {
  padding: 0 2px;
  border: none;
  background: transparent;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.group-open:hover,
.group-open.is-active {
  color: var(--ui-accent-primary-fg);
}

.group-open:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

/* 刻度行:比账线行轻一档 —— 它们不是可 inspect 的对象,只是时间上的记号。 */
.trajectory-tick {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  padding: 0 6px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}

.tick-rule {
  flex: 1;
  height: 1px;
  background: var(--ui-border-subtle-border);
}

.tick-time {
  font-variant-numeric: tabular-nums;
}

/* ---- inspector ---- */
.trajectory-inspector {
  grid-row: 2;
  grid-column: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 16px;
  border-left: 1px solid var(--ui-border-subtle-border);
}

@container (max-width: 520px) {
  .trajectory-inspector {
    grid-row: 3;
    grid-column: 1;
    border-left: none;
    border-top: 1px solid var(--ui-border-subtle-border);
  }
}

.inspector-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.inspector-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--ui-text-primary-fg);
}

.inspector-flag {
  flex: none;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-status-warning-fg);
}

.inspector-flag.is-error {
  color: var(--ui-status-danger-fg);
}

.inspector-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 8px 0 6px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
}

.inspector-tab {
  padding: 4px 7px;
  border: none;
  border-bottom: 1px solid transparent;
  background: transparent;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition:
    color var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.inspector-tab:hover {
  color: var(--ui-text-primary-fg);
}

.inspector-tab.is-active {
  color: var(--ui-accent-primary-fg);
  border-bottom-color: var(--ui-accent-primary-fg);
}

.inspector-tab:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: -1px;
}

.inspector-body {
  min-width: 0;
}

.inspector-section {
  margin-top: 12px;
}

.inspector-section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ui-text-faint-fg);
}

.inspector-fields {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 10px;
  margin: 6px 0 0;
}

.inspector-fields dt {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}

.inspector-fields dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  color: var(--ui-text-secondary-fg);
}

/*
 * 缺省值在 dl 里也得是"淡"的。`.inspector-fields dd` 的特异性比
 * `.inspector-unavailable` 高,不显式压一手的话这枚 unavailable 会长得跟真值
 * 一模一样 —— "拿不到"就看不出来了。
 */
.inspector-fields dd.inspector-unavailable {
  color: var(--ui-text-faint-fg);
}

.inspector-pre {
  margin: 6px 0 0;
  padding: 8px;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-xs);
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--ui-text-secondary-fg);
}

.inspector-pre.is-error {
  color: var(--ui-status-danger-fg);
}

.inspector-desc {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ui-text-secondary-fg);
}

.inspector-unavailable,
.inspector-idle {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ui-text-faint-fg);
}

/* ---- 空态 ---- */
.trajectory-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 20px 0;
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
