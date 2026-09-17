import type { MessageAttachment } from '@shared/ipc/chat'

/** 系统没有提供 MIME 时,保留常见图片/PDF 的模型输入类型。 */
const MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
])

function fileMimeType(file: File): string {
  if (file.type) return file.type
  const dot = file.name.lastIndexOf('.')
  const extension = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION.get(extension) ?? 'application/octet-stream'
}

/** 预览的 blob URL 不出渲染进程;命令总线接收真实的文件字节。 */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const fail = () => reject(new Error(`无法读取附件「${file.name}」${reader.error?.message ? `：${reader.error.message}` : ''}`))
    reader.onerror = fail
    reader.onabort = fail
    reader.onload = () => {
      const result = reader.result
      const separator = typeof result === 'string' ? result.indexOf(',') : -1
      if (typeof result !== 'string' || separator < 0) {
        fail()
        return
      }
      resolve(result.slice(separator + 1))
    }
    reader.readAsDataURL(file)
  })
}

export async function materializeFileAttachments(files: readonly File[]): Promise<MessageAttachment[]> {
  return Promise.all(files.map(async (file) => {
    const mimeType = fileMimeType(file)
    const mediaType = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('audio/') ? 'audio'
        : mimeType.startsWith('video/') ? 'video'
          : mimeType === 'application/pdf' ? 'document' : 'file'
    return {
      id: crypto.randomUUID(),
      fileName: file.name,
      mimeType,
      size: file.size,
      mediaType,
      base64Data: await readBase64(file),
    }
  }))
}
