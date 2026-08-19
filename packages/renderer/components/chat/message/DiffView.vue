<template>
  <div class="diff-view">
    <!-- Toolbar: only show when file header is disabled -->
    <div
      v-if="hasContent && !loading && !error && showToolbar && !showFileHeader"
      class="diff-toolbar"
    >
      <div class="toolbar-left">
        <Tooltip
          v-if="allowStyleToggle"
          :text="currentDiffStyle === 'split' ? 'Switch to unified view' : 'Switch to split view'"
        >
          <Button
            unstyled
            class="toolbar-btn"
            @click="toggleDiffStyle"
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
                v-if="currentDiffStyle === 'split'"
                x="3"
                y="3"
                width="7"
                height="18"
                rx="2"
              />
              <rect
                v-if="currentDiffStyle === 'split'"
                x="14"
                y="3"
                width="7"
                height="18"
                rx="2"
              />
              <rect
                v-if="currentDiffStyle === 'unified'"
                x="3"
                y="3"
                width="18"
                height="18"
                rx="2"
              />
            </svg>
            <span>{{ currentDiffStyle === 'split' ? 'Split' : 'Unified' }}</span>
          </Button>
        </Tooltip>
      </div>
      <div class="toolbar-right">
        <Button
          v-if="allowCopy"
          unstyled
          class="toolbar-btn"
          @click="copyDiffContent"
        >
          <svg
            v-if="!copied"
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
          <svg
            v-else
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>{{ copied ? 'Copied' : 'Copy' }}</span>
        </Button>
      </div>
    </div>

    <div
      v-if="loading"
      class="diff-loading"
    >
      <span class="loading-spinner" />
      Loading diff...
    </div>
    <div
      v-else-if="error"
      class="diff-error"
    >
      {{ error }}
    </div>
    <div
      v-else-if="!hasContent"
      class="diff-empty"
    >
      No changes
    </div>
    <!-- @pierre/diffs will create its own diffs-container element inside this wrapper -->
    <div
      v-show="hasContent && !loading && !error"
      ref="containerWrapperRef"
      class="diff-content"
    />
  </div>
</template>

<script setup lang="ts">
import Button from '@/components/common/Button.vue'
import Tooltip from '@/components/common/Tooltip.vue'
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { FileDiff } from '@pierre/diffs'
import { DIFF_THEME_NAME, registerDiffTheme } from './diff-theme'
import { fileDiffMetadataFromHunks } from './diff-hunks-metadata'
import { parseUnifiedDiffToHunks, diffHunksHaveChanges } from '@/utils/diff-hunks'
import { createDomButton, type MountedDomButton } from '@/components/common/dom-button'
import { copyTextToClipboard } from '@/utils/clipboard'
import type { DiffHunk } from '@/types'
import type {
  FileDiffOptions,
  FileDiffMetadata,
  RenderHeaderMetadataProps,
  ChangeTypes,
  FileContents
} from '@pierre/diffs'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.diff-view')

// Has to happen before the first FileDiff is constructed: the library resolves
// a theme by name and caches it forever, so it must find ours already there.
registerDiffTheme()

interface Props {
  /** Raw unified diff content string */
  diff?: string
  /**
   * Structured hunks. Preferred over `diff`: they carry each line with an
   * explicit op, so display never re-parses ambiguous patch text (a deleted
   * `-- foo` line serializes as `--- foo` and breaks header-pattern parsers).
   * `diff` remains the legacy/copy source.
   */
  hunks?: DiffHunk[]
  /** Loading state */
  loading?: boolean
  /** Error message */
  error?: string
  /** Max height of the diff content area */
  maxHeight?: string
  /** Diff style: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split'
  /** Show expanded unchanged context */
  expandUnchanged?: boolean
  /** Number of context lines to show when expanding */
  expansionLineCount?: number
  /** Show toolbar with controls */
  showToolbar?: boolean
  /** Allow toggling between split/unified view */
  allowStyleToggle?: boolean
  /** Allow copying diff content */
  allowCopy?: boolean
  /** File name to display in header (optional, will parse from diff if not provided) */
  fileName?: string
  /** Show file header with name and statistics */
  showFileHeader?: boolean
  /** Show file name in header (when false, only shows stats and controls) */
  showFileName?: boolean
  /** Old file content (required for expand unchanged feature) */
  oldContent?: string
  /** New file content (required for expand unchanged feature) */
  newContent?: string
}

