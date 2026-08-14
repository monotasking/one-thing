<template>
  <section
    ref="panelRef"
    class="todo-plan-panel"
    :class="{
      pinned,
      collapsed,
      standalone: isStandalone,
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
      <header class="panel-header">
        <div
          v-if="isStandalone"
          class="window-traffic-spacer"
          aria-hidden="true"
        />

        <div class="window-title">
          {{ displayTitle }}
        </div>

        <div class="panel-actions">
          <Tooltip text="Command Panel">
            <Button
              text
              class="icon-button"
              native-type="button"
              aria-label="Command Panel"
              @mousedown.prevent
              @click.stop="openActionPanel"
            >
              <Command :size="14" />
            </Button>
          </Tooltip>
          <Tooltip text="Browse notes">
            <Button
              ref="titleButtonRef"
              text
              class="icon-button"
              native-type="button"
              aria-label="Browse notes"
              @mousedown.prevent
              @click.stop="openSwitcher"
            >
              <FileText :size="14" />
            </Button>
          </Tooltip>
          <Tooltip text="New note">
            <Button
              text
              class="icon-button"
              native-type="button"
              aria-label="New note"
              @mousedown.prevent
              @click.stop="createNote"
            >
              <Plus :size="14" />
            </Button>
          </Tooltip>
          <Tooltip :text="pinControlLabel">
            <Button
              text
              class="icon-button"
              :class="{ active: pinned }"
              native-type="button"
              :aria-label="pinControlLabel"
              @mousedown.prevent
              @click.stop="togglePinned"
            >
              <Pin :size="14" />
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
      >
        <component
          :is="noteEditorComponent"
          ref="editorRef"
          :model-value="draft"
          surface="todo-notes"
          :document-id="activeDocument?.id || 'todo-notes'"
          :document-path="activeDocument?.filePath || ''"
          :workspace-root="snapshot?.directory || effectiveWorkingDirectory || ''"
          :settings="editorSettings"
          :features="todoMarkdownFeatures"
          :toolbar="false"
          placeholder="# Untitled Note"
          :spellcheck="true"
          :source-toggle="false"
          @update:model-value="handleDraftUpdate"
          @keydown="handleEditorKeydown"
          @paste="handleMarkdownPaste"
          @open-link="openMarkdownLink"
          @open-image="openMarkdownImage"
          @cancel="handleEscape"
        />
      </div>

      <footer
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
          <Tooltip text="Show formatting bar">
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Bot,
  Bold,
  ChevronDown,
  ChevronUp,
  Code2,
  Command,
  Copy,
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
import { useSettingsStore } from '@/stores/settings'
import { copyTextToClipboard } from '@/utils/clipboard'
import type { TodoPlanDocument, TodoPlanSnapshot } from '@/types'
import MarkdownDocumentEditor from '@/editor/MarkdownDocumentEditor.vue'
import ProseNoteEditor from '@/editor/prose/ProseNoteEditor.vue'
import type { MarkdownCommand, MarkdownDocumentEditorHandle, MarkdownFeatureSet } from '@/editor/markdown-document'
import { handleMarkdownAttachmentPaste } from '@/editor/markdown-attachments'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import TodoNotesActionPanel from './TodoNotesActionPanel.vue'
import {
  findMarkdownMatches,
  titleFromMarkdown,
} from './todo-plan-utils'
import type {
  TodoNotesAction,
  TodoNotesActionContext,
} from './todo-notes-actions'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'

const props = defineProps<{
  sessionId?: string
  workingDirectory?: string
  standalone?: boolean
}>()

const sessionsStore = useSessionsStore()
const settingsStore = useSettingsStore()
const storagePrefix = props.standalone ? 'todoPlanWindow' : 'todoPlanCard'
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
const editorRef = ref<MarkdownDocumentEditorHandle | null>(null)
let cleanupChanged: (() => void) | undefined
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
const editorSettings = computed(() => settingsStore.settings.general.editor)
// Render-first (ProseMirror) engine behind a settings flag; CodeMirror stays
// the default and the fallback. Both implement MarkdownDocumentEditorHandle.
const noteEditorComponent = computed(() =>
  editorSettings.value?.noteEngine === 'prosemirror' ? ProseNoteEditor : MarkdownDocumentEditor,
)

const isStandalone = computed(() => props.standalone === true)
const panelStyle = computed(() => {
  if (collapsed.value || isStandalone.value) return {}
  return { height: `${panelHeight.value}px` }
})
const popoverOpen = computed(() => switcherOpen.value || actionPanelOpen.value || findOpen.value)
const effectiveSessionId = computed(() => props.sessionId || sessionsStore.currentSessionId || undefined)
// Standalone runs in its own window, where the sessions store is never
// populated, so the session is whatever the host resolved the snapshot to.
const resolvedSessionId = computed(() => effectiveSessionId.value || snapshot.value?.sessionId || undefined)
const effectiveWorkingDirectory = computed(() => {
  if (props.workingDirectory !== undefined) return props.workingDirectory || undefined
  const session = sessionsStore.sessions.find(item => item.id === resolvedSessionId.value)
  return session?.workingDirectory || undefined
})
const allDocuments = computed(() => {
  if (!snapshot.value) return []
  return [
    ...snapshot.value.userNotes,
    ...(snapshot.value.sessionAiTodo ? [snapshot.value.sessionAiTodo] : []),
  ]
})
const activeDocument = computed(() => allDocuments.value.find(doc => doc.id === activeId.value) || allDocuments.value[0])
const displayTitle = computed(() => titleFromMarkdown(draft.value, activeDocument.value?.title || 'Todo / Notes'))
const pinControlLabel = computed(() => pinned.value ? 'Unpin Todo' : 'Pin Todo')
const noteCountLabel = computed(() => {
  const count = snapshot.value?.userNotes.length || 0
  const label = count === 1 ? 'Note' : 'Notes'
  return `${count} ${label}`
})
const characterCountLabel = computed(() => `${draft.value.length} characters`)
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
const findMatches = computed(() => findMarkdownMatches(draft.value, findQuery.value))
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

