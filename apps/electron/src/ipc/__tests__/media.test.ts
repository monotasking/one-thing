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
  it('registers media handlers against the provided IPC host', async () => {
    const handle = vi.fn()
    const listAssets = vi.fn().mockResolvedValue([{ id: 'asset-1' }])
    const hideAsset = vi.fn().mockResolvedValue({ success: true })
    const rebuildLibrary = vi.fn().mockResolvedValue({ success: true, added: 1, skipped: 0 })
    const getGallery = vi.fn().mockResolvedValue({ success: true, assets: [] })
    const saveImage = vi.fn().mockResolvedValue({ id: 'item-1' })
    const loadAll = vi.fn().mockResolvedValue([{ id: 'item-1' }])
    const deleteMedia = vi.fn().mockResolvedValue(true)
    const clearAll = vi.fn().mockResolvedValue(undefined)
    const openPreview = vi.fn().mockResolvedValue({ success: true, previewId: 'preview-1' })
    const getPreview = vi.fn().mockReturnValue({ success: true, src: 'media://preview-1' })
    const openGallery = vi.fn().mockResolvedValue({ success: true })
    const readImageBase64 = vi.fn().mockReturnValue('data:image/png;base64,abc')
    const ingestFiles = vi.fn().mockResolvedValue({
      success: true, assets: [], created: 1, skipped: 0, errors: [],
    })
    const saveAs = vi.fn().mockResolvedValue({ success: true, path: '/tmp/copy.png' })

    registerElectronMediaIpcHandlers({
      channels: {
        listAssets: 'media:list-assets',
        ingestFiles: 'media:ingest-files',
        saveAs: 'media:save-as',
        hideAsset: 'media:hide-asset',
        rebuildLibrary: 'media:rebuild-library',
        getGallery: 'media:get-gallery',
        saveImage: 'media:save-image',
        loadAll: 'media:load-all',
        delete: 'media:delete',
        clearAll: 'media:clear-all',
        openPreview: 'image-preview:open',
        getPreview: 'image-preview:get',
        openGallery: 'image-gallery:open',
        readImageBase64: 'media:read-image-base64',
      },
      listAssets,
      ingestFiles,
      saveAs,
      hideAsset,
      rebuildLibrary,
      getGallery,
      saveImage,
      loadAll,
      delete: deleteMedia,
      clearAll,
      openPreview,
      getPreview,
      openGallery,
      readImageBase64,
      ipcMain: { handle },
    })

    expect(handle).toHaveBeenCalledTimes(14)
    expect(handle.mock.calls.map(call => call[0])).toEqual([
      'media:list-assets',
      'media:ingest-files',
      'media:save-as',
      'media:hide-asset',
      'media:rebuild-library',
      'media:get-gallery',
      'media:save-image',
      'media:load-all',
      'media:delete',
      'media:clear-all',
      'image-preview:open',
      'image-preview:get',
      'image-gallery:open',
      'media:read-image-base64',
    ])

    const query = { kind: 'image' }
    const galleryRequest = { assetId: 'asset-1', query }
    const saveRequest = {
      base64: 'abc',
      prompt: 'hello',
      model: 'gpt-image',
      sessionId: 'session-1',
      messageId: 'message-1',
    }
    const previewRequest = { src: 'media://asset-1', alt: 'asset' }
    const galleryOpenRequest = { mediaId: 'asset-1' }

    /* 按**通道名**取 handler,不按下标 —— 加一条通道不该让十二条断言全体位移。 */
    const listener = (channel: string) =>
      handle.mock.calls.find(call => call[0] === channel)![1]

    const ingestRequest = { files: [{ filePath: '/tmp/a.pdf', fileName: 'a.pdf' }] }
    const saveAsRequest = { filePath: '/tmp/a.png', fileName: 'a.png' }

    await expect(listener('media:list-assets')({}, query)).resolves.toEqual([{ id: 'asset-1' }])
    await expect(listener('media:ingest-files')({}, ingestRequest)).resolves.toEqual({
      success: true, assets: [], created: 1, skipped: 0, errors: [],
    })
    await expect(listener('media:save-as')({}, saveAsRequest)).resolves.toEqual({
      success: true,
      path: '/tmp/copy.png',
    })
    await expect(listener('media:hide-asset')({}, 'asset-1')).resolves.toEqual({ success: true })
    await expect(listener('media:rebuild-library')({})).resolves.toEqual({ success: true, added: 1, skipped: 0 })
    await expect(listener('media:get-gallery')({}, galleryRequest)).resolves.toEqual({ success: true, assets: [] })
    await expect(listener('media:save-image')({}, saveRequest)).resolves.toEqual({ id: 'item-1' })
    await expect(listener('media:load-all')({})).resolves.toEqual([{ id: 'item-1' }])
    await expect(listener('media:delete')({}, 'item-1')).resolves.toBe(true)
    await expect(listener('media:clear-all')({})).resolves.toBeUndefined()
    await expect(listener('image-preview:open')({}, previewRequest)).resolves.toEqual({
      success: true,
      previewId: 'preview-1',
    })
    expect(listener('image-preview:get')({}, 'preview-1')).toEqual({ success: true, src: 'media://preview-1' })
    await expect(listener('image-gallery:open')({}, galleryOpenRequest)).resolves.toEqual({ success: true })
    expect(listener('media:read-image-base64')({}, '/tmp/image.png')).toBe('data:image/png;base64,abc')

    expect(ingestFiles).toHaveBeenCalledWith(ingestRequest)
    expect(saveAs).toHaveBeenCalledWith(saveAsRequest)
    expect(listAssets).toHaveBeenCalledWith(query)
    expect(hideAsset).toHaveBeenCalledWith('asset-1')
    expect(rebuildLibrary).toHaveBeenCalledWith()
    expect(getGallery).toHaveBeenCalledWith(galleryRequest)
    expect(saveImage).toHaveBeenCalledWith(saveRequest)
    expect(loadAll).toHaveBeenCalledWith()
    expect(deleteMedia).toHaveBeenCalledWith('item-1')
    expect(clearAll).toHaveBeenCalledWith()
    expect(openPreview).toHaveBeenCalledWith(previewRequest)
    expect(getPreview).toHaveBeenCalledWith('preview-1')
    expect(openGallery).toHaveBeenCalledWith(galleryOpenRequest)
    expect(readImageBase64).toHaveBeenCalledWith('/tmp/image.png')
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
