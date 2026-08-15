<template>
  <div
    ref="chatPanelRef"
    class="chat-panel"
  >
    <MessageList
      ref="messageListRef"
      :messages="listMessages"
      :is-loading="isLoading"
      :session-id="effectiveSessionId"
      :layout-transitioning="props.layoutTransitioning"
      :outline-rail-target="props.outlineRailTarget"
      :permission-shortcuts="props.permissionShortcuts"
      @set-quoted-text="handleSetQuotedText"
      @set-input-text="handleSetInputText"
      @reply-to="handleReplyTo"
      @regenerate="handleRegenerate"
      @edit-and-resend="handleEditAndResend"
      @split-with-branch="(sessionId) => emit('splitWithBranch', sessionId)"
      @open-file="(filePath) => emit('openFile', filePath)"
      @review-goal="(goalSessionId) => emit('reviewGoal', goalSessionId)"
    />

    <Teleport
      :to="props.footerTarget ?? 'body'"
      :disabled="!props.footerTarget"
    >
      <div
        v-show="props.active"
        ref="composerContainerRef"
        v-memo="[props.active, isGenerating, effectiveSessionId, isAgentExecutionSession, currentPendingPermission?.toolCall.id, queuedBehindPermission.length, isCollabSessionActive]"
        class="composer-container"
        data-ambient-anchor="composer"
      >
        <!-- S 状态带(docs/design/composer-bands-2026-08.md §2):后台任务 /
             目标 / 电台 / 插件 chat.status-bar 块收敛成一行 chips。
             顺序写死 jobs → goal → music,插件块按全局规范顺序排在后面;
             全员离场时整带零高度(`:empty`),输入区上方干净。
             横向溢出走滚动而不换行 —— 浮层已 teleport,不受裁切影响。 -->
        <div class="status-band">
          <BackgroundJobsStatusBar />
          <GoalStatusBar :session-id="effectiveSessionId" />
          <MusicStatusBar />
          <UiSlotHost
            anchor="chat.status-bar"
            chip-shell
            :session-id="effectiveSessionId"
          />
        </div>

        <!-- 权限账页栏位:位置(composer 上方)与语义(按 toolCallId 应答、
             scope 档位、快捷键)由 `PermissionLedger` 组件持有,房面共用同一个
             (去复用重构 R1 §8 铁律 1)。 -->
        <PermissionLedger
          v-if="currentPendingPermission"
          data-ambient-anchor="composer.block"
          :tool-call="currentPendingPermission.toolCall"
          :queued-count="queuedBehindPermission.length"
          :collab-scope-only="isCollabSessionActive"
          @allow="(toolCall, scope) => approveCurrentPermission(scope)"
          @reject="rejectCurrentPermission"
          @reject-with-instruction="(toolCall, reason) => rejectCurrentPermissionWithInstruction(reason)"
        />

        <!-- 提问栏位:与审批同一格「现在轮到你」,答完即收、会话里不留痕。
             它自己看账本(欠账为空就零高度),所以这里不需要条件 —— 也因此
             `v-memo` 只需 `effectiveSessionId` 这一枚已有的依赖。 -->
        <InteractionPrompt
          data-ambient-anchor="composer.block"
          :session-id="effectiveSessionId"
        />

        <!-- IM typing line: rides just above the composer in rooms only. It
             self-guards on an empty roster, so a quiet room costs no row. -->
        <CollabTypingLine
          v-if="isCollabRoomActive"
          data-ambient-anchor="composer.block"
          :session-id="effectiveSessionId"
        />

        <!-- Pending quote: sits directly on the composer it will be sent with,
             and clears the moment that send goes out (§3.5 A). -->
        <ComposerReplyBar
          v-if="pendingReplyTo"
          :reply-to="pendingReplyTo"
          @cancel="pendingReplyTo = null"
        />

        <!-- Agent 执行会话(W20):转录只读。一句用户话进这里会被当成"有人直接
             对 agent 说了句话"混进它的回合历史 —— 输入框整块不挂,取代它的是
             一行说明,免得输入框凭空消失像是坏了。 -->
        <div
          v-if="isAgentExecutionSession"
          class="composer-agent-note"
        >
          执行会话 · 只读转录
        </div>
        <InputBox
          v-else
          ref="inputBoxRef"
          :is-loading="isGenerating"
          :session-id="effectiveSessionId"
          @send-message="handleSendMessage"
          @stop-generation="handleStopGeneration"
          @switch-session="handleSwitchSession"
        />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { normalizeComposerWidth } from '@shared/defaults/settings'
