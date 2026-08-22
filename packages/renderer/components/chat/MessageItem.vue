<template>
  <div
    class="message-item-wrapper"
    :class="{ 'is-room-row': roomMode, 'is-room-stacked': isRoomStacked }"
  >
    <!-- Error message -->
    <MessageError
      v-if="message.role === 'error'"
      :content="message.content"
      :error-details="message.errorDetails"
      :timestamp="message.timestamp"
      :session-id="message.sessionId"
      :message-id="message.id"
    />

    <!-- Room system notice (§3.6, W15): task lifecycle, membership, budget
         freeze. In a room these are bookkeeping, not announcements — the
         generic card below is what the user called AI slop. Everywhere else
         the card is untouched. -->
    <RoomNoticeLine
      v-else-if="isRoomSystemNotice"
      :content="message.content"
    />

    <!-- System message (e.g., /files command output) -->
    <MessageSystem
      v-else-if="message.role === 'system'"
      :content="message.content"
      :timestamp="message.timestamp"
      :session-id="message.sessionId"
      :message-id="message.id"
    />

    <!-- Goal declaration: the /goal command's user message, framed -->
    <GoalSetMessage
      v-else-if="isGoalSet"
      :message="message"
    />

    <!-- Goal continuation: engine-injected user message, a blueprint tick -->
    <GoalContinuationLine
      v-else-if="isGoalInjected"
      :content="message.content"
      :timestamp="message.timestamp"
    />

    <!-- Collab activation drive: coordinator-injected, folded to a readable
         hairline showing WHO was activated and why — never the goal NUDGE. -->
    <div
      v-else-if="isCollabInjected"
      class="collab-drive-line"
    >
      {{ collabDriveLabel }}
    </div>

    <!-- Collab thinking record (W14b): the turn itself is no longer speech,
         so it folds to one hairline that unfolds into the full turn body.
         Deliberately BEFORE the pass branch — a W14b turn never means [pass],
         and a thinking record must never render as "选择不发言". -->
    <CollabThinkingTrace
      v-else-if="isRoomThinkingRecord"
      :message="message"
      @open-file="(filePath) => emit('openFile', filePath)"
    />

    <!-- Collab pass turn: the activated agent chose silence (§6.4).
         During the streaming hold window render a neutral ellipsis. -->
    <div
      v-else-if="isCollabPass || isCollabPassHold"
      class="collab-pass-line"
      :class="{ 'is-room': isRoomAgentMessage }"
    >
      {{ isCollabPass ? `${collabSenderName} 选择不发言` : '…' }}
    </div>

    <!-- Normal user/assistant message -->
    <div
      v-else
      :class="[
        'message',
        message.role,
        { highlighted: isHighlighted, steered: isSteered, 'is-room-agent': isRoomAgentMessage },
      ]"
      :data-message-id="message.id"
    >
      <!-- Room gutter: the emoji chip marks who is speaking, once per group.
           The column stays behind on continued messages so the whole group
           hangs off one axis. -->
      <div
        v-if="isRoomAgentMessage"
        class="room-avatar-col"
        :aria-hidden="canOpenAgentSpace ? undefined : 'true'"
      >
        <!-- 群里认识的人,点头像就进 TA 的空间(agent-im-chat-ui.md C3)——
             头像与署名是同一个入口。 -->
        <button
          v-if="groupHead && canOpenAgentSpace"
          type="button"
          class="room-avatar-btn"
          :aria-label="`${collabSenderName} 的空间`"
          @click="openAgentSpace"
        >
          <AgentAvatar
            class="room-avatar"
            :avatar="collabSender?.avatar"
            :avatar-image="collabSender?.avatarImage"
            :size="28"
          />
        </button>
        <AgentAvatar
          v-else-if="groupHead"
          class="room-avatar"
          :avatar="collabSender?.avatar"
          :avatar-image="collabSender?.avatarImage"
          :size="28"
        />
      </div>

      <div
        class="message-content-wrapper"
      >
        <!-- Collab room: assistant persona signature. In a room it names the
             speaker for the whole group (the chip carries the emoji), so it
             appears on the group head only. -->
        <div
          v-if="collabSender && (!isRoomAgentMessage || groupHead) && (!dmMode || groupCollapsible)"
          class="collab-sender"
          :class="{ 'is-room': isRoomAgentMessage, 'is-dm': dmMode, 'is-retired': collabSender.isRetired }"
        >
          <!-- 私聊房(§4.3)收掉署名本身,但这一行还得留着当折叠把手的家 ——
               把手没了,长发言块在私聊里就折不起来了。 -->
          <template v-if="!dmMode">
            <AgentAvatar
              v-if="!isRoomAgentMessage"
              class="collab-sender-avatar"
              :avatar="collabSender.avatar"
              :avatar-image="collabSender.avatarImage"
              :size="14"
            />
            <button
              v-if="canOpenAgentSpace"
              type="button"
              class="collab-sender-name is-contact"
              :aria-label="`${collabSender.name} · 打开空间`"
              @click="openAgentSpace"
            >
              {{ collabSender.name }}
            </button>
            <span
              v-else
              class="collab-sender-name"
            >{{ collabSender.name }}</span>
            <span
              v-if="collabSender.title"
              class="collab-sender-title"
            >{{ collabSender.title }}</span>
            <!-- 墓碑徽标(域模型 §3.2):这个人退休了,这句话还在。 -->
            <span
              v-if="collabSender.isRetired"
              class="collab-sender-retired"
            >已注销</span>
          </template>

          <!-- Fold this whole utterance block (P1-2). Lives next to the
               signature because the signature is what names the block: one
               hairline caret, no chip and no frame — the same idiom as the
               thinking trace. Folded, it says how many messages are behind it. -->
          <button
            v-if="groupCollapsible"
            type="button"
            class="room-group-toggle"
            :aria-expanded="!groupCollapsed"
            :aria-label="groupCollapsed ? '展开这段发言' : '收起这段发言'"
            @click="emit('toggleGroup', message.id)"
          >
            <span
              class="room-group-caret"
              :class="{ open: !groupCollapsed }"
              aria-hidden="true"
            >›</span>
            <span
              v-if="groupCollapsed"
              class="room-group-count"
            >{{ groupMessageCount }} 条消息</span>
          </button>
        </div>

        <!-- Thinking/Waiting status: rendered by MessageItem, PLACED by
             MessageBubble (#thinking slot) — inside the work group when the
             turn calls tools, at the top of the answer otherwise. -->

        <!-- Attachments live outside the bubble: bare thumbnails for
             images, compact chips for files. -->
        <div
          v-if="message.attachments?.length"
          class="message-attachments"
        >
          <div
            v-if="imageAttachments.length > 0"
            class="message-attachment-images"
            :class="{ grid: imageAttachments.length > 1 }"
          >
            <figure
              v-for="attachment in imageAttachments"
              :key="attachment.id"
              class="message-figure"
            >
              <AttachmentThumb
                size="md"
                clickable
                :src="attachmentImageSrc(attachment)"
                :alt="attachment.fileName"
                @open="openAttachmentImage(attachment)"
              />
              <figcaption class="message-figure-caption">
                {{ attachment.fileName }} · {{ formatFileSize(attachment.size) }}
              </figcaption>
            </figure>
          </div>
          <div
            v-if="fileAttachments.length > 0"
            class="message-attachment-files"
          >
            <!-- Web provenance (page mention / element pick): the chip names
                 the page and tooltips its URL instead of a meaningless size. -->
            <FileChip
              v-for="attachment in fileAttachments"
              :key="attachment.id"
              :file-name="attachment.fileName"
              :size-bytes="attachment.size"
              :tooltip-text="attachment.sourceUrl || undefined"
              :badge="attachment.sourceUrl ? 'WEB' : undefined"
            />
          </div>
        </div>

        <!-- Quote reply (§3.5 A): a snapshot of what this message answers.
             One hairline down its left edge, one line of text — the same
             marking every other quoted body in this app carries. Clicking
             walks back to the original; a missing original simply does not
             move (the snapshot already carries the words). -->
        <button
          v-if="replyQuote"
          type="button"
          class="reply-quote"
          @click.stop="handleJumpToReplyTarget"
        >
          <span class="reply-quote-author">{{ replyQuote.authorLabel }}</span>
          <span class="reply-quote-excerpt">{{ replyQuote.excerpt }}</span>
        </button>

        <!-- 旁观插话(§4.3):双成员 dm 房里用户说的话。一行发丝小字,与署名
             同一个寄存器 —— 它标的是"这句话来自旁观者",不是一个状态徽章。 -->
        <span
          v-if="showBystanderTag"
          class="bystander-tag"
        >旁观插话</span>

        <!-- Message bubble -->
        <MessageBubble
          :role="message.role"
          :content="displayContent"
          :content-parts="message.contentParts"
          :tool-calls="message.toolCalls"
          :steps="message.steps"
          :skill-used="message.skillUsed"
          :is-streaming="message.isStreaming"
          :is-editing="isEditing"
          :edit-content="editContent"
          :session-id="message.sessionId"
          :message-id="message.id"
          :has-thinking="message.role === 'assistant' && Boolean(topReasoning)"
          :started-at="message.timestamp"
          @submit-edit="handleSubmitEdit"
          @cancel-edit="handleCancelEdit"
          @open-media="handleOpenMedia"
          @text-selection="handleTextSelection"
          @execute-tool="handleToolExecute"
          @open-file="(filePath) => emit('openFile', filePath)"
        >
          <template
            v-if="message.role === 'assistant'"
            #thinking
          >
            <MessageThinking
              :is-streaming="message.isStreaming || false"
              :has-content="messageHasContent"
              :reasoning="topReasoning"
              :thinking-start-time="message.thinkingStartTime"
              :thinking-time="message.thinkingTime"
              :intent-key="`thinking-${message.id}`"
              @update-thinking-time="handleUpdateThinkingTime"
            />
          </template>
        </MessageBubble>

        <!-- Reaction chips (§3.5 B): the room's ambient feedback, on the
             bubble's lower edge. Room-only — an ordinary session never grows
             the row even if a message somehow carries the field. -->
        <div
          v-if="reactionChips.length > 0"
          class="reaction-row"
        >
          <button
            v-for="chip in reactionChips"
            :key="chip.emoji"
            type="button"
            class="reaction-chip"
            :class="{ mine: chip.mine }"
            @click.stop="handleReact(chip.emoji)"
            @mouseenter="handleReactionChipEnter(chip.emoji, $event)"
            @mouseleave="handleReactionChipLeave"
            @focus="handleReactionChipEnter(chip.emoji, $event)"
            @blur="handleReactionChipLeave"
          >
            <span class="reaction-chip-emoji">{{ chip.emoji }}</span>
            <span class="reaction-chip-count">{{ chip.count }}</span>
          </button>

          <!-- Attribution popover (W8b): who is behind this emoji. Hover-only
               (the click stays the toggle) and pointer-transparent, so it can
               never steal the tap it is describing. P1: 位置/翻转/视口回弹走
               Popover 内核;皮肤留在插槽这层 div 上(Popover 的根元素不在本组件
               的 scoped 作用域里 —— 方案 §6.1)。 -->
          <Popover
            :open="!!hoveredReactionChip"
            :anchor="hoveredReactionAnchor"
            placement="top-start"
            :offset="6"
            :z-offset="25"
            :surface="false"
            :close-on="{}"
            transition="none"
            style="pointer-events: none"
          >
            <div class="reaction-attribution">
              <div
                v-for="reactor in hoveredReactionChip?.reactors ?? []"
                :key="reactor.key"
                class="reaction-attribution-row"
              >
                <AgentAvatar
                  class="reaction-attribution-avatar"
                  :avatar="reactor.avatar"
                  :avatar-image="reactor.avatarImage"
                  :size="16"
                />
                <span class="reaction-attribution-name">{{ reactor.label }}</span>
              </div>
            </div>
          </Popover>
        </div>

        <!-- Steering identity line: marks the message as an interjection
             into a running response. While still queued it also carries the
             delivery state and the retract affordance. -->
        <div
          v-if="isSteered"
          class="steer-line"
        >
          <span class="steer-flag">插话</span>
          <template v-if="steeringPending">
            <span class="steer-pending-hint">待送达 · 下一轮注入</span>
            <button
              type="button"
              class="steer-retract-btn"
              @click="handleRetractSteer"
            >
              撤回
            </button>
          </template>
        </div>

        <!-- The turn context delivered with this message. Rendered into the
             model request as a <context-update> block; shown here so the user
             can see exactly what the model was told. Two stored shapes: the
             sectioned delta written since 2026-08-18 and the bare string of
             older sessions. -->
        <div
          v-if="message.role === 'user' && contextUpdateText"
          class="message-context-update"
        >
          <button
            type="button"
            class="context-update-toggle"
            :aria-expanded="contextUpdateExpanded"
            @click="contextUpdateExpanded = !contextUpdateExpanded"
          >
            context-update
          </button>
          <pre
            v-if="contextUpdateExpanded"
            class="context-update-body"
          >{{ contextUpdateText }}</pre>
        </div>

        <!-- Inline error for assistant messages that failed mid-stream -->
        <ErrorNote
          v-if="message.role === 'assistant' && message.errorDetails"
          class="inline-error"
          :message="inlineErrorText"
        />

        <!-- Message footer -->
        <div
          class="message-footer"
          data-message-footer
        >
          <div
            class="meta"
          >
            {{ formatTime(message.timestamp) }}
          </div>
          <MessageActions
            :role="message.role"
            :content="message.content"
            :visible="true"
            :mutations-disabled="isCollabRoomMessage"
            :can-reply="canReply"
            :can-react="canReact"
            :is-streaming="message.isStreaming || false"
            :branches="branches"
            :can-branch="canBranch"
            :usage="message.usage"
            :model="message.model"
            :message-id="message.id"
            :session-id="message.sessionId"
            @edit="startEdit"
            @reply="handleReply"
            @react="handleReact"
            @regenerate="handleRegenerate"
            @branch="handleBranch"
            @go-to-branch="handleGoToBranch"
          />
        </div>

        <!-- 消息级锚点(message.footer):插件块按消息实例挂载,只挂
             assistant 消息。**有意不放进 .message-footer**:那是悬停才显的
             chrome(时间戳/操作行),而插件块是内容(TPS/耗时/成本徽标),
             必须常显 —— 悬停门控会把这类块的存在意义打没。 -->
        <UiSlotHost
          v-if="message.role === 'assistant'"
          class="message-anchor-host"
          anchor="message.footer"
          :session-id="message.sessionId"
          :message-id="message.id"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import type { ChatMessage, ChatMessageReplyTo, MessageAttachment, ToolCall } from '@/types'
import type { AnchorRect } from '@/composables/floating/compute-position'
import { REPLY_USER_LABEL, buildReplyToSnapshot } from './message/reply-quote'
import { buildReactionChips } from './message/reactions'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AttachmentThumb from '@/components/common/AttachmentThumb.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import FileChip from '@/components/common/FileChip.vue'
import { formatFileSize } from '@/utils/format'
import MessageError from './message/MessageError.vue'
import UiSlotHost from '@/components/plugins/UiSlotHost.vue'
import MessageSystem from './message/MessageSystem.vue'
import RoomNoticeLine from './message/RoomNoticeLine.vue'
import CollabThinkingTrace from './message/CollabThinkingTrace.vue'
import GoalContinuationLine from './message/GoalContinuationLine.vue'
import GoalSetMessage from './message/GoalSetMessage.vue'
import MessageThinking from './message/MessageThinking.vue'
import MessageBubble from './message/MessageBubble.vue'
import MessageActions from './message/MessageActions.vue'
import Popover from '@/components/common/Popover.vue'
import { humanizeStreamError } from './message/error-humanizer'
import { rawTextFromPromptParts } from '@shared/prompt-references'
import { isActiveAgent } from '@shared/ipc'
import { renderCollabMentionMarkup } from '@/composables/collabInlineTags'
import { useUserProfile } from '@/composables/useUserProfile'
import { isRoomThinkingTrace, type RoomMessageLike } from './message/room-grouping'
import { mediaWindowApi } from '@/platform/media-window-client'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { useSessionsStore } from '@/stores/sessions'

interface BranchInfo {
  id: string
  name: string
}

interface Props {
  message: ChatMessage
  branches?: BranchInfo[]
  canBranch?: boolean
  isHighlighted?: boolean
  /** kind='room' session: render agent messages as IM (avatar column + group). */
  roomMode?: boolean
  /**
   * 托管私聊房(单成员 dm 房,agent-im-dm.md §4.3)。房间排版照旧,只收掉署名:
   * 一对一里"这句话是谁说的"没有悬念,头部那枚大头像已经回答过了。头像章留着
   * —— 它是 IM 的说话轴,不是署名。
   */
  dmMode?: boolean
  /**
   * agent ↔ agent 私聊房(双成员 dm 房,agent-im-dm.md §4.3)。房间排版一字不改
   * (两个人**要**署名),只给用户消息加一枚「旁观插话」的弱标识:这间房是两位
   * 成员的对话,用户是看得见也插得进来的第三方(D4 透明制),而"谁在说话"这件事
   * 在一屋子发言里必须一眼可辨。纯样式,不动任何数据。
   */
  pairDmMode?: boolean
  /** First message of a same-agent run — carries the avatar and the signature. */
  groupHead?: boolean
  /** Last message of a run — carries the turn gap and the hover footer. */
  groupTail?: boolean
  /** Room group head with more than one row: offer the fold toggle (P1-2). */
  groupCollapsible?: boolean
  groupCollapsed?: boolean
  /** Messages in the block — the folded head's summary count. */
  groupMessageCount?: number
}

const props = withDefaults(defineProps<Props>(), {
  canBranch: true,
  isHighlighted: false,
  roomMode: false,
  dmMode: false,
  pairDmMode: false,
  groupHead: true,
  groupTail: true,
  groupCollapsible: false,
  groupCollapsed: false,
  groupMessageCount: 0,
})

const inlineErrorText = computed(() => {
  const raw = props.message.errorDetails
  if (!raw) return ''
  const humanized = humanizeStreamError(raw)
  return humanized.title === '生成失败' ? raw : humanized.title
})

interface MessageMediaOpenPayload {
  src: string
  alt?: string
  fileName?: string
  mediaId?: string
}

const emit = defineEmits<{
  regenerate: [messageId: string]
  edit: [messageId: string, newContent: string]
  branch: [messageId: string, quotedText?: string]
  goToBranch: [sessionId: string]
  /** Rooms: quote this message into the composer (§3.5 A). */
  reply: [replyTo: ChatMessageReplyTo]
  /** Rooms: toggle one palette emoji on this message (§3.5 B). */
  react: [messageId: string, emoji: string]
  /** Rooms: fold / unfold the utterance block this head opens (P1-2). */
  toggleGroup: [messageId: string]
  /** Walk back to a quoted message; the list owns the scroll. */
  jumpToMessage: [messageId: string]
  textSelection: [messageId: string, text: string, rect: AnchorRect]
  executeTool: [toolCall: ToolCall]
  openFile: [filePath: string]
  updateThinkingTime: [messageId: string, thinkingTime: number]
}>()

// UI State
const isEditing = ref(false)
const editContent = ref('')
const contextUpdateExpanded = ref(false)

/**
 * What this message's turn-context block says, in the order it was delivered:
 * the sections it (re)sent, then the ones it retired. Falls back to the legacy
 * whole-block string for sessions written before the block gained sections.
 */
const contextUpdateText = computed(() => {
  const delta = props.message.turnContext
  if (delta) {
    return [
      ...Object.entries(delta.set ?? {}).map(([name, content]) => `[${name}]\n${content}`),
      ...(delta.removed ?? []).map(name => `[${name}] removed`),
    ].join('\n\n')
  }
  return props.message.contextUpdate ?? ''
})

// Steering identity + retraction. `steered` is the persisted marker (also
// true for historical messages); the pending set only tracks messages still
// waiting in the queue (retractable until the next loop turn drains them).
const chatStore = useChatStore()
const agentsStore = useAgentsStore()
const { mentionLabels: userMentionLabels } = useUserProfile()
// Room signature chips need agent display metadata; the store self-guards
// against duplicate loads, so this is a one-time fetch app-wide. Failures are
// cosmetic (chips fall back to the agent id) — never let them bubble.
void Promise.resolve(agentsStore.loadAgents()).catch(() => {})
const isSteered = computed(() =>
  props.message.role === 'user' &&
  (props.message.steered === true ||
    chatStore.pendingSteeringByMessageId.has(props.message.id)),
)
const steeringPending = computed(() =>
  props.message.role === 'user' &&
  chatStore.pendingSteeringByMessageId.has(props.message.id),
)

async function handleRetractSteer() {
  await chatStore.retractSteerMessage(props.message.id)
}

// Engine-injected goal continuation prompts persist as user messages so
// history rebuilds replay them; the UI renders them as a hairline tick.
const isGoalInjected = computed(
  () => props.message.role === 'user' && props.message.origin?.source === 'goal',
)

// The /goal command's own declaration message — a real user message marked
// at send time; rendered as the framed GOAL block.
const isGoalSet = computed(
  () => props.message.role === 'user' && props.message.source === 'goal-set',
)

// ── Collab (multi-agent room) rendering — docs/design/multi-agent-collab.md ──
// Coordinator activation drives fold like goal drives (keyed on origin.source,
// mirroring the goal fold; there is no 'radio' precedent — radio sessions are
// hidden wholesale).
const isCollabInjected = computed(
  () => props.message.role === 'user' && props.message.origin?.source === 'collab',
)

/**
 * 「旁观插话」标(§4.3):双成员 dm 房里的**真**用户消息。
 *
 * 排除项与它们的理由:驱动消息(coordinator 合成的激活)与 goal 注入本来就不是
 * 用户说的话,它们各自有自己的呈现;系统行是 role='system',压根不进这一支。
 */
const showBystanderTag = computed(() =>
  props.pairDmMode
  && props.message.role === 'user'
  && !isCollabInjected.value
  && !isGoalInjected.value,
)

// Drive content is "(名字 · 被 @ 激活)" — strip the parens for the hairline.
const collabDriveLabel = computed(() =>
  (props.message.content || '').replace(/^\(|\)$/g, '').trim() || '激活')

// agentId is only ever stamped in collab sessions, so it doubles as the
// "this is a room/work message" signal without a session lookup.
const isCollabAgentMessage = computed(
  () => props.message.role === 'assistant' && Boolean(props.message.agentId),
)

// Session-kind lookup: user messages in rooms must ALSO lose edit/retry —
// the engine refuses them and a stranded loading state would wedge the
// composer (评审修订). Falls back to the agentId signal when the session
// meta is not loaded.
const isCollabRoomMessage = computed(() => {
  if (isCollabAgentMessage.value) return true
  const sessionId = props.message.sessionId
  if (!sessionId) return false
  try {
    const kind = useSessionsStore().sessions.find(s => s.id === sessionId)?.kind
    return kind === 'room' || kind === 'work'
  } catch {
    return false
  }
})

const collabContentTrimmed = computed(() =>
  (props.message.content || '').trim().toLowerCase())

// Pass turn resolved: nothing but the sentinel (stream ended, or the first
// line completed as '[pass]' with a hedge following — the hedge case renders
// as normal speech, so only the ended-stream case is final here).
const isCollabPass = computed(() => {
  if (!isCollabAgentMessage.value) return false
  return !props.message.isStreaming && collabContentTrimmed.value === '[pass]'
})

// 首行门 hold window: while streaming and the partial content is still a
// prefix of '[pass]' the verdict is ambiguous — render a neutral ellipsis,
// never a premature "选择不发言" that could retract (评审修订).
const isCollabPassHold = computed(() => {
  if (!isCollabAgentMessage.value || !props.message.isStreaming) return false
  const trimmed = collabContentTrimmed.value
  return trimmed.length > 0 && '[pass]'.startsWith(trimmed)
})

/**
 * W14a: `@名字` is repainted from the message's mentions[] against the CURRENT
 * roster, so renaming a member updates every message that ever addressed it —
 * exactly like the model projection does. A member that is gone keeps its
 * label snapshot, and a message with no mentions returns its own string
 * untouched (same reference — no re-render churn on ordinary sessions).
 */
const displayContent = computed(() =>
  renderCollabMentionMarkup(
    props.message.content,
    props.message.mentions,
    agentsStore.agents,
    // agent-dm-user.md §2.4:`@一天` / `@yitian` 也该点亮用户高亮。
    userMentionLabels.value,
  ))

/**
 * 署名(域模型 M4 的 `displayAgent`):在职 → 正常;已退休 → 名字照旧 +
 * 「已注销」徽标;查无此人 → 墓碑「已注销」。
 *
 * 历史署名永远读得出来,这正是"退休不是删除"要保住的东西 —— 以前这里是内联
 * 的 strict find + 原始 id 兜底,一条来自已删 agent 的旧消息会署上一串 uuid。
 */
const collabSender = computed(() => {
  if (!isCollabAgentMessage.value) return null
  const identity = agentsStore.displayAgent(props.message.agentId)
  return {
    name: identity.name,
    title: identity.title,
    avatar: identity.avatar,
    avatarImage: identity.avatarImage,
    isRetired: !isActiveAgent(identity),
  }
})

const collabSenderName = computed(() => collabSender.value?.name ?? '成员')

// ── Room system notice (§3.6, W15) ──
// Context-compact is the one system message that is not a room notice: it is a
// JSON payload the compact panel unfolds, and clamping that to two lines of raw
// JSON would be a regression, not a de-slop. Everything the coordinator posts
// (task lifecycle / membership / budget) is plain prose and takes the trace.
function isContextCompactPayload(content: string | undefined): boolean {
  if (!content || !content.trimStart().startsWith('{')) return false
  try {
    return (JSON.parse(content) as { type?: string } | null)?.type === 'context-compact'
  } catch {
    return false
  }
}

const isRoomSystemNotice = computed(
  () =>
    props.roomMode &&
    props.message.role === 'system' &&
    !isContextCompactPayload(props.message.content),
)

// ── Thinking record (W14b 说话即行动) ──
// The turn's own message is the agent's thinking, not what it said; speech is
// its `say` calls, which persist as their own messages. Room-only: a work
// session IS the working view (its turns are the thing you went there to read),
// and an ordinary session never carries the marker at all.
const isRoomThinkingRecord = computed(
  () => props.roomMode && isRoomThinkingTrace(props.message as RoomMessageLike),
)

// Room IM layout applies to agent speech only: the user keeps the existing
// right-hand column, and work sessions (one agent, one task) keep the plain
// signature line. Grouping flags come from MessageList's room projection.
const isRoomAgentMessage = computed(() => props.roomMode && isCollabAgentMessage.value)

/**
 * 群聊 → 空间页动线(agent-im-chat-ui.md C3/Q5):署名头像/名字**直开**「我与
 * TA 的空间」。
 *
 * 曾经中间隔着一张联系人小卡(AgentContactCard),它的两个动作——私聊、履历
 * ——如今都是空间页资料块上的按钮,小卡因此退役:多一跳只是多一跳。
 *
 * 只在**群**里给:私聊房本来就收掉了署名(一对一无需署名),在那儿再放一个
 * "去认识 TA"的入口等于原地打转。没有 agentId 的消息(用户、系统、普通会话)
 * 也没有人可认识。
 */
const canOpenAgentSpace = computed(() =>
  isRoomAgentMessage.value && !props.dmMode && Boolean(props.message.agentId))

function openAgentSpace(): void {
  if (!canOpenAgentSpace.value) return
  agentsStore.openAgentSpace(props.message.agentId || '')
}

// ── Quote reply (§3.5 A) ──
// The affordance is room-only: ordinary sessions must stay pixel-identical, and
// a work session is one agent answering one task — there is nobody to quote AT.
// The block itself renders wherever a snapshot exists (history stays readable
// even if a room is later opened some other way).
const replyQuote = computed(() => {
  const replyTo = props.message.replyTo
  if (!replyTo?.excerpt) return null
  return replyTo
})

const canReply = computed(() =>
  props.roomMode &&
  (props.message.role === 'user' || props.message.role === 'assistant') &&
  !isCollabPass.value &&
  !isCollabPassHold.value,
)

function handleReply() {
  const snapshot = buildReplyToSnapshot({
    messageId: props.message.id,
    authorLabel: props.message.role === 'user' ? REPLY_USER_LABEL : collabSenderName.value,
    content: props.message.content,
  })
  if (!snapshot) return
  emit('reply', snapshot)
}

function handleJumpToReplyTarget() {
  const targetId = props.message.replyTo?.messageId
  if (!targetId) return
  emit('jumpToMessage', targetId)
}

// ── Emoji reactions (§3.5 B) ──
// Entry AND chips are room-only: a historical ordinary-session message that
// somehow carries the field must render exactly as it always did.
const canReact = computed(() =>
  props.roomMode &&
  (props.message.role === 'user' || props.message.role === 'assistant') &&
  !isCollabPass.value &&
  !isCollabPassHold.value,
)

const reactionChips = computed(() =>
  props.roomMode
    ? buildReactionChips(props.message.reactions, { agents: agentsStore.agents })
    : [],
)

/** Both entry points (palette pick, chip tap) are the same toggle write. */
function handleReact(emoji: string) {
  emit('react', props.message.id, emoji)
}

// ── Reaction attribution popover (W8b) ──
// "Who reacted" is a hover question: the chip's click is already spoken for by
// the toggle, so the popover opens after a 300ms rest (a mouse crossing the row
// on its way somewhere else must not flash three panels) and closes the instant
// the pointer leaves. Nothing is written, nothing is focused — it is a label.
const REACTION_POPOVER_DELAY_MS = 300

const hoveredReactionEmoji = ref<string | null>(null)
/** The chip the popover hangs off. Positioning itself is the kernel's job. */
const hoveredReactionAnchor = ref<HTMLElement | null>(null)
let reactionHoverTimer: ReturnType<typeof setTimeout> | null = null

/** Resolved live: a toggle that lands while the popover is open re-derives it,
 *  and a chip that drops to zero takes its popover with it. */
const hoveredReactionChip = computed(() => {
  const emoji = hoveredReactionEmoji.value
  if (!emoji) return null
  return reactionChips.value.find(chip => chip.emoji === emoji) ?? null
})

function clearReactionHoverTimer() {
  if (reactionHoverTimer !== null) {
    clearTimeout(reactionHoverTimer)
    reactionHoverTimer = null
  }
}

function handleReactionChipEnter(emoji: string, event: Event) {
  clearReactionHoverTimer()
  const anchor = event.currentTarget as HTMLElement | null
  reactionHoverTimer = setTimeout(() => {
    reactionHoverTimer = null
    // `top-start` with flip: above the chip by default — the popover must not
    // cover the message it annotates — turning below only when the top of the
    // viewport is in the way. The kernel measures the real panel instead of the
    // row-count estimate this used to guess with.
    hoveredReactionAnchor.value = anchor
    hoveredReactionEmoji.value = emoji
  }, REACTION_POPOVER_DELAY_MS)
}

function handleReactionChipLeave() {
  clearReactionHoverTimer()
  hoveredReactionEmoji.value = null
  hoveredReactionAnchor.value = null
}

onBeforeUnmount(clearReactionHoverTimer)

// A continued message drops the turn gap and its hover footer: inside a group
// the timestamp is the group's, and a 28px action row cannot paint in an 8px
// gap without landing on the text above it. The group tail keeps both.
const isRoomStacked = computed(() => isRoomAgentMessage.value && !props.groupTail)

const messageHasContent = computed(() => {
  if (props.message.content) return true
  if (props.message.toolCalls?.length || props.message.steps?.length) return true
  // transient 指示器不算"有内容":一条只挂着插件状态的消息不该被当成已有正文
  // (否则 waiting 指示器会被顶掉,用户看到插件在忙却看不到"在等模型")。
  return props.message.contentParts?.some(part =>
    part.type !== 'waiting' &&
    part.type !== 'image-loading' &&
    part.type !== 'plugin-status'
  ) ?? false
})

const topReasoning = computed(() => {
  return props.message.reasoning || ''
})

// Attachments render outside the bubble: images as bare thumbnails,
// everything else (including images without a resolvable source) as chips.
const imageAttachments = computed(() =>
  (props.message.attachments ?? []).filter(
    attachment => attachment.mediaType === 'image' && attachmentImageSrc(attachment),
  ),
)

const fileAttachments = computed(() =>
  (props.message.attachments ?? []).filter(
    attachment => !(attachment.mediaType === 'image' && attachmentImageSrc(attachment)),
  ),
)

function attachmentImageSrc(attachment: MessageAttachment): string {
  if (attachment.base64Data) {
    return `data:${attachment.mimeType};base64,${attachment.base64Data}`
  }
  return attachment.url || ''
}

function openAttachmentImage(attachment: MessageAttachment) {
  const src = attachmentImageSrc(attachment)
  if (!src) return
  handleOpenMedia({ src, fileName: attachment.fileName })
}

// Format time
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// Edit handlers
function startEdit() {
  editContent.value = rawTextFromPromptParts(props.message.content, props.message.contentParts)
  isEditing.value = true
}

function handleSubmitEdit(content: string) {
  emit('edit', props.message.id, content)
  isEditing.value = false
  editContent.value = ''
}

function handleCancelEdit() {
  isEditing.value = false
  editContent.value = ''
}

// Image preview handlers
function handleOpenMedia(payload: MessageMediaOpenPayload) {
  const { src, alt, fileName, mediaId } = payload
  if (!src) return
  if (mediaId) {
    void mediaWindowApi.openGallery({ mediaId })
    return
  }
  void mediaWindowApi.openPreview({ src, alt: fileName || alt })
}

// Regenerate handler
function handleRegenerate() {
  emit('regenerate', props.message.id)
}

// Branch handlers
function handleBranch() {
  if (!props.canBranch) return
  emit('branch', props.message.id)
}

function handleGoToBranch(sessionId: string) {
  emit('goToBranch', sessionId)
}

// Text selection: the toolbar itself is owned by MessageList (one instance
// for the whole list); this component only reports where the selection is.
function handleTextSelection(text: string, rect: AnchorRect) {
  emit('textSelection', props.message.id, text, rect)
}

// Tool handlers
function handleToolExecute(toolCall: ToolCall) {
  emit('executeTool', toolCall)
}

// Thinking time handler
function handleUpdateThinkingTime(time: number) {
  emit('updateThinkingTime', props.message.id, time)
}
</script>

<style scoped>
/* Wrapper for TransitionGroup compatibility */
.message-item-wrapper {
  width: 100%;
  display: flex;
  flex-direction: column;
  /* The turn gap lives here as padding (not margin on .message) so the
     hover-revealed footer can paint inside it and hovering the gap keeps
     the footer open. One token = one rhythm for the whole stream. */
  position: relative;
  padding-bottom: var(--chat-turn-gap, 34px);
}

.message {
  display: flex;
  gap: var(--message-gap, 10px);
  align-items: flex-start;
  animation: fadeIn 0.18s ease-out;
  width: 100%;
}

.message.user {
  flex-direction: row-reverse;
  justify-content: flex-start;
}

.message.assistant {
  flex-direction: row;
  justify-content: flex-start;
}

/* Navigation highlight effect */
.message.user.highlighted :deep(.bubble) {
  animation: highlight-pulse 2.5s ease-out;
}

@keyframes highlight-pulse {
  0% {
    box-shadow:
      0 0 0 4px color-mix(in srgb, var(--ui-accent-primary-fg) 60%, transparent),
      0 0 20px color-mix(in srgb, var(--ui-accent-primary-fg) 30%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 4px color-mix(in srgb, var(--ui-accent-primary-fg) 40%, transparent),
      0 0 15px color-mix(in srgb, var(--ui-accent-primary-fg) 20%, transparent);
  }
  100% {
    box-shadow: none;
  }
}

.message-content-wrapper {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

/* User messages: align items to the right */
.message.user .message-content-wrapper {
  align-items: flex-end;
}

/* Attachment layer above the bubble: no shell of its own, each thumb/chip
   carries its own surface. */
.message-context-update {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  margin-top: 2px;
}

.context-update-toggle {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--ui-text-muted-fg);
  font-size: 10px;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  letter-spacing: 0.03em;
  cursor: pointer;
  opacity: 0.75;
}

.context-update-toggle:hover {
  opacity: 1;
  text-decoration: underline;
}

.context-update-body {
  margin: 0;
  padding: 6px 8px;
  max-width: min(74%, 680px);
  overflow-x: auto;
  border-left: 1px solid var(--ui-border-default-border);
  background: transparent;
  color: var(--ui-text-muted-fg);
  font-size: 10.5px;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  white-space: pre-wrap;
}

.message-attachments {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(74%, 680px);
  margin-bottom: 4px;
}

.message-attachment-images,
.message-attachment-files {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}

.message.user .message-attachment-images,
.message.user .message-attachment-files {
  justify-content: flex-end;
}

/* Multiple images shrink into a uniform thumbnail grid. */
.message-attachment-images.grid :deep(.attachment-thumb-img) {
  width: 116px;
  height: 116px;
  object-fit: cover;
}

/* Plate captions: filename set like a figure label under each image. */
.message-figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin: 0;
  min-width: 0;
}

.message-figure-caption {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  letter-spacing: 0.5px;
  color: var(--ui-text-faint-fg, var(--ui-text-muted-fg));
}

.message.assistant .message-content-wrapper {
  gap: 4px;
  max-width: 100%;
  margin: 0;
}

/* Message footer — an overlay in the turn gap, not a layout row. Reserving
   28px under every message made the stream's rhythm read as slack; painting
   it inside the wrapper's padding keeps reveal shift-free at zero cost. */
/* 消息级锚点宿主:常显(与悬停门控的 .message-footer 刻意区隔)。 */
.message-anchor-host {
  margin: 2px 4px 0;
  opacity: 0.82;
  font-size: 11px;
}

.message-footer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 3px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
  min-height: 28px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.message-item-wrapper:hover .message-footer,
.message-footer:focus-within,
.message.highlighted .message-footer {
  opacity: 1;
  pointer-events: auto;
}

/* User messages: position actions at bottom-right */
.message.user .message-footer {
  justify-content: flex-end;
  padding: 0 8px 0 0;
}

/* AI messages: adjust footer for clean layout */
.message.assistant .message-footer {
  padding-left: 0;
  flex-direction: row-reverse;
}

.meta {
  font-size: 11.5px;
  line-height: 28px;
  color: var(--ui-text-muted-fg);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

/* Steered message: dashed frame marks an interjection into a running
   response, distinct from the solid outline of a normal user entry. */
.message.user.steered :deep(.bubble.user) {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--ui-accent-primary-fg) 45%, transparent);
}

