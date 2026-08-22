<template>
  <div class="search-window">
    <div class="search-input-row">
      <Search
        :size="15"
        class="search-icon"
      />
      <span
        v-if="splitIntent"
        class="intent-chip"
      >Split</span>
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="search-input"
        :placeholder="splitIntent ? 'Split with chat...' : inputPlaceholder"
        spellcheck="false"
        @keydown="onInputKeydown"
        @compositionstart="onInputCompositionStart"
        @compositionend="onInputCompositionEnd"
      >
      <div
        :class="['scope-tabs', { 'has-active-scope': activeTab !== 'all' }]"
        role="toolbar"
        aria-label="Search filters"
      >
        <Button
          v-for="(tab, index) in tabs"
          :key="tab.id"
          unstyled
          :class="[
            'scope-tab',
            {
              active: activeTab === tab.id,
              'default-scope': tab.id === 'all',
            },
          ]"
          native-type="button"
          :aria-pressed="activeTab === tab.id"
          :aria-keyshortcuts="`Meta+${index + 1}`"
          @click="activeTab = tab.id"
        >
          <span>{{ tab.label }}</span>
          <kbd>{{ index + 1 }}</kbd>
        </Button>
      </div>
    </div>

    <!-- Results -->
    <div
      ref="resultsRef"
      class="search-results"
    >
      <template v-if="visibleResults.length > 0">
        <SearchResultItem
          v-for="(item, index) in visibleResults"
          :key="item.id"
          :result="item"
          :selected="index === selectedIndex"
          :show-kind="activeTab === 'all'"
          @select="confirmResult(item)"
          @hover="selectedIndex = index"
        />
      </template>
      <div
        v-else-if="isLoading"
        class="search-state"
      >
        Searching...
      </div>
      <div
        v-else-if="searchError"
        class="search-state error"
      >
        {{ searchError }}
      </div>
      <div
        v-else
        class="search-state"
      >
        {{ emptyText }}
      </div>
    </div>

    <Dialog
      :open="showPromptCreate"
      aria-label="Create Prompt"
      :width="500"
      :dividers="false"
      :auto-focus="false"
      :style="promptDialogVars"
      @update:open="value => { if (!value) closePromptCreate() }"
    >
      <form
        class="prompt-dialog"
        @submit.prevent="createPromptFromDialog"
      >
        <header class="prompt-dialog-header">
          <h2>Create Prompt</h2>
          <Button
            unstyled
            native-type="button"
            class="prompt-dialog-close"
            @click="closePromptCreate"
          >
            ×
          </Button>
        </header>
        <label>
          <span>Name</span>
          <input
            ref="promptTitleRef"
            v-model="promptForm.title"
            type="text"
            autofocus
          >
        </label>
        <label>
          <span>Description</span>
          <input
            v-model="promptForm.description"
            type="text"
          >
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            v-model="promptForm.body"
            rows="7"
          />
        </label>
        <ErrorNote
          v-if="promptFormError"
          class="prompt-dialog-error"
          :message="promptFormError"
        />
        <footer>
          <Button
            unstyled
            native-type="button"
            class="secondary"
            @click="closePromptCreate"
          >
            Cancel
          </Button>
          <Button
            unstyled
            native-type="submit"
          >
            Save
          </Button>
        </footer>
      </form>
    </Dialog>

    <div
      v-if="dragGuides.visible"
      :class="[
        'drag-guides',
        {
          'is-center-x': dragGuides.centerX,
          'is-default-top': dragGuides.defaultTop,
          'is-default-height': dragGuides.defaultHeight,
          'is-default-bounds': dragGuides.defaultBounds,
        },
      ]"
      aria-hidden="true"
    >
      <span class="guide-line guide-center-x" />
      <span class="guide-line guide-default-top" />
      <span class="guide-line guide-default-height" />
    </div>
    <div
      class="resize-grip"
      aria-hidden="true"
    />
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Dialog from '@/components/common/Dialog.vue'
import ErrorNote from '@/components/common/ErrorNote.vue'
import { nextTick, onMounted, onUnmounted, ref, type CSSProperties } from 'vue'
import { Search } from 'lucide-vue-next'
import { useThemeStore } from '@/stores/themes'
import SearchResultItem from './SearchResultItem.vue'
import { resolveSearchResultAction } from './result-actions'
import { useSearchWindow } from './useSearchWindow'
import type {
  SearchResult,
  SearchWindowGuideState,
  SearchWindowShownPayload,
  SearchWindowSplitIntent,
} from '@shared/ipc/search'
import { platformApi } from '@/platform'
import { searchWindowApi } from '@/platform/search-window-client'

