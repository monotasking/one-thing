import { describe, expect, it } from 'vitest'
import {
  OnethingImagePreviewRegistry,
  openOnethingImageGalleryForIpc,
  openOnethingImagePreviewForIpc,
  type OnethingImagePreviewWindowRequest,
} from '../image-preview-registry.js'

describe('OnethingImagePreviewRegistry', () => {
  it('creates and resolves image preview records', () => {
    let nextId = 0
    const registry = new OnethingImagePreviewRegistry({
      createId: () => `preview-${++nextId}`,
      now: () => 1000,
    })

    const id = registry.create('data:image/png;base64,abc', 'Example')

    expect(id).toBe('preview-1')
    expect(registry.get(id)).toEqual({
      success: true,
      src: 'data:image/png;base64,abc',
      alt: 'Example',
    })
  })

  it('prunes expired records before lookup', () => {
    let now = 1000
    const registry = new OnethingImagePreviewRegistry({
      ttlMs: 100,
      createId: () => 'preview-1',
      now: () => now,
    })

    const id = registry.create('src')
    now = 1201

    expect(registry.get(id)).toEqual({
      success: false,
      error: 'Image preview expired or was not found',
    })
  })

  it('keeps only the newest records when maxRecords is exceeded', () => {
    let nextId = 0
    const registry = new OnethingImagePreviewRegistry({
      maxRecords: 2,
      createId: () => `preview-${++nextId}`,
      now: () => nextId,
    })

    const first = registry.create('first')
    const second = registry.create('second')
    const third = registry.create('third')

    expect(registry.get(first)).toEqual({
      success: false,
      error: 'Image preview expired or was not found',
    })
    expect(registry.get(second)).toMatchObject({ success: true, src: 'second' })
    expect(registry.get(third)).toMatchObject({ success: true, src: 'third' })
  })

  it('opens image previews through a host adapter', async () => {
    const opened: OnethingImagePreviewWindowRequest[] = []
    const registry = new OnethingImagePreviewRegistry({
      createId: () => 'preview-1',
      now: () => 1000,
    })

    await expect(openOnethingImagePreviewForIpc({
      registry,
      src: 'data:image/png;base64,abc',
      alt: 'Example',
      openPreviewWindow: request => {
        opened.push(request)
      },
    })).resolves.toEqual({
      success: true,
      previewId: 'preview-1',
    })

    expect(opened).toEqual([
      { mode: 'single', previewId: 'preview-1', alt: 'Example' },
    ])
    expect(registry.get('preview-1')).toMatchObject({
      success: true,
      src: 'data:image/png;base64,abc',
      alt: 'Example',
    })
  })

  it('opens image galleries through a host adapter', async () => {
    const opened: OnethingImagePreviewWindowRequest[] = []

    await expect(openOnethingImageGalleryForIpc({
      mediaId: 'asset-1',
      openPreviewWindow: request => {
        opened.push(request)
      },
    })).resolves.toEqual({ success: true })

    expect(opened).toEqual([{ mode: 'gallery', mediaId: 'asset-1' }])
  })

  it('normalizes image preview host failures', async () => {
    const registry = new OnethingImagePreviewRegistry({
      createId: () => 'preview-1',
    })

    await expect(openOnethingImagePreviewForIpc({
      registry,
      src: 'src',
      openPreviewWindow: () => {
        throw new Error('Window unavailable')
      },
    })).resolves.toEqual({
      success: false,
      error: 'Window unavailable',
    })
  })
})
