<template>
  <section
    ref="panelRef"
    class="todo-plan-panel todo-paper"
    :class="{
      pinned,
      collapsed,
      standalone: isStandalone,
      'window-inactive': isStandalone && !windowFocused,
      'popover-open': popoverOpen,
      'find-open': findOpen,
      'switcher-open': switcherOpen,
      'action-panel-open': actionPanelOpen,
      'format-buffer-open': formatBufferOpen,
    }"
    :style="panelStyle"
    @mouseenter="handlePanelMouseEnter"
    @mouseleave="handlePanelMouseLeave"
    @keydown="handleShortcut"
    @pointerdown="handleRootWindowDragStart"
    @pointermove="handleWindowDragMove"
    @pointerup="handleWindowDragEnd"
    @pointercancel="handleWindowDragEnd"
    @dblclick="handleRootWindowDragDoubleClick"
  >
    <Button
      v-if="collapsed"
      text
      class="wake-button"
      native-type="button"
      aria-label="Show Todo / Notes"
      @mousedown.prevent
      @click.stop="collapsed = false"
    >
      <FileText :size="15" />
    </Button>

    <template v-else>
      <!-- 形态轨。这扇窗是**唯一的浮面**:Todo/笔记与草稿纸是同一张纸的两种
           内容,不是两个浮层 —— 所以形态开关是一条常驻的轨,不是标题栏里的
           一枚丸。轨自己是窗的底面,主区是"垫在上面"的那张纸。 -->
      <nav
        class="mode-rail"
        aria-label="Todo window mode"
        @pointerdown="handleWindowDragStart"
        @pointermove="handleWindowDragMove"
        @pointerup="handleWindowDragEnd"
        @pointercancel="handleWindowDragEnd"
        @dblclick="handleWindowDragDoubleClick"
      >
        <!-- 竖排三点。**不是装饰**:这扇窗是 non-activating NSPanel,永远成不了
             main window,系统交通灯因此恒定是灰的 —— 所以主进程把系统按钮收了
             (`setWindowButtonVisibility(false)`),这三枚才是真控件。
             和上面的形态钮同一个理由:逐个写出来,不走 v-for(Tooltip 里有
             `Teleport to="body"`,进了 v-for 会在重排时拿错实例)。 -->
        <div
          v-if="isStandalone"
          class="window-lights"
        >
          <Tooltip
            text="关闭"
            position="right"
          >
            <button
              class="window-light close"
              type="button"
              aria-label="关闭"
              @pointerdown.stop
              @click.stop="closeStandaloneWindow"
            />
          </Tooltip>
          <Tooltip
            text="最小化"
            position="right"
          >
            <button
              class="window-light minimize"
              type="button"
              aria-label="最小化"
              @pointerdown.stop
              @click.stop="minimizeStandaloneWindow"
            />
          </Tooltip>
          <Tooltip
            text="缩放"
            position="right"
          >
            <button
              class="window-light zoom"
              type="button"
              aria-label="缩放"
              @pointerdown.stop
              @click.stop="zoomStandaloneWindow"
            />
          </Tooltip>
        </div>

        <!-- 两枚钮**逐个写出来**,不走 v-for。`Tooltip` 里有 `Teleport to="body"`,
             而 teleport 放进 v-for 之后 Vue 会在重排时拿错实例(实测:切形态时
             patch 到 null 容器,报 emitsOptions / insertBefore of null)。
             这一族本来就恰好两枚,穷举比省两行划算。 -->
        <div class="rail-buttons">
          <Tooltip
            text="待做 / 笔记"
            position="right"
          >
            <Button
              text
              class="rail-button rail-todo"
              :class="{ active: isTodoMode }"
              native-type="button"
              aria-label="待做 / 笔记"
              :aria-pressed="isTodoMode ? 'true' : 'false'"
              @mousedown.prevent
              @click.stop="selectMode('todo')"
            >
              <SquareCheckBig
                :size="17"
                :stroke-width="1.9"
              />
            </Button>
          </Tooltip>
          <Tooltip
            text="草稿纸"
            position="right"
          >
            <Button
              text
              class="rail-button rail-scratch"
              :class="{ active: isScratchpadMode }"
              native-type="button"
              aria-label="草稿纸"
              :aria-pressed="isScratchpadMode ? 'true' : 'false'"
              @mousedown.prevent
              @click.stop="selectMode('scratchpad')"
            >
              <NotebookPen
                :size="17"
                :stroke-width="1.9"
              />
            </Button>
          </Tooltip>
        </div>

        <span
          class="rail-label"
          aria-hidden="true"
        >{{ railLabel }}</span>
      </nav>

      <div class="panel-main">
        <div class="panel-column">
          <header
            class="panel-header"
            @pointerdown="handleWindowDragStart"
            @pointermove="handleWindowDragMove"
            @pointerup="handleWindowDragEnd"
            @pointercancel="handleWindowDragEnd"
            @dblclick="handleWindowDragDoubleClick"
          >
            <!-- 头行标题是**形态名**(设计稿如此),不是笔记名 —— 笔记自己的
                 标题就是文档第一行的 H1,头行再念一遍是重复;换笔记走 ⌘P。 -->
            <h1 class="window-title">
              {{ headerTitle }}
            </h1>

            <!-- 这张纸属于哪个会话。纸和 AI todo 都是按会话分的,窗又跟着主窗的
                 当前会话走 —— 不写出来,用户无从核对"我在往哪个会话的纸上写"。 -->
            <span
              v-if="sessionTitle"
              class="header-session"
            >{{ sessionTitle }}</span>

            <span class="header-stat">{{ headerStatLabel }}</span>

            <div class="panel-actions">
              <Tooltip
                v-if="isScratchpadMode && !showInfoPanel"
                text="把水位之后的内容(或选中的一段)正式发出 ⌘⏎"
              >
                <Button
                  text
                  class="icon-button"
                  native-type="button"
                  :disabled="!canSendScratchpad"
                  aria-label="Send scratchpad content"
                  @mousedown.prevent
                  @click.stop="sendScratchpadPending"
                >
                  <CornerDownLeft :size="14" />
                </Button>
              </Tooltip>
              <!-- 设计稿的头行只有「标题 + 读数」:那排图标钮收敛成一枚 ⋯,
                   切换笔记 / 新建 / 查找 / 格式条 / 钉住全部住进命令面板
                   (⌘K 同一入口)。`titleButtonRef` 留在这枚钮上 —— 笔记
                   切换器的"点外面关掉"靠它认得触发源。 -->
              <Tooltip
                v-if="isTodoMode"
                text="更多操作 ⌘K"
              >
                <Button
                  ref="titleButtonRef"
                  text
                  class="icon-button"
                  native-type="button"
                  aria-label="更多操作"
                  @mousedown.prevent
                  @click.stop="openActionPanel"
                >
                  <MoreHorizontal :size="15" />
                </Button>
              </Tooltip>
            </div>
          </header>

          <TodoNotesActionPanel
            :visible="actionPanelOpen"
            :query="actionQuery"
            :actions="todoActions"
            @update:query="actionQuery = $event"
            @select="runAction"
            @close="closeActionPanel"
          />

          <div
            v-if="switcherOpen"
            ref="switcherRef"
            class="note-switcher todo-popover todo-popover-notes"
          >
            <label class="switcher-search todo-popover-search">
              <Search :size="15" />
              <input
                ref="switcherInputRef"
                v-model="switcherQuery"
                placeholder="Search for notes..."
                spellcheck="false"
                @keydown="handleSwitcherKeydown"
              >
            </label>

            <div class="switcher-list todo-popover-list">
              <div class="switcher-header-row">
                <strong>Notes</strong>
                <span>
                  {{ noteCountLabel }}
                  <Info :size="16" />
                </span>
              </div>
              <div
                v-for="doc in filteredUserNotes"
                :key="doc.id"
                :class="['note-option', { active: activeId === doc.id, selected: switcherSelectedDocument?.id === doc.id }]"
                :data-note-id="doc.id"
                @mouseenter="selectSwitcherDocument(doc.id)"
              >
                <Button
                  text
                  class="note-option-main"
                  native-type="button"
                  @mousedown.prevent
                  @click.stop="selectDocument(doc.id)"
                >
                  <strong>{{ doc.title }}</strong>
                  <small>
                    <i :class="{ current: activeId === doc.id }" />
                    {{ activeId === doc.id ? 'Current' : 'Note' }}
                    <b>•</b>
                    {{ doc.content.length }} Characters
                  </small>
                </Button>
                <div class="note-option-actions">
                  <Button
                    text
                    :class="{ active: isNotePinned(doc.id) }"
                    native-type="button"
                    :aria-label="isNotePinned(doc.id) ? 'Unpin note' : 'Pin note'"
                    @mousedown.prevent
                    @click.stop="toggleNotePinned(doc.id)"
                  >
                    <Pin :size="16" />
                  </Button>
                  <Button
                    text
                    native-type="button"
                    aria-label="Delete note"
                    @mousedown.prevent
                    @click.stop="deleteUserNote(doc.id)"
                  >
                    <Trash2 :size="16" />
                  </Button>
                </div>
              </div>

              <div
                v-if="filteredSystemNotes.length"
                class="switcher-label"
              >
                System
              </div>
              <div
                v-for="doc in filteredSystemNotes"
                :key="doc.id"
                :class="['note-option', 'system', { active: activeId === doc.id, selected: switcherSelectedDocument?.id === doc.id }]"
                :data-note-id="doc.id"
                @mouseenter="selectSwitcherDocument(doc.id)"
              >
                <Button
                  text
                  class="note-option-main"
                  native-type="button"
                  @mousedown.prevent
                  @click.stop="selectDocument(doc.id)"
                >
                  <strong>AI Todo</strong>
                  <small>
                    <i :class="{ current: activeId === doc.id }" />
                    {{ activeId === doc.id ? 'Current' : 'System' }}
                    <b>•</b>
                    {{ doc.content.length }} Characters
                  </small>
                </Button>
                <div class="note-option-actions">
                  <Bot :size="16" />
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="findOpen"
            ref="findBarRef"
            class="floating-find-bar"
          >
            <Search :size="15" />
            <input
              ref="findInputRef"
              v-model="findQuery"
              placeholder="Find"
              spellcheck="false"
              @keydown="handleFindKeydown"
            >
            <span>{{ findStatus }}</span>
            <Button
              text
              class="mini-button"
              native-type="button"
              aria-label="Previous match"
              @mousedown.prevent
              @click.stop="moveFind(-1)"
            >
              <ChevronUp :size="14" />
            </Button>
            <Button
              text
              class="mini-button"
              native-type="button"
              aria-label="Next match"
              @mousedown.prevent
              @click.stop="moveFind(1)"
            >
              <ChevronDown :size="14" />
            </Button>
            <Button
              text
              class="mini-button"
              native-type="button"
              aria-label="Close find"
              @mousedown.prevent
              @click.stop="closeFind"
            >
              <X :size="14" />
            </Button>
          </div>

          <div
            ref="bodyRef"
            class="panel-body"
            @compositionstart="isComposingText = true"
            @compositionend="handleCompositionEnd"
          >
            <TiptapNoteEditor
              ref="editorRef"
              :model-value="editorValue"
              surface="todo-notes"
              :document-id="editorDocumentId"
              :document-path="editorDocumentPath"
              :workspace-root="editorWorkspaceRoot"
              :features="editorFeatures"
              :placeholder="editorPlaceholder"
              :spellcheck="false"
              :consumed-offset="editorConsumedOffset"
              @update:model-value="handleEditorUpdate"
              @keydown="handleEditorKeydown"
              @paste="handleMarkdownPaste"
              @open-link="openMarkdownLink"
              @open-image="openMarkdownImage"
              @selection-update="handleSelectionUpdate"
              @watermark="handleWatermark"
            />

            <!-- 选区浮条。`mousedown.prevent` 是它能工作的全部前提:不拦下来,
                 按下的那一刻焦点离开编辑器,选区当场没了,点到的是一段空文本。 -->
            <div
              v-if="selectionFloaterVisible"
              class="selection-floater"
              @mousedown.prevent
            >
              <span class="selection-count">{{ selectionCharCount }} 字</span>
              <Button
                text
                class="selection-send"
                native-type="button"
                aria-label="Send selection to AI"
                @mousedown.prevent
                @click.stop="sendScratchpadPending"
              >
                发给 AI
              </Button>
            </div>
          </div>

          <footer
            v-if="showFooterBar || formatBufferOpen"
            class="note-footer"
            :class="{ formatting: formatBufferOpen }"
          >
            <div
              v-if="formatBufferOpen"
              class="format-buffer"
              role="toolbar"
              aria-label="Markdown formatting"
            >
              <Button
                text
                class="format-command heading-command"
                native-type="button"
                aria-label="Heading 1"
                @mousedown.prevent
                @click.stop="runFormatCommand('heading-1')"
              >
                <span>H</span>
                <ChevronDown :size="12" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Bold"
                @mousedown.prevent
                @click.stop="runFormatCommand('bold')"
              >
                <Bold :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Italic"
                @mousedown.prevent
                @click.stop="runFormatCommand('italic')"
              >
                <Italic :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Strikethrough"
                @mousedown.prevent
                @click.stop="runFormatCommand('strikethrough')"
              >
                <Strikethrough :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Underline"
                @mousedown.prevent
                @click.stop="runFormatCommand('underline')"
              >
                <Underline :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Inline code"
                @mousedown.prevent
                @click.stop="runFormatCommand('inline-code')"
              >
                <Code2 :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Link"
                @mousedown.prevent
                @click.stop="runFormatCommand('link')"
              >
                <Link :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Code block"
                @mousedown.prevent
                @click.stop="runFormatCommand('code-block')"
              >
                <Code2 :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Quote"
                @mousedown.prevent
                @click.stop="runFormatCommand('blockquote')"
              >
                <Quote :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Bulleted list"
                @mousedown.prevent
                @click.stop="runFormatCommand('bullet-list')"
              >
                <List :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Numbered list"
                @mousedown.prevent
                @click.stop="runFormatCommand('ordered-list')"
              >
                <ListOrdered :size="16" />
              </Button>
              <Button
                text
                class="format-command"
                native-type="button"
                aria-label="Task list"
                @mousedown.prevent
                @click.stop="runFormatCommand('task-list')"
              >
                <ListChecks :size="16" />
              </Button>
              <span class="format-separator" />
              <Button
                text
                class="format-command close-format"
                native-type="button"
                aria-label="Hide formatting bar"
                @mousedown.prevent
                @click.stop="formatBufferOpen = false"
              >
                <X :size="16" />
              </Button>
            </div>
            <template v-else>
              <span>{{ characterCountLabel }}</span>
              <!-- 水位文案由 `scratchpad:consumed` 事件驱动,不是猜的:没有事件就
               不说"已读"。 -->
              <span
                v-if="watermarkLabel"
                class="pad-watermark"
              >{{ watermarkLabel }}</span>
              <Tooltip
                v-if="isTodoMode"
                text="Show formatting bar"
              >
                <Button
                  text
                  class="format-toggle"
                  native-type="button"
                  aria-label="Show formatting bar"
                  @mousedown.prevent
                  @click.stop="toggleFormatBuffer"
                >
                  <Type :size="21" />
                </Button>
              </Tooltip>
            </template>
          </footer>
        </div>

        <!-- 信息面。它不是第二块内容区,是**这一刻这张纸的读数** ——
             Todo 侧读进度,草稿纸侧读"AI 看到哪儿了 / 什么时候会看到"。 -->
        <aside
          v-if="showInfoPanel"
          class="info-panel"
        >
          <template v-if="isTodoMode">
            <span class="info-title">进度</span>
            <div class="progress-block">
              <!-- 「5/5」是一个词,不拆大小字(设计稿如此)。 -->
              <div class="progress-figure">
                <b>{{ todoProgress.done }}/{{ todoProgress.total }}</b>
              </div>
              <div
                class="progress-track"
                role="progressbar"
                :aria-valuenow="todoProgressPercent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div
                  class="progress-fill"
                  :style="{ width: `${todoProgressPercent}%` }"
                />
              </div>
            </div>
            <p class="info-hint">
              拖左侧手柄调顺序,完成的项留在原位。
            </p>
            <!-- 设计稿此处还有一枚「AI 已读」丸 —— 被裁掉了(用户裁定):Todo 侧
                 没有任何真实信号在驱动它,常驻等于假功能。等 todo 有了诚实的
                 已读事实(比如注入消费回执)再谈。 -->
          </template>

          <template v-else>
            <span class="info-title">AI 上下文</span>

            <div class="info-state">
              <span class="state-line">
                <i class="state-dot" />{{ watermarkLabel || 'AI 尚未读过' }}
              </span>
              <span class="state-sub">{{ pushStatusLabel }}</span>
              <span class="state-sub">{{ scratchpadSaveLabel }}</span>
            </div>

            <div class="send-group">
              <Button
                text
                class="send-primary"
                native-type="button"
                :disabled="!canSendScratchpad"
                aria-label="Send scratchpad content"
                @mousedown.prevent
                @click.stop="sendScratchpadPending"
              >
                发送给 AI
              </Button>
              <!-- ↩ 后面跟文本变体选择符(U+FE0E):裸 ↩ 会被 emoji 字形接管,
                   渲染成一枚键帽盒子 —— 设计稿是素文字。 -->
              <span class="send-hint">⌘ + ↩&#xFE0E;</span>
            </div>

            <div class="info-divider" />

            <div class="push-settings">
              <span class="info-title">推送设置</span>

              <div class="push-row">
                <span class="push-label">自动推送</span>
                <Switch
                  v-model="pushAuto"
                  size="small"
                  aria-label="自动推送"
                />
              </div>

              <!-- 「仅回复中」要靠宿主查得到"这一刻 AI 在不在回复"。查不到就把
                   整行关掉并说清楚,而不是留一个点得动、其实不生效的选项。 -->
              <Tooltip
                v-if="!canDetectReplying"
                text="本窗口查不到 AI 的回复状态,时机固定为「随时」"
              >
                <div
                  class="push-field is-off"
                  inert
                >
                  <span class="push-label">时机</span>
                  <SegmentedPill
                    :model-value="effectivePushTiming"
                    :options="PUSH_TIMING_OPTIONS"
                    aria-label="推送时机"
                  />
                </div>
              </Tooltip>
              <div
                v-else
                class="push-field"
                :class="{ 'is-off': !pushAuto }"
                :inert="!pushAuto"
              >
                <span class="push-label">时机</span>
                <SegmentedPill
                  :model-value="pushPrefs.timing"
                  :options="PUSH_TIMING_OPTIONS"
                  aria-label="推送时机"
                  @update:model-value="selectPushTiming"
                />
              </div>

              <div
                class="push-field"
                :class="{ 'is-off': !canUseWaitPills }"
                :inert="!canUseWaitPills"
              >
                <span class="push-label">等待</span>
                <SegmentedPill
                  :model-value="String(pushPrefs.waitSeconds)"
                  :options="PUSH_WAIT_OPTIONS"
                  aria-label="停笔等待时长"
                  @update:model-value="selectPushWait"
                />
              </div>
            </div>
          </template>
        </aside>
      </div>

      <div
        v-if="!isStandalone"
        class="resize-handle"
        @pointerdown="startResize"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { useConfirm } from '@/composables/useConfirm'
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import SegmentedPill from '@/components/common/SegmentedPill.vue'
import Switch from '@/components/common/Switch.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Bot,
  Bold,
  NotebookPen,
  SquareCheckBig,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  CornerDownLeft,
  FileText,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Info,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Quote,
  Search,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Underline,
  X,
} from 'lucide-vue-next'
import { useSessionsStore } from '@/stores/sessions'
import { copyTextToClipboard } from '@/utils/clipboard'
import type { TodoPlanDocument, TodoPlanSnapshot } from '@/types'
import TiptapNoteEditor from '@/editor/tiptap/TiptapNoteEditor.vue'
// 纸面色板(全局层,不 scoped):这扇窗的一切取色都从这里走。
import './todo-paper.css'
import type { MarkdownCommand, MarkdownFeatureSet } from '@/editor/markdown-document'
import { handleMarkdownAttachmentPaste } from '@/editor/markdown-attachments'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import { SESSION_COMMAND_TYPES } from '@shared/events/index.js'
import TodoNotesActionPanel from './TodoNotesActionPanel.vue'
import { parseTasks, titleFromMarkdown } from './todo-plan-utils'
import {
  createScratchpadPushScheduler,
  describeScratchpadPushStatus,
  readScratchpadPushPrefs,
  SCRATCHPAD_PUSH_WAIT_OPTIONS,
  scratchpadPushStorageKey,
  writeScratchpadPushPrefs,
  type ScratchpadPushPrefs,
  type ScratchpadPushTiming,
} from './scratchpad-push'
import type { ConsumedWatermarkResolution } from '@/editor/tiptap/consumed-watermark'
import {
  normalizeTodoPanelMode,
  readTodoPanelMode,
  TODO_PANEL_CARD_STORAGE_PREFIX,
  TODO_PANEL_WINDOW_STORAGE_PREFIX,
  todoPanelModeStorageKey,
  writeTodoPanelMode,
  type TodoPanelMode,
} from './todo-panel-mode'
import type {
  TodoNotesAction,
  TodoNotesActionContext,
} from './todo-notes-actions'
import { useScratchpadPad } from '@/composables/useScratchpadPad'
import {
  isWindowDragExcludedTarget,
  shouldStartWindowDrag,
  windowDragOffset,
  type WindowDragOffset,
  type WindowDragOrigin,
} from './todo-window-drag'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'
import { sessionCommands } from '@/platform/session-command-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.todo-plan')

