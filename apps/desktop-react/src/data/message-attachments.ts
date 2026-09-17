import { t } from '../i18n'
import { isBlobRef, type BlobRef } from '@onething/core/session/events'

/** 图片只携带现有数据引用;展示层按需读取 blob,不在投影里解码字节。 */
export interface MessageAttachmentImage {
  readonly mimeType: string
  readonly base64Data?: string | BlobRef
}

/** 文件卡使用元信息;图片额外保留预览来源,包括尚未发送完的 File。 */
export interface MessageAttachmentMetadata {
  readonly id: string
  readonly fileName: string
  readonly filePath?: string
  readonly mimeType?: string
  readonly mediaType?: string
  readonly size?: number
  readonly sourceUrl?: string
  readonly sourceTitle?: string
  readonly image?: MessageAttachmentImage
  readonly file?: File
}

const NO_ATTACHMENTS: readonly MessageAttachmentMetadata[] = []
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'],
  ['apng', 'image/apng'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['svg', 'image/svg+xml'],
])

export function imageMimeTypeOf(mimeType: string | undefined, fileName: string): string | undefined {
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (normalizedMimeType?.startsWith('image/') && normalizedMimeType.length > 'image/'.length) {
    return normalizedMimeType
  }
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? undefined : IMAGE_MIME_BY_EXTENSION.get(fileName.slice(dot + 1).toLowerCase())
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** 附件在消息顶层,与正文 contentParts 并列;账本与历史页走同一份投影。 */
export function messageAttachmentMetadata(message: {
  readonly id: string
  readonly attachments?: unknown
}): readonly MessageAttachmentMetadata[] {
  if (!Array.isArray(message.attachments)) return NO_ATTACHMENTS
  return message.attachments.flatMap((value: unknown, index): MessageAttachmentMetadata[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const attachment = value as Record<string, unknown>
    const file = typeof File !== 'undefined' && attachment.file instanceof File ? attachment.file : undefined
    const filePath = nonemptyString(attachment.filePath)
    const mimeType = nonemptyString(attachment.mimeType) ?? nonemptyString(file?.type)
    const mediaType = nonemptyString(attachment.mediaType)
    const sourceUrl = nonemptyString(attachment.sourceUrl)
    const sourceTitle = nonemptyString(attachment.sourceTitle)
    const size = typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0
      ? attachment.size : undefined
    const fileName = nonemptyString(attachment.fileName)
      ?? nonemptyString(attachment.name)
      ?? nonemptyString(file?.name)
      ?? filePath?.split(/[\\/]/).filter(Boolean).at(-1)
      ?? sourceTitle
      ?? `${t('composer.attachments')} ${index + 1}`
    const imageMimeType = imageMimeTypeOf(mimeType, fileName)
    let image: MessageAttachmentImage | undefined
    if (imageMimeType) {
      const base64Data = attachment.base64Data
      image = {
        mimeType: imageMimeType,
        ...(typeof base64Data === 'string' || isBlobRef(base64Data) ? { base64Data } : {}),
      }
    }
    return [{
      id: nonemptyString(attachment.id) ?? `${message.id}:attachment:${index}`,
      fileName,
      ...(filePath ? { filePath } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(mediaType ? { mediaType } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sourceTitle ? { sourceTitle } : {}),
      ...(image ? { image } : {}),
      ...(file ? { file } : {}),
    }]
  })
}
