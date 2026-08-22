<template>
  <div
    class="message-list-wrapper"
    :style="messageListStyles"
  >
    <Scrollbar
      ref="messageScrollbarRef"
      :class="[
        'message-list',
        `density-${messageListDensity}`,
        { 'stream-following': useBottomScrollAnchor, 'is-room': isRoomSession, 'is-holding-top': isHoldingTop },
      ]"
      :style="messageListStyles"
    >
      <EmptyState
        v-if="messages.length === 0 && !isLoading"
        @suggestion="handleSuggestion"
      />

      <div
        v-if="messages.length === 0"
        ref="messageListContentRef"
        class="message-list-content message-list-content--empty"
        aria-hidden="true"
      />

      <div
        v-else
        ref="messageListContentRef"
        class="message-list-content"
        :class="{ 'rows-skippable': rowsSkippable }"
      >
        <Button
          v-if="pageHistorySummary"
          unstyled
          class="history-page-summary"
          native-type="button"
          :disabled="pageState?.isLoadingOlder"
          @click="loadOlderHistoryIfNeeded(true)"
        >
          <span>{{ pageHistorySummary }}</span>
        </Button>

        <!-- say 聊天面(群聊 / 私聊 / agent 互聊)**不在这里**:去复用重构 R1
             起,那三种房在 workbench 下整条走 `chat/room/RoomSurface.vue`,连
             ChatWindow 都不会挂到本组件。这一层因此只剩既有 MessageItem 树 ——
             它同时服务直聊 / 工作会话,以及 classic 下的房(逐像素回滚闸)。 -->
        <template
          v-for="(message, index) in messages"
          :key="message.id || index"
        >
          <!-- Time break: its own row in the same flow, never a wrapper —
               one message stays one measurable row. -->
          <RoomTimeCapsule
            v-if="isRoomRowVisible(index) && roomCapsuleLabel(index)"
            :label="roomCapsuleLabel(index)"
          />

          <div
            v-if="isRoomRowVisible(index)"
            class="message-list-row"
            :class="roomRowClass(index)"
            :data-index="index"
            :data-message-id="message.id"
          >
            <MessageItem
              :message="message"
              :branches="getBranchesForMessage(message.id)"
              :can-branch="canCreateBranch"
              :is-highlighted="message.id === highlightedMessageId"
              :room-mode="isRoomSession"
              :dm-mode="isUserDmSession"
              :pair-dm-mode="isPairDmSession"
              :group-head="isRoomGroupHead(index)"
              :group-tail="isRoomGroupTail(index)"
              :group-collapsible="Boolean(roomGroupToggleFor(index))"
              :group-collapsed="isRoomGroupCollapsed(index)"
              :group-message-count="roomGroupMessageCount(index)"
              @toggle-group="toggleRoomGroup(index)"
              @edit="handleEdit"
              @reply="(replyTo) => emit('replyTo', replyTo)"
              @react="handleReact"
              @jump-to-message="handleJumpToMessage"
              @branch="handleBranch"
              @go-to-branch="handleGoToBranch"
              @text-selection="handleTextSelection"
              @regenerate="handleRegenerate"
              @execute-tool="handleExecuteTool"
              @open-file="(filePath) => emit('openFile', filePath)"
              @update-thinking-time="handleUpdateThinkingTime"
            />
          </div>

          <!-- Goal outcome: belongs to the run, so it sits after the reply
               that ended it rather than on the declaration that opened it. -->
          <GoalSummaryCard
            v-for="settledGoal in goalSummariesByIndex.get(index)"
            :key="settledGoal.id"
            :goal="settledGoal"
            @review="emit('reviewGoal', props.sessionId || '')"
          />
        </template>

        <!-- agent 提问不画在这里:它是 composer 上方的一条栏位(与审批同一格),
             答完即收、流里不留痕。见 `interaction/InteractionPrompt.vue`。 -->

        <!-- Tail spacer for the hold-top gesture (send / regenerate): grows so
             the held row can sit at the viewport top, then gives way as the
             answer streams into it — the scroll height stays put while the
             answer fills the space, so nothing under the reader moves. Height
             is written imperatively (measured before the scroll write). -->
        <div
          ref="tailSpacerRef"
          class="message-list-tail-spacer"
          aria-hidden="true"
        />
        <div
          ref="bottomSentinelRef"
          class="message-list-bottom-sentinel"
          aria-hidden="true"
        />
      </div>
    </Scrollbar>

    <!-- Selection toolbar: one instance for the whole list; MessageItems
         report selections upward instead of each owning a toolbar. P6: the
         singleton `Teleport to="body"` went away with the hand-rolled
         coordinates — the toolbar is a Popover now and teleports itself. -->
    <SelectionToolbar
      :visible="selectionToolbarVisible"
      :anchor="selectionToolbarAnchor"
      :selected-text="selectionToolbarText"
      :can-branch="canCreateBranch"
      @quote="handleSelectionQuote"
      @branch="handleSelectionBranch"
      @close="hideSelectionToolbar"
    />

    <Teleport
      :to="props.outlineRailTarget || 'body'"
      :disabled="!useSideOutlineRail"
    >
      <AssistantMessageNavRail
        v-if="useSideOutlineRail && hasAssistantOutlineNav"
        :markers="assistantOutlineMarkers"
        :current-index="currentAssistantOutlineIndex"
        :panel-available="true"
        placement="side"
        :show-mode-switch="false"
        @navigate="navigateToAssistantOutline"
      />
    </Teleport>

    <UserMessageNavRail
      v-if="hasUserNavTrail"
      :markers="displayNavMarkers"
      :current-index="currentUserMessageNavIndex"
      :total-count="displayNavMarkers.length"
      :panel-available="hasNavPanelRoom"
      placement="overlay"
      :show-mode-switch="false"
      @navigate="navigateToUserMessage"
    />

    <Transition name="scroll-bottom-btn">
      <Button
        v-if="showScrollToBottomButton && messages.length > 0"
        unstyled
        class="scroll-to-bottom-btn"
        native-type="button"
        aria-label="Scroll to bottom"
        @click="scrollToBottomFromButton"
      >
        <ArrowDown
          :size="16"
          :stroke-width="2"
        />
      </Button>
    </Transition>

    <!-- Reject Reason Dialog — 组件化后与房面共用同一个(去复用重构 R1)。 -->
    <RejectReasonDialog
      :visible="showRejectDialog"
      @confirm="confirmReject"
      @cancel="cancelReject"
    />

    <!-- Room reaction failures (§3.6: a trace line, never a card). Rare and
         self-clearing — a chip that refused to toggle otherwise looks like a
         click the app ignored. -->
    <div
      v-if="reactionHint"
      class="room-action-hint"
    >
      {{ reactionHint }}
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Scrollbar from '@/components/common/Scrollbar.vue'
import { ref, watch, nextTick, computed, onMounted, onUnmounted, toRaw, onUpdated } from 'vue'
import type {
  ChatMessage,
  ChatMessageReplyTo,
  SessionGoal,
  ToolCall,
} from '@/types'
import MessageItem from './MessageItem.vue'
import GoalSummaryCard from './message/GoalSummaryCard.vue'
import RoomTimeCapsule from './message/RoomTimeCapsule.vue'
import {
  EMPTY_ROOM_LAYOUT,
  buildRoomMessageLayout,
  isRoomThinkingTrace,
  roomGroupAt,
  type RoomMessageGroup,
  type RoomMessageLike,
} from './message/room-grouping'
import RejectReasonDialog from './permission/RejectReasonDialog.vue'
import SelectionToolbar from './message/SelectionToolbar.vue'
import EmptyState from './EmptyState.vue'
import AssistantMessageNavRail from './AssistantMessageNavRail.vue'
import UserMessageNavRail, { type UserMessageNavMarker } from './UserMessageNavRail.vue'
import {
  ASSISTANT_OUTLINE_ANCHOR_ATTR,
  buildAssistantMessageOutlineMarkers,
  shouldShowAssistantMessageOutline,
  type AssistantMessageOutlineMarker,
} from './assistant-message-outline'
import { ArrowDown } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { useSessionsStore } from '@/stores/sessions'
import { useSettingsStore } from '@/stores/settings'
import { usePermissionShortcuts } from '@/composables/usePermissionShortcuts'
import { useCollabReactions } from '@/composables/useCollabReactions'
import { usePermissionResponder } from '@/composables/usePermissionResponder'
import { useHistoryPagination } from '@/composables/useHistoryPagination'
import { findRespondableToolCall, type PermissionResponse } from './permission/permission-ledger'
import type { AnchorRect } from '@/composables/floating/compute-position'
import {
  useFollowScroll,
  provideChatFollowState,
  shouldShowScrollToBottomButton,
} from '@/composables/useFollowScroll'
import { shouldRestoreReadingAnchor, useMessageScrollCoordinator } from '@/composables/useMessageScrollCoordinator'
import { buildFontFamily, buildFontLoadSpecs } from '@shared/fonts'
import { isAgentPairDmRoom, isUserDmRoom } from '@onething/runtime/collab'
import { platformApi } from '@/platform'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.message-list')
const perfLog = getLogger('renderer.perf')

interface BranchInfo {
  id: string
  name: string
}

// Shared stable reference for messages without branches. Returning a fresh `[]`
// per call gives every MessageItem a new `branches` prop on each list re-render,
// which defeats Vue's "skip unchanged child" optimization and re-renders the
// whole list on every send (cost scales with conversation length). This array
// is read-only by all consumers (MessageActions only iterates / reads length).
const EMPTY_BRANCHES: BranchInfo[] = []

type NavMarker = UserMessageNavMarker
type MessageScrollBehavior = 'auto' | 'instant' | 'smooth'
type ExecutableToolCall = Pick<ToolCall, 'id' | 'toolId' | 'arguments'>
type PermissionToolCall = Pick<ToolCall, 'id' | 'permissionId' | 'requiresConfirmation' | 'canRespond'>

interface Props {
  messages: ChatMessage[]
  isLoading?: boolean
  sessionId?: string
  layoutTransitioning?: boolean
  outlineRailTarget?: HTMLElement | null
  /**
   * 是否接管权限审批的键盘快捷键(Enter 允许 / D·Esc 拒绝)。
   *
   * 缺省 `true` —— 直聊与旧壳字节等价。右栏的线程详情要传 `false`:
   * `usePermissionShortcuts` 注册的是 **window 级 capture keydown**,挂在右栏
   * 等于给那条执行会话开了一条**看不见的**审批通道 —— 右栏并不画审批 UI
   * (W6:审批只在中栏的账页栏位),但按键照样能批。看不见却能触发,比看得见
   * 能触发更危险。
   */
  permissionShortcuts?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isLoading: false,
  sessionId: undefined,
  layoutTransitioning: false,
  outlineRailTarget: null,
  permissionShortcuts: true,
})

const emit = defineEmits<{
  setQuotedText: [text: string]
  setInputText: [text: string]
  regenerate: [messageId: string]
  editAndResend: [messageId: string, newContent: string]
  splitWithBranch: [sessionId: string]
  openFile: [filePath: string]
  reviewGoal: [sessionId: string]
  /** Rooms: a message was picked to quote (§3.5 A). */
  replyTo: [replyTo: ChatMessageReplyTo]
}>()

/**
 * Walk back to a quoted message. The snapshot on the quote block already
 * carries the words, so a target that is gone (deleted, or not in the loaded
 * page) simply does not move the list — never an error, never a jump to the
 * wrong row. Reuses the search-highlight window that already exists here.
 */
function handleJumpToMessage(messageId: string) {
  void scrollToMessage(messageId, { preserveNavigation: true })
}

/**
 * Toggle an emoji on a room message (§3.5 B) —— 实现已抬进
 * `useCollabReactions`(去复用重构 R1),房面与这里共用同一份。
 */
const { reactionHint, react: handleReact } = useCollabReactions(() => effectiveSessionId.value)

const chatStore = useChatStore()
const collabBoardStore = useCollabBoardStore()
const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()
const messageScrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null)
const messageListRef = ref<HTMLElement | null>(null)
const messageListContentRef = ref<HTMLElement | null>(null)

// ---- Off-screen row skipping (content-visibility: auto) -------------------
// Rows may skip layout/paint only once every row has been rendered at its
// real size at least once (contain-intrinsic-size: auto then remembers it):
// the flag drops whenever the row set or the column width changes and comes
// back one frame after the full-size layout, so remembered sizes are never
// stale for skipped rows. See the .rows-skippable rule.
const rowsSkippable = ref(false)
let rowsSkippableFrame: number | null = null

function rearmRowSkipping() {
  rowsSkippable.value = false
  if (rowsSkippableFrame !== null) cancelAnimationFrame(rowsSkippableFrame)
  // Two frames: the first lets Vue flush + the browser lay every row out at
  // full size and record it (last remembered size updates at RO timing, after
  // layout); the second turns skipping back on.
  rowsSkippableFrame = requestAnimationFrame(() => {
    rowsSkippableFrame = requestAnimationFrame(() => {
      rowsSkippableFrame = null
      rowsSkippable.value = true
    })
  })
}

// Keyed on the row SET (ids), not the array identity: the store hands the
// list over as a fresh array on every stream chunk, and rearming on identity
// would toggle the class at chunk rate (2026-08-19: a 15 Hz width flicker
// after context compaction while a reply streamed).
watch(
  () => props.messages.map(message => message.id).join('\n'),
  () => rearmRowSkipping(),
  { immediate: true },
)
const bottomSentinelRef = ref<HTMLElement | null>(null)
const tailSpacerRef = ref<HTMLElement | null>(null)
const navMarkers = ref<NavMarker[]>([])
const assistantOutlineMarkers = ref<AssistantMessageOutlineMarker[]>([])
const hasNavPanelRoom = ref(false)
const showScrollToBottomButton = ref(false)
const searchHighlightedMessageId = ref<string | null>(null)
let searchHighlightTimer: ReturnType<typeof setTimeout> | null = null

// Reject reason dialog state
const showRejectDialog = ref(false)
const pendingRejectToolCall = ref<PermissionToolCall | null>(null)

