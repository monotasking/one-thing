import type { OnethingLegacyMediaItem, OnethingMediaIngestGeneratedImageInput } from './media-library-service.js'
import { mediaLibraryService } from './media-library-service-bound.js'

export type MediaItem = OnethingLegacyMediaItem

export async function saveMediaImage(
  data: OnethingMediaIngestGeneratedImageInput,
): Promise<MediaItem> {
  return mediaLibraryService.saveGeneratedImageAsLegacyItem(data)
}
