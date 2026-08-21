import {
  MediaLibraryService as RuntimeMediaLibraryService,
  type OnethingMediaLibraryPaths,
} from './index.js'
import {
  getOnethingMediaFilesDir,
  getOnethingMediaImagesDir,
  getOnethingMediaIndexPath,
} from '../storage/index.js'
function defaultPaths(): OnethingMediaLibraryPaths {
  return {
    indexPath: getOnethingMediaIndexPath(),
    imagesDir: getOnethingMediaImagesDir(),
    filesDir: getOnethingMediaFilesDir(),
  }
}

export class MediaLibraryService extends RuntimeMediaLibraryService {
  constructor(paths: OnethingMediaLibraryPaths = defaultPaths()) {
    super(paths)
  }
}

export const mediaLibraryService = new MediaLibraryService()