// Get the effective session for this panel (props.sessionId or fallback to global)
const effectiveSessionId = computed(() => props.sessionId || sessionsStore.currentSessionId)
const panelSession = computed(() => {
  const sid = effectiveSessionId.value
  if (!sid) return null
  return sessionsStore.sessions.find(s => s.id === sid) || null
})

// ── Room (kind='room') IM presentation ─────────────────────────────────────
// docs/design/multi-agent-collab-im.md §3. `props.messages` arrives already
// filtered by ChatPanel (drives / pass turns are gone), so consecutive
// messages here are what the user actually sees. Everything below reads only
// role / agentId / timestamp — never `content` — so a streaming reply does not
// re-run the layout (and re-render the whole list) on every chunk.
const isRoomSession = computed(() => panelSession.value?.kind === 'room')

/**
 * 托管私聊房(agent-im-dm.md §4.3):房间的全套排版照旧,只是一对一里没人需要
 * 署名 —— say 就是 TA 在说话。判定读产品层的纯规则(人数即形态),不在这里
 * 自己拼 `dm && members.length === 1`。
 */
const isUserDmSession = computed(() => isRoomSession.value && isUserDmRoom(panelSession.value?.room))

/**
 * agent ↔ agent 私聊房(§4.3):排版与签名气泡全部照群聊走(两个人**要**署名),
 * 唯一的分支是用户消息 —— 用户在这里是旁观者,插一句话与两位成员的对话不是
 * 同一种发言,气泡上要看得出来。
 */
const isPairDmSession = computed(() => isRoomSession.value && isAgentPairDmRoom(panelSession.value?.room))

// ── say 分流门已拆(R3,docs/design/im-workbench-layout.md §8.4)──
//
// C2′ 曾在这里挂第二棵组件树(`saySurfaceActive = isRoom && workbench`)。R1 把
// 房/私聊整条移到 `ChatWindow` 的 `roomSurfaceActive` 分支后,workbench 下的房
// 根本到不了本组件(ChatPanel 是 MessageList 的唯一挂载者,ChatWindow 是
// ChatPanel 的唯一挂载者,两者的房判据同一条),那道门恒为 false —— 死代码。
//
// 留下的房分支(`isRoomSession` 的分组 / 折叠 / 时间胶囊 / gap table)**不是**
// 死代码:classic 下房会话仍然走这条旧壳,那是逐像素回滚闸的落点。
const roomLayout = computed(() =>
  isRoomSession.value ? buildRoomMessageLayout(props.messages) : EMPTY_ROOM_LAYOUT,
)

/** '' when no capsule belongs above this message. */
function roomCapsuleLabel(index: number): string {
  return roomLayout.value.capsules.get(index) ?? ''
}

// Outside a room every message is its own group: the flags are inert but must
// stay truthful so MessageItem's ordinary layout is bit-for-bit unchanged.
function isRoomGroupHead(index: number): boolean {
  return !isRoomSession.value || roomLayout.value.groupHeads.has(index)
}

function isRoomGroupTail(index: number): boolean {
  if (!isRoomSession.value) return true
  if (roomLayout.value.groupTails.has(index)) return true
  // A folded group shows its head alone, so the head IS the group's last row:
  // it has to take the turn gap and the hover footer, or the block reads as
  // "stacked, more coming" with nothing coming.
  const group = roomGroupAt(roomLayout.value, index)
  return Boolean(group && group.head === index && isRoomGroupFolded(group))
}

// ── Room utterance folding (P1-2, todo #6) ────────────────────────────────────
// One agent's burst folds as a unit. Folded rows leave the DOM (v-if, not
// v-show): the room's gap table is a chain of `+ *` sibling rules, and a
// display:none row still matches those — hiding rows without removing them
// would leave a phantom band above the next visible one. The list is not
// virtualized (a plain v-for over `props.messages`), so removal costs nothing
// but the rows themselves, and every index-keyed helper here keeps reading the
// unfiltered array — folding changes what renders, never what a row IS.

function isRoomGroupFolded(group: RoomMessageGroup | null): boolean {
  if (!group?.collapsible) return false
  const sessionId = effectiveSessionId.value
  return Boolean(sessionId) && chatStore.isRoomGroupCollapsed(sessionId, group.key)
}

/** Rows removed by a fold: everything in the group except its head. */
function isRoomRowVisible(index: number): boolean {
  if (!isRoomSession.value) return true
  const group = roomGroupAt(roomLayout.value, index)
  if (!group || group.head === index) return true
  return !isRoomGroupFolded(group)
}

/** A head row offers the toggle only when there is something behind it. */
function roomGroupToggleFor(index: number): RoomMessageGroup | null {
  if (!isRoomSession.value) return null
  const group = roomGroupAt(roomLayout.value, index)
  return group && group.head === index && group.collapsible ? group : null
}

function isRoomGroupCollapsed(index: number): boolean {
  return isRoomGroupFolded(roomGroupToggleFor(index))
}

/**
 * Live count — a burst that grows while folded stays folded (the user's fold is
 * not revoked by an arriving message) but its summary keeps telling the truth.
 */
function roomGroupMessageCount(index: number): number {
  return roomGroupToggleFor(index)?.messageCount ?? 0
}

function toggleRoomGroup(index: number): void {
  const group = roomGroupToggleFor(index)
  const sessionId = effectiveSessionId.value
  if (!group || !sessionId) return
  chatStore.toggleRoomGroupCollapsed(sessionId, group.key)
}

// Navigation (quote jump / search hit / nav rail) must never aim at a row that
// a fold removed: the scroll would silently do nothing. Unfold first, then let
// the existing scroll path run on the next tick.
function revealRoomRowForMessage(messageId: string): void {
  if (!isRoomSession.value) return
  const sessionId = effectiveSessionId.value
  if (!sessionId) return
  const index = props.messages.findIndex(message => message.id === messageId)
  if (index < 0) return
  const group = roomGroupAt(roomLayout.value, index)
  if (!group || group.head === index || !isRoomGroupFolded(group)) return
  chatStore.expandRoomGroup(sessionId, group.key)
}

/**
 * Which band of the room gap table this row's TOP gap comes from (W15 §3.6).
 *
 * Every vertical gap in a room is owned by the row BELOW it — one margin-top
 * per row, no component-owned bottoms anywhere in the stream. That is the whole
 * trick: with a single contributor per gap, two rows of the same pair-type
 * cannot drift apart, which is what made the stream read as "间隔没有固定".
 * The band is decided here (from the projection, not from CSS guesswork) and
 * spent in one place — the `.message-list.is-room` block at the bottom of this
 * file.
 *
 * `undefined` = the default turn band. Outside a room this returns undefined
 * for every row and the table never engages.
 */
function roomRowClass(index: number): string | undefined {
  if (!isRoomSession.value) return undefined
  // A system line is a notice, whoever it interrupts.
  if (props.messages[index]?.role === 'system') return 'room-row--notice'
  // W14b: a thinking trace OPENS the turn it belongs to, so it takes the turn
  // band above it and hands the stack band to whatever it says next (the CSS
  // `+ *` rule below) — one turn reads as one block, not two full gaps.
  if (isRoomThinkingTrace(props.messages[index] as RoomMessageLike)) return 'room-row--trace'
  // Not a group head ⇒ the same agent is still speaking ⇒ stack band.
  if (!roomLayout.value.groupHeads.has(index)) return 'room-row--stacked'
  return undefined
}

// Get current message list density setting
const messageListDensity = computed(() => {
  return settingsStore.settings.general?.messageListDensity || 'comfortable'
})

// Get custom line height setting (overrides density default if set)
const customLineHeight = computed(() => {
  return settingsStore.settings.general?.messageLineHeight
})

// Get chat font size setting
const chatFontSize = computed(() => {
  return settingsStore.settings.chat?.chatFontSize
})

// Get chat font settings
const chatFontEn = computed(() => settingsStore.settings.chat?.chatFontEn)
const chatFontZh = computed(() => settingsStore.settings.chat?.chatFontZh)

const MESSAGE_DENSITY_TYPOGRAPHY = {
  compact: {
    fontSize: 14,
    lineHeight: 20 / 14,
    contentSpacing: 0.4,
  },
  comfortable: {
    fontSize: 15,
    lineHeight: 24 / 15,
    contentSpacing: 0.75,
  },
  spacious: {
    fontSize: 16,
    lineHeight: 29 / 16,
    contentSpacing: 1,
  },
} as const

type MessageDensityKey = keyof typeof MESSAGE_DENSITY_TYPOGRAPHY

function getDensityTypography(density: string) {
  return MESSAGE_DENSITY_TYPOGRAPHY[(density as MessageDensityKey)] ?? MESSAGE_DENSITY_TYPOGRAPHY.comfortable
}

function px(value: number): string {
  return `${Math.max(1, Math.round(value))}px`
}

// Combined styles for message list
const messageListStyles = computed(() => {
  const styles: Record<string, string> = {}
  const density = messageListDensity.value
  const densityTypography = getDensityTypography(density)
  // 聊天面(say-only)的 13 / 1.72 档不在这里:那一面走 `RoomSurface`,排版由
  // 它自己的 `flowStyles` 从 `SAY_METRICS` 写出来(R3 拆门时一并移走)。
  const fontSize = Number(chatFontSize.value) || densityTypography.fontSize
  const lineHeight = Number(customLineHeight.value) || densityTypography.lineHeight
  const contentSpacing = densityTypography.contentSpacing

  if (customLineHeight.value) {
    styles['--message-line-height'] = String(customLineHeight.value)
  }
  if (chatFontSize.value) {
    styles['--message-font-size'] = `${chatFontSize.value}px`
  }
  if (chatFontEn.value || chatFontZh.value) {
    styles['--font-body'] = buildFontFamily(chatFontEn.value, chatFontZh.value)
  }
  styles['--message-line-height-px'] = px(fontSize * lineHeight)
  styles['--content-spacing-px'] = px(fontSize * contentSpacing)
  styles['--content-paragraph-gap'] = px(fontSize * 0.5)
  styles['--content-list-gap'] = px(fontSize * 0.4)
  styles['--content-list-item-gap'] = px(fontSize * 0.15)
  styles['--content-heading-top-gap'] = px(fontSize * 0.55)
  styles['--content-heading-bottom-gap'] = px(fontSize * 0.18)
  styles['--content-heading-line-height-px'] = px(fontSize * 1.32)
  styles['--chat-composer-safe-gap'] = px(fontSize * 1.75)
  return Object.keys(styles).length > 0 ? styles : undefined
})

// Track current navigation position among user messages
const currentUserMessageNavIndex = ref(-1)
const currentAssistantOutlineIndex = ref(-1)

// Track if user has actually navigated (to avoid showing highlight on session switch)
const hasNavigated = ref(false)


// Flag to prevent scroll handler from overriding navigation index during active navigation
let isActivelyNavigating = false
let navigationCooldownTimer: ReturnType<typeof setTimeout> | null = null
let navMarkerUpdateFrame: number | null = null
let navPanelRoomUpdateFrame: number | null = null
let assistantOutlineUpdateFrame: number | null = null
let visibleUserMessageFrame: number | null = null
let measurementRefreshFrame: number | null = null
let navResizeObserver: ResizeObserver | null = null
let readingAnchorResizeObserver: ResizeObserver | null = null
let readingAnchorCaptureFrame: number | null = null
let lastScrollerBox: { width: number; height: number } | null = null
let isAssistantOutlineNavigating = false
let assistantOutlineCooldownTimer: ReturnType<typeof setTimeout> | null = null
let renderMeasureStart: number | null = null
let renderMeasureSessionId = ''
let renderMeasureMessageCount = 0
let userMessageMeasurements: Array<{ messageIndex: number; messageId: string; start: number }> = []
let deferredLayoutMeasurementRefresh = false
let deferredLayoutMeasurementTimer: ReturnType<typeof setTimeout> | null = null
let deferredLayoutMeasurementFollowupTimer: ReturnType<typeof setTimeout> | null = null

interface TopAnchor {
  messageId: string
  offsetWithinMessage: number
}

const NAV_VIEWPORT_OFFSET_RATIO = 0.18
const NAV_PANEL_MIN_RIGHT_GAP = 300
const SCROLL_ANCHOR_LOCK_MS = 2400
const SESSION_RESTORE_ANCHOR_LOCK_MS = 120_000

const pageState = computed(() => chatStore.getSessionPageState(effectiveSessionId.value))
const loadedMessageCount = computed(() => props.messages.length)
const totalMessageCount = computed(() => pageState.value?.totalCount ?? panelSession.value?.messageCount ?? loadedMessageCount.value)
const pageHistorySummary = computed(() => {
  const state = pageState.value
  const total = totalMessageCount.value
  const loaded = loadedMessageCount.value
  // `hasMoreBefore` is the authority. `totalCount` lags a send by a tick
  // (the two new rows land before the page state refreshes), and hiding the
  // button on `total <= loaded` made it vanish for a frame on every send —
  // 42px removed above the whole list, right as the new turn scrolled in.
  if (!state || !state.hasMoreBefore) return ''
  const counts = total > loaded ? ` · ${loaded}/${total}` : ''
  if (state.isLoadingOlder) return `Loading earlier messages...${counts}`
  return `Load earlier messages${counts}`
})

const hasActiveStream = computed(() => props.messages.some(message => message.isStreaming))

function deferLayoutMeasurementDuringTransition(): boolean {
  if (!props.layoutTransitioning) return false
  deferredLayoutMeasurementRefresh = true
  return true
}

function cancelPendingLayoutMeasurementFrames() {
  if (navMarkerUpdateFrame !== null) {
    cancelAnimationFrame(navMarkerUpdateFrame)
    navMarkerUpdateFrame = null
  }
  if (navPanelRoomUpdateFrame !== null) {
    cancelAnimationFrame(navPanelRoomUpdateFrame)
    navPanelRoomUpdateFrame = null
  }
  if (assistantOutlineUpdateFrame !== null) {
    cancelAnimationFrame(assistantOutlineUpdateFrame)
    assistantOutlineUpdateFrame = null
  }
  if (visibleUserMessageFrame !== null) {
    cancelAnimationFrame(visibleUserMessageFrame)
    visibleUserMessageFrame = null
  }
  if (measurementRefreshFrame !== null) {
    cancelAnimationFrame(measurementRefreshFrame)
    measurementRefreshFrame = null
  }
}

