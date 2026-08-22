<template>
  <div
    ref="rootRef"
    :class="[
      'session-item',
      {
        active: isActive,
        generating: isGenerating,
        pinned: session.isPinned,
        editing: isEditing,
        branch: session.depth > 0,
        hidden: session.isHidden,
        collapsed: session.isCollapsed
      }
    ]"
    @click="handleClick"
    @contextmenu.prevent="$emit('context-menu', $event)"
    @mouseenter="loadPreview"
  >
    <!-- 树线缩进区域：参与 flex 布局，宽度 = depth * 16px -->
    <div
      v-if="session.depth > 0"
      class="tree-indent"
      :style="{ width: `${session.depth * 16}px` }"
    >
      <div class="tree-lines">
        <!-- 祖先层级的垂直线 -->
        <span
          v-for="(isAncestorLast, idx) in session.ancestorsLastChild"
          :key="idx"
          :class="['tree-line-segment', { continue: !isAncestorLast }]"
        />
        <!-- 当前节点的连接线 -->
        <span :class="['tree-line-segment', 'connector', { 'last-child': session.isLastChild }]" />
      </div>
    </div>

    <!-- Session name (flex: 1) -->
    <input
      v-if="isEditing"
      ref="inputRef"
      v-model="localEditingName"
      class="session-name-input"
      maxlength="120"
      @click.stop
      @dblclick.stop
      @keydown.stop="handleRenameKeydown"
      @blur="confirmRename"
    >
    <span
      v-else
      class="session-name"
      @dblclick.stop="startRename"
    >{{ session.name || 'New chat' }}</span>

    <!-- Anchored to the whole row rather than wrapping it: .session-item pulls
         itself flush with a negative margin and must stay a direct child. -->
    <Tooltip
      :trigger-el="rootRef"
      :disabled="isEditing"
      position="right"
      :delay="600"
      interactive
    >
      <template #content>
        <SessionPreviewCard
          :session-name="session.name"
          :segments="previewSegments"
          :loading="previewLoading"
          :fallback-text="session.previewText"
        />
      </template>
    </Tooltip>

    <!-- Branch Badge：圆形数字，点击展开/收起 -->
    <Button
      v-if="session.hasBranches"
      text
      size="small"
      class="branch-badge"
      :aria-label="session.isCollapsed ? `展开 ${session.branchCount} 个分支` : `收起 ${session.branchCount} 个分支`"
      @click.stop="$emit('toggle-collapse')"
    >
      {{ session.branchCount }}
    </Button>

    <!-- 右侧状态区域：generating dot，hover 时隐藏让位给 ⋯ -->
    <div class="status-area">
      <!-- Generating dot - 始终存在，用 class 控制显隐 -->
      <div :class="['generating-dot', { active: isGenerating }]" />
    </div>

    <!-- Hover action: progressive disclosure menu -->
    <Button
      text
      circle
      class="more-btn"
      aria-label="More"
      :icon="MoreHorizontal"
      @click.stop="$emit('context-menu', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import { ref, watch, nextTick } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'
import Tooltip from '@/components/common/Tooltip.vue'
import SessionPreviewCard from './SessionPreviewCard.vue'
import { sessionsApi } from '@/platform/sessions-client'
import type { SessionSegment } from '@/types'
import type { SessionWithBranches } from './useSessionOrganizer'

interface Props {
  session: SessionWithBranches
  isActive: boolean
  isGenerating: boolean
  isEditing: boolean
  editingName: string
}

