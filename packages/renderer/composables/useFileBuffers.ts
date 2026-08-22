import { computed, reactive } from 'vue'
import { languageFromPath } from '@/editor/languages'
import type { EditorLanguage, EditorSelection } from '@/editor'
import type { FileSearchMatch } from '@/components/chat/file-search'
import { filesApi } from '@/platform/files-client'
import { platformApi } from '@/platform'

export interface FileSearchState {
  query: string
  caseSensitive: boolean
  currentMatchIndex: number
  matches: FileSearchMatch[]
  searchOpen: boolean
}

export interface FileBuffer {
  filePath: string
  content: string
  draftContent: string
  loading: boolean
  saving: boolean
  error: string
  conflict: boolean
  editing: boolean
  size: number
  truncated: boolean
  encoding: string
  isBinary: boolean
  language: EditorLanguage
  selection: EditorSelection
  scrollTop: number
  search: FileSearchState
  lastReadMtimeMs?: number
}

const buffers = reactive(new Map<string, FileBuffer>())

function hasWorkspaceFileAccess(): boolean {
  return platformApi.capabilities.localFileSystem || platformApi.capabilities.workspaceFileSystem
}

function createBuffer(filePath: string): FileBuffer {
  return reactive({
    filePath,
    content: '',
    draftContent: '',
    loading: false,
    saving: false,
    error: '',
    conflict: false,
    editing: false,
    size: 0,
    truncated: false,
    encoding: 'utf-8',
    isBinary: false,
    language: languageFromPath(filePath),
    selection: { from: 0, to: 0 },
    scrollTop: 0,
    search: {
      query: '',
      caseSensitive: false,
      currentMatchIndex: -1,
      matches: [],
      searchOpen: false,
    },
    lastReadMtimeMs: undefined,
  }) as FileBuffer
}

function getBuffer(filePath: string): FileBuffer {
  let buffer = buffers.get(filePath)
  if (!buffer) {
    buffer = createBuffer(filePath)
    buffers.set(filePath, buffer)
  }
  return buffer
}

function isDirty(filePath: string): boolean {
  const buffer = buffers.get(filePath)
  return !!buffer && buffer.draftContent !== buffer.content
}

async function loadFile(filePath: string, maxBytes: number, options: { force?: boolean } = {}) {
  const buffer = getBuffer(filePath)
  if (buffer.loading) return buffer
  if (!options.force && (buffer.content || buffer.error || buffer.lastReadMtimeMs !== undefined || buffer.isBinary)) {
    return buffer
  }
  if (!hasWorkspaceFileAccess()) {
    buffer.error = 'Workspace file access is not available in this host.'
    return buffer
  }

  buffer.loading = true
  buffer.error = ''
  buffer.conflict = false

  try {
    const res = await filesApi.readContent({ path: filePath, maxSize: maxBytes })
    if (!res.success) {
      buffer.error = res.error || 'Failed to read file'
      return buffer
    }

    buffer.content = res.content || ''
    buffer.draftContent = res.content || ''
    buffer.size = res.size || 0
    buffer.truncated = (res.size || 0) > maxBytes
    buffer.encoding = res.encoding || 'utf-8'
    buffer.isBinary = !!res.isBinary
    buffer.language = languageFromPath(filePath)
    buffer.lastReadMtimeMs = res.mtimeMs
    buffer.editing = false
    buffer.selection = { from: 0, to: 0 }
    buffer.scrollTop = 0
  } catch (e: any) {
    buffer.error = e.message || 'Failed to read file'
  } finally {
    buffer.loading = false
  }

  return buffer
}

function startEditing(filePath: string) {
  const buffer = getBuffer(filePath)
  if (buffer.truncated || buffer.isBinary || buffer.error) return
  buffer.draftContent = buffer.content
  buffer.editing = true
  buffer.conflict = false
}

function cancelEditing(filePath: string) {
  const buffer = getBuffer(filePath)
  buffer.draftContent = buffer.content
  buffer.editing = false
  buffer.conflict = false
}

function discard(filePath: string) {
  cancelEditing(filePath)
}

async function saveFile(filePath: string) {
  const buffer = getBuffer(filePath)
  if (buffer.truncated || buffer.isBinary) {
    buffer.error = 'This file is read-only in preview.'
    return false
  }
  if (!hasWorkspaceFileAccess()) {
    buffer.error = 'Workspace file access is not available in this host.'
    return false
  }

  buffer.saving = true
  buffer.error = ''
  buffer.conflict = false

  try {
    const res = await filesApi.saveContent({
      path: filePath,
      content: buffer.draftContent,
      expectedMtimeMs: buffer.lastReadMtimeMs,
    })
    if (!res.success) {
      buffer.conflict = !!res.conflict
      buffer.error = res.error || 'Failed to save'
      return false
    }
    buffer.content = buffer.draftContent
    buffer.editing = false
    buffer.lastReadMtimeMs = res.mtimeMs ?? buffer.lastReadMtimeMs
    return true
  } catch (e: any) {
    buffer.error = e.message || 'Failed to save'
    return false
  } finally {
    buffer.saving = false
  }
}

function releaseBuffer(filePath: string) {
  buffers.delete(filePath)
}

export function useFileBuffers() {
  return {
    buffers,
    getBuffer,
    loadFile,
    saveFile,
    startEditing,
    cancelEditing,
    discard,
    releaseBuffer,
    isDirty,
    dirtyFiles: computed(() => Array.from(buffers.values()).filter(buffer => buffer.draftContent !== buffer.content)),
  }
}