import { resolveComposerWidth } from './composer-width'
import { useChatSession } from '@/composables/useChatSession'
import MessageList from './MessageList.vue'
import InputBox from './InputBox.vue'
import CollabTypingLine from './CollabTypingLine.vue'
import ComposerReplyBar from './ComposerReplyBar.vue'
import BackgroundJobsStatusBar from './BackgroundJobsStatusBar.vue'
import UiSlotHost from '@/components/plugins/UiSlotHost.vue'
import GoalStatusBar from './GoalStatusBar.vue'
import MusicStatusBar from './composer/MusicStatusBar.vue'
import type { ChatMessage, ChatMessageMention, ChatMessageReplyTo, MessageAttachment, ToolCall } from '@/types'
import { filterRoomMessages } from './message/room-grouping'
import { isAgentExecutionSession as isAgentExecutionSessionKind } from '@/utils/agent-sessions'
import PermissionLedger from './permission/PermissionLedger.vue'
import InteractionPrompt from './interaction/InteractionPrompt.vue'
import type { PermissionResponse } from './permission/permission-ledger'

const props = withDefaults(defineProps<{
  sessionId?: string
  active?: boolean
  footerTarget?: HTMLElement | null
  layoutTransitioning?: boolean
  outlineRailTarget?: HTMLElement | null
  /**
   * 是否接管权限审批的键盘快捷键(Enter 允许 / D·Esc 拒绝)—— 原样透给
   * `MessageList`,这里不解释语义(解释在 `MessageList` 的同名 prop 上)。
   *
   * 缺省 `true`:中栏/旧壳一个字节不变。**右栏的线程详情传 `false`** ——
   * `usePermissionShortcuts` 注册的是 window 级 capture keydown,中栏与右栏
   * 同时挂着 `MessageList` 时,若两条会话各自都有待批请求,一次 Enter 会同时
   * 命中两个处理器,批错对象。键盘归中栏,右栏只留可点的按钮。
   */
  permissionShortcuts?: boolean
}>(), {
  active: true,
  footerTarget: null,
  layoutTransitioning: false,
  outlineRailTarget: null,
  permissionShortcuts: true,
})

const emit = defineEmits<{
  splitWithBranch: [sessionId: string]
  openFile: [filePath: string]
  reviewGoal: [sessionId: string]
  switchSession: [sessionId: string]
}>()

const sessionsStore = useSessionsStore()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

const effectiveSessionId = computed(() => props.sessionId || sessionsStore.currentSessionId)

const {
  messages,
  isLoading,
  isGenerating,
  sendMessage: chatSendMessage,
  steerMessage: chatSteerMessage,
  queueFollowUpMessage: chatQueueFollowUpMessage,
  regenerate: chatRegenerate,
  editAndResend: chatEditAndResend,
  stopGeneration: chatStopGeneration,
} = useChatSession(effectiveSessionId)

const currentSession = computed(() => {
  const sid = effectiveSessionId.value
  if (!sid) return null
  return sessionsStore.getSessionItem(sid) || null
})

const panelMessages = computed(() => messages.value)

// Actionability needs both truths: `requiresConfirmation` is persisted engine
// history, `canRespond` marks a live emitted prompt in the permission manager
// (set from permission events / the pending seed). Either alone renders a
// card that can't be answered — stale after restart, or a queued follower.
const currentPendingPermission = computed<{ toolCall: ToolCall } | null>(() => {
  for (const message of panelMessages.value) {
    const toolCall = message.toolCalls?.find(tc => tc.requiresConfirmation && tc.canRespond)
    if (toolCall) return { toolCall }
  }
  return null
})

const queuedBehindPermission = computed(() => {
  const pending = currentPendingPermission.value?.toolCall
  if (!pending) return []
  const queued: ToolCall[] = []
  let seenPending = false
  for (const message of panelMessages.value) {
    for (const toolCall of message.toolCalls || []) {
      if (toolCall.id === pending.id) {
        seenPending = true
        continue
      }
      if (seenPending && toolCall.status === 'queued') {
        queued.push(toolCall)
      }
    }
  }
  return queued
})

