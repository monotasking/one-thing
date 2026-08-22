<template>
  <div
    class="say-row"
    :class="{
      'is-head': head,
      'is-tail': tail,
      'is-self': isUser,
      'is-addressed': addressed,
      'is-highlighted': highlighted,
      'is-hover-anchor': hovered || barPinned,
      'is-me-unread': mentionUnread,
    }"
    :data-index="index"
    :data-message-id="message.id"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <!-- 悬浮操作条(im-message §E):hover 才挂,absolute 骑在行上缘右侧 ——
         **不占行高、不引起重排**。只在 hover / 面板开着时存在于 DOM 里:
         一屏几百行,常驻六枚按钮是白交的税。 -->
    <div
      v-if="canReply && (hovered || barPinned)"
      class="say-hoverbar"
    >
      <button
        v-for="emoji in quickEmojis"
        :key="emoji"
        type="button"
        class="say-hoverbar-btn"
        @click.stop="applyReaction(emoji)"
      >
        {{ emoji }}
      </button>
      <button
        ref="emojiButtonRef"
        type="button"
        class="say-hoverbar-btn"
        aria-label="更多表情"
        @click.stop="toggleEmojiPanel"
      >
        <Smile
          :size="14"
          :stroke-width="1.7"
        />
      </button>
      <span
        class="say-hoverbar-sep"
        aria-hidden="true"
      />
      <button
        type="button"
        class="say-hoverbar-btn"
        aria-label="引用回复"
        @click.stop="handleReply"
      >
        <Reply
          :size="14"
          :stroke-width="1.7"
        />
      </button>
      <button
        ref="moreButtonRef"
        type="button"
        class="say-hoverbar-btn"
        aria-label="更多"
        @click.stop="openMoreMenu"
      >
        ⋯
      </button>
    </div>

    <!-- 表情面板挂 body:中栏是个 Scrollbar 容器,面板留在行里会被裁掉。 -->
    <!-- P1:坐标/翻转/视口回弹交给 Popover 内核;原先那张全屏 backdrop 由 closeOn.outside 顶替(点面板外一样关,滚动同样关)。
         bottom-end = 面板右缘对齐按钮右缘,与原先 rect.right - 216 一致。面板皮肤留在插槽里的这层 div 上:
         插槽内容仍在本组件的 scoped 作用域内,而 Popover 的根元素不在(方案 §6.1 的坑)。 -->
    <Popover
      v-model:open="emojiPanelOpen"
      :anchor="emojiButtonRef"
      placement="bottom-end"
      :offset="6"
      :z-offset="25"
      :surface="false"
      :close-on="{ esc: true, outside: true, scroll: true }"
    >
      <div class="say-emoji-panel">
        <div class="say-emoji-cap">
          最近
        </div>
        <div class="say-emoji-grid">
          <button
            v-for="emoji in panelRecentEmojis"
            :key="`recent-${emoji}`"
            type="button"
            @click.stop="applyReaction(emoji)"
          >
            {{ emoji }}
          </button>
        </div>
        <div class="say-emoji-cap">
          常用
        </div>
        <div class="say-emoji-grid">
          <button
            v-for="emoji in SAY_COMMON_EMOJIS"
            :key="`common-${emoji}`"
            type="button"
            @click.stop="applyReaction(emoji)"
          >
            {{ emoji }}
          </button>
        </div>
      </div>
    </Popover>

    <!-- 「⋯」低频项走既有 ContextMenu(teleport + 视口回弹都是现成的)。 -->
    <ContextMenu
      :show="moreMenuOpen"
      :x="moreMenuPosition.x"
      :y="moreMenuPosition.y"
      :items="moreMenuItems"
      :min-width="150"
      @select="onMoreMenuSelect"
      @close="moreMenuOpen = false"
    />

    <!-- 引用(§3.5 A / im-message §B,Discord 式):整行骑在署名之上,一根圆角
         拐线从头像列拐上来钩住它 —— 「TA 答的是哪一句」在名字之前先被看到。
         竖线身份色改为只染作者名;原文已删则灰化不可点(快照仍在)。 -->
    <button
      v-if="replyQuote && !quoteSuppressed"
      type="button"
      class="say-quote"
      :class="{ 'is-gone': quoteMissing }"
      :style="quoteColorStyle"
      :disabled="quoteMissing"
      @click.stop="quoteMissing ? undefined : emit('jumpToMessage', replyQuote.messageId)"
    >
      <AgentAvatar
        v-if="quoteAuthor?.agent"
        class="say-quote-avatar"
        :avatar="quoteAuthor.agent.avatar"
        :avatar-image="quoteAuthor.agent.avatarImage"
        :size="QUOTE_AVATAR_SIZE"
      />
      <AgentAvatar
        v-else-if="quoteAuthor?.isUser"
        class="say-quote-avatar"
        :avatar="userProfile.avatar || USER_AVATAR_FALLBACK"
        :avatar-image="userProfile.avatarImage"
        :size="QUOTE_AVATAR_SIZE"
      />
      <span
        v-else
        class="say-quote-avatar say-quote-avatar--plain"
        aria-hidden="true"
      >?</span>
      <span class="say-quote-author">{{ replyQuote.authorLabel }}</span>
      <span class="say-quote-excerpt">{{ quoteExcerptText }}</span>
    </button>

    <!-- 头像列:一段发言只在头一条上有人,后续条留白,正文吊在同一条轴上。 -->
    <div class="say-gutter">
      <button
        v-if="head && canOpenAgentSpace"
        type="button"
        class="say-avatar-btn"
        :aria-label="`${senderName} 的空间`"
        @click="openAgentSpace"
      >
        <AgentAvatar
          class="say-avatar"
          :avatar="sender?.avatar"
          :avatar-image="sender?.avatarImage"
          :size="AVATAR_SIZE"
        />
      </button>
      <AgentAvatar
        v-else-if="head && sender"
        class="say-avatar"
        :avatar="sender.avatar"
        :avatar-image="sender.avatarImage"
        :size="AVATAR_SIZE"
      />
      <!-- 用户头像走同一个 AgentAvatar(该组件本无 agent 语义):emoji/图片两层
           与同事逐像素同源,缺省 emoji 由调用点给,组件的 🤖 一个字不改。 -->
      <AgentAvatar
        v-else-if="head && isUser"
        class="say-avatar"
        :avatar="userProfile.avatar || USER_AVATAR_FALLBACK"
        :avatar-image="userProfile.avatarImage"
        :size="AVATAR_SIZE"
      />
    </div>

    <div class="say-body">
      <!-- 署名行在**正文之上**(方案 A):名字带身份色 + 角色徽标 + 时间。
           不带气泡、不左右横跳 —— 我方与他人同一排版,区别只在署名与底色。 -->
      <div
        v-if="head"
        class="say-sig"
      >
        <button
          v-if="canOpenAgentSpace"
          type="button"
          class="say-sig-name is-contact"
          :style="senderColorStyle"
          :aria-label="`${senderName} 的空间`"
          @click="openAgentSpace"
        >
          {{ senderName }}
        </button>
        <span
          v-else
          class="say-sig-name"
          :style="senderColorStyle"
        >{{ senderName }}</span>
        <span
          v-if="sender?.title"
          class="say-sig-role"
        >{{ sender.title }}</span>
        <!-- 墓碑徽标(域模型 M4):这个人退休了,这句话还在。 -->
        <span
          v-if="sender?.isRetired"
          class="say-sig-retired"
        >已注销</span>
        <time
          v-if="clock"
          class="say-sig-time"
        >{{ clock }}</time>
      </div>

      <!-- 旁观插话(agent-im-dm.md §4.3):双成员 dm 房里用户说的话。 -->
      <span
        v-if="showBystanderTag"
        class="say-bystander"
      >旁观插话</span>

      <!-- 正文:走既有 markdown 渲染链(MessageMarkdown → Streaming/StaticMarkdown
           + markdownRenderCache + deferredMarkdownHydration)。say 里的表格 /
           代码 / 列表因此与别处**逐像素同源**,本组件一个 markdown 规则都不写。 -->
      <div
        v-if="displayContent"
        class="say-text md-say-scope md-code-block-scope md-inline-code-scope"
      >
        <MessageMarkdown
          :content="displayContent"
          :is-user="isUser"
          :live="false"
          :is-streaming="false"
        />
      </div>

      <!-- 附件:图片走既有缩略图组件,其余走既有文件 chip。 -->
      <div
        v-if="message.attachments?.length"
        class="say-attachments"
      >
        <div
          v-if="imageAttachments.length > 0"
          class="say-attachment-images"
          :class="{ grid: imageAttachments.length > 1 }"
        >
          <figure
            v-for="attachment in imageAttachments"
            :key="attachment.id"
            class="say-figure"
          >
            <AttachmentThumb
              size="md"
              clickable
              :src="attachmentImageSrc(attachment)"
              :alt="attachment.fileName"
              @open="openAttachmentImage(attachment)"
            />
            <figcaption class="say-figure-caption">
              {{ attachment.fileName }} · {{ formatFileSize(attachment.size) }}
            </figcaption>
          </figure>
        </div>
        <div
          v-if="fileAttachments.length > 0"
          class="say-attachment-files"
        >
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

      <!-- 「展开执行 →」:中栏**唯一**的执行入口(W3)。执行细节全在右栏线程,
           这里只派事件。拿不到 workSessionId 的时候这个按钮根本不渲染
           (见 SayChatFlow 的 threadEntry 解析),不派空事件。 -->
      <button
        v-if="threadEntry"
        type="button"
        class="say-thread-entry"
        :aria-label="`${threadEntry.title} · 在右栏线程里看这次执行`"
        @click.stop="openThread"
      >
        <span class="say-thread-entry-label">展开执行</span>
        <span
          class="say-thread-entry-arrow"
          aria-hidden="true"
        >→</span>
      </button>

      <!-- 表情(§3.5 B):房间既有的那份投影(reactions.ts),不另起一套。 -->
      <div
        v-if="reactionChips.length > 0"
        class="say-reactions"
      >
        <button
          v-for="chip in reactionChips"
          :key="chip.emoji"
          type="button"
          class="say-reaction-chip"
          :class="{ mine: chip.mine }"
          :aria-label="`${chip.emoji} · ${chip.reactors.map(reactor => reactor.label).join('、')}`"
          @click.stop="emit('react', message.id, chip.emoji)"
        >
          <span class="say-reaction-emoji">{{ chip.emoji }}</span>
          <span class="say-reaction-count">{{ chip.count }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 聊天面的一条消息(docs/design/im-workbench-layout.md §3 W2 / §5 C2′)。
 *
 * 形态走方案 A 频道台(`docs/design/im-redesign/a-channels.html`):
 * 30px 头像在左、署名行在上、正文在下、不带气泡也不左右横跳。
 *
 * **这个组件只渲染 say**:工具卡、StepsPanel、diff、思考过程一律不进来 ——
 * 那些是"某个 agent 在后台干活",归右栏线程(W4)。中栏最多留一个
 * 「展开执行 →」入口。
 *
 * 复用清单(本组件**没有**自写实现的东西):
 *  - markdown:`MessageMarkdown`(→ Static/StreamingMarkdown + markdownRenderCache
 *    + deferredMarkdownHydration)
 *  - 附件:`AttachmentThumb` / `FileChip` / `formatFileSize`
 *  - 引用快照:`message.replyTo` + `reply-quote.ts` 的 `buildReplyToSnapshot`
 *  - 表情投影:`message/reactions.ts` 的 `buildReactionChips`
 *  - 署名身份:`agentsStore.displayAgent`(域模型 M4:retired 返回墓碑,永不炸)
 *  - @提及渲染:`renderCollabMentionText`
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Reply, Smile } from 'lucide-vue-next'
import type { ChatMessage, MessageAttachment } from '@/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AttachmentThumb from '@/components/common/AttachmentThumb.vue'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { ContextMenuItem } from '@/components/common/context-menu'
import FileChip from '@/components/common/FileChip.vue'
import { SAY_COMMON_EMOJIS, useSayRecentEmojis } from './say-emoji'
import { copyTextToClipboard } from '@/utils/clipboard'
import MessageMarkdown from '../message/MessageMarkdown.vue'
import Popover from '@/components/common/Popover.vue'
import { buildReactionChips } from '../message/reactions'
import { REPLY_USER_LABEL, buildReplyToSnapshot } from '../message/reply-quote'
import { SAY_METRICS } from './say-typography'
import { formatFileSize } from '@/utils/format'
import { isActiveAgent } from '@shared/ipc'
import { renderCollabMentionMarkup } from '@/composables/collabInlineTags'
import {
  USER_AVATAR_FALLBACK,
  isCollabUserAuthorLabel,
  useUserProfile,
} from '@/composables/useUserProfile'
import { mediaWindowApi } from '@/platform/media-window-client'
import { useAgentsStore } from '@/stores/agents'
import { OPEN_MEMBERS_EVENT, type OpenMembersDetail } from '@/components/workbench/room-members'
import type { ChatMessageReplyTo } from '@/types'