/* Steering identity line: always visible on steered messages; carries the
   delivery state and retract affordance while the message is still queued. */
.steer-line {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding-right: 4px;
  font-size: 11.5px;
  color: var(--ui-text-muted-fg);
  user-select: none;
}

.steer-flag {
  font-size: 11px;
  line-height: 16px;
  padding: 0 5px;
  letter-spacing: 0.08em;
  border: 1px dashed color-mix(in srgb, var(--ui-accent-primary-fg) 40%, transparent);
  border-radius: 3px;
  color: color-mix(in srgb, var(--ui-accent-primary-fg) 75%, var(--ui-text-muted-fg));
}

.steer-pending-hint {
  letter-spacing: 0.02em;
}

.steer-retract-btn {
  border: none;
  background: transparent;
  padding: 0 2px;
  font-size: 11.5px;
  color: var(--ui-text-secondary-fg);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-default);
}

.steer-retract-btn:hover {
  color: var(--ui-accent-primary-fg);
}

/* Opacity only: a translateY on top of the send scroll was a third
   simultaneous motion (2026-08-17). */
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Inline error for failed assistant messages — positioning only; the ledger
   ink rule itself lives in ErrorNote. */
.inline-error {
  margin-top: 8px;
}
/* ── Quote reply block (§3.5 A / §3.6) ──
   A trace above the speech: one 2px rule down its left edge, 10-11px, the
   author half-bold, the excerpt clipped to a single line. The wash is 3% ink —
   just enough to read as "not my words", never a coloured card. */