// Collab 会话(room/work)的授权面收窄为仅 once:workspace 级 grant 只按
// {type, pattern, workspaceRoot} 匹配、无 agent/任务维度——在多 agent 语境下
// 批一次 = 该目录所有 agent 的所有未来任务全免检(docs/multi-agent-collab.md
// D8)。房间/任务维度的 grant 是 P2,做好才放开。
const isCollabSessionActive = computed(() => {
  const id = effectiveSessionId.value
  if (!id) return false
  const kind = sessionsStore.sessions.find(s => s.id === id)?.kind
  return kind === 'room' || kind === 'work'
})

// Agent 执行会话(W18/W20):打开就是原始转录直读 —— 驱动行、思考、工具面板
// 一个不滤(那正是"看执行过程"),所以下面的房间过滤天然不适用(它只认
// kind='room')。变的只有 composer:执行会话不收用户输入。
const isAgentExecutionSession = computed(() =>
  isAgentExecutionSessionKind(currentSession.value),
)

// Rooms only: work sessions are a single agent talking to you, so there is no
// "who else is about to speak" to report.
const isCollabRoomActive = computed(() => {
  const id = effectiveSessionId.value
  if (!id) return false
  return sessionsStore.sessions.find(s => s.id === id)?.kind === 'room'
})

// Rooms read as IM: the coordinator's machinery (activation drives, resolved
// pass turns) is dropped HERE, before the list — a row that renders nothing
// still owns a list slot and leaves a measurement hole. Grouping and time
// capsules downstream then see exactly the stream the user sees, so two
// replies from one agent that had a drive between them merge into one group.
// Non-room sessions pass through by identity (docs/design/multi-agent-collab-im.md §3).
const listMessages = computed(() =>
  isCollabRoomActive.value
    ? (filterRoomMessages(panelMessages.value) as ChatMessage[])
    : panelMessages.value,
)

// The quote waiting to ride out with the next message (§3.5 A). Per panel, and
// dropped on session switch — a quote belongs to the room it was picked in.
const pendingReplyTo = ref<ChatMessageReplyTo | null>(null)

function handleReplyTo(replyTo: ChatMessageReplyTo) {
  pendingReplyTo.value = replyTo
  focusInput()
}

watch(effectiveSessionId, () => {
  pendingReplyTo.value = null
})

const inputBoxRef = ref<InstanceType<typeof InputBox> | null>(null)
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const chatPanelRef = ref<HTMLElement | null>(null)
const composerContainerRef = ref<HTMLElement | null>(null)
const TAIL_SNAPSHOT_DISTANCE_PX = 4
const RESTORE_WAIT_FRAME_LIMIT = 120
let composerResizeObserver: ResizeObserver | null = null
let composerMeasureFrame: number | null = null
let lastMeasuredComposerHeight = -1
let contentColumnResizeObserver: ResizeObserver | null = null
let contentColumnMeasureFrame: number | null = null
let layoutFollowFrame: number | null = null
let lastMeasuredPanelLeft: number | null = null
let pendingComposerResizeHeight: number | null = null

const CONTENT_COLUMN_VAR_NAMES = [
  '--chat-composer-width',
  '--chat-content-column-left',
  '--chat-content-column-right',
  '--chat-content-column-center',
] as const

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function getContentColumnElement(): HTMLElement | null {
  return chatPanelRef.value?.querySelector<HTMLElement>('.message-list-content') ?? null
}

/* 输入区宽度档位。裁决本身是 `./composer-width` 的纯函数(那里有四档的完整
   口径与"为什么在 JS 不在 CSS"的理由);这里只负责取档位与 rem→px。 */
const composerWidthGear = computed(() =>
  normalizeComposerWidth(settingsStore.settings?.general?.composerWidth))

function remToPx(rem: number): number {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const base = root ? Number.parseFloat(getComputedStyle(root).fontSize) : 16
  return rem * (Number.isFinite(base) && base > 0 ? base : 16)
}

function getLayoutVariableTargets(): HTMLElement[] {
  return [composerContainerRef.value].filter((element): element is HTMLElement => Boolean(element))
}

function clearContentColumnVariables() {
  for (const target of getLayoutVariableTargets()) {
    for (const name of CONTENT_COLUMN_VAR_NAMES) {
      target.style.removeProperty(name)
    }
  }
}

