<template>
  <NestedCollapseGroup
    v-if="timelineItems.length > 0"
    ref="timelineRef"
    class="tool-activity-timeline"
    :items="timelineItems"
    :model-value="controlledExpandedKeys"
    variant="plain"
    expand-icon-position="inline-end"
    spacing="3px"
    :data-depth="depth"
    @panel-change="handleIntentPanelChange"
  >
    <template #title="{ item, expanded, toggle }">
      <template v-if="isFartTimelineItem(item)">
        <div class="operation-row tree-node-row">
          <ToolIcon
            tool-name="fart"
            :status="getTimelineItemGroup(item).status"
          />
          <div class="operation-copy tree-node-content">
            <div class="operation-primary">
              <span class="node-target operation-target">
                <span class="node-action">Fart</span>
                <span class="node-target-name">fart</span>
              </span>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="isGroupTimelineItem(item)">
        <div class="group-header-anchor">
          <div class="group-header">
            <span class="group-icons">
              <ToolIcon
                v-for="activity in getGroupIconActivities(getTimelineItemGroup(item))"
                :key="activity.id"
                :tool-name="activity.toolName"
                :status="activity.status"
              />
            </span>
            <div class="group-copy">
              <span class="group-summary-text">{{ getGroupSummaryText(getTimelineItemGroup(item)) }}</span>
              <span
                v-if="getGroupStatusText(getTimelineItemGroup(item))"
                class="group-status-badge"
                :class="getGroupStatusClass(getTimelineItemGroup(item))"
              >{{ getGroupStatusText(getTimelineItemGroup(item)) }}</span>
              <span
                v-if="getGroupAdditions(getTimelineItemGroup(item))"
                class="group-stat addition"
              >+{{ getGroupAdditions(getTimelineItemGroup(item)) }}</span>
              <span
                v-if="getGroupDeletions(getTimelineItemGroup(item))"
                class="group-stat deletion"
              >-{{ getGroupDeletions(getTimelineItemGroup(item)) }}</span>
              <LiveToolDuration
                v-if="getGroupLiveStart(getTimelineItemGroup(item)) !== undefined"
                class="group-meta"
                :start-time="getGroupLiveStart(getTimelineItemGroup(item))"
              />
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="isActivityTimelineItem(item)">
        <div
          class="operation-row tree-node-row"
          :class="[
            getTimelineItemActivity(item).status,
            `status-${getTimelineItemActivity(item).status}`,
            {
              'is-expanded': expanded,
              'file-tool-row': getTimelineItemActivity(item).canOpenFile,
              'has-details': getTimelineItemActivity(item).hasDetails,
            },
          ]"
        >
          <ToolIcon
            :tool-name="getTimelineItemActivity(item).toolName"
            :status="getTimelineItemActivity(item).status"
          />

          <div class="operation-copy tree-node-content">
            <div class="operation-primary">
              <span
                class="node-target operation-target"
                :aria-label="getSingleActivityText(getTimelineItemActivity(item))"
              >
                <span
                  class="node-action"
                  :class="{ 'is-flowing': isFlowingStatus(getTimelineItemActivity(item).status) }"
                >{{ getTimelineItemActivity(item).toolLabel }}</span><span
                  v-if="getTimelineItemActivity(item).target"
                  class="node-target-name"
                  :class="{
                    'command-chip': getTimelineItemActivity(item).toolName === 'bash',
                    'file-link': getTimelineItemActivity(item).canOpenFile,
                    'file-opened': isFileOpenFlash(getTimelineItemActivity(item)),
                  }"
                  @click.stop="handleTargetClick(getTimelineItemActivity(item), toggle, $event)"
                >{{ getTimelineItemActivity(item).target }}</span>
              </span>
              <span
                v-if="getStatusBadgeText(getTimelineItemActivity(item))"
                class="node-status-badge"
                :class="`badge-${getTimelineItemActivity(item).status}`"
              >{{ getStatusBadgeText(getTimelineItemActivity(item)) }}</span>
              <span
                v-if="getTimelineItemActivity(item).errorSummary"
                class="node-error-summary"
              >{{ getTimelineItemActivity(item).errorSummary }}</span>
            </div>
            <div
              v-if="getActivityMetaText(getTimelineItemActivity(item)) || hasLiveDuration(getTimelineItemActivity(item))"
              class="operation-secondary"
            >
              <span class="node-meta">{{ getActivityMetaText(getTimelineItemActivity(item)) }}<LiveToolDuration
                v-if="hasLiveDuration(getTimelineItemActivity(item))"
                :start-time="getActivityLiveStart(getTimelineItemActivity(item))"
                :separator="getActivityMetaText(getTimelineItemActivity(item)) ? ' · ' : ''"
              /></span>
            </div>
          </div>
        </div>
      </template>
    </template>

    <template #content="{ item }">
      <FartCallItem
        v-if="isFartTimelineItem(item)"
        :tool-call="getTimelineItemActivity(item).toolCall"
      />

      <template v-else-if="isActivityTimelineItem(item)">
        <ToolActivityDetails
          :activity="getTimelineItemActivity(item)"
          :session-id="sessionId"
        />
      </template>
    </template>
  </NestedCollapseGroup>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue'
