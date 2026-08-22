import { computed, markRaw, reactive, shallowReactive } from 'vue'
import * as monaco from 'monaco-editor'
import { monacoLanguageFromPath } from '@/editor/monaco-languages'
import { filesApi } from '@/platform/files-client'
import { platformApi } from '@/platform'

export interface ExplorerEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtimeMs?: number
}

export interface EditorBuffer {
  filePath: string
  title: string
  model: monaco.editor.ITextModel | null
  value: string
  content: string
  isMarkdown: boolean
  dirty: boolean
  loading: boolean
  loadingSince: number
  saving: boolean
  error: string
  conflict: boolean
  truncated: boolean
  isBinary: boolean
  size: number
  encoding: string
  lastReadMtimeMs?: number
  viewState: monaco.editor.ICodeEditorViewState | null
  scrollTop: number
  line: number
  column: number
  markers: monaco.editor.IMarker[]
}

export interface ExplorerNodeState {
  expanded: boolean
  loading: boolean
  error: string
  entries: ExplorerEntry[]
}

const workspace = reactive({
  root: '',
  activePath: '',
  openEditors: [] as string[],
  buffers: new Map<string, EditorBuffer>(),
  tree: new Map<string, ExplorerNodeState>(),
  externalEvents: [] as Array<{ path: string; eventType: string }>,
  problemsOpen: false,
})

let watchDispose: (() => void) | null = null
let watchedRoot = ''

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function normalizePath(path: string): string {
  if (path === '/') return '/'
  return path.replace(/\/+$/, '')
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const normalizedPath = normalizePath(filePath)
  const normalizedRoot = normalizePath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath.split(/[?#]/)[0])
}

function createBuffer(filePath: string): EditorBuffer {
  return shallowReactive({
    filePath,
    title: basename(filePath),
    model: null,
    value: '',
    content: '',
    isMarkdown: isMarkdownFile(filePath),
    dirty: false,
    loading: false,
    loadingSince: 0,
    saving: false,
    error: '',
    conflict: false,
    truncated: false,
    isBinary: false,
    size: 0,
    encoding: 'utf-8',
    lastReadMtimeMs: undefined,
    viewState: null,
    scrollTop: 0,
    line: 1,
    column: 1,
    markers: [],
  }) as EditorBuffer
}

function getBuffer(filePath: string): EditorBuffer {
  let buffer = workspace.buffers.get(filePath)
  if (!buffer) {
    buffer = createBuffer(filePath)
    workspace.buffers.set(filePath, buffer)
  }
  return buffer
}

function modelUri(filePath: string) {
  return monaco.Uri.file(filePath)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => window.clearTimeout(timer))
  })
}

const workspaceFileSystemUnavailable = 'Workspace file access is not available in this host.'

function hasWorkspaceFileAccess(): boolean {
  return platformApi.capabilities.localFileSystem || platformApi.capabilities.workspaceFileSystem
}

async function setWorkspaceRoot(root: string) {
  if (workspace.root === root) return
  if (watchedRoot) {
    await filesApi.watchStop({ root: watchedRoot }).catch(() => {})
  }
  watchDispose?.()
  watchDispose = null
  watchedRoot = ''
  workspace.root = root
  workspace.tree.clear()
  workspace.externalEvents = []
  if (root) {
    loadDirectory(root).catch(() => {})
  }
}

async function loadDirectory(dirPath: string) {
  let node = workspace.tree.get(dirPath)
  if (!node) {
    node = reactive({ expanded: true, loading: false, error: '', entries: [] }) as ExplorerNodeState
    workspace.tree.set(dirPath, node)
  }
  if (!hasWorkspaceFileAccess()) {
    node.loading = false
    node.entries = []
    node.error = workspaceFileSystemUnavailable
    return
  }
  node.loading = true
  node.error = ''
  try {
    const res = await filesApi.listDirectory({ path: dirPath })
    if (res.success) {
      node.entries = res.entries || []
      node.expanded = true
    } else {
      node.error = res.error || 'Failed to load directory'
    }
  } catch (error) {
    node.error = error instanceof Error ? error.message : 'Failed to load directory'
  } finally {
    node.loading = false
  }
}

async function toggleDirectory(dirPath: string) {
  const node = workspace.tree.get(dirPath)
  if (node?.expanded) {
    node.expanded = false
    return
  }
  await loadDirectory(dirPath)
}

