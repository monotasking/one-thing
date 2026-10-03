import { describe, expect, it, vi } from 'vitest'
import {
  clearOnethingMediaLibrary,
  deleteOnethingMediaItem,
  getOnethingMediaGallery,
  hideOnethingMediaAsset,
  listOnethingLegacyMediaImages,
  listOnethingMediaAssets,
  rebuildOnethingMediaLibrary,
  rebuildOnethingMediaLibraryForIpc,
} from '../media-library-presentation.js'

describe('media library presentation runtime', () => {
  it('lists media assets and gallery data through supplied adapters', async () => {
    const assets = [{ id: 'a' }, { id: 'b' }]
    const query = { kind: 'image' }
    const listAssets = vi.fn(() => assets)
    const getGallery = vi.fn(() => ({ images: assets, currentIndex: 1 }))

    await expect(listOnethingMediaAssets({
      query,
      listAssets,
    })).resolves.toEqual(assets)

    await expect(getOnethingMediaGallery({
      assetId: 'b',
      query,
      getGallery,
    })).resolves.toEqual({
      images: assets,
      currentIndex: 1,
    })

    expect(listAssets).toHaveBeenCalledWith(query)
    expect(getGallery).toHaveBeenCalledWith('b', query)
  })

  it('wraps hide and rebuild operations in stable result shapes', async () => {
    const hideAsset = vi.fn(() => true)
    const sessions = [{ id: 's1' }]
    const rebuildFromSessions = vi.fn(() => ({ added: 2, skipped: 1 }))

    await expect(hideOnethingMediaAsset({
      id: 'asset-1',
      hideAsset,
    })).resolves.toEqual({ success: true })

    await expect(rebuildOnethingMediaLibrary({
      sessions,
      rebuildFromSessions,
    })).resolves.toEqual({
      success: true,
      added: 2,
      skipped: 1,
    })

    expect(hideAsset).toHaveBeenCalledWith('asset-1')
    expect(rebuildFromSessions).toHaveBeenCalledWith(sessions)
  })

  it('handles legacy list, delete, and clear operations through adapters', async () => {
    const items = [{ id: 'legacy-1' }]
    const listLegacyImages = vi.fn(() => items)
    const hideAsset = vi.fn(() => false)
    const hideAllAssets = vi.fn()

    await expect(listOnethingLegacyMediaImages({
      listLegacyImages,
    })).resolves.toEqual(items)

    await expect(deleteOnethingMediaItem({
      id: 'legacy-1',
      hideAsset,
    })).resolves.toBe(false)

    await expect(clearOnethingMediaLibrary({
      hideAllAssets,
    })).resolves.toBeUndefined()

    expect(listLegacyImages).toHaveBeenCalledTimes(1)
    expect(hideAsset).toHaveBeenCalledWith('legacy-1')
    expect(hideAllAssets).toHaveBeenCalledTimes(1)
  })

  it('normalizes rebuild failures for IPC callers', async () => {
    const logger = { error: vi.fn() }
    const listSessions = vi.fn(() => [{ id: 's1' }])
    const rebuildFromSessions = vi.fn(() => {
      throw new Error('rebuild failed')
    })

    await expect(rebuildOnethingMediaLibraryForIpc({
      listSessions,
      rebuildFromSessions,
      logger,
    })).resolves.toEqual({
      success: false,
      added: 0,
      skipped: 0,
      error: 'rebuild failed',
    })

    expect(listSessions).toHaveBeenCalled()
    expect(rebuildFromSessions).toHaveBeenCalledWith([{ id: 's1' }])
    expect(logger.error).toHaveBeenCalled()
  })
})