.reply-quote {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  max-width: min(74%, 680px);
  margin: 0 0 3px;
  padding: 2px 8px 2px 7px;
  appearance: none;
  border: none;
  border-left: 2px solid color-mix(in srgb, var(--ui-text-primary-fg) 30%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--ui-text-primary-fg) 3%, transparent);
  font: inherit;
  font-size: 11px;
  line-height: 1.55;
  text-align: left;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: border-left-color var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.reply-quote:hover {
  border-left-color: color-mix(in srgb, var(--ui-text-primary-fg) 55%, transparent);
  color: var(--ui-text-secondary-fg);
}

.reply-quote:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

.reply-quote-author {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--ui-text-secondary-fg);
}

.reply-quote-excerpt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Reaction chips (§3.5 B / §3.6) ──
   A hairline capsule on the bubble's lower edge: 1px line, 3px radius, 14px
   emoji + a 10px ink-grey count. "I reacted" is said by DARKENING THE LINE —
   never a fill, never a colour, never a size change. */
/* The row is room-only (`reactionChips` returns [] outside a room), and in a
   room it is a flex item of `.message-content-wrapper`, whose 4px `gap`
   ALREADY spaces it off the bubble. A margin-top here does not collapse with
   a flex gap — it ADDS (W15c 真机实锤: a chip'd message sat 8px off its bubble
   while an un-chip'd one sat 4px off everything, and the whole row read as a
   bigger gap after it). One owner: the wrapper's gap. */