interface Emits {
  (e: 'click', event: MouseEvent): void
  (e: 'context-menu', event: MouseEvent): void
  (e: 'toggle-collapse'): void
  (e: 'start-rename'): void
  (e: 'confirm-rename', name: string): void
  (e: 'cancel-rename'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const localEditingName = ref('')

// Sync local editing name with prop
watch(() => props.editingName, (newName) => {
  localEditingName.value = newName
}, { immediate: true })

// Focus input when editing starts
watch(() => props.isEditing, (isEditing) => {
  if (isEditing) {
    nextTick(() => {
      inputRef.value?.focus()
      inputRef.value?.select()
    })
  }
})

// Fetched on first hover rather than with the list: a sidebar of 200 sessions
// would otherwise read 200 segment files to render rows nobody looked at.
const previewSegments = ref<SessionSegment[]>([])
const previewLoading = ref(false)
let previewLoadedFor: string | null = null
let previewLoadedAt = 0

/**
 * Segments are written well after the turn ends (the outline waits for the
 * session to go quiet), so an early hover legitimately sees nothing. Caching
 * that answer forever meant the preview stayed empty no matter how long you
 * waited — short-lived caching keeps repeat hovers cheap without pinning a
 * result that was simply too early.
 */
const PREVIEW_TTL_MS = 5000

async function loadPreview() {
  const sessionId = props.session.id
  if (previewLoading.value) return
  const cachedFresh =
    previewLoadedFor === sessionId && Date.now() - previewLoadedAt < PREVIEW_TTL_MS
  if (cachedFresh) return
  previewLoading.value = true
  try {
    const response = await sessionsApi.getSegments({ sessionId })
    // Guard against the pointer having moved on during the await.
    if (props.session.id !== sessionId) return
    previewSegments.value = response.success ? response.segments : []
    previewLoadedFor = sessionId
    previewLoadedAt = Date.now()
  } catch {
    previewSegments.value = []
  } finally {
    previewLoading.value = false
  }
}

function handleClick(event: MouseEvent) {
  if (props.isEditing) return
  emit('click', event)
}

function startRename() {
  emit('start-rename')
}

function handleRenameKeydown(event: KeyboardEvent) {
  // 中文输入法用 Enter 选词时 isComposing 为 true，此时不能当成「确认重命名」
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    confirmRename()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
  }
}

function confirmRename() {
  emit('confirm-rename', localEditingName.value)
}

function cancelRename() {
  emit('cancel-rename')
}
</script>

<style scoped>
/* Session Item - 抽屉风（v7）：圆角行，hover/active 用主题软填充。
   行包装盒(.app-menu-item)带 12px 内联起点，margin 拉回后填充满宽，
   正文缩进 32px 与抽屉头标签(chevron 12 + gap 8)对齐。 */
.session-item {
  /* 选中底只定义一次 —— 下面「被指着的选中行」那一档要贴着静息态写,
     两处各写一份数值早晚漂移(ui-system.md §1)。 */
  --session-row-active-fill: var(--sidebar-row-active-fill, var(--ui-state-selected-bg));

  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 6px 10px 6px 32px;
  /* 行间 2px 呼吸缝(ui-system.md §1「列表行的两种状态不能是同一种记号」):
     hover 与 active 都是满底色块,紧邻时各自的圆角被邻居的直边填平,两行焊成
     一整条通板(真机报告:aikefu-bridge 组下的 active + hover 两行)。
     只画 block-end 一侧:
      - 行与行之间照样是 2px(A 的下边距紧邻 B 的 0 上边距);
      - 组内第一行不带上边距 —— 分组头是 sticky 且底不透明,它下面留一条透明
        缝就是滚过的行文透出来的通道(同一份文件里 `margin-right: 0` 那条注释
        记的就是这个坑);
      - 组尾多出的 2px 由 SessionList 的列表 padding-bottom 反向补回(12→10),
        外缘几何逐像素不变。
     折叠行把这条缝归零(见 `.hidden`),否则一枝收起的分支会留下一串 2px 空条。 */
  margin: 0 0 2px -12px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  max-height: 44px;
  transition:
    min-height var(--duration-normal) var(--ease-default),
    max-height var(--duration-normal) var(--ease-default),
    padding var(--duration-normal) var(--ease-default),
    margin var(--duration-normal) var(--ease-default),
    opacity var(--duration-normal) var(--ease-default),
    background-color var(--duration-fast) var(--ease-default);
}

.session-item:hover {
  background: var(--sidebar-row-hover-fill, var(--ui-state-hover-bg));
}

.session-item.active {
  background: var(--session-row-active-fill);
}

/* 手指着一行已经选中的会话。
 *
 * 不写这条就是死区:`.session-item.active` (0,2,0) 写在 `.session-item:hover`
 * (0,2,0) 之后,选中底把 hover 整个吞掉,指针落上去什么都不动 —— 选中不等于
 * 这一行不再响应指针(ui-system.md §1)。
 *
 * 这里是面 register(圆角底色块),仅剩的通道是把选中底**加深一档**。掺的是
 * `--ui-text-primary-fg`:它在浅色主题是深的、深色主题是浅的,所以"更深一档"
 * 两边都成立,不用写死 alpha 或 hex;单纯抬 accent 的 alpha 在深色主题里几乎
 * 不动。同一条规则同时服务 `:hover` 与 `:focus-visible` —— 键盘与鼠标是同一
 * 条视觉通道。(0,3,0) 直接压过 `.active` 的 (0,2,0),不留平局。 */
.session-item.active:hover,
.session-item.active:focus-visible {
  background: color-mix(in srgb, var(--session-row-active-fill) 92%, var(--ui-text-primary-fg));
}

.session-item.hidden {
  /* min-height 在 CSS 盒模型里排在 max-height 之后生效，不归零的话
     基础规则的 min-height: 30px 会把折叠行撑回 30px 空白条 */
  min-height: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin: 0 0 0 -12px;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}

/* 树线缩进区域：参与 flex 布局 */
.tree-indent {
  position: relative;
  flex-shrink: 0;
  align-self: stretch;
}

/* 树状连接线 */
.tree-lines {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  display: flex;
  pointer-events: none;
}

/* 每层的连接线单元 (16px 宽) */
.tree-line-segment {
  width: 16px;
  height: 100%;
  position: relative;
}

/* 垂直延续线 (非最后子节点的祖先) —— 点线支流，呼应主账目线 */
.tree-line-segment.continue::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  border-left: 1px dotted var(--ui-border-strong-border);
  opacity: 0.55;
}

