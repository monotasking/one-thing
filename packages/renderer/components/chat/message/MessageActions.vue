<template>
  <div
    :class="['actions', role === 'user' ? 'user-actions' : '', { visible }]"
    @mouseleave="disarmRegenerate"
  >
    <!-- Copy button -->
    <Tooltip :text="copied ? 'Copied!' : 'Copy'">
      <Button
        unstyled
        class="action-btn copy-btn"
        :aria-label="copied ? 'Copied!' : 'Copy'"
        @click="handleCopy"
      >
        <Check
          v-if="copied"
          :size="15"
          :stroke-width="2"
        />
        <Copy
          v-else
          :size="15"
          :stroke-width="1.5"
        />
      </Button>
    </Tooltip>

    <!-- Reply (rooms only): quotes this message into the composer. -->
    <Tooltip
      v-if="canReply"
      text="回复"
    >
      <Button
        unstyled
        class="action-btn reply-btn"
        aria-label="回复"
        @click.stop="emit('reply')"
      >
        <Reply
          :size="15"
          :stroke-width="1.5"
        />
      </Button>
    </Tooltip>

    <!-- Reaction (rooms only): the palette opens on click, one tap writes. -->
    <div
      v-if="canReact"
      ref="reactBtnRef"
      class="react-btn-wrapper"
    >
      <Tooltip text="表情回应">
        <Button
          unstyled
          class="action-btn react-btn"
          aria-label="表情回应"
          @click.stop="toggleReactPicker"
        >
          <SmilePlus
            :size="15"
            :stroke-width="1.5"
          />
        </Button>
      </Tooltip>
      <!-- 表情面板:坐标/翻转/钳制/外点/Esc 全部由浮层内核给(P6 收口),
           面走菜单档(波 4:面归位),这里只剩一排字形。 -->
      <Popover
        :open="showReactPicker"
        :anchor="reactBtnRef"
        placement="top-start"
        :offset="6"
        :margin="6"
        :z-offset="25"
        surface="menu"
        class="react-picker-surface"
        transition="none"
        :close-on="REACT_PICKER_CLOSE_ON"
        @update:open="setReactPicker"
      >
        <div class="react-picker">
          <button
            v-for="emoji in REACTION_EMOJIS"
            :key="emoji"
            type="button"
            class="react-picker-item"
            :aria-label="`回应 ${emoji}`"
            @click="pickReaction(emoji)"
          >
            {{ emoji }}
          </button>
        </div>
      </Popover>
    </div>

    <!-- Edit button for user messages -->
    <Tooltip
      v-if="role === 'user' && !mutationsDisabled"
      text="Edit"
    >
      <Button
        unstyled
        class="action-btn edit-btn"
        aria-label="Edit"
        @click.stop="emit('edit')"
      >
        <Pencil
          :size="15"
          :stroke-width="1.5"
        />
      </Button>
    </Tooltip>

    <!-- Regenerate button (for assistant messages) -->
    <Tooltip
      v-if="role === 'assistant' && !mutationsDisabled"
      :text="regenerateArmed ? 'Click again to regenerate' : 'Regenerate'"
    >
      <Button
        unstyled
        class="action-btn regenerate-btn"
        :class="{ armed: regenerateArmed }"
        :aria-label="regenerateArmed ? 'Click again to regenerate' : 'Regenerate'"
        @click="handleRegenerateClick"
      >
        <RefreshCw
          :size="15"
          :stroke-width="2"
        />
      </Button>
    </Tooltip>

    <!-- Speak button (for assistant messages with TTS support) -->
    <Tooltip
      v-if="role === 'assistant' && ttsSupported"
      :text="isCurrentlySpeaking ? 'Stop' : 'Speak'"
    >
      <Button
        unstyled
        class="action-btn speak-btn"
        :class="{ speaking: isCurrentlySpeaking }"
        :aria-label="isCurrentlySpeaking ? 'Stop' : 'Speak'"
        @click="handleSpeak"
      >
        <Pause
          v-if="isCurrentlySpeaking"
          :size="15"
          :stroke-width="2"
        />
        <Volume2
          v-else
          :size="15"
          :stroke-width="2"
        />
      </Button>
    </Tooltip>

    <!-- Downvote button (evals incident capture) -->
    <Tooltip
      v-if="role === 'assistant'"
      :text="downvoted ? 'Reported' : 'Report bad response'"
    >
      <Button
        ref="downvoteBtnRef"
        unstyled
        class="action-btn downvote-btn"
        :class="{ downvoted }"
        :aria-label="downvoted ? 'Reported' : 'Report bad response'"
        @click="handleDownvote"
      >
        <ThumbsDown
          :size="14"
          :stroke-width="downvoted ? 2.5 : 1.5"
        />
      </Button>
    </Tooltip>
    <!-- Downvote note popover: the one-liner is the only human input the
         eval system asks for — it becomes the incident's expectation/rubric.
         Esc/外点关闭由内核给;`closeOn.scroll` 特意关着,滚一下就丢掉半句话
         不是这个面板该有的行为(内核改为跟随重定位)。 -->
    <Popover
      :open="showDownvoteNote"
      :anchor="downvoteBtnRef"
      placement="bottom-start"
      :offset="6"
      :z-offset="25"
      surface="elevated"
      class="downvote-note-surface"
      transition="none"
      :close-on="DOWNVOTE_NOTE_CLOSE_ON"
      @update:open="setDownvoteNote"
      @positioned="focusDownvoteNoteInput"
    >
      <div class="downvote-note-panel">
        <textarea
          ref="downvoteNoteInput"
          v-model="downvoteNote"
          class="downvote-note-input"
          rows="2"
          placeholder="哪里不对 / 应该怎么做?(可选,一句话)"
          @keydown.enter.exact.prevent="submitDownvote()"
        />
        <div class="downvote-note-actions">
          <Button
            unstyled
            class="downvote-note-btn secondary"
            @click="submitDownvote(true)"
          >
            跳过
          </Button>
          <Button
            unstyled
            class="downvote-note-btn primary"
            @click="submitDownvote()"
          >
            记录事故
          </Button>
        </div>
      </div>
    </Popover>

    <!-- Branch button (for assistant messages) -->
    <Tooltip
      v-if="role === 'assistant' && !mutationsDisabled"
      :text="hasBranches ? `${branchCount} branch${branchCount > 1 ? 'es' : ''}` : 'Branch'"
    >
      <div
        ref="branchBtnRef"
        class="branch-btn-wrapper"
      >
        <Button
          unstyled
          class="action-btn"
          :class="{ 'has-branches': hasBranches }"
          :aria-label="hasBranches ? `${branchCount} branch${branchCount > 1 ? 'es' : ''}` : 'Branch'"
          @click="hasBranches ? toggleBranchMenu() : emit('branch')"
        >
          <GitBranch
            :size="15"
            :stroke-width="2"
          />
          <span
            v-if="hasBranches"
            class="branch-count-badge"
          >{{ branchCount }}</span>
        </Button>
        <!-- Branch dropdown menu. P1: 坐标/翻转/外点关闭全部由 Dropdown 内核给,
             这里只剩内容与菜单语义(role=menuitem 让键盘导航能找到行)。 -->
        <Dropdown
          :open="showBranchMenu && hasBranches"
          class="branch-menu"
          :anchor="branchBtnRef"
          :offset="8"
          :z-offset="25"
          :min-width="180"
          transition="none"
          aria-label="Branches"
          @update:open="setBranchMenu"
        >
          <div class="branch-menu-list">
            <Button
              v-for="branch in branches"
              :key="branch.id"
              unstyled
              class="branch-menu-item"
              role="menuitem"
              @click="handleGoToBranch(branch.id)"
            >
              <span class="branch-name">{{ branch.name || 'Untitled branch' }}</span>
              <ChevronRight
                :size="12"
                :stroke-width="2"
              />
            </Button>
          </div>
          <div class="branch-menu-footer">
            <Button
              unstyled
              class="branch-menu-new"
              role="menuitem"
              @click="handleNewBranch"
            >
              <Plus
                :size="12"
                :stroke-width="2"
              />
              <span>New branch</span>
            </Button>
          </div>
        </Dropdown>
      </div>
    </Tooltip>

    <!-- Regenerate button for user messages -->
    <Tooltip
      v-if="role === 'user' && !mutationsDisabled"
      :text="regenerateArmed ? 'Click again to regenerate' : 'Regenerate response'"
    >
      <Button
        unstyled
        class="action-btn regenerate-btn"
        :class="{ armed: regenerateArmed }"
        :aria-label="regenerateArmed ? 'Click again to regenerate' : 'Regenerate'"
        @click="handleRegenerateClick"
      >
        <RefreshCw
          :size="15"
          :stroke-width="2"
        />
      </Button>
    </Tooltip>

    <!-- More menu button (for assistant messages) -->
    <div
      v-if="role === 'assistant'"
      ref="moreBtnRef"
      class="more-btn-wrapper"
    >
      <Tooltip text="More">
        <Button
          unstyled
          class="action-btn more-btn"
          aria-label="More"
          @click.stop="toggleMoreMenu"
        >
          <MoreHorizontal
            :size="15"
            :stroke-width="2"
          />
        </Button>
      </Tooltip>
      <!-- More menu dropdown (P1: Dropdown 内核;弹层不再自己算 rect) -->
      <Dropdown
        :open="showMoreMenu"
        class="more-menu"
        :anchor="moreBtnRef"
        :offset="4"
        :z-offset="25"
        :min-width="180"
        transition="none"
        aria-label="More"
        @update:open="setMoreMenu"
      >
        <!-- Action items -->
        <div class="more-menu-actions">
          <Button
            unstyled
            class="more-menu-item"
            role="menuitem"
            @click="handleViewTokenUsage"
          >
            <Hash
              :size="14"
              :stroke-width="2"
            />
            <span>Token usage</span>
            <span
              v-if="usage"
              class="more-menu-item-badge"
            >{{ formatCompact(usage.totalTokens) }}</span>
          </Button>
          <!-- 触发式锚点 message.actions(D 期):插件项直排在内置项之后,
               文案就是 manifest 的 label(v1 静态)。点击 → 关菜单、开弹层
               (弹层锚到 ⋯ 按钮,ctx 带 {sessionId, messageId})。
               入口是菜单项,内容住在另一层浮层里 —— 二者永不嵌套。 -->
          <Button
            v-for="entry in pluginEntries"
            :key="pluginEntryKey(entry)"
            unstyled
            class="more-menu-item"
            :class="{ 'is-paused': isPluginTriggerPaused(entry) }"
            role="menuitem"
            @click="openPluginTrigger(entry)"
          >
            <Puzzle
              :size="14"
              :stroke-width="2"
            />
            <span>{{ entry.label }}</span>
            <span
              v-if="isPluginTriggerPaused(entry)"
              class="more-menu-item-badge"
            >已暂停</span>
          </Button>
          <!-- 超容量折叠(message.actions 容量 3):与失败块同规,只报个数,
               详情在设置页 —— 菜单不是解释插件问题的地方。 -->
          <div
            v-if="pluginTruncated.length"
            class="more-menu-folded"
          >
            +{{ pluginTruncated.length }} 个插件项已折叠
          </div>
        </div>

        <!-- Info section (shown when expanded) -->
        <div
          v-if="showTokenDetails && usage"
          class="more-menu-details"
        >
          <div class="token-detail-row">
            <span>Input</span>
            <span>{{ formatNumber(usage.inputTokens) }}</span>
          </div>
          <div class="token-detail-row">
            <span>Output</span>
            <span>{{ formatNumber(usage.outputTokens) }}</span>
          </div>
          <div
            v-if="outputSpeed"
            class="token-detail-row speed"
          >
            <span>Speed</span>
            <span>{{ outputSpeed }} tok/s</span>
          </div>
          <div
            v-if="model"
            class="token-detail-row model"
          >
            <span>Model</span>
            <span>{{ model }}</span>
          </div>
        </div>
      </Dropdown>
      <!-- 插件弹层住在 Dropdown **之外**:菜单与弹层是两层浮层,内核只按
           "点到不到我身上"判外点,弹层若长在菜单里,点它就会先把菜单关掉,
           连着把弹层一起卸载。锚到 ⋯ 按钮 —— 它是这条消息上不会消失的宿主元素。 -->
      <PluginTriggerPopover
        :entry="pluginOpenEntry"
        :anchor-el="pluginOpenAnchorEl"
        :session-id="sessionId ?? null"
        :message-id="messageId"
        :max-height="pluginTriggerMaxHeight"
        placement="bottom-end"
        @close="closePluginTrigger"
        @state="notePluginTriggerState"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { ref, computed, nextTick, onUnmounted } from 'vue'