const props = defineProps<{
  sessionId?: string
  workingDirectory?: string
  standalone?: boolean
}>()

const sessionsStore = useSessionsStore()
const storagePrefix = props.standalone
  ? TODO_PANEL_WINDOW_STORAGE_PREFIX
  : TODO_PANEL_CARD_STORAGE_PREFIX
const legacyChatStorage: Record<string, string> = {
  ActiveId: 'todoPlanActiveId',
  Pinned: 'todoPlanPinned',
  Collapsed: 'todoPlanCollapsed',
  Height: 'todoPlanHeight',
}
const PINNED_NOTES_STORAGE_KEY = 'todoPlanPinnedNoteIds'

function storageKey(name: string): string {
  return `${storagePrefix}${name}`
}

function readStorage(name: string, fallback = ''): string {
  const scoped = localStorage.getItem(storageKey(name))
  if (scoped !== null) return scoped
  const legacyKey = props.standalone ? undefined : legacyChatStorage[name]
  return (legacyKey ? localStorage.getItem(legacyKey) : null) ?? fallback
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const TODO_PANEL_DEFAULT_HEIGHT = 320
const TODO_PANEL_LEGACY_DEFAULT_HEIGHT = 360
const TODO_PANEL_MIN_HEIGHT = 220
const TODO_PANEL_MAX_HEIGHT = 620

function readPanelHeight(): number {
  const raw = readStorage('Height')
  if (!raw) return TODO_PANEL_DEFAULT_HEIGHT
  const value = Number(raw)
  if (!Number.isFinite(value)) return TODO_PANEL_DEFAULT_HEIGHT
  if (value === TODO_PANEL_LEGACY_DEFAULT_HEIGHT) return TODO_PANEL_DEFAULT_HEIGHT
  return clampNumber(value, TODO_PANEL_MIN_HEIGHT, TODO_PANEL_MAX_HEIGHT)
}

const { confirm } = useConfirm()
const snapshot = ref<TodoPlanSnapshot | null>(null)
const activeId = ref(readStorage('ActiveId'))
const draft = ref('')
const pinned = ref(props.standalone ? true : readStorage('Pinned', 'false') === 'true')
const collapsed = ref(props.standalone ? false : readStorage('Collapsed', 'true') !== 'false')
const panelHeight = ref(readPanelHeight())
const switcherOpen = ref(false)
const switcherQuery = ref('')
const switcherSelectedIndex = ref(0)
const actionPanelOpen = ref(false)
const actionQuery = ref('')
const formatBufferOpen = ref(false)
const pinnedNoteIds = ref<Set<string>>(readPinnedNoteIds())
const findOpen = ref(false)
const findQuery = ref('')
const activeFindIndex = ref(0)
const panelRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)
const titleButtonRef = ref<{ contains: (node: Node | null) => boolean } | null>(null)
const switcherRef = ref<HTMLElement | null>(null)
const switcherInputRef = ref<HTMLInputElement | null>(null)
const findBarRef = ref<HTMLElement | null>(null)
const findInputRef = ref<HTMLInputElement | null>(null)
const editorRef = ref<InstanceType<typeof TiptapNoteEditor> | null>(null)
const modeStorageKey = todoPanelModeStorageKey(storagePrefix)
const mode = ref<TodoPanelMode>(readTodoPanelMode(modeStorageKey))

// --- 草稿纸推送(状态与偏好)-----------------------------------------------
const pushStorageKeyName = scratchpadPushStorageKey(storagePrefix)
const pushPrefs = ref<ScratchpadPushPrefs>(readScratchpadPushPrefs(pushStorageKeyName))
/**
 * 宿主查不查得到"这一刻 AI 在回复"。**一次性判定,不是猜**:查不到就把
 * 「仅回复中」整行关掉,而不是留一个点得动、其实永远不触发的选项。
 */
const canDetectReplying = typeof platformApi.getActiveStreams === 'function'
const replying = ref(false)
const pushCountdown = ref<number | null>(null)
const justSentChars = ref<number | null>(null)
/** IME 组字中不 arm:半个字打到一半被推出去,是最难堪的那种"自动"。 */
const isComposingText = ref(false)
/**
 * 已经推送过的那一份纸。自动推送只对**这之后又写的东西**生效 —— 否则发出去
 * 会自己触发下一次(水位要等引擎回推才前移,pending 在那之前一直不空)。
 */
const lastPushedContent = ref<string | null>(null)
/** 编辑器算出来的已读块序(0 基);段号只能从那边来,见 consumed-watermark.ts。 */
const consumedBlockIndex = ref<number | null>(null)
const selectionText = ref('')
const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)

let cleanupChanged: (() => void) | undefined
let replyPollTimer: ReturnType<typeof setInterval> | null = null
let justSentTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let resizing = false
let resizeStartY = 0
let resizeStartHeight = 0
let loadedDocumentId = ''
const todoMarkdownFeatures: MarkdownFeatureSet = {
  tasks: true,
  tables: true,
  images: true,
  math: true,
  codeBlocks: true,
  frontmatter: true,
}
/**
 * 草稿纸是**写想法的地方**,不是文档编辑器:任务/图片/代码块留着(粘图管线
 * 要靠 images),表格/公式/frontmatter 关掉 —— 那些属于 Todo/笔记那一侧。
 */
