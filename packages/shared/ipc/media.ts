export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'file'

export type MediaSource = 'user-upload' | 'ai-generated' | 'tool-output' | 'external'

export type MediaUsageTag = 'persona-avatar' | 'video-character' | 'chat-reference'

export interface MediaAssetLink {
  sessionId?: string
  messageId?: string
  attachmentId?: string
  role?: 'user' | 'assistant' | 'system' | 'error'
}

export interface MediaAssetMetadata {
  prompt?: string
  revisedPrompt?: string
  model?: string
  usageTags?: MediaUsageTag[]
  originalUrl?: string
}

export interface MediaAsset {
  id: string
  kind: MediaKind
  source: MediaSource
  mimeType: string
  size: number
  fileName: string
  filePath?: string
  thumbnailPath?: string
  width?: number
  height?: number
  contentHash?: string
  links: MediaAssetLink[]
  metadata?: MediaAssetMetadata
  createdAt: number
  updatedAt?: number
  libraryHiddenAt?: number
}

export interface MediaQuery {
  kind?: MediaKind
  source?: MediaSource
  search?: string
  includeHidden?: boolean
}

/**
 * Mirror of `OnethingMediaIngestFileInput` (runtime side). Exactly one of
 * `filePath` / `base64Data` carries the bytes: the desktop hands over a path
 * (no base64 round trip through IPC), the browser only ever has bytes.
 */
export interface MediaIngestFileInput {
	filePath?: string;
	base64Data?: string;
	fileName: string;
	mimeType?: string;
}

export interface MediaIngestFilesRequest {
	files: MediaIngestFileInput[];
	/** Defaults to 'user-upload' on the service side. */
	source?: MediaSource;
	links?: MediaAssetLink[];
}

export interface MediaIngestFilesResponse {
	success: boolean;
	assets: MediaAsset[];
	created: number;
	skipped: number;
	/** Per-file failures. A bad path never sinks the rest of the batch. */
	errors: { fileName: string; error: string }[];
	error?: string;
}

/**
 * "另存为". With `targetDir` the copy is silent (multi-select saves pick one
 * directory and then write N files); without it the host opens a save dialog.
 */
export interface MediaSaveAsRequest {
	filePath: string;
	fileName?: string;
	targetDir?: string;
}

export interface MediaSaveAsResponse {
	success: boolean;
	canceled?: boolean;
	path?: string;
	error?: string;
}

export interface MediaGalleryResponse {
  images: MediaAsset[]
  currentIndex: number
}

export interface MediaRebuildResponse {
  success: boolean
  added: number
  skipped: number
  error?: string
}

/**
 * A generated image as the LEGACY media shape — the row `saveImage` / `loadAll`
 * speak. Mirror of the runtime's `OnethingLegacyMediaItem`; declared here (not
 * imported) because `@shared` may not depend on the product layer, and the two
 * were already duplicated inline in `ElectronAPI` before P4c 第三批.
 */
