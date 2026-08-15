<template>
  <div
    class="editor-workbench"
    @keydown="onKeydown"
  >
    <Container
      as="section"
      main-as="div"
      class="editor-workbench-container"
      header-class="editor-workbench-header"
      body-class="editor-workbench-body"
      main-class="editor-workbench-main"
      full-height
      overflow="hidden"
      main-overflow="hidden"
      :main-flex="'1 1 0'"
    >
      <template #header>
        <div class="editor-breadcrumb-wrap">
          <Breadcrumb
            v-if="breadcrumbParts.length"
            class="editor-breadcrumb"
            separator="/"
          >
            <BreadcrumbItem
              v-for="part in breadcrumbParts"
              :key="part.path"
            >
              {{ part.label }}
            </BreadcrumbItem>
          </Breadcrumb>
        </div>
        <Button
          unstyled
          class="explorer-toggle"
          :aria-label="explorerCollapsed ? 'Show explorer' : 'Hide explorer'"
          @click="explorerCollapsed = !explorerCollapsed"
        >
          <PanelRightOpen
            v-if="explorerCollapsed"
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
          <PanelRightClose
            v-else
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </Button>
      </template>

      <Splitter
        class="editor-workbench-splitter"
        :gap="0"
        :resizer-size="1"
        :resizer-hit-size="10"
      >
        <SplitterPanel
          v-model:size="editorPanelSize"
          class="editor-panel"
          :min="38"
          :resizable="!explorerCollapsed"
        >
          <section class="editor-main">
            <div class="editor-body">
              <div
                v-if="activeBufferForRoot?.loading"
                class="editor-state"
              >
                Loading...
              </div>
              <div
                v-else-if="activeBufferForRoot?.isBinary || activeBufferForRoot?.truncated"
                class="editor-state"
              >
                This file is read-only in the workbench.
              </div>
              <div
                v-else-if="activeBufferForRoot?.error && !activeBufferForRoot.model"
                class="editor-state error"
              >
                {{ activeBufferForRoot.error }}
              </div>
              <TiptapNoteEditor
                v-else-if="activeBufferForRoot?.isMarkdown"
                ref="markdownRef"
                class="markdown-workbench-editor"
                :model-value="activeBufferForRoot.value"
                surface="document"
                :document-id="activeBufferForRoot.filePath"
                :document-path="activeBufferForRoot.filePath"
                :workspace-root="workspaceRoot"
                :features="markdownFeatures"
                placeholder=""
                :source-toggle="true"
                @update:model-value="onMarkdownChange"
                @selection-update="onMarkdownSelection"
                @paste="onMarkdownPaste"
                @open-link="openMarkdownLink"
                @open-image="openMarkdownImage"
              />
              <MonacoEditor
                v-else-if="activeBufferForRoot?.model"
                ref="monacoRef"
                :model="activeBufferForRoot.model"
                :view-state="activeBufferForRoot.viewState"
                :read-only="false"
                :settings="editorSettings"
                @change="onEditorChange"
                @cursor-change="onCursorChange"
                @view-state-change="onViewStateChange"
                @markers-change="onMarkersChange"
              />
              <div
                v-else
                class="editor-state"
              >
                Open a file
              </div>
            </div>
            <ProblemsPanel
              :open="workspace.problemsOpen"
              :problems="problems"
              @close="workspace.problemsOpen = false"
              @open-problem="openProblem"
            />
            <EditorStatusBar :buffer="activeBufferForRoot" />
          </section>
        </SplitterPanel>

        <SplitterPanel
          v-if="!explorerCollapsed"
          v-model:size="explorerPanelSize"
          as="aside"
          class="explorer-panel"
          :min="28"
          :max="58"
        >
          <FileExplorer
            class="editor-file-explorer"
            :root="workspace.root"
            :active-path="workspace.activePath"
            @open-file="emit('openFile', $event)"
          />
        </SplitterPanel>
      </Splitter>
    </Container>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEditorWorkspace } from '@/composables/useEditorWorkspace'