import type { Step } from '@/types'
import { beginCollapseCompensation } from '@/utils/collapse-compensation'
import { useDeferredAutoCollapse } from '@/composables/useDeferredAutoCollapse'
import NestedCollapseGroup from '@/components/common/NestedCollapseGroup.vue'
import type {
  CollapsePanelKey,
  CollapsePanelStatus,
  NestedCollapseItem,
  NestedCollapsePanelChange,
} from '@/components/common/collapse'
import { getExpansionIntent, setExpansionIntent } from '@/stores/helpers/expansion-intent'
import {
  buildToolActivityViews,
  type ToolActivityView,
} from '@/stores/helpers/tool-activity-view'
import type { ToolRenderStatus } from '@/stores/helpers/tool-status'
import FartCallItem from './FartCallItem.vue'
import LiveToolDuration from './LiveToolDuration.vue'
import ToolActivityDetails from './ToolActivityDetails.vue'
import ToolIcon from './ToolIcon.vue'
import { openReference } from '@/references'

const props = withDefaults(defineProps<{
  steps: Step[]
  depth?: number
  parentCollapsed?: boolean
  sessionId?: string
  /**
   * Flat timeline mode (inside ProcessRail): parallel batches render as
   * plain rows without the "N tools" group header — the rail summary
   * already carries the aggregate counts.
   */
  flat?: boolean
  /**
   * Address prefix for expansion-intent records. When set, this panel becomes
   * CONTROLLED: expansion is `user record > per-row auto-expand > collapsed`
   * instead of "whatever CollapseGroup happened to register at mount time".
   * That registration was the bug — a row remounting while, say, a bash call
   * was executing re-added its key to the group's expanded set and re-opened
   * something the user had just closed. Omit the prop and the panel stays
   * uncontrolled, exactly as before.
   */
  intentScope?: string
  /**
   * Intent addresses of host-owned containers wrapping this panel (today: the
   * ProcessRail shell). Expanding a row inside writes `true` to each of them —
   * the same "expanding a child pins its ancestors" rule that applies to the
   * groups inside this panel, extended across the component boundary because
   * the rail's own auto-collapse (streaming ends → fold) would otherwise take
   * the row the user just opened away with it.
   */
  parentIntentIds?: string[]
}>(), {
  depth: 0,
  parentCollapsed: false,
  sessionId: '',
  flat: false,
  intentScope: '',
  parentIntentIds: () => [],
})

const emit = defineEmits<{
  'open-file': [filePath: string]
}>()

// Live durations tick inside LiveToolDuration leaves; the activity views
// themselves only rebuild when the steps actually change.
const activities = computed(() => buildToolActivityViews(props.steps))

interface StepGroup {
  id: string
  /** Model generation round that issued this parallel batch (Step.turnIndex). */
  turnIndex: number | undefined
  isFart: boolean
  activities: ToolActivityView[]
  status: ToolRenderStatus
}

type ToolTimelineItemData =
  | { kind: 'fart'; group: StepGroup; activity: ToolActivityView }
  | { kind: 'group'; group: StepGroup }
  | { kind: 'single-container'; group: StepGroup }
  | { kind: 'activity'; group: StepGroup; activity: ToolActivityView; single: boolean }

type ToolTimelineItem = NestedCollapseItem<ToolTimelineItemData>

/**
 * The row's identity across its whole life. A tool call is first rendered from
 * a synthesized step (id = toolCallId) and later from the engine's real step
 * (id = step id, a different string). Keying on `activity.id` therefore threw
 * the row away and rebuilt it at the exact moment it stopped streaming —
 * losing its expansion, restarting its shimmer and re-numbering the ledger.
 * The toolCallId is the one identifier both forms agree on.
 */
function activityRowId(activity: ToolActivityView): string {
  return activity.step.toolCallId || activity.id
}

/**
 * Grouping: only tool calls issued together in ONE model turn (a parallel
 * tool_calls array) form a group. Sequential calls — even of the same tool —
 * always render as independent rows. Steps without a turnIndex never group.
 */
const stepGroups = computed<StepGroup[]>(() => {
  const groups: StepGroup[] = []
  let currentGroup: StepGroup | null = null

  for (const activity of activities.value) {
    if (activity.isFart) {
      if (currentGroup) {
        groups.push(currentGroup)
        currentGroup = null
      }
      groups.push({
        id: activityRowId(activity),
        turnIndex: undefined,
        isFart: true,
        activities: [activity],
        status: activity.status,
      })
      continue
    }

    const turnIndex = activity.step.turnIndex
    if (
      currentGroup &&
      !currentGroup.isFart &&
      currentGroup.turnIndex !== undefined &&
      turnIndex !== undefined &&
      turnIndex === currentGroup.turnIndex
    ) {
      currentGroup.activities.push(activity)
      currentGroup.status = mergeStatuses(currentGroup.status, activity.status)
    } else {
      if (currentGroup) groups.push(currentGroup)
      currentGroup = {
        id: activityRowId(activity),
        turnIndex,
        isFart: false,
        activities: [activity],
        status: activity.status,
      }
    }
  }

  if (currentGroup) groups.push(currentGroup)
  return groups
})

