/**
 * 消息引用的**唯一分类表**(docs/design/message-references-2026-08.md §2)。
 *
 * 一表两用:渲染时(`link_open` / `code_inline` 打标)和点击时(`dom.ts` 解析
 * `data-ref`)调的是同一个函数,所以同一个 href 在两处永远得出同一个结论 ——
 * 分类表分叉过一次,链接就会"看起来能点、点了没反应"。
 *
 * 纯 TS:不 import Vue / pinia / platformApi。宿主差异全部收在 `open.ts` 的
 * `ReferenceHost` 里。
 */

export type ReferenceKind = 'file' | 'url' | 'external'

export interface FileReference {
  kind: 'file'
  /** 绝对路径、`~/…`、Windows 盘符路径,或(allowRelative 时)相对路径。 */
  path: string
  line?: number
  endLine?: number
  col?: number
  /** 模型写下的原文,用于提示与"复制路径"(P3)。 */
  raw: string
}

export interface UrlReference {
  kind: 'url'
  url: string
  raw: string
}

export interface ExternalReference {
  kind: 'external'
  url: string
  raw: string
}

export type Reference = FileReference | UrlReference | ExternalReference

export interface ParseReferenceContext {
  /**
   * 放行相对路径。默认关:正文里的 `[标签](docs/a.md)` 不该被当成文件引用,
   * 只有行内代码的 autolink(已按更严的候选式过滤过)才开这一档。
   */
  allowRelative?: boolean
}

const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/
const SCHEME_RE = /^([A-Za-z][A-Za-z\d+.-]*):/
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'heic', 'heif',
])

/** markdown-it 的 normalizeLink 会把 href 百分号编码;解析前先还原。 */
function decodePath(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toLine(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

interface Position {
  path: string
  line?: number
  endLine?: number
  col?: number
}

/**
 * 把行号后缀从路径尾巴上摘下来。顺序有讲究:`:12:5` 与 `:12-30` 都以 `:12` 结尾,
 * 先试长的才不会把列号/终点当成路径的一部分。
 */
export function extractPosition(input: string): Position {
  const hash = /#L(\d+)(?:-L?(\d+))?$/i.exec(input)
  if (hash) {
    const line = toLine(hash[1])
    if (line) {
      return { path: input.slice(0, hash.index), line, endLine: toLine(hash[2]) }
    }
  }

  const lineCol = /:(\d+):(\d+)$/.exec(input)
  if (lineCol) {
    const line = toLine(lineCol[1])
    const col = toLine(lineCol[2])
    if (line && col) return { path: input.slice(0, lineCol.index), line, col }
  }

  const range = /:(\d+)-(\d+)$/.exec(input)
  if (range) {
    const line = toLine(range[1])
    const endLine = toLine(range[2])
    if (line && endLine) return { path: input.slice(0, range.index), line, endLine }
  }

  const single = /:(\d+)$/.exec(input)
  if (single) {
    const line = toLine(single[1])
    // `C:12` 摘完只剩一个盘符字母,那是路径不是行号。
    const rest = input.slice(0, single.index)
    if (line && rest && !/^[A-Za-z]:?$/.test(rest)) return { path: rest, line }
  }

  return { path: input }
}

export function isWindowsPath(value: string): boolean {
  return WINDOWS_PATH_RE.test(value)
}

/** 相对路径的保守判据:至少两段、不像域名、不含 scheme。 */
function relativeLooksLikePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('://')) return false
  if (!value.includes('/')) return false
  const segments = value.split('/')
  if (segments.some(segment => segment === '')) return false
  // `example.com/page` 是个网址不是路径 —— 第一段长得像主机名就退出。
  if (/^[\w-]+(\.[\w-]+)+$/.test(segments[0])) return false
  return true
}

function isFilePathLike(value: string, ctx?: ParseReferenceContext): boolean {
  if (!value) return false
  // `//host/share` 与协议相对 URL 都不当文件处理。
  if (value.startsWith('//')) return false
  if (value === '/' || value === '~') return false
  if (value.startsWith('/')) return true
  if (value.startsWith('~/')) return true
  if (isWindowsPath(value)) return true
  return Boolean(ctx?.allowRelative) && relativeLooksLikePath(value)
}

function fileReference(rawInput: string, target: string, ctx?: ParseReferenceContext): FileReference | null {
  const { path, line, endLine, col } = extractPosition(target)
  if (!isFilePathLike(path, ctx)) return null
  return {
    kind: 'file',
    path,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    ...(col ? { col } : {}),
    raw: rawInput,
  }
}

/** `file://` URL → 本地路径。`file://localhost/a` 与 `file:///C:/a` 都要认。 */
function parseFileUrl(raw: string, ctx?: ParseReferenceContext): FileReference | null {
  let pathname = ''
  let hash = ''
  try {
    const url = new URL(raw)
    if (url.hostname && url.hostname !== 'localhost') return null
    pathname = decodePath(url.pathname)
    hash = url.hash
  } catch {
    return null
  }
  if (!pathname) return null
  // `file:///C:/x` 的 pathname 是 `/C:/x`,盘符前那道斜杠不是路径的一部分。
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
  return fileReference(raw, `${pathname}${hash}`, ctx)
}

/**
 * 把一个 href / 裸 target 归类。不认识的一律返回 `null` —— 渲染端据此"什么也
 * 不做",锚点保持原样。
 */
export function parseReference(href: string, ctx?: ParseReferenceContext): Reference | null {
  if (!href) return null
  const raw = href.trim()
  if (!raw) return null

  const lower = raw.toLowerCase()
  // 三条拒绝项与 markdown-it 默认 validateLink 同口径(§2 表最后一行)。
  if (/^(javascript|vbscript):/.test(lower)) return null
  if (lower.startsWith('data:')) return null

  // 盘符要先判:`C:\Users\me` 也能被 scheme 正则吃掉。
  if (isWindowsPath(raw)) return fileReference(raw, decodePath(raw), ctx)

  const scheme = SCHEME_RE.exec(raw)?.[1]?.toLowerCase()
  if (scheme) {
    // 光秃秃一个 scheme(`C:`、`mailto:`)不指向任何东西。
    if (raw.length === scheme.length + 1) return null
    if (scheme === 'http' || scheme === 'https') return { kind: 'url', url: raw, raw }
    if (scheme === 'file') return parseFileUrl(raw, ctx)
    return { kind: 'external', url: raw, raw }
  }

  if (raw.startsWith('#')) return null
  return fileReference(raw, decodePath(raw), ctx)
}

/** 本地路径 → 可加载的 `file://` URL(段内编码,冒号保留给盘符)。 */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${withLeadingSlash
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')}`
}

export function isImagePath(filePath: string): boolean {
  const name = filePath.replace(/\\/g, '/').split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export function isAbsoluteReferencePath(filePath: string): boolean {
  return filePath.startsWith('/') || isWindowsPath(filePath)
}
