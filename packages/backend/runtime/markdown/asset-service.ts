import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from '../notes/paths.js'
import type { NoteVault } from '../notes/types.js'

export type MarkdownAssetKind = 'external' | 'missing' | 'file' | 'image'

export interface MarkdownAssetResolution {
  kind: MarkdownAssetKind
  rawTarget: string
  href?: string
  absolutePath?: string
  dataUrl?: string
  mimeType?: string
  fileName?: string
  error?: string
}

export interface MarkdownResolveAssetRequest {
  documentPath: string
  workspaceRoot?: string
  rawTarget: string
}

export interface MarkdownAttachmentInput {
  fileName: string
  mimeType: string
  base64Data: string
}

export interface SavedMarkdownAttachment {
  fileName: string
  absolutePath: string
  linkText: string
  mimeType: string
}

export interface MarkdownSaveAttachmentsRequest {
  documentPath: string
  workspaceRoot?: string
  files: MarkdownAttachmentInput[]
}

export interface MarkdownSaveAttachmentsResponse {
  success: boolean
  insertText?: string
  attachments?: SavedMarkdownAttachment[]
  error?: string
  code?: string
}

export interface OnethingMarkdownEditorSettings {
  /** 笔记库外的笔记根用的附件目录(`settings.notes.attachmentDirectory`)。 */
  markdownNoteAttachmentDirectory?: string
  markdownProjectAttachmentDirectory?: string
}

export interface OnethingMarkdownAssetServiceAdapters {
  getEditorSettings?: () => OnethingMarkdownEditorSettings | undefined
  /**
   * 这份文档落在哪个笔记库里(P3,正本 §4.2)。
   *
   * 这一格顶掉了从前那套「自己往上找 `.obsidian`、自己读 `app.json`」——
   * 附件落哪、链接怎么写、按名字找哪个文件,三件事今天都问**库自己**
   * (Obsidian 活着的时候它会去问 Obsidian,没跑就按快照复现同一套语义)。
   * 这个文件因此一个笔记系统的名字都不认识。
   *
   * 缺席 / 答 `null` = 这份文档不在任何笔记库里,走下面两态。
   */
  vaultFor?: (absolutePath: string) => NoteVault | null
  /**
   * 笔记根:**库表之外**还算笔记的目录。P1 之后用户加的「其他笔记目录」本身
   * 就是库(`FolderDriver` 认领),所以这一格在桌面上实际是空的 —— 它留着是
   * 因为「在笔记根里但没有库认领」在结构上仍然可能(夹紧的宿主把库表清空、
   * 而根列表另有来源),那一档的行为与从前逐字相同。
   */
  getNoteRoots?: () => Array<string | null | undefined>
}

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

interface MarkdownContext {
  /** `vault` = 有库认领;`note` = 在笔记根里但没有库;`project` = 其余。 */
  type: 'vault' | 'note' | 'project'
  root: string
  documentPath: string
  documentDir: string
  workspaceRoot?: string
  vault?: NoteVault
}

function normalizePath(filePath: string): string {
  return path.resolve(expandHome(filePath))
}