import { useSettingsStore } from '@/stores/settings'
import Breadcrumb from '@/components/common/Breadcrumb.vue'
import BreadcrumbItem from '@/components/common/BreadcrumbItem.vue'
import Button from '@/components/common/Button.vue'
import Container from '@/components/common/Container.vue'
import Splitter from '@/components/common/Splitter.vue'
import SplitterPanel from '@/components/common/SplitterPanel.vue'
import { PanelRightClose, PanelRightOpen } from 'lucide-vue-next'
import MonacoEditor from '@/editor/MonacoEditor.vue'
import TiptapNoteEditor from '@/editor/tiptap/TiptapNoteEditor.vue'
import EditorStatusBar from './EditorStatusBar.vue'
import FileExplorer from './FileExplorer.vue'
import ProblemsPanel from './ProblemsPanel.vue'
import { handleMarkdownAttachmentPaste } from '@/editor/markdown-attachments'
import type { MarkdownFeatureSet } from '@/editor/markdown-document'
import type { MarkdownAssetResolution } from '@shared/ipc/markdown'
import { platformApi } from '@/platform'
import { markdownApi } from '@/platform/markdown-client'

const props = defineProps<{
  initialFilePath?: string
  workspaceRoot?: string
  active?: boolean
}>()

const emit = defineEmits<{
  openFile: [filePath: string]
}>()

const editorWorkspace = useEditorWorkspace()
const settingsStore = useSettingsStore()
const {
  workspace,
  problems,
  setWorkspaceRoot,
  openFile,
  handleModelChange,
  saveFile,
  saveAll,
  setViewState,
  setScrollTop,
  setCursor,
  setMarkers,
  getOpenEditorsForRoot,
  isPathInsideRoot,
} = editorWorkspace

const monacoRef = ref<InstanceType<typeof MonacoEditor> | null>(null)
const markdownRef = ref<InstanceType<typeof TiptapNoteEditor> | null>(null)
const editorPanelSize = ref(62)
const explorerPanelSize = ref(38)
const explorerCollapsed = ref(false)
const editorSettings = computed(() => settingsStore.settings.general.editor)
const markdownFeatures: MarkdownFeatureSet = {
  tasks: true,
  tables: true,
  images: true,
  math: true,
  codeBlocks: true,
  frontmatter: true,
}

function parentDir(filePath: string) {
  return filePath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

const workspaceRoot = computed(() => {
  if (props.workspaceRoot) return props.workspaceRoot
  return props.initialFilePath ? parentDir(props.initialFilePath) : ''
})

const openEditorsForRoot = computed(() => {
  return workspaceRoot.value ? getOpenEditorsForRoot(workspaceRoot.value) : []
})

const activePathForRoot = computed(() => {
  if (workspaceRoot.value && workspace.activePath && isPathInsideRoot(workspace.activePath, workspaceRoot.value)) {
    return workspace.activePath
  }
  return openEditorsForRoot.value[0] || ''
})

const activeBufferForRoot = computed(() => {
  const activePath = activePathForRoot.value
  return activePath ? workspace.buffers.get(activePath) || null : null
})

const breadcrumbParts = computed(() => {
  const root = workspaceRoot.value
  const activePath = activeBufferForRoot.value?.filePath || activePathForRoot.value
  if (!activePath) return []

  if (!root || !isPathInsideRoot(activePath, root)) {
    return [{ label: basename(activePath), path: activePath }]
  }

  const normalizedRoot = root.replace(/\/+$/, '')
  const parts: Array<{ label: string; path: string }> = []
  const relative = activePath.slice(normalizedRoot.length).replace(/^\/+/, '')
  let current = normalizedRoot
  for (const segment of relative.split('/').filter(Boolean)) {
    current = `${current}/${segment}`
    parts.push({ label: segment, path: current })
  }
  return parts
})

async function bootstrap() {
  if (workspaceRoot.value) {
    await setWorkspaceRoot(workspaceRoot.value).catch(() => {})
  }
  if (props.initialFilePath) {
    await openFile(props.initialFilePath)
  }
  await nextTick()
  monacoRef.value?.focus()
}

function currentEditorFilePath() {
  return activeBufferForRoot.value?.filePath || ''
}

function onEditorChange(value: string) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  handleModelChange(filePath, value)
}

function onMarkdownChange(value: string) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  handleModelChange(filePath, value)
}

/**
 * markdown 面上的"光标在哪儿"。数字由编辑器给,不再由宿主拿源码偏移换算 ——
 * 所见即所得的文档里没有源码行,`line` 是顶层块的序号(见 TiptapNoteEditor 的
 * `selectionUpdate`)。状态栏读的是同一个"Ln/Col"格子,语义换了但位置没换。
 */
function onMarkdownSelection(info: { line: number; column: number }) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  setCursor(filePath, info.line, info.column)
  setScrollTop(filePath, markdownRef.value?.getScrollTop() || 0)
}