const follow = useFollowScroll({
  scroller: messageListRef,
  content: messageListContentRef,
  count: computed(() => props.messages.length),
  maintainOnLayout: hasActiveStream,
})

const { isFollowing } = follow
// 子树深处的自动收起要用它做可见性裁决(useDeferredAutoCollapse)。只读投影。
provideChatFollowState(isFollowing)
const useBottomScrollAnchor = computed(() => isFollowing.value && hasActiveStream.value)
const scrollCoordinator = useMessageScrollCoordinator({
  scroller: messageListRef,
  getSessionId: () => effectiveSessionId.value,
  getMessageRowById,
  onStateChange: updateScrollToBottomButton,
})

// —— 宽度变化时的阅读锚 ——
//
// `.message-list-row { overflow-anchor: none }` 是刻意的:位置由 scrollCoordinator
// 说了算。但 coordinator 只在 tail / anchor(流式跟随、发送后、hold-top)介入,
// 空闲阅读时没人维持锚点。于是拖工作台分隔条 / 收起展开左栏时聊天列变宽变窄,
// 视口**上方**每一条消息重新换行,可见内容被整体推走(实测单帧 26–104px,一次
// 拖拽累计 ~500px,方向随宽窄反转)。
//
// 补的是那一格空缺,不是把 overflow-anchor 重新打开 —— 浏览器原生锚定历史上和
// coordinator 打过架。只认宽度:高度变化仍旧全权交给 tail/anchor/hold-top。
function canTrackReadingAnchor(): boolean {
  if (hasActiveStream.value) return false
  return scrollCoordinator.isIdle()
}

function captureReadingAnchorNow() {
  if (!canTrackReadingAnchor()) return
  const el = messageListRef.value
  if (!el) return
  // 宽度已变但 ResizeObserver 还没派送(同一帧里 scroll 事件与 rAF 都排在 RO
  // 之前):此刻量到的是**已经漂走**的位置,记下来等于把漂移当成用户意图。
  if (props.layoutTransitioning) return
  if (lastScrollerBox && Math.abs(el.clientWidth - lastScrollerBox.width) > 0.5) return
  scrollCoordinator.captureReadingAnchor(captureTopAnchor())
}

// scroll 事件很密,不能每次都 querySelectorAll 全表:一帧最多量一次。
function scheduleReadingAnchorCapture() {
  if (!canTrackReadingAnchor()) return
  if (readingAnchorCaptureFrame !== null) return
  readingAnchorCaptureFrame = requestAnimationFrame(() => {
    readingAnchorCaptureFrame = null
    captureReadingAnchorNow()
  })
}

function attachReadingAnchorObserver(scroller: HTMLElement) {
  if (typeof ResizeObserver === 'undefined') return
  lastScrollerBox = { width: scroller.clientWidth, height: scroller.clientHeight }
  readingAnchorResizeObserver = new ResizeObserver(() => {
    const el = messageListRef.value
    if (!el) return
    const next = { width: el.clientWidth, height: el.clientHeight }
    const widthChanged = shouldRestoreReadingAnchor(lastScrollerBox, next)
    lastScrollerBox = next
    // A new column width invalidates every skipped row's remembered height:
    // lay them all out once at the new width before skipping again.
    if (widthChanged) rearmRowSkipping()
    if (!canTrackReadingAnchor()) return
    if (widthChanged) {
      // RO 回调 = layout 之后、paint 之前。同步写 scrollTop,一帧都不漏。
      scrollCoordinator.restoreReadingAnchor()
      return
    }
    // 只是高度变了(工具卡展开、composer 变高):不还原,但把锚点刷新一次,
    // 否则视口上方内容长高后锚点就过期了,下一次宽度变化会还原到错的地方。
    scheduleReadingAnchorCapture()
  })
  readingAnchorResizeObserver.observe(scroller)
}

function detachReadingAnchorObserver() {
  readingAnchorResizeObserver?.disconnect()
  readingAnchorResizeObserver = null
  lastScrollerBox = null
  if (readingAnchorCaptureFrame !== null) {
    cancelAnimationFrame(readingAnchorCaptureFrame)
    readingAnchorCaptureFrame = null
  }
}

// 历史分页(向上补旧 / 向下补新)—— 与房面共用同一份实现与阈值(R1)。
const historyPagination = useHistoryPagination({
  scroller: messageListRef,
  content: messageListContentRef,
  getSessionId: () => effectiveSessionId.value,
  getPageState: () => pageState.value,
  isSwitching: () => follow.isSwitching(),
  isFollowing,
  clearScrollMode: () => scrollCoordinator.clear(),
  getMessageRowById,
  writeScrollTop: top => scrollCoordinator.writeScrollTop(top),
  onLoaded: () => {
    scheduleMeasurementRefresh()
    scheduleNavMarkerUpdate()
    scheduleAssistantOutlineUpdate()
    scheduleVisibleUserMessageIndexUpdate()
  },
  onSettled: () => updateScrollToBottomButton(),
})
const { loadOlderHistoryIfNeeded, loadNewerHistoryIfNeeded } = historyPagination

// Auto-scroll: while a response is streaming, keep the scroller pinned to its natural bottom.
// Composer safety is real tail padding below the list content, so "follow" and
// the real scrollbar bottom stay identical even as the composer changes height.
const effectiveScrollVersion = computed(() => chatStore.getScrollVersion(effectiveSessionId.value))

let followNudgeFrame: number | null = null

function scheduleFollowNudge(source: string) {
  void source
  updateTailSpacer()
  if ((isFollowing.value && hasActiveStream.value) || scrollCoordinator.isTail()) {
    scrollCoordinator.onLayoutChange()
    updateScrollToBottomButton()
    return
  }
  if (!scrollCoordinator.isAnchored()) {
    scheduleScrollStateUpdate()
    return
  }
  if (followNudgeFrame !== null) return
  followNudgeFrame = requestAnimationFrame(() => {
    followNudgeFrame = null
    scrollCoordinator.onLayoutChange()
    updateScrollToBottomButton()
  })
}

function updateScrollToBottomButton() {
  const el = messageListRef.value
  if (!el) {
    showScrollToBottomButton.value = false
    return
  }
  // When hasMoreAfter is true, the visible "bottom" is not the real end
  // of the conversation — force-show the button so the user can navigate
  // to actual latest messages.
  const hasMoreAfter = pageState.value?.hasMoreAfter ?? false
  showScrollToBottomButton.value = hasMoreAfter || shouldShowScrollToBottomButton(el, isFollowing.value)
}

// External drift triggers — store-emitted scroll bumps and message count
// changes. The composable's internal ResizeObserver also covers post-paint
// layout (markdown rendering, code blocks growing, images loading), but we
// fire an extra nudge here so a store bump doesn't have to wait for layout.
watch([effectiveScrollVersion, () => props.messages.length], () => {
  if (props.messages.length === 0) return
  if (historyPagination.isPrepending()) return
  nextTick(() => scheduleFollowNudge('watch:scrollVersion+msgLen'))
}, { flush: 'post' })

// Force-follow when a new user message lands. The user explicitly sent it,
// so they want the new bubble + the response to be visible regardless of
// whether they were detached. The list is a plain `v-for` (never virtualized),
// so the first scrollHeight can still be wrong before the browser lays out the
// new row — schedule one post-paint nudge after the real heights settle.
const lastUserMessageId = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'user') return props.messages[i].id
  }
  return null
})
let isReloadingTailForSend = false
let isNavigatingCrossPage = false

watch([effectiveSessionId, lastUserMessageId, () => props.messages.length], async ([sessionId, newId, messageCount], [oldSessionId, oldId, oldMessageCount]) => {
  if (!newId || newId === oldId) return
  if (sessionId !== oldSessionId) return
  if (messageCount <= oldMessageCount) return
  if (follow.isSwitching()) return
  if (isReloadingTailForSend) return
  if (isNavigatingCrossPage) return
  // Only trigger when a new user message was APPENDED to the end
  // (user just sent a message), NOT when the message array was REPLACED
  // by a navigation action (loadMessagesAround/loadOlderMessages).
  // Heuristic: count increased by exactly 1, old last user message
  // still exists in the new array, and new last user message is
  // genuinely new (wasn't in the old array at any position).
  const countIncrementedByOne = messageCount === oldMessageCount + 1
  const oldMsgStillExists = oldId ? !!props.messages.find(m => m.id === oldId) : false
  const isNewUserMessage = countIncrementedByOne && oldMsgStillExists
  if (!isNewUserMessage) return
  
  // If we're viewing a truncated window (hasMoreAfter=true), reload the
  // tail page so the new message lands at the real bottom instead of being
  // appended into a partial window.
  if (sessionId && pageState.value?.hasMoreAfter) {
    isReloadingTailForSend = true
    try {
      scrollCoordinator.clear()
      await chatStore.loadInitialMessagePage(sessionId)
    } finally {
      isReloadingTailForSend = false
    }
  }
  
  // A steer interjects into a running response the reader is already
  // following: keep following. An ordinary send holds the new question at the
  // top and lets the answer stream into the space below it (D1, 2026-08-17)
  // — one continuous scroll instead of a hard jump to the tail.
  const newMessage = props.messages.find(m => m.id === newId)
  if (newMessage?.steered) {
    follow.isFollowing.value = true
    scrollCoordinator.setTail()
    nextTick(() => scheduleFollowNudge('watch:lastUserMsg'))
    return
  }
  // Detach NOW (pre-flush): the follow composable's ResizeObserver fires
  // right after the new row lays out and would pin to the bottom instantly,
  // landing on the very position the smooth hold is about to animate to.
  follow.isFollowing.value = false
  scrollCoordinator.clear()
  // Same patch as the new rows: the browser must not anchor-adjust the frame
  // they land in (see isHoldingTop).
  isHoldingTop.value = true
  nextTick(() => {
    if (!holdMessageAtTop(newId, sendHoldOffset(), { behavior: 'smooth' })) {
      isHoldingTop.value = false
      follow.isFollowing.value = true
      scrollCoordinator.setTail()
    }
    scheduleFollowNudge('watch:lastUserMsg')
  })
})

// ============ Hold-top: send / regenerate keep a row at the viewport top ============
//
// Two callers, one mechanism. On send, the new question is held at the top; on
// regenerate, the question above the regenerated answer (or whatever row the
// reader was already looking at above it) is held where it is. The tail spacer
// makes the hold physically possible when the content below the row is shorter
// than the viewport, and shrinks as the answer streams in — total scroll height
// is constant until the answer outgrows the viewport, at which point the hold
// hands over to ordinary tail-following. A user scroll (wheel / thumb drag)
// clears the coordinator anchor and thereby ends the hold; the spacer then
// freezes at its current height (shrinking it under the reader would jump).
const HOLD_TOP_ANCHOR_MS = 10 * 60_000
/**
 * Where a freshly sent question comes to rest: this fraction of the viewport
 * down from the top (2026-08-17 拍板 1/3). Pinning it to the very top read as
 * a page flip — the answer you were just reading vanished in one motion; a
 * third leaves the tail of the previous answer in view above the new turn.
 */
const SEND_HOLD_VIEWPORT_FRACTION = 1 / 3
function sendHoldOffset(): number {
  const el = messageListRef.value
  return el ? -Math.round(el.clientHeight * SEND_HOLD_VIEWPORT_FRACTION) : 0
}
// `armed` flips once the spacer has actually been needed (content below the
// row shorter than the viewport). Only an armed hold may hand over to tail
// following: a regenerate hold is taken BEFORE the truncation removes the
// content below, so at that instant the viewport is trivially "full".
let holdTop: { messageId: string; offsetWithinMessage: number; armed: boolean } | null = null
// Mirrors `holdTop` for the template: while holding, the scroller opts out of
// the browser's own scroll anchoring (measured: it re-adjusted scrollTop by the
// composer's collapse delta in the frame the new rows landed, a 66px step in
// front of the smooth hold). The coordinator owns the position during a hold.
const isHoldingTop = ref(false)

function setTailSpacerHeight(px: number) {
  const spacer = tailSpacerRef.value
  if (!spacer) return
  const next = Math.max(0, Math.round(px))
  if (spacer.offsetHeight === next) return
  spacer.style.height = next > 0 ? `${next}px` : ''
}

function releaseHoldTop() {
  holdTop = null
  isHoldingTop.value = false
}

/**
 * Size the spacer for the current hold. Returns false when the hold is over.
 * `allowHandover` lets a filled viewport end the hold in favour of tail
 * following — off at hold time (a regenerate hold is measured BEFORE the
 * truncation removes the content below the row).
 */
function applyTailSpacer(allowHandover: boolean): boolean {
  if (!holdTop) return false
  const scroller = messageListRef.value
  const spacer = tailSpacerRef.value
  if (!scroller || !spacer) return false
  const row = getMessageRowById(holdTop.messageId)
  if (!row) {
    releaseHoldTop()
    return false
  }
  // Real content height WITHOUT the spacer, measured on the content box —
  // not scrollHeight, which is clamped to clientHeight when the content is
  // shorter than the viewport (exactly the case a spacer exists for).
  const content = messageListContentRef.value
  if (!content) return false
  const baseHeight = content.offsetHeight - spacer.offsetHeight
  const needed = row.offsetTop + holdTop.offsetWithinMessage + scroller.clientHeight - baseHeight
  if (needed > 0) holdTop.armed = true
  if (needed <= 0 && allowHandover && holdTop.armed) {
    // The answer has filled the viewport below the held row: hand over to
    // tail-following from exactly here (no movement — the bottom is already
    // at the bottom).
    setTailSpacerHeight(0)
    releaseHoldTop()
    scrollCoordinator.clear()
    follow.isFollowing.value = true
    scrollCoordinator.setTail()
    return false
  }
  setTailSpacerHeight(needed)
  return true
}

/** Layout-change path: only while the coordinator anchor still holds. */
function updateTailSpacer() {
  if (!holdTop) {
    clampTailSpacerToLastQuestion()
    return
  }
  if (!scrollCoordinator.isAnchored()) {
    // User took over: stop holding. The spacer is not frozen — it keeps
    // getting clamped below so it can only ever shrink from here.
    releaseHoldTop()
    clampTailSpacerToLastQuestion()
    return
  }
  applyTailSpacer(true)
}