const timelineItems = computed<ToolTimelineItem[]>(() =>
  stepGroups.value.map(group => createGroupTimelineItem(group)),
)

// ============ Controlled expansion (intent > auto > default) ============

function intentIdFor(key: CollapsePanelKey): string {
  return `${props.intentScope}:${String(key)}`
}

/** Has the user expressed any expansion intent strictly *below* this item? */
function subtreeHasIntent(item: ToolTimelineItem): boolean {
  for (const child of (item.children ?? []) as ToolTimelineItem[]) {
    if (child.panel !== false && getExpansionIntent(intentIdFor(child.key)) !== undefined) return true
    if (subtreeHasIntent(child)) return true
  }
  return false
}

/**
 * Expansion is **continuous in the opening direction, restricted in the
 * closing one**.
 *
 * `auto` is recomputed from live status on every frame, not registered once at
 * mount. Opening that way is the whole point: an edit going
 * `awaiting-confirmation` must pop open the moment it happens. Closing that
 * way is what ate the user's reading position: a parallel
 * batch settling flips its group's auto from true to false, and since the group
 * itself carried no intent it folded — taking the tool call the user had just
 * expanded inside it out of sight with it.
 *
 * So: a container never auto-collapses while anything under it carries a user
 * record. Rows (no panel children) keep the old continuous behaviour — a
 * finished bash folding its own output back up is wanted.
 */
function collectExpandedKeys(items: ToolTimelineItem[], into: CollapsePanelKey[]): void {
  for (const item of items) {
    if (item.panel !== false) {
      const recorded = getExpansionIntent(intentIdFor(item.key))
      // `defaultCollapsed` undefined means "expanded" in NestedCollapseGroup —
      // mirror that here so an uncontrolled→controlled switch changes nothing.
      const auto = !(item.defaultCollapsed ?? false)
      const expanded = recorded ?? (auto || subtreeHasIntent(item))
      if (expanded) into.push(item.key)
    }
    if (item.children?.length) collectExpandedKeys(item.children as ToolTimelineItem[], into)
  }
}

/** Panel keys on the path from the roots down to `key` (excluding `key`). */
function findPanelAncestorKeys(
  items: ToolTimelineItem[],
  key: CollapsePanelKey,
  trail: CollapsePanelKey[] = [],
): CollapsePanelKey[] | null {
  for (const item of items) {
    if (item.key === key) return trail
    const children = item.children as ToolTimelineItem[] | undefined
    if (!children?.length) continue
    const found = findPanelAncestorKeys(
      children,
      key,
      item.panel === false ? trail : [...trail, item.key],
    )
    if (found) return found
  }
  return null
}

/**
 * 纯 auto+intent 的裁决,还没经过可见性门。`undefined` = 不受控(旧行为)。
 */
const autoExpandedKeys = computed<CollapsePanelKey[] | undefined>(() => {
  if (!props.intentScope) return undefined
  const keys: CollapsePanelKey[] = []
  collectExpandedKeys(timelineItems.value, keys)
  return keys
})

/**
 * 挂起中的自动收起:auto 已经想收了,但用户正看着这一行,于是这些 key **暂不**
 * 从受控集合里移除。门在 `useDeferredAutoCollapse`,见下面的 gate watcher。
 */
const deferredKeys = ref<CollapsePanelKey[]>([])

const autoCollapseGate = useDeferredAutoCollapse<CollapsePanelKey>({
  onDefer: (key) => {
    if (deferredKeys.value.includes(key)) return
    deferredKeys.value = [...deferredKeys.value, key]
  },
  // 放行(收起)与取消(用户介入 / auto 又把它展开了)都只是丢掉这一票;
  // 收不收由受控集合的合成说了算,补偿由下面那个 watcher 照常兜。
  onRelease: (key) => {
    deferredKeys.value = deferredKeys.value.filter(pending => pending !== key)
  },
})

/** `undefined` leaves CollapseGroup uncontrolled — the legacy behaviour. */
const controlledExpandedKeys = computed<CollapsePanelKey[] | undefined>(() => {
  const base = autoExpandedKeys.value
  if (!base || deferredKeys.value.length === 0) return base
  const merged = [...base]
  const present = new Set(base)
  for (const key of deferredKeys.value) {
    if (present.has(key)) continue
    present.add(key)
    merged.push(key)
  }
  return merged
})

/**
 * Expanding something also pins everything it lives inside — the group above
 * it and any host container that wrapped this panel. Collapsing does not touch
 * the ancestors (folding one row is not a statement about its group).
 *
 * Belt and braces with `subtreeHasIntent`: that one keeps the group open while
 * the panel is mounted, this one survives a remount and reaches containers
 * outside the panel entirely.
 */