function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function fileStat(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

/**
 * 笔记库自己的配置能把附件目录指到任意路径 —— 那是**磁盘上的配置**(Obsidian 的
 * `app.json`、目录库的 `settings.notes.attachmentDirectory`),不是请求输入,所以
 * 它是一条独立的逃逸面:请求里的路径全都夹住了,附件仍可能按库的配置写到界外。
 *
 * P3 之前这只函数自己往上找 `.obsidian`、自己读 `app.json`。今天它问的是**库自己**
 * 会把附件放哪(`attachmentPathFor` 答的那条路径的所在目录),于是「附件落哪」在
 * 全仓只有一个产地,守卫夹的与真正写入用的是同一个答案 —— 从前那是两份实现,
 * 两份实现就会各说各话。
 *
 * 这份文档不在任何库里 = 没有库的配置可逃,恒 true(非库两态的附件目录由
 * `clampAttachmentDirectory` 在装配层先夹过一道)。库答不出来(app 没跑且没有
 * 快照)也是 true:守卫不该因为读不到配置就把一次粘贴判死,真正的出口守卫是
 * `clampSavedAttachments`。
 */
export async function noteAttachmentRootStaysInside(
  documentPath: string,
  boundaryRoot: string,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): Promise<boolean> {
  const resolvedDocumentPath = normalizePath(documentPath)
  const vault = adapters?.vaultFor?.(resolvedDocumentPath) ?? null
  if (!vault) return true
  try {
    const target = await vault.attachmentPathFor(ATTACHMENT_PROBE_NAME, resolvedDocumentPath)
    return isPathInside(boundaryRoot, path.dirname(target))
  } catch {
    return true
  }
}

/** 探附件目录用的假文件名。只取它的所在目录,这个文件从不被创建。 */
const ATTACHMENT_PROBE_NAME = 'onething-attachment-probe.bin'

function getEditorSettings(adapters?: OnethingMarkdownAssetServiceAdapters): OnethingMarkdownEditorSettings {
  return adapters?.getEditorSettings?.() || {}
}

function noteRoots(adapters?: OnethingMarkdownAssetServiceAdapters): string[] {
  return (adapters?.getNoteRoots?.() || [])
    .filter(Boolean)
    .map(root => normalizePath(root as string))
    .sort((a, b) => b.length - a.length)
}

async function markdownContext(
  documentPath: string,
  workspaceRoot?: string,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): Promise<MarkdownContext> {
  const resolvedDocumentPath = normalizePath(documentPath)
  const documentDir = path.dirname(resolvedDocumentPath)
  const vault = adapters?.vaultFor?.(resolvedDocumentPath) ?? null
  if (vault) {
    return {
      type: 'vault',
      root: normalizePath(vault.root),
      documentPath: resolvedDocumentPath,
      documentDir,
      workspaceRoot: workspaceRoot ? normalizePath(workspaceRoot) : undefined,
      vault,
    }
  }

  const noteRoot = noteRoots(adapters).find(root => isPathInside(root, resolvedDocumentPath))
  if (noteRoot) {
    return {
      type: 'note',
      root: noteRoot,
      documentPath: resolvedDocumentPath,
      documentDir,
      workspaceRoot: workspaceRoot ? normalizePath(workspaceRoot) : undefined,
    }
  }

  const root = workspaceRoot ? normalizePath(workspaceRoot) : documentDir
  return {
    type: 'project',
    root,
    documentPath: resolvedDocumentPath,
    documentDir,
    workspaceRoot: root,
  }
}

function cleanRawTarget(rawTarget: string): string {
  let target = rawTarget.trim()
  const wiki = target.match(/^!?\[\[([\s\S]+)\]\]$/)
  if (wiki) target = wiki[1].trim()
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim()
  }
  target = target.split('|')[0].trim()
  target = target.split('#')[0].trim()
  try {
    // 外链保持 URL 语义(decodeURI 不动保留字的转义);本地路径必须**完全**
    // 解码 —— decodeURI 会把 %40(@)这类保留字原样留下,而粘贴管线插的是
    // encodeURI 过的文件名,CleanShot 的 `@2x` 就此永远对不上盘上的文件
    // (真机实锤:`...%402x-2.png` 找不到 `...@2x-2.png`)。
    return isExternalTarget(target) ? decodeURI(target) : decodeURIComponent(target)
  } catch {
    return target
  }
}

function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(target) && !target.toLowerCase().startsWith('file:')
}

function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.csv') return 'text/csv'
  if (ext === '.xls') return 'application/vnd.ms-excel'
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return 'application/octet-stream'
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/')
}

async function imageDataUrl(filePath: string): Promise<{ dataUrl: string; mimeType: string }> {
  const mimeType = mimeTypeFromPath(filePath)
  const buffer = await fs.readFile(filePath)
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
  }
}

function configuredAttachmentDirectory(root: string, configured?: string): string {
  const value = configured?.trim()
  if (!value) return root
  const expanded = expandHome(value)
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded)
}

