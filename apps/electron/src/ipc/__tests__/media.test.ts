import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  getFocusedWindow: vi.fn(() => null),
}))

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
  },
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
  },
}))

import { saveElectronMediaFileAs } from '../media.js'

// 「要宿主本体的三条」的**注册**于 A1-a 搬到宿主壳路由
// (`ipc/shell/media-window.ts`,由 `ipc/__tests__/shell-domains.test.ts` 钉);
// 本文件只留「另存为」这件真要 electron 的实现。
describe('saveElectronMediaFileAs', () => {
  it('copies straight into a pre-picked directory without opening a dialog', async () => {
    const copyFile = vi.fn().mockResolvedValue(undefined)
    const showSaveDialog = vi.fn()

    await expect(saveElectronMediaFileAs(
      { filePath: '/store/media/files/abc.pdf', fileName: 'brief.pdf', targetDir: '/Users/me/Desktop' },
      { copyFile, showSaveDialog: showSaveDialog as never },
    )).resolves.toEqual({ success: true, path: '/Users/me/Desktop/brief.pdf' })

    expect(copyFile).toHaveBeenCalledWith('/store/media/files/abc.pdf', '/Users/me/Desktop/brief.pdf')
    // 多选另存只问一次目录 —— 逐个文件再弹框正是这条分支要避免的。
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('opens a save dialog when no directory was picked, and reports a cancel as a cancel', async () => {
    const copyFile = vi.fn().mockResolvedValue(undefined)
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: true, filePath: undefined })

    await expect(saveElectronMediaFileAs(
      { filePath: '/store/a.png', fileName: 'a.png' },
      { copyFile, showSaveDialog: showSaveDialog as never },
    )).resolves.toEqual({ success: false, canceled: true })

    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'a.png' })
    expect(copyFile).not.toHaveBeenCalled()
  })

  it('surfaces a copy failure instead of claiming success', async () => {
    const copyFile = vi.fn().mockRejectedValue(new Error('EACCES'))
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: false, filePath: '/Users/me/a.png' })

    await expect(saveElectronMediaFileAs(
      { filePath: '/store/a.png' },
      { copyFile, showSaveDialog: showSaveDialog as never },
    )).resolves.toEqual({ success: false, error: 'EACCES' })
  })

  it('refuses an empty source path', async () => {
    await expect(saveElectronMediaFileAs({ filePath: '' })).resolves.toEqual({
      success: false,
      error: 'No file path provided',
    })
  })
})
