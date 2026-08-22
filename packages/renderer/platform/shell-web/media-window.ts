/**
 * 媒体域「要宿主本体的三条」的 **web 处理者**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 三段都逐字沿用迁移前 `platform/web.ts`:
 *  - `saveAs` —— 浏览器里「另存为」不是一次宿主对话框而是一次下载,沙箱里页面自发
 *    的下载会被拦,所以只**承认做不到**并让调用方退回 `<a download>`;
 *  - `openPreview` —— **就地**把这张图交给页内的 `ImagePreviewWindow`(一次本地广播;
 *    迁移前曾先 POST 一次登记再广播同一个 src,那趟往返从来没有人读);
 *  - `openGallery` —— 桌面开的是第二个 BrowserWindow;web 如实地在本地承认一次
 *    不改变任何东西的成功(旧的 `/api/media/gallery/open` 路由实现就是 `{success:true}`)。
 */
import type {
  MediaOpenImageGalleryRequest,
  MediaOpenImagePreviewRequest,
  MediaWindowRoutes,
} from '@shared/ipc/media.js'
import { mediaWindowRouter } from '@shared/ipc/media.js'
import { registerWebShellDomain, type WebShellRouteHandlers } from './registry'

export interface ImagePreviewUpdatePayload {
  mode: 'single'
  previewId?: string
  src?: string
  alt?: string
}

export interface MediaWindowWebShellDeps {
  emitImagePreviewUpdate(payload: ImagePreviewUpdatePayload): void
}

export function createMediaWindowWebShellHandlers(
  deps: MediaWindowWebShellDeps,
): WebShellRouteHandlers<MediaWindowRoutes> {
  return {
    saveAs: async () => ({
      success: false,
      error: 'Saving a copy is not available in the browser.',
    }),
    openPreview: async (request: MediaOpenImagePreviewRequest) => {
      deps.emitImagePreviewUpdate({ mode: 'single', src: request?.src, alt: request?.alt })
      return { success: true }
    },
    openGallery: async (_request: MediaOpenImageGalleryRequest) => ({ success: true }),
  }
}

export function registerMediaWindowWebShellDomain(
  deps: MediaWindowWebShellDeps,
): () => void {
  return registerWebShellDomain(mediaWindowRouter, createMediaWindowWebShellHandlers(deps))
}
