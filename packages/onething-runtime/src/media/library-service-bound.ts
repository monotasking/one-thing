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

const binding: { current?: RuntimeMediaLibraryService } = {}

/** The Backend installs one fixed-path library after acquiring its store lease. */
export function configureMediaLibraryService(instance: RuntimeMediaLibraryService): () => void {
  if (binding.current) throw new Error('Media library has already been assembled')
  binding.current = instance
  return () => { if (binding.current === instance) binding.current = undefined }
}

/** Compatibility calls delegate to the assembled instance; no implicit second writer. */
export const mediaLibraryService = new Proxy({} as RuntimeMediaLibraryService, {
  get(_target, property) {
    const instance = binding.current
    if (!instance) throw new Error('Media library has not been assembled')
    const value = Reflect.get(instance, property)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})