/* L 形连接线 (当前节点) */
.tree-line-segment.connector::after {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  height: 50%;
  width: 9px;
  border-left: 1px dotted var(--ui-border-strong-border);
  border-bottom: 1px solid var(--ui-border-strong-border);
  opacity: 0.55;
  transition: border-color var(--duration-fast) var(--ease-default), opacity var(--duration-fast) var(--ease-default);
}

/* 非最后子节点：T 形（延续垂直线） */
.tree-line-segment.connector:not(.last-child)::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  border-left: 1px dotted var(--ui-border-strong-border);
  opacity: 0.55;
}

/* 右侧状态区域 - 只剩 generating dot，按内容收宽把余量还给标题 */
.status-area {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  justify-content: flex-end;
  transition: opacity var(--duration-fast) var(--ease-default);
}

/* Generating indicator - 实心小圆点（v7），呼吸而非闪烁 */
.generating-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-accent-primary-fg);
  flex-shrink: 0;
  opacity: 0;
  transform: scale(0.8);
  transition: opacity var(--duration-normal) var(--ease-default), transform var(--duration-normal) var(--ease-default);
}

.generating-dot.active {
  opacity: 1;
  transform: scale(1);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .generating-dot.active { animation: none; }
}

/* Branch Badge：描边圆环数字，零填充 */
.branch-badge {
  --app-button-height: 18px;
  --app-button-min-width: 18px;
  --app-button-padding-x: 5px;
  --app-button-gap: 0;
  --app-button-font-size: var(--sidebar-type-caption);
  --app-button-hover-fill: transparent;
  --app-button-hover-fg: var(--ui-accent-primary-fg);
  --app-button-shadow: none;
  --app-button-hover-shadow: none;

  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: transparent;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
  font-size: var(--sidebar-type-caption);
  font-weight: var(--font-weight-medium);
  line-height: var(--type-caption-line-height);
  border: 1px solid var(--ui-border-default-border);
  cursor: pointer;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default);
}

.branch-badge:hover {
  background: transparent;
  border-color: var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
}

/* 已收起时的 badge 样式：虚线描边提示"折叠中" */
.session-item.collapsed .branch-badge {
  background: transparent;
  border-style: dashed;
  color: var(--ui-sidebar-item-muted-fg, var(--ui-text-muted-fg));
}

.session-item.collapsed .branch-badge:hover {
  background: transparent;
  border-color: var(--ui-accent-primary-fg);
  color: var(--ui-accent-primary-fg);
}


.session-item:hover .status-area {
  opacity: 0;
}

/* The Tooltip is driven by :trigger-el and hides its own wrapper. Do not give
   that wrapper a flex slot here — it is empty, and a `flex: 1` on it would
   split the row with .session-name and halve the visible title. */

/* Session name */
.session-name {
  flex: 1;
  min-width: 0;
  /* 会话名 = 列表行的主标题，引 sidebar 字号阶梯的 title 档（14px，
     与聊天区正文同号）。原来写死 13px —— 注释里那句「--type-size-500 是
     14px，比设计稿大一号」正是当年主动比刻度小 1px 的记录，代价是左栏整体
     偏小。 */
  font-size: var(--sidebar-type-title);
  font-weight: var(--type-body-weight);
  line-height: var(--type-chat-compact-line-height-px);
  letter-spacing: 0;
  /* 72% 墨：比全墨的分组头轻一档（色阶来自 SessionList 的 --sidebar-row-* 派生链） */
  color: var(--sidebar-row-fg, var(--ui-sidebar-item-fg, var(--ui-text-secondary-fg)));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--duration-normal) var(--ease-default);
}

.session-item:hover .session-name {
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg, var(--ui-sidebar-item-hover-fg)));
}

.session-item.active .session-name {
  font-weight: var(--type-label-weight);
  color: var(--sidebar-row-ink, var(--ui-text-primary-fg));
}

.session-name-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  /* 与 .session-name 同档 —— 差一档的话改名时字号会跳一下。 */
  font-size: var(--sidebar-type-title);
  font-weight: var(--type-body-weight);
  line-height: var(--type-chat-compact-line-height-px);
  color: var(--ui-sidebar-item-active-fg, var(--ui-text-primary-fg));
  outline: none;
}

/* Hover action: progressive disclosure (⋯ → context menu) */
.more-btn {
  --app-button-height: 23px;
  --app-button-min-width: 23px;
  --app-button-padding-x: 0;
  --app-button-hover-fill: transparent;
  --app-button-hover-fg: var(--ui-sidebar-action-hover-fg, var(--ui-text-primary-fg));
  --app-button-shadow: none;
  --app-button-hover-shadow: none;

  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  width: 23px;
  height: 23px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(
    --ui-sidebar-action-fg,
    color-mix(in srgb, var(--ui-sidebar-item-fg, var(--ui-text-secondary-fg, var(--ui-sidebar-item-fg))) 88%, transparent)
  );
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-default), background var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default);
}

.session-item:hover .more-btn {
  opacity: 0.9;
  pointer-events: auto;
}

.more-btn:hover {
  background: transparent;
  color: var(--ui-sidebar-action-hover-fg, var(--ui-text-primary-fg));
}
</style>
