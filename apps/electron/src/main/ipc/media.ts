/**
 * Media IPC Handlers
 *
 * Handles saving and loading generated images
 */

import { v4 as uuidv4 } from 'uuid'
import {
  registerElectronMediaIpcHandlers,
  saveElectronMediaFileAs,
  type ElectronImageGalleryRequest,
  type ElectronImagePreviewRequest,
  type ElectronMediaGalleryRequest,
  type ElectronMediaSaveImageRequest,
} from '@onething/electron-host/ipc/media'
import {
  clearOnethingMediaLibrary,
  deleteOnethingMediaItem,
  getOnethingMediaGallery,
  hideOnethingMediaAsset,
  ingestOnethingMediaFilesForIpc,
  listOnethingLegacyMediaImages,
  listOnethingMediaAssets,
  OnethingImagePreviewRegistry,
  openOnethingImageGalleryForIpc,
  openOnethingImagePreviewForIpc,
  readOnethingImageFileDataUrlForIpc,
  rebuildOnethingMediaLibraryForIpc,
  type OnethingMediaIngestLocalFilesInput,
} from '@onething/runtime/media'
import { getSessions } from '@onething/backend/stores/index.js'
import { openImagePreviewWindow } from '@onething/electron-host/window'
import { mediaLibraryService } from '@onething/runtime/media/library-service-bound'
import { saveMediaImage, type MediaItem } from '@onething/runtime/media/save-image'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type {
  MediaAsset,
  MediaIngestFilesResponse,
  MediaQuery,
  MediaSaveAsRequest,
} from '@shared/ipc.js'

export { saveMediaImage, type MediaItem } from '@onething/runtime/media/save-image'

const imagePreviewRegistry = new OnethingImagePreviewRegistry({
  createId: uuidv4,
})

export function registerMediaHandlers() {
  registerElectronMediaIpcHandlers({
    channels: {
      listAssets: IPC_CHANNELS.LIST_MEDIA_ASSETS,
      ingestFiles: IPC_CHANNELS.INGEST_MEDIA_FILES,
      saveAs: IPC_CHANNELS.SAVE_MEDIA_AS,
      hideAsset: IPC_CHANNELS.HIDE_MEDIA_ASSET,
      rebuildLibrary: IPC_CHANNELS.REBUILD_MEDIA_LIBRARY,
      getGallery: IPC_CHANNELS.GET_MEDIA_GALLERY,
      saveImage: 'media:save-image',
      loadAll: 'media:load-all',
      delete: 'media:delete',
      clearAll: 'media:clear-all',
      openPreview: IPC_CHANNELS.OPEN_IMAGE_PREVIEW,
      getPreview: IPC_CHANNELS.GET_IMAGE_PREVIEW,
      openGallery: IPC_CHANNELS.OPEN_IMAGE_GALLERY,
      readImageBase64: 'media:read-image-base64',
    },
    listAssets: async (query?: unknown): Promise<MediaAsset[]> =>
      listOnethingMediaAssets({
        query: (query as MediaQuery | undefined) || {},
        listAssets: mediaQuery => mediaLibraryService.listAssets(mediaQuery),
      }),
    ingestFiles: async (request?: unknown): Promise<MediaIngestFilesResponse> =>
      ingestOnethingMediaFilesForIpc({
        request: (request as OnethingMediaIngestLocalFilesInput | undefined) || { files: [] },
        ingestFiles: input => mediaLibraryService.ingestLocalFiles(input),
        logger: console,
      }),
    saveAs: (request: MediaSaveAsRequest) => saveElectronMediaFileAs(request),
    hideAsset: async (id: string): Promise<{ success: boolean }> =>
      hideOnethingMediaAsset({
        id,
        hideAsset: assetId => mediaLibraryService.hideAsset(assetId),
      }),
    rebuildLibrary: async (): Promise<{
      success: boolean
      added: number
      skipped: number
      error?: string
    }> =>
      rebuildOnethingMediaLibraryForIpc({
        listSessions: getSessions,
        rebuildFromSessions: sessions => mediaLibraryService.rebuildFromSessions(sessions),
        logger: console,
      }),
    getGallery: (data: ElectronMediaGalleryRequest) =>
      getOnethingMediaGallery({
        assetId: data.assetId,
        query: (data.query as MediaQuery | undefined) || {},
        getGallery: (assetId, mediaQuery) => mediaLibraryService.getGallery(assetId, mediaQuery),
      }),
    saveImage: (data: ElectronMediaSaveImageRequest): Promise<MediaItem> =>
      saveMediaImage(data),
    loadAll: (): Promise<MediaItem[]> =>
      listOnethingLegacyMediaImages({
        listLegacyImages: () => mediaLibraryService.listLegacyImages(),
      }),
    delete: (id: string): Promise<boolean> =>
      deleteOnethingMediaItem({
        id,
        hideAsset: assetId => mediaLibraryService.hideAsset(assetId),
      }),
    clearAll: async (): Promise<void> => {
      await clearOnethingMediaLibrary({
        hideAllAssets: () => mediaLibraryService.hideAllAssets(),
      })
    },
    openPreview: (data: ElectronImagePreviewRequest) =>
      openOnethingImagePreviewForIpc({
        registry: imagePreviewRegistry,
        src: data.src,
        alt: data.alt,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
    getPreview: (previewId: string): {
      success: boolean
      src?: string
      alt?: string
      error?: string
    } => imagePreviewRegistry.get(previewId),
    openGallery: (data: ElectronImageGalleryRequest) =>
      openOnethingImageGalleryForIpc({
        mediaId: data.mediaId,
        openPreviewWindow: openImagePreviewWindow,
        logger: console,
      }),
    readImageBase64: (filePath: string): string =>
      readOnethingImageFileDataUrlForIpc(filePath, { logger: console }),
  })
}