function handleDraftUpdate(value: string) {
  draft.value = value
  scheduleSave()
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
    console.warn('[TodoPlanPanel] Failed to copy markdown')
  }
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
  await handleMarkdownAttachmentPaste({
    event,
    editor: editorRef.value,
    documentPath: activeDocument.value?.filePath,
    workspaceRoot: snapshot.value?.directory || effectiveWorkingDirectory.value,
  })
}

async function resolveMarkdownLink(href: string, asset?: MarkdownAssetResolution | null) {
  if (asset) return asset
  const documentPath = activeDocument.value?.filePath
  if (!documentPath) return null
  const response = await markdownApi.resolveAsset({
    documentPath,
    workspaceRoot: snapshot.value?.directory || effectiveWorkingDirectory.value,
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

function shouldRefreshChanged(data: { scope: string; sessionId?: string }) {
  if (data.scope === 'global-user' || data.scope === 'all') return true
  if (data.scope === 'session-ai-todo') {
    return Boolean(resolvedSessionId.value) && data.sessionId === resolvedSessionId.value
  }
  return false
}

onMounted(() => {
  loadSnapshot()
  if (isStandalone.value) {
    platformApi.setTodoPlanWindowPinned(pinned.value)
  }
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
  if (!isStandalone.value) {
    window.addEventListener('todo-plan:toggle-card', toggleCollapsed)
  }
})

onUnmounted(() => {
  if (saveTimer) clearTimeout(saveTimer)
  cleanupChanged?.()
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  if (!isStandalone.value) {
    window.removeEventListener('todo-plan:toggle-card', toggleCollapsed)
  }
  window.removeEventListener('pointermove', handleResize)
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
.todo-plan-panel {
  --todo-plan-nav-gutter: 52px;
  --todo-card-bg: color-mix(in srgb, var(--ui-surface-elevated-bg) 92%, var(--ui-surface-note-bg, var(--color-warning-bg)) 8%);
  --todo-card-bg-soft: color-mix(in srgb, var(--todo-card-bg) 86%, var(--ui-surface-app-bg) 14%);
  --todo-rule: var(--ui-border-default-border);
  --todo-rule-soft: color-mix(in srgb, var(--todo-rule) 58%, transparent);
  --todo-rule-strong: var(--ui-border-strong-border);
  --todo-text: var(--ui-text-primary-fg);
  --todo-muted: var(--ui-text-muted-fg);
  --todo-accent: var(--ui-accent-primary-fg);
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
  border: 1px solid var(--todo-rule);
  border-radius: 22px;
  background: var(--todo-card-bg);
  box-shadow: none;
  color: var(--todo-text);
  overflow: hidden;
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

.panel-header {
  position: relative;
  height: 30px;
  padding: 0 10px 0 0;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 0;
  background: color-mix(in srgb, var(--todo-card-bg) 84%, transparent);
}

.todo-plan-panel.standalone .panel-header {
  -webkit-app-region: drag;
}

.todo-plan-panel.standalone .panel-actions,
.todo-plan-panel.standalone .note-switcher,
.todo-plan-panel.standalone .todo-notes-action-panel,
.todo-plan-panel.standalone .floating-find-bar,
.todo-plan-panel.standalone .panel-body {
  -webkit-app-region: no-drag;
}

.window-title {
  position: absolute;
  left: 108px;
  right: 108px;
  width: auto;
  min-width: 0;
  overflow: hidden;
  color: color-mix(in srgb, var(--todo-text) 72%, transparent);
  font-size: 14px;
  font-weight: 650;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.window-traffic-spacer {
  display: none;
}

.todo-plan-panel.standalone .window-traffic-spacer {
  display: block;
  flex: 0 0 82px;
  height: 100%;
  pointer-events: none;
}

.note-option:hover {
  color: var(--todo-text);
  background: var(--ui-state-hover-bg);
}

.panel-actions {
  margin-left: auto;
  display: flex;
  flex: 0 0 auto;
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

@media (max-width: 460px) {
  .todo-plan-panel.standalone .window-traffic-spacer {
    flex-basis: 76px;
  }

  .todo-plan-panel.standalone .window-title {
    left: 96px;
    right: 96px;
    font-size: 13px;
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

.panel-body {
  height: calc(100% - 68px);
  min-height: 120px;
  overflow: hidden;
  background: var(--todo-card-bg);
}

.note-footer {
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