const props = withDefaults(defineProps<Props>(), {
  diff: '',
  hunks: undefined,
  loading: false,
  error: '',
  maxHeight: '300px',
  diffStyle: 'split',  // 默认使用左右并排视图
  expandUnchanged: true,  // 改为 true，默认启用可展开区域
  expansionLineCount: 5,
  showToolbar: true,
  allowStyleToggle: true,
  allowCopy: true,
  fileName: undefined,
  showFileHeader: true,  // 默认显示文件头部
  showFileName: true,  // 默认显示文件名
  oldContent: undefined,  // 旧文件内容（用于展开功能）
  newContent: undefined  // 新文件内容（用于展开功能）
})

const containerWrapperRef = ref<HTMLElement | null>(null)
let fileDiffInstance: FileDiff | null = null

// Internal state for toolbar
const currentDiffStyle = ref<'unified' | 'split'>(props.diffStyle)
const copied = ref(false)

/**
 * Structured hunks + display name. Preferred source is the hunks prop; legacy
 * text diffs go through the count-based parser (never a header-pattern parse).
 */
const parsedDiffData = computed<{ hunks: DiffHunk[]; fileName?: string } | null>(() => {
  if (props.hunks && props.hunks.length > 0) {
    return { hunks: props.hunks, fileName: undefined }
  }
  if (!props.diff) return null
  try {
    const parsed = parseUnifiedDiffToHunks(props.diff)
    return parsed.hunks.length > 0 ? parsed : null
  } catch (err) {
    log.error('patch parse failed', {}, err)
    return null
  }
})

/** Check if there's actual diff content to display */
const hasContent = computed(() => diffHunksHaveChanges(parsedDiffData.value?.hunks))

/** Display file name (priority: prop > parsed > fallback) */
const displayFileName = computed<string>(() => {
  return props.fileName
    || parsedDiffData.value?.fileName
    || 'Unknown file'
})

/** File metadata built from structured hunks */
const fileDiffMetadata = computed<FileDiffMetadata | null>(() => {
  const parsed = parsedDiffData.value
  if (!parsed || parsed.hunks.length === 0) return null
  return fileDiffMetadataFromHunks(parsed.hunks, props.fileName || parsed.fileName || 'file')
})

/** Diff statistics (additions and deletions) */
const diffStats = computed<{ additions: number; deletions: number }>(() => {
  const hunks = fileDiffMetadata.value?.hunks
  if (!hunks) return { additions: 0, deletions: 0 }

  return hunks.reduce(
    (acc, hunk) => ({
      additions: acc.additions + hunk.additionCount,
      deletions: acc.deletions + hunk.deletionCount
    }),
    { additions: 0, deletions: 0 }
  )
})

