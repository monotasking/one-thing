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