.reaction-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 0;
  margin-bottom: 0;
}

.reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  appearance: none;
  border: 1px solid color-mix(in srgb, var(--ui-text-primary-fg) 18%, transparent);
  border-radius: 3px;
  background: transparent;
  font: inherit;
  line-height: 1.4;
  cursor: pointer;
  transition: border-color var(--duration-fast) var(--ease-default);
}

.reaction-chip:hover {
  border-color: color-mix(in srgb, var(--ui-text-primary-fg) 40%, transparent);
}

.reaction-chip.mine {
  border-color: color-mix(in srgb, var(--ui-text-primary-fg) 55%, transparent);
}

.reaction-chip:focus-visible {
  outline: 1px solid var(--ui-accent-primary-fg);
  outline-offset: 1px;
}

.reaction-chip-emoji {
  font-size: 14px;
  line-height: 1;
}

.reaction-chip-count {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted-fg);
}

/* ── Collab (multi-agent room) ── */
.collab-sender {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 2px 0 4px;
  user-select: none;
}

.collab-sender-avatar {
  font-size: 14px;
}

.collab-sender-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-primary-fg);
}

/* 可点的署名(§4.3 联系人卡入口):形态与不可点那版逐像素相同 —— 它是名字,
   不是按钮;只有 hover/聚焦时落一段点线,表明"这里可以点"。 */