/**
 * Invariant outside a hold: the spacer never lets the list scroll PAST the
 * last question at its send-hold position (SEND_HOLD_VIEWPORT_FRACTION). Without this the spacer left behind by
 * a finished/abandoned hold stayed at its old size while the answer kept
 * growing, and the last message could be scrolled almost out of the window
 * (2026-08-17 field report). Only ever shrinks, and while content grows the
 * shrink cancels the growth exactly, so max scroll holds still — no jump.
 */
function clampTailSpacerToLastQuestion() {
  const scroller = messageListRef.value
  const spacer = tailSpacerRef.value
  const content = messageListContentRef.value
  if (!scroller || !spacer || !content) return
  const current = spacer.offsetHeight
  if (current <= 0) return
  let row: HTMLElement | null = null
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role !== 'user') continue
    row = getMessageRowById(props.messages[i].id)
    if (row) break
  }
  if (!row) {
    setTailSpacerHeight(0)
    return
  }
  const baseHeight = content.offsetHeight - current
  const allowed = row.offsetTop + sendHoldOffset() + scroller.clientHeight - baseHeight
  if (allowed < current) setTailSpacerHeight(Math.max(0, allowed))
}

/**
 * Send is a two-beat event: the composer collapses NOW (draft cleared), the
 * new rows land a round-trip later. At the bottom of the list, a taller
 * viewport means the browser clamps scrollTop and the whole conversation
 * drops by the collapse delta one frame before the smooth hold can start.
 * ChatPanel calls this right before dispatching a send; the next composer
 * resize (notifyLayoutChange, same frame as the RO, pre-paint) grows the tail
 * spacer by the viewport delta so nothing moves — the hold then re-sizes the
 * spacer from real content.
 */
let sendPrep: { clientHeight: number; scrollTop: number; until: number } | null = null

function prepareForSend() {
  const el = messageListRef.value
  if (!el) return
  sendPrep = { clientHeight: el.clientHeight, scrollTop: el.scrollTop, until: performance.now() + 2000 }
}

function absorbComposerCollapseForSend() {
  if (!sendPrep) return
  const el = messageListRef.value
  const spacer = tailSpacerRef.value
  if (!el || !spacer || performance.now() > sendPrep.until) {
    sendPrep = null
    return
  }
  const grown = el.clientHeight - sendPrep.clientHeight
  if (grown <= 0) return
  setTailSpacerHeight(spacer.offsetHeight + grown)
  scrollCoordinator.writeScrollTop(sendPrep.scrollTop)
  sendPrep.clientHeight = el.clientHeight
}

function holdMessageAtTop(
  messageId: string,
  offsetWithinMessage: number,
  writeOptions: { behavior?: 'auto' | 'smooth' } = {},
): boolean {
  const scroller = messageListRef.value
  const row = getMessageRowById(messageId)
  if (!scroller || !row || !tailSpacerRef.value) return false
  holdTop = { messageId, offsetWithinMessage, armed: false }
  isHoldingTop.value = true
  sendPrep = null
  follow.isFollowing.value = false
  // Spacer first (synchronously, so the scroll target is reachable), then the
  // anchor — its restore is what actually moves the viewport.
  if (!applyTailSpacer(false)) return true
  scrollCoordinator.setAnchor(messageId, offsetWithinMessage, HOLD_TOP_ANCHOR_MS, writeOptions)
  updateScrollToBottomButton()
  return true
}

/**
 * Regenerate is a truncate-and-restream: the target answer and everything
 * after it vanish, then a placeholder streams in the same slot. Without a
 * hold the browser clamps scrollTop into whatever is left and the reader
 * lands somewhere else. Call BEFORE the command goes out.
 */
function holdForRegenerate(assistantMessageId: string): boolean {
  const index = props.messages.findIndex(m => m.id === assistantMessageId)
  if (index < 0) return false
  const targetRow = getMessageRowById(assistantMessageId)
  // Reader already looking at content above the target: keep that view.
  const topAnchor = captureTopAnchor()
  if (topAnchor && targetRow) {
    const anchorRow = getMessageRowById(topAnchor.messageId)
    if (anchorRow && anchorRow !== targetRow && anchorRow.offsetTop < targetRow.offsetTop) {
      return holdMessageAtTop(topAnchor.messageId, topAnchor.offsetWithinMessage)
    }
  }
  // Otherwise pin the question the answer belongs to at the top.
  for (let i = index - 1; i >= 0; i--) {
    if (props.messages[i].role === 'user' && getMessageRowById(props.messages[i].id)) {
      return holdMessageAtTop(props.messages[i].id, 0, { behavior: 'smooth' })
    }
  }
  return false
}

// Nav-rail markers + visible-user-msg tracking also depend on content
// height changes. We add a separate (cheap) ResizeObserver here so the nav
// concerns stay independent of the follow logic in the composable.
let navContentResizeObserver: ResizeObserver | null = null
watch(
  messageListContentRef,
  (el) => {
    if (navContentResizeObserver) {
      navContentResizeObserver.disconnect()
      navContentResizeObserver = null
    }
    if (!el || typeof ResizeObserver === 'undefined') return
    navContentResizeObserver = new ResizeObserver(() => {
      // Hold-top: keep the spacer in step with content height *every* layout
      // (CSS height transitions — the thinking panel folding — shrink the
      // content between store nudges; without this the max scroll dips under
      // the held offset for a few frames and the held row bobs).
      if (holdTop && scrollCoordinator.isAnchored()) {
        applyTailSpacer(true)
        // Synchronous, not the rAF-scheduled onLayoutChange: RO runs after
        // layout and before paint, so restoring here paints no clamped frame.
        scrollCoordinator.restoreAnchorNow()
      } else {
        clampTailSpacerToLastQuestion()
      }
      if (deferLayoutMeasurementDuringTransition()) return
      scheduleNavMarkerUpdate()
      scheduleNavPanelRoomUpdate()
      scheduleAssistantOutlineUpdate()
      scheduleMeasurementRefresh()
      if (hasActiveStream.value || scrollCoordinator.isAnchored() || scrollCoordinator.isTail()) {
        scrollCoordinator.onLayoutChange()
      }
      if (!scrollCoordinator.isAnchored()) {
        scheduleVisibleUserMessageIndexUpdate()
      }
    })
    navContentResizeObserver.observe(el)
  },
  { immediate: true },
)

// Get indices of user messages
const userMessageIndices = computed(() => {
  return props.messages
    .map((msg, index) => ({ msg, index }))
    .filter(item => item.msg.role === 'user')
    .map(item => item.index)
})

const displayNavMarkers = computed<NavMarker[]>(() => {
  const sessionId = effectiveSessionId.value
  const fullMarkers = sessionId ? chatStore.sessionUserMarkers.get(sessionId) : undefined
  if (fullMarkers && fullMarkers.length > 0) {
    return fullMarkers.map((marker, navIndex) => ({
      navIndex,
      messageId: marker.id,
      seq: marker.seq,
      position: getEvenNavPosition(navIndex, fullMarkers.length),
      label: `${navIndex + 1}/${fullMarkers.length} ${formatNavTime(marker.timestamp)} - ${marker.preview}`,
      preview: marker.preview || `${navIndex + 1}/${fullMarkers.length}`,
    }))
  }

  const total = userMessageIndices.value.length
  if (total === 0) return []

  const fallbackMarkers = userMessageIndices.value.map((messageIndex, navIndex) => {
    const message = props.messages[messageIndex]
    return {
      navIndex,
      messageId: message?.id || `nav-${navIndex}`,
      seq: message?.seq,
      position: getFallbackNavPosition(messageIndex),
      label: message ? buildNavMarkerLabel(message, navIndex) : `${navIndex + 1}/${total}`,
      preview: message ? buildNavMarkerPreview(message) : `${navIndex + 1}/${total}`,
    }
  })

  if (navMarkers.value.length === 0) {
    return fallbackMarkers
  }

  const markerMap = new Map(navMarkers.value.map(marker => [marker.messageId, marker]))
  return fallbackMarkers.map(marker => markerMap.get(marker.messageId) || marker)
})

const hasAssistantOutlineNav = computed(() => assistantOutlineMarkers.value.length > 1)
const hasUserNavTrail = computed(() => displayNavMarkers.value.length > 1)
const useSideOutlineRail = computed(() => Boolean(props.outlineRailTarget))

watch([assistantOutlineMarkers, currentAssistantOutlineIndex], ([markers, currentIndex]) => {
  const current = markers.find(marker => marker.navIndex === currentIndex) || null
  window.dispatchEvent(new CustomEvent('assistant-outline:current-changed', {
    detail: {
      sessionId: props.sessionId || '',
      label: current?.preview || '',
      count: markers.length,
    },
  }))
})

function updateNavPanelRoom() {
  const scroller = messageListRef.value
  const content = messageListContentRef.value
  if (!scroller || !content) {
    hasNavPanelRoom.value = false
    return
  }

  const scrollerRect = scroller.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const rightGap = scrollerRect.right - contentRect.right
  hasNavPanelRoom.value = rightGap >= NAV_PANEL_MIN_RIGHT_GAP
}

function scheduleNavPanelRoomUpdate() {
  if (deferLayoutMeasurementDuringTransition()) return
  if (navPanelRoomUpdateFrame !== null) {
    cancelAnimationFrame(navPanelRoomUpdateFrame)
  }
  navPanelRoomUpdateFrame = requestAnimationFrame(() => {
    navPanelRoomUpdateFrame = null
    updateNavPanelRoom()
  })
}

// Get the currently highlighted message ID for navigation
// Only returns a value if user has actually navigated (not on session switch)
const highlightedMessageId = computed(() => {
  if (searchHighlightedMessageId.value) return searchHighlightedMessageId.value
  if (!hasNavigated.value) return null
  if (currentUserMessageNavIndex.value < 0) return null
  return displayNavMarkers.value[currentUserMessageNavIndex.value]?.messageId ?? null
})

// A goal that has stopped running gets an outcome card in the timeline. Only
// terminal states qualify — an active goal has nothing to summarize yet, and
// resuming a paused one retracts the card.
const GOAL_OUTCOME_STATUSES = new Set([
  'complete',
  'abandoned',
  'paused',
  'blocked',
  'budget_limited',
])

const goalSummary = computed(() => {
  const goal = props.sessionId ? sessionsStore.sessionGoals.get(props.sessionId) : null
  return goal && GOAL_OUTCOME_STATUSES.has(goal.status) ? goal : null
})

/**
 * Every settled goal in the session, each anchored to the message it finished
 * on. A session can hold a run of goals now (docs/design/goal-system-v3.md),
 * so the timeline shows one card per goal rather than only the latest.
 *
 * Falls back to the single live goal for sessions whose history has not been
 * pushed down yet, which keeps the pre-v3 behaviour intact.
 */
const goalSummariesByIndex = computed<Map<number, SessionGoal[]>>(() => {
  const byIndex = new Map<number, SessionGoal[]>()
  if (!props.sessionId) return byIndex

  const history = sessionsStore.sessionGoalHistory.get(props.sessionId)
  const settled = history?.length
    ? history.filter(goal => GOAL_OUTCOME_STATUSES.has(goal.status))
    : goalSummary.value
      ? [goalSummary.value]
      : []

  for (const goal of settled) {
    const index = anchorIndexFor(goal)
    if (index === -1) continue
    const bucket = byIndex.get(index)
    if (bucket) bucket.push(goal)
    else byIndex.set(index, [goal])
  }
  return byIndex
})

// endedAt is the immutable moment the goal left 'active'. updatedAt keeps
// moving after that — completing a goal kicks off an async fileChanges
// backfill that rewrites it — which used to make the card jump a slot a
// moment after it appeared. Older records predate endedAt, hence the fallback.
function anchorIndexFor(goal: SessionGoal): number {
  const settledAt = goal.endedAt ?? goal.updatedAt
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if ((props.messages[i]?.timestamp ?? 0) <= settledAt) return i
  }
  return -1
}

// Initialize navigation index when messages change
// Note: Session switching is handled by ChatWindow's snapshot save/restore.
// This watcher handles message count changes (new messages arriving, session data swap).
watch(
  () => props.messages.length,
  () => {
    renderMeasureStart = performance.now()
    renderMeasureSessionId = effectiveSessionId.value
    renderMeasureMessageCount = props.messages.length
    // Skip during session switch — snapshot restore will set the correct state
    if (follow.isSwitching()) return
    if (historyPagination.isPrepending()) return

    // Reset navigation highlight (don't highlight on new message arrival)
    hasNavigated.value = false

    if (isFollowing.value) {
      setNavIndexToLastMarker()
    }

    // Schedule marker update after DOM renders
    nextTick(() => {
      scheduleMeasurementRefresh()
      nextTick(() => {
        scheduleNavMarkerUpdate()
        scheduleAssistantOutlineUpdate()
      })
    })
  },
  { immediate: true, flush: 'post' }
)

watch(effectiveSessionId, () => {
  clearAssistantOutline()
  renderMeasureStart = performance.now()
  renderMeasureSessionId = effectiveSessionId.value
  renderMeasureMessageCount = props.messages.length
}, { flush: 'pre' })

watch(effectiveSessionId, (sessionId) => {
  if (!sessionId || chatStore.sessionUserMarkers.get(sessionId)) return
  window.setTimeout(() => {
    if (effectiveSessionId.value === sessionId && !chatStore.sessionUserMarkers.get(sessionId)) {
      chatStore.loadUserMessageMarkers(sessionId)
    }
  }, 0)
}, { immediate: true })

watch(
  () => displayNavMarkers.value.length,
  () => {
    if (!isFollowing.value || hasNavigated.value) return
    setNavIndexToLastMarker()
  },
  { flush: 'post' },
)

onUpdated(() => {
  if (renderMeasureStart === null) return
  const start = renderMeasureStart
  const sessionId = renderMeasureSessionId
  const messageCount = renderMeasureMessageCount
  renderMeasureStart = null
  requestAnimationFrame(() => {
    const rows = messageListContentRef.value?.querySelectorAll('.message-list-row[data-message-id]').length ?? 0
    perfLog.debug('message list rendered', {
      sessionId,
      totalToFirstFrameMs: Math.round(performance.now() - start),
      messageCount,
      domRows: rows,
      scrollHeight: messageListRef.value?.scrollHeight ?? 0,
    })
  })
})