const AVATAR_SIZE = SAY_METRICS.avatarSizePx
/** 引用条上的小头像(im-message §B)。比署名头像小一号,不抢正文。 */
const QUOTE_AVATAR_SIZE = 16

const props = defineProps<{
  message: ChatMessage
  index: number
  head: boolean
  tail: boolean
  addressed: boolean
  highlighted?: boolean
  /** 单成员 dm 房:一对一无需署名头衔那一套,用户插话也不是"旁观"。 */
  dmMode?: boolean
  /** agent ↔ agent 私聊房:用户在这里是旁观者。 */
  pairDmMode?: boolean
  /** 「展开执行 →」的落点;null 就不画(拿不到 workSessionId 不派空事件)。 */
  threadEntry?: { workSessionId: string; title: string; taskId?: string } | null
  /** 这条消息所在的房 —— 署名头像下钻右栏空间页时的靶子(R2)。 */
  roomSessionId?: string
  /**
   * 被引用的那条原文**确实没了**(im-message §B 的降级态)。
   *
   * 只有上游能负责任地回答这个问题:一条消息不在当前列表里,可能是被删了,
   * 也可能只是还没翻到那一页。判定留在 SayChatFlow(它拿得到"历史是否已
   * 读全"),这里只画。
   */
  quoteMissing?: boolean
  /**
   * 连发里引同一句的后续条不画引用(say-rows 的口径)。反向命名是刻意的:
   * Vue 会把缺省的 boolean prop 强转成 false,「缺省 = 画」只有反着说才成立。
   */
  quoteSuppressed?: boolean
  /**
   * 这个会话的已读水位(epoch ms)。晚于它的「@我」才是未读的那一枚橘 pill。
   * 由上层读一次交下来 —— 一屏几百行不该各自去问仓储。缺省 0 = 全部已读。
   */
  unreadSince?: number
}>()

