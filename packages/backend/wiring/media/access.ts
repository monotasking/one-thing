import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizeStorePath } from '@onething/runtime/storage'
import type { OnethingMediaAssetAccess, OnethingMediaLibraryService } from '@onething/runtime/media'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { DEFAULT_SESSION_OWNER, SessionAccessError, ownerMatchesContext, ownsSessionRecord, type SessionAccess, type SessionAccessContext, type SessionAccessOperation } from '../../session/access.js'
import { isPathInside, resolveInsideSandbox, resolveRpcSandbox, type RpcSandbox } from '../../rpc/sandbox.js'

/** Every source must still exist and be visible. Orphan links never become local uploads. */
export function assertMediaAccess(access: Pick<SessionAccess, 'resolve'>, context: SessionAccessContext, asset: OnethingMediaAssetAccess, operation: SessionAccessOperation = 'read'): void {
  const links = asset.links ?? []
  if (links.some(link => (link.sessionId !== undefined || link.messageId || link.attachmentId) && (typeof link.sessionId !== 'string' || !link.sessionId))) throw new SessionAccessError()
  const sessions = links.map(link => link.sessionId).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (sessions.length) {
    for (const id of new Set(sessions)) access.resolve(context, id, operation)
  } else {
    if (links.some(link => link.sessionId !== undefined || link.messageId || link.attachmentId)) throw new SessionAccessError()
    if (!ownsSessionRecord(asset, context)) throw new SessionAccessError()
  }
}

export function mediaVisible(access: Pick<SessionAccess, 'resolve'>, context: SessionAccessContext) {
  return (asset: OnethingMediaAssetAccess): boolean => {
    try { assertMediaAccess(access, context, asset); return true }
    catch (error) { if (error instanceof SessionAccessError) return false; throw error }
  }
}

/** The local operator keeps native file picking; other identities always need the host sandbox. */
export function mediaSandbox(context: RpcDispatchContext): RpcSandbox {
  const sandbox = resolveRpcSandbox(context)
  if (sandbox.confined || ownerMatchesContext(DEFAULT_SESSION_OWNER, context)) return sandbox
  if (!context.sandboxRoot || !isAbsolute(context.sandboxRoot)) throw new SessionAccessError()
  return { confined: true, root: context.sandboxRoot }
}

export function resolveMediaInputPath(context: RpcDispatchContext, requested: string): string {
  const sandbox = mediaSandbox(context)
  const resolved = resolveInsideSandbox(sandbox, requested)
  if (!resolved) throw new SessionAccessError()
  const canonical = canonicalizeStorePath(resolved)
  if (sandbox.confined && !isPathInside(canonical, canonicalizeStorePath(sandbox.root))) throw new SessionAccessError()
  return canonical
}

export function assertMediaPathSources(library: Pick<OnethingMediaLibraryService, 'listAssetAccess'>, access: Pick<SessionAccess, 'resolve'>, context: SessionAccessContext, candidate: string): OnethingMediaAssetAccess[] {
  const canonical = canonicalizeStorePath(candidate)
  const records = library.listAssetAccess().filter(asset => [asset.filePath, asset.thumbnailPath].some(file => file && canonicalizeStorePath(file) === canonical))
  for (const asset of records) assertMediaAccess(access, context, asset)
  return records
}

/** Path authorization stays separate from the runtime's image-to-data-URL conversion. */
export function createMediaPathAccess(library: Pick<OnethingMediaLibraryService, 'listAssetAccess' | 'storagePaths'>, access: Pick<SessionAccess, 'resolve'>) {
  function readPath(context: RpcDispatchContext, requested: string): string {
    const canonical = canonicalizeStorePath(requested)
    const records = assertMediaPathSources(library, access, context, canonical)
    if (records.length) {
      const paths = library.storagePaths()
      if ([paths.imagesDir, paths.filesDir].some(root => isPathInside(canonical, canonicalizeStorePath(root)))) return canonical
    }
    return resolveMediaInputPath(context, requested)
  }
  function previewSource(context: RpcDispatchContext, source: string): void {
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source)
      if (url.pathname.startsWith('/api/media/file/')) source = url.pathname
    }
    const prefix = source.startsWith('media://') ? 'media://' : source.startsWith('/api/media/file/') ? '/api/media/file/' : undefined
    if (prefix) {
      const name = decodeURIComponent(source.slice(prefix.length))
      const records = library.listAssetAccess().filter(asset => asset.filePath && basename(asset.filePath) === name)
      if (!records.length) throw new SessionAccessError()
      records.forEach(asset => assertMediaAccess(access, context, asset))
    } else if (source.startsWith('file://')) readPath(context, fileURLToPath(source))
    else if (isAbsolute(source)) readPath(context, source)
  }
  return { readPath, previewSource }
}