import Dropdown from '@/components/common/Dropdown.vue'
import Popover from '@/components/common/Popover.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import PluginTriggerPopover from '@/components/plugins/PluginTriggerPopover.vue'
import { usePluginTriggerEntries } from '@/components/plugins/usePluginTriggerEntries'
import type { PluginContributedUiSlot } from '@/workspace/ui-anchor-registry'
import { useTTS } from '@/composables/useTTS'
import { stripMarkdown } from '@/composables/useMarkdownRenderer'
import { copyTextToClipboard } from '@/utils/clipboard'
import { platformApi } from '@/platform'
import { evalsApi } from '@/platform/evals-client'
import { useEvalsWorkbenchStore } from '@/stores/evalsWorkbench'
import { COLLAB_REACTION_EMOJIS } from '@onething/runtime/collab'
import { getLogger } from '@/services/log'
import {
  Copy,
  Check,
  Pencil,
  RefreshCw,
  Reply,
  SmilePlus,
  Volume2,
  Pause,
  GitBranch,
  ChevronRight,
  Plus,
  MoreHorizontal,
  Hash,
  Puzzle,
  ThumbsDown,
} from 'lucide-vue-next'

interface BranchInfo {
  id: string
  name: string
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs?: number
}

const log = getLogger('renderer.message-actions')