const emit = defineEmits<{
  reply: [replyTo: ChatMessageReplyTo]
  react: [messageId: string, emoji: string]
  jumpToMessage: [messageId: string]
}>()

const agentsStore = useAgentsStore()
/** 「我」也是这个群里的一个人:有名字、有头像(agent-dm-user.md §5 Q2)。 */
const { profile: userProfile, mentionLabels: userMentionLabels } = useUserProfile()

/**
 * @我 的未读态(im-message §A 修订):这条消息还没被看过(晚于已读水位)时,
 * 行挂 is-me-unread,pill 实底橘;看过(readAt 追上来)即褪回常态 pill。
 *
 * 水位由**上层**读一次交下来(prop),不是每行自己去问仓储:一屏几百行就是几百
 * 次 store 查询,而"这一屏读到哪儿了"整张列表只有一个答案。行只管比自己的时间。
 * `unreadSince` 缺省 0 = 没有水位 = 全部已读(与 isMarkUnread 的口径同源)。
 */
const mentionUnread = computed(() => {
  if (!props.addressed || !props.unreadSince) return false
  const timestamp = props.message.timestamp
  return typeof timestamp === 'number' && timestamp > props.unreadSince
})

const isUser = computed(() => props.message.role === 'user')

/**
 * 署名走 `displayAgent`(域模型 M4):在职 → 正常;已退休 → 名字照旧 +
 * 「已注销」徽标;查无此人 → 墓碑。历史署名永远读得出来,渲染永不炸。
 */
