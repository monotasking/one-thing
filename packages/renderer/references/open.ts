/**
 * 消息引用的**唯一动作表**(docs/design/message-references-2026-08.md §5)。
 *
 * 这里只有"点了以后做什么",不知道 workbench / 浏览器 store / Electron 是什么 ——
 * 那些由 App.vue 在挂载期包成一个 `ReferenceHost` 注入进来。宿主差异(web 没有
 * 内置浏览器、网关没有文件系统)因此全部收在一处,而不是散在每个调用点。
 */
import { isAbsoluteReferencePath, pathToFileUrl, type Reference } from './parse'

export interface ReferenceOpenModifiers {
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export interface ReferenceStat {
  exists: boolean
  isDirectory: boolean
  isImage: boolean
  /** 宿主实际 stat 到的绝对路径(`~` 已由主进程展开);有就用它替换原 path。 */
  path?: string
}

export interface ReferenceFilePosition {
  line?: number
  endLine?: number
  col?: number
}

export interface ReferenceHost {
  /** 编辑器 tab(带行号定位)。 */
  openFile(path: string, position: ReferenceFilePosition): void | Promise<void>
  /** 内置浏览器 tab;没有内置浏览器的宿主自己降级成 openExternal。 */
  openUrl(url: string): void | Promise<void>
  openExternal(url: string): void | Promise<void>
  /** 文件管理器里显示(shift-click)。 */
  revealPath?(path: string): void | Promise<void>
  statPath?(path: string): Promise<ReferenceStat | null>
  /** 目录引用:以该目录为根开文件树。 */
  openFolder?(path: string): void | Promise<void>
  /** 图片引用:灯箱。 */
  openImage?(path: string, fileUrl: string): void | Promise<void>
  /**
   * 相对路径 / 裸文件名的候选绝对路径(按会话工作目录、本会话工具碰过的文件…),
   * 调用方逐个 stat,第一个存在的胜出。空 / null = 无从解析。
   */
  resolveRelative?(path: string): string[] | string | null | Promise<string[] | string | null>
  notify?(message: string, type?: 'error' | 'info'): void
}

export type ReferenceOpenResult =
  | { ok: true }
  | { ok: false; reason: 'no-host' | 'missing' | 'unsupported' }

let host: ReferenceHost | null = null

export function setReferenceHost(next: ReferenceHost | null): void {
  host = next
}

export function getReferenceHost(): ReferenceHost | null {
  return host
}

function fail(reason: 'no-host' | 'missing' | 'unsupported', message?: string): ReferenceOpenResult {
  if (message) host?.notify?.(message, 'error')
  return { ok: false, reason }
}

function isSystemOpen(modifiers: ReferenceOpenModifiers): boolean {
  return Boolean(modifiers.meta || modifiers.ctrl)
}

async function openFileReference(
  ref: Extract<Reference, { kind: 'file' }>,
  modifiers: ReferenceOpenModifiers,
): Promise<ReferenceOpenResult> {
  const current = host
  if (!current) return fail('no-host')

  // `~/x` 与相对路径都不能直接交给 workbench:先落成绝对路径。`~` 的展开在宿主
  // (主进程 stat 返回展开后的 path),相对路径由宿主给候选、这里逐个 stat 挑第一个存在的。
  let path = ref.path
  let stat: ReferenceStat | null = null
  if (path.startsWith('~')) {
    stat = current.statPath ? await current.statPath(path) : null
    if (!stat?.exists || !stat.path) return fail('missing', `无法解析路径:${ref.path}`)
    path = stat.path
  } else if (!isAbsoluteReferencePath(path)) {
    const resolved = await current.resolveRelative?.(path)
    const candidates = (Array.isArray(resolved) ? resolved : resolved ? [resolved] : []).filter(Boolean)
    if (candidates.length === 0) return fail('missing', `无法解析路径:${ref.path}`)
    let hit: { path: string; stat: ReferenceStat } | null = null
    for (const candidate of candidates) {
      const probe = current.statPath ? await current.statPath(candidate) : null
      // 宿主没有 stat 能力时只能信第一个候选。
      if (!current.statPath) { hit = { path: candidate, stat: { exists: true, isDirectory: false, isImage: false } }; break }
      if (probe?.exists) { hit = { path: probe.path || candidate, stat: probe }; break }
    }
    if (!hit) return fail('missing', `文件不存在:${ref.path}`)
    path = hit.path
    stat = hit.stat
  }

  if (modifiers.shift) {
    if (!current.revealPath) return fail('unsupported', '此宿主无法在文件管理器中显示')
    await current.revealPath(path)
    return { ok: true }
  }

  if (isSystemOpen(modifiers)) {
    await current.openExternal(pathToFileUrl(path))
    return { ok: true }
  }

  if (!stat) stat = current.statPath ? await current.statPath(path) : null
  if (stat && !stat.exists) return fail('missing', `文件不存在:${path}`)
  if (stat?.path) path = stat.path

  if (stat?.isDirectory) {
    if (current.openFolder) {
      await current.openFolder(path)
      return { ok: true }
    }
    return fail('unsupported', '此宿主无法打开目录')
  }

  if (stat?.isImage) {
    const fileUrl = pathToFileUrl(path)
    if (current.openImage) await current.openImage(path, fileUrl)
    else await current.openExternal(fileUrl)
    return { ok: true }
  }

  await current.openFile(path, { line: ref.line, endLine: ref.endLine, col: ref.col })
  return { ok: true }
}

/** 点击一条引用。修饰键语义见设计文档 §5 的表。 */
export async function openReference(
  ref: Reference,
  modifiers: ReferenceOpenModifiers = {},
): Promise<ReferenceOpenResult> {
  const current = host
  if (!current) return fail('no-host')

  if (ref.kind === 'file') return openFileReference(ref, modifiers)

  if (ref.kind === 'url') {
    if (isSystemOpen(modifiers)) await current.openExternal(ref.url)
    else await current.openUrl(ref.url)
    return { ok: true }
  }

  await current.openExternal(ref.url)
  return { ok: true }
}
