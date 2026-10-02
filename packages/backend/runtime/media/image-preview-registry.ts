export interface OnethingImagePreviewRecord {
  src: string
  alt?: string
  createdAt: number
}


export type OnethingImagePreviewLookupResult =
  | { success: true; src: string; alt?: string }
  | { success: false; error: string }

export class OnethingImagePreviewRegistry {
  private readonly records = new Map<string, OnethingImagePreviewRecord>()
  private readonly ttlMs: number
  private readonly maxRecords: number
  private readonly now: () => number

  constructor(private readonly options: {
    ttlMs?: number
    maxRecords?: number
    createId(): string
    now?(): number
  }) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.maxRecords = options.maxRecords ?? 20
    this.now = options.now ?? (() => Date.now())
  }

  create(src: string, alt?: string): string {
    this.prune()
    const previewId = this.options.createId()
    this.records.set(previewId, {
      src,
      alt,
      createdAt: this.now(),
    })
    this.pruneOverflow()
    return previewId
  }

  get(previewId: string): OnethingImagePreviewLookupResult {
    this.prune()
    const record = this.records.get(previewId)
    if (!record) {
      return { success: false, error: 'Image preview expired or was not found' }
    }
    return {
      success: true,
      src: record.src,
      alt: record.alt,
    }
  }

  size(): number {
    this.prune()
    return this.records.size
  }

  clear(): void {
    this.records.clear()
  }

  private prune(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      if (now - record.createdAt > this.ttlMs) {
        this.records.delete(id)
      }
    }
    this.pruneOverflow()
  }

  private pruneOverflow(): void {
    while (this.records.size > this.maxRecords) {
      const oldestId = this.records.keys().next().value
      if (!oldestId) break
      this.records.delete(oldestId)
    }
  }
}

export type OnethingImagePreviewWindowRequest =
  | { mode: 'single'; previewId: string; alt?: string }
  | { mode: 'gallery'; mediaId: string }

export type OpenOnethingImagePreviewForIpcResult =
  | { success: true; previewId: string }
  | { success: false; error: string }

export type OpenOnethingImageGalleryForIpcResult =
  | { success: true }
  | { success: false; error: string }

export interface OpenOnethingImagePreviewForIpcOptions {
  registry: Pick<OnethingImagePreviewRegistry, 'create'>
  src: string
  alt?: string
  openPreviewWindow(request: OnethingImagePreviewWindowRequest): unknown | Promise<unknown>
  logger?: Pick<Console, 'log' | 'error'>
}

export interface OpenOnethingImageGalleryForIpcOptions {
  mediaId: string
  openPreviewWindow(request: OnethingImagePreviewWindowRequest): unknown | Promise<unknown>
  logger?: Pick<Console, 'log' | 'error'>
}

function previewErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Failed to open image preview'
}

export async function openOnethingImagePreviewForIpc(
  options: OpenOnethingImagePreviewForIpcOptions,
): Promise<OpenOnethingImagePreviewForIpcResult> {
  try {
    const previewId = options.registry.create(options.src, options.alt)
    options.logger?.log('[Media Runtime] Opening image preview window:', {
      previewId,
      alt: options.alt,
      srcPrefix: options.src.substring(0, 50),
      srcLength: options.src.length,
    })
    await options.openPreviewWindow({ mode: 'single', previewId, alt: options.alt })
    return { success: true, previewId }
  } catch (error) {
    const message = previewErrorMessage(error)
    options.logger?.error('[Media Runtime] Failed to open image preview window:', error)
    return { success: false, error: message }
  }
}

export async function openOnethingImageGalleryForIpc(
  options: OpenOnethingImageGalleryForIpcOptions,
): Promise<OpenOnethingImageGalleryForIpcResult> {
  try {
    options.logger?.log('[Media Runtime] Opening image gallery for mediaId:', options.mediaId)
    await options.openPreviewWindow({ mode: 'gallery', mediaId: options.mediaId })
    return { success: true }
  } catch (error) {
    const message = previewErrorMessage(error)
    options.logger?.error('[Media Runtime] Failed to open image gallery:', error)
    return { success: false, error: message }
  }
}