const scratchpadMarkdownFeatures: MarkdownFeatureSet = {
  tasks: true,
  images: true,
  codeBlocks: true,
  tables: false,
  math: false,
  frontmatter: false,
}

/** 轨底的落款。两枚钮的图标与可及名逐个写在模板里(理由见那里的注释)。 */
const RAIL_LABELS: Record<TodoPanelMode, string> = {
  todo: 'TODO',
  scratchpad: 'SCRATCH',
}

const PUSH_TIMING_OPTIONS = [
  { value: 'anytime', label: '随时' },
  { value: 'while-replying', label: '仅回复中' },
]

const PUSH_WAIT_OPTIONS = SCRATCHPAD_PUSH_WAIT_OPTIONS.map(seconds => ({
  value: String(seconds),
  label: `${seconds}s`,
}))

/**
 * 「AI 在不在回复」的轮询间隔。
 *
 * 独立窗收不到主窗那条流事件(IPCBridge 只发给绑定的 webContents),所以这一位
 * 状态只能主动问 —— `platformApi.getActiveStreams()` 是渲染层唯一查得到它的地方。
 * 1.5s 是"人察觉不到延迟"与"别把 IPC 敲成鼓"之间的取值,而且**只在真的选了
 * 「仅回复中」时才轮**,其余时候一次也不问。
 */
const REPLY_POLL_MS = 1500

/** 「刚推送完」那句话停留多久。够看清,又不至于把状态行长期占住。 */
const JUST_SENT_HOLD_MS = 3200

/** 低于这个宽度就没有信息面了 —— 194px 的面加 60px 的轨会把文档挤成一条缝。 */
const INFO_PANEL_MIN_WIDTH = 560

const isStandalone = computed(() => props.standalone === true)
const isTodoMode = computed(() => mode.value === 'todo')
const isScratchpadMode = computed(() => mode.value === 'scratchpad')
const panelStyle = computed(() => {
  if (collapsed.value || isStandalone.value) return {}
  return { height: `${panelHeight.value}px` }
})
const popoverOpen = computed(() => switcherOpen.value || actionPanelOpen.value || findOpen.value)
const effectiveSessionId = computed(() => props.sessionId || sessionsStore.currentSessionId || undefined)
// 独立窗里 host 的答案优先:这扇窗跑的也是整套 App 引导,自己的 sessions store
// 在**开窗那一刻**水合过一次、此后永不更新 —— 把它排在 snapshot.sessionId 前面,
// 纸就永远停在开窗时的会话(真机实锤)。主窗切会话 → 主进程记下新的当前会话并
// 广播 → 这里重拉 snapshot,拿到的才是现在的会话。
const resolvedSessionId = computed(() => (isStandalone.value
  ? snapshot.value?.sessionId || effectiveSessionId.value
  : effectiveSessionId.value || snapshot.value?.sessionId) || undefined)
const effectiveWorkingDirectory = computed(() => {
  if (props.workingDirectory !== undefined) return props.workingDirectory || undefined
  const session = sessionsStore.sessions.find(item => item.id === resolvedSessionId.value)
  return session?.workingDirectory || undefined
})
/**
 * 草稿纸(scratchpad · AI 静默感知)。每会话一张纸,AI 每个 turn 静默读一遍,
 * 读到哪儿由 `scratchpad:consumed` 事件回推成一条水位线。
 *
 * 会话取 `resolvedSessionId` —— 独立窗里 sessions store 从不填充,会话是宿主
 * 解析出来的那一个(snapshot 带回来的)。
 */
const scratchpad = useScratchpadPad(() => resolvedSessionId.value, {
  active: () => isScratchpadMode.value,
})

const allDocuments = computed(() => {
  if (!snapshot.value) return []
  return [
    ...snapshot.value.userNotes,
    ...(snapshot.value.sessionAiTodo ? [snapshot.value.sessionAiTodo] : []),
  ]
})
const activeDocument = computed(() => allDocuments.value.find(doc => doc.id === activeId.value) || allDocuments.value[0])
const displayTitle = computed(() => isScratchpadMode.value
  ? '草稿纸'
  : titleFromMarkdown(draft.value, activeDocument.value?.title || 'Todo / Notes'))
const headerTitle = computed(() => (isScratchpadMode.value ? '草稿纸' : '待做'))
/**
 * 会话名。主窗里 sessions store 是活的,直接查;独立窗的 store 停在开窗那一刻,
 * 得按 id 去问 host(getSession)。查不到就空着 —— 头行少一个名字,不编一个。
 */
const sessionTitle = ref('')
watch(resolvedSessionId, async (sessionId) => {
  sessionTitle.value = ''
  if (!sessionId) return
  const local = sessionsStore.sessions.find(item => item.id === sessionId)?.name
  if (local) {
    sessionTitle.value = local
    return
  }
  try {
    const response = await platformApi.getSession(sessionId)
    // 异步回来时会话可能又换了 —— 只认还是当前会话的那份答案。
    if (resolvedSessionId.value === sessionId && response?.success) {
      sessionTitle.value = response.session?.name || ''
    }
  } catch {
    sessionTitle.value = ''
  }
}, { immediate: true })
/** 窗有没有键盘焦点 —— 交通灯褪灰的依据(真 mac 行为)。 */
const windowFocused = ref(typeof document === 'undefined' ? true : document.hasFocus())
function handleWindowFocusIn() {
  windowFocused.value = true
}
function handleWindowFocusOut() {
  windowFocused.value = false
}
const noteCountLabel = computed(() => {
  const count = snapshot.value?.userNotes.length || 0
  const label = count === 1 ? 'Note' : 'Notes'
  return `${count} ${label}`
})
const characterCountLabel = computed(() => isScratchpadMode.value
  ? `${scratchpad.charCount.value} 字${scratchpad.isDirty.value ? ' · 未保存' : ''}`
  : `${draft.value.length} characters`)

/**
 * 水位文案:只认事件,不猜。没有事件就不说"已读"。
 *
 * 「第 N 段」优先于「第 N 字」:水位本来就是**块边界**语义(offset 落在块中间
 * 时向后取整),报字数会给出一个比它实际知道的更精确的假象。段号由编辑器算
 * (`@watermark`),算不出来时才退回字数 —— 退回的是精度,不是诚实。
 */
const watermarkLabel = computed(() => {
  if (!isScratchpadMode.value) return ''
  const offset = scratchpad.consumedOffset.value
  const text = scratchpad.content.value
  if (offset === null) return text.trim() ? 'AI 尚未读过' : ''
  if (offset >= text.length) return 'AI 已读全部'
  if (consumedBlockIndex.value !== null) return `AI 读到第 ${consumedBlockIndex.value + 1} 段`
  return `AI 已读至 ${offset} 字`
})

/** 纸的存档状态:字数 + 落没落盘。dirty 只是"这一拍还没写出去",不是错误。 */
const scratchpadSaveLabel = computed(() =>
  `${scratchpad.charCount.value} 字 · ${scratchpad.isDirty.value ? '未保存' : '自动保存'}`)

// --- 头行读数 ---------------------------------------------------------------

/** 与 `todo-plan-utils.parseTasks` 同一条口径(围栏内的 `- [ ]` 不算任务)。 */
const todoProgress = computed(() => {
  const tasks = parseTasks(draft.value)
  return { done: tasks.filter(task => task.done).length, total: tasks.length }
})
const todoProgressPercent = computed(() => {
  const { done, total } = todoProgress.value
  return total ? Math.round((done / total) * 100) : 0
})
/** 没有任务的笔记不报"0 / 0 已完成" —— 那是在说一件不存在的事,改报字数。 */
const headerStatLabel = computed(() => {
  if (isScratchpadMode.value) return `${scratchpad.charCount.value} 字`
  const { done, total } = todoProgress.value
  return total ? `${done} / ${total} 已完成` : `${draft.value.length} 字`
})
const railLabel = computed(() => RAIL_LABELS[mode.value])

// --- 壳层可见性 -------------------------------------------------------------

/**
 * 信息面只在独立窗、且窗够宽时出。卡片形态(280px)放不下,窄窗放下了也只剩
 * 一条缝 —— 它退场之后发送钮回到头行,能力不掉。
 */
const showInfoPanel = computed(() =>
  isStandalone.value && viewportWidth.value >= INFO_PANEL_MIN_WIDTH)
/** 常驻页脚只属于卡片形态;窗形态的页脚只在格式条打开时临时出现。 */
const showFooterBar = computed(() => !isStandalone.value)

// --- 编辑器的一套入参:两种模式喂同一个 TiptapNoteEditor 实例 --------------
// `documentId` 一变编辑器就整份重置(含撤销历史)—— 切模式 = 换一份文档,
// undo 不许走回上一份,这正是想要的。

const editorValue = computed(() => isScratchpadMode.value ? scratchpad.content.value : draft.value)
const editorDocumentId = computed(() => isScratchpadMode.value
  ? `scratchpad:${resolvedSessionId.value ?? 'none'}`
  : (activeDocument.value?.id || 'todo-notes'))
const editorDocumentPath = computed(() => isScratchpadMode.value
  ? scratchpad.filePath.value
  : (activeDocument.value?.filePath || ''))
const editorWorkspaceRoot = computed(() => isScratchpadMode.value
  ? scratchpad.documentDir.value
  : (snapshot.value?.directory || effectiveWorkingDirectory.value || ''))
const editorFeatures = computed(() => isScratchpadMode.value
  ? scratchpadMarkdownFeatures
  : todoMarkdownFeatures)
const editorPlaceholder = computed(() => isScratchpadMode.value
  ? '随手写,AI 会看见'
  : '# Untitled Note')
const editorConsumedOffset = computed(() => isScratchpadMode.value
  ? scratchpad.consumedOffset.value
  : null)

/**
 * 「正式发出」能不能按。草稿会话的 id 只活在渲染层,永远不许过 IPC —— 这里是
 * 独立窗,没有 composer 那条物化管线接住它,所以直接把钮关掉而不是发出去失败。
 */
const scratchpadSessionReady = computed(() => {
  const sessionId = resolvedSessionId.value
  if (!sessionId) return false
  return !sessionsStore.isNewChatDraftId?.(sessionId)
})
const canSendScratchpad = computed(() => {
  if (!isScratchpadMode.value || !scratchpadSessionReady.value) return false
  // 选区优先的另一半:水位之后空着,但手里正选着一段,那一段照样发得出去。
  return scratchpad.hasUnreadTail.value || selectionText.value.trim().length > 0
})

// --- 选区浮条 ---------------------------------------------------------------

const selectionCharCount = computed(() => selectionText.value.trim().length)
const selectionFloaterVisible = computed(() =>
  isScratchpadMode.value && scratchpadSessionReady.value && selectionCharCount.value > 0)

// --- 自动推送 ---------------------------------------------------------------

/**
 * 生效的时机档。查不到"AI 在不在回复"时**强制回到「随时」** —— 存着的偏好
 * 不动(宿主换了就自然恢复),但这一刻不许按一个判不了的条件去等。
 */
const effectivePushTiming = computed<ScratchpadPushTiming>(() =>
  canDetectReplying ? pushPrefs.value.timing : 'anytime')
/** 「等待」只对「随时」有意义:回复时机是被事件触发的,没有停笔这回事。 */
const canUseWaitPills = computed(() =>
  pushPrefs.value.auto && effectivePushTiming.value === 'anytime')
/** 还有没有"没推送过"的新内容。推过的那一份不再自动重发。 */
const hasUnpushedContent = computed(() =>
  canSendScratchpad.value && scratchpad.content.value !== lastPushedContent.value)

const pushAuto = computed({
  get: () => pushPrefs.value.auto,
  set: (value: boolean) => updatePushPrefs({ auto: value === true }),
})

const pushStatusLabel = computed(() => describeScratchpadPushStatus({
  auto: pushPrefs.value.auto,
  timing: effectivePushTiming.value,
  waitSeconds: pushPrefs.value.waitSeconds,
  hasPending: hasUnpushedContent.value,
  countdownSeconds: pushCountdown.value,
  replying: replying.value,
  replyingKnown: canDetectReplying,
  justSentChars: justSentChars.value,
}))

