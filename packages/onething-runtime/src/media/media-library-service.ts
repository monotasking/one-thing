import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import {
  basenamePath,
  dirnamePath,
  ensureDir,
  extnamePath,
  joinPaths,
  readJsonFile,
  writeJsonFile,
} from '@onething/core/storage'

import { getLogger } from '../logging/index.js'

const log = getLogger('media')

export type OnethingMediaKind = 'image' | 'video' | 'audio' | 'document' | 'file'
export type OnethingMediaSource = 'user-upload' | 'ai-generated' | 'tool-output' | 'external'
export type OnethingMediaUsageTag = 'persona-avatar' | 'video-character' | 'chat-reference'
export type OnethingMediaRole = 'user' | 'assistant' | 'system' | 'error'
export type OnethingAttachmentMediaType = 'image' | 'document' | 'audio' | 'video' | 'file'

export interface OnethingMediaAssetLink {
  sessionId?: string
  messageId?: string
  attachmentId?: string
  role?: OnethingMediaRole
}

export interface OnethingMediaAssetMetadata {
  prompt?: string
  revisedPrompt?: string
  model?: string
  usageTags?: OnethingMediaUsageTag[]
  originalUrl?: string
}

export interface OnethingMediaAsset {
  id: string
  /** Independent uploads only; linked assets derive authority from their sessions. */
  ownerUserId?: string
  ownerWorkspaceId?: string
  kind: OnethingMediaKind
  source: OnethingMediaSource
  mimeType: string
  size: number
  fileName: string
  filePath?: string
  thumbnailPath?: string
  width?: number
  height?: number
  contentHash?: string
  links: OnethingMediaAssetLink[]
  metadata?: OnethingMediaAssetMetadata
  createdAt: number
  updatedAt?: number
  libraryHiddenAt?: number
}

export interface OnethingMediaQuery {
  kind?: OnethingMediaKind
  source?: OnethingMediaSource
  search?: string
  includeHidden?: boolean
}

export interface OnethingMessageAttachment {
  id: string
  fileName: string
  mimeType: string
  size: number
  mediaType: OnethingAttachmentMediaType
  base64Data?: string
  url?: string
  width?: number
  height?: number
  mediaAssetId?: string
  /**
   * Absolute on-disk path. Present from the start for dropped/picked files;
   * backfilled from the stored asset for pasted ones (ingestMessageAttachments).
   */
  filePath?: string
}

export interface OnethingMediaMessage {
  id: string
  role: OnethingMediaRole
  attachments?: OnethingMessageAttachment[]
}

export interface OnethingMediaSession {
  id: string
  messages: OnethingMediaMessage[]
}

export interface OnethingLegacyMediaItem {
  id: string
  type: 'image'
  filePath: string
  prompt: string
  revisedPrompt?: string
  model: string
  createdAt: number
  sessionId: string
  messageId: string
}

export interface OnethingMediaLibraryIndex {
  version: 2
  assets: OnethingMediaAsset[]
}

export interface OnethingMediaLibraryPaths {
  indexPath: string
  imagesDir: string
  filesDir: string
}

export type OnethingMediaAssetAccess = Pick<OnethingMediaAsset, 'id' | 'links' | 'ownerUserId' | 'ownerWorkspaceId' | 'filePath' | 'thumbnailPath'>
export type OnethingMediaVisibility = (asset: OnethingMediaAssetAccess) => boolean
export interface OnethingMediaImportOwner { userId: string; workspaceId: string }

function provenanceKey(links: readonly OnethingMediaAssetLink[], owner?: OnethingMediaImportOwner): string {
  const sessions = [...new Set(links.map(link => link.sessionId).filter((id): id is string => !!id))].sort()
  return sessions.length ? JSON.stringify(['sessions', sessions]) : JSON.stringify(['owner', owner?.userId ?? 'local-user', owner?.workspaceId ?? 'default'])
}

export interface OnethingMediaIngestAttachmentInput {
  sessionId: string
  messageId: string
  role: OnethingMediaRole
  attachment: OnethingMessageAttachment
}