.collab-sender-name.is-contact {
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  line-height: inherit;
  cursor: pointer;
  border-bottom: 1px dotted transparent;
}

.collab-sender-name.is-contact:hover,
.collab-sender-name.is-contact:focus-visible {
  border-bottom-color: color-mix(in srgb, var(--ui-text-primary-fg) 45%, transparent);
}

.collab-sender-title {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
}

/* 墓碑署名(域模型 §3.2):整行压暗,后面缀一枚 11px 的「已注销」。徽标是一个
   词加一道细边,不是 chip —— 历史消息的主角是那句话,不是它的注销状态。 */
.collab-sender.is-retired .collab-sender-name,
.collab-sender.is-retired .collab-sender-avatar {
  color: var(--ui-text-muted-fg);
  opacity: 0.75;
}

.collab-sender-retired {
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--ui-text-muted-fg) 40%, transparent);
  font-size: 11px;
  line-height: 1.45;
  color: var(--ui-text-muted-fg);
}

/* 「旁观插话」(§4.3):与署名同一个寄存器(11px 弱墨),右对齐到用户气泡那一侧
   —— 用户消息本来就靠右,标在同一边才读成"这条消息的注记"而不是一行独立内容。
   自身宽度只包住那三个字,所以 margin-left:auto 而不是 text-align。 */