const sender = computed(() => {
  if (props.message.role !== 'assistant' || !props.message.agentId) return null
  const identity = agentsStore.displayAgent(props.message.agentId)
  return {
    name: identity.name,
    title: identity.title,
    avatar: identity.avatar,
    avatarImage: identity.avatarImage,
    color: identity.color,
    isRetired: !isActiveAgent(identity),
  }
})

/**
 * 配了名字就显示名字,没配保持「我」(§5 Q2:IM 里每个说话者含自己都有名有脸;
 * 但没配置过资料的人不该突然在自己的消息上看见「用户」)。
 */
const senderName = computed(() => (isUser.value ? userProfile.value.name : sender.value?.name || '成员'))

/** 身份色只染名字,正文不带任何底色(方案 A 的注 3)。 */
const senderColorStyle = computed(() =>
  sender.value?.color ? { color: sender.value.color } : undefined)

/**
 * 点头像/名字 = 进 TA 的空间(agent-im-chat-ui.md C3)。
 * 私聊房里不给:一对一房里再放一个「去认识 TA」的入口是原地打转。
 */
const canOpenAgentSpace = computed(() =>
  Boolean(sender.value) && !props.dmMode && Boolean(props.message.agentId))

/**
 * R2:署名头像/名字 → **右栏空间页**(样板「中栏署名头像点击也到这里」)。
 * 下钻不新开 tab —— 事件带 agentId 就是直接落在成员 tab 的下钻层。
 *
 * 拿不到房 id 时退回既有的全屏空间页:宁可换个地方打开,也不吞掉这次点击。
 */