export interface OnethingMediaIngestGeneratedImageInput {
  url?: string
  base64?: string
  prompt: string
  revisedPrompt?: string
  model: string
  sessionId: string
  messageId: string
  /**
   * Where the bytes came FROM. Defaults to `'ai-generated'` — this path exists
   * for image generation — but a picked agent avatar travels the same pipe and
   * is genuinely a `'user-upload'`; letting the caller say so is what keeps the
   * source facet from lying (it did, until 2026-08).
   */
  source?: OnethingMediaSource
  /**
   * The image's real mime type (`image/png` | `image/jpeg` | `image/webp` | …).
   *
   * P4-8:provider 侧现在报得出真实类型(gemini 的 `inlineData.mimeType`、
   * OpenRouter data URL 的那一段),落库就该按真实类型写 —— 文件后缀由
   * `mimeToExtension` 从它推,索引里的 `mimeType` 也记它。
   *
   * 缺席 = `image/png`(旧行为逐字不变:codex 的 `image_generation` 与 OpenAI
   * images API 都只回 png,它们不带这个字段)。非 `image/` 前缀一律忽略 ——
   * 这条路只收图。
   */
  mediaType?: string
  /**
   * What the image is FOR (e.g. 'persona-avatar'). Recorded on the asset so a
   * picked agent avatar can be told apart from generated artwork later; it does
   * not change where the bytes land.
   */
  usageTags?: OnethingMediaUsageTag[]
}

/**
 * One file handed to the library from outside a chat message — a drop, a
 * "选择文件" pick, a web upload. Exactly one of `filePath` / `base64Data`
 * carries the bytes: the desktop has a real path (no base64 round trip, so a
 * 300MB video costs nothing to ingest), the browser only ever has bytes.
 */
export interface OnethingMediaIngestFileInput {
  filePath?: string
  base64Data?: string
  fileName: string
  mimeType?: string
}

export interface OnethingMediaIngestLocalFilesInput {
  files: OnethingMediaIngestFileInput[]
  /** Defaults to `'user-upload'` — a hand-fed file is by definition an upload. */
  source?: OnethingMediaSource
  links?: OnethingMediaAssetLink[]
}

/**
 * Per-file outcome, not a batch verdict. One unreadable path must not sink the
 * other four files of the same drop, so failures are collected and reported
 * rather than thrown.
 */
export interface OnethingMediaIngestLocalFilesResult {
  assets: OnethingMediaAsset[]
  created: number
  skipped: number
  errors: { fileName: string; error: string }[]
}

interface IngestMediaAssetResult {
  asset?: OnethingMediaAsset
  created: boolean
  changed: boolean
}

function mimeToExtension(mimeType: string, fallbackName?: string): string {
  const existing = fallbackName ? extnamePath(fallbackName) : ''
  if (existing) return existing

  const normalized = mimeType.toLowerCase()
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'application/pdf') return '.pdf'
  if (normalized === 'text/plain') return '.txt'
  if (normalized === 'audio/mpeg') return '.mp3'
  if (normalized === 'video/mp4') return '.mp4'
  return '.bin'
}

/**
 * The one mime→kind rule in this file. Extracted (not copied) out of
 * `kindFromAttachment` so file ingest and attachment ingest can never drift
 * into two different answers for the same mime type.
 */
function kindFromMimeType(mimeType: string): OnethingMediaKind {
  const normalized = mimeType.toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized === 'application/pdf' || normalized.startsWith('text/')) return 'document'
  return 'file'
}

function kindFromAttachment(attachment: OnethingMessageAttachment): OnethingMediaKind {
  if (attachment.mediaType === 'image') return 'image'
  if (attachment.mediaType === 'audio') return 'audio'
  if (attachment.mediaType === 'video') return 'video'
  if (attachment.mediaType === 'document') return 'document'

  return kindFromMimeType(attachment.mimeType)
}

/**
 * Reverse of `mimeToExtension` for the handful of extensions that table knows,
 * plus the ones a dropped file actually arrives as. A drop from Finder often
 * carries no mime at all (the renderer only sees `File.type === ''`), and
 * guessing wrong here would file a PNG under `kind: 'file'`.
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
}

function mimeFromFileName(fileName: string): string {
  const extension = extnamePath(fileName).toLowerCase()
  return EXTENSION_MIME_TYPES[extension] || 'application/octet-stream'
}

/**
 * 生图落库的 mime:调用方报什么就记什么,只挡住不是图的那一类。缺席 = png
 * (codex / OpenAI images 只回 png,它们不带 `mediaType`)。
 */
