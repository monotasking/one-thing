import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { syncDirectoryChain, writeDurableJson } from '../storage/durable-json.js'

type SessionRecord = { id: string; storageGeneration?: string; [key: string]: unknown }
interface DeletionTarget { id: string; generation: string; directory: boolean; legacy: boolean; associated?: readonly string[] }
export interface SessionDeletionIntent {
  readonly version: 1
  readonly operationId: string
  readonly status: 'pending' | 'complete'
  readonly targets: readonly DeletionTarget[]
}
export interface SessionDeletionRecovery {
  /** Caller holds the store lease and has stopped/drained every target writer. */
  prepare(ids: readonly string[]): SessionDeletionIntent
  commit(intent: SessionDeletionIntent): Promise<void>
  /** Must finish before index repair, cold loading, or accepting requests. */
  recover(): Promise<void>
  /** The retained deletion fact also guards scanners from revived directory entries. */
  isDeleted(id: string, storageGeneration?: string): boolean
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function segment(value: string): string {
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value) || path.basename(value) !== value) throw new Error('Invalid session deletion path')
  return value
}
function sessionSegment(value: string): string {
  segment(value)
  if (value.startsWith('.') || value === 'index' || /[<>:"|?*]/.test(value)) throw new Error('Invalid session deletion target path')
  return value
}
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true } catch (error) { if (missing(error)) return false; throw error }
}
function read<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (error) { if (missing(error)) return undefined; throw error }
}

/**
 * A durable, store-owned deletion journal. Completed records are deliberately
 * retained: they are the authority if a filesystem replays an old unlink after
 * power loss. Reusing an id is safe only with a new, already persisted generation.
 * No online GC is provided; reclamation needs a separately verified offline
 * compaction/checkpoint protocol, not an assumption about directory flush on NTFS.
 */