function handleIntentPanelChange(change: NestedCollapsePanelChange): void {
  if (!props.intentScope) return
  // 用户点的这一下由 `controlledExpandedKeys` 的 watcher 消费:主动收起不补偿。
  manualPanelToggle = true
  // 用户意图直接生效:这一行若正挂着自动收起,挂起作废(cancel 会把它从
  // deferredKeys 里摘掉,受控集合随即听用户的)。
  autoCollapseGate.cancel(change.item.key)
  setExpansionIntent(intentIdFor(change.item.key), change.expanded)
  if (!change.expanded) return

  for (const key of findPanelAncestorKeys(timelineItems.value, change.item.key) ?? []) {
    setExpansionIntent(intentIdFor(key), true)
  }
  for (const id of props.parentIntentIds) {
    setExpansionIntent(id, true)
  }
}

// ============ 自动塌缩的滚动补偿(T2) ============
// 详情面板自己合上(bash 跑完、批次落定)是"自动"塌缩:如果它发生在视口顶
// 之上,用户正在读的正文会被抽掉那段高度。这里在塌缩前量一次、DOM 落定后把
// 差值还给 scrollTop。用户点击收起走 `handleIntentPanelChange`,置旗跳过。
const timelineRef = ref<ComponentPublicInstance | null>(null)
let manualPanelToggle = false

// 属性值里可能出现引号(toolCallId 来自外部),所以按属性遍历比拼选择器安全。
function panelElement(key: CollapsePanelKey): HTMLElement | null {
  const root = timelineRef.value?.$el
  if (!(root instanceof HTMLElement)) return null
  const wanted = String(key)
  if (root.getAttribute('data-activity-panel-key') === wanted) return root
  for (const el of root.querySelectorAll<HTMLElement>('[data-activity-panel-key]')) {
    if (el.getAttribute('data-activity-panel-key') === wanted) return el
  }
  return null
}

/**
 * 可见性门。**同步** flush 是刻意的:auto 想收的那一刻就把裁决做完,受控集合
 * 才不会先掉 key、再被挂起加回来 —— 下面那个补偿 watcher 看到的每一次"少了
 * 一个 key"都是"这次真收"。此刻 DOM 还是展开态,几何量得准。
 *
 * 用户自己点收起(`handleIntentPanelChange` 置旗)不进门:意图直接生效。
 * 这里只**读**旗,不清 —— 清旗归补偿 watcher,一处消费。
 */
watch(autoExpandedKeys, (next, prev) => {
  if (!prev || !next) return
  const stillOpen = new Set(next)

  // auto 又把它展开了(新一轮 streaming / 重新进入执行态):挂起作废。
  for (const key of autoCollapseGate.pendingKeys()) {
    if (stillOpen.has(key)) autoCollapseGate.cancel(key)
  }

  if (manualPanelToggle) return
  for (const key of prev) {
    if (stillOpen.has(key)) continue
    autoCollapseGate.request(key, panelElement(key))
  }
}, { flush: 'sync' })

watch(controlledExpandedKeys, (next, prev) => {
  const wasManual = manualPanelToggle
  manualPanelToggle = false
  if (wasManual || !prev || !next) return

  const stillOpen = new Set(next)
  const closed = prev.filter(key => !stillOpen.has(key))
  if (closed.length === 0) return

  // 多行同时合上时锚在**最下面**那一个:把它的下边钉住,所有塌缩之下的内容
  // 才全都不动(锚最上面那个只能保住第一处塌缩以下、第二处塌缩以上的一段)。
  let anchor: HTMLElement | null = null
  let anchorBottom = -Infinity
  for (const key of closed) {
    const el = panelElement(key)
    if (!el) continue
    const bottom = el.getBoundingClientRect().bottom
    if (bottom >= anchorBottom) {
      anchorBottom = bottom
      anchor = el
    }
  }
  const apply = beginCollapseCompensation(anchor)
  if (!apply) return
  void nextTick(() => {
    apply()
  })
})

const fileOpenFlashMap = ref<Record<string, boolean>>({})
const fileOpenFlashTimers = new Map<string, ReturnType<typeof setTimeout>>()

onUnmounted(() => {
  for (const timer of fileOpenFlashTimers.values()) {
    clearTimeout(timer)
  }
  fileOpenFlashTimers.clear()
})

function isGrouped(group: StepGroup): boolean {
  return group.activities.length > 1
}