const pushScheduler = createScratchpadPushScheduler({
  onFire: () => { void sendScratchpadPending() },
  onTick: (remaining) => { pushCountdown.value = remaining },
})
const actionContext = computed<TodoNotesActionContext>(() => ({
  activeDocument: activeDocument.value,
  selection: editorRef.value?.getSelection() || { from: 0, to: 0 },
  canEditNote: Boolean(activeDocument.value),
  canDeleteNote: activeDocument.value?.scope === 'user-note',
}))
const todoActions = computed<TodoNotesAction[]>(() => {
  const context = actionContext.value
  const canDelete = context.canDeleteNote
  const activePinned = context.activeDocument ? isNotePinned(context.activeDocument.id) : false
  return [
    {
      id: 'create-note',
      title: 'Create Note',
      subtitle: 'Start a new Markdown note',
      group: 'Note Actions',
      shortcut: '⌘N',
      icon: Plus,
      keywords: ['new', 'add'],
      run: createNote,
    },
    {
      id: 'rename-note',
      title: 'Rename Note',
      subtitle: canDelete ? 'Rename the current user note' : 'Only user notes can be renamed',
      group: 'Note Actions',
      icon: Pencil,
      enabled: canDelete,
      keywords: ['title'],
      run: renameNote,
    },
    {
      id: 'delete-note',
      title: 'Delete Note',
      subtitle: canDelete ? 'Delete the current user note' : 'System notes cannot be deleted',
      group: 'Note Actions',
      icon: Trash2,
      enabled: canDelete,
      keywords: ['remove'],
      run: deleteNote,
    },
    {
      id: 'pin-note',
      title: activePinned ? 'Unpin Note' : 'Pin Note',
      subtitle: canDelete
        ? (activePinned ? 'Remove the current note from the top of the list' : 'Keep the current note at the top of the list')
        : 'Only user notes can be pinned',
      group: 'Note Actions',
      icon: Pin,
      enabled: canDelete,
      keywords: ['favorite', 'top', 'unpin'],
      run: toggleActiveNotePinned,
    },
    {
      id: 'reveal-notes-folder',
      title: 'Reveal Notes Folder',
      subtitle: 'Open the Markdown storage directory',
      group: 'Note Actions',
      icon: FolderOpen,
      keywords: ['folder', 'directory', 'files'],
      run: revealNotesFolder,
    },
    {
      id: 'copy-markdown',
      title: 'Copy Markdown',
      subtitle: 'Copy the current note as Markdown',
      group: 'Note Actions',
      icon: Copy,
      keywords: ['clipboard', 'copy text'],
      run: copyMarkdown,
    },
    markdownAction('bold', 'Bold', 'bold', 'Markdown Formatting', Bold, '⌘B'),
    markdownAction('italic', 'Italic', 'italic', 'Markdown Formatting', Italic, '⌘I'),
    markdownAction('strikethrough', 'Strikethrough', 'strikethrough', 'Markdown Formatting', Strikethrough),
    markdownAction('underline', 'Underline', 'underline', 'Markdown Formatting', Underline, '⌘U'),
    markdownAction('inline-code', 'Inline Code', 'inline-code', 'Markdown Formatting', Code2, '⌘E'),
    markdownAction('link', 'Link', 'link', 'Markdown Formatting', Link),
    markdownAction('heading-1', 'Heading 1', 'heading-1', 'Markdown Formatting', Heading1, '⌥⌘1'),
    markdownAction('heading-2', 'Heading 2', 'heading-2', 'Markdown Formatting', Heading2, '⌥⌘2'),
    markdownAction('heading-3', 'Heading 3', 'heading-3', 'Markdown Formatting', Heading3, '⌥⌘3'),
    markdownAction('bullet-list', 'Bulleted List', 'bullet-list', 'Insert', List, '⇧⌘8'),
    markdownAction('ordered-list', 'Numbered List', 'ordered-list', 'Insert', ListOrdered, '⇧⌘7'),
    markdownAction('task-list', 'Task List', 'task-list', 'Insert', ListChecks, '⇧⌘9'),
    markdownAction('blockquote', 'Quote', 'blockquote', 'Insert', Quote),
    markdownAction('code-block', 'Code Block', 'code-block', 'Insert', Code2),
    markdownAction('table', 'Table', 'table', 'Insert', Table2),
    markdownAction('image', 'Image', 'image', 'Insert', Image),
    markdownAction('divider', 'Divider', 'horizontal-rule', 'Insert', Minus),
    {
      id: 'browse-notes',
      title: 'Browse Notes',
      subtitle: 'Open the notes switcher',
      group: 'Navigation',
      shortcut: '⌘P',
      icon: FileText,
      keywords: ['switch', 'open note'],
      run: openSwitcher,
    },
    {
      id: 'find-in-note',
      title: 'Find in Note',
      subtitle: 'Search the current note',
      group: 'Navigation',
      shortcut: '⌘F',
      icon: Search,
      keywords: ['search'],
      run: openFind,
    },
    {
      id: 'toggle-format-bar',
      title: formatBufferOpen.value ? 'Hide Formatting Bar' : 'Show Formatting Bar',
      subtitle: 'Markdown formatting shortcuts',
      group: 'Navigation',
      icon: Type,
      keywords: ['format', 'markdown', 'bar'],
      run: toggleFormatBuffer,
    },
    {
      id: 'pin-window',
      title: pinned.value ? 'Unpin Todo' : 'Pin Todo',
      subtitle: pinned.value ? 'Let the window hide with the app' : 'Keep the window on top',
      group: 'Navigation',
      icon: Pin,
      keywords: ['pin', 'float', 'top'],
      run: togglePinned,
    },
  ]
})
const sortedUserNotes = computed(() => {
  const notes = snapshot.value?.userNotes || []
  return [...notes].sort((a, b) => {
    const pinnedDelta = Number(isNotePinned(b.id)) - Number(isNotePinned(a.id))
    if (pinnedDelta !== 0) return pinnedDelta
    return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
  })
})
const filteredUserNotes = computed(() => {
  const query = switcherQuery.value.trim().toLowerCase()
  const notes = sortedUserNotes.value
  if (!query) return notes
  return notes.filter(note => documentMatchesQuery(note, query))
})
const filteredSystemNotes = computed(() => {
  const document = snapshot.value?.sessionAiTodo
  if (!document) return []
  const query = switcherQuery.value.trim().toLowerCase()
  if (!query || documentMatchesQuery(document, query)) return [document]
  return []
})
const switcherDocuments = computed(() => [
  ...filteredUserNotes.value,
  ...filteredSystemNotes.value,
])
const switcherSelectedDocument = computed(() => switcherDocuments.value[switcherSelectedIndex.value])
const switcherDocumentSignature = computed(() => switcherDocuments.value.map(doc => doc.id).join('\u0000'))
watch([switcherQuery, switcherDocumentSignature], () => {
  if (!switcherOpen.value) return
  resetSwitcherSelection()
})
/**
 * 查找交给编辑器做,而不是拿 markdown 原文 `indexOf`。
 *
 * 换 Tiptap 之后这一条从"可以"变成"必须":选区用的是 ProseMirror 坐标,而
 * markdown 字符偏移与它不是同一套(`#` / `- [ ]` / `**` 在源码里占位、在文档里
 * 不占)。照着源码偏移去选,会稳定地选到别处。
 */
const findMatches = computed<Array<{ from: number; to: number }>>(() => {
  // 读一下 draft:它一变说明文档变了,匹配位置要跟着重算(PM 的 state 不是
  // Vue 的响应式依赖,这里得手动挂一个)。
  void draft.value
  if (!isTodoMode.value) return []
  return editorRef.value?.findTextMatches(findQuery.value) ?? []
})
const findStatus = computed(() => {
  if (!findQuery.value.trim()) return '0/0'
  if (!findMatches.value.length) return '0/0'
  return `${activeFindIndex.value + 1}/${findMatches.value.length}`
})

function documentMatchesQuery(document: TodoPlanDocument, query: string): boolean {
  return document.title.toLowerCase().includes(query) ||
    document.content.toLowerCase().includes(query)
}

watch(activeDocument, (doc) => {
  if (!doc || doc.id === loadedDocumentId) return
  loadedDocumentId = doc.id
  draft.value = doc.content || ''
}, { immediate: true })

watch([pinned, collapsed], () => {
  localStorage.setItem(storageKey('Pinned'), String(pinned.value))
  if (!isStandalone.value) {
    localStorage.setItem(storageKey('Collapsed'), String(collapsed.value))
  }
})

watch(effectiveSessionId, () => {
  loadSnapshot()
})

watch(findQuery, () => {
  activeFindIndex.value = 0
  selectActiveFindMatch()
})

watch(activeFindIndex, () => {
  selectActiveFindMatch()
})

/**
 * 纸一变就重排推送。挂在 `content` 上而不是 keydown 上:外部改动(AI 用文件
 * 工具写了这张纸、别的窗口在写)同样是"纸变了",凭什么不算。
 */
watch(() => scratchpad.content.value, () => {
  syncAutoPushArming()
})

watch([() => mode.value, () => resolvedSessionId.value], () => {
  syncAutoPush()
})

async function loadSnapshot() {
  const response = await platformApi.getTodoPlan({
    sessionId: effectiveSessionId.value,
  })
  if (!response.success || !response.snapshot) return
  snapshot.value = response.snapshot
  if (!allDocuments.value.some(doc => doc.id === activeId.value)) {
    const fallbackDocument = response.snapshot.userNotes[0] || response.snapshot.sessionAiTodo
    if (fallbackDocument) {
      selectDocument(fallbackDocument.id, false)
    } else {
      activeId.value = ''
      loadedDocumentId = ''
      draft.value = ''
    }
  }
}

