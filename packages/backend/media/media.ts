/**
 * media —— 媒体库:用户上传与 AI 生成的图片、文件按会话登记、落盘与取用,以及生图那条流。
 *
 * 对外交出四类东西:
 * - 媒体库:服务类 `OnethingMediaLibraryService`(`MediaLibraryService` 是它的别名)、它的几个形状、
 *   进程级单槽(`configureMediaLibraryService` / `mediaLibraryService`)与「存一张图」;
 * - 生图:请求规划、OpenAI 兼容的生图调用、流的开始 / 成功 / 失败事件规划与正文(整只转交,见下);
 * - 生成中的预览登记表、把本地图片读成 data URL;
 * - 两只调试日志口的形状。
 * 依赖 storage、logging。
 */

// 媒体库。
export { MediaLibraryService, OnethingMediaLibraryService } from './media-library-service.js'
export type { OnethingMediaAsset, OnethingMediaLibraryPaths, OnethingMediaSession } from './media-library-service.js'
export { configureMediaLibraryService, mediaLibraryService } from './media-library-service-bound.js'
export { saveMediaImage } from './media-save-image.js'

// 生图。这一组**整只转交**(`export *`,本入口唯一的一处):里面有四个名字带服务商的名字
// (`buildOpenAIImageGenerationRequest` 等),在入口里逐个写出来就让 `provider:gate` 多出一对
// (openai, media/media.ts);要具名交出得先给它们改成不带服务商名的名字,那是另一笔。
export * from './media-image-generation.js'

// 预览与读图。
export { OnethingImagePreviewRegistry } from './media-image-preview-registry.js'
export { readOnethingImageFileDataUrl } from './media-image-file-data-url.js'

// 调试日志口。
export type { OnethingImageFileDataUrlIpcLogger } from './media-image-file-data-url.js'
export type { OnethingMediaIpcLogger } from './media-library-presentation.js'