/**
 * 「这个文件该落在哪」—— 三态各自的答法,统一成一只 `place(fileName)`。
 *
 * **vault 态把整件事交给库**:`attachmentPathFor` 答的是**文件**的绝对路径,
 * 已经含了同名让路(Obsidian 活着时那一步就是 Obsidian 自己算的)。所以这一态
 * 不再走本文件的 `uniqueFilePath` —— 两套让名规则会让同一张图在两条路下落成
 * 两个文件。
 */
type AttachmentPlacement =
  | { ok: true; place(fileName: string): Promise<string> }
  | { ok: false; error: string; code?: string }

function attachmentPlacementForContext(
  context: MarkdownContext,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): AttachmentPlacement {
  const editorSettings = getEditorSettings(adapters)
  if (context.type === 'vault' && context.vault) {
    const vault = context.vault
    return { ok: true, place: fileName => vault.attachmentPathFor(fileName, context.documentPath) }
  }
  if (context.type === 'note') {
    const configured = editorSettings.markdownNoteAttachmentDirectory?.trim()
    if (!configured) {
      return {
        ok: false,
        error: 'Configure a note attachment folder before pasting files into a note root that no note vault claims.',
        code: 'MISSING_NOTE_ATTACHMENT_DIR',
      }
    }
    const directory = configuredAttachmentDirectory(context.root, configured)
    return { ok: true, place: fileName => uniqueFilePath(directory, fileName) }
  }
  const directory = configuredAttachmentDirectory(
    context.workspaceRoot || context.root,
    editorSettings.markdownProjectAttachmentDirectory,
  )
  return { ok: true, place: fileName => uniqueFilePath(directory, fileName) }
}

function candidatePaths(
  context: MarkdownContext,
  target: string,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): string[] {
  if (!target) return []
  if (target.toLowerCase().startsWith('file:')) {
    try {
      return [fileURLToPath(target)]
    } catch {
      return []
    }
  }
  if (path.isAbsolute(target)) return [target]

  const candidates = [
    path.resolve(context.documentDir, target),
    path.resolve(context.root, target),
  ]
  // vault 态**没有第三个候选**:「库把附件放哪」要问库,而那是一次异步(可能还
  // 是一次 CLI 调用),预览里每个资源都问一遍太贵。那一档由下面的
  // `vault.resolveByName` 兜底 —— 它本来就是库自己的按名解析。
  if (context.type === 'note') {
    const configured = getEditorSettings(adapters).markdownNoteAttachmentDirectory?.trim()
    if (configured) candidates.push(path.resolve(configuredAttachmentDirectory(context.root, configured), target))
  } else if (context.workspaceRoot) {
    const configured = getEditorSettings(adapters).markdownProjectAttachmentDirectory?.trim()
    if (configured) candidates.push(path.resolve(configuredAttachmentDirectory(context.workspaceRoot, configured), target))
  }

  return [...new Set(candidates)]
}

export async function resolveMarkdownAsset(
  request: MarkdownResolveAssetRequest,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): Promise<MarkdownAssetResolution> {
  const rawTarget = request.rawTarget
  const target = cleanRawTarget(rawTarget)
  if (!target) return { kind: 'missing', rawTarget, error: 'Empty Markdown target' }

  if (isExternalTarget(target) || target.startsWith('#')) {
    return { kind: 'external', rawTarget, href: target }
  }

  const context = await markdownContext(request.documentPath, request.workspaceRoot, adapters)
  for (const candidate of candidatePaths(context, target, adapters)) {
    const stats = await fileStat(candidate)
    if (!stats?.isFile()) continue
    if (isImagePath(candidate)) {
      const image = await imageDataUrl(candidate)
      return {
        kind: 'image',
        rawTarget,
        absolutePath: candidate,
        fileName: path.basename(candidate),
        ...image,
      }
    }
    return {
      kind: 'file',
      rawTarget,
      absolutePath: candidate,
      fileName: path.basename(candidate),
      mimeType: mimeTypeFromPath(candidate),
    }
  }

  if (context.type === 'vault' && context.vault && !target.includes('/') && !target.includes('\\')) {
    // 按名找:这是**库自己**的规则(wikilink 的解析顺序、附件目录优先),不是这里
    // 重新扫一遍盘再排个序。从前那份索引(整库 walk + 30s TTL 缓存)随之删掉。
    const found = await context.vault.resolveByName(target, context.documentPath).catch(() => null)
    if (found) {
      if (isImagePath(found)) {
        const image = await imageDataUrl(found)
        return {
          kind: 'image',
          rawTarget,
          absolutePath: found,
          fileName: path.basename(found),
          ...image,
        }
      }
      return {
        kind: 'file',
        rawTarget,
        absolutePath: found,
        fileName: path.basename(found),
        mimeType: mimeTypeFromPath(found),
      }
    }
  }

  return { kind: 'missing', rawTarget, error: `File not found: ${target}` }
}