function readPinnedNoteIds(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_NOTES_STORAGE_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function writePinnedNoteIds(ids: Set<string>) {
  localStorage.setItem(PINNED_NOTES_STORAGE_KEY, JSON.stringify([...ids]))
}

function isNotePinned(id: string): boolean {
  return pinnedNoteIds.value.has(id)
}

function toggleActiveNotePinned() {
  const document = activeDocument.value
  if (!document || document.scope !== 'user-note') return
  toggleNotePinned(document.id)
}

function toggleNotePinned(id: string) {
  const next = new Set(pinnedNoteIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  pinnedNoteIds.value = next
  writePinnedNoteIds(next)
}

function selectDocument(id: string, closeSwitcher = true) {
  activeId.value = id
  localStorage.setItem(storageKey('ActiveId'), id)
  const document = allDocuments.value.find(doc => doc.id === id)
  loadedDocumentId = id
  draft.value = document?.content || ''
  findQuery.value = ''
  if (closeSwitcher) switcherOpen.value = false
  nextTick(() => {
    editorRef.value?.focus()
  })
}

function markdownAction(
  id: string,
  title: string,
  command: MarkdownCommand,
  group: TodoNotesAction['group'],
  icon: TodoNotesAction['icon'],
  shortcut?: string,
): TodoNotesAction {
  return {
    id,
    title,
    subtitle: 'Format the current Markdown selection',
    group,
    shortcut,
    icon,
    markdownCommand: command,
    keywords: [command, 'markdown', 'format'],
    enabled: Boolean(activeDocument.value),
    run: () => applyEditorCommand(command),
  }
}

function applyEditorCommand(command: MarkdownCommand) {
  editorRef.value?.applyCommand(command)
}

function handleEditorUpdate(value: string) {
  if (isScratchpadMode.value) {
    // 纸自己就是事实:store 本地即改 + 防抖落盘,不走 todo 的保存路。
    scratchpad.setContent(value)
    return
  }
  handleDraftUpdate(value)
}

function handleDraftUpdate(value: string) {
  draft.value = value
  scheduleSave()
}

// --- 形态开关 -------------------------------------------------------------

/** 换形态前先把浮层收干净 —— 它们全是 Todo 侧的东西,跟到草稿纸上就是幽灵。 */
function closeTodoPopovers() {
  actionPanelOpen.value = false
  actionQuery.value = ''
  switcherOpen.value = false
  findOpen.value = false
  findQuery.value = ''
  formatBufferOpen.value = false
}

function applyMode(next: TodoPanelMode, options?: { persist?: boolean }) {
  if (next === mode.value) return
  // 离开草稿纸时把欠的 flush 结掉:纸是文件,不是内存草稿。
  if (isScratchpadMode.value) void scratchpad.store.flushNow(resolvedSessionId.value)
  closeTodoPopovers()
  // 换形态 = 换一份文档:选区、已读段序、排着的推送都属于上一份,一律清掉。
  pushScheduler.disarm()
  selectionText.value = ''
  consumedBlockIndex.value = null
  mode.value = next
  if (options?.persist !== false) writeTodoPanelMode(modeStorageKey, next)
  nextTick(() => editorRef.value?.focus())
}

function selectMode(next: string) {
  applyMode(normalizeTodoPanelMode(next))
}

/**
 * 跨窗口的形态信号。composer 的草稿纸钮在主窗里写这个键,这扇窗靠 `storage`
 * 事件跟上(同源的另一个文档写了键才会派发)。事件没送达也不会坏事 —— 最差是
 * 已经开着的窗停在原形态。
 */
function handleModeStorage(event: StorageEvent) {
  if (event.key !== modeStorageKey) return
  applyMode(normalizeTodoPanelMode(event.newValue), { persist: false })
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveDraft, 260)
}

async function saveDraft() {
  saveTimer = null
  const document = activeDocument.value
  if (!document) return
  const response = await platformApi.updateTodoPlan({
    scope: document.scope,
    id: document.scope === 'user-note' ? document.id : undefined,
    sessionId: effectiveSessionId.value,
    content: draft.value,
  })
  if (response.success && response.document) {
    applyDocument(response.document)
  }
}

function applyDocument(document: TodoPlanDocument) {
  if (!snapshot.value) return
  const currentDocument = activeDocument.value
  const isActiveDocument = currentDocument?.id === document.id
  const hasLocalDraftChanges = isActiveDocument && draft.value !== (currentDocument.content || '')

  if (document.scope === 'user-note') {
    const nextNotes = snapshot.value.userNotes.some(note => note.id === document.id)
      ? snapshot.value.userNotes.map(note => note.id === document.id ? document : note)
      : [...snapshot.value.userNotes, document]
    snapshot.value = { ...snapshot.value, userNotes: nextNotes }
  } else if (document.scope === 'session-ai-todo') {
    snapshot.value = { ...snapshot.value, sessionAiTodo: document }
  }

  if (isActiveDocument && !hasLocalDraftChanges) {
    loadedDocumentId = document.id
    draft.value = document.content || ''
  }
}

async function createNote() {
  const title = 'Untitled Note'
  const response = await platformApi.createTodoPlanNote({
    title,
    content: `# ${title}\n\n`,
  })
  if (response.success && response.document) {
    applyDocument(response.document)
    selectDocument(response.document.id)
    nextTick(() => {
      editorRef.value?.focus()
      editorRef.value?.setSelection(response.document?.content.length || draft.value.length)
    })
  }
}

async function renameNote() {
  const document = activeDocument.value
  if (!document || document.scope !== 'user-note') return
  const title = window.prompt('Rename note', displayTitle.value)
  if (!title?.trim()) return
  const response = await platformApi.renameTodoPlanNote({ id: document.id, title })
  if (response.success && response.document) {
    loadedDocumentId = ''
    await loadSnapshot()
    selectDocument(response.document.id)
  }
}

async function deleteNote() {
  const document = activeDocument.value
  if (!document || document.scope !== 'user-note') return
  await deleteUserNote(document.id)
}

async function deleteUserNote(id: string) {
  const document = snapshot.value?.userNotes.find(note => note.id === id)
  if (!document) return
  const accepted = await confirm({
    title: 'Delete note',
    message: `Delete "${document.title}"?`,
    confirmText: 'Delete',
    danger: true,
  })
  if (!accepted) return
  const response = await platformApi.deleteTodoPlanNote({ id: document.id })
  if (response.success) {
    loadedDocumentId = ''
    await loadSnapshot()
  }
}

function openSwitcher() {
  if (!isTodoMode.value) return
  actionPanelOpen.value = false
  formatBufferOpen.value = false
  findOpen.value = false
  switcherOpen.value = true
  switcherQuery.value = ''
  resetSwitcherSelection()
  nextTick(() => {
    switcherInputRef.value?.focus()
    switcherInputRef.value?.select()
    scrollSelectedSwitcherDocumentIntoView()
  })
}

function closeSwitcher() {
  switcherOpen.value = false
}

function resetSwitcherSelection() {
  const documents = switcherDocuments.value
  if (!documents.length) {
    switcherSelectedIndex.value = 0
    return
  }
  const activeIndex = documents.findIndex(doc => doc.id === activeId.value)
  switcherSelectedIndex.value = activeIndex >= 0 ? activeIndex : 0
  scrollSelectedSwitcherDocumentIntoView()
}

function moveSwitcherSelection(direction: number) {
  const documents = switcherDocuments.value
  if (!documents.length) return
  switcherSelectedIndex.value = (switcherSelectedIndex.value + direction + documents.length) % documents.length
  scrollSelectedSwitcherDocumentIntoView()
}

function selectSwitcherDocument(id: string) {
  const index = switcherDocuments.value.findIndex(doc => doc.id === id)
  if (index >= 0) switcherSelectedIndex.value = index
}

function scrollSelectedSwitcherDocumentIntoView() {
  if (!switcherOpen.value) return
  nextTick(() => {
    const id = switcherSelectedDocument.value?.id
    if (!id) return
    const option = [...(switcherRef.value?.querySelectorAll<HTMLElement>('.note-option') || [])]
      .find(element => element.dataset.noteId === id)
    option?.scrollIntoView({ block: 'nearest' })
  })
}

function openActionPanel() {
  if (!isTodoMode.value) return
  actionPanelOpen.value = true
  actionQuery.value = ''
  switcherOpen.value = false
  findOpen.value = false
  formatBufferOpen.value = false
}

function closeActionPanel(focusEditor = true) {
  actionPanelOpen.value = false
  actionQuery.value = ''
  if (focusEditor) nextTick(() => editorRef.value?.focus())
}

async function runAction(action: TodoNotesAction) {
  if (action.enabled === false) return
  actionPanelOpen.value = false
  actionQuery.value = ''
  await action.run()
  if (!switcherOpen.value && !findOpen.value) {
    nextTick(() => editorRef.value?.focus())
  }
}

function openFind() {
  if (!isTodoMode.value) return
  actionPanelOpen.value = false
  formatBufferOpen.value = false
  switcherOpen.value = false
  findOpen.value = true
  nextTick(() => {
    findInputRef.value?.focus()
    findInputRef.value?.select()
    selectActiveFindMatch()
  })
}

function closeFind() {
  findOpen.value = false
  findQuery.value = ''
  nextTick(() => editorRef.value?.focus())
}

function toggleFormatBuffer() {
  if (!isTodoMode.value) return
  formatBufferOpen.value = !formatBufferOpen.value
  if (formatBufferOpen.value) {
    actionPanelOpen.value = false
    switcherOpen.value = false
    findOpen.value = false
    nextTick(() => editorRef.value?.focus())
  }
}

function runFormatCommand(command: MarkdownCommand) {
  applyEditorCommand(command)
}

async function revealNotesFolder() {
  await platformApi.revealTodoPlanDirectory?.()
}

async function copyMarkdown() {
  const success = await copyTextToClipboard(draft.value)
  if (!success) {
    log.warn('todo plan markdown copy failed')
  }
}

/**
 * 草稿纸的「正式发出」:选区优先,否则水位之后没被读过的那一段。发出的内容
 * **不从纸上删除** —— 纸是持久文档,水位由引擎消费驱动往前推,与这次发送无关。
 *
 * ## 为什么这里直接发命令,而不是借道 composer
 * 借不到。这个组件唯一活着的挂载点是**独立的 Todo 窗**(`TodoPlanWindow.vue`),
 * 那扇窗里没有 InputBox —— 排队、引用物化、附件降级那一套全在主窗的 composer 里,
 * 跨窗口够不着(要够着就得加一条主进程通道,那是后端改动)。
 *
 * 所以这条路**诚实地窄**:纯文本,一条 `command:send-message`,与 chatStore
 * 发普通消息落到主进程的是同一个命令。它不做的事说清楚:不物化 `@文件` / 页面
 * 引用(纸上手打的 token 会原样进正文)、不按模型能力把图降级成原生附件
 * (路径留在正文,模型用文件工具去看)、生成中不排队(引擎自己决定怎么接)。
 */
async function sendScratchpadPending() {
  if (!canSendScratchpad.value) return
  const sessionId = resolvedSessionId.value
  if (!sessionId) return
  const selected = editorRef.value?.getSelectedText() ?? ''
  const text = selected.trim() ? selected : scratchpad.pendingText()
  if (!text.trim()) return
  // 手动发出去的那一刻,已经排好的自动推送作废 —— 否则等一会儿会再发一次。
  pushScheduler.disarm()
  // 先把纸落盘再发:模型下一个 turn 读到的那份必须已经包含这段话。
  await scratchpad.store.flushNow(sessionId)
  await sessionCommands.emit({
    sessionId,
    command: {
      type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
      content: text,
    },
  })
  lastPushedContent.value = scratchpad.content.value
  noteJustSent(text.trim().length)
}

// --- 推送设置的状态机接线 ---------------------------------------------------

function updatePushPrefs(patch: Partial<ScratchpadPushPrefs>) {
  pushPrefs.value = { ...pushPrefs.value, ...patch }
  writeScratchpadPushPrefs(pushStorageKeyName, pushPrefs.value)
  syncAutoPush()
}

function selectPushTiming(next: string) {
  updatePushPrefs({ timing: next === 'while-replying' ? 'while-replying' : 'anytime' })
}

function selectPushWait(next: string) {
  updatePushPrefs({ waitSeconds: Number(next) })
}

function noteJustSent(chars: number) {
  justSentChars.value = chars
  if (justSentTimer) clearTimeout(justSentTimer)
  justSentTimer = setTimeout(() => {
    justSentTimer = null
    justSentChars.value = null
  }, JUST_SENT_HOLD_MS)
}

/**
 * 「随时」档的停笔倒计时。每一次内容变化就重新计时 —— 这正是"停笔多久"的
 * 含义。条件一个不满足就解除,而不是留一个跑着的钟。
 */
function syncAutoPushArming() {
  const armed = isScratchpadMode.value
    && pushPrefs.value.auto
    && effectivePushTiming.value === 'anytime'
    && hasUnpushedContent.value
    && !isComposingText.value
  if (!armed) {
    pushScheduler.disarm()
    return
  }
  pushScheduler.arm(pushPrefs.value.waitSeconds)
}

/**
 * 「仅回复中」档的探针。**只在真的选了它的时候才轮** —— 别的时候一次 IPC 都不打。
 *
 * 两个宿主的返回字段不同名(desktop 是 `sessionIds`,server 是 `streams`),
 * 两边都读,谁在读谁。查不到就当"不在回复",不猜。
 */
async function pollReplying() {
  const sessionId = resolvedSessionId.value
  if (!sessionId) {
    replying.value = false
    return
  }
  try {
    const response = await platformApi.getActiveStreams()
    const ids = response?.sessionIds ?? response?.streams ?? []
    const next = Array.isArray(ids) && ids.includes(sessionId)
    const started = next && !replying.value
    replying.value = next
    if (started && hasUnpushedContent.value) await sendScratchpadPending()
  } catch {
    replying.value = false
  }
}

function syncReplyPolling() {
  const wanted = canDetectReplying
    && isScratchpadMode.value
    && pushPrefs.value.auto
    && effectivePushTiming.value === 'while-replying'
  if (wanted && !replyPollTimer) {
    void pollReplying()
    replyPollTimer = setInterval(() => { void pollReplying() }, REPLY_POLL_MS)
    return
  }
  if (!wanted && replyPollTimer) {
    clearInterval(replyPollTimer)
    replyPollTimer = null
    replying.value = false
  }
}

function syncAutoPush() {
  syncAutoPushArming()
  syncReplyPolling()
}

function handleCompositionEnd() {
  isComposingText.value = false
  syncAutoPushArming()
}

/** 选区变了就重取一次:浮条与"发选区"读的是同一个值,不许各拿各的。 */
function handleSelectionUpdate() {
  selectionText.value = editorRef.value?.getSelectedText() ?? ''
}

function handleWatermark(resolution: ConsumedWatermarkResolution) {
  consumedBlockIndex.value = resolution.blockIndex
}

function moveFind(direction: number) {
  if (!findMatches.value.length) return
  activeFindIndex.value = (activeFindIndex.value + direction + findMatches.value.length) % findMatches.value.length
}

function selectActiveFindMatch() {
  const match = findMatches.value[activeFindIndex.value]
  if (!findOpen.value || !match) return
  nextTick(() => editorRef.value?.setSelection(match.from, match.to))
}

function handleFindKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeFind()
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    moveFind(event.shiftKey ? -1 : 1)
  }
}

function handleSwitcherKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSwitcher()
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveSwitcherSelection(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveSwitcherSelection(-1)
    return
  }
  if (event.key !== 'Enter') return
  if (switcherSelectedDocument.value) {
    event.preventDefault()
    selectDocument(switcherSelectedDocument.value.id)
  }
}

function handleEditorKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()

  if (isScratchpadMode.value) {
    // 纸上 Enter 永远是换行 —— 只有 ⌘⏎ / Ctrl⏎ 才是"正式发出"。Todo 侧的
    // ⌘F/⌘P/⌘K/⌘N 全是笔记操作,草稿纸上一律不接管(留给系统)。
    if (command && event.key === 'Enter') {
      event.preventDefault()
      void sendScratchpadPending()
    }
    return
  }

  if (command && key === 'f') {
    event.preventDefault()
    openFind()
    return
  }
  if (command && key === 'p') {
    event.preventDefault()
    openSwitcher()
    return
  }
  if (command && key === 'k') {
    event.preventDefault()
    openActionPanel()
    return
  }
  if (command && key === 'n') {
    event.preventDefault()
    createNote()
    return
  }
}

async function handleMarkdownPaste(event: ClipboardEvent) {
  // 粘图落盘要一个"文档在哪儿"的基准。草稿纸模式下那就是纸本身的路径 ——
  // 这张纸是真实文件,所以整条附件管线原样通。
  await handleMarkdownAttachmentPaste({
    event,
    editor: editorRef.value,
    documentPath: editorDocumentPath.value || undefined,
    workspaceRoot: editorWorkspaceRoot.value || undefined,
  })
}

async function resolveMarkdownLink(href: string, asset?: MarkdownAssetResolution | null) {
  if (asset) return asset
  const documentPath = editorDocumentPath.value
  if (!documentPath) return null
  const response = await markdownApi.resolveAsset({
    documentPath,
    workspaceRoot: editorWorkspaceRoot.value || undefined,
    rawTarget: href,
  })
  return response.success ? response.asset || null : null
}

async function openMarkdownLink(payload: { href: string; asset?: MarkdownAssetResolution | null }) {
  const asset = await resolveMarkdownLink(payload.href, payload.asset)
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

async function openMarkdownImage(payload: { src: string; alt: string; asset?: MarkdownAssetResolution | null }) {
  await platformApi.openImagePreview(payload.asset?.dataUrl || payload.src, payload.alt)
}

function handleShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  const target = event.target as Node | null
  const isInPanel = isStandalone.value || (target && panelRef.value?.contains(target))
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()

  if (command && event.shiftKey && key === 't' && !isStandalone.value) {
    event.preventDefault()
    toggleCollapsed()
    return
  }
  if (!isInPanel) return

  // 笔记快捷键只在 Todo 侧成立 —— 草稿纸上没有"笔记"这个东西。
  if (isTodoMode.value) {
    if (command && key === 'f') {
      event.preventDefault()
      openFind()
      return
    }
    if (command && key === 'p') {
      event.preventDefault()
      openSwitcher()
      return
    }
    if (command && key === 'k') {
      event.preventDefault()
      openActionPanel()
      return
    }
    if (command && key === 'n') {
      event.preventDefault()
      createNote()
      return
    }
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    handleEscape()
  }
}