function cssPx(value: number): string {
  return `${Math.max(0, value).toFixed(2)}px`
}

function getResizeEntryBlockSize(entry: ResizeObserverEntry): number {
  const borderBox = entry.borderBoxSize
  const firstBorderBox = Array.isArray(borderBox) ? borderBox[0] : borderBox
  return firstBorderBox?.blockSize ?? entry.contentRect.height
}

function measureContentColumn() {
  contentColumnMeasureFrame = null

  const panel = chatPanelRef.value
  const column = getContentColumnElement()
  if (!panel || !column) {
    clearContentColumnVariables()
    return
  }

  const panelRect = panel.getBoundingClientRect()
  const columnRect = column.getBoundingClientRect()
  lastMeasuredPanelLeft = panelRect.left
  const left = columnRect.left - panelRect.left
  const width = columnRect.width
  const center = left + width / 2

  // 输入区可以与内容列不同宽(宽度档位),于是它的左右外边距按**中线对齐**
  // 现算,而不是照抄内容列的两侧留白。standard 档 composerWidth === width,
  // 三个表达式逐项等于改造前的 left / right / width。
  const composerWidth = resolveComposerWidth(
    composerWidthGear.value,
    { columnWidth: width, panelWidth: panelRect.width },
    remToPx,
  )
  const composerLeft = center - composerWidth / 2
  const composerRight = panelRect.width - composerLeft - composerWidth

  const values = {
    '--chat-composer-width': cssPx(composerWidth),
    '--chat-content-column-left': cssPx(composerLeft),
    '--chat-content-column-right': cssPx(composerRight),
    '--chat-content-column-center': cssPx(center),
  }

  for (const target of getLayoutVariableTargets()) {
    for (const [name, value] of Object.entries(values)) {
      target.style.setProperty(name, value)
    }
  }
}

function scheduleContentColumnMeasure() {
  if (contentColumnMeasureFrame !== null) return
  contentColumnMeasureFrame = requestAnimationFrame(measureContentColumn)
}

function observeContentColumn() {
  contentColumnResizeObserver?.disconnect()
  contentColumnResizeObserver = null
  scheduleContentColumnMeasure()

  const panel = chatPanelRef.value
  if (!panel || typeof ResizeObserver === 'undefined') return

  contentColumnResizeObserver = new ResizeObserver(scheduleContentColumnMeasure)
  contentColumnResizeObserver.observe(panel)

  const column = getContentColumnElement()
  if (column) {
    contentColumnResizeObserver.observe(column)
  }
}

/* 档位换了要重量一次:内容列本身没变尺寸,ResizeObserver 不会自己醒。
   量完写下的仍是同一组内联变量,氛围层地标那边的 RO 观察的是**元素**,
   宽度一变它自己就跟上,不需要第二条通知。 */
watch(composerWidthGear, () => {
  scheduleContentColumnMeasure()
})

function setComposerHeightVariable(height: number) {
  const measuredHeight = Math.max(0, Math.ceil(height))
  if (measuredHeight === lastMeasuredComposerHeight) return
  lastMeasuredComposerHeight = measuredHeight
  for (const target of getLayoutVariableTargets()) {
    target.style.setProperty('--chat-composer-height', `${measuredHeight}px`)
  }
  messageListRef.value?.notifyLayoutChange?.()
}

function applyPendingComposerResizeHeight(): boolean {
  if (pendingComposerResizeHeight === null) return false
  const height = pendingComposerResizeHeight
  pendingComposerResizeHeight = null
  setComposerHeightVariable(height)
  return true
}

function measureComposerHeight() {
  composerMeasureFrame = null
  if (applyPendingComposerResizeHeight()) return
  const composer = composerContainerRef.value
  setComposerHeightVariable(composer?.getBoundingClientRect().height ?? 0)
}

function scheduleComposerMeasure() {
  if (composerMeasureFrame !== null) return
  composerMeasureFrame = requestAnimationFrame(measureComposerHeight)
}

function observeComposerHeight() {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  scheduleComposerMeasure()

  const composer = composerContainerRef.value
  if (!composer || typeof ResizeObserver === 'undefined') return

  composerResizeObserver = new ResizeObserver((entries) => {
    const entry = entries.find(item => item.target === composerContainerRef.value) ?? entries[0]
    if (!entry) return
    pendingComposerResizeHeight = getResizeEntryBlockSize(entry)
    applyPendingComposerResizeHeight()
  })
  composerResizeObserver.observe(composer, { box: 'border-box' })
}

