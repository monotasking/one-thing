<template>
  <!-- 收起态:一枚浮着的小圆钮。它和展开态是**同一个东西的两种大小**,所以
       位置各记各的(收起时拖到哪、展开时拖到哪,互不干扰)。 -->
  <button
    v-if="isOpen && collapsed"
    class="scratchpad-bubble"
    type="button"
    :style="bubbleStyle"
    :aria-label="`展开草稿纸(${charCount} 字)`"
    @mousedown="startBubbleDrag"
    @click="expand"
  >
    <NotebookPen
      :size="18"
      :stroke-width="1.9"
    />
  </button>

  <section
    v-else-if="isOpen"
    class="scratchpad-pad"
    :style="padStyle"
    aria-label="草稿纸"
    @keydown.esc.stop="handleEscape"
  >
    <!-- 头部栏兼拖动把手。工具区自己吃掉 mousedown,否则点一下按钮会连带把
         垫子拖走一像素。 -->
    <header
      class="pad-header"
      @mousedown="startPadDrag"
    >
      <span class="pad-title">草稿纸</span>
      <span
        class="pad-sync"
        :class="isDirty ? 'is-pending' : 'is-synced'"
      >
        <i
          class="pad-sync-dot"
          aria-hidden="true"
        />
        {{ isDirty ? '未保存' : '已保存' }}
      </span>
      <span
        v-if="watermarkLabel"
        class="pad-watermark"
      >{{ watermarkLabel }}</span>

      <span class="pad-spacer" />

      <Tooltip
        text="把水位之后的内容(或选中的一段)正式发出 ⌘⏎"
        position="top"
      >
        <Button
          size="small"
          class="pad-icon-btn"
          native-type="button"
          :disabled="!hasUnreadTail"
          aria-label="正式发出草稿纸内容"
          @mousedown.stop.prevent
          @click.stop="requestSend"
        >
          <template #icon>
            <CornerDownLeft
              :size="14"
              :stroke-width="2"
            />
          </template>
        </Button>
      </Tooltip>

      <Tooltip
        text="收起成小圆钮(Esc)"
        position="top"
      >
        <Button
          size="small"
          class="pad-icon-btn"
          native-type="button"
          aria-label="收起草稿纸"
          @mousedown.stop.prevent
          @click.stop="collapse"
        >
          <template #icon>
            <X
              :size="14"
              :stroke-width="2"
            />
          </template>
        </Button>
      </Tooltip>
    </header>

    <div class="pad-body">
      <TiptapNoteEditor
        ref="editorRef"
        :model-value="content"
        surface="todo-notes"
        :document-id="documentId"
        :document-path="filePath"
        :workspace-root="documentDir"
        :features="PAD_FEATURES"
        :consumed-offset="consumedOffset"
        spellcheck
        placeholder="随手写,AI 会看见"
        slash-z-layer="sidebar"
        :slash-z-offset="10"
        @update:model-value="handleUpdate"
        @keydown="handleEditorKeydown"
        @paste="handlePaste"
        @open-link="openMarkdownLink"
        @open-image="openMarkdownImage"
      />
    </div>

    <footer class="pad-footer">
      <span class="pad-count">{{ charCount }} 字</span>
    </footer>

    <!-- 八向拉伸把手。每一枚只是一块透明的抓取区,视觉上什么都不画 —— 边框由
         垫子自己出,把手再画一遍就是两条线。 -->
    <span
      v-for="dir in RESIZE_DIRECTIONS"
      :key="dir"
      class="pad-resize"
      :class="`is-${dir}`"
      role="separator"
      :aria-label="`调整草稿纸大小(${dir})`"
      @mousedown.prevent.stop="startResize(dir, $event)"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * 悬浮草稿垫 —— 一张浮在聊天区之上、可拖可缩、收得起来的纸。
 *
 * ## 为什么不再嵌在输入框里
 * 嵌进 `.input-area` 的那一版解决不了它要解决的问题:滚上去看回复时,输入框
 * 跟着待在最底下,想写字还是得先滚回来。用户的原话是"和 inputbox 没有区别,
 * 反而放大了它的缺点"。所以形态改成自由浮动 —— 纸在哪儿由用户说了算,聊天流
 * 怎么滚都不影响它。
 *
 * ## 层级
 * 垫子取 `--z-sidebar`(200)—— 层级表里"浮动侧栏"那一档,语义上正是它:一块
 * 用户自己摆位置的、常驻的、盖住内容的面。代价说清楚:它会盖住 `--z-dropdown`
 * 档(100)的浮层(比如模型选择器),这与浮动侧栏盖住页面内浮层是同一种关系。
 * 垫子**自己的**浮层(斜杠菜单)必须反过来压过它,所以编辑器往下传
 * `slash-z-layer="sidebar"` + `slash-z-offset="10"`(= 210)。
 *
 * ## 编辑器
 * 三档对比(CM 现状 / 自研 PM 升级 / Tiptap)跑完之后终选 **Tiptap**,对比脚手架
 * 与落选的那两档已经拆掉。纸的存储格式仍是纯 markdown —— 换编辑器换的是呈现,
 * 不是事实。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CornerDownLeft, NotebookPen, X } from 'lucide-vue-next'
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import TiptapNoteEditor from '@/editor/tiptap/TiptapNoteEditor.vue'
import type { MarkdownDocumentEditorHandle, MarkdownFeatureSet } from '@/editor/markdown-document'
import { handleMarkdownAttachmentPaste } from '@/editor/markdown-attachments'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import { useScratchpadPad } from '@/composables/useScratchpadPad'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'
import {
  BUBBLE_SIZE,
  clampBubble,
  clampRect,
  loadPadState,
  resizeRect,
  savePadState,
  viewportSize,
  type FloatingPadState,
} from './floating-pad-state'

