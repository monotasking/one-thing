import { defineRouter } from './router.js'

export type MarkdownAssetKind = 'external' | 'missing' | 'file' | 'image'

export interface MarkdownAssetResolution {
  kind: MarkdownAssetKind
  rawTarget: string
  href?: string
  absolutePath?: string
  dataUrl?: string
  mimeType?: string
  fileName?: string
  error?: string
}

export interface MarkdownResolveAssetRequest {
  documentPath: string
  workspaceRoot?: string
  rawTarget: string
}

export interface MarkdownResolveAssetResponse {
  success: boolean
  asset?: MarkdownAssetResolution
  error?: string
}

export interface MarkdownAttachmentInput {
  fileName: string
  mimeType: string
  base64Data: string
}

export interface SavedMarkdownAttachment {
  fileName: string
  absolutePath: string
  linkText: string
  mimeType: string
}

export interface MarkdownSaveAttachmentsRequest {
  documentPath: string
  workspaceRoot?: string
  files: MarkdownAttachmentInput[]
}

export interface MarkdownSaveAttachmentsResponse {
  success: boolean
  insertText?: string
  attachments?: SavedMarkdownAttachment[]
  error?: string
  code?: string
}

/**
 * Markdown 附件域（主线 T 批 3 迁入通用 RPC 通道）。
 *
 * 批 1 把它放进「不可迁清单」第 2 类：server 侧有 `prepareServerMarkdownRequest`
 * + `sanitizeServerMarkdownAsset` 的工作区沙箱，而通用信封当时不带 request
 * context，护栏迁过去就没有输入。批 3 的 `RpcDispatchContext` 补上了输入，护栏
 * 随之搬进 `@onething/app`，两个宿主共用一份实现。
 */
export type MarkdownRoutes = {
  resolveAsset: { input: MarkdownResolveAssetRequest; output: MarkdownResolveAssetResponse }
  saveAttachments: { input: MarkdownSaveAttachmentsRequest; output: MarkdownSaveAttachmentsResponse }
}

export const markdownRouter = defineRouter<MarkdownRoutes>('markdown', [
  'resolveAsset',
  'saveAttachments',
])