function approveCurrentPermission(response: PermissionResponse = 'once') {
  const toolCall = currentPendingPermission.value?.toolCall
  if (!toolCall) return
  messageListRef.value?.confirmTool(toolCall, response)
}

function rejectCurrentPermission() {
  const toolCall = currentPendingPermission.value?.toolCall
  if (!toolCall) return
  messageListRef.value?.rejectTool(toolCall)
}

function rejectCurrentPermissionWithInstruction(reason?: string) {
  const toolCall = currentPendingPermission.value?.toolCall
  if (!toolCall) return
  messageListRef.value?.rejectTool(toolCall, reason)
}

async function waitForRestorePage(
  sessionId: string,
  anchorMessageId?: string,
  options: { allowEmptyTail?: boolean } = {},
) {
  for (let frame = 0; frame < RESTORE_WAIT_FRAME_LIMIT; frame += 1) {
    if (effectiveSessionId.value !== sessionId) return false
    const messages = chatStore.sessionMessages.get(sessionId) ?? []
    const pageState = chatStore.getSessionPageState(sessionId)
    const session = sessionsStore.getSessionItem(sessionId)
    const canRestoreEmptyTail = options.allowEmptyTail === true &&
      !anchorMessageId &&
      messages.length === 0 &&
      (
        sessionsStore.isNewChatDraftId(sessionId) ||
        pageState?.totalCount === 0 ||
        session?.messageCount === 0 ||
        (!isLoading.value && !pageState && typeof session?.messageCount !== 'number')
      )
    const hasRestoreMessages = messages.length > 0 || canRestoreEmptyTail
    const hasAnchor = !anchorMessageId || messages.some(message => message.id === anchorMessageId)
    if (!isLoading.value && hasRestoreMessages && hasAnchor) {
      await nextTick()
      return true
    }
    await nextFrame()
  }
  return effectiveSessionId.value === sessionId
}

function saveCurrentSnapshot(sessionId: string, prepareForSwitch = false) {
  const distanceToBottom = messageListRef.value?.getDistanceToBottom() ?? 0
  const isAtTail = distanceToBottom <= TAIL_SNAPSHOT_DISTANCE_PX
  const anchorMessageId = messageListRef.value?.getAnchorMessageId() ?? undefined
  const anchorOffset = messageListRef.value?.getAnchorOffset() ?? 0
  const navMessageId = messageListRef.value?.getNavMessageId() ?? undefined
  const hasNavigated = messageListRef.value?.getHasNavigated() ?? false
  const messageInput = inputBoxRef.value?.getMessageInput() ?? ''
  const quotedText = inputBoxRef.value?.getQuotedText() ?? ''
  const attachments = inputBoxRef.value?.getAttachments() ?? []

  if (prepareForSwitch) {
    messageListRef.value?.prepareForSwitch()
  }

  chatStore.saveSnapshot(sessionId, {
    mode: isAtTail || !anchorMessageId ? 'tail' : 'anchor',
    anchorMessageId: isAtTail ? undefined : anchorMessageId,
    offsetWithinMessage: isAtTail ? undefined : anchorOffset,
    navMessageId: isAtTail ? undefined : navMessageId,
    hasNavigated,
    messageInput,
    quotedText,
    attachments,
  })
}

async function restoreCurrentSnapshot(sessionId: string) {
  const snapshot = chatStore.getSnapshot(sessionId)
  if (!snapshot) {
    await waitForRestorePage(sessionId, undefined, { allowEmptyTail: true })
    if (effectiveSessionId.value !== sessionId) return false
    messageListRef.value?.restoreTail()
    return false
  }

  if (snapshot.mode === 'anchor') {
    await waitForRestorePage(sessionId, snapshot.anchorMessageId)
  }
  if (effectiveSessionId.value !== sessionId) return false

  if (snapshot.mode === 'anchor') {
    messageListRef.value?.restoreAnchor(snapshot)
  } else {
    messageListRef.value?.restoreTail()
  }

  if (effectiveSessionId.value !== sessionId) return false
  inputBoxRef.value?.restoreSnapshot(snapshot)
  return true
}