function openAgentSpace(): void {
  if (!canOpenAgentSpace.value) return
  const agentId = props.message.agentId || ''
  if (props.roomSessionId) {
    window.dispatchEvent(new CustomEvent<OpenMembersDetail>(OPEN_MEMBERS_EVENT, {
      detail: { sessionId: props.roomSessionId, agentId },
    }))
    return
  }
  agentsStore.openAgentSpace(agentId)
}

const clock = computed(() => {
  const timestamp = props.message.timestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
})

const displayContent = computed(() =>
  renderCollabMentionMarkup(
    props.message.content,
    props.message.mentions,
    agentsStore.agents,
    userMentionLabels.value,
  ))

const replyQuote = computed(() => {
  const replyTo = props.message.replyTo
  if (!replyTo?.excerpt) return null
  return replyTo
})

/**
 * 被引者的身份(im-message §B:竖线/名字取 TA 的身份色,配一枚 16px 头像)。
 *
 * 快照里只有 authorLabel —— 引用是**一段话的快照**,不是一个 id 引用。所以
 * 这里按名字在花名册上找,而且**只认唯一命中**:重名的时候给不出确定的那
 * 个人,就退回中性色 + 问号头像,绝不挑一个显示。
 */
const quoteAuthor = computed(() => {
  const label = replyQuote.value?.authorLabel?.trim()
  if (!label) return null
  // 快照里的用户署名可能是「用户」(旧数据)也可能是 TA 的名字(配了资料之后),
  // 两者都是同一个人 —— 只认一个的代价是老引用突然掉进"重名判不出"的中性态。
  if (isCollabUserAuthorLabel(label, userProfile.value)) {
    return { isUser: true, agent: null, color: undefined }
  }
  const matches = agentsStore.agents.filter(agent => agent.name?.trim() === label)
  if (matches.length !== 1) return null
  const identity = agentsStore.displayAgent(matches[0].id)
  return { isUser: false, agent: identity, color: identity.color }
})

/** 竖线与作者名同一枚变量;拿不到身份色就落回中性描边色。 */
const quoteColorStyle = computed(() =>
  quoteAuthor.value?.color ? { '--say-quote-color': quoteAuthor.value.color } : undefined)

/** 原文没了:摘录前面写清它是快照 —— 这段字还在,但它指的消息不在了。 */
const quoteExcerptText = computed(() => {
  const excerpt = replyQuote.value?.excerpt ?? ''
  return props.quoteMissing ? `原消息已删除 · 快照:${excerpt}` : excerpt
})

/** 旁观插话:只有 agent↔agent 房里用户说的话才是"旁观"。 */
const showBystanderTag = computed(() => Boolean(props.pairDmMode) && isUser.value)

const reactionChips = computed(() =>
  buildReactionChips(props.message.reactions, { agents: agentsStore.agents }))

const canReply = computed(() =>
  props.message.role === 'user' || props.message.role === 'assistant')

function handleReply(): void {
  const snapshot = buildReplyToSnapshot({
    messageId: props.message.id,
    // 与 app 层 `resolveUserIdentity().label` 逐字同源:同一条消息被两侧引用时
    // 必须署同一个名,否则「这条引用的是谁说的」在同一间房里会有两个答案。
    authorLabel: isUser.value
      ? (userProfile.value.configuredName || REPLY_USER_LABEL)
      : senderName.value,
    content: props.message.content,
  })
  if (!snapshot) return
  closeOverlays()
  emit('reply', snapshot)
}

/* ── 悬浮操作条(im-message §E)──────────────────────────────────────
   表情落既有 reactions 投影(emit('react') → useCollabReactions →
   reactToCollabMessage,后端 toggle),引用落既有 ComposerReplyBar 那条链
   (emit('reply') → RoomSurface 的 pendingReplyTo)。这里一条新链路都不起。 */
const hovered = ref(false)
const emojiPanelOpen = ref(false)
const moreMenuOpen = ref(false)
const emojiButtonRef = ref<HTMLElement | null>(null)
const moreButtonRef = ref<HTMLElement | null>(null)
const moreMenuPosition = ref({ x: 0, y: 0 })

const { quick: quickEmojis, panelRecent: panelRecentEmojis, remember: rememberEmoji } = useSayRecentEmojis()

/** 面板/菜单开着的时候操作条不许消失 —— 鼠标已经离开行去点面板了。 */
const barPinned = computed(() => emojiPanelOpen.value || moreMenuOpen.value)

