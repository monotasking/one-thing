import { describe, expect, it, vi } from 'vitest'
import {
  resolveOnethingMarkdownAssetForIpc,
  saveOnethingMarkdownAttachmentsForIpc,
} from '../ipc-operations.js'

const request = {
  documentPath: '/notes/today.md',
  workspaceRoot: '/notes',
  rawTarget: 'image.png',
}

describe('Markdown IPC operations', () => {
  it('wraps resolved assets in the renderer response shape', async () => {
    const resolveAsset = vi.fn(async () => ({
      kind: 'image' as const,
      rawTarget: 'image.png',
      absolutePath: '/notes/image.png',
    }))

    await expect(resolveOnethingMarkdownAssetForIpc({ request, resolveAsset }))
      .resolves.toEqual({
        success: true,
        asset: {
          kind: 'image',
          rawTarget: 'image.png',
          absolutePath: '/notes/image.png',
        },
      })
    expect(resolveAsset).toHaveBeenCalledWith(request)
  })

  it('normalizes resolve and save failures for IPC callers', async () => {
    await expect(resolveOnethingMarkdownAssetForIpc({
      request,
      resolveAsset: async () => {
        throw new Error('missing asset')
      },
    })).resolves.toEqual({
      success: false,
      error: 'missing asset',
    })

    await expect(saveOnethingMarkdownAttachmentsForIpc({
      request: { ...request, files: [] },
      saveAttachments: async () => {
        throw new Error('disk failed')
      },
    })).resolves.toEqual({
      success: false,
      error: 'disk failed',
      code: 'INTERNAL',
    })
  })
})