onMounted(() => {
  observeComposerHeight()
  observeContentColumn()
  const sessionId = effectiveSessionId.value
  if (sessionId) {
    restoreCurrentSnapshot(sessionId)
  }
})

onBeforeUnmount(() => {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  if (composerMeasureFrame !== null) {
    cancelAnimationFrame(composerMeasureFrame)
    composerMeasureFrame = null
  }
  contentColumnResizeObserver?.disconnect()
  contentColumnResizeObserver = null
  if (contentColumnMeasureFrame !== null) {
    cancelAnimationFrame(contentColumnMeasureFrame)
    contentColumnMeasureFrame = null
  }
  stopLayoutFollowLoop()

  const sessionId = effectiveSessionId.value
  if (sessionId) {
    saveCurrentSnapshot(sessionId)
  }
})

watch(
  () => [props.footerTarget, props.active] as const,
  () => {
    nextTick(() => {
      observeComposerHeight()
      scheduleContentColumnMeasure()
      messageListRef.value?.notifyLayoutChange?.()
    })
  },
  { flush: 'post' },
)

// While the sidebar (or another layout region) animates, re-measure every frame
// so the composer column tracks the moving layout instead of snapping afterwards.
function stopLayoutFollowLoop() {
  if (layoutFollowFrame !== null) {
    cancelAnimationFrame(layoutFollowFrame)
    layoutFollowFrame = null
  }
}

function runLayoutFollowLoop() {
  if (layoutFollowFrame !== null) return
  layoutFollowFrame = requestAnimationFrame(() => {
    layoutFollowFrame = null
    if (!props.layoutTransitioning) return
    const prevPanelLeft = lastMeasuredPanelLeft
    measureContentColumn()
    if (prevPanelLeft !== null && lastMeasuredPanelLeft !== null) {
      const delta = prevPanelLeft - lastMeasuredPanelLeft
      if (Math.abs(delta) >= 0.5) applyLayoutFlip(delta)
    }
    runLayoutFollowLoop()
  })
}

// The panel origin snaps in a single frame when the docked sidebar toggles
// (its width is deliberately discrete, see App.vue). Margin/width transitions
// on the composer children ease relative to the container, so without
// compensation the whole composer still jumps by the panel delta. FLIP: shift
// the container back by that delta, then release it on the same curve.
// Carrying the in-flight transform keeps re-toggles mid-animation smooth.
function applyLayoutFlip(delta: number) {
  const composer = composerContainerRef.value
  if (!composer) return
  const transform = getComputedStyle(composer).transform
  const carried = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0
  composer.style.transitionProperty = 'none'
  composer.style.transform = `translateX(${(delta + carried).toFixed(2)}px)`
  void composer.offsetWidth
  composer.style.transitionProperty = ''
  composer.style.transform = 'translateX(0px)'
}

function clearLayoutFlip() {
  const composer = composerContainerRef.value
  if (!composer) return
  composer.style.transitionProperty = ''
  composer.style.transform = ''
}

watch(
  () => props.layoutTransitioning,
  (isTransitioning) => {
    // Imperative class: the container sits behind a v-memo, so a reactive
    // :class binding would not re-render on this prop alone.
    const composer = composerContainerRef.value
    if (isTransitioning) {
      composer?.classList.add('is-layout-animating')
      runLayoutFollowLoop()
      return
    }
    stopLayoutFollowLoop()
    clearLayoutFlip()
    composer?.classList.remove('is-layout-animating')
    // Final true-up once the animation settles.
    scheduleContentColumnMeasure()
    scheduleComposerMeasure()
  },
)

// Session switch: save/restore scroll position and input state
watch(effectiveSessionId, async (newId, oldId) => {
  const start = performance.now()
  const oldMessageCount = oldId ? (chatStore.sessionMessages.get(oldId)?.length ?? 0) : 0
  const newMessageCount = newId ? (chatStore.sessionMessages.get(newId)?.length ?? 0) : 0
  if (oldId && oldId !== newId) {
    saveCurrentSnapshot(oldId, true)
  }

  const beforeTick = performance.now()
  await nextTick()
  const afterTick = performance.now()

  if (newId) {
    const hadSnapshot = !!chatStore.getSnapshot(newId)
    if (effectiveSessionId.value !== newId) return
    if (!hadSnapshot) {
      inputBoxRef.value?.clearInput()
    }
    await restoreCurrentSnapshot(newId)
    if (effectiveSessionId.value !== newId) return
  }

  requestAnimationFrame(() => {
    console.info('[Perf][SessionRender][ChatPanel]', {
      sessionId: newId,
      oldSessionId: oldId,
      totalToFirstFrameMs: Math.round(performance.now() - start),
      nextTickMs: Math.round(afterTick - beforeTick),
      oldMessageCount,
      newMessageCount,
      restoredSnapshot: !!(newId && chatStore.getSnapshot(newId)),
    })
  })
})

