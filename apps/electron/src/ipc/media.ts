import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  MediaSaveAsRequest,
  MediaSaveAsResponse,
  MediaSource,
  MediaUsageTag,
} from '@shared/ipc.js'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronMediaIpcChannels {
  listAssets: string
  ingestFiles: string
  saveAs: string
  hideAsset: string
  rebuildLibrary: string
  getGallery: string
  saveImage: string
  loadAll: string
  delete: string
  clearAll: string
  openPreview: string
  getPreview: string
  openGallery: string
  readImageBase64: string
}

export interface ElectronMediaGalleryRequest {
  assetId: string
  query?: unknown
}

export interface ElectronMediaSaveImageRequest {
  url?: string
  base64?: string
  prompt: string
  revisedPrompt?: string
  model: string
  sessionId: string
  messageId: string
  /** Where the bytes came from. Defaults to 'ai-generated' on the service side. */
  source?: MediaSource
  /** What the image is for, e.g. 'persona-avatar'. */
  usageTags?: MediaUsageTag[]
}

export interface ElectronImagePreviewRequest {
  src: string
  alt?: string
}

export interface ElectronImageGalleryRequest {
  mediaId: string
}

/**
 * Host side of 「另存为」. Kept next to the media IPC host (rather than in the
 * main-process adapter) because it is the half that needs `electron` —
 * `apps/electron/src/main/ipc/media.ts` is checker-forbidden from importing it.
 *
 * `showSaveDialog` / `copyFile` are injectable for the same reason the settings
 * host injects its dialog: so the branch logic is unit-testable without a
 * running Electron.
 */
export interface ElectronMediaSaveAsHost {
  showSaveDialog?: typeof dialog.showSaveDialog
  copyFile?(source: string, target: string): Promise<void>
}

export async function saveElectronMediaFileAs(
  request: MediaSaveAsRequest,
  host: ElectronMediaSaveAsHost = {},
): Promise<MediaSaveAsResponse> {
  const sourcePath = request?.filePath || ''
  if (!sourcePath) return { success: false, error: 'No file path provided' }

  const fileName = request.fileName || path.basename(sourcePath)
  const copyFile = host.copyFile ?? ((source: string, target: string) => fs.copyFile(source, target))

  try {
    // A pre-picked directory means the caller already asked once (multi-select
    // save). Popping N dialogs for N files is the behaviour that flow exists
    // to avoid, so this branch never opens one.
    if (request.targetDir) {
      const target = path.join(request.targetDir, fileName)
      await copyFile(sourcePath, target)
      return { success: true, path: target }
    }

    const showSaveDialog = host.showSaveDialog ?? dialog.showSaveDialog
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const result = focusedWindow
      ? await showSaveDialog(focusedWindow, { defaultPath: fileName })
      : await showSaveDialog({ defaultPath: fileName })

    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    await copyFile(sourcePath, result.filePath)
    return { success: true, path: result.filePath }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface RegisterElectronMediaIpcHandlersOptions {
  channels: ElectronMediaIpcChannels
  listAssets(query?: unknown): unknown
  ingestFiles(request: unknown): unknown
  saveAs(request: MediaSaveAsRequest): unknown
  hideAsset(id: string): unknown
  rebuildLibrary(): unknown
  getGallery(request: ElectronMediaGalleryRequest): unknown
  saveImage(request: ElectronMediaSaveImageRequest): unknown
  loadAll(): unknown
  delete(id: string): unknown
  clearAll(): unknown
  openPreview(request: ElectronImagePreviewRequest): unknown
  getPreview(previewId: string): unknown
  openGallery(request: ElectronImageGalleryRequest): unknown
  readImageBase64(filePath: string): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronMediaIpcHandlers(
  options: RegisterElectronMediaIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.listAssets, (_event, query?: unknown) => {
    return options.listAssets(query)
  })

  host.handle(options.channels.ingestFiles, (_event, request?: unknown) => {
    return options.ingestFiles(request)
  })

  host.handle(options.channels.saveAs, (_event, request: MediaSaveAsRequest) => {
    return options.saveAs(request)
  })

  host.handle(options.channels.hideAsset, (_event, id: string) => {
    return options.hideAsset(id)
  })

  host.handle(options.channels.rebuildLibrary, () => {
    return options.rebuildLibrary()
  })

  host.handle(options.channels.getGallery, (_event, request: ElectronMediaGalleryRequest) => {
    return options.getGallery(request)
  })

  host.handle(options.channels.saveImage, (_event, request: ElectronMediaSaveImageRequest) => {
    return options.saveImage(request)
  })

  host.handle(options.channels.loadAll, () => {
    return options.loadAll()
  })

  host.handle(options.channels.delete, (_event, id: string) => {
    return options.delete(id)
  })

  host.handle(options.channels.clearAll, () => {
    return options.clearAll()
  })

  host.handle(options.channels.openPreview, (_event, request: ElectronImagePreviewRequest) => {
    return options.openPreview(request)
  })

  host.handle(options.channels.getPreview, (_event, previewId: string) => {
    return options.getPreview(previewId)
  })

  host.handle(options.channels.openGallery, (_event, request: ElectronImageGalleryRequest) => {
    return options.openGallery(request)
  })

  host.handle(options.channels.readImageBase64, (_event, filePath: string) => {
    return options.readImageBase64(filePath)
  })
}