export function createSessionDeletionRecovery(options: {
  sessionsDir: string
  assertOwned(): void
  /** Trusted composition-root directories whose immediate id children share the session lifetime. */
  associatedDirectories?: Readonly<Record<string, string>>
}): SessionDeletionRecovery {
  const sessionsDir = path.resolve(options.sessionsDir)
  const directory = path.join(sessionsDir, '.deletions')
  const indexPath = path.join(sessionsDir, 'index.json')
  const associatedDirectories = Object.freeze(Object.fromEntries(Object.entries(options.associatedDirectories ?? {})
    .map(([name, directory]) => [segment(name), path.resolve(directory)])))
  const intents = new Map<string, SessionDeletionIntent>()
  const deletedGenerations = new Map<string, Set<string>>()
  const metaPath = (id: string) => path.join(sessionsDir, sessionSegment(id), 'meta.json')
  const legacyPath = (id: string) => path.join(sessionsDir, `${sessionSegment(id)}.json`)
  const operationPath = (id: string) => path.join(directory, segment(id))
  const intentPath = (id: string) => path.join(operationPath(id), 'intent.json')
  const metadata = (id: string) => read<SessionRecord>(metaPath(id)) ?? read<SessionRecord>(legacyPath(id))

  function indexIntent(intent: SessionDeletionIntent): void {
    intents.set(intent.operationId, intent)
    for (const target of intent.targets) {
      const generations = deletedGenerations.get(target.id) ?? new Set<string>()
      generations.add(target.generation)
      deletedGenerations.set(target.id, generations)
    }
  }

  function validate(value: SessionDeletionIntent): SessionDeletionIntent {
    if (value.version !== 1 || !['pending', 'complete'].includes(value.status) || !Array.isArray(value.targets)) throw new Error('Invalid session deletion intent')
    segment(value.operationId)
    const seen = new Set<string>()
    for (const target of value.targets) {
      sessionSegment(target.id)
      if (!target.generation || typeof target.generation !== 'string' || typeof target.directory !== 'boolean' || typeof target.legacy !== 'boolean' || seen.has(target.id)) throw new Error('Invalid session deletion target')
      if (target.associated !== undefined && (!Array.isArray(target.associated) || target.associated.some((name: unknown) =>
        typeof name !== 'string' || !Object.hasOwn(associatedDirectories, name)))) throw new Error('Session deletion requires an unavailable associated resource directory')
      seen.add(target.id)
    }
    return Object.freeze({ ...value, targets: Object.freeze(value.targets.map(target => Object.freeze({
      ...target, ...(target.associated ? { associated: Object.freeze([...target.associated]) } : {}),
    }))) })
  }
  function loadIntents(): void {
    if (!exists(directory)) return
    for (const name of fs.readdirSync(directory)) {
      if (!fs.lstatSync(operationPath(name)).isDirectory()) continue
      const intent = read<SessionDeletionIntent>(intentPath(name))
      if (!intent) continue // A crash before publishing an intent made no destructive change.
      if (intent.operationId !== name) throw new Error('Session deletion intent directory mismatch')
      indexIntent(validate(intent))
    }
  }
  /**
   * 已完成的删除记录保留多久(工单 5 §3)。
   *
   * 这份记录唯一的用途是"断电后文件系统重放了一次旧的 unlink,让删掉的目录又冒出来"
   * —— 那是**秒级到分钟级**的窗口。七天之后它只剩两个作用:让每次开机多读一个文件,
   * 让 `.deletions/` 无限长大。到期即删,连同它那个已经空掉的隔离区目录。
   * 判据取 intent 文件自己的 mtime:这份记录只在 pending → complete 那一刻被重写过一次。
   */
  const COMPLETED_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

  /** 只删 complete 且过期的;pending 与未到期的一个都不动。 */
  function collectCompletedIntents(now = Date.now()): void {
    for (const intent of [...intents.values()]) {
      if (intent.status !== 'complete') continue
      let modified: number
      try { modified = fs.statSync(intentPath(intent.operationId)).mtimeMs }
      catch (error) { if (missing(error)) { intents.delete(intent.operationId); continue } throw error }
      if (now - modified < COMPLETED_INTENT_RETENTION_MS) continue
      fs.rmSync(operationPath(intent.operationId), { recursive: true, force: true })
      intents.delete(intent.operationId)
      for (const target of intent.targets) {
        const generations = deletedGenerations.get(target.id)
        if (!generations) continue
        generations.delete(target.generation)
        if (!generations.size) deletedGenerations.delete(target.id)
      }
    }
  }

  function remember(intent: SessionDeletionIntent): SessionDeletionIntent {
    const fixed = validate(intent)
    writeDurableJson(intentPath(fixed.operationId), fixed, sessionsDir)
    indexIntent(fixed)
    return fixed
  }

  function prepare(ids: readonly string[]): SessionDeletionIntent {
    options.assertOwned()
    const uniqueIds = [...new Set(ids.map(sessionSegment))]
    const index = read<SessionRecord[]>(indexPath) ?? []
    const targets: DeletionTarget[] = []
    for (const id of uniqueIds) {
      const meta = read<SessionRecord>(metaPath(id))
      const legacy = read<SessionRecord>(legacyPath(id))
      const indexed = index.find(item => item.id === id)
      const generations = new Set([meta?.storageGeneration, legacy?.storageGeneration, indexed?.storageGeneration].filter((v): v is string => Boolean(v)))
      if (generations.size > 1) throw new Error(`Conflicting session generations: ${id}`)
      const generation = [...generations][0] ?? randomUUID()
      const hasDirectory = exists(path.join(sessionsDir, id))
      // Legacy generations are made reliable before intent acceptance. A crash
      // here merely leaves a harmless generation stamp, never a half deletion.
      if (meta || hasDirectory) writeDurableJson(metaPath(id), { ...indexed, ...meta, id, storageGeneration: generation }, sessionsDir)
      if (legacy) writeDurableJson(legacyPath(id), { ...legacy, storageGeneration: generation }, sessionsDir)
      if (indexed) indexed.storageGeneration = generation
      const associated = Object.entries(associatedDirectories).filter(([, directory]) => exists(path.join(directory, id))).map(([name]) => name)
      targets.push({ id, generation, directory: hasDirectory, legacy: Boolean(legacy), ...(associated.length ? { associated } : {}) })
    }
    if (uniqueIds.some(id => index.some(item => item.id === id))) writeDurableJson(indexPath, index, sessionsDir)
    return remember({ version: 1, operationId: randomUUID(), status: 'pending', targets })
  }

  function isolate(intent: SessionDeletionIntent, target: DeletionTarget, kind: 'directory' | 'legacy'): void {
    if (!target[kind]) return
    const source = kind === 'directory' ? path.join(sessionsDir, target.id) : legacyPath(target.id)
    const quarantined = path.join(operationPath(intent.operationId), 'resources', `${target.id}.${kind}`)
    if (exists(source)) {
      const sourceMeta = read<SessionRecord>(kind === 'directory' ? metaPath(target.id) : source)
      // Missing metadata can only be a partial old removal. A new generation's
      // complete initial metadata must be persisted before that generation exists.
      if (!sourceMeta || sourceMeta.storageGeneration === target.generation) {
        fs.mkdirSync(path.dirname(quarantined), { recursive: true })
        if (exists(quarantined)) fs.rmSync(source, { recursive: true, force: true })
        else fs.renameSync(source, quarantined)
        syncDirectoryChain(sessionsDir, sessionsDir)
        syncDirectoryChain(path.dirname(quarantined), sessionsDir)
      }
    }
    // This private path is forever tied to the original operation, so it cannot
    // accidentally address a replacement session even after partial rm failure.
    fs.rmSync(quarantined, { recursive: true, force: true })
  }
  /**
   * 隔离区清空之后的目录屏障,**每个 intent 一次**(工单 5 §3,triage A4)。
   *
   * 从前它挂在 `isolate()` 的尾巴上,于是一次删除跑 3N 遍(每个目标的 directory /
   * legacy / 每个关联资源目录各一遍),而它们同步的是**同一个** `resources` 目录。
   * 挪到目标全删完之后跑一次:覆盖面一字不变(那时每一次 rm 都已经发生),次数从
   * 3N 变 1。丢了这一次也不致命 —— 保留下来的 complete 记录才是"这些数据必须不可见"
   * 的权威,隔离区里的副本挂在一个与该次操作绑死的私有路径上,下次 recover 再删一遍。
   */
  function syncQuarantine(intent: SessionDeletionIntent): void {
    const resources = path.join(operationPath(intent.operationId), 'resources')
    if (exists(resources)) syncDirectoryChain(resources, sessionsDir)
  }
  function removeTarget(intent: SessionDeletionIntent, target: DeletionTarget): void {
    // Capture the incarnation before isolating metadata. Once metadata has moved,
    // its absence cannot be used to decide whether an associated directory is new.
    const generation = metadata(target.id)?.storageGeneration
    const original = !generation || generation === target.generation
    for (const name of target.associated ?? []) {
      const base = associatedDirectories[name]
      if (!base) throw new Error('Session deletion requires an unavailable associated resource directory')
      const source = path.join(base, target.id)
      const quarantined = path.join(operationPath(intent.operationId), 'resources', `${target.id}.associated-${name}`)
      if (original && exists(source)) {
        fs.mkdirSync(path.dirname(quarantined), { recursive: true })
        if (exists(quarantined)) fs.rmSync(source, { recursive: true, force: true })
        else fs.renameSync(source, quarantined)
        syncDirectoryChain(base, base)
        syncDirectoryChain(path.dirname(quarantined), sessionsDir)
      }
      fs.rmSync(quarantined, { recursive: true, force: true })
    }
    isolate(intent, target, 'directory')
    isolate(intent, target, 'legacy')
  }
  async function commit(input: SessionDeletionIntent): Promise<void> {
    options.assertOwned()
    const intent = intents.get(input.operationId)
    if (!intent) throw new Error('Session deletion intent is not owned by this store')
    for (const target of intent.targets) {
      removeTarget(intent, target)
    }
    syncQuarantine(intent)
    const index = read<SessionRecord[]>(indexPath) ?? []
    const next = index.filter(item => {
      const target = intent.targets.find(target => target.id === item.id)
      if (!target) return true
      const current = metadata(item.id)
      if (current?.storageGeneration && current.storageGeneration !== target.generation) return true
      return Boolean(item.storageGeneration && item.storageGeneration !== target.generation)
    })
    if (intent.status === 'pending' || next.length !== index.length) writeDurableJson(indexPath, next, sessionsDir)
    // Completion is another reliable file publication, never deletion of the only
    // evidence that old data must remain invisible after restart.
    if (intent.status === 'pending') remember({ ...intent, status: 'complete' })
  }
  return {
    prepare, commit,
    async recover() {
      options.assertOwned()
      loadIntents()
      if (intents.size === 0) return
      const pending = [...intents.values()].filter(intent => intent.status === 'pending')
      /*
       * **只重放没跑完的**(工单 5 §3,triage A4)。
       *
       * 从前这里对**全部**历史 intent(含早已 complete 的)跑一遍 `removeTarget` ——
       * 每个目标一次 `metadata()` 读盘、几次 `exists()`、`rmSync` 与目录 fsync,而它们
       * 要删的东西上一次开机就已经删干净了。一个删过几百条会话的库,于是每次开机
       * 都在装配链上同步跑几百趟空转的文件系统往返。complete 的记录仍然被 `loadIntents`
       * 读进 `deletedGenerations` —— 墓碑还在,`isDeleted` 一个字都没变;变的只是
       * 「已经做完的事不再重做一遍」。
       */
      for (const intent of pending) {
        for (const target of intent.targets) {
          removeTarget(intent, target)
        }
        syncQuarantine(intent)
      }
      collectCompletedIntents()
      const index = read<SessionRecord[]>(indexPath) ?? []
      const next = index.filter(item => {
        const generations = deletedGenerations.get(item.id)
        if (!generations) return true
        const current = metadata(item.id)?.storageGeneration
        if (current && !generations.has(current)) return true
        return Boolean(item.storageGeneration && !generations.has(item.storageGeneration))
      })
      if (pending.length || next.length !== index.length) writeDurableJson(indexPath, next, sessionsDir)
      for (const intent of pending) remember({ ...intent, status: 'complete' })
    },
    isDeleted(id, generation) {
      const generations = deletedGenerations.get(id)
      if (!generations) return false
      const currentGeneration = generation ?? metadata(id)?.storageGeneration
      /*
       * 问不出代际 = **不判它已删**(工单 5 §3,triage A4)。
       *
       * 从前这里是 `!currentGeneration || …`,于是"这个 id 曾经被删过,而现在盘上
       * 既没有 meta 也没人交代际"被当成"它已删"。可这一格恰恰是**新建**同 id 会话
       * 还没落 meta 的那一瞬间、以及任何一个只拿得到 id 的读路 —— 把它判成已删,
       * 等于让一次历史删除永久毒死这个 id。代际是这套墓碑唯一的判据:没有代际
       * 就没有判据,没有判据就不下判。
       */
      if (!currentGeneration) return false
      return generations.has(currentGeneration)
    },
  }
}