watch(() => panelMessages.value.length, () => {
  nextTick(observeContentColumn)
}, { flush: 'post' })

async function handleSendMessage(
  message: string,
  mode: 'send' | 'steer' | 'followup' = 'send',
  attachments?: MessageAttachment[],
  mentions?: ChatMessageMention[],
) {
  const session = currentSession.value
  if (!session) return
  // Note: do not scroll here. This runs before the message is in state, so it
  // would smooth-scroll against stale content and then fight MessageList's
  // new-user-message watcher (force-follow + instant setTail), producing a
  // visible "smooth then snap" double scroll. The watcher owns follow-on-send.
  if (mode === 'steer') {
    await chatSteerMessage(message)
  } else if (mode === 'followup') {
    await chatQueueFollowUpMessage(message)
  } else {
    // The quote rides out with THIS send and is consumed here — taking it
    // before the awaits keeps a second Enter from re-attaching it.
    const replyTo = pendingReplyTo.value ?? undefined
    pendingReplyTo.value = null
    if (sessionsStore.isNewChatDraftId(session.id)) {
      const materialized = await sessionsStore.materializeNewChatDraft(session.id, session.name || 'New Chat')
      if (!materialized) {
        // The input is already cleared; a silent return would discard the
        // message with zero feedback. The draft was restored, so surface a
        // visible error card in it.
        chatStore.addLocalMessage(session.id, {
          role: 'error',
          content: 'Failed to create the session — your message was not sent. Please try again.',
        })
        return
      }
      await chatStore.sendMessage(materialized.id, message, attachments, mentions ? { mentions } : undefined)
      return
    }
    await chatSendMessage(message, attachments, {
      ...(replyTo ? { replyTo } : {}),
      ...(mentions ? { mentions } : {}),
    })
  }
}

async function handleStopGeneration() {
  await chatStopGeneration()
}

function handleSwitchSession(sessionId: string) {
  emit('switchSession', sessionId)
}

function handleSetQuotedText(text: string) {
  inputBoxRef.value?.setQuotedText(text)
}

async function handleRegenerate(messageId: string) {
  if (!currentSession.value) return
  await chatRegenerate(messageId)
}

async function handleEditAndResend(messageId: string, newContent: string) {
  if (!currentSession.value) return
  await chatEditAndResend(messageId, newContent)
}

function handleSetInputText(text: string) {
  inputBoxRef.value?.setMessageInput(text)
}

function focusInput() {
  inputBoxRef.value?.focus()
}

function insertPromptReference(promptId: string) {
  inputBoxRef.value?.insertPromptReference(promptId)
}

function saveSnapshotForCurrentSession() {
  const sessionId = effectiveSessionId.value
  if (!sessionId) return false
  saveCurrentSnapshot(sessionId, false)
  return true
}

async function restoreSnapshotForCurrentSession() {
  const sessionId = effectiveSessionId.value
  if (!sessionId) return false
  return restoreCurrentSnapshot(sessionId)
}

async function scrollToMessage(messageId: string) {
  await nextTick()
  return messageListRef.value?.scrollToMessage?.(messageId) ?? false
}

defineExpose({
  focusInput,
  insertPromptReference,
  saveSnapshotForCurrentSession,
  restoreSnapshotForCurrentSession,
  scrollToMessage,
})
</script>