function generatedImageMimeType(mediaType: string | undefined): string {
  const normalized = mediaType?.trim().toLowerCase()
  return normalized?.startsWith('image/') ? normalized : 'image/png'
}

function base64ToBuffer(base64Data: string): Buffer {
  const base64Content = base64Data.replace(/^data:[^;]+;base64,/, '')
  return Buffer.from(base64Content, 'base64')
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function createMediaId(): string {
  return crypto.randomUUID()
}

function linkKey(link: OnethingMediaAssetLink): string {
  return [
    link.sessionId || '',
    link.messageId || '',
    link.attachmentId || '',
    link.role || '',
  ].join(':')
}

function mergeLink(asset: OnethingMediaAsset, link: OnethingMediaAssetLink): boolean {
  const existing = new Set(asset.links.map(linkKey))
  if (existing.has(linkKey(link))) return false
  asset.links.push(link)
  asset.updatedAt = Date.now()
  return true
}

/**
 * Union of what the asset already claims and what this ingest declares. A
 * content-hash hit means the SAME bytes are now serving a second purpose (the
 * user picked a generated image as an avatar) — dropping either tag would lose
 * a true statement about the asset.
 */
function mergeUsageTags(
  existing: OnethingMediaUsageTag[] | undefined,
  incoming: OnethingMediaUsageTag[] | undefined,
): OnethingMediaUsageTag[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])]
  return merged.length > 0 ? merged : undefined
}

function isLegacyIndex(value: unknown): value is { items: OnethingLegacyMediaItem[] } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items))
}

