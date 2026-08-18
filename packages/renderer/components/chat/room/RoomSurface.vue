<template>
  <div class="room-surface">
    <Scrollbar
      ref="scrollbarRef"
      class="room-flow"
      :class="{ 'stream-following': useBottomScrollAnchor }"
      :style="flowStyles"
    >
      <div
        ref="flowContentRef"
        class="room-flow-content"
      >
        <Button
          v-if="pageHistorySummary"
          unstyled
          class="room-history-summary"
          native-type="button"
          :disabled="pageState?.isLoadingOlder"
          @click="loadOlderHistory(true)"
        >
          <span>{{ pageHistorySummary }}</span>
        </Button>

        <!-- 中栏只有 say(W2):署名 / 正文 markdown / 附件 / 引用 / 一个
             「展开执行 →」。工具卡、StepsPanel、diff 一律在右栏线程。 -->
        <SayChatFlow
          :messages="listMessages"
          :session-id="effectiveSessionId"
          :dm-mode="isUserDmSession"
          :pair-dm-mode="isPairDmSession"
          :highlighted-message-id="highlightedMessageId"
          :history-complete="!pageState?.hasMoreBefore"
          @reply-to="handleReplyTo"
          @react="handleReact"
          @jump-to-message="handleJumpToMessage"
        />

        <!-- 流式跟随靠浏览器的 scroll anchoring:say 行一律 `overflow-anchor:
             none`,只有这一枚哨兵在跟随时打开,锚点因此只可能是"底"。 -->
        <div
          ref="bottomSentinelRef"
          class="room-flow-sentinel"
          aria-hidden="true"
        />
      </div>
    </Scrollbar>

    <Transition name="room-scroll-btn">
      <Button
        v-if="showScrollToBottomButton && listMessages.length > 0"
        unstyled
        class="room-scroll-bottom"
        native-type="button"
        aria-label="回到底部"
        @click="scrollToBottomFromButton"
      >
        <ArrowDown
          :size="16"
          :stroke-width="2"
        />
      </Button>
    </Transition>

    <div
      ref="composerRef"
      class="room-composer"
    >
      <BackgroundJobsStatusBar :session-id="effectiveSessionId" />

      <!-- 权限账页栏位(§8 铁律 1):位置与语义与旧壳逐字段一致 —— 中栏底部、
           composer 上方、按 toolCallId 应答、scope 档位、Enter/D 快捷键。
           实现是同一个组件,不是一份拷贝。 -->
      <PermissionLedger
        v-if="pendingPermission"
        :tool-call="pendingPermission"
        :queued-count="queuedBehindCount"
        collab-scope-only
        @allow="(toolCall, scope) => void confirmTool(toolCall, scope)"
        @reject="openRejectDialog"
        @reject-with-instruction="(toolCall, reason) => handleRejectWithInstruction(toolCall, reason)"
      />

      <!-- 提问栏位:与审批同一格,同一个实现(房面与直聊共用,不是一份拷贝)。
           自己看账本,欠账为空就零高度。 -->
      <InteractionPrompt :session-id="effectiveSessionId" />

      <CollabTypingLine :session-id="effectiveSessionId" />

      <ComposerReplyBar
        v-if="pendingReplyTo"
        :reply-to="pendingReplyTo"
        @cancel="pendingReplyTo = null"
      />

      <!-- `allow-stop-action="true"`:房面**有**停止态(E5)。
           这个开关当初是 `false`,理由是真机走查的结论——「那颗停止钮按下去停不掉
           任何东西」:房会话自己从来没有流,回合跑在各成员的执行会话上,而当时
           那条链只掐得到房会话。
           v3 之后那条链全程可达:停止 → `abortStream` → 装配层注入的
           `abortCollabRoomTurnForStop` → `stopCollabV3RoomFloor`,它按回合登记簿
           找到这间房在飞的每一条执行会话逐条 abort、换代作废在外的牌,并对外部
           执行体再调一次 `interrupt`(E4;abort 掐不到别的进程里那颗大脑)。
           显示条件不在这里 —— `InputBox` 的 `hasActiveGeneration` 早就读
           `collabBoardStore.isRoomTurnActive`,房间的"在跑"一直都答得出,只是被
           这个开关整档挡住了。 -->
      <InputBox
        ref="inputBoxRef"
        :is-loading="isGenerating"
        :session-id="effectiveSessionId"
        :placeholder="composerPlaceholder"
        :allow-stop-action="true"
        @send-message="handleSendMessage"
        @stop-generation="handleStopGeneration"
        @switch-session="(sessionId) => emit('switchSession', sessionId)"
      />
    </div>

    <RejectReasonDialog
      :visible="showRejectDialog"
      @confirm="confirmReject"
      @cancel="cancelReject"
    />

    <div
      v-if="reactionHint"
      class="room-action-hint"
    >
      {{ reactionHint }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 房 / 私聊的聊天面 —— 去复用重构 R1 的新中栏
 * (样板 `docs/design/im-redesign/final.html`,设计 §8)。
 *
 * 它**不是** `ChatPanel` 的一个分支,而是另一棵壳:没有 TabBar、没有
 * ChatSidePanel、没有 GoalStatusBar / 大纲导航轨 / 练习条,也没有行内工具卡。
 * 分流在 `ChatWindow` 层(`kind === 'room' && shellMode === 'workbench'`),两面
 * 永不同时挂载。
 *
 * **组件级复用照旧,壳级复用禁止**(§8 铁律 4)。这一面复用的是:
 *  - `SayChatFlow` / `SayMessageRow`(C2′ 的 say 呈现树,原样从 MessageList 提出)
 *  - `useFollowScroll` / `useMessageScrollCoordinator`(跟随与锚定)
 *  - `useHistoryPagination`(历史分页,与旧壳同一份阈值)
 *  - `PermissionLedger` + `usePermissionResponder` + `RejectReasonDialog`(审批,
 *    §8 铁律 1:位置/字段/快捷键零变化,靠"同一个实现"而不是靠比对)
 *  - `InputBox`(composer 不重写,§8 铁律 5;它自己会在 room 会话切 messenger 形态)
 *  - `CollabTypingLine` / `ComposerReplyBar` / `BackgroundJobsStatusBar`
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Scrollbar from '@/components/common/Scrollbar.vue'
import SayChatFlow from '../say/SayChatFlow.vue'
import { SAY_METRICS, shouldUseSayTypography } from '../say/say-typography'
import InputBox from '../InputBox.vue'
import CollabTypingLine from '../CollabTypingLine.vue'
import ComposerReplyBar from '../ComposerReplyBar.vue'
import BackgroundJobsStatusBar from '../BackgroundJobsStatusBar.vue'
import PermissionLedger from '../permission/PermissionLedger.vue'
import InteractionPrompt from '../interaction/InteractionPrompt.vue'
import RejectReasonDialog from '../permission/RejectReasonDialog.vue'
import {
  countQueuedBehind,
  findPendingPermission,
  type PermissionResponse,
} from '../permission/permission-ledger'
import { filterRoomMessages } from '../message/room-grouping'
import type { ChatMessage, ChatMessageMention, ChatMessageReplyTo, MessageAttachment, ToolCall } from '@/types'
import { useSessionsStore } from '@/stores/sessions'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { useChatStore } from '@/stores/chat'
import { useChatSession } from '@/composables/useChatSession'
import { useFollowScroll } from '@/composables/useFollowScroll'
import { useMessageScrollCoordinator } from '@/composables/useMessageScrollCoordinator'
import { useHistoryPagination } from '@/composables/useHistoryPagination'
import { usePermissionResponder } from '@/composables/usePermissionResponder'
import { usePermissionShortcuts } from '@/composables/usePermissionShortcuts'
import { useCollabReactions } from '@/composables/useCollabReactions'
import { useCollabBoardStore } from '@/stores/collabBoard'
import { buildComposerPlaceholder, findRoomDefaultThread } from './room-head'
import { repairTailLedgerAfterPrepend, shouldShowRoomScrollToBottom } from './room-scroll'
import { isAgentPairDmRoom, isUserDmRoom } from '@onething/runtime/collab'

const props = defineProps<{
  sessionId?: string
}>()

const emit = defineEmits<{
  switchSession: [sessionId: string]
}>()

const sessionsStore = useSessionsStore()
const agentsStore = useAgentsStore()
const settingsStore = useSettingsStore()
const chatStore = useChatStore()

const effectiveSessionId = computed(() => props.sessionId || sessionsStore.currentSessionId)
const panelSession = computed(() => {
  const sid = effectiveSessionId.value
  if (!sid) return null
  return sessionsStore.sessions.find(item => item.id === sid) || null
})

const {
  messages,
  isLoading,
  isGenerating,
  sendMessage: chatSendMessage,
  steerMessage: chatSteerMessage,
  queueFollowUpMessage: chatQueueFollowUpMessage,
  stopGeneration: chatStopGeneration,
} = useChatSession(effectiveSessionId)

// 协调器的机器动作(激活驱动、resolved pass)在这里就被丢掉 —— 与旧壳同一个
// 过滤器,时间胶囊与署名合并因此看到的正是用户看到的那一串。
const listMessages = computed(() => filterRoomMessages(messages.value) as ChatMessage[])

const isUserDmSession = computed(() => isUserDmRoom(panelSession.value?.room))
const isPairDmSession = computed(() => isAgentPairDmRoom(panelSession.value?.room))

/**
 * composer 占位符(样板 `final.html`:群「发送到 #浏览器重构」/ 私聊
 * 「给小林发消息」)。形态判据与房头同一条 —— **只有单成员 dm 房是私聊态**,
 * agent 互聊 pair 房照群聊走(那间房里"给谁发"没有唯一答案)。
 * 名字也走同一份身份解析(`displayAgent`),不反解 id。
 */
const composerPlaceholder = computed(() => {
  if (isUserDmSession.value) {
    const agentId = panelSession.value?.room?.memberAgentIds?.[0] || ''
    return buildComposerPlaceholder({
      mode: 'dm',
      name: agentId ? agentsStore.displayAgent(agentId).name : '',
    })
  }
  return buildComposerPlaceholder({ mode: 'group', name: panelSession.value?.name || '' })
})

/**
 * 排版档的唯一真源仍是 SAY_METRICS(与 C2′ 同一张表),但**要过退让闸**:
 * 用户显式调过字号/行高/密度时整档退让,让他的设置照旧生效。
 *
 * 这道闸原本长在 `MessageList` 上,房面脱离旧壳(R1)后一度失联——`flowStyles`
 * 变成无条件写档,手动把字号调大过的人进房会被按回 13px。R3 拆死门时暴露出来,
 * 在此接回。判据不是"有值"而是"与出厂默认值不同"(见 say-typography.ts 的注释:
 * density/fontSize 在 defaults 里本来就有值,"有值即退让"会让这档永不生效)。
 */
const flowStyles = computed((): Record<string, string> => {
  const settings = settingsStore.settings
  const active = shouldUseSayTypography({
    isSaySurface: true,
    messageListDensity: settings?.general?.messageListDensity,
    messageLineHeight: settings?.general?.messageLineHeight,
    chatFontSize: settings?.chat?.chatFontSize,
  })
  if (!active) return {}
  return {
    '--message-font-size': `${SAY_METRICS.fontSize}px`,
    '--message-line-height': String(SAY_METRICS.lineHeight),
    '--message-line-height-px': `${Math.round(SAY_METRICS.fontSize * SAY_METRICS.lineHeight)}px`,
    '--content-spacing-px': `${Math.round(SAY_METRICS.fontSize * SAY_METRICS.contentSpacing)}px`,
    '--chat-turn-gap': `${SAY_METRICS.turnGapPx}px`,
  }
})

// ── 滚动:跟随 / 锚定 / 分页,三件都复用既有 composable ──────────────────
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null)
const scrollerRef = ref<HTMLElement | null>(null)
const flowContentRef = ref<HTMLElement | null>(null)
const bottomSentinelRef = ref<HTMLElement | null>(null)
const composerRef = ref<HTMLElement | null>(null)
const showScrollToBottomButton = ref(false)
const searchHighlightedMessageId = ref<string | null>(null)
let searchHighlightTimer: ReturnType<typeof setTimeout> | null = null