<style scoped>
.chat-panel {
  /* 上限拆成一枚变量,公式本身一字不动:展开后与改造前逐字符等价。
     以后要按外壳形态改聊天面宽度时**只准改 --content-measure /
     --chat-measure-cap 这两枚输入变量,不准直接写 --chat-content-width**
     —— `:root[data-shell-mode='workbench'] .chat-panel` 的特异性是 (0,3,1),
     会压过本文件末尾窄窗 `@media` 里 (0,1,0) 的 `.chat-panel` 覆盖,
     把 768 / 480 两个断点整个废掉。 */
  --chat-measure-cap: max(58%, calc(100% - 144px));
  --chat-content-width: min(var(--content-measure, 46rem), var(--chat-measure-cap));
  --chat-composer-width: var(--chat-content-width);
  --chat-composer-height: 0px;

  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.composer-container {
  flex-shrink: 0;
  padding: 0 0 16px;
  display: flex;
  flex-direction: column;
  /* flex-start, not center: the column children position themselves via the
     measured margin vars (auto margins still center the fallback). Centering
     would re-split leftover space in a single frame when the panel width
     snaps, defeating the animated margins below. */
  align-items: flex-start;
  background: transparent;
  position: relative;
  /* Above the message list's scroll-to-bottom button (z-index 4): composer
     flyouts (model picker, file picker) must never be overlapped by it. */
  z-index: 5;
}

/* S 状态带:与 composer 同一条测量出来的阅读列,chip 左沿对齐输入框左沿。
   零高度是它的静息态 —— 没有 padding、没有 min-height,成员全部离场时
   flex 容器自然塌成 0(`:empty` 只补那点与输入框之间的呼吸)。 */
.composer-container > .status-band {
  box-sizing: border-box;
  width: var(--chat-composer-width);
  margin: 0 var(--chat-content-column-right, auto) 0 var(--chat-content-column-left, auto);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* 超宽横向滚动,不换行(共享 Table 的 overflow-x 判例)。纵轴被连带变成
     auto 也无所谓:展开浮层已经 teleport 出去了。 */
  overflow-x: auto;
  scrollbar-width: none;
}

.composer-container > .status-band::-webkit-scrollbar {
  display: none;
}

.composer-container > .status-band:not(:empty) {
  padding: 2px 0 8px;
}

/* 插件块带穿 chip 壳后就是一组并排 chip,不再是纵向块列。 */
.composer-container > .status-band > :deep(.ui-slot-host[data-chip-shell]) {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

/* Agent 执行会话的只读说明:占输入框的位置,走同一条测量出来的阅读列,
   一行淡字,零填充零边框(§3.6)。 */
.composer-agent-note {
  box-sizing: border-box;
  width: var(--chat-composer-width);
  margin: 0 var(--chat-content-column-right, auto) 0 var(--chat-content-column-left, auto);
  padding: 10px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted-fg);
  user-select: none;
}

/* The typing line rides the same measured reading column as the composer it
   sits on, so the names start on the composer's left edge. */
.composer-container > :deep(.collab-typing) {
  box-sizing: border-box;
  width: var(--chat-composer-width);
  margin: 0 var(--chat-content-column-right, auto) 4px var(--chat-content-column-left, auto);
}

/* The pending quote rides the same measured column, right on the composer it
   will be sent with. */
.composer-container > :deep(.composer-reply) {
  box-sizing: border-box;
  width: var(--chat-composer-width);
  margin: 0 var(--chat-content-column-right, auto) 4px var(--chat-content-column-left, auto);
}

/* The docked sidebar snaps discretely (see App.vue), so the composer glides
   to its new column on its own; only while the layout toggle is animating,
   so live splitter drags keep tracking the cursor 1:1. The container transform
   carries the FLIP compensation for the panel-origin snap. */
.composer-container.is-layout-animating {
  transition: transform var(--app-sidebar-transition-duration, var(--duration-slow)) var(--app-sidebar-transition-ease, var(--ease-default));
}

.composer-container.is-layout-animating :deep(.composer-wrapper),
.composer-container.is-layout-animating .status-band,
.composer-container.is-layout-animating :deep(.collab-typing),
.composer-container.is-layout-animating :deep(.composer-reply),
.composer-container.is-layout-animating .session-permission-panel,
.composer-container.is-layout-animating .session-interaction-panel {
  transition:
    width var(--app-sidebar-transition-duration, var(--duration-slow)) var(--app-sidebar-transition-ease, var(--ease-default)),
    margin var(--app-sidebar-transition-duration, var(--duration-slow)) var(--app-sidebar-transition-ease, var(--ease-default));
}

@media (max-width: 768px) {
  .chat-panel {
    --chat-content-width: calc(100% - 48px);
  }
}

@media (max-width: 480px) {
  .chat-panel {
    --chat-content-width: calc(100% - 24px);
  }
}
</style>