// Ensure nav markers are updated when user message count changes
// This handles the case where messages are loaded asynchronously after app restart
watch(
  () => userMessageIndices.value.length,
  (newLen, oldLen) => {
    if (newLen !== oldLen && newLen > 0) {
      nextTick(() => scheduleNavMarkerUpdate())
    }
  }
)

async function navigateToUserMessage(navIndex: number) {
  const marker = displayNavMarkers.value.find(item => item.navIndex === navIndex)
  if (marker) {
    const sessionId = effectiveSessionId.value
    hasNavigated.value = true
    isFollowing.value = false
    lockNavigationIndex(navIndex)
    if (getMessageRowById(marker.messageId)) {
      scrollToMessage(marker.messageId, {
        preserveNavigation: true,
        behavior: 'smooth',
        viewportOffsetRatio: NAV_VIEWPORT_OFFSET_RATIO,
        lockDurationMs: SCROLL_ANCHOR_LOCK_MS,
      })
      return
    }
    if (!sessionId) return
    // Set a guard to prevent the lastUserMessageId watcher (Fix D5)
    // from re-loading the tail page while we're doing a cross-page
    // navigation. Without this, the watcher sees the new message set,
    // detects hasMoreAfter=true, and calls loadInitialMessagePage
    // which overwrites the anchor window with the tail.
    isNavigatingCrossPage = true
    // Clear any residual tail/anchor mode before loading a new message
    // window — otherwise the coordinator will pull the viewport to the
    // bottom instead of the target message.
    scrollCoordinator.clear()
    const loaded = await chatStore.loadMessagesAround(sessionId, marker.messageId)
    if (loaded) {
      await nextTick()
      lockNavigationIndex(navIndex)
      // Use 'auto' (instant) scroll for cross-page jumps so that
      // scrollToMessage's non-smooth branch sets an anchor lock on the
      // target message, protecting it from layout-driven drift.
      scrollToMessage(marker.messageId, {
        preserveNavigation: true,
        behavior: 'auto',
        viewportOffsetRatio: NAV_VIEWPORT_OFFSET_RATIO,
        lockDurationMs: SCROLL_ANCHOR_LOCK_MS,
      })
    }
    // Schedule a reset of the guard — uses nextTick so any pending
    // watcher invocations that were queued during the navigation
    // still see isNavigatingCrossPage = true.
    nextTick(() => { isNavigatingCrossPage = false })
    return
  }

  if (navIndex < 0 || navIndex >= userMessageIndices.value.length) return
  hasNavigated.value = true
  isFollowing.value = false
  lockNavigationIndex(navIndex)
  scrollToUserMessage(navIndex)
}

function clearAssistantOutline() {
  assistantOutlineMarkers.value = []
  currentAssistantOutlineIndex.value = -1
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getAssistantOutlineAnchor(marker: AssistantMessageOutlineMarker): HTMLElement | null {
  const row = getMessageRowById(marker.messageId)
  if (!row) return null
  return row.querySelector<HTMLElement>(
    `[${ASSISTANT_OUTLINE_ANCHOR_ATTR}="${escapeCssAttributeValue(marker.anchorId)}"]`,
  )
}

function getScrollerRelativeTop(target: HTMLElement, scroller: HTMLElement): number {
  const scrollerRect = scroller.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  return scroller.scrollTop + targetRect.top - scrollerRect.top
}

function areAssistantOutlinesEqual(
  previous: AssistantMessageOutlineMarker[],
  next: AssistantMessageOutlineMarker[],
): boolean {
  if (previous.length !== next.length) return false
  return previous.every((marker, index) => {
    const other = next[index]
    return marker.anchorId === other.anchorId &&
      marker.messageId === other.messageId &&
      marker.label === other.label &&
      marker.level === other.level &&
      marker.kind === other.kind
  })
}

function updateVisibleAssistantOutlineIndex() {
  if (isAssistantOutlineNavigating) return
  const scroller = messageListRef.value
  const markers = assistantOutlineMarkers.value
  if (!scroller || markers.length === 0) {
    currentAssistantOutlineIndex.value = -1
    return
  }

  const anchorY = scroller.scrollTop + scroller.clientHeight * 0.22
  let nextIndex = markers[0]?.navIndex ?? -1

  for (const marker of markers) {
    const target = getAssistantOutlineAnchor(marker)
    if (!target) continue
    const top = getScrollerRelativeTop(target, scroller)
    if (top <= anchorY + 1) {
      nextIndex = marker.navIndex
    } else {
      break
    }
  }

  currentAssistantOutlineIndex.value = nextIndex
}

function updateAssistantOutline() {
  const scroller = messageListRef.value
  if (!scroller || props.messages.length === 0) {
    clearAssistantOutline()
    return
  }

  const viewportTop = scroller.scrollTop
  const viewportBottom = viewportTop + scroller.clientHeight
  const viewportAnchor = viewportTop + scroller.clientHeight * 0.28
  let best: {
    messageId: string
    markers: AssistantMessageOutlineMarker[]
    score: number
  } | null = null

  for (const message of props.messages) {
    if (message.role !== 'assistant' || message.isStreaming) continue
    const row = getMessageRowById(message.id)
    if (!row) continue

    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (rowBottom < viewportTop || rowTop > viewportBottom) continue

    const markers = buildAssistantMessageOutlineMarkers(message.id, row)
    if (!shouldShowAssistantMessageOutline(row, scroller, markers.length)) continue

    const visiblePx = Math.max(0, Math.min(rowBottom, viewportBottom) - Math.max(rowTop, viewportTop))
    const containsAnchor = rowTop <= viewportAnchor && rowBottom >= viewportAnchor
    const anchorDistance = containsAnchor
      ? 0
      : Math.min(Math.abs(rowTop - viewportAnchor), Math.abs(rowBottom - viewportAnchor))
    const score = (containsAnchor ? 1_000_000 : 0) + visiblePx - anchorDistance * 0.25

    if (!best || score > best.score) {
      best = {
        messageId: message.id,
        markers,
        score,
      }
    }
  }

  if (!best) {
    clearAssistantOutline()
    return
  }

  if (!areAssistantOutlinesEqual(assistantOutlineMarkers.value, best.markers)) {
    assistantOutlineMarkers.value = best.markers
  }
  updateVisibleAssistantOutlineIndex()
}

function scheduleAssistantOutlineUpdate() {
  if (deferLayoutMeasurementDuringTransition()) return
  if (assistantOutlineUpdateFrame !== null) {
    cancelAnimationFrame(assistantOutlineUpdateFrame)
  }
  assistantOutlineUpdateFrame = requestAnimationFrame(() => {
    assistantOutlineUpdateFrame = null
    updateAssistantOutline()
  })
}

async function navigateToAssistantOutline(navIndex: number) {
  const marker = assistantOutlineMarkers.value.find(item => item.navIndex === navIndex)
  const scroller = messageListRef.value
  if (!marker || !scroller) return

  await nextTick()
  const target = getAssistantOutlineAnchor(marker)
  if (!target) return

  isFollowing.value = false
  scrollCoordinator.clear()
  isAssistantOutlineNavigating = true
  currentAssistantOutlineIndex.value = navIndex

  if (assistantOutlineCooldownTimer) {
    clearTimeout(assistantOutlineCooldownTimer)
  }

  const targetTop = getScrollerRelativeTop(target, scroller)
  const viewportOffset = Math.round(scroller.clientHeight * NAV_VIEWPORT_OFFSET_RATIO)
  scrollCoordinator.writeScrollTop(targetTop - viewportOffset, { behavior: 'smooth' })

  assistantOutlineCooldownTimer = setTimeout(() => {
    isAssistantOutlineNavigating = false
    updateAssistantOutline()
  }, 700)
}

function lockNavigationIndex(navIndex: number) {
  isActivelyNavigating = true
  currentUserMessageNavIndex.value = navIndex
  if (navigationCooldownTimer) {
    clearTimeout(navigationCooldownTimer)
  }
  navigationCooldownTimer = setTimeout(() => {
    isActivelyNavigating = false
    updateVisibleUserMessageIndex()
  }, 2600)
}

// Scroll to a specific user message by nav index
function scrollToUserMessage(navIndex: number) {
  const messageIndex = userMessageIndices.value[navIndex]
  if (messageIndex === undefined) return

  lockNavigationIndex(navIndex)
  isFollowing.value = false
  const messageId = props.messages[messageIndex]?.id
  if (!messageId) return
  scrollToMessage(messageId, {
    preserveNavigation: true,
    behavior: 'smooth',
    viewportOffsetRatio: NAV_VIEWPORT_OFFSET_RATIO,
    lockDurationMs: SCROLL_ANCHOR_LOCK_MS,
  })
}

function formatNavTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function buildNavMarkerLabel(message: ChatMessage, navIndex: number): string {
  const total = userMessageIndices.value.length
  const snippet = buildNavMarkerPreview(message)
  return `${navIndex + 1}/${total} ${formatNavTime(message.timestamp)} - ${snippet}`
}

function buildNavMarkerPreview(message: ChatMessage): string {
  const rawContent = typeof message.content === 'string' ? message.content : ''
  const compact = rawContent.replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, 36) : 'No text'
}

function updateNavMarkers() {
  if (userMessageIndices.value.length === 0) {
    navMarkers.value = []
    return
  }

  const total = userMessageIndices.value.length
  navMarkers.value = userMessageIndices.value.map((messageIndex, navIndex) => {
    const message = props.messages[messageIndex]
    return {
      navIndex,
      messageId: message?.id || `nav-${navIndex}`,
      seq: message?.seq,
      position: getEvenNavPosition(navIndex, total),
      label: message ? buildNavMarkerLabel(message, navIndex) : `${navIndex + 1}/${total}`,
      preview: message ? buildNavMarkerPreview(message) : `${navIndex + 1}/${total}`,
    }
  })
}

function getMessageRow(messageIndex: number): HTMLElement | null {
  return messageListContentRef.value?.querySelector<HTMLElement>(`[data-index="${messageIndex}"]`) ?? null
}

// ---- Row lookup cache ------------------------------------------------------
// `getMessageRowById` used to be one full-subtree `querySelector` per call.
// The layout-measurement passes (assistant outline, user-message measurements,
// nav markers, tail-spacer clamp) call it once per MESSAGE, and the content
// ResizeObserver runs those passes on every frame of a collapse animation —
// on a 300-message / 37k-node list that was ~300 × 1ms of selector matching
// per frame, i.e. 100–230ms long tasks for the whole 180ms a tool row took to
// expand (measured 2026-08-19). Rows are direct children of the content box,
// so one `querySelectorAll` walk builds an id → row map; a childList observer
// on the content box (no subtree) invalidates it when rows mount/unmount.
// First match wins, exactly like `querySelector` did (the outer
// `.message-list-row` carries the id before the inner `.message` does).
let messageRowCache: Map<string, HTMLElement> | null = null
let messageRowCacheContent: HTMLElement | null = null
let messageRowCacheObserver: MutationObserver | null = null
let messageRowCacheMissRebuilt = false

function invalidateMessageRowCache() {
  messageRowCache = null
}

function buildMessageRowCache(content: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  for (const el of content.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = el.dataset.messageId
    if (id && !map.has(id)) map.set(id, el)
  }
  if (messageRowCacheContent !== content) {
    messageRowCacheObserver?.disconnect()
    messageRowCacheObserver = null
    messageRowCacheContent = content
    if (typeof MutationObserver !== 'undefined') {
      messageRowCacheObserver = new MutationObserver(invalidateMessageRowCache)
      messageRowCacheObserver.observe(content, { childList: true })
    }
  }
  messageRowCache = map
  return map
}

function getMessageRowById(messageId: string): HTMLElement | null {
  const content = messageListContentRef.value
  if (!content) return null
  let map = messageRowCache && messageRowCacheContent === content ? messageRowCache : null
  if (!map) map = buildMessageRowCache(content)
  const hit = map.get(messageId)
  if (hit) {
    if (hit.isConnected) return hit
    // A row swapped under us without a childList mutation on the content box
    // (only possible for a nested match) — rebuild once and re-answer.
    map = buildMessageRowCache(content)
    return map.get(messageId) ?? null
  }
  // Miss: the row may have mounted in this very task, before the observer's
  // microtask delivered. Re-walk at most once per microtask checkpoint so a
  // loop over hidden rows (room mode) cannot degrade back to N walks.
  if (!messageRowCacheMissRebuilt) {
    messageRowCacheMissRebuilt = true
    queueMicrotask(() => { messageRowCacheMissRebuilt = false })
    map = buildMessageRowCache(content)
    return map.get(messageId) ?? null
  }
  return null
}

function getMessageSeq(message: ChatMessage | undefined): number | null {
  const seq = message?.seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
}

function getMarkerIndexForMessage(message: ChatMessage | undefined): number {
  if (!message) return -1

  const exactIndex = displayNavMarkers.value.findIndex(marker => marker.messageId === message.id)
  if (exactIndex >= 0) return exactIndex

  const seq = getMessageSeq(message)
  if (seq === null) return -1

  let markerIndex = -1
  for (let i = 0; i < displayNavMarkers.value.length; i++) {
    const markerSeq = displayNavMarkers.value[i].seq
    if (typeof markerSeq !== 'number') continue
    if (markerSeq <= seq) markerIndex = i
    else break
  }
  return markerIndex
}

function captureTopAnchor(): TopAnchor | null {
  const scroller = messageListRef.value
  const content = messageListContentRef.value
  if (!scroller || !content) return null

  const rows = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
  const viewportTop = scroller.scrollTop
  const row = rows.find(candidate => candidate.offsetTop + candidate.offsetHeight > viewportTop)
  if (!row) return null

  const messageId = row.dataset.messageId
  if (!messageId) return null

  return {
    messageId,
    offsetWithinMessage: viewportTop - row.offsetTop,
  }
}

// 历史分页已抬进 `useHistoryPagination`(去复用重构 R1),行为逐字不变;
// 房面自带滚动容器,复用的是同一份阈值与锚点还原。见文件中部的 historyPagination。