function handleEscape() {
  if (actionPanelOpen.value) {
    closeActionPanel()
    return
  }
  if (findOpen.value) {
    closeFind()
    return
  }
  if (switcherOpen.value) {
    closeSwitcher()
    return
  }
  if (formatBufferOpen.value) {
    formatBufferOpen.value = false
    nextTick(() => editorRef.value?.focus())
    return
  }
  if (isStandalone.value) {
    platformApi.hideTodoPlanWindow?.({
      activation: 'preserve-current-app',
      preserveMainWindowVisibility: true,
    })
    return
  }
  collapseToEdge()
}

function handleOutsidePointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (!target) return
  if (actionPanelOpen.value) {
    const actionPanel = panelRef.value?.querySelector('.todo-notes-action-panel')
    if (actionPanel?.contains(target)) return
    actionPanelOpen.value = false
  }
  if (switcherOpen.value) {
    if (titleButtonRef.value?.contains(target) || switcherRef.value?.contains(target)) return
    switcherOpen.value = false
  }
  if (findOpen.value) {
    if (findBarRef.value?.contains(target)) return
  }
  if (formatBufferOpen.value && panelRef.value && !panelRef.value.contains(target)) {
    formatBufferOpen.value = false
  }
}

function togglePinned() {
  pinned.value = !pinned.value
  if (pinned.value) collapsed.value = false
  if (isStandalone.value) {
    platformApi.setTodoPlanWindowPinned(pinned.value)
  }
}

function startResize(event: PointerEvent) {
  resizing = true
  resizeStartY = event.clientY
  resizeStartHeight = panelHeight.value
  window.addEventListener('pointermove', handleResize)
  window.addEventListener('pointerup', stopResize, { once: true })
}

function handleResize(event: PointerEvent) {
  if (!resizing) return
  const nextHeight = clampNumber(
    resizeStartHeight + event.clientY - resizeStartY,
    TODO_PANEL_MIN_HEIGHT,
    TODO_PANEL_MAX_HEIGHT,
  )
  panelHeight.value = nextHeight
  localStorage.setItem(storageKey('Height'), String(nextHeight))
}

function stopResize() {
  resizing = false
  window.removeEventListener('pointermove', handleResize)
}

function toggleCollapsed() {
  if (isStandalone.value) return
  collapsed.value = !collapsed.value
}

function expandFromEdge() {
  if (isStandalone.value) return
  collapsed.value = false
}

function collapseToEdge() {
  if (isStandalone.value) return
  if (pinned.value) return
  collapsed.value = true
}

function handlePanelMouseEnter() {
  expandFromEdge()
}

function handlePanelMouseLeave() {
  collapseToEdge()
}

// ── 独立窗:自绘红绿灯 + 手动拖窗 ─────────────────────────────────────────────
//
// 两件事同一个根因:这扇窗是 macOS non-activating `NSPanel`(`type: 'panel'` +
// native 的 `NSWindowStyleMaskNonactivatingPanel` / `_setPreventsActivation:`)。
// 它永远成不了 main window,于是 ① 系统交通灯恒定画成失活的灰点;② 原生
// `-webkit-app-region: drag` 那条路(最终落到 `-[NSWindow performWindowDragWithEvent:]`)
// 对它不生效 —— 同一份 CSS 在主窗和搜索窗上都拖得动,唯独这扇不动。
//
// 所以:主进程把系统按钮收起来,这里画三枚真的点;CSS 里的 drag 声明**保留**
// (哪天窗型变了它自然接管),同时补一条手动拖拽。两条路互斥:原生 drag 一旦生效,
// 拖动面上的 pointerdown 会被原生层吃掉,下面这套自然就不再触发。

/** 红点 = 隐藏,不是销毁 —— 这扇窗从来就是「收起来」的语义(见 hideTodoPlanWindow)。 */
function closeStandaloneWindow() {
  void platformApi.hideTodoPlanWindow()
}

function minimizeStandaloneWindow() {
  void platformApi.minimizeTodoPlanWindow?.()
}

function zoomStandaloneWindow() {
  void platformApi.zoomTodoPlanWindow?.()
}

let windowDragPointerId: number | null = null
let windowDragSurface: HTMLElement | null = null
let windowDragOrigin: WindowDragOrigin | null = null
let windowDragPending: WindowDragOffset | null = null
let windowDragFrame: number | null = null

function flushWindowDrag() {
  windowDragFrame = null
  const offset = windowDragPending
  windowDragPending = null
  if (!offset) return
  void platformApi.dragTodoPlanWindow?.({ phase: 'move', dx: offset.dx, dy: offset.dy })
}

function handleWindowDragStart(event: PointerEvent) {
  if (!isStandalone.value) return
  if (typeof platformApi.dragTodoPlanWindow !== 'function') return
  if (!shouldStartWindowDrag(event)) return

  const surface = event.currentTarget as HTMLElement | null
  windowDragPointerId = event.pointerId
  windowDragSurface = surface
  windowDragOrigin = { screenX: event.screenX, screenY: event.screenY }
  // 指针捕获:拖到窗外、拖过别的元素都还收得到 move,松手也一定收得到 up。
  surface?.setPointerCapture?.(event.pointerId)
  // 拖动期间禁选:否则一路拖过去会把标题刷成蓝底。
  document.body.classList.add('todo-window-dragging')
  void platformApi.dragTodoPlanWindow({ phase: 'start' })
}

function handleWindowDragMove(event: PointerEvent) {
  if (windowDragPointerId === null || event.pointerId !== windowDragPointerId) return
  if (!windowDragOrigin) return
  // 每帧最多一条 invoke。攒的是**累计位移**而不是帧间增量,所以合帧时丢掉中间那些
  // 也不会少挪一段。
  windowDragPending = windowDragOffset(windowDragOrigin, event)
  if (windowDragFrame !== null) return
  windowDragFrame = requestAnimationFrame(flushWindowDrag)
}

function handleWindowDragEnd(event?: PointerEvent) {
  if (windowDragPointerId === null) return
  if (event && event.pointerId !== windowDragPointerId) return
  if (windowDragFrame !== null) {
    cancelAnimationFrame(windowDragFrame)
    windowDragFrame = null
  }
  flushWindowDrag()
  if (event) windowDragSurface?.releasePointerCapture?.(event.pointerId)
  windowDragPointerId = null
  windowDragSurface = null
  windowDragOrigin = null
  document.body.classList.remove('todo-window-dragging')
  void platformApi.dragTodoPlanWindow?.({ phase: 'end' })
}

/** 双击顶带 = zoom,mac 惯例。落在可交互件上的双击不算。 */
/**
 * 根元素的裸面 = `panel-main` 四周那圈窗底缝隙(margin 露出来的部分)。它也是
 * 窗铬,得能拖 —— 但只认根元素**自己**:子元素(编辑器/按钮/信息面)各有各的
 * 手柄或本来就不该拖,`target === currentTarget` 一条判掉,不抢。
 */
function handleRootWindowDragStart(event: PointerEvent) {
  if (event.target !== event.currentTarget) return
  handleWindowDragStart(event)
}

function handleRootWindowDragDoubleClick(event: MouseEvent) {
  if (event.target !== event.currentTarget) return
  handleWindowDragDoubleClick(event)
}

function handleWindowDragDoubleClick(event: MouseEvent) {
  if (!isStandalone.value) return
  if (isWindowDragExcludedTarget(event.target as Element | null)) return
  zoomStandaloneWindow()
}

function shouldRefreshChanged(data: { scope: string; sessionId?: string }) {
  if (data.scope === 'global-user' || data.scope === 'all') return true
  if (data.scope === 'session-ai-todo') {
    return Boolean(resolvedSessionId.value) && data.sessionId === resolvedSessionId.value
  }
  return false
}

function handleViewportResize() {
  viewportWidth.value = window.innerWidth
}

onMounted(() => {
  loadSnapshot()
  syncAutoPush()
  if (isStandalone.value) {
    platformApi.setTodoPlanWindowPinned(pinned.value)
  }
  window.addEventListener('resize', handleViewportResize)
  cleanupChanged = platformApi.onTodoPlanChanged((data) => {
    if (!shouldRefreshChanged(data)) return
    if (data.document) {
      applyDocument(data.document)
    } else {
      loadSnapshot()
    }
  })
  window.addEventListener('keydown', handleShortcut)
  window.addEventListener('pointerdown', handleOutsidePointerDown, true)
  window.addEventListener('storage', handleModeStorage)
  // 真 mac 行为:窗失焦时交通灯整组褪灰。non-activating panel 拿不到系统的
  // main/key 状态,但 webContents 的 focus/blur 是真的 —— 用它当代理。
  window.addEventListener('focus', handleWindowFocusIn)
  window.addEventListener('blur', handleWindowFocusOut)
  if (!isStandalone.value) {
    window.addEventListener('todo-plan:toggle-card', toggleCollapsed)
  }
})

onUnmounted(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (justSentTimer) clearTimeout(justSentTimer)
  if (replyPollTimer) clearInterval(replyPollTimer)
  pushScheduler.dispose()
  window.removeEventListener('resize', handleViewportResize)
  cleanupChanged?.()
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  window.removeEventListener('storage', handleModeStorage)
  window.removeEventListener('focus', handleWindowFocusIn)
  window.removeEventListener('blur', handleWindowFocusOut)
  if (!isStandalone.value) {
    window.removeEventListener('todo-plan:toggle-card', toggleCollapsed)
  }
  window.removeEventListener('pointermove', handleResize)
  handleWindowDragEnd()
})
</script>

<style scoped>
/* ── G8 私有 token 岛判决:`--todo-*` **整族保留**,理由是量出来的 ─────────────
   这张面不是 panel 面,是一张**纸色卡**(elevated 92% 掺 8% 便签色)。而
   `--ui-state-*` 全族"一窗一值、以 panel 面解析成实色",两者在 18 主题 × 明暗双向
   实跑下差 Δ中位 20~24;更要命的是中性 hover 档相对这张卡面只有 Δ中位 5.0、
   **最小 1.0** —— 迁过去等于把 hover 迁没(波 3 立的"会把 hover 迁没就不迁"判例)。
   要真正并进 REGION_OVERLAY_STEPS,得先把这张卡面本身搬进主题层(给单一住户新立
   一个"纸色卡"区域档),那正是 G7-1 判 `.session-header` 不接时否掉的造分类。
   记为:等主题层出现第二张纸色卡面时再收。
   下面各枚的分类:几何/尺寸(nav-gutter / plan-width / popover-* / row-min-height)
   纯布局,永远保留;`--todo-rule*` 是边框浓度(主题层无边框档);`--todo-text/-muted/
   -accent` 是区域别名(sidebar 先例);`--todo-card-bg*` 是这张卡自己的纸色语言。 */
/* ── 边栏 v2 的两级面 ─────────────────────────────────────────────────────
   设计稿是"暖纸上垫一层更亮的纸",层级关系是:窗底(轨所在的那一层)取
   `--todo-card-bg-soft`(深一档的壳 = 退后),主区取 `--todo-card-bg`
   (亮纸本身 = 浮起)。两者都从 **`--paper-*`** 派生,不是 `--ui-surface-*`:
   这扇窗自己有一层纸面色板(`components/chat/todo-paper.css`),刻意不跟随应用
   主题的冷暖 —— 纸就是纸,深色主题下由那份文件底部的 `[data-theme='dark']` 块
   翻成"墨纸"(同一族暖色的暗面),"退后/浮起"的方向在那一面里自洽。
   色值只允许出现在 todo-paper.css 里,这里一律消费语义名。若这套观感将来要沉淀
   成一张正式的纸色主题,那是主题层的事(`packages/onething-runtime/src/themes/`),
   不是这个组件的事。 */
.todo-plan-panel {
  --todo-plan-nav-gutter: 52px;
  /* 两级面直接落纸面色板:主区 = 亮纸,窗底/轨 = 深一档的壳。 */
  --todo-card-bg: var(--paper-main);
  --todo-card-bg-soft: var(--paper-shell);
  --todo-rail-width: 60px;
  --todo-info-width: 194px;
  --todo-main-inset: 9px;
  --todo-rule: var(--paper-divider);
  --todo-rule-soft: color-mix(in srgb, var(--todo-rule) 58%, transparent);
  --todo-rule-strong: var(--paper-border);
  --todo-text: var(--paper-ink);
  --todo-muted: var(--paper-muted);
  /* 窗内的"主色"是暖橙(语汇侧);结构记号(进度/勾选/pills)单走橄榄,见
     各自的规则 —— 设计稿的两条 accent 不折成一条。 */
  --todo-accent: var(--paper-warm);
  /* `--todo-accent-soft`(accent 14%)于 G8 删除:全仓零消费者 —— 岛上唯一一枚
     真·死 token,删它零观感变化。同族的强调底今后引 `--ui-state-hover-accent-bg`。 */
  --todo-accent-border: color-mix(in srgb, var(--ui-accent-primary-fg) 36%, transparent);
  --todo-plan-width: 280px;
  --todo-popover-inline-inset: 12px;
  --todo-popover-top: clamp(58px, 12vh, 88px);
  --todo-popover-width: min(520px, calc(100% - (var(--todo-popover-inline-inset) * 2)));
  --todo-popover-radius: 14px;
  /* Ink-line style: floating layers separate with a 1px rule, not a shadow
     (the panel's overflow:hidden clipped large shadows anyway). */
  --todo-popover-shadow: none;
  /* `--todo-popover-bg` / `--todo-popover-search-bg` 搬到浮层自己身上了
     (components/chat/todo-popover.css,G8 私有 token 收编)—— 声明在祖先上的
     token,上游推不动。 */
  --todo-popover-search-height: 46px;
  --todo-popover-search-padding-x: 16px;
  --todo-popover-search-gap: 10px;
  --todo-popover-search-font-size: 15px;
  --todo-popover-list-padding: 8px;
  --todo-note-row-min-height: 52px;
  --todo-action-row-min-height: 52px;
  --todo-popover-content-height: 226px;
  --todo-popover-height: min(
    calc(var(--todo-popover-search-height) + var(--todo-popover-content-height)),
    calc(100% - var(--todo-popover-top) - 12px)
  );

  position: absolute;
  top: 40px;
  right: 12px;
  z-index: calc(var(--z-dropdown) + 2);
  width: min(var(--todo-plan-width), calc(100vw - var(--todo-plan-nav-gutter) - 18px));
  min-height: 220px;
  display: flex;
  align-items: stretch;
  border: 1px solid var(--todo-rule);
  border-radius: 22px;
  background: var(--todo-card-bg-soft);
  box-shadow: none;
  color: var(--todo-text);
  overflow: hidden;
}

