<template>
  <section
    class="outline-workbench"
    aria-label="Contents"
  >
    <div class="outline-head">
      <span class="outline-head-title">Contents</span>
      <span
        class="outline-head-leader"
        aria-hidden="true"
      />
      <span
        v-if="contentsSummary"
        class="outline-head-live"
      >{{ contentsSummary }}</span>
      <div class="outline-mode-switch">
        <button
          type="button"
          :class="['outline-mode-option', { active: outlineMode === 'topics' }]"
          @click="setOutlineMode('topics')"
        >
          Topics
        </button>
        <span
          class="outline-mode-sep"
          aria-hidden="true"
        >/</span>
        <button
          type="button"
          :class="['outline-mode-option', { active: outlineMode === 'message' }]"
          @click="setOutlineMode('message')"
        >
          Message
        </button>
      </div>
    </div>

    <div class="outline-body">
      <div
        v-if="outlineMode === 'topics'"
        class="outline-topics"
      >
        <SessionSegmentList
          v-if="tocSegments.length > 0"
          :segments="tocSegments"
          :messages-by-segment="topicMessages"
          @jump-message="handleMessageJump"
        />
        <!-- No segments yet (young session, or the segmenter has not run):
             the user messages alone still make a serviceable outline. -->
        <ol
          v-else-if="userMarkers.length > 0"
          class="outline-usermsg-flat"
        >
          <li
            v-for="marker in userMarkers"
            :key="marker.id"
          >
            <button
              type="button"
              class="outline-usermsg-row"
              @click="handleMessageJump(marker.id)"
            >
              <span
                class="outline-usermsg-tick"
                aria-hidden="true"
              />
              <span class="outline-usermsg-text">{{ marker.preview }}</span>
            </button>
          </li>
        </ol>
        <div
          v-else
          class="outline-empty"
        >
          {{ tocLoading ? '…' : 'Nothing recorded yet' }}
        </div>
      </div>
      <!-- Message 模式:这一格是**宿主**,内容由聊天面的 MessageList teleport
           进来(见 `composables/useOutlineRail.ts`)。两种模式都保持挂载 ——
           它是个 teleport 目标,拆了就等于把轨扔到 body 上。 -->
      <div
        v-show="outlineMode === 'message'"
        ref="outlineHostRef"
        class="outline-rail-host"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 右栏「Contents」页签(会话域)—— 外壳布局收敛 L3。
 *
 * 承自 `components/chat/ChatSidePanel.vue` 的第一段(逐字搬,不重写):会话目录
 * (topics)与当前长回复的标题轨(message)是同一件事的两种视图,共用一条模式
 * 开关。大纲栏作为独立第四列已退役,这里是它唯一的落点。
 *
 * 跳转走 `jump-to-source` —— 与 Media 面板的「跳到来源消息」同一条既有链路
 * (`RightWorkbenchPanel` 中继 → App 的 `handleWorkbenchJumpToSource`),不新开路。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import SessionSegmentList, { type SegmentUserMessage } from '@/components/common/SessionSegmentList.vue'
import { groupMarkersBySegment } from '@/components/chat/session-topic-grouping'
import { releaseOutlineRailHost, setOutlineRailHost } from '@/composables/useOutlineRail'
import { sessionsApi } from '@/platform/sessions-client'
import type { SessionSegment, UserMessageMarker } from '@/types'

type OutlineMode = 'topics' | 'message'

const props = withDefaults(defineProps<{
  sessionId?: string
  /** 这一格此刻是不是选中的那条页签(切回来时重读一次目录)。 */
  active?: boolean
}>(), {
  sessionId: undefined,
  active: true,
})

const emit = defineEmits<{
  'jump-to-source': [payload: { sessionId: string, messageId: string }]
}>()

const OUTLINE_MODE_STORAGE_KEY = 'workbenchOutlineMode'
const OUTLINE_CURRENT_CHANGED_EVENT = 'assistant-outline:current-changed'

const sessionsStore = useSessionsStore()
const chatStore = useChatStore()

const outlineHostRef = ref<HTMLElement | null>(null)
const outlineSummary = ref('')
const tocSegments = ref<SessionSegment[]>([])
const tocLoading = ref(false)
const outlineMode = ref<OutlineMode>(readStoredOutlineMode())

const isDraftSession = computed(() => props.sessionId ? sessionsStore.isNewChatDraftId(props.sessionId) : false)

const userMarkers = computed<UserMessageMarker[]>(() => {
  if (!props.sessionId) return []
  return chatStore.sessionUserMarkers.get(props.sessionId) ?? []
})

/** User messages folded under their topic, in the shape the list renders. */
const topicMessages = computed<Record<string, SegmentUserMessage[]>>(() => {
  const groups = groupMarkersBySegment(tocSegments.value, userMarkers.value)
  return Object.fromEntries(groups.map(group => [
    group.segment.id,
    group.markers.map(marker => ({ id: marker.id, preview: marker.preview })),
  ]))
})

const contentsSummary = computed(() => {
  if (outlineMode.value === 'message') return outlineSummary.value
  if (tocLoading.value) return ''
  const count = tocSegments.value.length
  return count ? `${count}` : ''
})