/** Detect current theme (light/dark) */
function getCurrentTheme(): 'light' | 'dark' {
  const dataTheme = document.documentElement.getAttribute('data-theme')
  if (dataTheme === 'dark') return 'dark'
  if (dataTheme === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Bridge the library's surface colours onto the app's palette. The theme in
 * diff-theme.ts covers the text; this covers what sits behind it.
 *
 * Two details here are load-bearing and were both wrong before:
 *
 * - The `:host` selector. wrapUnsafeCSS() drops this string into
 *   `@layer unsafe { … }` verbatim and adds no selector of its own, so bare
 *   declarations parse to zero rules and the whole block is silently discarded.
 * - The `-override` suffix. The library writes the un-suffixed names (e.g.
 *   `--diffs-bg-addition`) as inline styles computed from the theme, and inline
 *   beats a stylesheet rule; only the `-override` hooks it reads first can win.
 *
 * Values stay as `var()` references rather than resolved colours, so a theme
 * switch re-resolves in CSS with no re-render.
 */
function generateCustomCSS(): string {
  return `
    :host {
      /* The three colours every other diff shade is mixed from: changed line
         numbers, the indicator bars, the word-level emphasis, the +N/-N counts.
         They have to be set here rather than in the theme — see diff-theme.ts
         on why theme.colors cannot carry them. */
      --diffs-addition-color-override: var(--ui-status-success-fg);
      --diffs-deletion-color-override: var(--ui-status-danger-fg);
      --diffs-modified-color-override: var(--ui-status-warning-fg);

      /* Surfaces. The library would otherwise colour-mix these out of the
         background; we have a designed palette, so use it. */
      --diffs-bg-addition-override: var(--diff-add-bg);
      --diffs-bg-deletion-override: var(--diff-del-bg);
      --diffs-bg-separator-override: var(--diff-hunk-bg);
      --diffs-bg-context-override: var(--ui-surface-code-block-bg);
      --diffs-bg-hover-override: var(--ui-state-hover-bg);

      --diffs-fg-number-override: var(--ui-text-muted-fg);

      --diffs-font-family: var(--font-mono);
    }

    /* Line numbers are 'position: sticky; left: 0' in the library so they
       stay put while a long line scrolls horizontally. Every sticky box in a
       composited scroller is its own compositing candidate, so a 400-line
       write/diff pane brought 400 layers — and every animation frame anywhere
       on the page (a tool row folding, a rail collapsing) paid ~40–100ms of
       layerization for as long as the pane was open (measured 2026-08-19).
       Static numbers scroll with the code; the trade is worth it. */
    [data-column-number] {
      position: static;
    }
  `.trim()
}

/** Create FileDiff options */
function createOptions(): FileDiffOptions<undefined> {
  const isDark = getCurrentTheme() === 'dark'

  return {
    // One theme for both: its colours are var() references, so light and dark
    // are already distinguished by the app's tokens rather than by the theme.
    theme: {
      dark: DIFF_THEME_NAME,
      light: DIFF_THEME_NAME
    },
    // Still needed — it sets `color-scheme`, which decides the light-dark()
    // branch of the shades the library mixes itself.
    themeType: isDark ? 'dark' : 'light',
    diffStyle: currentDiffStyle.value,  // Use internal state for dynamic switching
    diffIndicators: 'bars',  // Modern bar indicators
    disableFileHeader: !props.showFileHeader,  // Enable/disable based on prop
    renderHeaderMetadata: props.showFileHeader ? renderHeaderMetadata : undefined,  // Custom header renderer
    overflow: 'scroll',
    lineDiffType: 'word',  // Word-level diffs for better precision
    expandUnchanged: props.expandUnchanged,
    expansionLineCount: props.expansionLineCount,
    hunkSeparators: 'metadata',  // Show metadata in separators
    unsafeCSS: generateCustomCSS(),  // Inject custom theme CSS
  }
}

/** Render the diff using @pierre/diffs */
async function renderDiff() {
  if (!containerWrapperRef.value) return
  if (!hasContent.value) return

  try {
    const fileDiff = fileDiffMetadata.value
    if (!fileDiff) return

    // Clean up previous instance
    if (fileDiffInstance) {
      fileDiffInstance.cleanUp()
      fileDiffInstance = null
    }

    // Clear wrapper (remove old diffs-container if any)
    containerWrapperRef.value.innerHTML = ''

    // Create new FileDiff instance
    const options = createOptions()
    fileDiffInstance = new FileDiff(options)

    // Prepare file contents for expand unchanged feature
    // When oldContent and newContent are provided (non-empty), the library can expand collapsed sections
    let oldFile: FileContents | undefined
    let newFile: FileContents | undefined

    if (props.oldContent && props.newContent) {
      oldFile = {
        name: fileDiff.prevName || fileDiff.name,
        contents: props.oldContent
      }
      newFile = {
        name: fileDiff.name,
        contents: props.newContent
      }
    }

    // KEY FIX: Use containerWrapper instead of fileContainer
    // This lets the library create its own diffs-container custom element
    // which has the required Shadow DOM
    fileDiffInstance.render({
      fileDiff,
      oldFile,  // Pass old file contents for expand feature
      newFile,  // Pass new file contents for expand feature
      containerWrapper: containerWrapperRef.value  // Let library create diffs-container
    })

  } catch (err) {
    log.error('diff render failed', {}, err)
  }
}

/** Toggle between split and unified diff styles */
function toggleDiffStyle() {
  currentDiffStyle.value = currentDiffStyle.value === 'split' ? 'unified' : 'split'
  renderDiff()
}

/** Copy diff content to clipboard */
async function copyDiffContent() {
  if (!props.diff) return

  const success = await copyTextToClipboard(props.diff)
  if (!success) {
    log.warn('diff copy failed')
    return
  }

  copied.value = true

  // If file header is enabled, re-render to update button state
  if (props.showFileHeader) {
    renderDiff()
  }

  setTimeout(() => {
    copied.value = false
    if (props.showFileHeader) {
      renderDiff()
    }
  }, 2000)
}

/**
 * Colours are var() references, so the browser re-resolves them on its own; the
 * only thing a theme switch still has to push is `color-scheme`, which no
 * variable can carry. Notably this means no re-highlight.
 */
function updateTheme() {
  if (!fileDiffInstance) return
  fileDiffInstance.setThemeType(getCurrentTheme())
}

/** Get lucide icon SVG string */
function getLucideIconSVG(iconName: string, size = 14): string {
  const icons: Record<string, string> = {
    'file-plus': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    'file-x': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="9.5" y1="12.5" x2="14.5" y2="17.5"/><line x1="14.5" y1="12.5" x2="9.5" y2="17.5"/></svg>`,
    'file-edit': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z"/></svg>`,
    'file': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    'columns-2': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>`,
    'rows-3': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/></svg>`,
    'copy': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    'check': `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
  }
  return icons[iconName] || icons['file']
}

/** Get file icon name based on change type */
function getFileIconName(type: ChangeTypes): string {
  const iconMap: Record<ChangeTypes, string> = {
    'new': 'file-plus',
    'deleted': 'file-x',
    'rename-pure': 'file-edit',
    'rename-changed': 'file-edit',
    'change': 'file'
  }
  return iconMap[type] || 'file'
}

// Header buttons are Vue trees mounted imperatively via render(); they live in
// the library's shadow DOM, out of reach of unmountDomButtons(), so we hold the
// handles ourselves and tear them down explicitly.
let headerButtons: MountedDomButton[] = []

function releaseHeaderButtons() {
  for (const mounted of headerButtons) mounted.unmount()
  headerButtons = []
}

/** Create header button element */
function createHeaderButton(
  iconName: string,
  onClick: () => void,
  title: string
): ReturnType<typeof createDomButton> {
  const mounted = createDomButton({
    className: 'diff-header-btn',
    title,
    onClick: (event) => {
      event.preventDefault()
      onClick()
    },
  })
  mounted.button.innerHTML = getLucideIconSVG(iconName, 14)
  headerButtons.push(mounted)
  return mounted
}

/** Render custom file header with metadata */
function renderHeaderMetadata(headerProps: RenderHeaderMetadataProps): HTMLElement {
  // The library discards the previous header on every render — drop its buttons
  // before building new ones.
  releaseHeaderButtons()

  const wrapper = document.createElement('div')
  wrapper.className = 'diff-header-metadata'

  // Left: File information (conditional)
  if (props.showFileName) {
    const fileSection = document.createElement('div')
    fileSection.className = 'diff-header-file'

    const fileIcon = document.createElement('span')
    fileIcon.className = 'diff-header-icon'
    const iconName = getFileIconName(headerProps.fileDiff?.type || 'change')
    fileIcon.innerHTML = getLucideIconSVG(iconName, 14)

    const fileName = document.createElement('span')
    fileName.className = 'diff-header-name'
    fileName.textContent = displayFileName.value

    fileSection.appendChild(fileIcon)
    fileSection.appendChild(fileName)
    wrapper.appendChild(fileSection)
  }

  // Middle: Statistics
  const statsSection = document.createElement('div')
  statsSection.className = 'diff-header-stats'

  const stats = diffStats.value
  if (stats.deletions > 0) {
    const del = document.createElement('span')
    del.className = 'diff-stat-deletions'
    del.textContent = `-${stats.deletions}`
    statsSection.appendChild(del)
  }

  if (stats.additions > 0) {
    const add = document.createElement('span')
    add.className = 'diff-stat-additions'
    add.textContent = `+${stats.additions}`
    statsSection.appendChild(add)
  }

  // Right: Controls
  const controlsSection = document.createElement('div')
  controlsSection.className = 'diff-header-controls'

  if (props.allowStyleToggle) {
    const toggleBtn = createHeaderButton(
      currentDiffStyle.value === 'split' ? 'columns-2' : 'rows-3',
      () => toggleDiffStyle(),
      currentDiffStyle.value === 'split' ? 'Switch to unified view' : 'Switch to split view'
    )
    controlsSection.appendChild(toggleBtn.host)
  }

  if (props.allowCopy) {
    const copyBtn = createHeaderButton(
      copied.value ? 'check' : 'copy',
      () => copyDiffContent(),
      copied.value ? 'Copied!' : 'Copy diff'
    )
    if (copied.value) copyBtn.button.classList.add('active')
    controlsSection.appendChild(copyBtn.host)
  }

  wrapper.appendChild(statsSection)
  wrapper.appendChild(controlsSection)

  return wrapper
}

// Watch for theme changes
let themeObserver: MutationObserver | null = null

function setupThemeObserver() {
  themeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === 'data-theme') {
        updateTheme()
      }
    }
  })

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
}

// Sync currentDiffStyle when prop changes
watch(() => props.diffStyle, (newStyle) => {
  currentDiffStyle.value = newStyle
})

// Unified watch for all relevant props
watch(
  () => ({
    diff: props.diff,
    hunks: props.hunks,
    loading: props.loading,
    diffStyle: props.diffStyle
  }),
  async (newVal) => {
    if (!newVal.loading && hasContent.value && containerWrapperRef.value) {
      await nextTick()
      renderDiff()
    }
  },
  { deep: true }
)

onMounted(async () => {
  setupThemeObserver()

  // Render if we have content
  if (hasContent.value && !props.loading) {
    await nextTick()
    renderDiff()
  }
})

onUnmounted(() => {
  if (fileDiffInstance) {
    fileDiffInstance.cleanUp()
    fileDiffInstance = null
  }

  releaseHeaderButtons()

  if (themeObserver) {
    themeObserver.disconnect()
    themeObserver = null
  }
})
</script>

<style scoped>
.diff-view {
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-sm);
  border: 1px solid var(--ui-surface-code-block-border);
  background: var(--ui-surface-code-block-bg);
}

/* Toolbar */
.diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: var(--ui-surface-code-header-bg);
  border-bottom: 1px solid var(--ui-surface-code-block-border);
  gap: 8px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-xs);
  color: var(--ui-text-secondary-fg);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
}

.toolbar-btn:hover {
  background: var(--ui-state-hover-bg);
  border-color: var(--ui-border-default-border);
  color: var(--ui-text-primary-fg);
}

.toolbar-btn:active {
  background: var(--ui-state-active-bg);
  transform: scale(0.98);
}

.toolbar-btn svg {
  flex-shrink: 0;
}

.diff-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--ui-text-muted-fg);
  font-size: 12px;
}

.loading-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--ui-border-default-border);
  border-top-color: var(--ui-accent-primary-fg);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.diff-error,
.diff-empty {
  padding: 16px;
  color: var(--ui-text-muted-fg);
  font-size: 12px;
  text-align: center;
}

.diff-content {
  max-height: v-bind(maxHeight);
  overflow: auto;
}

/* Style the diffs-container custom element */
.diff-content :deep(diffs-container) {
  display: block;
  width: 100%;

  /* Font settings - @pierre/diffs adapts to these */
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;

  /* Advanced font features for code */
  font-feature-settings:
    'liga' 1,    /* ligatures */
    'calt' 1,    /* contextual alternates */
    'zero' 1,    /* slashed zero */
    'cv01' 1;    /* stylistic set (varies by font) */
  font-variant-numeric: tabular-nums; /* monospaced numbers */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;

  /* Library-specific CSS variables */
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-tab-size: 2;
}

/* Additional theme integration */
.diff-content :deep(.diffs-line) {
  border-radius: 0;
}

.diff-content :deep(.diffs-line-number) {
  user-select: none;
  font-variant-numeric: tabular-nums;
  min-width: 40px; /* Consistent width for line numbers */
}

/* Code highlighting enhancements */
.diff-content :deep(code) {
  font-family: inherit;
  font-feature-settings: inherit;
}

/* Smooth transitions on theme change */
.diff-content :deep(diffs-container *) {
  transition: background-color var(--duration-normal) var(--ease-default), color var(--duration-normal) var(--ease-default), border-color var(--duration-normal) var(--ease-default);
}

/* ========================================
   File Header Styles
   ======================================== */

/* File header container */
.diff-content :deep(.diffs-file-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--ui-surface-code-header-bg);
  border-bottom: 1px solid var(--ui-surface-code-block-border);
  font-size: 12px;
  min-height: 36px;
}

.diff-content :deep(.diff-header-metadata) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

/* File information section */
.diff-content :deep(.diff-header-file) {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.diff-content :deep(.diff-header-icon) {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.diff-content :deep(.diff-header-icon svg) {
  width: 14px;
  height: 14px;
  color: var(--ui-text-secondary-fg);
}

.diff-content :deep(.diff-header-name) {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-primary-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Statistics section */
.diff-content :deep(.diff-header-stats) {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
}

.diff-content :deep(.diff-stat-deletions) {
  color: var(--diff-del-text);
  background: var(--diff-del-bg);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
}

.diff-content :deep(.diff-stat-additions) {
  color: var(--diff-add-text);
  background: var(--diff-add-bg);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
}

/* Control buttons section */
.diff-content :deep(.diff-header-controls) {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.diff-content :deep(.diff-header-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--ui-border-subtle-border);
  border-radius: var(--radius-xs);
  color: var(--ui-text-secondary-fg);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
}

.diff-content :deep(.diff-header-btn:hover) {
  background: var(--ui-state-hover-bg);
  border-color: var(--ui-border-default-border);
  color: var(--ui-text-primary-fg);
}

.diff-content :deep(.diff-header-btn:active) {
  background: var(--ui-state-active-bg);
  transform: scale(0.95);
}

.diff-content :deep(.diff-header-btn.active) {
  background: var(--ui-state-selected-bg);
  border-color: var(--ui-border-selected-border, var(--ui-action-primary-border));
  color: var(--ui-text-primary-fg);
}

/* ========================================
   Expansion Controls Enhancement
   ======================================== */

.diff-content :deep(.diffs-expansion) {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--diff-hunk-bg);
  border: 1px solid var(--ui-border-subtle-border);
  border-left: none;
  border-right: none;
  padding: 6px 12px;
  margin: 2px 0;
  font-size: 11px;
  color: var(--diff-hunk-text);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  user-select: none;
}

.diff-content :deep(.diffs-expansion:hover) {
  background: var(--ui-state-hover-bg);
  border-color: var(--ui-border-default-border);
  color: var(--ui-text-primary-fg);
}

.diff-content :deep(.diffs-expansion-icon) {
  margin-right: 4px;
}

/* Scrollbar styles */
.diff-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.diff-content::-webkit-scrollbar-track {
  background: transparent;
}

.diff-content::-webkit-scrollbar-thumb {
  background: var(--ui-border-default-border);
  border-radius: 3px;
}

.diff-content::-webkit-scrollbar-thumb:hover {
  background: var(--ui-text-muted-fg);
}

.diff-content::-webkit-scrollbar-corner {
  background: transparent;
}
</style>
