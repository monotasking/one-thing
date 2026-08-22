/**
 * Media 的**宿主残留三条**接线。
 *
 * 十一条数据面(listAssets / ingestFiles / hideAsset / rebuildLibrary /
 * getGallery / saveImage / loadAll / delete / clearAll / readImageBase64 /
 * getPreview)已整只搬到通用 RPC 通道 —— `@shared/ipc/media.js` 的 `mediaRouter`
 * + `@onething/backend/rpc/domains/media`,桌面走 `rpc:invoke`、web 走
 * `POST /api/rpc`,两边同一份实现。
 *
 * 留在这里的三条要的是**宿主本体**而不是数据:
 *  - `saveAs` —— 一次原生保存对话框(`saveElectronMediaFileAs`);
 *  - `openPreview` / `openGallery` —— 两个 `BrowserWindow`(`openImagePreviewWindow`)。
 *
 * 它们于 2026-08-23(结构债 P4 终态批 A1-a)从三条手写通道改为**宿主
 * 壳路由**上的一份处理者表(`mediaWindowRouter` →
 * `@onething/electron-host/ipc/shell/media-window`),形状与语义逐字不变。
 *
 * 「开预览窗」写进的那本登记簿,和已迁走的 `media.getPreview` 读的是**同一本** ——
 * `@onething/runtime/media/image-preview-registry-bound` 的进程内单例。簿子从
 * 本文件搬到产品层,正是因为它的两半从此不在同一个包里。
 */
import { saveElectronMediaFileAs } from '@onething/electron-host/ipc/media'
import { registerMediaWindowShellDomain } from '@onething/electron-host/ipc/shell/media-window'
import {
  openOnethingImageGalleryForIpc,
  openOnethingImagePreviewForIpc,
} from '@onething/runtime/media'
import { imagePreviewRegistry } from '@onething/runtime/media/image-preview-registry-bound'
import { openImagePreviewWindow } from '@onething/electron-host/window'
import type {
  MediaOpenImageGalleryRequest,
  MediaOpenImagePreviewRequest,
  MediaSaveAsRequest,
} from '@shared/ipc.js'

export function registerMediaHandlers() {
  registerMediaWindowShellDomain({
    saveAs: (request: MediaSaveAsRequest) => saveElectronMediaFileAs(request),
    openPreview: (data: MediaOpenImagePreviewRequest) =>
      openOnethingImagePreviewForIpc({
        registry: imagePreviewRegistry,
        src: data.src,
        alt: data.alt,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
    openGallery: (data: MediaOpenImageGalleryRequest) =>
      openOnethingImageGalleryForIpc({
        mediaId: data.mediaId,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
  })
}