/* ── 形态轨 ─────────────────────────────────────────────────────────────── */

.mode-rail {
  flex: 0 0 var(--todo-rail-width);
  width: var(--todo-rail-width);
  padding: 8px 0 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: transparent;
}

.rail-buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

/* 选中 = **浮起到主区那张面**(同一枚 token)+ 一圈 accent 描边环,不是涂一块主色底
   —— ui-system §2 禁的是 accent 当**背景**;描边环是选中语义的允许写法(与侧栏行的
   左缘墨线同一路数:另开一条通道,不去动面色)。前景照旧上主色。 */
.rail-button {
  --app-button-height: 40px;
  --app-button-tone: color-mix(in srgb, var(--todo-muted) 82%, transparent);
  --app-button-hover-fill: var(--ui-state-hover-bg);
  --app-button-hover-fg: var(--todo-text);

  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  color: color-mix(in srgb, var(--todo-muted) 82%, transparent);
  transition:
    background var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.rail-button:hover {
  color: var(--todo-text);
  background: var(--ui-state-hover-bg);
}

.rail-button.active,
.rail-button.active:hover {
  /* 选中前景随形态走(设计稿:Todo=橄榄深、草稿纸=暖橙深),缺省落暖橙。 */
  --rail-active-fg: var(--todo-accent);
  --app-button-tone: var(--rail-active-fg);
  --app-button-hover-fill: var(--todo-card-bg);
  --app-button-hover-fg: var(--rail-active-fg);

  color: var(--rail-active-fg);
  background: var(--todo-card-bg);
  /* 不画描边环(用户裁定):选中态只靠"浮起到主区面色 + 着色前景 + 一层薄影"。 */
  box-shadow: 0 1px 2px color-mix(in srgb, var(--todo-text) 8%, transparent);
}

.rail-button.rail-todo.active,
.rail-button.rail-todo.active:hover {
  --rail-active-fg: var(--paper-struct-deep, var(--todo-accent));
}

.rail-button.rail-scratch.active,
.rail-button.rail-scratch.active:hover {
  --rail-active-fg: var(--paper-warm-deep, var(--todo-accent));
}

.rail-button:focus-visible {
  outline: 2px solid var(--todo-accent-border);
  outline-offset: 2px;
}

/* 轨底的竖排小字:它是"你现在在哪一格"的落款,不是可点的东西。 */
.rail-label {
  margin-top: auto;
  color: color-mix(in srgb, var(--todo-muted) 62%, transparent);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  writing-mode: vertical-rl;
  user-select: none;
}

/* ── 主区(垫在窗底上的那张纸)───────────────────────────────────────────── */

.panel-main {
  flex: 1 1 auto;
  min-width: 0;
  margin: var(--todo-main-inset) var(--todo-main-inset) var(--todo-main-inset) 0;
  display: flex;
  align-items: stretch;
  border-radius: 9px;
  background: var(--todo-card-bg);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--todo-text) 6%, transparent);
  /* **不设 overflow: hidden** —— 笔记切换器 / 命令面板 / 查找条都住在这棵子树里
     并按面板宽度居中;裁掉它们就等于把三个浮层关进主区。 */
}

.panel-column {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ── 信息面 ─────────────────────────────────────────────────────────────── */

.info-panel {
  flex: 0 0 var(--todo-info-width);
  width: var(--todo-info-width);
  padding: 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-left: 1px solid var(--todo-rule-soft);
  overflow-y: auto;
  /* 读数面同样是铬:进度 / 状态 / 设置项的文案都不该被选中。 */
  user-select: none;
}

.info-title {
  color: var(--todo-muted);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.progress-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.progress-figure {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-family: var(--font-display);
  font-variant-numeric: tabular-nums;
}

.progress-figure b {
  color: var(--todo-text);
  font-size: 30px;
  font-weight: 650;
  line-height: 1;
}

.progress-figure span {
  color: var(--todo-muted);
  font-size: 14px;
  font-weight: 500;
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--paper-track, color-mix(in srgb, var(--todo-text) 8%, transparent));
  overflow: hidden;
}

/* 进度是**结构**,走橄榄(设计稿 accent-2-500),不跟暖橙。 */
.progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--paper-struct-mid, var(--todo-accent));
  transition: width var(--duration-normal) var(--ease-default);
}

.info-hint {
  margin: 0;
  color: var(--todo-muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.state-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: currentcolor;
}

.info-state {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* 「AI 读到第 N 段」:深暖橙字 + 亮暖橙点(设计稿 accent-800 / accent-500)。 */
.state-line {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--paper-warm-deep, var(--todo-accent));
  font-size: 12.5px;
  font-weight: 600;
}

.state-line .state-dot {
  background: var(--paper-warm, currentcolor);
}

.state-sub {
  padding-left: 12px;
  color: var(--todo-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.send-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.send-primary {
  --app-button-height: 30px;
  --app-button-tone: var(--ui-action-primary-fg);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-accent) 88%, var(--todo-text));
  --app-button-hover-fg: var(--ui-action-primary-fg);

  height: 30px;
  padding: 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--paper-main, var(--ui-action-primary-fg));
  background: var(--todo-accent);
  font-family: var(--font-display);
  font-size: 12.5px;
  font-weight: 600;
  transition: background var(--duration-fast) var(--ease-default);
}

.send-primary:hover {
  background: var(--paper-warm-hover, color-mix(in srgb, var(--todo-accent) 88%, var(--todo-text)));
}

.send-primary:disabled {
  background: color-mix(in srgb, var(--todo-text) 12%, transparent);
  color: var(--todo-muted);
  cursor: not-allowed;
}

.send-primary:focus-visible {
  outline: 2px solid var(--todo-accent-border);
  outline-offset: 2px;
}

.send-hint {
  color: color-mix(in srgb, var(--todo-muted) 78%, transparent);
  font-size: 11.5px;
  letter-spacing: 0.04em;
}

.info-divider {
  height: 1px;
  background: var(--todo-rule-soft);
}

.push-settings {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.push-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.push-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity var(--duration-fast) var(--ease-default);
}

/* 关掉的那一组:降透明 + `inert`(在模板上)。只降透明是**假禁用** ——
   点得动、还进 Tab 序列。 */
.push-field.is-off {
  opacity: 0.42;
}

.push-label {
  color: var(--todo-muted);
  font-size: 12px;
  font-weight: 500;
}

.push-field :deep(.segmented-pill-item) {
  height: 22px;
  padding: 0 9px;
  font-size: 11.5px;
}

.todo-plan-panel.collapsed {
  top: 74px;
  right: 0;
  width: 20px;
  height: 46px !important;
  min-height: 0;
  border: 0;
  border-radius: 999px 0 0 999px;
  background: transparent;
  box-shadow: none;
  overflow: visible;
}

.todo-plan-panel.standalone {
  width: 100%;
  min-height: 100%;
}

/* 卡片形态只有 280px 宽:轨与内缩全部收一档,头行也不摆窗标题栏的谱。
   它没有信息面(`showInfoPanel` 卡在 standalone 上),读数留在头行与页脚。 */
.todo-plan-panel:not(.standalone) {
  --todo-rail-width: 44px;
  --todo-main-inset: 6px;
}

.todo-plan-panel:not(.standalone) .mode-rail {
  padding: 8px 0 10px;
}

.todo-plan-panel:not(.standalone) .rail-button {
  --app-button-height: 32px;

  width: 32px;
  height: 32px;
  border-radius: 9px;
}

.todo-plan-panel:not(.standalone) .panel-header {
  padding: 12px 14px 6px;
}

.wake-button,
.icon-button,
.mini-button,
.note-option-main,
.note-option-actions button,
.format-toggle,
.format-command {
  --app-button-height: auto;
  --app-button-min-width: 0;
  --app-button-padding-x: 0;
  --app-button-gap: 0;
  --app-button-font-size: inherit;
  --app-button-tone: var(--todo-muted);
  --app-button-hover-fill: transparent;
  --app-button-hover-fg: var(--todo-text);
  --app-button-shadow: none;
  --app-button-hover-shadow: none;

  border: 0;
  color: var(--todo-muted);
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.wake-button :deep(.app-button-content),
.icon-button :deep(.app-button-content),
.mini-button :deep(.app-button-content),
.note-option-actions button :deep(.app-button-content),
.format-toggle :deep(.app-button-content),
.format-command :deep(.app-button-content) {
  justify-content: center;
}

.wake-button :deep(.app-button-label),
.icon-button :deep(.app-button-label),
.mini-button :deep(.app-button-label),
.note-option-actions button :deep(.app-button-label),
.format-toggle :deep(.app-button-label),
.format-command :deep(.app-button-label) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}

.wake-button {
  --app-button-tone: color-mix(in srgb, var(--todo-muted) 58%, transparent);
  --app-button-hover-fg: color-mix(in srgb, var(--todo-accent) 68%, var(--todo-muted) 32%);

  position: relative;
  width: 100%;
  height: 100%;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--todo-rule) 42%, transparent);
  border-right: 0;
  border-radius: 999px 0 0 999px;
  background: color-mix(in srgb, var(--todo-card-bg) 44%, transparent);
  box-shadow: 0 6px 14px color-mix(in srgb, var(--todo-text) 4%, transparent);
  color: color-mix(in srgb, var(--todo-muted) 58%, transparent);
  opacity: 0.34;
}

.wake-button::before {
  content: '';
  position: absolute;
  inset: -8px 0 -8px -8px;
  border-radius: 999px 0 0 999px;
}

.wake-button:hover {
  border-color: color-mix(in srgb, var(--todo-accent-border) 58%, transparent);
  background: color-mix(in srgb, var(--todo-card-bg) 64%, var(--todo-accent) 5%);
  color: color-mix(in srgb, var(--todo-accent) 68%, var(--todo-muted) 32%);
  opacity: 0.72;
}

/* 头行:左标题、右读数,读数之后才是几枚图标钮。三段一条基线,不再靠绝对定位
   把标题"摆到中间"—— 那套做法每加一枚钮就要重算一次左右内缩。 */
.panel-header {
  flex: 0 0 auto;
  padding: 22px 26px 8px;
  display: flex;
  align-items: baseline;
  gap: 12px;
  /* 头行是窗铬(标题/读数),不是内容 —— 静态禁选。这不只为了好看:拖窗兜底
     依赖 preload 的 IPC,宿主还没带上那条通道时(比如没重启的 dev),起拖被
     放弃,mousedown 就会落回文本选择,把「草稿纸 N 字」刷成蓝底。 */
  user-select: none;
}

/* 轨与头行是这扇窗的拖动区。**红绿灯下面那一格必须能拖** —— 它是无内容的空白,
   不给 drag 就成了一块死区。
   声明保留,但**当下真正在拖窗的不是它**:这扇窗是 non-activating NSPanel,原生
   drag region 那条路对它不生效(理由见 script 里那段)。同一批面上挂了 pointer 事件
   做手动兜底;哪天窗型变了,原生 drag 会先把 pointerdown 吃掉,手动那套自动让位。 */
.todo-plan-panel.standalone .mode-rail,
.todo-plan-panel.standalone .panel-header {
  -webkit-app-region: drag;
}

/* 手动拖窗期间禁选。写在 body 上而不是面板上:指针捕获会把 move 一路送到窗外,
   选区却是整份文档的事。`user-select` 会继承,一条就够。 */
:global(body.todo-window-dragging) {
  user-select: none;
}

/* 拖动区里的可点区必须逐个还回来 —— `no-drag` 只对 drag 分支上的子孙生效。 */
.todo-plan-panel.standalone .window-lights,
.todo-plan-panel.standalone .rail-button,
.todo-plan-panel.standalone .panel-actions,
.todo-plan-panel.standalone .note-switcher,
.todo-plan-panel.standalone .todo-notes-action-panel,
.todo-plan-panel.standalone .floating-find-bar,
.todo-plan-panel.standalone .panel-body {
  -webkit-app-region: no-drag;
}

