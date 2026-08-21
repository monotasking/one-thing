import type {
  OnethingLegacyMediaItem,
  OnethingMediaIngestGeneratedImageInput,
} from './index.js'
import { mediaLibraryService } from './library-service-bound.js'

export type MediaItem = OnethingLegacyMediaItem

export async function saveMediaImage(
  data: OnethingMediaIngestGeneratedImageInput,
): Promise<MediaItem> {
  return mediaLibraryService.saveGeneratedImageAsLegacyItem(data)
}