.bystander-tag {
  align-self: flex-end;
  margin-bottom: 2px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ui-text-muted-fg);
  opacity: 0.85;
  user-select: none;
}

/* Utterance fold (P1-2). Read straight off CollabThinkingTrace's hairline: a
   bare rotating caret, 11px muted ink, no border, no fill, no icon font. The
   count only appears folded — expanded, the rows themselves are the answer. */
.room-group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0;
  padding: 0 2px;
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ui-text-muted-fg);
  /* Idle it is a whisper; the group head is the loud part of the row. */
  opacity: 0.55;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.message-item-wrapper:hover .room-group-toggle,
.room-group-toggle:hover,
.room-group-toggle:focus-visible {
  opacity: 1;
}

/* Folded is a STATE, not a hover affordance: the count has to stay legible
   whether or not the pointer is anywhere near it. */
.room-group-toggle[aria-expanded='false'] {
  opacity: 1;
}

.room-group-caret {
  display: inline-block;
  font-size: 12px;
  line-height: 1;
  transition: transform var(--duration-fast) var(--ease-default);
}

.room-group-caret.open {
  transform: rotate(90deg);
}

.room-group-count {
  letter-spacing: 0.02em;
}

.collab-pass-line {
  margin: 2px 0;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
  user-select: none;
  opacity: 0.75;
}