function closeOverlays(): void {
  emojiPanelOpen.value = false
  moreMenuOpen.value = false
}

/** 面板的落点、翻转与视口回弹都由 Popover 内核算(见 template 的 placement/offset);
 *  这里只管「同一时刻只开一个浮层」。 */
function toggleEmojiPanel(): void {
  if (emojiPanelOpen.value) {
    emojiPanelOpen.value = false
    return
  }
  moreMenuOpen.value = false
  emojiPanelOpen.value = true
}

/** 点表情 = 对这条消息 toggle 回应,并把它记进「最近使用」。 */
function applyReaction(emoji: string): void {
  if (!emoji) return
  rememberEmoji(emoji)
  closeOverlays()
  emit('react', props.message.id, emoji)
}

const moreMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [{ id: 'copy', label: '复制文本' }]
  // 「跳转原文」只有在真有落点时才给:引用条自己也是这个规矩。
  if (replyQuote.value && !props.quoteMissing) {
    items.push({ id: 'jump', label: '跳转原文' })
  }
  return items
})

function openMoreMenu(): void {
  const rect = moreButtonRef.value?.getBoundingClientRect()
  emojiPanelOpen.value = false
  moreMenuPosition.value = rect
    ? { x: rect.left, y: rect.bottom + 4 }
    : { x: 0, y: 0 }
  moreMenuOpen.value = true
}

async function onMoreMenuSelect(id: string): Promise<void> {
  moreMenuOpen.value = false
  if (id === 'copy') {
    await copyTextToClipboard(props.message.content ?? '')
    return
  }
  if (id === 'jump' && replyQuote.value) {
    emit('jumpToMessage', replyQuote.value.messageId)
  }
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (!emojiPanelOpen.value && !moreMenuOpen.value) return
  closeOverlays()
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

/**
 * 已定契约(W4 / C3-B 已在 App.vue 监听):
 * `onething:open-thread`,detail = { workSessionId, title?, taskId? }。
 * `threadEntry` 为 null 时按钮不渲染,所以这里不可能派出空 workSessionId。
 */
function openThread(): void {
  const entry = props.threadEntry
  if (!entry?.workSessionId) return
  window.dispatchEvent(new CustomEvent('onething:open-thread', {
    detail: { workSessionId: entry.workSessionId, title: entry.title, taskId: entry.taskId },
  }))
}

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

function openAttachmentImage(attachment: MessageAttachment): void {
  const src = attachmentImageSrc(attachment)
  if (!src) return
  void mediaWindowApi.openPreview({ src, alt: attachment.fileName })
}
</script>

<style scoped>
/* ── 方案 A 频道台的一行(docs/design/im-redesign/a-channels.html)──────────
   数值真源在 say-typography.ts 的 SAY_METRICS,这里只消费它写出来的变量
   (`__tests__/say-typography.test.ts` 用源文本比对钉住两边不漂移)。

   这棵树只在 workbench + 房/私聊下挂载,classic 与直聊根本不渲染它 ——
   所以本文件不需要任何 `:root[data-shell-mode]` 门。 */
.say-row {
  display: flex;
  flex-wrap: wrap; /* 引用条独占第一行(flex-basis:100%),头像+正文换行到其下 */
  gap: 0 var(--say-gutter-gap, 11px);
  padding: var(--say-row-padding-block, 5px) var(--say-row-padding-inline, 20px);
  position: relative;
  overflow-anchor: none;
}

/* hover 锚(im-message §E):整行衬底告诉你操作条/表情面板属于哪条消息。
   类驱动而不是 :hover —— 鼠标进了 teleport 到 body 的面板后行会丢 :hover,
   但归属感不能跟着丢;barPinned(面板/菜单开着)期间衬底钉住。
   波 3 复核:类驱动的机制**正当**(不是该改成 :hover 的疏漏);值也保留 —— 4% 是
   "整行衬底"刻意取的半档,统一档 `--ui-state-hover-bg` 相当于墨 8%(实测差 ΔRGB
   中位 14.1),迁过去会把一整行压成控件级 hover 的分量。 */
.say-row.is-hover-anchor {
  background: color-mix(in srgb, var(--ui-text-primary-fg) 4%, transparent);
}

/* 提及/回我的那条 = 一条左墨条,不是整行黄底。 */
.say-row.is-addressed {
  box-shadow: inset 2px 0 0 var(--ui-accent-primary-fg);
}

.say-row.is-highlighted {
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 12%, transparent);
}