function createGroupTimelineItem(group: StepGroup): ToolTimelineItem {
  if (group.isFart) {
    const activity = group.activities[0]
    return {
      key: `fart-${group.id}`,
      data: { kind: 'fart', group, activity },
      class: ['activity-group', 'single-operation', 'fart-panel', 'tool-operation-panel', group.status],
      attrs: { 'data-tool-activity-row': true },
      collapsible: false,
      status: getCollapsePanelStatus(group.status),
      streaming: isStreamingToolStatus(group.status),
    }
  }

  if (isGrouped(group) && !props.flat) {
    return {
      key: `group-${group.id}`,
      data: { kind: 'group', group },
      class: [
        'activity-group',
        'tool-group-panel',
        group.status,
        { 'workflow-group': true },
      ],
      attrs: { 'data-tool-activity-row': true, 'data-activity-panel-key': `group-${group.id}` },
      defaultCollapsed: !isGroupDefaultExpanded(group),
      status: getCollapsePanelStatus(group.status),
      streaming: isStreamingToolStatus(group.status),
      expandIconDisplay: 'hover',
      childrenClass: ['operation-list', 'group-timeline-tree'],
      children: group.activities.map(activity => createActivityTimelineItem(group, activity, false)),
    }
  }

  return {
    key: `single-${group.id}`,
    panel: false,
    data: { kind: 'single-container', group },
    class: ['activity-group', 'single-operation', group.status],
    attrs: { 'data-tool-activity-row': true },
    childrenClass: ['operation-list', 'group-timeline-tree', 'single'],
    children: group.activities.map(activity => createActivityTimelineItem(group, activity, true)),
  }
}

/**
 * 批次抑制:并行批次里,**没有一行**因为「正在执行」而自动展开。
 *
 * 失败(failed)与待审批(awaiting-confirmation)不受批次影响:错误和审批必须
 * 显眼。所以这里只按 `status === 'executing'` 抑制,不动其他状态。
 */
function isActivityDefaultExpanded(group: StepGroup, activity: ToolActivityView): boolean {
  if (!activity.defaultExpanded) return false
  if (group.activities.length > 1 && activity.status === 'executing') return false
  return true
}

function createActivityTimelineItem(
  group: StepGroup,
  activity: ToolActivityView,
  single: boolean,
): ToolTimelineItem {
  return {
    key: `activity-${activityRowId(activity)}`,
    data: { kind: 'activity', group, activity, single },
    class: [
      'operation-block',
      'tool-operation-panel',
      activity.status,
      `status-${activity.status}`,
      {
        'file-tool-row': activity.canOpenFile,
        'has-details': activity.hasDetails,
      },
    ],
    attrs: { 'data-activity-panel-key': `activity-${activityRowId(activity)}` },
    defaultCollapsed: !isActivityDefaultExpanded(group, activity),
    collapsible: activity.hasDetails,
    status: getCollapsePanelStatus(activity.status),
    streaming: isStreamingToolStatus(activity.status),
    contentVariant: 'plain',
    contentClass: 'activity-inline-details',
    contentAttrs: { 'data-tool-activity-details': activity.id },
    expandIconDisplay: 'hover',
  }
}

function mergeStatuses(current: ToolRenderStatus, next: ToolRenderStatus): ToolRenderStatus {
  const precedence: ToolRenderStatus[] = [
    'failed',
    'rejected',
    'awaiting-confirmation',
    'executing',
    'streaming-input',
    'received',
    'pending',
    'queued',
    'cancelled',
    'completed',
  ]
  return precedence.find(status => current === status || next === status) || next
}

function isGroupDefaultExpanded(group: StepGroup): boolean {
  return group.activities.some(activity => activity.defaultExpanded) ||
    (group.status !== 'completed' && group.status !== 'cancelled')
}

/**
 * 文件类工具(read/write/edit)的目标名点击 = 打开文件,**不管有没有详情** ——
 * 折叠/展开由行头其余部分和展开图标负责,目标名不再兼职开关。走消息引用的同一个
 * 动作口(docs/design/message-references-2026-08.md §3):存在性校验、目录/图片
 * 分支、⌘-click 系统打开、shift-click Finder 显示都跟着来;edit 还定位到首个 hunk。
 */
function handleTargetClick(activity: ToolActivityView, togglePanel?: () => void, event?: MouseEvent) {
  if (activity.canOpenFile) {
    flashFileOpen(activity.id)
    void openReference(
      { kind: 'file', path: activity.filePath, line: activity.fileLine, raw: activity.filePath },
      { meta: event?.metaKey, ctrl: event?.ctrlKey, shift: event?.shiftKey, alt: event?.altKey },
    ).then((result) => {
      // 没装宿主(测试 / 辅助窗)时退回旧的事件链。
      if (!result.ok && result.reason === 'no-host') emit('open-file', activity.filePath)
    })
    return
  }
  if (activity.hasDetails) togglePanel?.()
}

function isFileOpenFlash(activity: ToolActivityView): boolean {
  return fileOpenFlashMap.value[activity.id] === true
}

function flashFileOpen(activityId: string) {
  if (fileOpenFlashTimers.has(activityId)) {
    clearTimeout(fileOpenFlashTimers.get(activityId)!)
  }
  fileOpenFlashMap.value[activityId] = true
  const timer = setTimeout(() => {
    delete fileOpenFlashMap.value[activityId]
    fileOpenFlashTimers.delete(activityId)
  }, 300)
  fileOpenFlashTimers.set(activityId, timer)
}