.collab-drive-line {
  margin: 6px 0 2px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--ui-text-muted-fg);
  user-select: none;
  opacity: 0.65;
  display: flex;
  align-items: center;
  gap: 8px;
}

.collab-drive-line::before,
.collab-drive-line::after {
  content: '';
  flex: 1;
  border-top: 1px dashed color-mix(in srgb, var(--ui-text-muted-fg) 35%, transparent);
}

/* ── Room (kind='room') IM layout ──
   IM's manners, this app's skin. Attribution is carried by the gutter and the
   signature — both OUTSIDE the frame; the speech itself sits in the same box
   the user's own messages sit in (§3.6 2026-07-28 revision: the W3 left-rule
   scheme is withdrawn, an agent's message is framed exactly like a user's and
   only the left/right layout says who spoke).

   Vertical rhythm is NOT this component's business in a room: every gap
   between rows comes from MessageList's gap table (W15). This block only
   zeroes what MessageItem would otherwise contribute. */
.message-item-wrapper.is-room-row {
  /* The gutter the avatar hangs in. One name for the 28px chip + the row gap,
     used by the outdent, the footer anchor and the pass line alike — they can
     never drift apart again. */
  --room-gutter: calc(28px + var(--message-gap, 10px));

  /* The turn gap moves to the list's table; the hover footer is re-anchored
     below the box so it still paints in the gap without reserving it. */
  padding-bottom: 0;
}

/* ── W15c: the reading column IS the bubble column ──
   The gutter used to be spent INSIDE the reading column, so an agent's frame
   started 38px in and the whole speech column sat ~19px right of the composer
   and of every ordinary session's content column. The gutter now HANGS in the
   page margin: the row is widened leftward by exactly the gutter, so the
   content column that follows it measures the full reading column and its
   centre line lands on the composer's.

   The user column carries no gutter, so it is already the reading column —
   which is what makes the two sides symmetric: agent frames grow rightward
   from the column's left edge, user frames leftward from its right edge. */
.message-item-wrapper.is-room-row .message.is-room-agent {
  margin-left: calc(-1 * var(--room-gutter));
  width: calc(100% + var(--room-gutter));
}

.message-item-wrapper.is-room-row .message-footer {
  top: 100%;
  bottom: auto;
  /* Fit INSIDE the smallest band of the rhythm table (the notice gap): taller
     than 24px and the row bleeds onto whatever comes next — 真机实锤 it landed
     on a system notice. Height is pinned to the band; buttons compact below. */
  height: 24px;
  min-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  align-items: center;
  /* Start where the message starts. Since W15c outdented the gutter out of
     the reading column, the bubble's left line IS the wrapper's left edge —
     the footer anchors at 0 (it used to add the gutter back, which after the
     outdent would push it a full 38px right of the frame it belongs to). */
  left: 0;
  background: var(--ui-surface-chat-bg);
}

/* Compact the buttons so the row truly fits the 24px band. */
.message-item-wrapper.is-room-row .message-footer .action-btn {
  padding: 2px;
}

