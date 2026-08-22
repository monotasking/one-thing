import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { MediaSaveAsRequest, MediaSaveAsResponse } from '@shared/ipc.js'

/**
 * 媒体域**留在宿主侧的三条**(结构债 P4c 第三批)的那半个实现。十一条数据面已迁到
 * 通用 `rpc:invoke` / `POST /api/rpc`(`mediaRouter`);要宿主本体的三条于 A1-a
 * (2026-08-23)改走宿主壳路由(`mediaWindowRouter`),注册工厂与那三份请求形状
 * 随之搬进契约 / 处理者表 —— 本文件只留「另存为」这件真要 `electron` 的实现。
 */

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