function isMediaLibraryIndex(value: unknown): value is OnethingMediaLibraryIndex {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { assets?: unknown }).assets))
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    protocol.get(url, (response) => {
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('Image download was interrupted')))
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          response.on('end', () => { downloadToBuffer(redirectUrl).then(resolve, reject) })
          response.resume()
          return
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`))
        response.resume()
        return
      }

      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

export function mediaAssetToLegacyImage(asset: OnethingMediaAsset): OnethingLegacyMediaItem {
  const primaryLink = asset.links[0] || {}
  return {
    id: asset.id,
    type: 'image',
    filePath: asset.filePath || '',
    prompt: asset.metadata?.prompt || asset.fileName,
    revisedPrompt: asset.metadata?.revisedPrompt,
    model: asset.metadata?.model || (asset.source === 'user-upload' ? 'user-upload' : ''),
    createdAt: asset.createdAt,
    sessionId: primaryLink.sessionId || '',
    messageId: primaryLink.messageId || '',
  }
}

export class OnethingMediaLibraryService {
  private indexCache: OnethingMediaLibraryIndex | null = null
  private closed = false
  private readonly downloads = new Set<Promise<Buffer>>()

  private readonly fixedPaths: Readonly<OnethingMediaLibraryPaths>
  constructor(paths: OnethingMediaLibraryPaths) { this.fixedPaths = Object.freeze({ ...paths }) }

  private get paths(): OnethingMediaLibraryPaths {
    if (this.closed) throw new Error('Media library has been stopped')
    return this.fixedPaths
  }

  quiesce(): void { this.closed = true }

  async drain(): Promise<void> {
    while (this.downloads.size) await Promise.allSettled([...this.downloads])
  }

  storagePaths(): Readonly<OnethingMediaLibraryPaths> { return { ...this.paths } }

  /** This projection contains only access metadata, never prompts or file bytes. */
  listAssetAccess(): OnethingMediaAssetAccess[] {
    return this.loadIndex().assets.map(({ id, links, ownerUserId, ownerWorkspaceId, filePath, thumbnailPath }) =>
      ({ id, links, ownerUserId, ownerWorkspaceId, filePath, thumbnailPath }))
  }

  listAssets(query: OnethingMediaQuery = {}, visible: OnethingMediaVisibility = () => true): OnethingMediaAsset[] {
    const index = this.loadIndex()
    const search = query.search?.trim().toLowerCase()
    return index.assets
      .filter(visible)
      .filter(asset => query.includeHidden || !asset.libraryHiddenAt)
      .filter(asset => !query.kind || asset.kind === query.kind)
      .filter(asset => !query.source || asset.source === query.source)
      .filter(asset => {
        if (!search) return true
        return [
          asset.fileName,
          asset.mimeType,
          asset.source,
          asset.metadata?.prompt,
          asset.metadata?.revisedPrompt,
          asset.metadata?.model,
        ].some(value => value?.toLowerCase().includes(search))
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  listLegacyImages(visible?: OnethingMediaVisibility): OnethingLegacyMediaItem[] {
    return this.listAssets({ kind: 'image' }, visible)
      .filter(asset => asset.filePath && fs.existsSync(asset.filePath))
      .map(mediaAssetToLegacyImage)
  }

  getAsset(id: string, includeHidden = true): OnethingMediaAsset | undefined {
    const asset = this.loadIndex().assets.find(item => item.id === id)
    if (!asset) return undefined
    if (!includeHidden && asset.libraryHiddenAt) return undefined
    return asset
  }

  hideAsset(id: string): boolean {
    const index = this.loadIndex()
    const asset = index.assets.find(item => item.id === id)
    if (!asset) return false
    asset.libraryHiddenAt = Date.now()
    asset.updatedAt = Date.now()
    this.saveIndex(index)
    return true
  }

  hideAllAssets(): void {
    const index = this.loadIndex()
    const now = Date.now()
    for (const asset of index.assets) {
      asset.libraryHiddenAt = asset.libraryHiddenAt || now
      asset.updatedAt = now
    }
    this.saveIndex(index)
  }

  getGallery(assetId: string, query: OnethingMediaQuery = {}, visible: OnethingMediaVisibility = () => true): { images: OnethingMediaAsset[]; currentIndex: number } {
    const images = this.listAssets({ ...query, kind: 'image' }, visible)
    let currentIndex = images.findIndex(asset => asset.id === assetId)

    if (currentIndex === -1) {
      const target = this.getAsset(assetId, true)
      if (target?.kind === 'image' && visible(target)) {
        images.unshift(target)
        currentIndex = 0
      }
    }

    return {
      images,
      currentIndex: Math.max(currentIndex, 0),
    }
  }

  ingestAttachment(input: OnethingMediaIngestAttachmentInput): OnethingMediaAsset | undefined {
    const index = this.loadIndex()
    const result = this.ingestAttachmentIntoIndex(index, input)
    if (result.changed) this.saveIndex(index)
    return result.asset
  }

  async ingestGeneratedImage(input: OnethingMediaIngestGeneratedImageInput, beforeCommit?: () => void): Promise<OnethingMediaAsset> {
    const operationIndex = this.paths.indexPath
    if (!input.base64 && !input.url) {
      throw new Error('No image data provided')
    }
    let buffer: Buffer
    if (input.base64) buffer = base64ToBuffer(input.base64)
    else {
      const pending = downloadToBuffer(input.url!)
      this.downloads.add(pending)
      void pending.then(() => this.downloads.delete(pending), () => this.downloads.delete(pending))
      buffer = await pending
    }
    if (this.paths.indexPath !== operationIndex) throw new Error('Media library changed during image download')
    beforeCommit?.()
    const contentHash = hashBuffer(buffer)
    const source: OnethingMediaSource = input.source ?? 'ai-generated'
    const link: OnethingMediaAssetLink = {
      sessionId: input.sessionId,
      messageId: input.messageId,
      role: 'assistant',
    }
    const existing = this.findByHashInIndex(this.loadIndex(), 'image', source, contentHash, [link])

    if (existing) {
      const index = this.loadIndex()
      const asset = index.assets.find(item => item.id === existing.id)
      if (asset) {
        mergeLink(asset, link)
        asset.metadata = {
          ...asset.metadata,
          prompt: asset.metadata?.prompt || input.prompt,
          revisedPrompt: asset.metadata?.revisedPrompt || input.revisedPrompt,
          model: asset.metadata?.model || input.model,
          originalUrl: asset.metadata?.originalUrl || input.url,
          usageTags: mergeUsageTags(asset.metadata?.usageTags, input.usageTags),
        }
        this.saveIndex(index)
        return asset
      }
    }

    return this.createStoredAsset({
      kind: 'image',
      source,
      buffer,
      mimeType: generatedImageMimeType(input.mediaType),
      fileName: undefined,
      link,
      contentHash,
      metadata: {
        prompt: input.prompt,
        revisedPrompt: input.revisedPrompt,
        model: input.model,
        originalUrl: input.url,
        usageTags: input.usageTags?.length ? [...input.usageTags] : undefined,
      },
    })
  }

  async saveGeneratedImageAsLegacyItem(
    input: OnethingMediaIngestGeneratedImageInput,
    beforeCommit?: () => void,
  ): Promise<OnethingLegacyMediaItem> {
    const asset = await this.ingestGeneratedImage(input, beforeCommit)
    return mediaAssetToLegacyImage(asset)
  }

  /**
   * Ingest files that never travelled through a chat message — a drop onto the
   * Media panel, a "选择文件" pick, a web upload.
   *
   * Three things it deliberately reuses rather than reinvents: the mime→kind
   * rule (`kindFromMimeType`), the dedup key (kind, source, contentHash and
   * provenance, shared with attachment ingest), and `createStoredAssetInIndex` — the ONLY
   * place in this class that writes bytes to disk.
   *
   * Errors are per file. A missing path is one line in `errors`, not a thrown
   * batch: dropping five files and losing all five because one was a dangling
   * symlink is the wrong failure mode.
   */
  ingestLocalFiles(input: OnethingMediaIngestLocalFilesInput, owner?: OnethingMediaImportOwner): OnethingMediaIngestLocalFilesResult {
    const index = this.loadIndex()
    const source: OnethingMediaSource = input.source ?? 'user-upload'
    const links = input.links ?? []
    const result: OnethingMediaIngestLocalFilesResult = {
      assets: [],
      created: 0,
      skipped: 0,
      errors: [],
    }
    let changed = false

    for (const file of input.files ?? []) {
      const fileName = file.fileName
        || (file.filePath ? basenamePath(file.filePath) : '')
        || 'untitled'
      try {
        const buffer = this.readIngestBuffer(file)
        const mimeType = file.mimeType || mimeFromFileName(fileName)
        const kind = kindFromMimeType(mimeType)
        const contentHash = hashBuffer(buffer)

        const existing = this.findByHashInIndex(index, kind, source, contentHash, links, owner)
        if (existing) {
          for (const link of links) {
            changed = mergeLink(existing, link) || changed
          }
          result.assets.push(existing)
          result.skipped += 1
          continue
        }

        const asset = this.createStoredAssetInIndex(index, {
          kind,
          source,
          buffer,
          mimeType,
          fileName,
          link: links[0] ?? {},
          contentHash,
          owner: links.some(link => link.sessionId) ? undefined : owner,
        })
        // `createStoredAssetInIndex` always seeds one link; with no caller-supplied
        // links that seed is an empty object, which would read as "linked to
        // nothing in particular" instead of "not linked".
        if (links.length === 0) asset.links = []
        for (const link of links.slice(1)) mergeLink(asset, link)

        result.assets.push(asset)
        result.created += 1
        changed = true
      } catch (error) {
        result.errors.push({
          fileName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (changed) this.saveIndex(index)
    return result
  }

  private readIngestBuffer(file: OnethingMediaIngestFileInput): Buffer {
    if (file.filePath) {
      if (!fs.existsSync(file.filePath)) {
        throw new Error(`File not found: ${file.filePath}`)
      }
      return fs.readFileSync(file.filePath)
    }
    if (file.base64Data) return base64ToBuffer(file.base64Data)
    throw new Error('No file data provided')
  }

  ingestMessageAttachments(
    sessionId: string,
    messageId: string,
    role: OnethingMediaRole,
    attachments?: OnethingMessageAttachment[],
  ): number {
    let added = 0
    for (const attachment of attachments ?? []) {
      try {
        const asset = this.ingestAttachment({ sessionId, messageId, role, attachment })
        if (asset) {
          attachment.mediaAssetId = asset.id
          // A pasted file has no path of its own — but its bytes were just
          // written to the media library, so a stable one exists. Adopting it
          // here (never overwriting the user's own path, which is the better
          // answer when it exists) is what lets the model reach the file with
          // read/bash: this runs before store.addMessage, so the path is in
          // the persisted message and survives every history rebuild.
          if (!attachment.filePath && asset.filePath) {
            attachment.filePath = asset.filePath
          }
          added += 1
        }
      } catch (error) {
        log.warn('attachment ingest failed', {
          sessionId,
          messageId,
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return added
  }

  rebuildFromSessions(sessions: OnethingMediaSession[]): { added: number; skipped: number } {
    let added = 0
    let skipped = 0
    let changed = false
    const index = this.loadIndex()

    for (const session of sessions) {
      for (const message of session.messages) {
        for (const attachment of message.attachments ?? []) {
          try {
            const result = this.ingestAttachmentIntoIndex(index, {
              sessionId: session.id,
              messageId: message.id,
              role: message.role,
              attachment,
            })
            changed = changed || result.changed
            if (!result.asset) {
              skipped += 1
              continue
            }
            if (result.created) added += 1
            else skipped += 1
          } catch (error) {
            log.warn('attachment backfill failed', {
              sessionId: session.id,
              messageId: message.id,
              attachmentId: attachment.id,
              fileName: attachment.fileName,
              error: error instanceof Error ? error.message : String(error),
            })
            skipped += 1
          }
        }
      }
    }

    if (changed) this.saveIndex(index)
    return { added, skipped }
  }

  private ingestAttachmentIntoIndex(
    index: OnethingMediaLibraryIndex,
    input: OnethingMediaIngestAttachmentInput,
  ): IngestMediaAssetResult {
    const attachment = input.attachment
    const kind = kindFromAttachment(attachment)
    const source: OnethingMediaSource = input.role === 'user' ? 'user-upload' : 'external'
    const link: OnethingMediaAssetLink = {
      sessionId: input.sessionId,
      messageId: input.messageId,
      attachmentId: attachment.id,
      role: input.role,
    }

    if (!attachment.base64Data) {
      return this.upsertMetadataOnlyAssetIntoIndex(index, {
        kind,
        source,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        link,
      })
    }

    const buffer = base64ToBuffer(attachment.base64Data)
    const contentHash = hashBuffer(buffer)
    const existing = this.findByHashInIndex(index, kind, source, contentHash, [link])
    if (existing) {
      const changed = mergeLink(existing, link)
      return {
        asset: existing,
        created: false,
        changed,
      }
    }

    return {
      asset: this.createStoredAssetInIndex(index, {
        kind,
        source,
        buffer,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        width: attachment.width,
        height: attachment.height,
        link,
        contentHash,
      }),
      created: true,
      changed: true,
    }
  }

  private upsertMetadataOnlyAsset(input: {
    kind: OnethingMediaKind
    source: OnethingMediaSource
    fileName: string
    mimeType: string
    size: number
    width?: number
    height?: number
    link: OnethingMediaAssetLink
  }): OnethingMediaAsset {
    const index = this.loadIndex()
    const result = this.upsertMetadataOnlyAssetIntoIndex(index, input)
    if (result.changed) this.saveIndex(index)
    if (!result.asset) throw new Error('Failed to create media asset')
    return result.asset
  }

  private upsertMetadataOnlyAssetIntoIndex(
    index: OnethingMediaLibraryIndex,
    input: {
      kind: OnethingMediaKind
      source: OnethingMediaSource
      fileName: string
      mimeType: string
      size: number
      width?: number
      height?: number
      link: OnethingMediaAssetLink
    },
  ): IngestMediaAssetResult {
    const existing = index.assets.find(asset =>
      asset.source === input.source &&
      asset.kind === input.kind &&
      asset.fileName === input.fileName &&
      asset.size === input.size &&
      asset.links.some(link => linkKey(link) === linkKey(input.link))
    )

    if (existing) {
      return {
        asset: existing,
        created: false,
        changed: false,
      }
    }

    const now = Date.now()
    const asset: OnethingMediaAsset = {
      id: createMediaId(),
      kind: input.kind,
      source: input.source,
      mimeType: input.mimeType,
      size: input.size,
      fileName: input.fileName,
      width: input.width,
      height: input.height,
      links: [input.link],
      createdAt: now,
      updatedAt: now,
    }
    index.assets.unshift(asset)
    return {
      asset,
      created: true,
      changed: true,
    }
  }

  private createStoredAsset(input: {
    kind: OnethingMediaKind
    source: OnethingMediaSource
    buffer: Buffer
    mimeType: string
    fileName?: string
    width?: number
    height?: number
    link: OnethingMediaAssetLink
    contentHash: string
    metadata?: OnethingMediaAsset['metadata']
  }): OnethingMediaAsset {
    const index = this.loadIndex()
    const asset = this.createStoredAssetInIndex(index, input)
    this.saveIndex(index)
    return asset
  }

  private createStoredAssetInIndex(
    index: OnethingMediaLibraryIndex,
    input: {
      kind: OnethingMediaKind
      source: OnethingMediaSource
      buffer: Buffer
      mimeType: string
      fileName?: string
      width?: number
      height?: number
      link: OnethingMediaAssetLink
      contentHash: string
      metadata?: OnethingMediaAsset['metadata']
      owner?: OnethingMediaImportOwner
    },
  ): OnethingMediaAsset {
    const id = createMediaId()
    const extension = mimeToExtension(input.mimeType, input.fileName)
    const fileName = input.fileName || `${id}${extension}`
    const storageDir = input.kind === 'image' ? this.paths.imagesDir : this.paths.filesDir
    ensureDir(storageDir)
    const storedFileName = `${id}${extension}`
    const filePath = joinPaths(storageDir, storedFileName)
    fs.writeFileSync(filePath, input.buffer)

    const now = Date.now()
    const asset: OnethingMediaAsset = {
      id,
      ...(input.owner ? { ownerUserId: input.owner.userId, ownerWorkspaceId: input.owner.workspaceId } : {}),
      kind: input.kind,
      source: input.source,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      fileName,
      filePath,
      width: input.width,
      height: input.height,
      contentHash: input.contentHash,
      links: [input.link],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    }

    index.assets.unshift(asset)
    return asset
  }

  private findByHashInIndex(
    index: OnethingMediaLibraryIndex,
    kind: OnethingMediaKind,
    source: OnethingMediaSource,
    contentHash: string,
    links: readonly OnethingMediaAssetLink[],
    owner?: OnethingMediaImportOwner,
  ): OnethingMediaAsset | undefined {
    return index.assets.find(asset =>
      asset.kind === kind &&
      asset.source === source &&
      asset.contentHash === contentHash &&
      provenanceKey(asset.links, { userId: asset.ownerUserId ?? 'local-user', workspaceId: asset.ownerWorkspaceId ?? 'default' }) === provenanceKey(links, owner)
    )
  }

  private loadIndex(): OnethingMediaLibraryIndex {
    const paths = this.paths
    if (this.indexCache) return this.indexCache

    const raw = readJsonFile<unknown>(paths.indexPath, { version: 2, assets: [] })
    if (isMediaLibraryIndex(raw)) {
      this.indexCache = {
        version: 2,
        assets: raw.assets.map(asset => ({
          ...asset,
          links: Array.isArray(asset.links) ? asset.links : [],
        })),
      }
      return this.indexCache
    }

    if (isLegacyIndex(raw)) {
      const migrated = this.migrateLegacyIndex(raw.items)
      this.indexCache = migrated
      return migrated
    }

    this.indexCache = { version: 2, assets: [] }
    return this.indexCache
  }

  private saveIndex(index: OnethingMediaLibraryIndex): void {
    ensureDir(dirnamePath(this.paths.indexPath))
    this.indexCache = index
    writeJsonFile(this.paths.indexPath, {
      version: 2,
      assets: index.assets,
    })
  }

  private migrateLegacyIndex(items: OnethingLegacyMediaItem[]): OnethingMediaLibraryIndex {
    const assets: OnethingMediaAsset[] = []
    const now = Date.now()

    for (const item of items) {
      const fileName = basenamePath(item.filePath || `${item.id}.png`)
      assets.push({
        id: item.id,
        kind: 'image',
        source: 'ai-generated',
        mimeType: 'image/png',
        size: 0,
        fileName,
        filePath: item.filePath,
        links: [{
          sessionId: item.sessionId,
          messageId: item.messageId,
          role: 'assistant',
        }],
        metadata: {
          prompt: item.prompt,
          revisedPrompt: item.revisedPrompt,
          model: item.model,
        },
        createdAt: item.createdAt || now,
        updatedAt: now,
      })
    }

    return { version: 2, assets }
  }
}

export { OnethingMediaLibraryService as MediaLibraryService }