/* The user column is right-aligned; its footer hugs the bubble's right edge
   already — only pin the height so it cannot bleed either. */
.message-item-wrapper.is-room-row .message.user .message-footer {
  left: 0;
}

.room-avatar-col {
  flex: 0 0 28px;
  width: 28px;
  display: flex;
  justify-content: center;
  /* Top-aligned with the signature's cap height, not its box. */
  padding-top: 1px;
}

.room-avatar {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--ui-text-primary-fg) 35%, transparent);
  font-size: 15px;
  line-height: 1;
  user-select: none;
}

/* 头像变成可点入口时,按钮本身完全透明 —— 章还是那枚章(§3.6 禁 hover 缩放,
   所以"可点"只由圈线变实来说)。 */
.room-avatar-btn {
  position: relative;
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  display: flex;
  cursor: pointer;
}

/* 「可点」提示:静止态与今天完全一致,hover 只垫一层软阴影的立体感 ——
   不描色、不缩放(§3.6)。按下阴影收紧一档。四处头像同一句法。 */
.room-avatar-btn .room-avatar {
  transition: box-shadow var(--duration-fast) var(--ease-default);
}

.room-avatar-btn:hover .room-avatar,
.room-avatar-btn:focus-visible .room-avatar {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ui-text-primary-fg) 22%, transparent);
}

.room-avatar-btn:active .room-avatar {
  box-shadow: 0 1px 3px color-mix(in srgb, var(--ui-text-primary-fg) 18%, transparent);
}

/* The signature sits outside the frame, flush with the frame's left edge. */
.collab-sender.is-room {
  margin: 0;
  padding-left: 0;
}

/* One utterance = one column, evenly stacked: signature → quote → attachments
   → frame → chips all sit on a single 4px rhythm, so nothing inside a message
   can fake a between-message gap.

   Keyed on the WRAPPER, not on `.is-room-agent` (W15c): the user column never
   carries that class, so it kept the ordinary 2px base gap while the agent
   column ran on 4px — the two sides of the same room stacked on different
   rhythms. In a room both sides are one utterance shape. */
.message-item-wrapper.is-room-row .message-content-wrapper {
  gap: 4px;
}

/* The blanket ban on component-owned vertical margins, room-wide. Each of
   these is a flex item of the wrapper above, so its margin ADDS to the 4px
   gap instead of collapsing into it — every one of them was a private extra
   band (attachments +4, context-update +2, signature +2/+4) that only fired
   on some rows and made the stream read as unevenly spaced. */
.message-item-wrapper.is-room-row .message-attachments,
.message-item-wrapper.is-room-row .message-context-update,
.message-item-wrapper.is-room-row .collab-sender {
  margin-top: 0;
  margin-bottom: 0;
}

/* THE frame. Read straight off `.bubble.user` in MessageBubble.vue — same
   hairline, same 4% ink wash, same 4px radius, same padding token. An agent
   message must be framed the way a user message is framed; only the side of
   the column and the avatar/signature say who is speaking.

   That sameness extends to the `bubbleRadius` skin knob (H3): this frame is a
   bubble, so it turns with the knob. The bare `.bubble.assistant` outside a
   room is NOT — it has no border, no background and no padding, so a radius
   there would round nothing. */
.message.is-room-agent :deep(.bubble.assistant) {
  width: fit-content;
  max-width: 100%;
  min-width: 3.5em;
  padding: var(--message-padding, 14px 18px);
  border: 1px solid color-mix(in srgb, var(--ui-border-strong-border) 52%, transparent);
  border-radius: var(--skin-bubble-radius, var(--radius-xs, 4px));
  background: color-mix(in srgb, var(--ui-text-primary-fg) 4%, transparent);
  /* Landing from a quote deepens the frame — STATE, not an animation; only
     the 120ms fade is motion (§3.6). */
  transition: border-color var(--duration-fast) var(--ease-default), background-color var(--duration-fast) var(--ease-default);
}

.message.is-room-agent.highlighted :deep(.bubble.assistant) {
  border-color: color-mix(in srgb, var(--ui-accent-primary-fg) 70%, transparent);
  background: color-mix(in srgb, var(--ui-text-primary-fg) 8%, transparent);
}

/* The verdict is not in yet ('[pa…' could still become speech): hold a bare
   ellipsis on the speech axis. A resolved pass never reaches the room list —
   ChatPanel drops it from the projection. */
.collab-pass-line.is-room {
  margin: 0;
  /* Sits on the speech axis, which after the W15c outdent is the wrapper's
     own left edge — the line is not inside `.message`, so it never received
     the outdent and a gutter indent here would push it off the column. */
  padding-left: 0;
}

/* Continued message in a group: each one keeps its own frame (IM manners — a
   burst reads as several small boxes, not one merged slab). The stack gap is
   the list's; all that is left here is the footer, which cannot paint a 28px
   action row into an 8px gap without landing on the text above it. */
.message-item-wrapper.is-room-stacked .message-footer {
  display: none;
}

/* Narrow windows: ChatPanel drops the reading column to `100% - 48px` (and
   `100% - 24px` below 480), leaving 24px/12px of page margin — less than the
   38px gutter. Hanging the avatar there would put it under the scroller's
   `overflow-x: hidden` and simply clip it, so below the same breakpoint the
   gutter comes back INSIDE the column: the avatar stays visible, the column
   narrows by 38px, and nothing overflows. The footer follows it back. */
@media (max-width: 768px) {
  .message-item-wrapper.is-room-row .message.is-room-agent {
    margin-left: 0;
    width: 100%;
  }

  .message-item-wrapper.is-room-row .message-footer {
    left: var(--room-gutter);
  }

  .message-item-wrapper.is-room-row .message.user .message-footer {
    left: 0;
  }

  .collab-pass-line.is-room {
    padding-left: var(--room-gutter, calc(28px + var(--message-gap, 10px)));
  }
}
</style>

<!-- Global styles for the Teleported reaction attribution popover (W8b). -->
<style>
/* Paper-and-ink floating label (§3.6): 1px line, 4px radius, no shadow
   stack, 11px type. It answers "who" and nothing else — pointer-transparent
   so the chip underneath keeps every click, and a 120ms fade so it appears
   without announcing itself. */
.reaction-attribution {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 220px;
  padding: 4px 6px;
  border: 1px solid var(--ui-border-strong-border);
  border-radius: 4px;
  background: var(--ui-surface-floating-bg);
  pointer-events: none;
  animation: reactionAttributionIn 0.12s ease-out;
}

@keyframes reactionAttributionIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.reaction-attribution-row {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 16px;
}

/* Same stamp the room gutter uses, shrunk to label scale: a hairline circle
   around the emoji, never a filled disc. */
.reaction-attribution-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  border: 1px solid color-mix(in srgb, var(--ui-text-primary-fg) 35%, transparent);
  border-radius: 50%;
  font-size: 9px;
  line-height: 1;
}

.reaction-attribution-name {
  overflow: hidden;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ui-text-primary-fg);
}
</style>