interface Props {
  role: 'user' | 'assistant'
  content: string
  visible: boolean
  isStreaming?: boolean
  branches?: BranchInfo[]
  usage?: TokenUsage
  model?: string
  messageId: string
  sessionId?: string
  /**
   * Collab rooms: edit/regenerate/branch are meaningless (persona replay is
   * undefined and the engine refuses them) — hide the mutating actions while
   * keeping copy/TTS/usage (docs/design/multi-agent-collab.md D2/§8).
   */
  mutationsDisabled?: boolean
  /**
   * Collab rooms only (W7, §3.5 A): quoting a message into the composer is an
   * IM affordance, so ordinary sessions never grow the button.
   */
  canReply?: boolean
  /**
   * Collab rooms only (W8, §3.5 B): same reasoning as canReply — an ordinary
   * session has nobody to react AT, so it never grows the button either.
   */
  canReact?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  copy: []
  reply: []
  /** Rooms: one palette emoji was picked (§3.5 B). */
  react: [emoji: string]
  edit: []
  regenerate: []
  branch: []
  goToBranch: [sessionId: string]
  menuOpen: [isOpen: boolean]
  downvote: []
}>()

const workbenchStore = useEvalsWorkbenchStore()

// TTS
const { isSupported: ttsSupported, isSpeaking, speak, stop } = useTTS()
const speakingMessageId = ref<string | null>(null)

