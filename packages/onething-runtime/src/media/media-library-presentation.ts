type MaybePromise<T> = T | Promise<T>

export interface OnethingMediaIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface ListOnethingMediaAssetsOptions<TQuery = unknown, TAsset = unknown> {
  query: TQuery
  listAssets(query: TQuery): MaybePromise<TAsset[]>
}

export async function listOnethingMediaAssets<TQuery = unknown, TAsset = unknown>(
  options: ListOnethingMediaAssetsOptions<TQuery, TAsset>,
): Promise<TAsset[]> {
  return await options.listAssets(options.query)
}

export interface HideOnethingMediaAssetOptions {
  id: string
  hideAsset(id: string): MaybePromise<boolean>
}

export interface HideOnethingMediaAssetResult {
  success: boolean
}

export async function hideOnethingMediaAsset(
  options: HideOnethingMediaAssetOptions,
): Promise<HideOnethingMediaAssetResult> {
  return {
    success: await options.hideAsset(options.id),
  }
}

export interface RebuildOnethingMediaLibraryOptions<TSession = unknown> {
  sessions: TSession[]
  rebuildFromSessions(sessions: TSession[]): MaybePromise<{ added: number; skipped: number }>
}

export interface RebuildOnethingMediaLibraryResult {
  success: true
  added: number
  skipped: number
}

export async function rebuildOnethingMediaLibrary<TSession = unknown>(
  options: RebuildOnethingMediaLibraryOptions<TSession>,
): Promise<RebuildOnethingMediaLibraryResult> {
  const result = await options.rebuildFromSessions(options.sessions)
  return {
    success: true,
    ...result,
  }
}

export async function rebuildOnethingMediaLibraryForIpc<TSession = unknown>(
  options: {
    listSessions(): MaybePromise<TSession[]>
    rebuildFromSessions(sessions: TSession[]): MaybePromise<{ added: number; skipped: number }>
    logger?: OnethingMediaIpcLogger
  },
): Promise<RebuildOnethingMediaLibraryResult | {
  success: false
  added: number
  skipped: number
  error: string
}> {
  try {
    return await rebuildOnethingMediaLibrary({
      sessions: await options.listSessions(),
      rebuildFromSessions: options.rebuildFromSessions,
    })
  } catch (error) {
    options.logger?.error?.('[Media IPC] Failed to rebuild media library:', error)
    return {
      success: false,
      added: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface IngestOnethingMediaFilesOptions<TRequest = unknown, TAsset = unknown> {
  request: TRequest
  ingestFiles(request: TRequest): MaybePromise<{
    assets: TAsset[]
    created: number
    skipped: number
    errors: { fileName: string; error: string }[]
  }>
  logger?: OnethingMediaIpcLogger
}

export interface IngestOnethingMediaFilesResult<TAsset = unknown> {
  success: boolean
  assets: TAsset[]
  created: number
  skipped: number
  errors: { fileName: string; error: string }[]
  error?: string
}

/**
 * Host-facing shape for "put these files in the library". Per-file failures
 * already ride inside `errors` (the service never throws for one bad file), so
 * the catch here only covers the batch-level accident — an unwritable index,
 * a missing store. Both hosts get the same envelope.
 */
export async function ingestOnethingMediaFilesForIpc<TRequest = unknown, TAsset = unknown>(
  options: IngestOnethingMediaFilesOptions<TRequest, TAsset>,
): Promise<IngestOnethingMediaFilesResult<TAsset>> {
  try {
    const result = await options.ingestFiles(options.request)
    return {
      success: true,
      assets: result.assets,
      created: result.created,
      skipped: result.skipped,
      errors: result.errors,
    }
  } catch (error) {
    options.logger?.error?.('[Media IPC] Failed to ingest media files:', error)
    return {
      success: false,
      assets: [],
      created: 0,
      skipped: 0,
      errors: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export interface GetOnethingMediaGalleryOptions<TQuery = unknown, TAsset = unknown> {
  assetId: string
  query: TQuery
  getGallery(assetId: string, query: TQuery): MaybePromise<{ images: TAsset[]; currentIndex: number }>
}

export async function getOnethingMediaGallery<TQuery = unknown, TAsset = unknown>(
  options: GetOnethingMediaGalleryOptions<TQuery, TAsset>,
): Promise<{ images: TAsset[]; currentIndex: number }> {
  return await options.getGallery(options.assetId, options.query)
}

export interface ListOnethingLegacyMediaImagesOptions<TMediaItem = unknown> {
  listLegacyImages(): MaybePromise<TMediaItem[]>
}

export async function listOnethingLegacyMediaImages<TMediaItem = unknown>(
  options: ListOnethingLegacyMediaImagesOptions<TMediaItem>,
): Promise<TMediaItem[]> {
  return await options.listLegacyImages()
}

export interface DeleteOnethingMediaItemOptions {
  id: string
  hideAsset(id: string): MaybePromise<boolean>
}

export async function deleteOnethingMediaItem(
  options: DeleteOnethingMediaItemOptions,
): Promise<boolean> {
  return await options.hideAsset(options.id)
}

export interface ClearOnethingMediaLibraryOptions {
  hideAllAssets(): MaybePromise<void>
}

export async function clearOnethingMediaLibrary(
  options: ClearOnethingMediaLibraryOptions,
): Promise<void> {
  await options.hideAllAssets()
}
