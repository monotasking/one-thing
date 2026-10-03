import { MediaLibraryService, type OnethingMediaLibraryPaths } from '@onething/backend/runtime/media'
import type { RuntimeMediaAdapter, RuntimeRequestContext } from '@onething/backend/server/runtime-facade.js'
import type { SessionAccess } from '@onething/backend/runtime/sessions'
import { mediaFileNameOf, resolveMediaFileByName } from '@onething/backend/runtime/media/resolve-file'

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
      const missing = { success: false, error: 'Media file not found' }
      // 名字能不能取出来先判:取不出就不必为这个 owner 建一本租户库。
      if (!mediaFileNameOf(input)) return missing
      const key = ports.ownerKey(context)
      let service = services.get(key)
      if (!service) { service = new MediaLibraryService(ports.libraryPaths(context)); services.set(key, service) }
      // 按名找路径的判据只在 `runtime/media/resolve-file.ts` 一处(G 线 §23.2),RPC 的
      // `media.readFile` 调的是同一只函数;这里只负责「查哪几本库、按什么顺序」。
      const libraries = [ports.sharedLibrary, service].filter((value): value is MediaLibraryService => !!value)
      const found = resolveMediaFileByName(libraries, ports.access, context, input)
      return found ? { success: true, path: found.path, mimeType: found.mimeType } : missing
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
