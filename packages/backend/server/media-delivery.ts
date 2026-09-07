import { basename, isAbsolute, relative } from 'node:path'
import { MediaLibraryService, type OnethingMediaLibraryPaths } from '@onething/runtime/media'
import { canonicalizeStorePath } from '@onething/runtime/storage'
import type { RuntimeMediaAdapter, RuntimeRequestContext } from '@onething/core/runtime-facade'
import { SessionAccessError, type SessionAccess } from '../session/access.js'
import { assertMediaAccess } from '../wiring/media/access.js'

export interface ServerMediaDeliveryPorts {
  defaultContext(): RuntimeRequestContext
  ownerKey(context: RuntimeRequestContext): string
  libraryPaths(context: RuntimeRequestContext): OnethingMediaLibraryPaths
  access: Pick<SessionAccess, 'resolve'>
  sharedLibrary?: MediaLibraryService
}

/** Byte lookup and event subscriptions for one server surface; paths come from its host. */
export function createServerMediaDelivery(ports: ServerMediaDeliveryPorts) {
  const services = new Map<string, MediaLibraryService>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let disposed = false
  const adapter: RuntimeMediaAdapter = {
    async resolveFile(input, context = ports.defaultContext()) {
      if (disposed) return { success: false, error: 'Media delivery has been disposed' }
      const trimmed = input.trim()
      const encoded = trimmed.startsWith('/api/media/file/') ? trimmed.slice('/api/media/file/'.length)
        : trimmed.startsWith('media://') ? trimmed.slice('media://'.length) : undefined
      const missing = { success: false, error: 'Media file not found' }
      let fileName: string
      try {
        const decoded = encoded === undefined ? trimmed : decodeURIComponent(encoded)
        fileName = basename(decoded)
        if (encoded !== undefined && decoded !== fileName) return missing
      } catch { return missing }
      if (!fileName || fileName === '.' || fileName === '..') return missing
      const key = ports.ownerKey(context)
      const paths = ports.libraryPaths(context)
      let service = services.get(key)
      if (!service) { service = new MediaLibraryService(paths); services.set(key, service) }
      for (const library of [ports.sharedLibrary, service].filter((value): value is MediaLibraryService => !!value)) {
        const roots = library.storagePaths()
        const matches = library.listAssetAccess().filter(asset => asset.filePath && basename(asset.filePath) === fileName)
        try { for (const asset of matches) assertMediaAccess(ports.access, context, asset) }
        catch (error) { if (error instanceof SessionAccessError) return missing; throw error }
        for (const asset of matches) {
          const path = canonicalizeStorePath(asset.filePath!)
          if (![roots.imagesDir, roots.filesDir].some(root => isInside(path, canonicalizeStorePath(root)))) return missing
          return { success: true, path, mimeType: library.getAsset(asset.id)?.mimeType }
        }
      }
      return missing
    },
    subscribeImageGenerated(handler, context = ports.defaultContext()) {
      if (disposed) return () => {}
      const key = ports.ownerKey(context)
      let handlers = listeners.get(key)
      if (!handlers) { handlers = new Set(); listeners.set(key, handlers) }
      handlers.add(handler)
      return () => { handlers.delete(handler); if (!handlers.size) listeners.delete(key) }
    },
  }
  return { adapter, dispose(): void { disposed = true; listeners.clear(); services.clear() } }
}

function isInside(candidate: string, root: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