export interface MediaLegacyItem {
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

/**
 * Park a generated (or picked) image in the library. Mirror of the runtime's
 * `OnethingMediaIngestGeneratedImageInput`; it used to live twice — once as
 * `ElectronMediaSaveImageRequest` in the Electron IPC factory and once inline
 * in `ElectronAPI` / `platform/web.ts`.
 */
export interface MediaSaveImageRequest {
  url?: string
  base64?: string
  prompt: string
  revisedPrompt?: string
  model: string
  sessionId: string
  messageId: string
  /** Where the bytes came from. Defaults to 'ai-generated' on the service side. */
  source?: MediaSource
  /** What the image is for, e.g. 'persona-avatar'. */
  usageTags?: MediaUsageTag[]
}

/** What a parked single-image preview resolves to. */
export interface MediaPreviewLookupResponse {
  success: boolean
  src?: string
  alt?: string
  error?: string
}

/**
 * media(媒体库)域 —— 结构债 P4c 第三批。
 *
 * **十一条数据面**在这里;三条**宿主残留**不在:「另存为」(`SAVE_MEDIA_AS`,
 * 一次原生保存对话框)、「开预览窗」/「开画廊窗」(`OPEN_IMAGE_PREVIEW` /
 * `OPEN_IMAGE_GALLERY`,一次 `BrowserWindow`)。它们要的是宿主本体而不是数据,
 * 按 P4 终态留在手写通道上(拍板 #10 的「窗口系残留集」)。
 *
 * `getPreview` 是数据面而不是窗口面 —— 它读的是那本进程内的预览登记簿
 * (`runtime/media/image-preview-registry-bound`),开窗那半留在宿主侧,两边
 * 因此共用同一本簿子。
 *
 * 位置参数一律折成信封:`readImageBase64({ filePath })`、
 * `getGallery({ assetId, query })` —— 与 skills 同一判例(渲染侧不再包一层旧签名)。
 */
import { defineRouter } from './router.js'

export type MediaRoutes = {
  listAssets: { input: { query?: MediaQuery }; output: MediaAsset[] }
  ingestFiles: { input: MediaIngestFilesRequest; output: MediaIngestFilesResponse }
  hideAsset: { input: { id: string }; output: { success: boolean } }
  rebuildLibrary: { input: Record<string, never>; output: MediaRebuildResponse }
  getGallery: { input: { assetId: string; query?: MediaQuery }; output: MediaGalleryResponse }
  saveImage: { input: MediaSaveImageRequest; output: MediaLegacyItem }
  loadAll: { input: Record<string, never>; output: MediaLegacyItem[] }
  delete: { input: { id: string }; output: boolean }
  clearAll: { input: Record<string, never>; output: void }
  readImageBase64: { input: { filePath: string }; output: string }
  getPreview: { input: { previewId: string }; output: MediaPreviewLookupResponse }
}

export const mediaRouter = defineRouter<MediaRoutes>('media', [
  'listAssets',
  'ingestFiles',
  'hideAsset',
  'rebuildLibrary',
  'getGallery',
  'saveImage',
  'loadAll',
  'delete',
  'clearAll',
  'readImageBase64',
  'getPreview',
])

/**
 * 媒体域**要宿主本体的三条**(结构债 P4 终态批 A1-a,2026-08-23)。
 *
 * 它们从手写通道搬到**宿主壳路由**(`shell:invoke`),分界线一字未改 ——
 * 上面 `mediaRouter` 的十一条是数据面(装配层能做,桌面/web 同一份实现),
 * 这三条要的是宿主本体:
 *  - `saveAs` —— 一次原生保存对话框;
 *  - `openPreview` / `openGallery` —— 各一个 `BrowserWindow`。
 *
 * web 侧不是"做不到"就完事:开预览在浏览器里是**就地**把图交给页内的
 * `ImagePreviewWindow`(一次本地广播),开画廊如实回一次不改变任何东西的成功,
 * 另存为如实说做不到并让调用点退回 `<a download>` —— 三段都是迁移前 web.ts 里
 * 那几段的逐字搬迁。
 */
export interface MediaOpenImagePreviewRequest {
  src: string
  alt?: string
}

export interface MediaOpenImagePreviewResponse {
  success: boolean
  previewId?: string
  error?: string
}

export interface MediaOpenImageGalleryRequest {
  mediaId: string
}

export interface MediaOpenImageGalleryResponse {
  success: boolean
  error?: string
}

export type MediaWindowRoutes = {
  saveAs: { input: MediaSaveAsRequest; output: MediaSaveAsResponse }
  openPreview: { input: MediaOpenImagePreviewRequest; output: MediaOpenImagePreviewResponse }
  openGallery: { input: MediaOpenImageGalleryRequest; output: MediaOpenImageGalleryResponse }
}

export const mediaWindowRouter = defineRouter<MediaWindowRoutes>('media-window', [
  'saveAs',
  'openPreview',
  'openGallery',
])
