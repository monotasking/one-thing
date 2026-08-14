import type { MarkdownAttachmentInput } from '@shared/ipc/markdown'
import type { EditorHandle } from './types'
import { platformApi } from '@/platform'
import { toast } from '@/composables/useToast'

function clipboardFiles(event: ClipboardEvent): File[] {
  const files = new Map<string, File>()
  for (const file of Array.from(event.clipboardData?.files ?? [])) {
    const key = `${file.name}:${file.type}:${file.size}`
    files.set(key, file)
  }
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    const key = `${file.name}:${file.type}:${file.size}`
    files.set(key, file)
  }
  return Array.from(files.values())
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/png') return '.png'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/webp') return '.webp'
  if (mimeType === 'image/svg+xml') return '.svg'
  if (mimeType === 'application/pdf') return '.pdf'
  return ''
}

function fallbackFileName(file: File, index: number): string {
  if (file.name) return file.name
  const ext = extensionFromMime(file.type || '')
  return file.type?.startsWith('image/')
    ? `pasted-image-${index + 1}${ext || '.png'}`
    : `pasted-file-${index + 1}${ext}`
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',')[1] : result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function toAttachmentInput(file: File, index: number): Promise<MarkdownAttachmentInput> {
  return {
    fileName: fallbackFileName(file, index),
    mimeType: file.type || 'application/octet-stream',
    base64Data: await readBase64(file),
  }
}

/**
 * 落盘 + 插入引用的那一段,与"文件是从哪儿来的"无关。
 *
 * 粘贴走剪贴板,斜杠菜单的「图片」走文件选择框——两条入口同一条管线,不该有
 * 两份落盘规则(第二份迟早会和第一份的目录约定分叉)。
 */
export async function insertMarkdownAttachmentFiles(options: {
  files: File[]
  editor: EditorHandle | null
  documentPath?: string
  workspaceRoot?: string
}): Promise<boolean> {
  if (!options.files.length) return false
  if (!options.editor || !options.documentPath) return false

  const attachments = await Promise.all(options.files.map(toAttachmentInput))
  const response = await platformApi.saveMarkdownAttachments({
    documentPath: options.documentPath,
    workspaceRoot: options.workspaceRoot,
    files: attachments,
  })

  if (!response.success || !response.insertText) {
    // A paste handler cannot block on a modal — the toast service is callable
    // from plain `.ts` for exactly this reason (see composables/useToast).
    toast.error(response.error || 'Failed to save Markdown attachment')
    return true
  }

  const selection = options.editor.getSelection()
  options.editor.replaceRange(selection.from, selection.to, response.insertText)
  return true
}

export async function handleMarkdownAttachmentPaste(options: {
  event: ClipboardEvent
  editor: EditorHandle | null
  documentPath?: string
  workspaceRoot?: string
}): Promise<boolean> {
  const files = clipboardFiles(options.event)
  if (!files.length) return false
  if (!options.editor || !options.documentPath) return false

  options.event.preventDefault()
  return insertMarkdownAttachmentFiles({
    files,
    editor: options.editor,
    documentPath: options.documentPath,
    workspaceRoot: options.workspaceRoot,
  })
}