async function scrollToMessage(
  messageId: string,
  options: {
    preserveNavigation?: boolean
    behavior?: MessageScrollBehavior
    viewportOffsetRatio?: number
    lockDurationMs?: number
  } = {},
) {
  const messageIndex = props.messages.findIndex(message => message.id === messageId)
  if (messageIndex === -1) return false

  if (!options.preserveNavigation) {
    hasNavigated.value = false
  }
  isFollowing.value = false
  searchHighlightedMessageId.value = messageId
  // A folded room block has no row to scroll to; unfold before measuring.
  revealRoomRowForMessage(messageId)

  await nextTick()
  const row = getMessageRowById(messageId) || getMessageRow(messageIndex)
  const scroller = messageListRef.value
  const behavior = options.behavior ?? 'smooth'
  if (row && scroller && typeof options.viewportOffsetRatio === 'number') {
    const offsetWithinMessage = -Math.round(scroller.clientHeight * options.viewportOffsetRatio)
    scrollCoordinator.writeScrollTop(row.offsetTop + offsetWithinMessage, { behavior })
    if (behavior !== 'smooth') {
      scrollCoordinator.setAnchor(messageId, offsetWithinMessage, options.lockDurationMs)
    }
  } else if (row && scroller) {
    const offsetWithinMessage = -Math.round((scroller.clientHeight - row.offsetHeight) / 2)
    scrollCoordinator.writeScrollTop(row.offsetTop + offsetWithinMessage, { behavior })
    if (behavior !== 'smooth') {
      scrollCoordinator.setAnchor(messageId, offsetWithinMessage, options.lockDurationMs)
    }
  }

  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  searchHighlightTimer = setTimeout(() => {
    if (searchHighlightedMessageId.value === messageId) {
      searchHighlightedMessageId.value = null
    }
  }, 2600)

  return true
}

function getFallbackNavPosition(messageIndex: number): number {
  const denominator = Math.max(props.messages.length - 1, 1)
  return Math.min(0.98, Math.max(0.02, messageIndex / denominator))
}

function getEvenNavPosition(navIndex: number, total: number): number {
  if (total <= 1) return 0.5
  return (navIndex + 1) / (total + 1)
}

function setNavIndexToLastMarker() {
  currentUserMessageNavIndex.value = displayNavMarkers.value.length > 0
    ? displayNavMarkers.value.length - 1
    : -1
}

function setNavIndexToFirstMarker() {
  currentUserMessageNavIndex.value = displayNavMarkers.value.length > 0 ? 0 : -1
}

function setNavIndexToMessage(messageId: string | undefined) {
  if (!messageId) {
    setNavIndexToLastMarker()
    return
  }
  const index = displayNavMarkers.value.findIndex(marker => marker.messageId === messageId)
  currentUserMessageNavIndex.value = index >= 0 ? index : currentUserMessageNavIndex.value
}

function scheduleNavMarkerUpdate() {
  // Cancel any pending update and reschedule to ensure we use latest data
  // This fixes the issue where session switching could cause markers to disappear
  // due to RAF executing before messages are fully loaded
  if (navMarkerUpdateFrame !== null) {
    cancelAnimationFrame(navMarkerUpdateFrame)
  }
  navMarkerUpdateFrame = requestAnimationFrame(() => {
    navMarkerUpdateFrame = null
    updateNavMarkers()
  })
}

function scheduleScrollStateUpdate() {
  if (followNudgeFrame !== null) return
  followNudgeFrame = requestAnimationFrame(() => {
    followNudgeFrame = null
    updateScrollToBottomButton()
  })
}

function refreshUserMessageMeasurements() {
  const content = messageListContentRef.value
  if (!content || userMessageIndices.value.length === 0) {
    userMessageMeasurements = []
    return
  }

  userMessageMeasurements = userMessageIndices.value
    .map(messageIndex => {
      const message = props.messages[messageIndex]
      if (!message?.id) return null
      const row = getMessageRowById(message.id) || getMessageRow(messageIndex)
      if (!row) return null
      return {
        messageIndex,
        messageId: message.id,
        start: row.offsetTop,
      }
    })
    .filter((item): item is { messageIndex: number; messageId: string; start: number } => item !== null)
}

function scheduleMeasurementRefresh() {
  if (deferLayoutMeasurementDuringTransition()) return
  if (measurementRefreshFrame !== null) return
  measurementRefreshFrame = requestAnimationFrame(() => {
    measurementRefreshFrame = null
    refreshUserMessageMeasurements()
    scheduleVisibleUserMessageIndexUpdate()
  })
}

function scheduleVisibleUserMessageIndexUpdate() {
  if (deferLayoutMeasurementDuringTransition()) return
  if (visibleUserMessageFrame !== null) return
  visibleUserMessageFrame = requestAnimationFrame(() => {
    visibleUserMessageFrame = null
    updateVisibleUserMessageIndex()
  })
}

// Check if current session can create branches (only root sessions can)
const canCreateBranch = computed(() => {
  const currentSession = panelSession.value
  if (!currentSession) return false
  // Only allow branching from root sessions (no parent)
  return !currentSession.parentSessionId
})

// Compute branches for each message
// Returns a map of messageId -> branches created from that message
const messageBranches = computed(() => {
  const branchMap = new Map<string, BranchInfo[]>()
  const currentSession = panelSession.value
  if (!currentSession) return branchMap

  // Find all sessions that branched from the current session
  for (const session of sessionsStore.sessions) {
    if (session.parentSessionId === currentSession.id && session.branchFromMessageId) {
      const branches = branchMap.get(session.branchFromMessageId) || []
      branches.push({
        id: session.id,
        name: session.name
      })
      branchMap.set(session.branchFromMessageId, branches)
    }
  }

  return branchMap
})

// Get branches for a specific message
function getBranchesForMessage(messageId: string): BranchInfo[] {
  return messageBranches.value.get(messageId) ?? EMPTY_BRANCHES
}

// Find which user message is currently most visible in the viewport
function updateVisibleUserMessageIndex(options: { allowAnchored?: boolean } = {}) {
  if (isActivelyNavigating) return
  if (!options.allowAnchored && scrollCoordinator.isAnchored()) return
  if (props.messages.length === 0) return

  const el = messageListRef.value
  if (!el) return

  if (el.scrollTop <= 24) {
    setNavIndexToFirstMarker()
    return
  }

  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distanceToBottom < 96 || isFollowing.value) {
    setNavIndexToLastMarker()
    return
  }

  // A chat node represents a user turn, so assistant content belongs to the
  // most recent user message above the viewport anchor.
  const viewportAnchor = el.scrollTop + el.clientHeight * 0.18

  let activeMessageIndex = 0
  const measurements = userMessageMeasurements
  if (measurements.length > 0) {
    for (const measurement of measurements) {
      if (measurement.start <= viewportAnchor) activeMessageIndex = measurement.messageIndex
      else break
    }
  } else {
    for (const msgIdx of userMessageIndices.value) {
      const start = getFallbackNavPosition(msgIdx) * Math.max(1, el.scrollHeight)

      if (start <= viewportAnchor) activeMessageIndex = msgIdx
      else break
    }
  }

  const activeMessage = props.messages[activeMessageIndex]
  const markerIndex = getMarkerIndexForMessage(activeMessage)
  if (markerIndex >= 0) {
    currentUserMessageNavIndex.value = markerIndex
  }
}

function handleScroll() {
  follow.checkReattach()
  const el = messageListRef.value
  if (el) {
    // Detect user-initiated scrolls that bypass wheel/pointerdown
    // (custom scrollbar thumb drag, PageUp/Home, keyboard scroll, etc.)
    scrollCoordinator.detectExternalScroll(el)
    
    const isAtTail = el.scrollHeight - el.scrollTop - el.clientHeight <= 2
    // Only set tail mode when at the true end of the conversation,
    // not at the bottom of a partial window (hasMoreAfter=true).
    // Otherwise tail mode would snap the viewport to the window's
    // bottom on every content-height change, creating a cascade
    // that flings the user to the real bottom.
    const isRealTail = !pageState.value?.hasMoreAfter
    if (isAtTail && isRealTail && !scrollCoordinator.isAnchored() && (hasActiveStream.value ? isFollowing.value : true)) {
      scrollCoordinator.setTail()
    }
  }
  updateScrollToBottomButton()
  scheduleReadingAnchorCapture()
  scheduleNavMarkerUpdate()
  scheduleAssistantOutlineUpdate()
  scheduleVisibleUserMessageIndexUpdate()
  loadOlderHistoryIfNeeded()
  loadNewerHistoryIfNeeded()
}

function handleWheel(event: WheelEvent) {
  scrollCoordinator.clear()
  follow.onWheel(event)
}

function handlePointerDown() {
  scrollCoordinator.clear()
}

// Track permission request cleanup function

// Get the first actionable permission request. 「可应答」的谓词只有一份
// (`findRespondableToolCall`),这里与 `findPendingPermission` 共用它;这里多留
// 的只是 message —— 审批卡要挂在哪条消息下面。
const currentPendingPermission = computed<{ message: ChatMessage; toolCall: ToolCall } | null>(() => {
  for (const message of props.messages) {
    const pendingToolCall = findRespondableToolCall(message)
    if (pendingToolCall) {
      return { message, toolCall: pendingToolCall }
    }
  }
  return null
})

// Setup keyboard shortcuts for permission confirmation
// Enter = allow current tool, D/Escape = reject
usePermissionShortcuts(
  () => props.permissionShortcuts && !!currentPendingPermission.value && !showRejectDialog.value,
  {
    onAllow: () => {
      const pending = currentPendingPermission.value
      if (pending) {
        handleConfirmTool(pending.toolCall, 'once')
      }
    },
    onReject: () => {
      const pending = currentPendingPermission.value
      if (pending) {
        openRejectDialog(pending.toolCall)
      }
    },
  }
)

// handlePermissionRequest is now in the chat store (called by IPC Hub)
// The store's handlePermissionRequest() updates messages reactively.

async function scrollToBottomFromButton() {
  const sessionId = effectiveSessionId.value
  setNavIndexToLastMarker()
  follow.isFollowing.value = true
  
  // If we're viewing a truncated window, reload from the tail so the
  // user sees actual latest messages instead of a partial window.
  if (sessionId && pageState.value?.hasMoreAfter) {
    scrollCoordinator.clear()
    await chatStore.loadInitialMessagePage(sessionId)
    await nextTick()
  }
  
  scrollCoordinator.setTail({ behavior: 'smooth' })
}

let attachedMessageListElement: HTMLElement | null = null

function syncMessageListScroller() {
  const scroller = messageScrollbarRef.value?.getScrollElement() ?? null
  messageListRef.value = scroller
  return scroller
}

function attachMessageListListeners() {
  const scroller = syncMessageListScroller()
  if (!scroller || attachedMessageListElement === scroller) return

  detachMessageListListeners()
  attachedMessageListElement = scroller
  scroller.addEventListener('scroll', handleScroll)
  scroller.addEventListener('wheel', handleWheel, { passive: false })
  scroller.addEventListener('pointerdown', handlePointerDown)

  if (typeof ResizeObserver !== 'undefined') {
    navResizeObserver = new ResizeObserver(() => {
      if (deferLayoutMeasurementDuringTransition()) return
      scheduleNavMarkerUpdate()
      scheduleNavPanelRoomUpdate()
      scheduleAssistantOutlineUpdate()
      scheduleMeasurementRefresh()
    })
    navResizeObserver.observe(scroller)
  }
  attachReadingAnchorObserver(scroller)
}

function detachMessageListListeners() {
  if (!attachedMessageListElement) return

  attachedMessageListElement.removeEventListener('scroll', handleScroll)
  attachedMessageListElement.removeEventListener('wheel', handleWheel)
  attachedMessageListElement.removeEventListener('pointerdown', handlePointerDown)
  attachedMessageListElement = null
  navResizeObserver?.disconnect()
  navResizeObserver = null
  detachReadingAnchorObserver()
}

// Setup event listeners
onMounted(() => {
  document.addEventListener('selectionchange', handleSelectionChange)
  nextTick(() => {
    attachMessageListListeners()

    // Scroll to bottom on initial mount (messages may be pre-loaded in store)
    const snapshot = effectiveSessionId.value ? chatStore.getSnapshot(effectiveSessionId.value) : null
    if (props.messages.length > 0 && messageListRef.value && snapshot?.mode !== 'anchor') {
      scrollCoordinator.setTail()
    }
    scheduleNavMarkerUpdate()
    scheduleNavPanelRoomUpdate()
    scheduleAssistantOutlineUpdate()
    scheduleMeasurementRefresh()
  })
})

watch(
  () => props.layoutTransitioning,
  (isTransitioning, wasTransitioning) => {
    if (isTransitioning) {
      cancelPendingLayoutMeasurementFrames()
      deferredLayoutMeasurementRefresh = true
      if (deferredLayoutMeasurementTimer) {
        clearTimeout(deferredLayoutMeasurementTimer)
        deferredLayoutMeasurementTimer = null
      }
      if (deferredLayoutMeasurementFollowupTimer) {
        clearTimeout(deferredLayoutMeasurementFollowupTimer)
        deferredLayoutMeasurementFollowupTimer = null
      }
      return
    }

    if (!wasTransitioning || !deferredLayoutMeasurementRefresh) return
    deferredLayoutMeasurementRefresh = false
    if (deferredLayoutMeasurementTimer) {
      clearTimeout(deferredLayoutMeasurementTimer)
    }
    deferredLayoutMeasurementTimer = setTimeout(() => {
      deferredLayoutMeasurementTimer = null
      requestAnimationFrame(() => {
        scheduleNavMarkerUpdate()
        updateScrollToBottomButton()
        if (deferredLayoutMeasurementFollowupTimer) {
          clearTimeout(deferredLayoutMeasurementFollowupTimer)
        }
        deferredLayoutMeasurementFollowupTimer = setTimeout(() => {
          deferredLayoutMeasurementFollowupTimer = null
          if (props.layoutTransitioning) {
            deferredLayoutMeasurementRefresh = true
            return
          }
          requestAnimationFrame(() => {
            scheduleNavPanelRoomUpdate()
            scheduleAssistantOutlineUpdate()
            scheduleMeasurementRefresh()
            if (!scrollCoordinator.isAnchored()) {
              scheduleVisibleUserMessageIndexUpdate()
            }
          })
        }, 80)
      })
    }, 700)
  },
)

