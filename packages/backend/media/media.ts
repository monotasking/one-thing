/**
 * media —— 媒体库:用户上传与 AI 生成的图片、文件按会话登记、落盘与取用,以及生图那条流。
 *
 * 对外交出四类东西:
 * - 媒体库:服务类 `OnethingMediaLibraryService`(`MediaLibraryService` 是它的别名)、它的几个形状、
 *   进程级单槽(`configureMediaLibraryService` / `mediaLibraryService`)与「存一张图」;
 * - 生图:请求规划、OpenAI 兼容的生图调用、流的开始 / 成功 / 失败事件规划与正文;
 * - 生成中的预览登记表、把本地图片读成 data URL;
 * - 两只调试日志口的形状。
 * 依赖 storage、logging。
 */

// 媒体库。
export { MediaLibraryService, OnethingMediaLibraryService } from './media-library-service.js'
export type { OnethingMediaAsset, OnethingMediaLibraryPaths, OnethingMediaSession } from './media-library-service.js'
export { configureMediaLibraryService, mediaLibraryService } from './media-library-service-bound.js'
export { saveMediaImage } from './media-save-image.js'

// 生图。只交外面真用到的(引擎的生图流与 `engine/__tests__/core-image-generation.test.ts`)。这一组从前整只转交
// (`export *`),因为里面有四个带服务商名的名字;批 2(D240)按内容改了名(`generateImageViaImagesApi` 等:它们实现的是
// `/images/generations` 那一套生图 HTTP 接口),这里就改成具名。
export {
  buildImageGeneratedNotification,
  buildImageGenerationErrorContent,
  buildImageStreamErrorEventPlan,
  buildImageStreamResponseContent,
  buildImageStreamStartEventPlan,
  buildImageStreamSuccessEventPlan,
  buildImagesApiRequest,
  executeCoreImageGenerationStream,
  executeOnethingImageGenerationStream,
  extractImageGenerationResponseError,
  extractImagesApiPayload,
  generateImageViaImagesApi,
  normalizeImageModelId,
  normalizeImagesApiBaseUrl,
  planImageGenerationRequest,
} from './media-image-generation.js'
export type {
  CoreImageGenerationResult,
  CoreImageStreamStoreAdapter,
  ExecuteCoreImageGenerationStreamOptions,
} from './media-image-generation.js'

// 预览与读图。
export { OnethingImagePreviewRegistry } from './media-image-preview-registry.js'
export { readOnethingImageFileDataUrl } from './media-image-file-data-url.js'

// 调试日志口。
export type { OnethingImageFileDataUrlIpcLogger } from './media-image-file-data-url.js'
export type { OnethingMediaIpcLogger } from './media-library-presentation.js'