const HIDDEN_GUIDES: SearchWindowGuideState = {
  visible: false,
  centerX: false,
  defaultTop: false,
  defaultHeight: false,
  defaultBounds: false,
}

const inputRef = ref<HTMLInputElement | null>(null)
const resultsRef = ref<HTMLElement | null>(null)
/**
 * The sheet keeps its own compact frame; only the mechanics (teleport, fixed
 * positioning, --z-modal, Esc, focus) move to Dialog. `autoFocus` is off because
 * this dialog wants the title field, not the first focusable (the close button).
 */
const promptDialogVars: CSSProperties = {
  '--app-dialog-overlay-bg': 'color-mix(in srgb, var(--ui-surface-app-bg) 66%, transparent)',
  '--app-dialog-radius': '10px',
  '--app-dialog-bg': 'color-mix(in srgb, var(--ui-surface-panel-bg) 94%, var(--ui-surface-app-bg) 6%)',
  '--app-dialog-border': 'color-mix(in srgb, var(--ui-border-default-border) 68%, transparent)',
  '--app-dialog-shadow': 'var(--ui-surface-popover-shadow, var(--shadow-md))',
  '--app-dialog-padding': '12px',
  '--app-dialog-body-padding': '0',
} as CSSProperties

const promptTitleRef = ref<HTMLInputElement | null>(null)
const showPromptCreate = ref(false)
const promptForm = ref({ title: '', description: '', body: '' })
const promptFormError = ref('')
const dragGuides = ref<SearchWindowGuideState>(HIDDEN_GUIDES)
const isInputComposing = ref(false)
// Present while the window was opened from a panel's split button: confirming
// a chat splits that panel instead of switching the main session.
const splitIntent = ref<SearchWindowSplitIntent | null>(null)

const COMPOSITION_ENTER_SUPPRESS_MS = 80

const {
  settingsStore,
  tabs,
  activeTab,
  query,
  selectedIndex,
  isLoading,
  searchError,
  visibleResults,
  inputPlaceholder,
  emptyText,
  moveSelection,
  cycleTab,
  selectTabByShortcut,
  confirmSelectedResult,
  doSearch,
  resetSearchWindow,
} = useSearchWindow(resultsRef)

let unsubscribeShown: (() => void) | null = null
let unsubscribeGuides: (() => void) | null = null
let lastCompositionEndAt: number | null = null

function closeWindow() {
  void searchWindowApi.close({})
}

function onInputKeydown(event: KeyboardEvent) {
  if (isComposingKeydown(event)) return

  if ((event.metaKey || event.ctrlKey) && selectTabByShortcut(event.key)) {
    event.preventDefault()
    return
  }

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveSelection(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveSelection(-1)
      break
    case 'Enter':
      event.preventDefault()
      confirmSelected()
      break
    case 'Escape':
      event.preventDefault()
      if (showPromptCreate.value) closePromptCreate()
      else closeWindow()
      break
    case 'Tab':
      event.preventDefault()
      cycleTab(event.shiftKey ? -1 : 1)
      break
    case '/':
      if (!query.value && activeTab.value !== 'actions') activeTab.value = 'actions'
      break
  }
}

function isComposingKeydown(event: KeyboardEvent) {
  if (isInputComposing.value || event.isComposing || event.keyCode === 229) return true
  return event.key === 'Enter' &&
    lastCompositionEndAt !== null &&
    Date.now() - lastCompositionEndAt < COMPOSITION_ENTER_SUPPRESS_MS
}

function onInputCompositionStart() {
  isInputComposing.value = true
}