function extensionFromMime(mimeType: string): string {
  const type = mimeType.toLowerCase()
  if (type === 'image/jpeg') return '.jpg'
  if (type === 'image/png') return '.png'
  if (type === 'image/gif') return '.gif'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/svg+xml') return '.svg'
  if (type === 'application/pdf') return '.pdf'
  return ''
}

function sanitizeFileName(fileName: string, mimeType: string): string {
  const fallback = isImageMime(mimeType) ? `pasted-image${extensionFromMime(mimeType) || '.png'}` : 'pasted-file'
  const clean = (fileName || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  const withFallback = clean || fallback
  if (path.extname(withFallback) || !extensionFromMime(mimeType)) return withFallback
  return `${withFallback}${extensionFromMime(mimeType)}`
}

async function uniqueFilePath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName)
  let candidate = path.join(directory, fileName)
  let index = 2
  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`)
    index += 1
  }
  return candidate
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function encodeMarkdownTarget(target: string): string {
  return toPosixPath(target)
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')
}

function labelForFile(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)) || fileName
}

async function linkTextForAttachment(
  context: MarkdownContext,
  saved: SavedMarkdownAttachment,
): Promise<string> {
  const image = isImageMime(saved.mimeType) || isImagePath(saved.absolutePath)
  if (context.type === 'vault' && context.vault) {
    // 链接文本也问库:wikilink 还是 markdown 链接、省不省扩展名、路径取哪一段,
    // 三档全是库的配置。这里自拼一条 `[[...]]` 就是第二份规则。
    return context.vault.linkTextFor(saved.absolutePath, context.documentPath, image ? 'embed' : 'link')
  }

  const relativeToDocument = encodeMarkdownTarget(path.relative(context.documentDir, saved.absolutePath))
  const label = labelForFile(saved.fileName)
  return image
    ? `![${label}](${relativeToDocument})`
    : `[${label}](${relativeToDocument})`
}

export async function saveMarkdownAttachments(
  request: MarkdownSaveAttachmentsRequest,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): Promise<MarkdownSaveAttachmentsResponse> {
  const context = await markdownContext(request.documentPath, request.workspaceRoot, adapters)
  const placement = attachmentPlacementForContext(context, adapters)
  if (!placement.ok) {
    return { success: false, error: placement.error, code: placement.code }
  }

  const attachments: SavedMarkdownAttachment[] = []

  for (const file of request.files) {
    const fileName = sanitizeFileName(file.fileName, file.mimeType)
    const absolutePath = await placement.place(fileName)
    // 落点目录由这里建:库答的是一条路径,建不建目录不是它的事。
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, Buffer.from(file.base64Data, 'base64'))
    const saved: SavedMarkdownAttachment = {
      fileName: path.basename(absolutePath),
      absolutePath,
      mimeType: file.mimeType || mimeTypeFromPath(absolutePath),
      linkText: '',
    }
    saved.linkText = await linkTextForAttachment(context, saved)
    attachments.push(saved)
  }

  return {
    success: true,
    attachments,
    insertText: attachments.map(item => item.linkText).join('\n'),
  }
}

export {
  resolveMarkdownAsset as resolveOnethingMarkdownAsset,
  saveMarkdownAttachments as saveOnethingMarkdownAttachments,
}