async function openFile(filePath: string, maxBytes = 1024 * 1024) {
  const buffer = getBuffer(filePath)
  if (!workspace.openEditors.includes(filePath)) {
    workspace.openEditors.push(filePath)
  }
  workspace.activePath = filePath
  buffer.isMarkdown = isMarkdownFile(filePath)
  if (buffer.model || (buffer.isMarkdown && buffer.lastReadMtimeMs !== undefined)) return buffer
  if (buffer.loading) {
    const elapsed = Date.now() - buffer.loadingSince
    if (elapsed < 10_000) return buffer
    buffer.loading = false
  }
  if (!hasWorkspaceFileAccess()) {
    buffer.error = workspaceFileSystemUnavailable
    return buffer
  }

  buffer.loading = true
  buffer.loadingSince = Date.now()
  buffer.error = ''
  try {
    const res = await withTimeout(
      filesApi.readContent({ path: filePath, maxSize: maxBytes }),
      8000,
      'File load timed out',
    )
    if (!res.success) {
      buffer.error = res.error || 'Failed to read file'
      return buffer
    }
    buffer.content = res.content || ''
    buffer.value = buffer.content
    buffer.size = res.size || 0
    buffer.encoding = res.encoding || 'utf-8'
    buffer.lastReadMtimeMs = res.mtimeMs
    buffer.truncated = (res.size || 0) > maxBytes
    buffer.isBinary = !!res.isBinary
    if (!buffer.truncated && !buffer.isBinary && !buffer.isMarkdown) {
      const existing = monaco.editor.getModel(modelUri(filePath))
      buffer.model = markRaw(
        existing || monaco.editor.createModel(buffer.content, monacoLanguageFromPath(filePath), modelUri(filePath)),
      )
    }
  } catch (error) {
    buffer.error = error instanceof Error ? error.message : 'Failed to read file'
  } finally {
    buffer.loading = false
    buffer.loadingSince = 0
  }
  return buffer
}

function setActivePath(filePath: string) {
  if (workspace.openEditors.includes(filePath)) workspace.activePath = filePath
}

function handleModelChange(filePath: string, value: string) {
  const buffer = getBuffer(filePath)
  buffer.value = value
  buffer.dirty = value !== buffer.content
}

async function saveFile(filePath = workspace.activePath) {
  const buffer = workspace.buffers.get(filePath)
  if (!buffer || buffer.truncated || buffer.isBinary) return false
  if (!buffer.model && !buffer.isMarkdown) return false
  if (!hasWorkspaceFileAccess()) {
    buffer.error = workspaceFileSystemUnavailable
    workspace.problemsOpen = true
    return false
  }
  buffer.saving = true
  buffer.error = ''
  buffer.conflict = false
  const value = buffer.model?.getValue() ?? buffer.value
  const res = await filesApi.saveContent({
    path: filePath,
    content: value,
    expectedMtimeMs: buffer.lastReadMtimeMs,
  })
  buffer.saving = false
  if (!res.success) {
    buffer.conflict = !!res.conflict
    buffer.error = res.error || 'Failed to save file'
    workspace.problemsOpen = true
    return false
  }
  buffer.content = value
  buffer.value = value
  buffer.dirty = false
  buffer.lastReadMtimeMs = res.mtimeMs ?? buffer.lastReadMtimeMs
  return true
}

async function saveAll() {
  const results = await Promise.all(workspace.openEditors.map(filePath => {
    const buffer = workspace.buffers.get(filePath)
    return buffer?.dirty ? saveFile(filePath) : Promise.resolve(true)
  }))
  return results.every(Boolean)
}

function getOpenEditorsForRoot(root: string) {
  return workspace.openEditors.filter(filePath => isPathInsideRoot(filePath, root))
}

function getDirtyBuffersForRoot(root: string) {
  return Array.from(workspace.buffers.values()).filter(buffer =>
    buffer.dirty && isPathInsideRoot(buffer.filePath, root),
  )
}

async function saveWorkspace(root: string) {
  const results = await Promise.all(getDirtyBuffersForRoot(root).map(buffer => saveFile(buffer.filePath)))
  return results.every(Boolean)
}

function closeFile(filePath: string, disposeModel = true) {
  const index = workspace.openEditors.indexOf(filePath)
  if (index !== -1) workspace.openEditors.splice(index, 1)
  const buffer = workspace.buffers.get(filePath)
  if (disposeModel) {
    buffer?.model?.dispose()
    workspace.buffers.delete(filePath)
  }
  if (workspace.activePath === filePath) {
    workspace.activePath = workspace.openEditors[Math.max(0, index - 1)] || ''
  }
}