function isFlowingStatus(status: ToolRenderStatus): boolean {
  return status === 'executing' || status === 'streaming-input' || status === 'received'
}

function getStatusBadgeText(activity: ToolActivityView): string {
  // Queued behind another prompt in the session's permission queue: waiting,
  // not actionable yet (no respond card).
  if (activity.status === 'awaiting-confirmation' && activity.toolCall.permissionQueued) {
    return 'Waiting for approval'
  }
  if (activity.status === 'awaiting-confirmation') return 'Needs approval'
  if (activity.status === 'cancelled') return 'Cancelled'
  if (activity.status === 'rejected') return 'Rejected'
  // A failed row used to differ from a successful one by text colour alone.
  if (activity.status === 'failed') return '失败'
  return ''
}

function getCollapsePanelStatus(status: ToolRenderStatus): CollapsePanelStatus {
  switch (status) {
    case 'executing':
    case 'received':
      return 'executing'
    case 'streaming-input':
      return 'streaming'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'rejected':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'awaiting-confirmation':
    case 'pending':
    case 'queued':
      return 'pending'
    default:
      return 'idle'
  }
}

function isStreamingToolStatus(status: ToolRenderStatus): boolean {
  return status === 'streaming-input'
}

function getGroupIconActivities(group: StepGroup): ToolActivityView[] {
  const seen = new Set<string>()
  const picked: ToolActivityView[] = []
  for (const activity of group.activities) {
    if (seen.has(activity.toolName)) continue
    seen.add(activity.toolName)
    picked.push(activity)
    if (picked.length === 3) break
  }
  return picked
}

function getGroupSummaryText(group: StepGroup): string {
  const count = group.activities.length
  if (count === 1) return getSingleActivityText(group.activities[0])
  return `${count} tools`
}

function getGroupStatusText(group: StepGroup): string {
  if (group.status === 'failed' || group.status === 'rejected') return 'Failed'
  if (group.status === 'cancelled') return 'Cancelled'
  return ''
}

function getGroupStatusClass(group: StepGroup): string {
  if (group.status === 'failed' || group.status === 'rejected') return 'failed'
  if (group.status === 'cancelled') return 'cancelled'
  return 'ok'
}

function getActivityMetaText(activity: ToolActivityView): string {
  if (activity.status === 'awaiting-confirmation') return ''
  const parts = [
    activity.stats,
    activity.toolName === 'variable' ? activity.targetMeta : '',
    // Live durations render via LiveToolDuration so the row meta stays static.
    hasLiveDuration(activity) ? '' : activity.duration,
  ].filter(Boolean)
  return parts.join(' · ')
}

/**
 * Live tick anchor per phase: receiving ticks from the toolCall's creation
 * (input-start), execution from the authoritative startTime.
 */
function getActivityLiveStart(activity: ToolActivityView): number | undefined {
  if (activity.status === 'streaming-input' || activity.status === 'received') {
    return activity.toolCall.timestamp
  }
  if (activity.status === 'executing' && typeof activity.toolCall.startTime === 'number') {
    return activity.toolCall.startTime
  }
  return undefined
}

function hasLiveDuration(activity: ToolActivityView): boolean {
  return getActivityLiveStart(activity) !== undefined
}

function getSingleActivityText(activity: ToolActivityView): string {
  return activity.target ? `${activity.toolLabel}(${activity.target})` : activity.toolLabel
}

function getGroupAdditions(group: StepGroup): number {
  return group.activities.reduce((sum, activity) => sum + activity.additions, 0)
}

function getGroupDeletions(group: StepGroup): number {
  return group.activities.reduce((sum, activity) => sum + activity.deletions, 0)
}

/**
 * Parallel batch: the batch runs as long as its slowest member, i.e. from the
 * earliest running start time. LiveToolDuration ticks from that instant.
 */
function getGroupLiveStart(group: StepGroup): number | undefined {
  if (group.status !== 'executing' && group.status !== 'streaming-input') return undefined
  const starts = group.activities
    .filter(activity => hasLiveDuration(activity))
    .map(activity => activity.toolCall.startTime as number)
  if (starts.length === 0) return undefined
  return Math.min(...starts)
}

function getTimelineItemData(item: NestedCollapseItem): ToolTimelineItemData | null {
  return (item.data as ToolTimelineItemData | undefined) ?? null
}

function isFartTimelineItem(item: NestedCollapseItem): boolean {
  return getTimelineItemData(item)?.kind === 'fart'
}

function isGroupTimelineItem(item: NestedCollapseItem): boolean {
  return getTimelineItemData(item)?.kind === 'group'
}

function isActivityTimelineItem(item: NestedCollapseItem): boolean {
  return getTimelineItemData(item)?.kind === 'activity'
}

function getTimelineItemGroup(item: NestedCollapseItem): StepGroup {
  return getTimelineItemData(item)!.group
}