const props = withDefaults(defineProps<{
  sessionId?: string
  /** 工程形态之外(房 / 私聊)整块不出现。 */
  available?: boolean
}>(), {
  sessionId: undefined,
  available: true,
})

const emit = defineEmits<{
  /** 正式发出:选区优先,否则水位之后的内容。 */
  (e: 'send', text: string): void
  /** 垫子关掉/收起后把焦点还给输入框。 */
  (e: 'returnFocus'): void
}>()

const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
type ResizeDirection = typeof RESIZE_DIRECTIONS[number]

// 草稿纸是**写想法的地方**,不是文档编辑器:任务/图片/代码块留着(粘图管线
// 要靠 images),表格/公式/frontmatter 关掉 —— 那些属于面板里的正式文档。
const PAD_FEATURES: MarkdownFeatureSet = {
  tasks: true,
  images: true,
  codeBlocks: true,
  tables: false,
  math: false,
  frontmatter: false,
}

const pad = useScratchpadPad(() => props.sessionId, { available: () => props.available })

const editorRef = ref<MarkdownDocumentEditorHandle | null>(null)

const isOpen = computed(() => pad.isOpen.value)
const content = computed(() => pad.content.value)
const filePath = computed(() => pad.filePath.value)
const documentDir = computed(() => pad.documentDir.value)
const charCount = computed(() => pad.charCount.value)
const isDirty = computed(() => pad.isDirty.value)
const hasUnreadTail = computed(() => pad.hasUnreadTail.value)
const documentId = computed(() => `scratchpad:${props.sessionId ?? 'none'}`)

/**
 * 已读末尾的 markdown 字符偏移。头部栏拿它写一句话,编辑器拿它在块边界上画线
 * (`editor/tiptap/consumed-watermark.ts`)—— 同一个数,两处呈现。
 */
const consumedOffset = computed(() => pad.consumedOffset.value)

/** 水位文案由 consumed 事件驱动,不是猜的:没有事件就不说"已读"。 */
const watermarkLabel = computed(() => {
  const offset = consumedOffset.value
  if (offset === null) return content.value.trim() ? 'AI 尚未读过' : ''
  if (offset >= content.value.length) return 'AI 已读全部'
  return `AI 已读至 ${offset} 字`
})

// ---------------------------------------------------------------------------
// 几何:每窗口一份账,与"哪张纸在上面"无关。

const state = ref<FloatingPadState>(loadPadState())
const collapsed = computed(() => state.value.collapsed)

const padStyle = computed(() => ({
  left: `${state.value.rect.x}px`,
  top: `${state.value.rect.y}px`,
  width: `${state.value.rect.width}px`,
  height: `${state.value.rect.height}px`,
}))

const bubbleStyle = computed(() => ({
  left: `${state.value.bubble.x}px`,
  top: `${state.value.bubble.y}px`,
  width: `${BUBBLE_SIZE}px`,
  height: `${BUBBLE_SIZE}px`,
}))

watch(state, value => savePadState(value), { deep: true })

/** 窗口变小后垫子不许留在屏幕外 —— 每次 resize 重新夹一遍。 */
function reclamp(): void {
  const viewport = viewportSize()
  state.value = {
    ...state.value,
    rect: clampRect(state.value.rect, viewport),
    bubble: clampBubble(state.value.bubble, viewport),
  }
}

