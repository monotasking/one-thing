/**
 * 媒体域**要宿主本体的三条**的处理者(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 一次原生保存对话框 + 两个 `BrowserWindow`。十一条数据面早在 P4c 第三批就走了
 * `rpc:invoke` 的 `mediaRouter`,分界线一字未改;变的只是这三条不再各占一条手写通道。
 *
 * 「开预览窗」写进的那本登记簿,和已迁走的 `media.getPreview` 读的是**同一本**
 * (`runtime/media/image-preview-registry-bound` 的进程内单例)——两条通道,一份真相。
 */
import type {
  MediaOpenImageGalleryRequest,
  MediaOpenImageGalleryResponse,
  MediaOpenImagePreviewRequest,
  MediaOpenImagePreviewResponse,
  MediaSaveAsRequest,
  MediaSaveAsResponse,
  MediaWindowRoutes,
} from '@shared/ipc/media.js'
import { mediaWindowRouter } from '@shared/ipc/media.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

export interface MediaWindowShellOperations {
  saveAs(request: MediaSaveAsRequest): Promise<MediaSaveAsResponse>
  openPreview(request: MediaOpenImagePreviewRequest): Promise<MediaOpenImagePreviewResponse>
  openGallery(request: MediaOpenImageGalleryRequest): Promise<MediaOpenImageGalleryResponse>
}

export function createMediaWindowShellHandlers(
  operations: MediaWindowShellOperations,
): ShellRouteHandlers<MediaWindowRoutes> {
  return {
    saveAs: async request => operations.saveAs(request),
    openPreview: async request => operations.openPreview(request),
    openGallery: async request => operations.openGallery(request),
  }
}

export function registerMediaWindowShellDomain(
  operations: MediaWindowShellOperations,
): () => void {
  return registerShellDomain(mediaWindowRouter, createMediaWindowShellHandlers(operations))
}