const isCurrentlySpeaking = computed(() =>
  isSpeaking.value && speakingMessageId.value === props.messageId
)

async function handleSpeak() {
  if (isCurrentlySpeaking.value) {
    stop()
    speakingMessageId.value = null
    return
  }

  stop()
  const textContent = stripMarkdown(props.content)
  if (!textContent) return

  speakingMessageId.value = props.messageId

  try {
    await speak(textContent)
  } catch (error) {
    log.error('tts speak failed', { messageId: props.messageId }, error)
  } finally {
    speakingMessageId.value = null
  }
}

// Copy
const copied = ref(false)

async function handleCopy() {
  const success = await copyTextToClipboard(props.content)
  if (!success) {
    log.warn('message copy failed', { messageId: props.messageId })
    return
  }

  copied.value = true
  emit('copy')
  setTimeout(() => {
    copied.value = false
  }, 2000)
}

// Downvote (evals incident capture)
const downvoted = ref(false)
const showDownvoteNote = ref(false)
const downvoteNote = ref('')
const downvoteBtnRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null)
const downvoteNoteInput = ref<HTMLTextAreaElement | null>(null)

/** Frozen so the prop identity never changes — a fresh object every render
 *  would re-run the kernel's `closeOn` getter for nothing. */
const DOWNVOTE_NOTE_CLOSE_ON = { esc: true, outside: true } as const

/** Single door for the panel's open state (same shape as the two menus): the
 *  kernel's own dismissals (Esc / outside) come back through here, so the note
 *  is cleared exactly once no matter who closed it. */
