/**
 * media(媒体库)域 —— 结构债 P4c 第三批,十一条数据面从手写 IPC 通道搬到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/media.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/media.ts`
 *    那层壳适配。旧线上除了六条 `IPC_CHANNELS.*_MEDIA_*` 常量,还有**五条写死的
 *    字面量通道**(`media:save-image` / `media:load-all` / `media:delete` /
 *    `media:clear-all` / `media:read-image-base64`)—— 它们根本不在契约表里,
 *    transport 门连数都数不到。搬完之后这五条不再存在。
 *  - `preload/bridge.ts` 的十一条包装与 `platform/web.ts` 的十一条 REST 镜像;
 *  - `server/http.ts` 的十一条 REST 路由与 `server/runtime.ts` 那个 media facade
 *    adapter 里对应的十一个方法(连同它们背后的 `toServerClientMediaAsset` /
 *    `toServerClientLegacyMediaItem` 路径改写)。
 *
 * 逻辑一行没搬:十一条**逐条**转调 `@onething/runtime/media` 的投影
 * (`*OnethingMedia*` / `*ForIpc`),库本体照旧是 `library-service-bound` 那台
 * 单例 —— 与迁移前 `@main` 那份适配逐字同义。
 *
 * **留在宿主侧的三条**(P4 终态的「窗口系残留集」,拍板 #10):`saveAs`(原生保存
 * 对话框)、`openPreview` / `openGallery`(`BrowserWindow`)。它们要的是宿主本体
 * 而不是数据,所以仍是手写通道。`getPreview` 跟着数据走:它读的是那本进程内的
 * 预览登记簿,开窗那半写、这半读,两边共用
 * `@onething/runtime/media/image-preview-registry-bound` 的同一本簿子。
 *
 * **`ingestFiles` 的入参是「本机路径列表」**(桌面拖拽给的是 filePath,浏览器
 * 给的是 base64)。域挂上 router 之后它经 server 也可达,于是 server 会去读
 * **server 本机**的那些路径 —— 这与桌面语义相同(单用户、同一台机、同一个 store),
 * 但它确实比从前的 REST 面宽:旧的 `/api/media/ingest` 走的是同一份投影,同样
 * 收 filePath,所以这不是本批新开的口子,只是换了通道。
 */
import {
  clearOnethingMediaLibrary,
  deleteOnethingMediaItem,
  getOnethingMediaGallery,
  hideOnethingMediaAsset,
  ingestOnethingMediaFilesForIpc,
  listOnethingLegacyMediaImages,
  listOnethingMediaAssets,
  readOnethingImageFileDataUrlForIpc,
  rebuildOnethingMediaLibraryForIpc,
  type OnethingMediaIngestLocalFilesInput,
  type OnethingMediaQuery,
} from '@onething/runtime/media'
import { imagePreviewRegistry } from '@onething/runtime/media/image-preview-registry-bound'
import { mediaLibraryService } from '@onething/runtime/media/library-service-bound'
import { saveMediaImage } from '@onething/runtime/media/save-image'
import type { MediaRoutes } from '@shared/ipc/media.js'
import { getSessions } from '../../stores/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.media')
/** 投影层收的是鸭子 logger;过渡替身与旧的 `@main` 适配用的是同一个(area ① 统一后删)。 */
const consoleLog = consolePort(log)

export const mediaRpcHandlers: RpcRouteHandlers<MediaRoutes> = {
  async listAssets(request) {
    return listOnethingMediaAssets({
      query: (request?.query as OnethingMediaQuery | undefined) || {},
      listAssets: mediaQuery => mediaLibraryService.listAssets(mediaQuery),
    })
  },
  async ingestFiles(request) {
    return ingestOnethingMediaFilesForIpc({
      request: (request as OnethingMediaIngestLocalFilesInput | undefined) || { files: [] },
      ingestFiles: input => mediaLibraryService.ingestLocalFiles(input),
      logger: consoleLog,
    })
  },
  async hideAsset(request) {
    return hideOnethingMediaAsset({
      id: request.id,
      hideAsset: assetId => mediaLibraryService.hideAsset(assetId),
    })
  },
  async rebuildLibrary() {
    return rebuildOnethingMediaLibraryForIpc({
      listSessions: getSessions,
      rebuildFromSessions: sessions => mediaLibraryService.rebuildFromSessions(sessions),
      logger: consoleLog,
    })
  },
  async getGallery(request) {
    return getOnethingMediaGallery({
      assetId: request.assetId,
      query: (request.query as OnethingMediaQuery | undefined) || {},
      getGallery: (assetId, mediaQuery) => mediaLibraryService.getGallery(assetId, mediaQuery),
    })
  },
  async saveImage(request) {
    return saveMediaImage(request)
  },
  async loadAll() {
    return listOnethingLegacyMediaImages({
      listLegacyImages: () => mediaLibraryService.listLegacyImages(),
    })
  },
  async delete(request) {
    return deleteOnethingMediaItem({
      id: request.id,
      hideAsset: assetId => mediaLibraryService.hideAsset(assetId),
    })
  },
  async clearAll() {
    await clearOnethingMediaLibrary({
      hideAllAssets: () => mediaLibraryService.hideAllAssets(),
    })
  },
  async readImageBase64(request) {
    return readOnethingImageFileDataUrlForIpc(request.filePath, { logger: consoleLog })
  },
  async getPreview(request) {
    return imagePreviewRegistry.get(request.previewId)
  },
}