function getTimelineItemActivity(item: NestedCollapseItem): ToolActivityView {
  const data = getTimelineItemData(item)!
  if (data.kind === 'activity' || data.kind === 'fart') return data.activity
  return data.group.activities[0]
}
</script>

<style scoped>
.tool-activity-timeline {
  /* NOTE: no container-type here — its style containment would trap the
     ledger counter below. The @container ancestor is .process-rail (the
     normal mount); the legacy fallback merely loses narrow-column tweaks. */
  /* Defined here (StepsPanel's own root) so they inherit into slot content;
     panel/list containers are rendered by NestedCollapseGroup/CollapsePanel
     and never carry this component's scope attribute. */
  --activity-title-fg: var(--ui-tool-text-faint-fg);
  --activity-row-fg: var(--ui-tool-text-muted-fg);
  --activity-hover-fg: var(--ui-tool-text-fg);
  --activity-link-fg: color-mix(in srgb, var(--ui-tool-accent-fg, var(--ui-accent-primary-fg)) 60%, var(--ui-tool-text-muted-fg));
  width: 100%;
  margin: 4px 0 6px;
  color: var(--ui-tool-text-muted-fg);
  font-family: var(--tool-font-sans);
  /* Blueprint ledger: rows are numbered like figures on a sheet. */
  counter-reset: tool-fig;
}

.tool-activity-timeline :deep(.activity-group) {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  max-width: 100%;
}

.group-header-anchor {
  display: flex;
  justify-self: start;
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 22px;
  padding: 1px 0;
  border-radius: 0;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: color var(--duration-normal) var(--ease-default);
}

.group-icons {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

.group-header:focus:not(:focus-visible),
.operation-row:focus:not(:focus-visible) {
  outline: none;
}

.group-header:focus-visible,
.operation-row:focus-visible {
  outline: 1.5px solid var(--ui-accent-primary-fg);
  outline-offset: -1.5px;
}

.group-copy {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.group-summary-text {
  color: var(--activity-title-fg);
  font-size: var(--tool-font-size-body);
  font-weight: 500;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: normal;
}

.group-meta {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--ui-text-faint-fg, var(--ui-text-muted-fg)) 86%, transparent);
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  white-space: nowrap;
}

.group-status-badge,
.group-stat {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  font-weight: 560;
  line-height: 1.25;
  white-space: nowrap;
}

.group-status-badge.ok {
  color: var(--ui-status-success-fg);
}

.group-status-badge.failed {
  color: var(--ui-status-danger-fg);
}

.group-status-badge.cancelled {
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.group-stat.addition {
  color: var(--ui-tool-success-text-fg);
}

.group-stat.deletion {
  color: var(--ui-tool-danger-text-fg);
}

.group-header:hover .group-summary-text {
  color: var(--activity-hover-fg);
}

.group-header:hover .group-meta {
  color: var(--ui-tool-text-muted-fg);
}

.tool-activity-timeline :deep(.operation-list) {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 1px 0 3px;
  border-top: 0;
}

/* Hairline rules between ledger rows. */
.tool-activity-timeline :deep(.operation-list > * + *) {
  border-top: 1px solid color-mix(in srgb, var(--ui-tool-border-border, var(--ui-border-subtle-border)) 32%, transparent);
}

.tool-activity-timeline :deep(.workflow-group .operation-list) {
  padding-left: 20px;
}

.tool-activity-timeline :deep(.workflow-group .operation-list)::before {
  content: '';
  position: absolute;
  top: 3px;
  bottom: 6px;
  left: 6px;
  width: 1px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-tool-border-border, var(--ui-border-subtle-border)) 28%, transparent);
}

.tool-activity-timeline :deep(.operation-list.single) {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border-top: 0;
}

.operation-list.single .operation-row {
  width: 100%;
  max-width: 100%;
}

.tool-activity-timeline :deep(.operation-block) {
  width: 100%;
  min-width: 0;
}

.operation-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 4px 8px 4px 4px;
  border-radius: 0;
  user-select: none;
  -webkit-user-select: none;
  transition: color var(--duration-normal) var(--ease-default);
}

/* Ledger row number (01, 02, …), counted in DOM order per timeline.
   Hidden at rest and faded in while the pointer is anywhere over the
   timeline: the numbers are an addressing aid for "the third call", not
   something to read on every row. The column keeps its 20px either way, so
   nothing shifts — only the ink appears. Counting is untouched. */
.operation-row::before {
  counter-increment: tool-fig;
  content: counter(tool-fig, decimal-leading-zero);
  flex: 0 0 auto;
  width: 20px;
  padding-top: 1px;
  opacity: 0;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  line-height: 1.75;
  text-align: left;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.tool-activity-timeline:hover .operation-row::before {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .operation-row::before {
    transition: none;
  }
}

/* The op name is the identity — no icons on the sheet. */
.operation-row :deep(.tool-icon) {
  display: none;
}

.operation-row.has-details {
  cursor: pointer;
}

.operation-row:focus:not(:focus-visible),
.group-header:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}

