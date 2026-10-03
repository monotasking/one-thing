import { describe, expect, it, vi } from 'vitest'
import {
  getOnethingImageMimeTypeFromPath,
  onethingImageBufferToDataUrl,
  readOnethingImageFileDataUrlForIpc,
} from '../image-file-data-url.js'

describe('image file data URL helpers', () => {
  it('maps image paths to display MIME types', () => {
    expect(getOnethingImageMimeTypeFromPath('/tmp/photo.jpg')).toBe('image/jpeg')
    expect(getOnethingImageMimeTypeFromPath('/tmp/photo.jpeg')).toBe('image/jpeg')
    expect(getOnethingImageMimeTypeFromPath('/tmp/anim.gif')).toBe('image/gif')
    expect(getOnethingImageMimeTypeFromPath('/tmp/image.webp')).toBe('image/webp')
    expect(getOnethingImageMimeTypeFromPath('/tmp/unknown')).toBe('image/png')
  })

  it('serializes image buffers to data URLs', () => {
    expect(onethingImageBufferToDataUrl(Buffer.from('hello'), '/tmp/image.webp')).toBe(
      'data:image/webp;base64,aGVsbG8=',
    )
  })

  it('logs and rethrows read failures for IPC callers', () => {
    const logger = { error: vi.fn() }

    expect(() => readOnethingImageFileDataUrlForIpc('/tmp/missing-image.png', {
      logger,
    })).toThrow()
    expect(logger.error).toHaveBeenCalled()
  })
})
