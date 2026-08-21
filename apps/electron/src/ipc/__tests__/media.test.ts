import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  getFocusedWindow: vi.fn(() => null),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
  },
  BrowserWindow: {
    getFocusedWindow: electronMocks.getFocusedWindow,
  },
}))

import { registerElectronMediaIpcHandlers, saveElectronMediaFileAs } from '../media.js'

describe('electron media IPC host', () => {
  it('registers the three host-residual handlers against the provided IPC host', async () => {
    // P4c 第三批之后这只工厂只剩「要宿主本体」的三条:一次原生保存对话框 +
    // 两个 BrowserWindow。十一条数据面走通用 RPC 通道,由
    // `packages/backend/rpc/__tests__/media-domain.test.ts` 钉。
    const handle = vi.fn()
    const saveAs = vi.fn().mockResolvedValue({ success: true, path: '/tmp/copy.png' })
    const openPreview = vi.fn().mockResolvedValue({ success: true, previewId: 'preview-1' })
    const openGallery = vi.fn().mockResolvedValue({ success: true })

    registerElectronMediaIpcHandlers({
      channels: {
        saveAs: 'media:save-as',
        openPreview: 'image-preview:open',
        openGallery: 'image-gallery:open',
      },
      saveAs,
      openPreview,
      openGallery,
      ipcMain: { handle },
    })

    expect(handle).toHaveBeenCalledTimes(3)
    expect(handle.mock.calls.map(call => call[0])).toEqual([
      'media:save-as',
      'image-preview:open',
      'image-gallery:open',
    ])

    /* 按**通道名**取 handler,不按下标 —— 加一条通道不该让断言全体位移。 */
    const listener = (channel: string) =>
      handle.mock.calls.find(call => call[0] === channel)![1]

    const saveAsRequest = { filePath: '/tmp/a.png', fileName: 'a.png' }
    const previewRequest = { src: 'media://asset-1', alt: 'asset' }
    const galleryOpenRequest = { mediaId: 'asset-1' }

    await expect(listener('media:save-as')({}, saveAsRequest)).resolves.toEqual({
      success: true,
      path: '/tmp/copy.png',
    })
    await expect(listener('image-preview:open')({}, previewRequest)).resolves.toEqual({
      success: true,
      previewId: 'preview-1',
    })
    await expect(listener('image-gallery:open')({}, galleryOpenRequest)).resolves.toEqual({ success: true })

    expect(saveAs).toHaveBeenCalledWith(saveAsRequest)
    expect(openPreview).toHaveBeenCalledWith(previewRequest)
    expect(openGallery).toHaveBeenCalledWith(galleryOpenRequest)
  })
})

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