.operation-copy {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-wrap: nowrap;
  align-items: baseline;
  gap: 6px;
}

.operation-primary,
.operation-secondary {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.operation-primary {
  flex: 1 1 auto;
  max-width: 100%;
  overflow: hidden;
  flex-wrap: nowrap;
}

.operation-secondary {
  /* Never crushed by a long title/error: the timing readout stays legible. */
  flex: 0 0 auto;
  overflow: hidden;
  color: color-mix(in srgb, var(--ui-text-faint-fg, var(--ui-text-muted-fg)) 88%, transparent);
}

/* Title: `ToolName(primary arg)` — one line like every other row, ellipsis
   when long; the expanded details always carry the full arguments. */
.node-target {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--activity-row-fg);
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: 1.45;
}

/* Ledger op column: lowercase mono, fixed width so targets align. */
.node-action {
  display: inline-block;
  min-width: 46px;
  color: var(--activity-title-fg);
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-body);
  font-weight: 620;
  line-height: inherit;
  text-transform: lowercase;
}

.operation-row.status-failed .node-action,
.operation-row.status-rejected .node-action {
  color: var(--ui-status-danger-fg);
}

.node-target-name {
  min-width: 0;
  margin-left: 10px;
  color: var(--activity-row-fg);
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-body);
  font-weight: 450;
  line-height: inherit;
}

.node-target-name.command-chip {
  font-weight: 420;
}

.node-target-name.file-link {
  color: var(--activity-link-fg);
  cursor: pointer;
}

/* Flowing shimmer on the tool name while the call is live. */
.node-action.is-flowing {
  background: linear-gradient(
    90deg,
    var(--activity-row-fg) 32%,
    var(--activity-hover-fg) 50%,
    var(--activity-row-fg) 68%
  );
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: tool-name-flow 1.8s linear infinite;
}

@keyframes tool-name-flow {
  from {
    background-position: 130% 0;
  }
  to {
    background-position: -90% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .node-action.is-flowing {
    animation: none;
    background: none;
    -webkit-text-fill-color: initial;
    color: var(--ui-tool-accent-fg, var(--ui-accent-primary-fg));
  }
}

.operation-row.has-details:hover .node-action:not(.is-flowing),
.operation-row.has-details:hover .node-target-name {
  color: var(--activity-hover-fg);
}

.operation-row.has-details:hover .node-target-name.file-link {
  color: var(--ui-accent-primary-fg);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.operation-row.is-expanded .node-action:not(.is-flowing),
.operation-row.is-expanded .node-target-name {
  color: var(--ui-tool-text-muted-fg);
}

.operation-list.single .operation-row.has-details:hover .node-target-name.file-link,
.operation-list.single .operation-row:focus-within .node-target-name.file-link {
  color: var(--ui-accent-primary-fg);
}

.node-status-badge {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  font-weight: 540;
  line-height: 1.3;
  white-space: nowrap;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.node-status-badge.badge-awaiting-confirmation {
  color: var(--ui-status-warning-fg);
}

.node-status-badge.badge-rejected {
  color: var(--ui-tool-danger-text-fg, var(--ui-status-danger-fg));
}

.node-error-summary {
  flex: 1 1 22ch;
  min-width: 0;
  max-width: min(56ch, 100%);
  overflow: hidden;
  color: var(--ui-status-danger-fg);
  font-size: var(--tool-font-size-body);
  font-weight: 500;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-target-name.file-link.file-opened {
  animation: file-open-flash 0.3s ease;
}

@keyframes file-open-flash {
  0%,
  100% {
    background: transparent;
  }
  45% {
    background: color-mix(in srgb, var(--ui-accent-primary-fg) 8%, transparent);
  }
}

.diff-stats-inline {
  flex: 0 0 auto;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  line-height: 1.25;
}

.node-verb,
.node-meta,
.node-duration {
  flex: 0 0 auto;
  overflow: hidden;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
  font-family: var(--font-mono, monospace);
  font-size: var(--tool-font-size-meta);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
  line-height: 1.25;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

/* Meta content is data, not chrome: stats, identifiers and durations must
   keep their true case (0.7s, not 0.7S) — uppercase stays on the verb only. */
.node-meta,
.node-duration {
  text-transform: none;
}

:deep(.tool-operation-panel > .collapse-panel-content-shell > .activity-inline-details) {
  box-sizing: border-box;
  width: calc(100% - 25px);
  max-width: calc(100% - 25px);
  min-width: 0;
  margin: 2px 5px 7px 20px;
}

/* Narrow message column: give content width priority over indentation. */
@container (max-width: 480px) {
  .tool-activity-timeline :deep(.workflow-group .operation-list) {
    padding-left: 10px;
  }

  :deep(.tool-operation-panel > .collapse-panel-content-shell > .activity-inline-details) {
    width: calc(100% - 12px);
    max-width: calc(100% - 12px);
    margin: 2px 2px 7px 10px;
  }
}
</style>