onUnmounted(() => {
  if (rowsSkippableFrame !== null) {
    cancelAnimationFrame(rowsSkippableFrame)
    rowsSkippableFrame = null
  }
  messageRowCacheObserver?.disconnect()
  messageRowCacheObserver = null
  messageRowCache = null
  messageRowCacheContent = null
  document.removeEventListener('selectionchange', handleSelectionChange)
  if (deferredLayoutMeasurementTimer) {
    clearTimeout(deferredLayoutMeasurementTimer)
    deferredLayoutMeasurementTimer = null
  }
  if (deferredLayoutMeasurementFollowupTimer) {
    clearTimeout(deferredLayoutMeasurementFollowupTimer)
    deferredLayoutMeasurementFollowupTimer = null
  }
  detachMessageListListeners()
  if (navigationCooldownTimer) {
    clearTimeout(navigationCooldownTimer)
  }
  if (searchHighlightTimer) {
    clearTimeout(searchHighlightTimer)
    searchHighlightTimer = null
  }
  cancelPendingLayoutMeasurementFrames()
  if (followNudgeFrame !== null) {
    cancelAnimationFrame(followNudgeFrame)
    followNudgeFrame = null
  }
  if (assistantOutlineCooldownTimer) {
    clearTimeout(assistantOutlineCooldownTimer)
    assistantOutlineCooldownTimer = null
  }
  scrollCoordinator.clear()
  if (navResizeObserver) {
    navResizeObserver.disconnect()
    navResizeObserver = null
  }
  if (navContentResizeObserver) {
    navContentResizeObserver.disconnect()
    navContentResizeObserver = null
  }
  detachReadingAnchorObserver()
})


// 切会话 / 消息刚加载完时,让待审批账本对一次账(架构收敛 C4 §5)。
//
// 这里从前是一段组件内直查 `getPendingPermissions` + 一段手写投影:组件自己认识
// prompt 的形状,自己决定 queued 走哪个 handler。于是补水与事件是两条路,而"切回
// 一个正在等审批的会话"是唯一能把两条路的分歧照出来的场景。现在只说一句"这个会话
// 上屏了",拉取、去序与投影全归账本。
//
// 两个触发边保持原样:会话变了,或者消息刚从 0 变成非 0 —— 投影要落到 toolCall 上,
// 消息没到就没有落点(queued 在找不到 toolCall 时是丢弃而不是缓存的)。
watch(
  [effectiveSessionId, () => props.messages.length],
  async ([newSessionId, msgCount], [oldSessionId, oldMsgCount]) => {
    if (!newSessionId) return

    const sessionChanged = newSessionId !== oldSessionId
    const messagesJustLoaded = oldMsgCount === 0 && msgCount > 0

    if (!sessionChanged && !messagesJustLoaded) return
    if (msgCount === 0) return  // Messages not loaded yet, wait

    await collabBoardStore.ensurePendingForSession(newSessionId)
  },
  { immediate: true }
)

// Nav marker update on density/font changes
watch(
  [messageListDensity, customLineHeight, chatFontSize],
  () => {
    nextTick(() => {
      scheduleNavMarkerUpdate()
      scheduleAssistantOutlineUpdate()
    })
  }
)

// --- Long-tail chat font preload ---
// Phase C covers the high-frequency CJK sample at startup, but historical
// messages with rare characters hit woff2 subsets that weren't preloaded.
// This watcher fires once per session-load and triggers document.fonts.load()
// with the actual visible message text, shrinking the swap window for those
// remaining subsets. We don't gate rendering — deferred swap for rare chars
// is acceptable and hiding text would introduce perceptible first-paint delay.

/** Track which session we've already preloaded, so we only fire once per load */
const fontPreloadSessionId = ref<string | null>(null)

/** Extract up to `maxChars` unique non-ASCII characters from the given messages */
function extractCjkSample(messages: ChatMessage[], maxChars = 300): string {
  const seen = new Set<string>()
  const chars: string[] = []
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : ''
    for (const ch of text) {
      if (chars.length >= maxChars) break
      // Skip ASCII (unicode <= 0x7F) — those glyphs are always in the Latin subset
      if (ch.charCodeAt(0) <= 0x7f) continue
      if (seen.has(ch)) continue
      seen.add(ch)
      chars.push(ch)
    }
    if (chars.length >= maxChars) break
  }
  return chars.join('')
}

watch(
  [effectiveSessionId, () => props.messages.length],
  ([sessionId, msgCount]) => {
    if (!sessionId || msgCount === 0) return
    if (fontPreloadSessionId.value === sessionId) return
    if (typeof document === 'undefined' || !document.fonts) return
    fontPreloadSessionId.value = sessionId

    // Use last N messages (visible range) instead of all to stay cheap
    const visibleCount = Math.min(msgCount, 20)
    const visibleMessages = props.messages.slice(-visibleCount)
    const sample = extractCjkSample(visibleMessages)
    if (!sample) return

    const specs = buildFontLoadSpecs(chatFontEn.value, chatFontZh.value)
    for (const { spec } of specs) {
      document.fonts.load(spec, sample).catch(() => null)
    }
  },
  { immediate: true },
)


// Handle edit message event - emit to parent for immediate stop button response
function handleEdit(messageId: string, newContent: string) {
  emit('editAndResend', messageId, newContent)
}

// Handle branch creation event
async function handleBranch(messageId: string, quotedText?: string) {
  const currentSession = panelSession.value
  if (!currentSession) return

  // Create the branch
  const branchSession = await sessionsStore.createBranch(currentSession.id, messageId)

  if (branchSession) {
    // Check setting for split screen behavior
    const splitEnabled = settingsStore.settings.chat?.branchOpenInSplitScreen ?? true
    if (splitEnabled) {
      // Emit event to open branch in split view
      emit('splitWithBranch', branchSession.id)
    } else {
      // Just switch to the branch session
      await sessionsStore.switchSession(branchSession.id)
    }
  }

  // If we have quoted text, we need to pass it to InputBox
  // We'll emit this to the parent so it can handle setting the quoted text
  if (quotedText) {
    emit('setQuotedText', quotedText)
  }
}

// Handle go to branch event
async function handleGoToBranch(sessionId: string) {
  await sessionsStore.switchSession(sessionId)
}

// Handle quote text event
function handleQuote(quotedText: string) {
  emit('setQuotedText', quotedText)
}

// ============ Selection toolbar (single instance for the list) ============
const selectionToolbarVisible = ref(false)
const selectionToolbarText = ref('')
/** The selection's box; the toolbar hands it to the floating kernel as a
 *  virtual anchor, so nothing here computes coordinates any more (P6). */
const selectionToolbarAnchor = ref<AnchorRect | null>(null)
const selectionMessageId = ref<string | null>(null)

function handleTextSelection(messageId: string, text: string, rect: AnchorRect) {
  selectionMessageId.value = messageId
  selectionToolbarText.value = text
  selectionToolbarAnchor.value = rect
  selectionToolbarVisible.value = true
}

function hideSelectionToolbar() {
  selectionToolbarVisible.value = false
}

function handleSelectionQuote(text: string) {
  handleQuote(text)
  hideSelectionToolbar()
}

async function handleSelectionBranch(text: string) {
  if (!canCreateBranch.value || !selectionMessageId.value) return
  hideSelectionToolbar()
  await handleBranch(selectionMessageId.value, text)
}

// 外点关闭已交给浮层内核(SelectionToolbar 的 Popover),这里只留语义那一半:
// 选区本身没了,工具条就没有操作对象 —— 内核看不到这件事。
function handleSelectionChange() {
  if (!selectionToolbarVisible.value) return
  const text = window.getSelection()?.toString().trim()
  if (!text) {
    hideSelectionToolbar()
  }
}

function handleRegenerate(messageId: string) {
  emit('regenerate', messageId)
}

function handleSuggestion(text: string) {
  emit('setInputText', text)
}

// Handle tool execution
async function handleExecuteTool(toolCall: ExecutableToolCall) {
  const currentSession = panelSession.value
  if (!currentSession) return

  // Find the message containing this tool call
  const message = props.messages.find(m =>
    m.toolCalls?.some(tc => tc.id === toolCall.id)
  )
  const tc = message?.toolCalls?.find(t => t.id === toolCall.id)

  // Record start time
  const startTime = Date.now()
  if (!platformApi.capabilities.shellTools) {
    const error = 'Tool execution is not available in this host.'
    const endTime = Date.now()
    if (tc) {
      tc.endTime = endTime
      tc.status = 'failed'
      tc.error = error
    }
    if (message) {
      await platformApi.updateToolCall(currentSession.id, message.id, toolCall.id, {
        status: 'failed',
        startTime,
        endTime,
        error,
      })
    }
    return
  }

  if (tc) {
    tc.status = 'executing'
    tc.startTime = startTime
  }

  try {
    // Deep clone to unwrap all Vue reactive proxies - IPC cannot serialize Proxy objects
    const rawArguments = JSON.parse(JSON.stringify(toRaw(toolCall.arguments) || {}))
    const result = await platformApi.executeTool(
      toolCall.toolId,
      rawArguments,
      toolCall.id,
      currentSession.id
    )

    // Record end time and update status
    const endTime = Date.now()
    if (tc) {
      tc.endTime = endTime
      tc.status = result.success ? 'completed' : 'failed'
      tc.result = result.result
      tc.error = result.error
    }

    // Persist to backend
    if (message) {
      await platformApi.updateToolCall(currentSession.id, message.id, toolCall.id, {
        status: result.success ? 'completed' : 'failed',
        startTime,
        endTime,
        result: result.result,
        error: result.error,
      })
    }
  } catch (error) {
    log.error('tool execute failed', {}, error)
    const endTime = Date.now()
    if (tc) {
      tc.endTime = endTime
      tc.status = 'failed'
      tc.error = String(error)
    }

    // Persist to backend
    if (message) {
      await platformApi.updateToolCall(currentSession.id, message.id, toolCall.id, {
        status: 'failed',
        startTime,
        endTime,
        error: String(error),
      })
    }
  }
}

// Handle tool confirmation (for permission-gated tool calls).
// 应答本身(sessionCommands.emit + 本地收尾)已抬进 `usePermissionResponder`,房面与这里
// 共用同一份 —— 见去复用重构 R1 §8 铁律 1。
const { confirmTool: handleConfirmTool, rejectTool: handleRejectTool } = usePermissionResponder({
  getSessionId: () => panelSession.value?.id,
  getMessages: () => props.messages,
})

// Open the reject reason dialog
function openRejectDialog(toolCall: PermissionToolCall) {
  pendingRejectToolCall.value = toolCall
  showRejectDialog.value = true
}

// Confirm rejection with reason
function confirmReject(reason?: string) {
  if (pendingRejectToolCall.value) {
    void handleRejectTool(pendingRejectToolCall.value, reason)
  }
  cancelReject()
}

// Cancel the reject dialog
function cancelReject() {
  showRejectDialog.value = false
  pendingRejectToolCall.value = null
}

// Handle updating thinking time for a message
async function handleUpdateThinkingTime(messageId: string, thinkingTime: number) {
  const currentSession = panelSession.value
  if (!currentSession) return

  try {
    // Update local message
    const message = props.messages.find(m => m.id === messageId)
    if (message) {
      message.thinkingTime = thinkingTime
    }

    // Persist to backend
    await platformApi.updateMessageThinkingTime(currentSession.id, messageId, thinkingTime)
  } catch (error) {
    log.error('thinking time update failed', { messageId }, error)
  }
}

// ============ Snapshot API for session switching ============

function finishSessionSwitchFromViewport() {
  follow.finishSwitch()
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = messageListRef.value
      if (!el) return
      isFollowing.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 2
      scheduleMeasurementRefresh()
      scheduleVisibleUserMessageIndexUpdate()
      scheduleNavMarkerUpdate()
      scheduleAssistantOutlineUpdate()
      updateScrollToBottomButton()
    })
  })
}

defineExpose({
  confirmTool: (toolCall: ToolCall, response: PermissionResponse = 'once') => handleConfirmTool(toolCall, response),
  rejectTool: (toolCall: ToolCall, reason?: string) => {
    if (reason) {
      void handleRejectTool(toolCall, reason)
    } else {
      openRejectDialog(toolCall)
    }
  },
  getIsFollowing: () => follow.isFollowing.value,
  getDistanceToBottom: () => {
    const el = messageListRef.value
    if (!el) return 0
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
  },
  getHasNavigated: () => hasNavigated.value,
  getAnchorMessageId: () => captureTopAnchor()?.messageId ?? null,
  getAnchorOffset: () => captureTopAnchor()?.offsetWithinMessage ?? 0,
  getNavMessageId: () => displayNavMarkers.value[currentUserMessageNavIndex.value]?.messageId ?? null,
  notifyLayoutChange: () => {
    absorbComposerCollapseForSend()
    scheduleFollowNudge('composer-resize')
    updateScrollToBottomButton()
  },

  prepareForSend,

  prepareForSwitch: () => {
    scrollCoordinator.clear()
    releaseHoldTop()
    setTailSpacerHeight(0)
    follow.prepareForSwitch()
  },

  holdForRegenerate,

  finishSwitch: finishSessionSwitchFromViewport,

  restoreTail: () => {
    scrollCoordinator.clear()
    releaseHoldTop()
    setTailSpacerHeight(0)
    hasNavigated.value = false
    setNavIndexToLastMarker()
    follow.isFollowing.value = true
    scrollCoordinator.setTail()
    follow.finishSwitch()
    updateScrollToBottomButton()
  },

  restoreAnchor: (snap: {
    anchorMessageId?: string
    offsetWithinMessage?: number
    navMessageId?: string
    hasNavigated: boolean
  }) => {
    hasNavigated.value = snap.hasNavigated
    setNavIndexToMessage(snap.navMessageId)
    follow.isFollowing.value = false
    const restoreSessionId = effectiveSessionId.value

    const applyAnchor = () => {
      if (!restoreSessionId || effectiveSessionId.value !== restoreSessionId) {
        follow.finishSwitch()
        return true
      }
      const row = snap.anchorMessageId ? getMessageRowById(snap.anchorMessageId) : null
      if (!row || !messageListRef.value) return false

      const offsetWithinMessage = Math.max(0, snap.offsetWithinMessage ?? 0)
      scrollCoordinator.writeScrollTop(row.offsetTop + offsetWithinMessage)
      refreshUserMessageMeasurements()
      updateVisibleUserMessageIndex({ allowAnchored: true })
      if (snap.anchorMessageId) {
        scrollCoordinator.setAnchor(snap.anchorMessageId, offsetWithinMessage, SESSION_RESTORE_ANCHOR_LOCK_MS)
      }
      follow.finishSwitch()
      updateScrollToBottomButton()
      return true
    }

    if (applyAnchor()) return

    nextTick(async () => {
      if (!applyAnchor()) {
        scrollCoordinator.clear()
        hasNavigated.value = false
        setNavIndexToLastMarker()
        follow.isFollowing.value = true
        scrollCoordinator.setTail()
        follow.finishSwitch()
        updateScrollToBottomButton()
      }
    })
  },

  scrollToBottom: () => {
    setNavIndexToLastMarker()
    follow.isFollowing.value = true
    scrollCoordinator.setTail({ behavior: 'smooth' })
  },

  scrollToMessage,
})
</script>