.say-gutter {
  flex-shrink: 0;
  width: var(--say-avatar-size, 30px);
}

.say-avatar-btn {
  position: relative;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  display: block;
}

/* 「可点」提示:静止态与今天完全一致,hover 只垫一层软阴影的立体感 ——
   不描色、不缩放(§3.6),章还是那枚章。按下阴影收紧一档。
   四处头像同一句法。 */
.say-avatar-btn .say-avatar {
  transition: box-shadow var(--duration-fast) var(--ease-default);
}

.say-avatar-btn:hover .say-avatar,
.say-avatar-btn:focus-visible .say-avatar {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ui-text-primary-fg) 22%, transparent);
}

.say-avatar-btn:active .say-avatar {
  box-shadow: 0 1px 3px color-mix(in srgb, var(--ui-text-primary-fg) 18%, transparent);
}

/* 头像的框由本行画(AgentAvatar 只出内容不出框):用户与 agent 同一个
   30px 盒、同一条轴 —— 两种头像不许差一像素。 */
.say-avatar {
  display: grid;
  place-items: center;
  width: var(--say-avatar-size, 30px);
  height: var(--say-avatar-size, 30px);
  border-radius: 50%;
  overflow: hidden;
  font-size: 20px;
  line-height: 1;
  user-select: none;
}

.say-avatar--self {
  font-size: 11px;
  color: var(--ui-text-muted-fg);
  background: color-mix(in srgb, var(--ui-text-primary-fg) 8%, transparent);
}

.say-body {
  flex: 1;
  min-width: 0;
}

.say-sig {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 2px;
}

.say-sig-name {
  font-size: var(--say-signature-size, 12.5px);
  font-weight: 600;
  color: var(--ui-text-primary-fg);
  padding: 0;
  border: none;
  background: none;
}

.say-sig-name.is-contact {
  cursor: pointer;
}

.say-sig-name.is-contact:hover {
  text-decoration: underline;
}

.say-sig-role,
.say-sig-retired {
  font-size: 10px;
  color: var(--ui-text-muted-fg);
  border: 1px solid var(--ui-border-default-border);
  border-radius: 3px;
  padding: 0 4px;
}

.say-sig-time {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted-fg);
}

/* 引用条(im-message §B):2px 身份色竖线 + 16px 头像 + 身份色名字 + 单行摘录。
   hover 整条起底,点击跳回原文;跳转落点的闪烁复用 .say-row.is-highlighted。 */
/* Discord 式引用行:独占整行、骑在署名之上,左端一根圆角拐线从头像列拐上来。
   身份色不再画竖线,只染作者名(--say-quote-color)。 */
.say-quote {
  display: flex;
  gap: 6px;
  align-items: center;
  /* 独占一行靠 flex-basis:100% —— 宽度上限**不能**设在按钮上:按钮被压窄后
     行上有剩余空间,正文会排到引用条右边、按钮还被同行 stretch 拉高。
     上限设在摘录(say-quote-excerpt)上。 */
  flex-basis: 100%;
  min-width: 0;
  position: relative;
  margin: 0 0 2px;
  margin-inline-start: calc(var(--say-avatar-size, 30px) + var(--say-gutter-gap, 11px));
  padding: 1px 8px 1px 4px;
  border: none;
  border-radius: 5px;
  background: none;
  cursor: pointer;
  text-align: start;
  font-size: 12px;
  color: var(--ui-text-muted-fg);
}

/* 拐线:垂直段立在头像中轴上,向上圆角拐进引用行。几何 = 头像半径 + 列距。 */
.say-quote::before {
  content: '';
  position: absolute;
  inset-inline-start: calc(-1 * (var(--say-gutter-gap, 11px) + var(--say-avatar-size, 30px) / 2) + 1px);
  top: 50%;
  width: calc(var(--say-gutter-gap, 11px) + var(--say-avatar-size, 30px) / 2 - 8px);
  height: calc(50% + 6px);
  border-inline-start: 2px solid var(--ui-border-default-border);
  border-top: 2px solid var(--ui-border-default-border);
  border-start-start-radius: 6px;
  pointer-events: none;
}

.say-quote:hover:not(:disabled) {
  background: var(--ui-state-hover-bg);
}

.say-quote:disabled {
  cursor: default;
}

.say-quote-avatar {
  flex-shrink: 0;
}

.say-quote-avatar--plain {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 9px;
  color: var(--ui-text-muted-fg);
  background: color-mix(in srgb, var(--ui-text-primary-fg) 8%, transparent);
  user-select: none;
}