function onInputCompositionEnd() {
  isInputComposing.value = false
  lastCompositionEndAt = Date.now()
}

function confirmSelected() {
  const item = confirmSelectedResult()
  if (item) confirmResult(item)
}

function confirmResult(item: SearchResult) {
  const action = resolveSearchResultAction(item)
  if (!action) return

  if (action.type === 'create-prompt') {
    openPromptCreate(action.title)
    return
  }

  if (splitIntent.value && action.actionId.startsWith('switch-session:')) {
    const sessionId = action.actionId.slice('switch-session:'.length)
    void searchWindowApi.executeAction({ actionId: `split-panel:${splitIntent.value.panelId}:${sessionId}` })
    return
  }

  void searchWindowApi.executeAction({ actionId: action.actionId })
}

function openPromptCreate(title: string) {
  promptForm.value = { title, description: '', body: '' }
  promptFormError.value = ''
  showPromptCreate.value = true
  nextTick(() => promptTitleRef.value?.focus())
}

function closePromptCreate() {
  showPromptCreate.value = false
  promptFormError.value = ''
  nextTick(() => inputRef.value?.focus())
}

async function createPromptFromDialog() {
  const title = promptForm.value.title.trim()
  const body = promptForm.value.body.trim()
  if (!title) {
    promptFormError.value = 'Name is required'
    return
  }
  if (!body) {
    promptFormError.value = 'Prompt is required'
    return
  }

  const response = await platformApi.createPrompt({
    title,
    body,
    description: promptForm.value.description.trim() || undefined,
  })
  if (!response.success || !response.prompt) {
    promptFormError.value = response.error || 'Failed to create prompt'
    return
  }

  showPromptCreate.value = false
  void searchWindowApi.executeAction({ actionId: `insert-prompt:${response.prompt.id}` })
}

let lastShiftUp = 0
let shiftClean = false

function onGlobalKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (showPromptCreate.value) closePromptCreate()
    else closeWindow()
    return
  }

  shiftClean = event.key === 'Shift' && !event.ctrlKey && !event.altKey && !event.metaKey
}

function onGlobalKeyUp(event: KeyboardEvent) {
  if (event.key !== 'Shift' || !shiftClean) {
    shiftClean = false
    return
  }

  const now = Date.now()
  if (now - lastShiftUp < 300) {
    lastShiftUp = 0
    closeWindow()
  } else {
    lastShiftUp = now
  }
  shiftClean = false
}

onMounted(async () => {
  const themeStore = useThemeStore()
  await settingsStore.loadSettings()
  await themeStore.initialize()

  inputRef.value?.focus()
  void doSearch()
  unsubscribeShown = platformApi.onSearchWindowShown?.((payload?: SearchWindowShownPayload | null) => {
    splitIntent.value = payload?.intent?.type === 'split-panel' ? payload.intent : null
    resetSearchWindow()
    // Set after reset so the watcher's isResetting guard swallows the tab
    // change and the initial query runs once against the right category.
    if (splitIntent.value) activeTab.value = 'chats'
    nextTick(() => inputRef.value?.focus())
  }) ?? null
  unsubscribeGuides = platformApi.onSearchWindowGuides?.((state) => {
    dragGuides.value = state
  }) ?? null
  window.addEventListener('keydown', onGlobalKeyDown, true)
  window.addEventListener('keyup', onGlobalKeyUp, true)
})

onUnmounted(() => {
  unsubscribeShown?.()
  unsubscribeGuides?.()
  window.removeEventListener('keydown', onGlobalKeyDown, true)
  window.removeEventListener('keyup', onGlobalKeyUp, true)
})
</script>

<style scoped>
.search-window {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--ui-surface-app-bg);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 0 0 0.5px var(--ui-border-default-border);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
  user-select: none;
}

.drag-guides {
  position: absolute;
  inset: 5px;
  pointer-events: none;
  z-index: 9;
  border: 1px dashed color-mix(in srgb, var(--ui-accent-primary-fg) 34%, transparent);
  border-radius: 9px;
  opacity: 0.86;
}