<style scoped>
.message-list-wrapper {
  --chat-scroll-safe-gap: var(
    --chat-composer-safe-gap,
    max(calc(var(--content-spacing-px, 8px) * 3), calc(var(--message-line-height-px, 20px) * 1.25))
  );
  --chat-scroll-tail-reserve: var(--chat-scroll-safe-gap);
  --chat-scroll-top-reserve: max(
    calc(var(--content-spacing-px, 8px) * 1.25),
    calc(var(--message-line-height-px, 20px) * 0.65)
  );
  --scroll-bottom-button-offset: var(--chat-scroll-safe-gap);

  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  min-height: 0;
  container-type: inline-size;
  overflow: visible;
}

/* 失败痕迹:一行墨灰,贴在列表底边,不做卡片不做图标(§3.6)。 */
.room-action-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px 10px;
  font-size: 11px;
  text-align: center;
  color: var(--ui-text-muted-fg);
  pointer-events: none;
}

/* Paper-ink, flat: an ink hairline ring on solid paper. Elevation (drop
   shadow + backdrop blur) was the one "floating plastic" element in an
   otherwise line-drawn surface. */
.scroll-to-bottom-btn {
  position: absolute;
  left: 50%;
  bottom: var(--scroll-bottom-button-offset);
  transform: translateX(-50%) translateY(50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 55%, transparent);
  background: var(--ui-surface-chat-bg);
  color: color-mix(in srgb, var(--ui-text-secondary-fg) 78%, transparent);
  cursor: pointer;
  opacity: 0.7;
  transition: background var(--duration-normal) var(--ease-default), transform var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default);
  z-index: 4;
}

.scroll-to-bottom-btn:hover {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
  opacity: 1;
}

.scroll-to-bottom-btn:active {
  transform: translateX(-50%) translateY(50%) scale(0.94);
}

.scroll-bottom-btn-enter-active,
.scroll-bottom-btn-leave-active {
  transition: opacity var(--duration-normal) var(--ease-default), transform var(--duration-normal) var(--ease-default);
}
.scroll-bottom-btn-enter-from,
.scroll-bottom-btn-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(50%) translateY(6px);
}

.message-list {
  flex: 1;
  overflow-anchor: auto;
  padding: 0;
  background: transparent;
  position: relative;
}

.message-list-content {
  position: relative;
  width: var(--chat-content-width, var(--content-measure, 46rem));
  margin: 0 auto;
  padding-top: var(--chat-scroll-top-reserve);
  padding-bottom: var(--chat-scroll-tail-reserve);
}

.message-list-content.message-list-content--empty {
  height: 0;
  min-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
  pointer-events: none;
  overflow-anchor: none;
}

.history-page-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  max-width: 100%;
  min-height: 28px;
  margin: 0 auto 14px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--ui-border-default-border) 64%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-surface-elevated-bg) 84%, transparent);
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-meta-size);
  line-height: var(--type-leading-control);
  overflow-anchor: none;
  transition: border-color var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default), background var(--duration-normal) var(--ease-default);
}

/* 底**不**迁 `--ui-state-hover-accent-bg`:这颗药丸的静息面自己就是手写的
   `elevated 84%` 半透明(2486 行),而 token 以 panel 面解析成实色 —— 18 主题里有
   4 个(after-rain-night / gruvbox-dark / nord / tokyo-night,都在各自的自然深色
   模式)token 与这颗药丸的静息面只差 ΔRGB 2.8–4.0,hover 会**看不见**(现状 10.6–17.5)。
   要归位得先让静息面归位,不是单迁 hover 能解决的。 */
.history-page-summary:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ui-accent-primary-fg) 36%, var(--ui-border-default-border));
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 8%, var(--ui-surface-elevated-bg));
  color: var(--ui-accent-primary-fg);
}

.history-page-summary:disabled {
  cursor: default;
  opacity: 0.72;
}

.message-list-row {
  width: 100%;
  overflow-anchor: none;
  /* Records each row's last rendered size (see rowsSkippable): with the row
     skipped, its remembered box stands in, so nothing above or below moves. */
  contain-intrinsic-size: auto 240px;
}

/* Off-screen rows opt out of layout / paint work (2026-08-19). Expanding a
   tool row mid-list used to re-run pre-paint over every row below it on each
   animation frame — the last of the "tool expand stutters" causes once the
   selector storm was gone. The class arrives one frame AFTER any row set
   change (see rowsSkippable), so every row has been laid out at full size
   once and its remembered size is exact; without that, a never-rendered row
   would stand in with the 240px estimate and shove content when it later
   rendered — with `overflow-anchor: none` on the rows nobody would
   compensate. */
.message-list-content.rows-skippable .message-list-row {
  content-visibility: auto;
  /* `auto` brings paint containment: anything painted outside the row's box
     is clipped. The only such paint is the navigation highlight glow around a
     bubble (up to 20px). Widen the paint box without moving the content box:
     symmetric padding cancelled by margin. */
  padding-inline: 24px;
  margin-inline: -24px;
  /* The global reset is border-box, under which the padding would eat 48px
     of the row's content width and every line would rewrap each time the
     class toggles. content-box keeps `width: 100%` as the content width. */
  box-sizing: content-box;
}

/* ── Room (kind='room') gap table ── docs/design/multi-agent-collab-im.md §3.6
   (W15, 2026-07-28: "message 之间的间隔没有固定,看起来很混乱")

   FOUR bands, and nothing in a room stream is allowed to be spaced by anything
   else. Values are the 8px grid the chat already stands on (the comfortable
   density's 34px turn gap rounds to 32; the stacked 8px stays):

     turn     32px  组间 — 换发言人 / 用户↔agent / 组边界 / 任何新一组
     stack     8px  组内 — 同一 agent 的连发
     notice   32px  系统通知痕迹行的上下(W15b 从 24 提档,见下方注释)
     capsule  40px  时间胶囊的上下(真正的断点,值得更多空气)

   INSIDE a row there is exactly one more number, and it is not a band: the
   4px rhythm `.message-content-wrapper` stacks a message's own parts on
   (signature → quote → attachments → frame → reaction chips). W15c: every one
   of those parts is a FLEX item, so a margin of its own does not collapse
   into that gap — it ADDS. MessageItem now zeroes all of them, both sides of
   the room, so a message's height is its content and never a hidden band.

   ONE rule makes them hold: **a gap is owned by the row below it**, as a
   margin-top, and every component in the stream contributes zero of its own
   (MessageItem zeroes its turn padding via `.is-room-row`, the capsule and the
   page-summary pill are zeroed here). Two adjacent margins in a block flow
   collapse to the larger, and every bottom is 0, so the collapsed value is
   always exactly the band — no addition, no density drift, no per-component
   surprise. The two `+` rules give the notice and the capsule their BELOW gap,
   which is the only case where a row's band has to reach past itself.

   P1-2 (folding): a folded utterance block's rows are REMOVED from the DOM, not
   hidden. Those two `+` rules — and `> * + *` itself — still match a
   display:none sibling, so v-show would leave a phantom band above whatever
   came next; the table only stays honest if the row is actually gone. */
.message-list.is-room {
  --room-gap-turn: 32px;
  --room-gap-stack: 8px;
  /* 32, not 24: this band hosts the 24px hover action row (真机实锤"距离
     action bar 太近"), and every band that can host it must leave ≥8px of
     air — same clearance the 32px turn band gives. */
  --room-gap-notice: 32px;
  --room-gap-capsule: 40px;
}

/* Default band + the blanket ban on component-owned bottoms. */
.message-list.is-room .message-list-content > * {
  margin-top: var(--room-gap-turn);
  margin-bottom: 0;
}

.message-list.is-room .message-list-content > .room-row--stacked {
  margin-top: var(--room-gap-stack);
}

.message-list.is-room .message-list-content > .room-row--notice {
  margin-top: var(--room-gap-notice);
}

.message-list.is-room .message-list-content > .room-time-capsule {
  margin-top: var(--room-gap-capsule);
}

/* The below side of the two rows whose band is symmetric. A stacked row can
   never follow either of them (both break the group in room-grouping.ts), so
   these never fight the stack band. */
.message-list.is-room .message-list-content > .room-row--notice + * {
  margin-top: var(--room-gap-notice);
}

/* W14b thinking trace: it opens a turn, so its own band is the turn band and
   what follows it — the first thing that agent actually SAID — takes the stack
   band. Without the second rule one turn would cost two full 32px gaps for what
   the reader experiences as a single utterance. Declared before the capsule's
   own-band rule below so a capsule after a trace still wins its 40px. */
.message-list.is-room .message-list-content > .room-row--trace {
  margin-top: var(--room-gap-turn);
}

.message-list.is-room .message-list-content > .room-row--trace + * {
  margin-top: var(--room-gap-stack);
}

.message-list.is-room .message-list-content > .room-time-capsule + * {
  margin-top: var(--room-gap-capsule);
}

/* …and the capsule's OWN band outranks whatever precedes it: a notice ten
   minutes before the next message must not shrink the break that follows it.
   Same specificity as the rules above, declared after them, so it wins. */
.message-list.is-room .message-list-content > * + .room-time-capsule {
  margin-top: var(--room-gap-capsule);
}

/* Neither end of the stream owns a gap: the scroller's reserves do. */
.message-list.is-room .message-list-content > *:first-child,
.message-list.is-room .message-list-content > .message-list-bottom-sentinel {
  margin-top: 0;
}

.message-list-bottom-sentinel {
  width: 100%;
  height: 1px;
  pointer-events: none;
  overflow-anchor: none;
}

/* Hold-top: the coordinator drives the position; the browser must not. */
.message-list.is-holding-top :deep(.scrollbar-viewport) {
  overflow-anchor: none;
}

.message-list-tail-spacer {
  width: 100%;
  height: 0;
  pointer-events: none;
  overflow-anchor: none;
}

.message-list.stream-following .message-list-bottom-sentinel {
  overflow-anchor: auto;
}

/* Message list density modes */
.message-list.density-compact {
  --chat-turn-gap: 24px;
  --message-gap: 4px;
  --message-padding: 8px 12px;
  --message-font-size: var(--type-chat-compact-size);
  --message-line-height: var(--type-chat-compact-line-height);
  --message-line-height-px: var(--type-chat-compact-line-height-px);
  --avatar-size: 24px;
  --content-spacing: 0.4em;
  --content-spacing-px: 6px;
  --content-paragraph-gap: 7px;
  --content-list-gap: 6px;
  --content-list-item-gap: 2px;
  --content-heading-top-gap: 8px;
  --content-heading-bottom-gap: 3px;
  --content-heading-line-height-px: 18px;
  gap: 6px;
  padding: 0;
}

.message-list.density-comfortable {
  --chat-turn-gap: 34px;
  --message-gap: 10px;
  --message-padding: 14px 18px;
  --message-font-size: var(--type-chat-comfortable-size);
  --message-line-height: var(--type-chat-comfortable-line-height);
  --message-line-height-px: var(--type-chat-comfortable-line-height-px);
  --avatar-size: 32px;
  --content-spacing: 0.75em;
  --content-spacing-px: 12px;
  --content-paragraph-gap: 9px;
  --content-list-gap: 8px;
  --content-list-item-gap: 2px;
  --content-heading-top-gap: 14px;
  --content-heading-bottom-gap: 5px;
  --content-heading-line-height-px: 22px;
  gap: 14px;
  padding: 0;
}

.message-list.density-spacious {
  --chat-turn-gap: 44px;
  --message-gap: 16px;
  --message-padding: 18px 24px;
  --message-font-size: var(--type-chat-spacious-size);
  --message-line-height: var(--type-chat-spacious-line-height);
  --message-line-height-px: var(--type-chat-spacious-line-height-px);
  --avatar-size: 40px;
  --content-spacing: 1em;
  --content-spacing-px: 16px;
  --content-paragraph-gap: 8px;
  --content-list-gap: 6px;
  --content-list-item-gap: 2px;
  --content-heading-top-gap: 9px;
  --content-heading-bottom-gap: 3px;
  --content-heading-line-height-px: 21px;
  gap: 24px;
  padding: 0;
}
/* Responsive styles */
@media (max-width: 768px) {
  .message-list {
    padding: 0;
    gap: 12px;
  }

  .thinking-indicator {
    padding: 14px 16px;
    border-radius: 14px;
  }

}

@container (max-width: 560px) {
  .assistant-nav-rail,
  .user-nav-rail {
    display: none;
  }

  .scroll-to-bottom-btn {
    bottom: var(--scroll-bottom-button-offset);
  }
}

@media (max-width: 480px) {
  .message-list {
    padding: 0;
    gap: 10px;
  }

  .empty-title {
    font-size: var(--type-display-size);
  }

  .empty-subtitle {
    font-size: var(--type-body-size);
  }

  .thinking-indicator {
    padding: 12px 14px;
    border-radius: 12px;
  }

  .thinking-avatar {
    width: 28px;
    height: 28px;
  }

  .thinking-avatar svg {
    width: 16px;
    height: 16px;
  }

}

</style>