.say-quote-author {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--say-quote-color, var(--ui-text-muted-fg));
}

.say-quote-excerpt {
  min-width: 0;
  max-width: 40em; /* 行宽纪律在这,不在按钮上(见 .say-quote 注释) */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 原文已删:整条灰化、摘录斜体 —— 快照读得到,但没有落点可跳。 */
.say-quote.is-gone .say-quote-author,
.say-quote.is-gone .say-quote-excerpt {
  color: var(--ui-text-muted-fg);
  font-style: italic;
  opacity: 0.8;
}

.say-bystander {
  display: inline-block;
  margin-bottom: 2px;
  font-size: 10px;
  color: var(--ui-text-muted-fg);
}

.say-text {
  min-width: 0;
}

.say-attachments {
  margin-top: 7px;
}

.say-attachment-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.say-figure {
  margin: 0;
}

.say-figure-caption {
  margin-top: 2px;
  font-size: 10px;
  color: var(--ui-text-muted-fg);
}

.say-attachment-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

/* 执行入口:虚线 pill,一行,默认收起 —— 方案 A 的「活动线」形态。 */
.say-thread-entry {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding: 3px 9px;
  border: 1px dashed var(--ui-border-default-border);
  border-radius: 20px;
  background: none;
  color: var(--ui-text-muted-fg);
  font-size: 11.5px;
  cursor: pointer;
}

.say-thread-entry:hover {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-text-muted-fg);
}

.say-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}

.say-reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 10px;
  background: none;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
  color: var(--ui-text-muted-fg);
}

.say-reaction-chip.mine {
  color: var(--ui-text-primary-fg);
  border-color: var(--ui-text-muted-fg);
}

/* ── 悬浮操作条(im-message §E)───────────────────────────────────────
   absolute 骑在行上缘右侧:它不占行高,所以 hover 进出时消息流一像素都不动。
   这是"浮"的全部意义 —— 一个会把下面所有消息顶一下的操作条不如没有。 */
.say-hoverbar {
  position: absolute;
  inset-block-start: -13px;
  inset-inline-end: var(--say-row-padding-inline, 20px);
}

/* 连发的后续条没有署名行,行顶就是正文第一行 —— 骑在 -13px 会遮住正在读的
   字。整体抬出行外(自身 30px 高),压在行距与上一条的收尾上,自己一字不遮;
   头条照旧骑行上缘,顶上是署名行,不碍读。 */
.say-row:not(.is-head) .say-hoverbar {
  /* 条高 30px:底边恰好贴住行顶。不能再高 —— 留出缝隙的话,鼠标从行里挪向
     条的半路会触发 mouseleave,条在够到之前就消失了。 */
  inset-block-start: -30px;
}

.say-hoverbar {
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px 3px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 8px;
  background: var(--ui-surface-floating-bg);
  box-shadow: var(--shadow-floating, 0 4px 14px rgba(20, 18, 12, 0.1));
}

.say-hoverbar-btn {
  display: grid;
  place-items: center;
  min-width: 26px;
  height: 24px;
  padding: 0 4px;
  border: none;
  border-radius: 5px;
  background: none;
  font-size: 13px;
  line-height: 1;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-default), background var(--duration-fast) var(--ease-default);
}

.say-hoverbar-btn:hover {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
  transform: scale(1.06);
}

.say-hoverbar-sep {
  flex-shrink: 0;
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: var(--ui-border-default-border);
}

/* 表情面板:定位/层级(+25)/视口回弹都在 Popover 内核的内联样式里,这里只剩皮肤。
   面板是 Popover 的根元素 —— 子组件根元素会被父级 scoped CSS 命中,所以这条留在本作用域内仍然生效。 */
.say-emoji-panel {
  width: 216px;
  padding: 10px 12px 12px;
  border: 1px solid var(--ui-border-default-border);
  border-radius: 10px;
  background: var(--ui-surface-floating-bg);
  box-shadow: var(--shadow-floating);
  font-size: 13px;
  line-height: normal;
}

.say-emoji-cap {
  margin-bottom: 6px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-text-muted-fg);
}

.say-emoji-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
}

.say-emoji-cap + .say-emoji-grid {
  margin-bottom: 8px;
}

.say-emoji-grid button {
  display: grid;
  place-items: center;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: none;
  font-size: 15px;
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-default), background var(--duration-fast) var(--ease-default);
}

.say-emoji-grid button:hover {
  background: var(--ui-state-hover-bg);
  transform: scale(1.12);
}
</style>
