import path from 'node:path'
import { applyVisibility, type SearchContext } from '@onething/core/search'
import { canonicalizeStorePath } from '@onething/runtime/storage'
import { resolveDailyNoteSearchDirs, type OnethingSearchProvidersAdapters, type SearchServiceOptions } from '@onething/runtime/search'
import { DEFAULT_SESSION_OWNER, SessionAccessError, ownerMatchesContext, createSessionAccess } from '../../session/access.js'
import { fixedExecutionContext } from '../engine/execution-context.js'
import { getConnectedDirectories, getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'

/** Global notes, prompts and plugin catalogs are owned by the local operator. */
export function createAppSearchAuthorization(adapters: OnethingSearchProvidersAdapters) {
  const access = createSessionAccess({ findMeta: id => adapters.getSessionsList().find(meta => meta.id === id) })
  const owner = (ctx: SearchContext) => fixedExecutionContext(ctx.executionContext)
  const operator = (ctx: SearchContext) => ownerMatchesContext(DEFAULT_SESSION_OWNER, owner(ctx))
  function assertOperator(ctx: SearchContext): void {
    if (!operator(ctx)) throw new SessionAccessError()
  }
  function assertSource(ctx: SearchContext): void {
    if (ctx.principal.sessionId) access.resolve(owner(ctx), ctx.principal.sessionId, 'read')
  }
  function fileRoots(ctx: SearchContext): string[] {
    assertSource(ctx)
    const roots = access.filter(owner(ctx), adapters.getSessionsList())
      .flatMap(meta => typeof meta.workingDirectory === 'string' ? [meta.workingDirectory] : [])
    if (operator(ctx)) {
      const variables = adapters.getVariablesStore()
      roots.push(...[variables.getUserNoteDir(), variables.getWorkNoteDir()].filter((value): value is string => !!value))
      const current = ctx.principal.sessionId ?? adapters.getCurrentSessionId()
      const allowedCurrent = current && access.filterIds(owner(ctx), [current]).length > 0
      roots.push(...(allowedCurrent ? getConnectedDirectoriesForSession(current) : getConnectedDirectories()))
    }
    return [...new Set(roots)]
  }
  function assertPath(requested: string, roots: readonly string[]): void {
    const target = canonicalizeStorePath(requested)
    const allowed = roots.some(root => {
      const relative = path.relative(canonicalizeStorePath(root), target)
      return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    })
    if (!allowed) throw new SessionAccessError()
  }
  async function checkTarget(capability: string, target: { kind: string; payload: unknown } | undefined, ctx: SearchContext): Promise<void> {
    if (!target || !target.payload || typeof target.payload !== 'object') throw new SessionAccessError()
    const payload = target.payload as Record<string, unknown>
    if (capability === 'chats' || capability === 'messages') {
      if (target.kind !== (capability === 'chats' ? 'chat' : 'message') || typeof payload.sessionId !== 'string') throw new SessionAccessError()
      access.resolve(owner(ctx), payload.sessionId, 'read')
      return
    }
    if (capability === 'files' || capability === 'daily') {
      if (target.kind !== (capability === 'files' ? 'file' : 'daily') || typeof payload.filePath !== 'string') throw new SessionAccessError()
      if (capability === 'daily') assertOperator(ctx)
      assertPath(payload.filePath, capability === 'files' ? fileRoots(ctx) : await resolveDailyNoteSearchDirs(adapters))
      return
    }
    assertOperator(ctx)
    // A capability cannot smuggle a session/path action through another kind.
    if (['chat', 'message', 'file', 'daily'].includes(target.kind)) throw new SessionAccessError()
  }
  const authorization: NonNullable<SearchServiceOptions['authorization']> = {
    async query(capability, query, ctx) {
      assertSource(ctx)
      if (capability === 'chats' || capability === 'messages') {
        const ids = access.filter(owner(ctx), adapters.getSessionsList()).map(meta => meta.id)
        return applyVisibility(query, { sessionId: ids })
      }
      if (capability === 'files') {
        const dir = query.filters.dir
        if (typeof dir === 'string') assertPath(dir, fileRoots(ctx))
        return query
      }
      assertOperator(ctx)
      return query
    },
    async targets(capability, items, ctx, actionId) {
      assertSource(ctx)
      for (const item of items) {
        if (item.capability !== capability) throw new SessionAccessError()
        await checkTarget(capability, item.target, ctx)
      }
      if (actionId !== undefined) {
        if (capability === 'daily' && actionId.startsWith('create-daily:')) {
          assertOperator(ctx)
          assertPath(decodeURIComponent(actionId.slice('create-daily:'.length)), await resolveDailyNoteSearchDirs(adapters))
        } else if (capability !== 'chats' && capability !== 'messages' && capability !== 'files') assertOperator(ctx)
      }
    },
  }
  return { authorization, fileRoots }
}