function setDownvoteNote(open: boolean) {
  if (showDownvoteNote.value === open) return
  showDownvoteNote.value = open
  if (!open) downvoteNote.value = ''
  else awaitingNoteFocus = true
}

/**
 * 打开后焦点落输入框(RejectReasonDialog 的同一条要求)。
 *
 * 挂上 `@positioned` 而不是 RejectReasonDialog 那套 `nextTick` —— 内核在量出
 * 坐标之前会给浮层挂 `visibility: hidden`,而 `focus()` 打在 hidden 元素上是
 * 空操作(真机实测:焦点留在 body)。`positioned` 正是"量完了、看得见了"这一刻,
 * 每次重定位都会再发,所以要用一次性闸门,免得滚动重排把焦点抢回来。
 */
let awaitingNoteFocus = false

function focusDownvoteNoteInput() {
  if (!awaitingNoteFocus) return
  awaitingNoteFocus = false
  void nextTick(() => downvoteNoteInput.value?.focus())
}

function handleDownvote() {
  if (downvoted.value) return
  if (!props.sessionId) {
    log.error('downvote recording failed, no sessionId on this message', { messageId: props.messageId })
    return
  }
  setDownvoteNote(!showDownvoteNote.value)
}

async function submitDownvote(skipNote = false) {
  if (!props.sessionId) return
  const note = skipNote ? undefined : downvoteNote.value.trim() || undefined
  setDownvoteNote(false)

  try {
    const result = await evalsApi.recordDownvote({
      sessionId: props.sessionId,
      turnId: props.messageId,
      userMessage: props.content,
      note,
    })
    downvoted.value = true
    emit('downvote')
    // The incident is created quietly; the workbench stays out of the way
    // (open it later from Settings → Evals when reviewing incidents).
    if (result.success && result.incidentId) {
      workbenchStore.notePendingIncident(result.incidentId)
    }
  } catch (error) {
    log.error('downvote recording failed', { sessionId: props.sessionId, messageId: props.messageId }, error)
  }
}

// Reaction palette (§3.5 B). Six emoji, one row, one tap — deliberately not a
// full emoji picker: the room's vocabulary is fixed so the agent half of the
// feature (judgement react) and the human half can never disagree.
const REACTION_EMOJIS = COLLAB_REACTION_EMOJIS
const showReactPicker = ref(false)
const reactBtnRef = ref<HTMLElement | null>(null)

/** `placement="top-start"` + flip reproduces the old hand-rolled rule verbatim:
 *  prefer above the row (the message underneath must stay readable), drop below
 *  only when there is no room up top. Scroll dismisses — the palette hangs off a
 *  hover-revealed button that the scroll is about to take away anyway. */
const REACT_PICKER_CLOSE_ON = { esc: true, outside: true, scroll: true } as const

function setReactPicker(open: boolean) {
  if (showReactPicker.value === open) return
  showReactPicker.value = open
  emit('menuOpen', open)
}

function toggleReactPicker() {
  setReactPicker(!showReactPicker.value)
}

function pickReaction(emoji: string) {
  setReactPicker(false)
  emit('react', emoji)
}

// Branch menu
const showBranchMenu = ref(false)
const branchBtnRef = ref<HTMLElement | null>(null)

const hasBranches = computed(() => props.branches && props.branches.length > 0)
const branchCount = computed(() => props.branches?.length || 0)

/** Single door for the open state: the Dropdown reports its own dismissals
 *  (Esc / outside / scroll) through the same function the button uses, so the
 *  hover bar's `menuOpen` flag can never drift out of sync with the menu. */
function setBranchMenu(open: boolean) {
  if (showBranchMenu.value === open) return
  showBranchMenu.value = open
  emit('menuOpen', open)
}

function toggleBranchMenu() {
  setBranchMenu(!showBranchMenu.value)
}

function handleGoToBranch(sessionId: string) {
  setBranchMenu(false)
  emit('goToBranch', sessionId)
}

function handleNewBranch() {
  setBranchMenu(false)
  emit('branch')
}

// More menu
const showMoreMenu = ref(false)
const showTokenDetails = ref(false)
const moreBtnRef = ref<HTMLElement | null>(null)

// Note: We don't auto-close menus when `visible` changes because the menu is
// teleported to body and the pointer has to be able to travel to it. Dismissal
// is the floating kernel's job (Esc / outside press / scroll).

function handleViewTokenUsage() {
  showTokenDetails.value = !showTokenDetails.value
}