const highlightedMessageId = computed(() => searchHighlightedMessageId.value)

const hasActiveStream = computed(() => listMessages.value.some(message => message.isStreaming))
const pageState = computed(() => chatStore.getSessionPageState(effectiveSessionId.value))
const totalMessageCount = computed(() =>
  pageState.value?.totalCount ?? panelSession.value?.messageCount ?? listMessages.value.length)
const pageHistorySummary = computed(() => {
  const state = pageState.value
  const total = totalMessageCount.value
  const loaded = listMessages.value.length
  if (!state || !state.hasMoreBefore || total <= loaded) return ''
  if (state.isLoadingOlder) return `正在读更早的消息… ${loaded}/${total}`
  return `读更早的消息 · ${loaded}/${total}`
})

const follow = useFollowScroll({
  scroller: scrollerRef,
  content: flowContentRef,
  count: computed(() => listMessages.value.length),
  maintainOnLayout: hasActiveStream,
})
const { isFollowing } = follow
const useBottomScrollAnchor = computed(() => isFollowing.value && hasActiveStream.value)

function getMessageRowById(messageId: string): HTMLElement | null {
  return flowContentRef.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`) ?? null
}

function updateScrollToBottomButton() {
  const el = scrollerRef.value
  if (!el) {
    showScrollToBottomButton.value = false
    return
  }
  // 规则(含"到底即灭")在 room-scroll.ts,那里是纯函数、单独钉着。
  showScrollToBottomButton.value = shouldShowRoomScrollToBottom(
    el,
    isFollowing.value,
    pageState.value?.hasMoreAfter ?? false,
  )
}

const scrollCoordinator = useMessageScrollCoordinator({
  scroller: scrollerRef,
  getSessionId: () => effectiveSessionId.value,
  getMessageRowById,
  onStateChange: updateScrollToBottomButton,
})

const historyPagination = useHistoryPagination({
  scroller: scrollerRef,
  content: flowContentRef,
  getSessionId: () => effectiveSessionId.value,
  getPageState: () => pageState.value,
  isSwitching: () => follow.isSwitching(),
  isFollowing,
  clearScrollMode: () => scrollCoordinator.clear(),
  getMessageRowById,
  writeScrollTop: top => scrollCoordinator.writeScrollTop(top),
  onSettled: () => updateScrollToBottomButton(),
})
const { loadOlderHistoryIfNeeded, loadNewerHistoryIfNeeded } = historyPagination

/**
 * 「读更早」补页 —— 房面在共用件外面套的一层账目修补。
 *
 * 根因见 `room-scroll.ts` 的 `repairTailLedgerAfterPrepend`:`loadOlderMessages`
 * 会用"更旧那一页"的响应整份覆盖分页台账,而存储层对更旧那一页一律答
 * `hasMoreAfter: true` —— 于是向上补过一次页,"回到底部"就永久亮着,滚到真底也
 * 不灭(真机走查的那个现象)。
 *
 * 修在这里而不是 `chatStore.loadOlderMessages` / `useHistoryPagination`:那两个
 * 都是旧壳共用件,动它们就动了 classic(§8 铁律 3)。向上补页物理上改不了"更新
 * 那一边"的事实,所以补页前抄下那两栏、补完原样还回去,是最小的一刀。
 */
async function loadOlderHistory(force = false) {
  const sessionId = effectiveSessionId.value
  const before = sessionId ? chatStore.getSessionPageState(sessionId) : null
  const tailLedger = before
    ? { hasMoreAfter: before.hasMoreAfter, backwardsCursor: before.backwardsCursor }
    : null

  await loadOlderHistoryIfNeeded(force)

  if (!sessionId) return
  const patch = repairTailLedgerAfterPrepend(tailLedger, chatStore.getSessionPageState(sessionId))
  if (!patch) return
  chatStore.updateSessionPageState(sessionId, patch)
  updateScrollToBottomButton()
}

function handleScroll() {
  follow.checkReattach()
  const el = scrollerRef.value
  if (el) {
    scrollCoordinator.detectExternalScroll(el)
    const isAtTail = el.scrollHeight - el.scrollTop - el.clientHeight <= 2
    // 只在真尾才进 tail 档:局部窗口的底不是对话的底,否则每次高度变化都会
    // 把视野甩向真尾。
    const isRealTail = !pageState.value?.hasMoreAfter
    if (isAtTail && isRealTail && !scrollCoordinator.isAnchored() && (hasActiveStream.value ? isFollowing.value : true)) {
      scrollCoordinator.setTail()
    }
  }
  updateScrollToBottomButton()
  void loadOlderHistory()
  void loadNewerHistoryIfNeeded()
}

function handleWheel(event: WheelEvent) {
  scrollCoordinator.clear()
  follow.onWheel(event)
}

function handlePointerDown() {
  scrollCoordinator.clear()
}

let attachedScroller: HTMLElement | null = null

function attachScrollListeners() {
  const scroller = scrollbarRef.value?.getScrollElement() ?? null
  scrollerRef.value = scroller
  if (!scroller || attachedScroller === scroller) return
  detachScrollListeners()
  attachedScroller = scroller
  scroller.addEventListener('scroll', handleScroll)
  scroller.addEventListener('wheel', handleWheel, { passive: false })
  scroller.addEventListener('pointerdown', handlePointerDown)
}

function detachScrollListeners() {
  if (!attachedScroller) return
  attachedScroller.removeEventListener('scroll', handleScroll)
  attachedScroller.removeEventListener('wheel', handleWheel)
  attachedScroller.removeEventListener('pointerdown', handlePointerDown)
  attachedScroller = null
}

/** composer 高度变化会改可视区:跟随/锚定要立刻跟上,不能等下一次滚动。 */
let composerResizeObserver: ResizeObserver | null = null

function observeComposer() {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  const el = composerRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  composerResizeObserver = new ResizeObserver(() => {
    scrollCoordinator.onLayoutChange()
    updateScrollToBottomButton()
  })
  composerResizeObserver.observe(el)
}

async function scrollToMessage(messageId: string, options: { preserveNavigation?: boolean } = {}) {
  void options
  const index = listMessages.value.findIndex(message => message.id === messageId)
  if (index === -1) return false
  isFollowing.value = false
  searchHighlightedMessageId.value = messageId

  await nextTick()
  const row = getMessageRowById(messageId)
  const scroller = scrollerRef.value
  if (row && scroller) {
    const offsetWithinMessage = -Math.round((scroller.clientHeight - row.offsetHeight) / 2)
    scrollCoordinator.writeScrollTop(row.offsetTop + offsetWithinMessage, { behavior: 'smooth' })
  }

  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  searchHighlightTimer = setTimeout(() => {
    if (searchHighlightedMessageId.value === messageId) {
      searchHighlightedMessageId.value = null
    }
  }, 2600)
  return true
}

function handleJumpToMessage(messageId: string) {
  void scrollToMessage(messageId, { preserveNavigation: true })
}

async function scrollToBottomFromButton() {
  const sessionId = effectiveSessionId.value
  isFollowing.value = true
  // 局部窗口:先把尾页读回来,否则"回到底部"只回到这一窗的底。
  if (sessionId && pageState.value?.hasMoreAfter) {
    scrollCoordinator.clear()
    await chatStore.loadInitialMessagePage(sessionId)
    await nextTick()
  }
  scrollCoordinator.setTail({ behavior: 'smooth' })
}

// 新消息落地 / store 主动 bump:轻推一次跟随。
const effectiveScrollVersion = computed(() => chatStore.getScrollVersion(effectiveSessionId.value))
watch([effectiveScrollVersion, () => listMessages.value.length], () => {
  if (listMessages.value.length === 0) return
  if (historyPagination.isPrepending()) return
  nextTick(() => {
    scrollCoordinator.onLayoutChange()
    updateScrollToBottomButton()
  })
}, { flush: 'post' })

// ── 右栏「线程」的默认落点 ──────────────────────────────────────────────
//
// 右栏不另起一根:App 级 `RightWorkbenchPanel` 已经有 `thread` tab + 既有
// `ThreadWorkbench`,开合初值也已经走 `resolveInspectorDefaultOpen`(≥1400 默认
// 展开)。房面只回答"这间房该看哪条线程",**开不开是右栏自己的事** —— 窗宽策略
// (W-Q2)仍然只归 `resolveInspectorDefaultOpen`,房面不读 `inspectorOpen`。
//
// 这里曾经写着"只在右栏已经开着时才去落座"。那道闸下面那段注释已经拆了,
// 这句描述却留了下来 —— 两段互相矛盾的注释里,过期的那句比没有注释更坏。
const collabBoardStore = useCollabBoardStore()
collabBoardStore.ensureSubscribed()

function seatDefaultThread() {
  const sessionId = effectiveSessionId.value
  if (!sessionId) return

  // 进房 = 把右栏备齐成样板那三条(线程 / 成员 / 看板)并落在线程上。
  //
  // 从前这里有两道闸,叠起来让线程**永远不出现**:①右栏没开就直接返回;
  // ②看板上没有"在跑且开过工作台"的卡就不派事件。于是一间还没跑过活的房,
  // 右栏里一条线程也没有 —— 真机走查时用户第一句话就是"我看不到线程"。
  // 现在:靶子拿得到就带上,拿不到也照开(空线程是个真答案,ThreadWorkbench
  // 自己会说"还没有执行记录")。
  const dmAgentId = isUserDmSession.value
    ? (panelSession.value?.room?.memberAgentIds?.[0] || '')
    : ''
  const thread = findRoomDefaultThread(collabBoardStore.boardFor(sessionId))

  window.dispatchEvent(new CustomEvent('onething:room-workbench', {
    detail: {
      roomSessionId: sessionId,
      workSessionId: thread?.workSessionId,
      dmAgentId: dmAgentId || undefined,
    },
  }))
}

// ── 权限审批 ────────────────────────────────────────────────────────────
const pendingPermission = computed<ToolCall | null>(() => findPendingPermission(messages.value))
const queuedBehindCount = computed(() => countQueuedBehind(messages.value, pendingPermission.value))

const { confirmTool, rejectTool } = usePermissionResponder({
  getSessionId: () => panelSession.value?.id,
  getMessages: () => messages.value,
})

const showRejectDialog = ref(false)
const pendingRejectToolCall = ref<ToolCall | null>(null)

function openRejectDialog(toolCall: ToolCall) {
  pendingRejectToolCall.value = toolCall
  showRejectDialog.value = true
}

function confirmReject(reason?: string) {
  if (pendingRejectToolCall.value) {
    void rejectTool(pendingRejectToolCall.value, reason)
  }
  cancelReject()
}

function cancelReject() {
  showRejectDialog.value = false
  pendingRejectToolCall.value = null
}

/** 与旧壳一致:栏位里写了理由就直接拒;理由为空则退回拒绝理由对话框。 */
function handleRejectWithInstruction(toolCall: ToolCall, reason: string | undefined) {
  if (reason) {
    void rejectTool(toolCall, reason)
    return
  }
  openRejectDialog(toolCall)
}

// Enter = allow current tool, D/Escape = reject —— 与旧壳同一个 composable、
// 同一组按键、同一道"对话框开着就不接管"的闸。
usePermissionShortcuts(
  () => !!pendingPermission.value && !showRejectDialog.value,
  {
    onAllow: () => {
      const pending = pendingPermission.value
      if (pending) void confirmTool(pending, 'once' as PermissionResponse)
    },
    onReject: () => {
      const pending = pendingPermission.value
      if (pending) openRejectDialog(pending)
    },
  },
)

// ── 表情 / 引用 / 发送 ──────────────────────────────────────────────────
const { reactionHint, react: handleReact } = useCollabReactions(() => effectiveSessionId.value)

const pendingReplyTo = ref<ChatMessageReplyTo | null>(null)
const inputBoxRef = ref<InstanceType<typeof InputBox> | null>(null)

function handleReplyTo(replyTo: ChatMessageReplyTo) {
  pendingReplyTo.value = replyTo
  focusInput()
}

async function handleSendMessage(
  message: string,
  mode: 'send' | 'steer' | 'followup' = 'send',
  attachments?: MessageAttachment[],
  mentions?: ChatMessageMention[],
) {
  if (!panelSession.value) return
  if (mode === 'steer') {
    await chatSteerMessage(message)
    return
  }
  if (mode === 'followup') {
    await chatQueueFollowUpMessage(message)
    return
  }
  // 引用跟着这一次发送出去,并在 await 之前就被吃掉 —— 否则第二次 Enter 会把
  // 同一条引用再挂一次(§3.5 A)。房不会是草稿会话,所以没有 draft 物化分支。
  const replyTo = pendingReplyTo.value ?? undefined
  pendingReplyTo.value = null
  isFollowing.value = true
  scrollCoordinator.setTail()
  await chatSendMessage(message, attachments, {
    ...(replyTo ? { replyTo } : {}),
    ...(mentions ? { mentions } : {}),
  })
}

/**
 * 目前**打不到**:`InputBox` 在房面收着停止态(`allow-stop-action="false"`),
 * 这个 emit 不会发出来。接线留着不拆 —— 等引擎侧的 collab turn 中断真的接通,
 * 入口翻回来就直接可用,不必再补一遍 DOM。
 */
async function handleStopGeneration() {
  await chatStopGeneration()
}

function focusInput() {
  inputBoxRef.value?.focus()
}

function insertPromptReference(promptId: string) {
  inputBoxRef.value?.insertPromptReference(promptId)
}

// ── 会话快照(滚动位置 + 草稿),与旧壳同一本账 ─────────────────────────
const TAIL_SNAPSHOT_DISTANCE_PX = 4

function saveSnapshot(sessionId: string, prepareForSwitch = false) {
  const el = scrollerRef.value
  const distanceToBottom = el ? Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight) : 0
  const isAtTail = distanceToBottom <= TAIL_SNAPSHOT_DISTANCE_PX
  const anchor = captureAnchor()

  if (prepareForSwitch) {
    scrollCoordinator.clear()
    follow.prepareForSwitch()
  }

  chatStore.saveSnapshot(sessionId, {
    mode: isAtTail || !anchor ? 'tail' : 'anchor',
    anchorMessageId: isAtTail ? undefined : anchor?.messageId,
    offsetWithinMessage: isAtTail ? undefined : anchor?.offset,
    navMessageId: undefined,
    hasNavigated: false,
    messageInput: inputBoxRef.value?.getMessageInput() ?? '',
    quotedText: inputBoxRef.value?.getQuotedText() ?? '',
    attachments: inputBoxRef.value?.getAttachments() ?? [],
  })
}

function captureAnchor(): { messageId: string; offset: number } | null {
  const scroller = scrollerRef.value
  const content = flowContentRef.value
  if (!scroller || !content) return null
  const rows = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]'))
  const viewportTop = scroller.scrollTop
  const row = rows.find(candidate => candidate.offsetTop + candidate.offsetHeight > viewportTop)
  const messageId = row?.dataset.messageId
  if (!row || !messageId) return null
  return { messageId, offset: viewportTop - row.offsetTop }
}

function restoreTail() {
  scrollCoordinator.clear()
  isFollowing.value = true
  scrollCoordinator.setTail()
  follow.finishSwitch()
  updateScrollToBottomButton()
}

async function restoreSnapshot(sessionId: string) {
  const snapshot = chatStore.getSnapshot(sessionId)
  await nextTick()
  if (effectiveSessionId.value !== sessionId) return false
  if (!snapshot) {
    restoreTail()
    return false
  }
  inputBoxRef.value?.restoreSnapshot(snapshot)
  if (snapshot.mode !== 'anchor' || !snapshot.anchorMessageId) {
    restoreTail()
    return true
  }
  isFollowing.value = false
  const row = getMessageRowById(snapshot.anchorMessageId)
  if (!row) {
    restoreTail()
    return true
  }
  const offset = Math.max(0, snapshot.offsetWithinMessage ?? 0)
  scrollCoordinator.writeScrollTop(row.offsetTop + offset)
  scrollCoordinator.setAnchor(snapshot.anchorMessageId, offset)
  follow.finishSwitch()
  updateScrollToBottomButton()
  return true
}

onMounted(() => {
  attachScrollListeners()
  observeComposer()
  const sessionId = effectiveSessionId.value
  if (sessionId) void restoreSnapshot(sessionId)
  seatDefaultThread()
})

onBeforeUnmount(() => {
  detachScrollListeners()
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  const sessionId = effectiveSessionId.value
  if (sessionId) saveSnapshot(sessionId)
})

watch(effectiveSessionId, async (newId, oldId) => {
  if (oldId && oldId !== newId) saveSnapshot(oldId, true)
  await nextTick()
  attachScrollListeners()
  if (!newId) return
  if (!chatStore.getSnapshot(newId)) inputBoxRef.value?.clearInput()
  await restoreSnapshot(newId)
  seatDefaultThread()
})

watch(() => listMessages.value.length, () => {
  nextTick(attachScrollListeners)
}, { flush: 'post' })

defineExpose({
  focusInput,
  insertPromptReference,
  scrollToMessage,
  isLoading,
})
</script>

<style scoped>
.room-surface {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* 阅读列不收窄:房是高密度的场,吃满面板(W2)。 */
.room-flow {
  /* 尾部呼吸(真机走查:最后一条几乎贴着输入框)。样板是张不滚动的静态图,
     `.flow` 只留 4px 就够看;真面在滚,末条贴边读起来是压迫的 —— 这里按**旧壳
     同一条量尺**给足:`MessageList` 的 `--chat-scroll-tail-reserve`,逐字同式,
     所以它随字号/行高设置一起缩放,不是拍脑袋的常数。

     这段留白是 `.room-flow-content` 的 padding-bottom,**在哨兵之下**,对
     "跟随到底"是中性的:①`useFollowScroll` 判到底用的是
     `scrollHeight - clientHeight - scrollTop`,padding 让被减数与 scrollTop 上限
     同量增长,真尾仍然是距离 0;②scroll anchoring 锚的是那枚 1px 哨兵,增长发生
     在它**下方**且是常量,不会触发锚点补偿。 */
  --room-flow-tail-reserve: var(
    --chat-composer-safe-gap,
    max(calc(var(--content-spacing-px, 8px) * 3), calc(var(--message-line-height-px, 20px) * 1.25))
  );

  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.room-flow-content {
  display: flex;
  flex-direction: column;
  padding: 16px 0 var(--room-flow-tail-reserve, 24px);
}

.room-flow-sentinel {
  width: 100%;
  height: 1px;
  pointer-events: none;
  overflow-anchor: none;
}

.room-flow.stream-following .room-flow-sentinel {
  overflow-anchor: auto;
}

.room-history-summary {
  align-self: center;
  margin-bottom: 8px;
  padding: 3px 12px;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: 20px;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

.room-history-summary:disabled {
  cursor: default;
  opacity: 0.6;
}

/* composer 区:样板里它吃满宽度、左右各留一格,不走阅读列的测量。
   `--chat-composer-width` / 两枚列边距是账页栏位与 InputBox 共同消费的输入
   变量 —— 在这里一次性钉成"整宽 + 零外边距",里面的组件一个字节都不用改。 */
.room-composer {
  --chat-composer-width: 100%;
  --chat-content-column-left: 0px;
  --chat-content-column-right: 0px;

  position: relative;
  z-index: 5;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 0 20px 16px;
}

.room-composer > :deep(.background-jobs-bar) {
  align-self: center;
}

.room-composer > :deep(.collab-typing),
.room-composer > :deep(.composer-reply) {
  box-sizing: border-box;
  width: 100%;
  margin: 0 0 4px;
}

/* ── composer 皮相(R2,样板两张整窗图的输入框)────────────────────────────
 *
 * 样板要的是**圆角 12px + 浅底 + 一行图标 + 右侧深色圆形发送**,而 `InputBox`
 * 自己是"蓝图框"(方角、发丝描边、顶边浮标签、mono 的 SEND)。
 *
 * 皮相整段写在**这里**而不是 `InputBox` 里,理由是结构性的:这是父级 scoped
 * CSS,编译出来带着 `.room-composer[data-v-…]` 前缀,**直聊那棵树上根本不存在
 * 这个祖先** —— 直聊逐像素不变不靠"我记得没改到",靠选择器够不着。
 * `InputBox` 本体(行为与自己的样式)一个字节都没动(§8 铁律 5)。
 *
 * 与样板的一处取舍:样板画的是「附件 / ＋ / 麦克风」三颗,这里只有附件与麦克风
 * ——「＋」在 messenger 形态下没有对应动作,凭空加一颗按钮就不是皮相而是行为。 */
.room-surface .room-composer :deep(.composer) {
  border-radius: 12px;
  border-color: var(--ui-border-subtle-border);
  background: var(--ui-surface-panel-bg);
}

.room-surface .room-composer :deep(.composer.focused) {
  background: var(--ui-surface-panel-bg);
}

.room-surface .room-composer :deep(.input-area) {
  padding: 5px 6px 0 14px;
}

/* 顶边浮标签是蓝图框的构件,聊天面不要 —— 但录音计时 / 命令态 / 正在放的歌
   是**活状态**,那几档照旧留着,不能连状态一起抹掉。
   (电台档已随 E 期迁进 S 状态带,`.music` 这一档不再存在。) */
.room-surface .room-composer :deep(.composer-frame-label:not(.listening):not(.transcribing):not(.command)) {
  display: none;
}

/* 工具条:去掉分格线与顶边,收成样板那一行图标。 */
.room-surface .room-composer :deep(.composer-toolbar) {
  min-height: 38px;
  margin: 0;
  padding: 0 10px 4px 12px;
  border-top: 0;
}

/* messenger 形态下 toolbar-left 本来就是空的(工程控件整条不渲染),
   让 toolbar-right 吃满整行,图标因此贴左、发送键靠 margin 甩到右边 —— 与样板
   的「一行图标 + 右侧圆钮」同一个排布,不动一行 DOM。 */
.room-surface .room-composer :deep(.toolbar-left) {
  display: none;
}

.room-surface .room-composer :deep(.toolbar-right) {
  flex: 1;
  align-items: center;
  gap: 4px;
}

.room-surface .room-composer :deep(.toolbar-right > *) {
  border-left: 0;
}

.room-surface .room-composer :deep(.toolbar-right > .voice-btn),
.room-surface .room-composer :deep(.toolbar-right > .voice-aux-btn) {
  height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-sm, 6px);
}

/* 深色圆钮:34px、纸底墨面,箭头顶掉 mono 的 `SEND ⏎`。 */
.room-surface .room-composer :deep(.toolbar-right > .send-btn) {
  --app-button-hover-fill: var(--ui-text-primary-fg);
  --app-button-hover-fg: var(--ui-surface-app-bg);

  width: 34px;
  min-width: 34px;
  height: 34px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--ui-text-primary-fg);
  color: var(--ui-surface-app-bg);
}

/* Hover/active step the ink one notch toward the paper, the same move the
   global `.btn.primary:hover` makes (mix the opposite tone into the fill).
   The previous recipe faded the fill's ALPHA to 82%, which on an opaque
   34px disc mostly let the composer behind it bleed through — the disc kept
   its shape and the change read as nothing happening. Staying opaque and
   shifting the tone is what makes the state legible. */
.room-surface .room-composer :deep(.toolbar-right > .send-btn:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 86%, var(--ui-surface-app-bg));
  color: var(--ui-surface-app-bg);
}

.room-surface .room-composer :deep(.toolbar-right > .send-btn:active:not(:disabled)) {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 74%, var(--ui-surface-app-bg));
  color: var(--ui-surface-app-bg);
}

.room-surface .room-composer :deep(.toolbar-right > .send-btn:disabled) {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 26%, transparent);
  color: var(--ui-surface-app-bg);
}

.room-surface .room-composer :deep(.send-label) {
  font-size: 0;
  letter-spacing: 0;
}

.room-surface .room-composer :deep(.send-label)::after {
  content: "→";
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1;
}

/* ── 打字行皮相(样板 `final.html` 的 `.typing`)─────────────────────────────
 *
 * 样板要的是**三根小竖条波纹在最左 + 灰字「阿澈 正在输入…」**,整行很轻、贴着
 * 输入框上沿。`CollabTypingLine` 自己画的是「头像 + 名字 + 正在输入 + 三颗 2px
 * 圆点」——那是 C1/C2 的旧形态,而**旧壳(ChatPanel)还在用同一个组件**。
 *
 * 所以皮相写在**这里**,与 composer 皮相同一手法:父级 scoped CSS 编译出来带着
 * `.room-composer[data-v-…]` 前缀,直聊那棵树上根本不存在这个祖先 —— 直聊逐像素
 * 不变不靠"我记得没改到",靠选择器够不着。组件本体一个字节没动。
 *
 * 与样板的一处取舍:样板画的是纯文字署名,这里把头像收起来(`display: none`)
 * 而不是从 DOM 拆掉 —— 拆 DOM 就动到旧壳了。 */
.room-surface .room-composer :deep(.collab-typing) {
  gap: 5px;
  margin-bottom: 8px;
  font-size: 11.5px;
}

/* 样板里波纹在最左,不是行尾。 */
.room-surface .room-composer :deep(.collab-typing .typing-dots) {
  order: -1;
  align-items: flex-end;
  height: 9px;
  margin-right: 4px;
  gap: 2px;
}

/* 圆点 → 竖条:2px 宽、9px 高、1px 圆角,只在 Y 轴上呼吸(transform,不动布局,
   行高恒定)。 */
.room-surface .room-composer :deep(.collab-typing .typing-dot) {
  width: 2px;
  height: 9px;
  border-radius: 1px;
  transform-origin: bottom;
  opacity: 1;
  animation: room-typing-wave 1s ease-in-out infinite;
}

.room-surface .room-composer :deep(.collab-typing .typing-dot:nth-child(2)) {
  animation-delay: 0.15s;
}

.room-surface .room-composer :deep(.collab-typing .typing-dot:nth-child(3)) {
  animation-delay: 0.3s;
}

/* 样板是「正在输入…」;组件的三颗点被改造成左侧波纹了,省略号补在动词后。 */
.room-surface .room-composer :deep(.collab-typing .typing-verb)::after {
  content: "…";
}

.room-surface .room-composer :deep(.collab-typing .typing-avatar) {
  display: none;
}

@keyframes room-typing-wave {
  0%,
  100% {
    transform: scaleY(0.4);
    opacity: 0.55;
  }

  50% {
    transform: scaleY(1);
    opacity: 1;
  }
}

/* 组件自己的 reduced-motion 档被这里的高特异性规则盖住了,得原样补一份回来。 */
@media (prefers-reduced-motion: reduce) {
  .room-surface .room-composer :deep(.collab-typing .typing-dot) {
    transform: scaleY(0.75);
    opacity: 0.55;
    animation: none;
  }
}

/* 浮在 composer 上沿右角:它是"你不在底部"这件事的唯一提示,不能被 composer
   压住,所以 z-index 比 composer 低一档但位置在它上方。 */
.room-scroll-bottom {
  position: absolute;
  right: 26px;
  bottom: var(--room-scroll-bottom-offset, 96px);
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: 50%;
  background: var(--ui-surface-panel-bg);
  cursor: pointer;
  color: var(--ui-text-muted-fg);
}

.room-scroll-bottom:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-border-strong-border);
}

.room-scroll-btn-enter-active,
.room-scroll-btn-leave-active {
  transition: opacity var(--duration-fast) var(--ease-default);
}

.room-scroll-btn-enter-from,
.room-scroll-btn-leave-to {
  opacity: 0;
}

.room-action-hint {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: var(--radius-xs, 4px);
  background: var(--ui-surface-panel-bg);
  border: 1px solid var(--ui-border-subtle-border);
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  pointer-events: none;
}
</style>