async function onMarkdownPaste(event: ClipboardEvent) {
  const filePath = currentEditorFilePath()
  await handleMarkdownAttachmentPaste({
    event,
    editor: markdownRef.value,
    documentPath: filePath,
    workspaceRoot: workspaceRoot.value,
  })
}

function onCursorChange(line: number, column: number) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  setCursor(filePath, line, column)
}

function onViewStateChange(state: Parameters<typeof setViewState>[1]) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  setViewState(filePath, state)
}

function onMarkersChange(markers: Parameters<typeof setMarkers>[1]) {
  const filePath = currentEditorFilePath()
  if (!filePath) return
  setMarkers(filePath, markers)
}

async function openProblem(filePath: string, line: number) {
  emit('openFile', filePath)
  await openFile(filePath)
  await nextTick()
  monacoRef.value?.revealLine(line)
}

async function resolveMarkdownLink(href: string, asset?: MarkdownAssetResolution | null) {
  if (asset) return asset
  const documentPath = currentEditorFilePath()
  if (!documentPath) return null
  const response = await markdownApi.resolveAsset({
    documentPath,
    workspaceRoot: workspaceRoot.value,
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

async function openMarkdownImage(payload: {
  src: string
  alt: string
  absolutePath?: string
  asset?: MarkdownAssetResolution | null
}) {
  const src = payload.asset?.dataUrl || payload.src
  await platformApi.openImagePreview(src, payload.alt)
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (!props.active) return
  if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    if (event.shiftKey) saveAll()
    else saveFile()
  }
  if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
    if (activeBufferForRoot.value?.isMarkdown) return
    event.preventDefault()
    monacoRef.value?.openFind()
  }
  if (event.key === 'p' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    platformApi.toggleSearchWindow?.()
  }
}

onMounted(bootstrap)

watch(() => props.initialFilePath, async (filePath) => {
  if (!filePath) return
  await openFile(filePath)
})

watch(workspaceRoot, async (root) => {
  await setWorkspaceRoot(root)
})

watch(() => activeBufferForRoot.value?.filePath, async () => {
  await nextTick()
  if (activeBufferForRoot.value?.isMarkdown) {
    markdownRef.value?.setScrollTop(activeBufferForRoot.value.scrollTop)
    markdownRef.value?.focus()
  } else {
    monacoRef.value?.focus()
  }
})
</script>

<style scoped>
.editor-workbench {
  flex: 1;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-surface-panel-bg);
}

.editor-workbench-container,
.editor-workbench-splitter {
  min-width: 0;
  min-height: 0;
  height: 100%;
}

:deep(.editor-workbench-header) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 34px;
  overflow: hidden;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--ui-border-default-border);
  background: var(--ui-surface-panel-bg);
}

:deep(.editor-workbench-body),
:deep(.editor-workbench-main) {
  min-width: 0;
  min-height: 0;
}

.editor-breadcrumb-wrap,
.editor-breadcrumb {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 100%;
}

.editor-breadcrumb-wrap {
  overflow: hidden;
}

.editor-breadcrumb {
  overflow-x: auto;
  overflow-y: hidden;
  font-size: 12px;
  line-height: 1.25;
  scrollbar-width: thin;
  overscroll-behavior-inline: contain;
}

.editor-breadcrumb::-webkit-scrollbar {
  height: 4px;
}

.editor-breadcrumb :deep(.app-breadcrumb__list) {
  flex: 0 0 max-content;
  flex-wrap: nowrap;
  width: max-content;
  min-width: max-content;
  overflow: visible;
  white-space: nowrap;
}

.editor-breadcrumb :deep(.app-breadcrumb-item) {
  flex: 0 0 auto;
  min-width: 0;
}

.editor-breadcrumb :deep(.app-breadcrumb-item.is-last) {
  flex: 0 0 auto;
}

.editor-breadcrumb :deep(.app-breadcrumb-item__content) {
  max-width: none;
}

.editor-breadcrumb :deep(.app-breadcrumb-item__separator) {
  min-width: 1.25em;
  padding: 0 0.28em;
}

.explorer-toggle {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--ui-text-muted-fg);
}

.explorer-toggle:hover {
  background: var(--ui-state-hover-bg);
  color: var(--ui-text-primary-fg);
}

.editor-panel,
.explorer-panel {
  min-width: 0;
  min-height: 0;
}

.editor-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.editor-file-explorer {
  flex: 1 1 auto;
  width: 100%;
  max-width: none;
  border-right: 0;
  border-left: 0;
}

.editor-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.editor-state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted-fg);
  font-size: 13px;
}

.editor-state.error {
  color: var(--ui-status-danger-fg);
}
</style>