function formatCompact(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

// Calculate output speed in tokens/second
const outputSpeed = computed(() => {
  if (!props.usage?.durationMs || props.usage.durationMs <= 0) return null
  const seconds = props.usage.durationMs / 1000
  return (props.usage.outputTokens / seconds).toFixed(1)
})

function setMoreMenu(open: boolean) {
  if (showMoreMenu.value === open) return
  showMoreMenu.value = open
  if (!open) showTokenDetails.value = false
  emit('menuOpen', open)
}

function toggleMoreMenu() {
  setMoreMenu(!showMoreMenu.value)
}

// ── 触发式锚点 message.actions(D 期) ──────────────────────────────
// 清单/顺序/容量裁决全部来自 ui-anchor-registry 的既有投影(与常显块同一份);
// 这里只管开合与"哪个入口灰了"。
const {
  entries: pluginEntries,
  truncated: pluginTruncated,
  openEntry: pluginOpenEntry,
  openAnchorEl: pluginOpenAnchorEl,
  maxHeight: pluginTriggerMaxHeight,
  entryKey: pluginEntryKey,
  isPaused: isPluginTriggerPaused,
  toggle: togglePluginTrigger,
  close: closePluginTriggerState,
  noteState: notePluginTriggerStateFor,
} = usePluginTriggerEntries('message.actions')

function openPluginTrigger(entry: PluginContributedUiSlot) {
  const opened = togglePluginTrigger(entry, moreBtnRef.value)
  // 菜单先退场(见模板注释),再把"这条消息上还有浮层开着"报给悬停行,
  // 否则操作行会在指针离开时淡出,弹层就悬在半空没有锚。
  setMoreMenu(false)
  emit('menuOpen', opened)
}

function closePluginTrigger() {
  closePluginTriggerState()
  emit('menuOpen', false)
}

function notePluginTriggerState(state: { degraded: boolean; error: boolean }) {
  const entry = pluginOpenEntry.value
  if (entry) notePluginTriggerStateFor(entry, state)
}

function formatNumber(num: number): string {
  return num.toLocaleString()
}

// P6:最后一处手写 document click 监听随表情面板一起删除 —— 这个组件里的四层
// (branch / more / 表情 / 踩后备注)现在全部由浮层内核负责关闭。

// 重新生成会丢弃已有回复,误触代价不小 —— 第一次点只把按钮"上膛",
// 第二次点才真的重来。指针移开这一行或几秒不动都会自动撤销。
const REGENERATE_ARM_TIMEOUT_MS = 4000
const regenerateArmed = ref(false)
let regenerateArmTimer: ReturnType<typeof setTimeout> | null = null

function disarmRegenerate() {
  regenerateArmed.value = false
  if (regenerateArmTimer) {
    clearTimeout(regenerateArmTimer)
    regenerateArmTimer = null
  }
}

function handleRegenerateClick() {
  if (regenerateArmed.value) {
    disarmRegenerate()
    emit('regenerate')
    return
  }
  regenerateArmed.value = true
  if (regenerateArmTimer) clearTimeout(regenerateArmTimer)
  regenerateArmTimer = setTimeout(disarmRegenerate, REGENERATE_ARM_TIMEOUT_MS)
}

onUnmounted(disarmRegenerate)
</script>

<style scoped>
.actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
  height: 28px;
  min-height: 28px;
  align-items: center;
  line-height: 0;
}

.actions.visible {
  opacity: 1;
}

.actions :deep(.tooltip-wrapper) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  line-height: 0;
}

.action-btn {
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  line-height: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease-default);
  flex: 0 0 28px;
  position: relative;
}

/* 底走 G6 的「叠 accent 淡底」档 —— 配方就是 accent 10%,与这里原来手写的百分比
   逐字相同;字仍是 accent 本色,两个通道各自独立。
   如实记:token 是以 panel 面解析出的**实色**,而原来的 10% 是半透明叠在 chat
   面上,18 主题实测 ΔRGB 中位 11.2,hover 底相对 chat 面的可见度从中位 10.9 升到
   30 —— 不是配方变了,是 `--ui-state-*` 全族"一窗一值、以 panel 为基"的固有性质。
   同一条消息旁边的 ChatHeader / composer 按钮早就在 chat 面上画 panel 解析的
   `--ui-state-hover-bg`,迁过来是让操作条回到邻居的同一套解析,不是新造观感。 */
