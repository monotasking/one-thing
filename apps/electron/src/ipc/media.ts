import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { MediaSaveAsRequest, MediaSaveAsResponse } from '@shared/ipc.js'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

/**
 * 媒体域**留在宿主侧的三条**(结构债 P4c 第三批)。十一条数据面已迁到通用
 * `rpc:invoke` / `POST /api/rpc`(`mediaRouter`);这里只剩要宿主本体的那三件:
 * 一次原生保存对话框 + 两个 `BrowserWindow`。
 */
export interface ElectronMediaIpcChannels {
  saveAs: string
  openPreview: string
  openGallery: string
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
  saveAs(request: MediaSaveAsRequest): unknown
  openPreview(request: ElectronImagePreviewRequest): unknown
  openGallery(request: ElectronImageGalleryRequest): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronMediaIpcHandlers(
  options: RegisterElectronMediaIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.saveAs, (_event, request: MediaSaveAsRequest) => {
    return options.saveAs(request)
  })

  host.handle(options.channels.openPreview, (_event, request: ElectronImagePreviewRequest) => {
    return options.openPreview(request)
  })

  host.handle(options.channels.openGallery, (_event, request: ElectronImageGalleryRequest) => {
    return options.openGallery(request)
  })
}