.window-title {
  min-width: 0;
  margin: 0;
  flex: 0 0 auto;
  overflow: hidden;
  color: var(--todo-text);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.004em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 会话名:退后一档的小字,窄了先牺牲它(标题与读数不让)。 */
.header-session {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  color: color-mix(in srgb, var(--todo-muted) 88%, transparent);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-stat {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--todo-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 自绘红绿灯:竖排三枚 11px 圆点,轨内居中,gap 7px。系统那组已经被主进程收起
   (`setWindowButtonVisibility(false)`),这里不会叠出第二排。
   颜色走语义 status token —— 主题换色时三枚点跟着走,而不是钉死在 mac 的三个 hex 上。 */
.window-lights {
  display: none;
}

.todo-plan-panel.standalone .window-lights {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  /* 真 mac 的灯距是 8pt(横排如此,竖排沿用)。 */
  gap: 8px;
  padding-bottom: 6px;
}

/* 真 mac 规格:12px 满色圆 + 一圈极细深描边;hover 不变色,只浮符号;按下加深;
   窗失焦整组变灰(hover 又亮回来 —— 系统就是这么干的)。系统灯在 non-activating
   NSPanel 上永远是灰的,所以这三枚是自绘,但规格照抄系统。 */
.window-light {
  position: relative;
  width: 12px;
  height: 12px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--window-light-tone);
  box-shadow: inset 0 0 0 0.5px var(--paper-dot-rim, transparent);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default);
}

.window-light:active {
  background: color-mix(in srgb, var(--window-light-tone) 75%, var(--todo-text) 25%);
}

/* 窗失焦 = 整组褪成灰点(真 mac 行为);悬回这组时立刻恢复满色。 */
.todo-plan-panel.window-inactive .window-lights:not(:hover) .window-light {
  background: var(--paper-dot-inactive, color-mix(in srgb, var(--todo-text) 16%, transparent));
}

/* 符号:深一档的同族色(系统符号就是各自颜色的暗面),组悬停才现身。
   杆与三角都是画出来的,不用字形 —— 任何字体/主题下都不走样。 */
.window-light::before,
.window-light::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 6px;
  height: 1.3px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--window-light-tone) 30%, var(--todo-text) 70%);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.window-lights:hover .window-light::before,
.window-lights:hover .window-light::after,
.window-lights:focus-within .window-light::before,
.window-lights:focus-within .window-light::after {
  opacity: 1;
}

/* 关闭 = ×;最小化 = −;缩放 = 两枚对角三角(系统绿点的全屏符号 —— 这枚点的
   动作是贴满/还原,语义相邻,认知上跟系统一致比字面精确更重要)。 */
.window-light.close::before {
  transform: translate(-50%, -50%) rotate(45deg);
}

.window-light.close::after {
  transform: translate(-50%, -50%) rotate(-45deg);
}

.window-light.minimize::before {
  transform: translate(-50%, -50%);
}

.window-light.minimize::after {
  content: none;
}

.window-light.zoom::before,
.window-light.zoom::after {
  width: 4.5px;
  height: 4.5px;
  border-radius: 0.5px;
}

.window-light.zoom::before {
  transform: translate(-100%, -100%) translate(1px, 1px);
  clip-path: polygon(0 0, 100% 0, 0 100%);
}

.window-light.zoom::after {
  transform: translate(0, 0) translate(-1px, -1px);
  clip-path: polygon(100% 100%, 0 100%, 100% 0);
}

.window-light:focus-visible {
  outline: 2px solid var(--todo-accent-border);
  outline-offset: 2px;
}

.window-light.close {
  --window-light-tone: var(--paper-dot-close, var(--ui-status-danger-fg));
}

.window-light.minimize {
  --window-light-tone: var(--paper-dot-min, var(--ui-status-warning-fg));
}

.window-light.zoom {
  --window-light-tone: var(--paper-dot-zoom, var(--ui-status-success-fg));
}

.note-option:hover {
  color: var(--todo-text);
  background: var(--ui-state-hover-bg);
}

.panel-actions {
  display: flex;
  flex: 0 0 auto;
  align-self: center;
  gap: 4px;
}

.icon-button {
  --app-button-height: 22px;
  --app-button-tone: color-mix(in srgb, var(--todo-text) 66%, transparent);

  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: color-mix(in srgb, var(--todo-text) 66%, transparent);
}

.mini-button {
  --app-button-height: 24px;
  --app-button-tone: color-mix(in srgb, var(--todo-text) 66%, transparent);

  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: color-mix(in srgb, var(--todo-text) 66%, transparent);
}

.icon-button:hover,
.icon-button.active:hover,
.mini-button:hover {
  --app-button-tone: var(--todo-text);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-text) 10%, transparent);

  color: var(--todo-text);
  background: color-mix(in srgb, var(--todo-text) 10%, transparent);
}

.icon-button.active {
  --app-button-tone: color-mix(in srgb, var(--todo-text) 66%, transparent);

  color: color-mix(in srgb, var(--todo-text) 66%, transparent);
  background: transparent;
}

.icon-button:focus-visible,
.mini-button:focus-visible,
.note-option:focus-visible {
  outline: 2px solid var(--todo-accent-border);
  outline-offset: 2px;
}

.floating-find-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--todo-muted);
  background: var(--todo-card-bg-soft);
}

.floating-find-bar input {
  min-width: 0;
  flex: 1;
  height: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--todo-text);
  font: inherit;
  line-height: inherit;
}

.floating-find-bar input::placeholder {
  color: var(--todo-muted);
  opacity: 0.68;
}

.switcher-header-row {
  height: 28px;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: color-mix(in srgb, var(--todo-text) 72%, transparent);
  font-size: 13px;
  font-weight: 700;
}

.switcher-header-row span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: color-mix(in srgb, var(--todo-text) 66%, transparent);
  font-weight: 650;
}

.switcher-label {
  padding: 8px 2px 5px;
  color: var(--todo-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.note-option {
  width: 100%;
  min-height: var(--todo-note-row-min-height);
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  border-radius: 12px;
  text-align: left;
}

.note-option.active,
.note-option.selected {
  color: var(--todo-text);
  background: color-mix(in srgb, var(--todo-text) 9%, transparent);
}

.note-option.selected {
  background: color-mix(in srgb, var(--todo-text) 12%, transparent);
}

.note-option.system {
  color: color-mix(in srgb, var(--todo-text) 90%, var(--todo-accent) 10%);
}

.note-option-main {
  --app-button-height: 100%;
  --app-button-tone: inherit;
  --app-button-hover-fill: transparent;

  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  border-radius: inherit;
  text-align: left;
}

.note-option-main :deep(.app-button-content),
.note-option-main :deep(.app-button-label) {
  display: contents;
}

.note-option-main:hover {
  color: var(--todo-text);
  background: transparent;
}

.note-option strong,
.note-option small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-option strong {
  color: inherit;
  font-size: 14px;
  font-weight: 700;
}

.note-option small {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--todo-muted);
  font-size: 12px;
  font-style: normal;
}

.note-option small i {
  width: 7px;
  height: 7px;
  display: inline-block;
  border-radius: 999px;
  background: color-mix(in srgb, var(--todo-muted) 52%, transparent);
}

.note-option small i.current {
  background: var(--ui-status-danger-fg, var(--color-danger));
}

.note-option small b {
  color: color-mix(in srgb, var(--todo-muted) 62%, transparent);
  font-weight: 500;
}

.note-option-actions {
  padding-right: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--todo-muted);
}

.note-option-actions button {
  --app-button-height: 24px;
  --app-button-tone: var(--todo-muted);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-text) 11%, transparent);

  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}

/* 窄窗:轨收一档、头行内缩跟着收。信息面在这个宽度下已经由 `showInfoPanel`
   撤走了(JS 判据与这里的断点是同一个数,见 INFO_PANEL_MIN_WIDTH)。 */
@media (max-width: 460px) {
  .todo-plan-panel.standalone {
    --todo-rail-width: 48px;
    --todo-main-inset: 6px;
  }

  .todo-plan-panel.standalone .panel-header {
    padding: 18px 16px 6px;
  }

  .todo-plan-panel.standalone .window-title {
    font-size: 13px;
  }

  .todo-plan-panel.standalone .rail-button {
    --app-button-height: 34px;

    width: 34px;
    height: 34px;
  }
}

@container (max-width: 240px) {
  .switcher-header-row {
    height: 30px;
    font-size: 13px;
  }

  .note-option {
    min-height: 50px;
    grid-template-columns: minmax(0, 1fr);
  }

  .note-option small {
    max-width: 100%;
  }

  .note-option-actions {
    display: none;
  }
}

.note-option-actions button.active {
  --app-button-tone: var(--todo-text);

  color: var(--todo-text);
  background: color-mix(in srgb, var(--todo-text) 11%, transparent);
}

.floating-find-bar {
  position: absolute;
  top: 58px;
  right: 14px;
  z-index: 4;
  width: min(340px, calc(100% - 28px));
  height: 40px;
  padding: 0 8px 0 12px;
  border: 1px solid var(--todo-rule-strong);
  border-radius: 11px;
  box-shadow: none;
  font-size: 14px;
  line-height: 1;
}

.floating-find-bar span {
  flex: 0 0 auto;
  min-width: 40px;
  color: var(--todo-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

/* 文档区吃掉剩下的全部高度。`min-height: 0` 是 flex 列里滚动区能滚的前提 ——
   缺了它子元素的 `overflow-y: auto` 会被内容撑成"不滚,只是变高"。 */
.panel-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: transparent;
}

/* 选区浮条:反色小条,浮在文档区顶部中线。局部层级(个位数,不进层级表)——
   它只需要压住同一张纸上的正文。 */
.selection-floater {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: var(--z-sticky);
  padding: 5px 6px 5px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 8px;
  color: var(--todo-card-bg);
  background: color-mix(in srgb, var(--todo-text) 88%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--todo-text) 18%, transparent);
  font-size: 12px;
  transform: translateX(-50%);
}

.selection-count {
  color: color-mix(in srgb, var(--todo-card-bg) 80%, transparent);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.selection-send {
  --app-button-height: 22px;
  --app-button-tone: var(--ui-action-primary-fg);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-accent) 86%, var(--todo-card-bg));
  --app-button-hover-fg: var(--ui-action-primary-fg);

  height: 22px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  color: var(--ui-action-primary-fg);
  background: var(--todo-accent);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.selection-send:hover {
  background: color-mix(in srgb, var(--todo-accent) 86%, var(--todo-card-bg));
}

.note-footer {
  flex: 0 0 auto;
  height: 38px;
  padding: 0 18px;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  border-top: 1px solid var(--todo-rule-soft);
  color: color-mix(in srgb, var(--todo-muted) 72%, transparent);
  background: color-mix(in srgb, var(--todo-card-bg) 88%, transparent);
  font-size: 13px;
  font-weight: 600;
}

.note-footer.formatting {
  padding: 0 8px;
  display: flex;
  justify-content: stretch;
}

.note-footer span {
  text-align: center;
}

/* 水位文案:说的是"AI 读到哪儿了",是一句状态而不是一个操作 —— 用强调色的
   弱档说话,别抢字数那一格的位置。 */
.pad-watermark {
  justify-self: end;
  color: var(--ui-accent-subtle-fg);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.format-toggle {
  --app-button-height: 30px;
  --app-button-tone: color-mix(in srgb, var(--todo-text) 72%, transparent);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-text) 9%, transparent);

  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--todo-text) 72%, transparent);
}

.format-toggle:hover,
.format-toggle:focus-visible {
  color: var(--todo-text);
  background: color-mix(in srgb, var(--todo-text) 9%, transparent);
  outline: none;
}

.format-buffer {
  min-width: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
  scrollbar-width: none;
}

.format-buffer::-webkit-scrollbar {
  display: none;
}

.format-command {
  --app-button-height: 30px;
  --app-button-tone: color-mix(in srgb, var(--todo-text) 72%, transparent);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-text) 9%, transparent);

  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border-radius: 7px;
  color: color-mix(in srgb, var(--todo-text) 72%, transparent);
}

.format-command:hover,
.format-command:focus-visible {
  color: var(--todo-text);
  background: color-mix(in srgb, var(--todo-text) 9%, transparent);
  outline: none;
}

.heading-command {
  width: 42px;
  font-size: 22px;
  font-weight: 750;
  letter-spacing: 0;
}

.format-separator {
  width: 1px;
  height: 28px;
  flex: 0 0 auto;
  margin: 0 8px 0 auto;
  background: var(--todo-rule);
}

.close-format {
  --app-button-tone: var(--todo-card-bg);
  --app-button-hover-fg: var(--todo-card-bg);
  --app-button-hover-fill: color-mix(in srgb, var(--todo-text) 72%, transparent);

  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: var(--todo-card-bg);
  background: color-mix(in srgb, var(--todo-text) 58%, transparent);
}

.close-format:hover,
.close-format:focus-visible {
  color: var(--todo-card-bg);
  background: color-mix(in srgb, var(--todo-text) 72%, transparent);
}

.resize-handle {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 8px;
  cursor: ns-resize;
}

@media (max-width: 720px) {
  .todo-plan-panel {
    right: 8px;
    top: 46px;
    width: min(340px, calc(100vw - 16px));
  }

  .todo-plan-panel.collapsed {
    right: 0;
  }
}

@media (max-width: 520px) {
  .todo-plan-panel {
    left: auto;
    right: 6px;
    width: min(340px, calc(100vw - 12px));
  }

  .panel-actions {
    gap: 2px;
  }
}
</style>