.drag-guides.is-default-bounds {
  border-color: color-mix(in srgb, var(--ui-accent-primary-fg) 62%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-accent-primary-fg) 12%, transparent);
}

.guide-line {
  position: absolute;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-default);
}

.guide-center-x {
  top: 0;
  bottom: 0;
  left: 50%;
  border-left: 1px dashed color-mix(in srgb, var(--ui-accent-primary-fg) 54%, transparent);
}

.guide-default-top,
.guide-default-height {
  left: 10px;
  right: 10px;
  border-top: 1px dashed color-mix(in srgb, var(--ui-accent-primary-fg) 48%, transparent);
}

.guide-default-top {
  top: 7px;
}

.guide-default-height {
  bottom: 7px;
}

.drag-guides.is-center-x .guide-center-x,
.drag-guides.is-default-top .guide-default-top,
.drag-guides.is-default-height .guide-default-height {
  opacity: 1;
}

.resize-grip {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 14px;
  height: 14px;
  pointer-events: none;
  z-index: 8;
  opacity: 0.42;
  background:
    linear-gradient(135deg, transparent 0 50%, color-mix(in srgb, var(--ui-text-muted-fg) 28%, transparent) 50% 56%, transparent 56% 100%),
    linear-gradient(135deg, transparent 0 66%, color-mix(in srgb, var(--ui-text-muted-fg) 22%, transparent) 66% 72%, transparent 72% 100%);
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 38px;
  padding: 3px 9px 1px 12px;
  -webkit-app-region: drag;
}

.search-icon {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 52%, transparent);
}

.intent-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ui-accent-primary-fg) 14%, transparent);
  color: color-mix(in srgb, var(--ui-accent-primary-fg) 86%, var(--ui-text-primary-fg) 14%);
  font-size: var(--type-micro-size);
  font-weight: 500;
  line-height: var(--type-micro-line-height);
}

.search-input {
  flex: 1;
  min-width: 120px;
  -webkit-app-region: no-drag;
  background: none;
  border: none;
  outline: none;
  font-size: var(--type-headline-size);
  line-height: var(--type-headline-line-height);
  color: var(--ui-text-primary-fg);
  font-family: inherit;
}

.search-input::placeholder {
  color: var(--ui-text-muted-fg);
  opacity: 0.54;
}

.scope-tabs {
  -webkit-app-region: no-drag;
  flex: 0 0 auto;
  max-width: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  overflow-x: auto;
  scrollbar-width: none;
  opacity: 0;
  transition:
    max-width var(--duration-normal) var(--ease-default),
    opacity var(--duration-fast) var(--ease-default);
}

.scope-tabs::-webkit-scrollbar {
  display: none;
}

.scope-tab {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  box-sizing: border-box;
  padding: 0;
  max-width: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 48%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-micro-size);
  font-weight: 500;
  line-height: var(--type-micro-line-height);
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  transition:
    max-width var(--duration-normal) var(--ease-default),
    padding var(--duration-normal) var(--ease-default),
    opacity var(--duration-fast) var(--ease-default),
    background var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.search-input-row:hover .scope-tabs,
.search-input-row:focus-within .scope-tabs,
.scope-tabs.has-active-scope {
  max-width: 46%;
  opacity: 1;
}

.scope-tabs:hover .scope-tab,
.scope-tabs:focus-within .scope-tab,
.scope-tabs.has-active-scope .scope-tab.active,
.scope-tab:hover {
  max-width: 76px;
  padding: 0 4px;
  opacity: 1;
  pointer-events: auto;
}

.scope-tab:hover {
  background: color-mix(in srgb, var(--ui-state-hover-bg) 22%, transparent);
  color: color-mix(in srgb, var(--ui-text-primary-fg) 76%, transparent);
}

.scope-tab.active {
  max-width: 0;
  padding: 0 4px;
  background: transparent;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 82%, var(--ui-text-primary-fg) 18%);
  opacity: 0;
  pointer-events: none;
}

.scope-tabs.has-active-scope .scope-tab.active:not(.default-scope) {
  max-width: 58px;
  opacity: 1;
  pointer-events: auto;
}