onMounted(() => window.addEventListener('resize', reclamp))
onBeforeUnmount(() => window.removeEventListener('resize', reclamp))

// ---------------------------------------------------------------------------
// 拖动与拉伸

/**
 * 一次指针拖动。`onMove` 拿到的是**相对起点的位移**,不是绝对坐标 —— 起点由
 * 调用方自己快照,中途状态被外部改掉(窗口 resize 触发 reclamp)也不会让拖动
 * 突然跳一下。
 */
function trackDrag(event: MouseEvent, onMove: (dx: number, dy: number) => void): void {
  const startX = event.clientX
  const startY = event.clientY
  const move = (moveEvent: MouseEvent) => onMove(moveEvent.clientX - startX, moveEvent.clientY - startY)
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function startPadDrag(event: MouseEvent): void {
  if (event.button !== 0) return
  const start = { ...state.value.rect }
  const viewport = viewportSize()
  trackDrag(event, (dx, dy) => {
    state.value = {
      ...state.value,
      rect: clampRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport),
    }
  })
}

function startResize(dir: ResizeDirection, event: MouseEvent): void {
  if (event.button !== 0) return
  const start = { ...state.value.rect }
  const viewport = viewportSize()
  trackDrag(event, (dx, dy) => {
    state.value = { ...state.value, rect: resizeRect(start, dir, dx, dy, viewport) }
  })
}

/**
 * 小圆钮的拖动与"点击展开"共用一次按下:超过 4px 才算拖,否则松手就是点击。
 * 没有这个阈值,想点开它的人有一半概率只是把它挪了两像素。
 */
function startBubbleDrag(event: MouseEvent): void {
  if (event.button !== 0) return
  const start = { ...state.value.bubble }
  const viewport = viewportSize()
  let moved = false
  trackDrag(event, (dx, dy) => {
    if (!moved && Math.hypot(dx, dy) < 4) return
    moved = true
    state.value = {
      ...state.value,
      bubble: clampBubble({ x: start.x + dx, y: start.y + dy }, viewport),
    }
  })
}

// ---------------------------------------------------------------------------
// 收起 / 展开 / 焦点

function collapse(): void {
  state.value = { ...state.value, collapsed: true }
  emit('returnFocus')
}

function expand(): void {
  state.value = { ...state.value, collapsed: false }
  void nextTick(() => editorRef.value?.focus())
}

/** 垫子刚出现 / 刚展开:焦点落到纸上,而不是掉在地上。 */
watch(() => [pad.isOpen.value, collapsed.value] as const, ([open, isCollapsed]) => {
  if (!open || isCollapsed) return
  void nextTick(() => editorRef.value?.focus())
})

defineExpose({
  focus: () => {
    if (collapsed.value) expand()
    else editorRef.value?.focus()
  },
})

// ---------------------------------------------------------------------------
// 内容与发送

function handleUpdate(next: string): void {
  pad.setContent(next)
}

/** 选区优先,否则水位之后的内容。发出去的内容**不从纸上删除**。 */
function pendingSendText(): string {
  const selected = editorRef.value?.getSelectedText?.() ?? ''
  if (selected.trim()) return selected
  return pad.pendingText()
}

function requestSend(): void {
  const text = pendingSendText()
  if (!text.trim()) return
  emit('send', text)
}

/**
 * Escape 在根上统一接,但**先看有没有人吃过**:斜杠菜单开着时编辑器已经把这一下
 * `preventDefault` 掉了(菜单关自己),这时再收垫子就是一下按键办两件事。
 */
function handleEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  collapse()
}

function handleEditorKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  // 纸上 Enter 永远是换行 —— 只有 ⌘⏎ / Ctrl+⏎ 才是"正式发出"。
  // IME 组字中的回车属于候选框,不属于我们。
  if (event.key !== 'Enter' || event.isComposing) return
  if (!(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  requestSend()
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  await handleMarkdownAttachmentPaste({
    event,
    editor: editorRef.value,
    documentPath: filePath.value,
    workspaceRoot: documentDir.value,
  })
}

async function resolveMarkdownAsset(
  href: string,
  asset?: MarkdownAssetResolution | null,
): Promise<MarkdownAssetResolution | null> {
  if (asset) return asset
  if (!filePath.value) return null
  const response = await markdownApi.resolveAsset({
    documentPath: filePath.value,
    workspaceRoot: documentDir.value,
    rawTarget: href,
  })
  return response.success ? response.asset || null : null
}

async function openMarkdownLink(payload: { href: string, asset?: MarkdownAssetResolution | null }): Promise<void> {
  const asset = await resolveMarkdownAsset(payload.href, payload.asset)
  if (asset?.kind === 'external') {
    await platformApi.openExternal(asset.href || payload.href)
    return
  }
  if (asset?.absolutePath) {
    await platformApi.openPath(asset.absolutePath)
    return
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(payload.href)) {
    await platformApi.openExternal(payload.href)
  }
}

async function openMarkdownImage(payload: { src: string, alt: string, asset?: MarkdownAssetResolution | null }): Promise<void> {
  await platformApi.openImagePreview(payload.asset?.dataUrl || payload.src, payload.alt)
}
</script>

<style scoped>
/* 垫子与小圆钮都是 `position: fixed`:它们的坐标是**视口**坐标,与聊天面板的
   布局、滚动、宽度动画一概无关 —— 那正是"拖到哪就停在哪"的前提。 */
.scratchpad-pad,
.scratchpad-bubble {
  position: fixed;
  z-index: var(--z-sidebar);
}

.scratchpad-pad {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--ui-border-default-border);
  border-radius: var(--radius-md);
  background: var(--ui-surface-floating-bg);
  box-shadow: var(--shadow-floating);
  overflow: hidden;
}

.pad-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px 5px 12px;
  border-bottom: 1px solid var(--ui-border-subtle-border);
  font-size: 11px;
  color: var(--ui-text-faint-fg);
  cursor: grab;
  user-select: none;
}

.pad-header:active {
  cursor: grabbing;
}

.pad-title {
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ui-text-muted-fg);
}

.pad-sync {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.pad-sync-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: currentcolor;
}

.pad-sync.is-synced {
  color: var(--ui-text-faint-fg);
}

.pad-sync.is-pending {
  color: var(--ui-status-warning-fg);
}

.pad-watermark {
  color: var(--ui-accent-subtle-fg);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.pad-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.pad-icon-btn {
  flex: 0 0 auto;
}

.pad-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* 编辑器本体是 ProseMirror 自己的 DOM,scoped 够不着 —— 这里只把外框的边与底
   收掉,涂装仍由编辑器的 surface 持有。 */
.pad-body :deep(.tiptap-note-editor) {
  height: 100%;
  background: transparent;
  border: 0;
}

.pad-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px 5px;
  border-top: 1px solid var(--ui-border-subtle-border);
  font-size: 10px;
  color: var(--ui-text-faint-fg);
}

.pad-count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

/* --------------------------------------------------------------- 拉伸把手 */

.pad-resize {
  position: absolute;
  /* 局部堆叠:压在内容之上,但这一层没有跨出垫子的野心(个位数,不进层级表)。 */
  z-index: 2;
}

.pad-resize.is-n,
.pad-resize.is-s {
  left: 8px;
  right: 8px;
  height: 6px;
  cursor: ns-resize;
}

.pad-resize.is-e,
.pad-resize.is-w {
  top: 8px;
  bottom: 8px;
  width: 6px;
  cursor: ew-resize;
}

.pad-resize.is-n { top: -2px; }
.pad-resize.is-s { bottom: -2px; }
.pad-resize.is-w { left: -2px; }
.pad-resize.is-e { right: -2px; }

.pad-resize.is-ne,
.pad-resize.is-nw,
.pad-resize.is-se,
.pad-resize.is-sw {
  width: 12px;
  height: 12px;
}

.pad-resize.is-nw { top: -2px; left: -2px; cursor: nwse-resize; }
.pad-resize.is-se { bottom: -2px; right: -2px; cursor: nwse-resize; }
.pad-resize.is-ne { top: -2px; right: -2px; cursor: nesw-resize; }
.pad-resize.is-sw { bottom: -2px; left: -2px; cursor: nesw-resize; }

/* --------------------------------------------------------------- 小圆钮 */

.scratchpad-bubble {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--ui-border-default-border);
  border-radius: var(--radius-full);
  background: var(--ui-surface-floating-bg);
  color: var(--ui-text-muted-fg);
  box-shadow: var(--shadow-floating);
  cursor: grab;
  transition:
    color var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default);
}

.scratchpad-bubble:hover {
  color: var(--ui-accent-primary-fg);
  border-color: var(--ui-accent-primary-fg);
}

.scratchpad-bubble:active {
  cursor: grabbing;
}
</style>
