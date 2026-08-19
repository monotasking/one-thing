<template>
  <Popover
    :open="visible && !!anchor"
    :anchor="anchor ?? undefined"
    placement="top"
    :offset="8"
    :z-layer="Z_LAYER"
    :close-on="CLOSE_ON"
    surface="menu"
    class="selection-toolbar-surface"
    transition="none"
    @update:open="onOpenChange"
  >
    <div class="selection-toolbar">
      <Button
        unstyled
        class="toolbar-btn"
        @click="handleCopy"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect
            x="9"
            y="9"
            width="13"
            height="13"
            rx="2"
            ry="2"
          />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{{ copied ? 'Copied!' : 'Copy' }}</span>
      </Button>
      <div class="toolbar-divider" />
      <Button
        unstyled
        class="toolbar-btn"
        @click="handleQuote"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
          <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
        </svg>
        <span>Quote</span>
      </Button>
      <template v-if="canBranch">
        <div class="toolbar-divider" />
        <Button
          unstyled
          class="toolbar-btn"
          @click="handleBranch"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line
              x1="6"
              y1="3"
              x2="6"
              y2="15"
            />
            <circle
              cx="18"
              cy="6"
              r="3"
            />
            <circle
              cx="6"
              cy="18"
              r="3"
            />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span>Branch</span>
        </Button>
      </template>
    </div>
  </Popover>
</template>

<script setup lang="ts">
/**
 * SelectionToolbar — the bar that appears over a text selection.
 *
 * P6 收口:Teleport 与坐标计算全部交给 `Popover`/`useFloatingLayer`。它的锚点
 * 语义比别的浮层特殊 —— 不是某个元素,而是**选区自己的矩形**,所以走内核的
 * 虚拟锚点(带 width/height 的那种,见 `VirtualAnchor` 注释):`placement="top"`
 * 让工具条压在选区正上方居中,上方不够时 flip 到选区下沿(零高度的点锚点做不到
 * 这一点,会把工具条摔回选区身上),越界由内核 clamp。
 *
 * 保留的自管逻辑,以及为什么:
 *  - 选区**内容**变化(`selectionchange`)由 MessageList 关闭工具条。那是语义,
 *    不是定位:选区没了,工具条就没有对象可操作了,内核无从判断。
 *  - `closeOn.scroll` 关着。选区跟着文档一起滚,内核的 autoUpdate 会把工具条
 *    一起带走,这正是想要的"跟随";滚一下就消失反而割裂。锚点矩形本身在滚动后
 *    会过期一帧(它是 emit 时刻的快照),但选区消失/改变必然重新 emit,
 *    所以这一帧的漂移不会沉淀下来。
 */
import Button from '@/components/common/Button.vue'
import Popover from '@/components/common/Popover.vue'
import { ref } from 'vue'
import { copyTextToClipboard } from '@/utils/clipboard'
import type { AnchorRect } from '@/composables/floating/compute-position'
import type { FloatingCloseOn, FloatingZLayer } from '@/composables/floating/useFloatingLayer'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.selection-toolbar')

interface Props {
  visible: boolean
  /** The selection's own box, in viewport coordinates. */
  anchor: AnchorRect | null
  selectedText: string
  /** Branching only exists on root sessions; the list decides. */
  canBranch?: boolean
}

const props = withDefaults(defineProps<Props>(), { canBranch: true })

const emit = defineEmits<{
  copy: []
  quote: [text: string]
  branch: [text: string]
  close: []
}>()

/** 划词工具条压一切(docs/design/ui-system.md §3 的 max 档),原样保留 —— 只是
 *  从 CSS 里的 `z-index: var(--z-max)` 换成内核层级语义。 */
const Z_LAYER: FloatingZLayer = 'max'
/** 见组件头注释:scroll 关着是有意的。 */
const CLOSE_ON: FloatingCloseOn = { esc: true, outside: true }

const copied = ref(false)

function onOpenChange(open: boolean) {
  if (!open) emit('close')
}

async function handleCopy() {
  const success = await copyTextToClipboard(props.selectedText)
  if (!success) {
    log.warn('selection copy failed')
    return
  }

  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}

function handleQuote() {
  emit('quote', props.selectedText)
  emit('close')
  window.getSelection()?.removeAllRanges()
}

function handleBranch() {
  emit('branch', props.selectedText)
  emit('close')
  window.getSelection()?.removeAllRanges()
}
</script>

<style scoped>
/* 坐标与层级由内核以内联样式给到 Popover 根上;面走 `menu` 档(波 4:面归位)。
   删掉的那张自绘面里有两条是真错:一是 `html[data-theme='light']` 那整块 ——
   本仓的主题不靠这个属性区分明暗(明暗由 `--ui-*` 的取值决定),那块硬编码白
   在多数主题下**根本不触发**,触发时又是一张不跟主题的白纸;二是两条分隔线的
   `rgba(255,255,255,.1)` / `rgba(0,0,0,.1)`,同理。
   波 3 记的 `.toolbar-btn:hover`(Δ中位 21.1,当时因为"面还没归位"没迁)在这一刀
   之后一并落回统一态 token 的重档。 */
.selection-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  animation: toolbarSlideIn 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--ui-border-subtle-border);
  margin: 0 2px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--ui-text-primary-fg);
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  white-space: nowrap;
}

.toolbar-btn:hover {
  background: var(--ui-state-hover-accent-strong-bg);
  color: var(--ui-accent-primary-fg);
  transform: translateY(-1px);
}

.toolbar-btn:active {
  transform: translateY(0) scale(0.98);
}

.toolbar-btn svg {
  flex-shrink: 0;
  transition: transform var(--duration-normal) var(--ease-default);
}

.toolbar-btn:hover svg {
  transform: scale(1.1);
}

@keyframes toolbarSlideIn {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>

<!-- Popover 的根是 Teleport,拿不到本组件的 scoped 作用域(ui-system.md §1),
     所以实例级的几何覆写只能落在全局块里。 -->
<style>
/* 工具条比菜单窄一圈:4px 内边距是形,不是皮肤。 */
.selection-toolbar-surface {
  --app-popover-padding: 4px;
}
</style>