.scope-tabs:hover .scope-tab.active,
.scope-tabs:focus-within .scope-tab.active {
  max-width: 76px;
  background: color-mix(in srgb, var(--ui-state-selected-bg, var(--selection)) 16%, transparent);
  color: color-mix(in srgb, var(--ui-text-primary-fg) 84%, transparent);
}

.scope-tabs:hover .scope-tab.active.default-scope,
.scope-tabs:focus-within .scope-tab.active.default-scope {
  max-width: 76px;
  padding: 0 4px;
  opacity: 1;
  pointer-events: auto;
}

.scope-tab kbd {
  color: color-mix(in srgb, var(--ui-text-muted-fg) 62%, transparent);
  font: inherit;
  font-size: var(--type-micro-size);
  opacity: 0;
  width: 0;
  overflow: hidden;
  transition: opacity var(--duration-fast) var(--ease-default), width var(--duration-fast) var(--ease-default);
}

.scope-tabs:hover .scope-tab kbd,
.scope-tabs:focus-within .scope-tab kbd,
.scope-tab:hover kbd {
  opacity: 0.58;
  width: auto;
}

/* ── Results ────────────────────────── */
.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 0 0 4px;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.search-results::-webkit-scrollbar {
  width: 4px;
}

.search-results::-webkit-scrollbar-track {
  background: transparent;
}

.search-results::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: transparent;
}

.search-results:hover,
.search-results:focus-within {
  scrollbar-color: color-mix(in srgb, var(--ui-text-muted-fg) 16%, transparent) transparent;
}

.search-results:hover::-webkit-scrollbar-thumb,
.search-results:focus-within::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ui-text-muted-fg) 16%, transparent);
}

.search-state {
  padding: 16px 18px 0 32px;
  text-align: left;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 58%, transparent);
  font-size: var(--type-caption-size);
  line-height: var(--type-caption-line-height);
}

.search-state.error {
  color: var(--ui-status-danger-fg, var(--danger));
}

/* The backdrop and the panel frame are `Dialog` since P2. This overlay used to
   be `position: absolute; inset: 0` inside the search shell, so the rounded
   window clipped it and it sat over the search field instead of above it;
   Dialog teleports to <body> and uses `position: fixed`, which is the whole
   point of the primitive. The form still owns its own layout below. */
.prompt-dialog {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.prompt-dialog-header,
.prompt-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.prompt-dialog h2 {
  margin: 0;
  font-size: var(--type-title-sm-size);
  font-weight: var(--type-title-sm-weight);
  line-height: var(--type-title-sm-line-height);
}

.prompt-dialog-close {
  border: 0;
  background: transparent;
  color: var(--ui-text-muted-fg);
  cursor: pointer;
  font-size: 18px;
}

.prompt-dialog label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: color-mix(in srgb, var(--ui-text-muted-fg) 78%, transparent);
  font-size: var(--type-caption-size);
  line-height: var(--type-caption-line-height);
}

.prompt-dialog input,
.prompt-dialog textarea {
  width: 100%;
  box-sizing: border-box;
  border: 0.5px solid color-mix(in srgb, var(--ui-border-default-border) 72%, transparent);
  border-radius: 7px;
  background: var(--ui-surface-app-bg);
  color: var(--ui-text-primary-fg);
  font: inherit;
  font-size: var(--type-body-size);
  line-height: var(--type-body-line-height);
  outline: none;
  padding: 7px 8px;
  resize: vertical;
}

.prompt-dialog button[type="submit"],
.prompt-dialog .secondary {
  border: 0.5px solid color-mix(in srgb, var(--ui-border-default-border) 72%, transparent);
  border-radius: 7px;
  background: var(--ui-accent-primary-fg);
  color: white;
  cursor: pointer;
  font: inherit;
  font-size: var(--type-label-size);
  line-height: var(--type-label-line-height);
  padding: 6px 10px;
}

.prompt-dialog .secondary {
  background: transparent;
  color: var(--ui-text-primary-fg);
}

.prompt-dialog-error {
  align-self: stretch;
}

@media (max-width: 620px) {
  .scope-tabs {
    max-width: 44%;
  }

  .scope-tab span {
    max-width: 44px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