.action-btn:hover {
  background: var(--ui-state-hover-accent-bg);
  color: var(--ui-accent-primary-fg);
}

.action-btn:active {
  transform: scale(0.92);
}

.action-btn svg {
  width: 15px;
  height: 15px;
  display: block;
  flex: 0 0 15px;
}

/* Regenerate button animation */
.regenerate-btn svg {
  transition: transform var(--duration-slow) var(--ease-default);
}

.regenerate-btn:hover svg {
  transform: rotate(180deg);
}

/* 上膛态:强调色 + 停在半圈,和普通 hover 明确区分开。 */
.regenerate-btn.armed svg {
  color: var(--ui-accent-primary-fg);
  transform: rotate(180deg);
}

.regenerate-btn.armed {
  color: var(--ui-accent-primary-fg);
}

/* Downvote button */
/* 面归位(波 4):这是一张"读一段字 + 填一句话"的任务卡,走 Popover 的
   `elevated` 档 —— 面色/边框/圆角/投影四项从这里搬进了组件,只剩排版。
   (投影原是字面 `0 8px 24px rgba(0,0,0,.18)`,不跟主题;档位给的是
   `--shadow-elevated`。) */
.downvote-note-panel {
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.downvote-note-input {
  width: 100%;
  resize: vertical;
  min-height: 44px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--ui-border-default-border);
  background: var(--ui-surface-input-bg);
  color: var(--ui-text-primary-fg);
  font-size: 12.5px;
  line-height: 1.5;
  font-family: inherit;
}

.downvote-note-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.downvote-note-btn {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.downvote-note-btn.secondary {
  color: var(--ui-text-secondary-fg);
}

.downvote-note-btn.primary {
  background: var(--ui-status-danger-bg);
  color: var(--ui-status-danger-fg, var(--color-danger));
  border: 1px solid var(--ui-status-danger-border);
}

.downvote-btn.downvoted {
  color: var(--ui-accent-primary-fg);
}

/* 已表态的按钮 hover 要比普通按钮压得住:走同族的重档(配方 accent 16%,原手写
   15%,ΔRGB 中位 12.2)。阶梯 18/18 主题实测仍单调 —— 重档离 chat 面的距离
   (中位 41)始终大于淡档(中位 30)。 */
.downvote-btn.downvoted:hover {
  background: var(--ui-state-hover-accent-strong-bg);
}

/* Copy button success state - when showing check icon */
.copy-btn:has(.lucide-check) {
  color: var(--ui-accent-primary-fg);
}

/* Speak button speaking state */
.speak-btn.speaking {
  color: var(--ui-accent-primary-fg);
}

/* 同「已表态」的那一档(见上),同一枚 token —— 两处原本各写一次 15%。 */
.speak-btn.speaking:hover {
  background: var(--ui-state-hover-accent-strong-bg);
}

/* Branch button with count */
.branch-btn-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  line-height: 0;
}

.action-btn.has-branches {
  color: var(--ui-accent-primary-fg);
}

.branch-count-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  background: var(--ui-accent-primary-fg);
  color: white;
  font-size: 10px;
  font-weight: 600;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Branch menu: the surface itself moved to the global block below — it is drawn
   on the Dropdown's root, which is teleported and therefore out of this scope.
   The rows stay here: slot content keeps the parent's scope id wherever it is
   teleported to. */
.branch-menu-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 4px;
}

.branch-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-size: 13px;
  text-align: left;
  border-radius: 8px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

/* 波 3 记的"面还没归位"四处,波 4 面归位后一并迁入统一态 token:三个菜单项走
   G6 的「叠 accent 淡底」档(配方与原来手写的 10% 同源),react-picker-item 走
   中性档。当时不迁的理由(面是 `:surface="false"` 的自绘玻璃面,统一 token 以
   panel 面解析,Δ中位 21.6 / 27.5)随着面搬进 Dropdown/Popover 档位而消失。 */
.branch-menu-item:hover {
  background: var(--ui-state-hover-accent-bg);
}

.branch-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-menu-footer {
  padding: 4px;
  border-top: 1px solid var(--ui-border-default-border);
}

.branch-menu-new {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--ui-accent-primary-fg);
  font-size: 13px;
  border-radius: 8px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.branch-menu-new:hover {
  background: var(--ui-state-hover-accent-bg);
}

