// 带适配器的会话装载与同步(从 `session-store-helpers.ts` 拆出,拆分批 1,D226):先查缓存、再从存储读、
// 读到后做装载期清洗;以及「改了会话元数据 / 改了有副作用的字段」之后怎么经适配器写回、怎么在就绪后同步。
import type { CoreTimelineSession } from './session-timeline.js'
import { sanitizeLoadedSession, type CoreSessionCommandSession } from './session-message-shapes.js'

export type CoreSessionMetadataMutationResult<TSession> =
  | { applied: false }
  | { applied: true; session: TSession }

export interface ApplySessionMetadataMutationWithAdaptersOptions<
  TSession extends { id: string },
  TMeta extends { id: string },
> {
  sessionId: string
  getSession: (sessionId: string) => TSession | undefined
  mutateSession: (session: TSession) => void
  saveSession: (sessionId: string, session: TSession) => void
  syncSessionMetadata?: (session: TSession) => void
  updateIndexMeta?: (sessionId: string, mutate: (meta: TMeta) => void) => void
  mutateMeta?: (meta: TMeta, session: TSession) => void
}

export interface ApplySessionSideEffectMutationWithAdaptersOptions<TSession extends { id: string }> {
  sessionId: string
  getSession: (sessionId: string) => TSession | undefined
  mutateSession: (session: TSession) => void
  saveSession: (sessionId: string, session: TSession) => void
  syncSession?: (session: TSession) => void
}

export interface SyncSessionSideEffectWithReadyAdaptersOptions<TSession> {
  sessionId: string
  session: TSession
  isReady(sessionId: string): boolean
  scheduleMigration(sessionId: string): void
  syncReady(session: TSession): void
  logger?: { error?: (...args: unknown[]) => void }
  errorMessage?: string
}

export type SyncSessionSideEffectWithReadyAdaptersResult = 'synced' | 'scheduled' | 'error'

export interface CoreSessionCacheAdapter<TSession> {
  get(sessionId: string): TSession | undefined
  set(sessionId: string, session: TSession): void
}

export interface LoadSessionWithAdaptersOptions<
  TSession extends CoreTimelineSession & {
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
> {
  sessionId: string
  cache?: CoreSessionCacheAdapter<TSession>
  loadSession(sessionId: string): TSession | undefined
  saveSession?(sessionId: string, session: TSession): void
  syncSession?: (session: TSession) => void
  expandPath?: (path: string) => string
  /** COW:改了返回新会话,没改返回 undefined(F4) */
  sanitizeSession?: (session: TSession) => TSession | undefined
}

export type LoadSessionWithAdaptersResult<TSession> =
  | {
      status: 'cache-hit' | 'loaded'
      session: TSession
      sanitized: boolean
    }
  | {
      status: 'missing'
      session?: undefined
      sanitized: false
    }

export interface NormalizeWorkingDirectoryRootsOptions {
  active?: string
  expandPath?: (path: string) => string
}

export function normalizeWorkingDirectoryRoots(
  roots: unknown,
  options: NormalizeWorkingDirectoryRootsOptions = {},
): string[] | undefined {
  if (!Array.isArray(roots)) return undefined

  const expand = options.expandPath ?? ((value: string) => value)
  const activePath = options.active ? expand(options.active) : ''
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue
    const expanded = expand(root.trim())
    if (expanded === activePath || seen.has(expanded)) continue
    seen.add(expanded)
    normalized.push(expanded)
  }

  return normalized.length > 0 ? normalized : undefined
}

export function applySessionMetadataMutationWithAdapters<
  TSession extends { id: string },
  TMeta extends { id: string },
>(
  options: ApplySessionMetadataMutationWithAdaptersOptions<TSession, TMeta>,
): CoreSessionMetadataMutationResult<TSession> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  options.mutateSession(session)
  options.saveSession(options.sessionId, session)
  options.syncSessionMetadata?.(session)
  if (options.updateIndexMeta && options.mutateMeta) {
    options.updateIndexMeta(options.sessionId, meta => options.mutateMeta?.(meta, session))
  }

  return { applied: true, session }
}

export function applySessionSideEffectMutationWithAdapters<TSession extends { id: string }>(
  options: ApplySessionSideEffectMutationWithAdaptersOptions<TSession>,
): CoreSessionMetadataMutationResult<TSession> {
  const session = options.getSession(options.sessionId)
  if (!session) return { applied: false }

  options.mutateSession(session)
  options.saveSession(options.sessionId, session)
  options.syncSession?.(session)

  return { applied: true, session }
}

export function syncSessionSideEffectWithReadyAdapters<TSession>(
  options: SyncSessionSideEffectWithReadyAdaptersOptions<TSession>,
): SyncSessionSideEffectWithReadyAdaptersResult {
  try {
    if (options.isReady(options.sessionId)) {
      options.syncReady(options.session)
      return 'synced'
    }

    options.scheduleMigration(options.sessionId)
    return 'scheduled'
  } catch (error) {
    options.logger?.error?.(options.errorMessage ?? '[Sessions] Failed to sync session side effect:', error)
    return 'error'
  }
}

export function loadSessionWithAdapters<
  TSession extends CoreTimelineSession & {
    workingDirectory?: string
    workingDirectoryRoots?: string[]
  },
>(
  options: LoadSessionWithAdaptersOptions<TSession>,
): LoadSessionWithAdaptersResult<TSession> {
  const cached = options.cache?.get(options.sessionId)
  if (cached) {
    return { status: 'cache-hit', session: cached, sanitized: false }
  }

  const session = options.loadSession(options.sessionId)
  if (!session) {
    return { status: 'missing', sanitized: false }
  }

  const expand = options.expandPath
  if (session.workingDirectory && expand) {
    session.workingDirectory = expand(session.workingDirectory)
  }
  session.workingDirectoryRoots = normalizeWorkingDirectoryRoots(session.workingDirectoryRoots, {
    active: session.workingDirectory,
    expandPath: expand,
  })

  const sanitize: (target: TSession) => TSession | undefined =
    options.sanitizeSession
    ?? (target => sanitizeLoadedSession(target as unknown as CoreSessionCommandSession) as unknown as TSession | undefined)
  const repaired = sanitize(session)
  const loaded = repaired ?? session
  if (repaired) {
    /*
     * **修复不再写盘**(§17.7 #16,2026-08-28)。
     *
     * 修复本来就是**纯派生**(`computeSessionRepairOnLoad`,一字未动)而且只在
     * 本进程第一次接手这条会话时跑一次;它的结果每次冷加载都算得出来,把它写回
     * 盘只是让"盘上带不带修好的值"多出一种状态,而没有任何消费者要求那种状态:
     *
     *  - `getSessionRaw` 的三个消费者(所有权回填、`iterateMessagesRaw`、
     *    `scanSessionsForSearch`)在契约里就写着**raw 语义:不 sanitize、不回写**
     *    —— 它们本来就不该看见修复过的值;
     *  - 产品读路一律走 `getSession`,那条路现修现给(幂等)。
     *
     * `syncSession` 同理:SQLite 那份镜像跟着内存那份走,不需要一次额外的落盘。
     * (S3w-3 批 6b 起这里落盘的只剩 `meta.json` 的 summary / contextSize /
     * lastInputTokens 三格,而 #15 收口之后那三格的产地是**会话账**,不是修复。)
     */
  }

  options.cache?.set(options.sessionId, loaded)
  return { status: 'loaded', session: loaded, sanitized: Boolean(repaired) }
}