function readStoredOutlineMode(): OutlineMode {
  return localStorage.getItem(OUTLINE_MODE_STORAGE_KEY) === 'message' ? 'message' : 'topics'
}

function setOutlineMode(mode: OutlineMode): void {
  if (outlineMode.value === mode) return
  outlineMode.value = mode
  localStorage.setItem(OUTLINE_MODE_STORAGE_KEY, mode)
}

/**
 * Segments are written after the session goes quiet, so the list is stale by
 * construction. Reloading when this tab opens (and on every session switch) is
 * the cheapest way to stay current without polling a file on a timer. Markers
 * ride along: the topics view needs both, and the marker fetch is a light
 * index read.
 */
async function loadContents(): Promise<void> {
  const sessionId = props.sessionId
  if (!sessionId || isDraftSession.value) {
    tocSegments.value = []
    return
  }
  tocLoading.value = true
  try {
    const [response] = await Promise.all([
      sessionsApi.getSegments({ sessionId }),
      chatStore.loadUserMessageMarkers(sessionId),
    ])
    if (props.sessionId !== sessionId) return
    tocSegments.value = response.success ? response.segments : []
  } catch {
    tocSegments.value = []
  } finally {
    tocLoading.value = false
  }
}

function handleMessageJump(messageId: string): void {
  if (!props.sessionId) return
  emit('jump-to-source', { sessionId: props.sessionId, messageId })
}

function handleOutlineCurrentChanged(event: Event) {
  const detail = (event as CustomEvent<{ sessionId?: string, label?: string, count?: number }>).detail
  if (!detail) return
  if (props.sessionId && detail.sessionId && detail.sessionId !== props.sessionId) return
  outlineSummary.value = detail.count ? detail.label || '' : ''
}

watch(outlineHostRef, (host, previous) => {
  if (previous) releaseOutlineRailHost(previous)
  setOutlineRailHost(host)
}, { flush: 'post' })

watch(() => props.sessionId, () => {
  outlineSummary.value = ''
  void loadContents()
}, { immediate: true })

/* 分段是会话安静下来之后才写的,这条页签在后台待着的那段时间里它一直在变旧。
   切回来重读一次 —— 与大纲栏时代"这一段拿到焦点就重读"同一条口径。 */
watch(() => props.active, (active) => {
  if (active) void loadContents()
})

onMounted(() => {
  setOutlineRailHost(outlineHostRef.value)
  window.addEventListener(OUTLINE_CURRENT_CHANGED_EVENT, handleOutlineCurrentChanged)
})

onUnmounted(() => {
  releaseOutlineRailHost(outlineHostRef.value)
  window.removeEventListener(OUTLINE_CURRENT_CHANGED_EVENT, handleOutlineCurrentChanged)
})
</script>

<style scoped>
.outline-workbench {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--ui-text-primary-fg);
}

.outline-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 34px;
  padding: 8px 10px;
}

.outline-head-title {
  flex: 0 0 auto;
  color: color-mix(in srgb, var(--ui-text-primary-fg) 82%, var(--ui-text-muted-fg));
  font-family: var(--font-display, var(--font-serif, serif));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
}

/* 点线:题名与摘要之间的引导线(承自大纲栏,账页调子不变) */
.outline-head-leader {
  flex: 1 1 auto;
  align-self: center;
  height: 0;
  min-width: 12px;
  border-bottom: 1.5px dotted color-mix(in srgb, var(--ui-border-strong-border) 85%, transparent);
  transform: translateY(1px);
}

.outline-head-live {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-text-muted-fg);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Topics / Message 切换:账页小注,当前项落墨 */
.outline-mode-switch {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 4px;
  align-items: baseline;
}

.outline-mode-option {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font-family: var(--type-mono-font, monospace);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.outline-mode-option:hover {
  color: var(--ui-text-primary-fg);
}

.outline-mode-option.active {
  color: var(--ui-text-primary-fg);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.outline-mode-sep {
  color: color-mix(in srgb, var(--ui-text-muted-fg) 55%, transparent);
  font-size: 9.5px;
}

.outline-body {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.outline-rail-host {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px;
}

/* topics 视图:与 rail 宿主同一呼吸,自己滚动 */
.outline-topics {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 10px 10px;
}

/* 尚无分段时的纯 user message 列表 */
.outline-usermsg-flat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.outline-usermsg-row {
  display: flex;
  gap: 7px;
  align-items: baseline;
  width: 100%;
  padding: 2px 4px;
  margin: 0 -4px;
  border: none;
  border-radius: var(--radius-xs, 4px);
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* 中性 hover 底走统一档(与 SessionSegmentList 逐字同一条配方)。 */
.outline-usermsg-row:hover {
  background: var(--ui-state-hover-bg);
}

.outline-usermsg-tick {
  flex: 0 0 auto;
  width: 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-text-muted-fg) 65%, transparent);
  transform: translateY(-3px);
}

.outline-usermsg-text {
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 11.5px;
  line-height: 1.35;
  color: color-mix(in srgb, var(--ui-text-primary-fg) 84%, transparent);
}

/* 目录空态:与 leader 线同一淡墨,不喧宾夺主 */
.outline-empty {
  font-size: 11.5px;
  color: var(--ui-text-muted-fg);
  font-style: italic;
}
</style>