/* Reaction palette (§3.6): a hairline strip of glyphs. No fill, no shadow
   stack, no bounce — hover moves the ink behind the emoji, nothing else.
   波 4:面色/边框搬到 Popover 的 `menu` 档(见全局块里的 `.react-picker-surface`
   三条几何覆写),这里只剩排布与进场。 */
.react-picker {
  display: flex;
  gap: 2px;
  animation: reactPickerIn 0.12s ease-out;
}

@keyframes reactPickerIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.react-picker-item {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.react-picker-item:hover {
  background: var(--ui-state-hover-bg);
}

/* Reaction palette trigger (§3.5 B) */
.react-btn-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  line-height: 0;
}

/* More menu */
.more-btn-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  line-height: 0;
}
</style>

<!-- Global styles for Teleported menu -->
<style>
/* 消息浮层族的三张面(波 4「浮面皮肤收口 G1」)。
 *
 * 面色 / 边框 / 圆角 / 投影四项全部搬进了组件档位 —— Dropdown 的缺省档就是菜单面
 * (`.app-context-menu.is-surface`),表情条是 Popover 的 `menu` 档。这里只剩**几何
 * 与进场**:窗宽、贴边、动画,以及一枚 `--app-context-padding: 0`(菜单里是自带
 * padding 的滚动列表,不要档位再多包一圈)。
 *
 * 观感差异如实记(三张面原本各画各的):底 floating → menu(2026-08-09 拍板:
 * 输入区一带的浮层统一菜单面,floating 在夜间亮一档);边 strong → subtle;
 * branch 圆角 12 → 10;投影 `--shadow-floating` → `--ui-surface-tooltip-shadow`;
 * `backdrop-filter: blur(20px)` 交给壁纸 E 级统一的磨砂(自绘那层在非壁纸模式下
 * 什么也没糊到,底本来就是不透明的)。族色区分保持:菜单族 = 菜单面。
 *
 * 坐标与层级仍由内核给(zOffset 25 = 消息级浮层档,压过 Select/Mention +20 与
 * 表格筛选 +24)。 */
.branch-menu {
  --app-context-padding: 0;
  max-width: 280px;
  overflow: hidden;
  animation: menuSlideIn 0.15s ease-out;
}

/* 表情条:面走 `menu` 档,但它刻意是**一条发丝细带**而不是一张卡 —— 4px 直角、
   零投影、3/4px 的紧内边距三条是形,不是皮肤,用实例变量原样留住。 */
.react-picker-surface {
  --app-popover-padding: 3px 4px;
  --app-popover-radius: 4px;
  --app-popover-shadow: none;
}

/* 事故记录卡:`elevated` 档 + 原来的 10px 内边距(档位只管面,不管几何)。 */
.downvote-note-surface {
  --app-popover-padding: 10px;
}

@keyframes menuSlideIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.more-menu {
  --app-context-padding: 0;
  min-width: 180px;
  overflow: hidden;
  animation: moreMenuSlideIn 0.15s ease-out;
}

@keyframes moreMenuSlideIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.more-menu-actions {
  padding: 4px;
}

.more-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-size: 13px;
  text-align: left;
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.more-menu-item:hover {
  background: var(--ui-state-hover-accent-bg);
}

.more-menu-item-badge {
  margin-left: auto;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  font-variant-numeric: tabular-nums;
}

/* 降级过的插件项:**置灰不消失**(§9.3 第 4 条)。用户该知道"这里有个坏了的
   插件项",点进去看降级态并可再试一次 —— 所以它照常可点,只是收掉墨色。 */
.more-menu-item.is-paused {
  color: var(--ui-text-muted-fg);
}

/* 超容量折叠的计数行:纯说明,不可点。 */
.more-menu-folded {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

.more-menu-details {
  padding: 8px 12px;
  border-top: 1px solid var(--ui-border-default-border);
  background: rgba(0, 0, 0, 0.02);
}

.token-detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 3px 0;
}

.token-detail-row span:first-child {
  color: var(--ui-text-muted-fg);
}

.token-detail-row span:last-child {
  color: var(--ui-text-primary-fg);
  font-variant-numeric: tabular-nums;
}

.token-detail-row.model span:last-child {
  font-size: 11px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
