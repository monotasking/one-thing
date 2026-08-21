/**
 * Media IPC Handlers —— **只剩宿主残留的三条**(结构债 P4c 第三批)。
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
 * 「开预览窗」写进的那本登记簿,和已迁走的 `media.getPreview` 读的是**同一本** ——
 * `@onething/runtime/media/image-preview-registry-bound` 的进程内单例。簿子从
 * 本文件搬到产品层,正是因为它的两半从此不在同一个包里。
 */
import {
  registerElectronMediaIpcHandlers,
  saveElectronMediaFileAs,
  type ElectronImageGalleryRequest,
  type ElectronImagePreviewRequest,
} from '@onething/electron-host/ipc/media'
import {
  openOnethingImageGalleryForIpc,
  openOnethingImagePreviewForIpc,
} from '@onething/runtime/media'
import { imagePreviewRegistry } from '@onething/runtime/media/image-preview-registry-bound'
import { openImagePreviewWindow } from '@onething/electron-host/window'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { MediaSaveAsRequest } from '@shared/ipc.js'

export function registerMediaHandlers() {
  registerElectronMediaIpcHandlers({
    channels: {
      saveAs: IPC_CHANNELS.SAVE_MEDIA_AS,
      openPreview: IPC_CHANNELS.OPEN_IMAGE_PREVIEW,
      openGallery: IPC_CHANNELS.OPEN_IMAGE_GALLERY,
    },
    saveAs: (request: MediaSaveAsRequest) => saveElectronMediaFileAs(request),
    openPreview: (data: ElectronImagePreviewRequest) =>
      openOnethingImagePreviewForIpc({
        registry: imagePreviewRegistry,
        src: data.src,
        alt: data.alt,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
    openGallery: (data: ElectronImageGalleryRequest) =>
      openOnethingImageGalleryForIpc({
        mediaId: data.mediaId,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
  })
}
