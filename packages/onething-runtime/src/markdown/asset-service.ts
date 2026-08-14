import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  markdownNoteAttachmentDirectory?: string
  markdownProjectAttachmentDirectory?: string
}

export interface OnethingMarkdownAssetServiceAdapters {
  getEditorSettings?: () => OnethingMarkdownEditorSettings | undefined
  getNoteRoots?: () => Array<string | null | undefined>
}

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])
const SKIP_SEARCH_DIRS = new Set(['.git', '.obsidian', 'node_modules'])
const MAX_VAULT_SEARCH_ENTRIES = 200000
const VAULT_ASSET_INDEX_TTL_MS = 30000

interface ObsidianConfig {
  attachmentFolderPath?: string
  useMarkdownLinks?: boolean
}

interface MarkdownContext {
  type: 'obsidian' | 'note' | 'project'
  root: string
  documentPath: string
  documentDir: string
  workspaceRoot?: string
  obsidian?: {
    vaultRoot: string
    config: ObsidianConfig
  }
}

interface VaultAssetIndex {
  createdAt: number
  filesByName: Map<string, string[]>
}

const vaultAssetIndexCache = new Map<string, Promise<VaultAssetIndex> | VaultAssetIndex>()

function normalizePath(filePath: string): string {
  return path.resolve(expandHome(filePath))
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  if (input.startsWith('$HOME/')) return path.join(os.homedir(), input.slice(6))
  return input
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

export async function findObsidianVaultRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath)
  const stat = await fileStat(current)
  if (stat?.isFile()) current = path.dirname(current)

  while (true) {
    if (await pathExists(path.join(current, '.obsidian'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function readObsidianConfig(vaultRoot: string): Promise<ObsidianConfig> {
  try {
    const raw = await fs.readFile(path.join(vaultRoot, '.obsidian', 'app.json'), 'utf-8')
    const parsed = JSON.parse(raw) as ObsidianConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Obsidian 的 `.obsidian/app.json` 能把附件目录指到任意路径 —— 那是**磁盘上的
 * 配置文件**,不是请求输入,所以它是一条独立的逃逸面:请求里的路径全都夹住了,
 * 附件仍可能按 vault 配置写到界外。
 *
 * 从 `documentPath` 往上、以 `boundaryRoot` 为界找到第一个 `.obsidian`,判它的
 * `attachmentFolderPath` 是否留在界内:空配置 = 编辑器默认目录(界内)放行;
 * `~` / `$HOME` 前缀直接拒;相对路径以 vault 根解析。找不到配置或读不动,
 * 一律当默认目录放行。界内没有 vault 时恒 true。
 */
export async function obsidianAttachmentRootStaysInside(
  documentPath: string,
  boundaryRoot: string,
): Promise<boolean> {
  let current = path.dirname(documentPath)
  while (isPathInside(boundaryRoot, current)) {
    if (await pathExists(path.join(current, '.obsidian'))) {
      const folder = (await readObsidianConfig(current)).attachmentFolderPath
      const trimmed = typeof folder === 'string' ? folder.trim() : ''
      if (!trimmed) return true
      if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('$HOME/')) return false
      const attachmentRoot = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(current, trimmed))
      return isPathInside(boundaryRoot, attachmentRoot)
    }
    const parent = path.dirname(current)
    if (parent === current) return true
    current = parent
  }
  return true
}

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
  const vaultRoot = await findObsidianVaultRoot(resolvedDocumentPath)
  if (vaultRoot) {
    return {
      type: 'obsidian',
      root: vaultRoot,
      documentPath: resolvedDocumentPath,
      documentDir,
      workspaceRoot: workspaceRoot ? normalizePath(workspaceRoot) : undefined,
      obsidian: {
        vaultRoot,
        config: await readObsidianConfig(vaultRoot),
      },
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
    return decodeURI(target)
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

function obsidianAttachmentDirectory(context: MarkdownContext): string {
  const folder = context.obsidian?.config.attachmentFolderPath?.trim()
  if (!folder) return context.documentDir
  if (path.isAbsolute(folder)) return folder
  return path.resolve(context.obsidian?.vaultRoot || context.root, folder)
}

function configuredAttachmentDirectory(root: string, configured?: string): string {
  const value = configured?.trim()
  if (!value) return root
  const expanded = expandHome(value)
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded)
}

function attachmentDirectoryForContext(
  context: MarkdownContext,
  adapters?: OnethingMarkdownAssetServiceAdapters,
): { directory?: string; error?: string; code?: string } {
  const editorSettings = getEditorSettings(adapters)
  if (context.type === 'obsidian') {
    return { directory: obsidianAttachmentDirectory(context) }
  }
  if (context.type === 'note') {
    const configured = editorSettings.markdownNoteAttachmentDirectory?.trim()
    if (!configured) {
      return {
        error: 'Configure a note attachment folder before pasting files into a non-Obsidian note root.',
        code: 'MISSING_NOTE_ATTACHMENT_DIR',
      }
    }
    return { directory: configuredAttachmentDirectory(context.root, configured) }
  }
  return {
    directory: configuredAttachmentDirectory(
      context.workspaceRoot || context.root,
      editorSettings.markdownProjectAttachmentDirectory,
    ),
  }
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
  if (context.type === 'obsidian') {
    candidates.push(path.resolve(obsidianAttachmentDirectory(context), target))
  } else if (context.type === 'note') {
    const configured = getEditorSettings(adapters).markdownNoteAttachmentDirectory?.trim()
    if (configured) candidates.push(path.resolve(configuredAttachmentDirectory(context.root, configured), target))
  } else if (context.workspaceRoot) {
    const configured = getEditorSettings(adapters).markdownProjectAttachmentDirectory?.trim()
    if (configured) candidates.push(path.resolve(configuredAttachmentDirectory(context.workspaceRoot, configured), target))
  }

  return [...new Set(candidates)]
}

async function buildVaultAssetIndex(root: string): Promise<VaultAssetIndex> {
  const filesByName = new Map<string, string[]>()
  let visited = 0

  async function walk(dir: string): Promise<void> {
    if (visited > MAX_VAULT_SEARCH_ENTRIES) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_VAULT_SEARCH_ENTRIES) return
      if (!entry.isFile()) continue
      const absolutePath = path.join(dir, entry.name)
      const matches = filesByName.get(entry.name) || []
      matches.push(absolutePath)
      filesByName.set(entry.name, matches)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_SEARCH_DIRS.has(entry.name)) continue
      await walk(path.join(dir, entry.name))
      if (visited > MAX_VAULT_SEARCH_ENTRIES) return
    }
  }

  await walk(root)
  return { createdAt: Date.now(), filesByName }
}

async function getVaultAssetIndex(root: string): Promise<VaultAssetIndex> {
  const cached = vaultAssetIndexCache.get(root)
  if (cached) {
    if (cached instanceof Promise) return cached
    if (Date.now() - cached.createdAt < VAULT_ASSET_INDEX_TTL_MS) return cached
  }

  const pending = buildVaultAssetIndex(root)
  vaultAssetIndexCache.set(root, pending)
  try {
    const index = await pending
    vaultAssetIndexCache.set(root, index)
    return index
  } catch (error) {
    vaultAssetIndexCache.delete(root)
    throw error
  }
}

async function findObsidianAssetByBasename(context: MarkdownContext, fileName: string): Promise<string | null> {
  const index = await getVaultAssetIndex(context.root)
  const matches = index.filesByName.get(fileName)
  if (!matches?.length) return null

  const attachmentRoot = obsidianAttachmentDirectory(context)
  return [...matches].sort((a, b) => {
    const aInAttachment = isPathInside(attachmentRoot, a)
    const bInAttachment = isPathInside(attachmentRoot, b)
    if (aInAttachment !== bInAttachment) return aInAttachment ? -1 : 1

    const aInDocumentDir = isPathInside(context.documentDir, a)
    const bInDocumentDir = isPathInside(context.documentDir, b)
    if (aInDocumentDir !== bInDocumentDir) return aInDocumentDir ? -1 : 1

    const aRelative = path.relative(context.root, a)
    const bRelative = path.relative(context.root, b)
    return aRelative.localeCompare(bRelative)
  })[0] || null
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

  if (context.type === 'obsidian' && !target.includes('/') && !target.includes('\\')) {
    const found = await findObsidianAssetByBasename(context, target)
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

function linkTextForAttachment(context: MarkdownContext, saved: SavedMarkdownAttachment): string {
  const image = isImageMime(saved.mimeType) || isImagePath(saved.absolutePath)
  if (context.type === 'obsidian' && context.obsidian?.config.useMarkdownLinks !== true) {
    const relativeToVault = toPosixPath(path.relative(context.root, saved.absolutePath))
    return image ? `![[${relativeToVault}]]` : `[[${relativeToVault}]]`
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
  const target = attachmentDirectoryForContext(context, adapters)
  if (!target.directory) {
    return { success: false, error: target.error || 'Attachment directory is not configured', code: target.code }
  }

  await fs.mkdir(target.directory, { recursive: true })
  const attachments: SavedMarkdownAttachment[] = []

  for (const file of request.files) {
    const fileName = sanitizeFileName(file.fileName, file.mimeType)
    const absolutePath = await uniqueFilePath(target.directory, fileName)
    await fs.writeFile(absolutePath, Buffer.from(file.base64Data, 'base64'))
    const saved: SavedMarkdownAttachment = {
      fileName: path.basename(absolutePath),
      absolutePath,
      mimeType: file.mimeType || mimeTypeFromPath(absolutePath),
      linkText: '',
    }
    saved.linkText = linkTextForAttachment(context, saved)
    attachments.push(saved)
  }

  if (context.type === 'obsidian') {
    vaultAssetIndexCache.delete(context.root)
  }

  return {
    success: true,
    attachments,
    insertText: attachments.map(item => item.linkText).join('\n'),
  }
}

export {
  findObsidianVaultRoot as findOnethingObsidianVaultRoot,
  resolveMarkdownAsset as resolveOnethingMarkdownAsset,
  saveMarkdownAttachments as saveOnethingMarkdownAttachments,
}
