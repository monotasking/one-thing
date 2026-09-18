import path from 'node:path'
import { applyVisibility, type SearchContext } from '@onething/core/search'
import { canonicalizeStorePath } from '@onething/runtime/storage'
import type { OnethingSearchProvidersAdapters, SearchServiceOptions } from '@onething/runtime/search'
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
      // 笔记根:与 `noteRoots()` 同一句话(P3;从前是那两个变量)。
      roots.push(...noteRoots())
      const current = ctx.principal.sessionId ?? adapters.getCurrentSessionId()
      const allowedCurrent = current && access.filterIds(owner(ctx), [current]).length > 0
      roots.push(...(allowedCurrent ? getConnectedDirectoriesForSession(current) : getConnectedDirectories()))
    }
    return [...new Set(roots)]
  }
  /**
   * 笔记库根(P2)。从前这里是 `resolveDailyNoteSearchDirs(adapters)` —— 它自己
   * 去读设置与 `.obsidian/daily-notes.json` 推一遍目录;今天问的是**笔记领域的
   * 库表**,与索引 feed / 能力自述读的是同一份,所以「能搜到的」与「准打开的」
   * 不会各说各话。一个库都没有 = 空表 = 任何路径都不准 —— 那正是对的。
   */
  function noteRoots(): string[] {
    return (adapters.getNoteVaults?.() ?? []).map(vault => vault.root)
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
    if (capability === 'files' || capability === 'notes') {
      if (target.kind !== (capability === 'files' ? 'file' : 'note') || typeof payload.filePath !== 'string') throw new SessionAccessError()
      if (capability === 'notes') assertOperator(ctx)
      assertPath(payload.filePath, capability === 'files' ? fileRoots(ctx) : noteRoots())
      return
    }
    assertOperator(ctx)
    // A capability cannot smuggle a session/path action through another kind.
    if (['chat', 'message', 'file', 'note'].includes(target.kind)) throw new SessionAccessError()
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
        // 两条建文件的动作都把**目标路径**编在 id 里(`capabilities/notes.ts` 的
        // `actionWithPath`),于是夹的就是那一格 —— 授权不重算「建哪个文件」。
        const prefix = ['create-daily:', 'create-note:'].find(value => actionId.startsWith(value))
        if (capability === 'notes' && prefix !== undefined) {
          assertOperator(ctx)
          assertPath(decodeURIComponent(actionId.slice(prefix.length)), noteRoots())
        } else if (capability !== 'chats' && capability !== 'messages' && capability !== 'files') assertOperator(ctx)
      }
    },
  }
  return { authorization, fileRoots }
}