function closeWorkspace(root: string) {
  for (const filePath of getOpenEditorsForRoot(root)) {
    closeFile(filePath)
  }
}

async function refreshActiveFile() {
  const filePath = workspace.activePath
  const buffer = workspace.buffers.get(filePath)
  if (!filePath || !buffer || buffer.dirty) return
  buffer.model?.dispose()
  workspace.buffers.delete(filePath)
  await openFile(filePath)
}

async function createFile(parentDir: string, name: string) {
  if (!hasWorkspaceFileAccess()) return { success: false, error: workspaceFileSystemUnavailable }
  const filePath = `${parentDir.replace(/\/$/, '')}/${name}`
  const res = await filesApi.create({ path: filePath })
  if (res.success) await loadDirectory(parentDir)
  return res
}

async function createDirectory(parentDir: string, name: string) {
  if (!hasWorkspaceFileAccess()) return { success: false, error: workspaceFileSystemUnavailable }
  const dirPath = `${parentDir.replace(/\/$/, '')}/${name}`
  const res = await filesApi.createDirectory({ path: dirPath })
  if (res.success) await loadDirectory(parentDir)
  return res
}

async function renamePath(oldPath: string, newName: string) {
  if (!hasWorkspaceFileAccess()) return { success: false, error: workspaceFileSystemUnavailable }
  const parent = oldPath.split('/').slice(0, -1).join('/') || '/'
  const newPath = `${parent}/${newName}`
  const res = await filesApi.rename({ oldPath, newPath })
  if (res.success) {
    await loadDirectory(parent)
    if (workspace.buffers.has(oldPath)) {
      closeFile(oldPath)
      await openFile(newPath)
    }
  }
  return res
}

async function deletePath(targetPath: string) {
  if (!hasWorkspaceFileAccess()) return { success: false, error: workspaceFileSystemUnavailable }
  const parent = targetPath.split('/').slice(0, -1).join('/') || '/'
  const res = await filesApi.delete({ path: targetPath })
  if (res.success) {
    closeFile(targetPath)
    await loadDirectory(parent)
  }
  return res
}

async function revealPath(targetPath: string) {
  if (!hasWorkspaceFileAccess()) return { success: false, error: workspaceFileSystemUnavailable }
  return filesApi.reveal({ path: targetPath })
}

function setViewState(filePath: string, state: monaco.editor.ICodeEditorViewState | null) {
  const buffer = workspace.buffers.get(filePath)
  if (buffer) buffer.viewState = state ? markRaw(state) : null
}

function setScrollTop(filePath: string, scrollTop: number) {
  const buffer = workspace.buffers.get(filePath)
  if (buffer) buffer.scrollTop = scrollTop
}

function setCursor(filePath: string, line: number, column: number) {
  const buffer = workspace.buffers.get(filePath)
  if (buffer) {
    buffer.line = line
    buffer.column = column
  }
}

function setMarkers(filePath: string, markers: monaco.editor.IMarker[]) {
  const buffer = workspace.buffers.get(filePath)
  if (buffer) buffer.markers = markRaw(markers.slice())
}

export function useEditorWorkspace() {
  const activeBuffer = computed(() => workspace.buffers.get(workspace.activePath) || null)
  const dirtyBuffers = computed(() => Array.from(workspace.buffers.values()).filter(buffer => buffer.dirty))
  const problems = computed(() => Array.from(workspace.buffers.values()).flatMap(buffer => [
    ...(buffer.error ? [{ filePath: buffer.filePath, message: buffer.error, severity: 'error' as const }] : []),
    ...buffer.markers.map(marker => ({
      filePath: buffer.filePath,
      message: marker.message,
      severity: marker.severity >= monaco.MarkerSeverity.Error ? 'error' as const : 'warning' as const,
      line: marker.startLineNumber,
      column: marker.startColumn,
    })),
  ]))

  return {
    workspace,
    activeBuffer,
    dirtyBuffers,
    problems,
    setWorkspaceRoot,
    loadDirectory,
    toggleDirectory,
    openFile,
    setActivePath,
    handleModelChange,
    saveFile,
    saveAll,
    saveWorkspace,
    closeFile,
    closeWorkspace,
    refreshActiveFile,
    createFile,
    createDirectory,
    renamePath,
    deletePath,
    revealPath,
    setViewState,
    setScrollTop,
    setCursor,
    setMarkers,
    getOpenEditorsForRoot,
    getDirtyBuffersForRoot,
    isPathInsideRoot,
  }
}
