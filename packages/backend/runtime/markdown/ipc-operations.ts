import type {
  MarkdownAssetResolution,
  MarkdownResolveAssetRequest,
  MarkdownSaveAttachmentsRequest,
  MarkdownSaveAttachmentsResponse,
} from './asset-service.js'

type MaybePromise<T> = T | Promise<T>

export interface MarkdownResolveAssetResponse {
  success: boolean
  asset?: MarkdownAssetResolution
  error?: string
}

export interface ResolveOnethingMarkdownAssetForIpcOptions {
  request: MarkdownResolveAssetRequest
  resolveAsset(request: MarkdownResolveAssetRequest): MaybePromise<MarkdownAssetResolution>
}

export async function resolveOnethingMarkdownAssetForIpc(
  options: ResolveOnethingMarkdownAssetForIpcOptions,
): Promise<MarkdownResolveAssetResponse> {
  try {
    return {
      success: true,
      asset: await options.resolveAsset(options.request),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to resolve Markdown asset',
    }
  }
}

export interface SaveOnethingMarkdownAttachmentsForIpcOptions {
  request: MarkdownSaveAttachmentsRequest
  saveAttachments(request: MarkdownSaveAttachmentsRequest): MaybePromise<MarkdownSaveAttachmentsResponse>
}

export async function saveOnethingMarkdownAttachmentsForIpc(
  options: SaveOnethingMarkdownAttachmentsForIpcOptions,
): Promise<MarkdownSaveAttachmentsResponse> {
  try {
    return await options.saveAttachments(options.request)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Markdown attachments',
      code: 'INTERNAL',
    }
  }
}
