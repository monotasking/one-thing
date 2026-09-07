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
 *
 * ---
 * 2026-09-07 之后:域改成 `createMediaRpcHandlers(ports)` 的工厂,十一条口在库本体
 * 之前先过一道归属闸(`wiring/media/access.ts`:资产按它挂的会话判、路径按沙箱判)。
 * 上面那些判例一条没作废 —— 换的是「谁看得见」,不是「货从哪来」。
 */
import {
  ingestOnethingMediaFilesForIpc, readOnethingImageFileDataUrlForIpc,
  type OnethingMediaLibraryService, type OnethingMediaSession, type OnethingImagePreviewRegistry,
} from '@onething/runtime/media'
import { imagePreviewRegistry } from '@onething/runtime/media/image-preview-registry-bound'
import { mediaLibraryService } from '@onething/runtime/media/library-service-bound'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { MediaRoutes } from '@shared/ipc/media.js'
import { getSession, getSessionsList } from '../../stores/sessions.js'
import { DEFAULT_SESSION_OWNER, SessionAccessError, ownerMatchesContext, requestSessionOwner, sessionAccess, type SessionAccess } from '../../session/access.js'
import { assertMediaAccess, assertMediaPathSources, createMediaPathAccess, mediaVisible, resolveMediaInputPath } from '../../wiring/media/access.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'

const consoleLog = consolePort(getLogger('rpc.media'))

export interface MediaRpcPorts {
  library: OnethingMediaLibraryService
  access: SessionAccess
  listSessions(): readonly { id: string }[]
  getSession(id: string): OnethingMediaSession | undefined
  previews: Pick<OnethingImagePreviewRegistry, 'get'>
}

/** Transport supplies identity; the library owns bytes and provenance, never caller payloads. */
export function createMediaRpcHandlers(ports: MediaRpcPorts): RpcRouteHandlers<MediaRoutes> {
  const { library, access } = ports
  const { readPath, previewSource } = createMediaPathAccess(library, access)
  function assertAsset(context: RpcDispatchContext, id: string, write = false) {
    const asset = library.listAssetAccess().find(asset => asset.id === id)
    if (!asset) throw new SessionAccessError()
    assertMediaAccess(access, context, asset, write ? 'write' : 'read')
    return asset
  }
  return {
    async listAssets(request, context = DESKTOP_RPC_CONTEXT) {
      return library.listAssets(request?.query ?? {}, mediaVisible(access, context))
    },
    async ingestFiles(request, context = DESKTOP_RPC_CONTEXT) {
      const input = request ?? { files: [] }
      for (const link of input.links ?? []) {
        if (!link.sessionId) throw new SessionAccessError()
        access.resolve(context, link.sessionId, 'write')
      }
      // Preflight every path before the first file read or library mutation.
      const files = input.files.map(file => {
        if (!file.filePath) return file
        const filePath = resolveMediaInputPath(context, file.filePath)
        assertMediaPathSources(library, access, context, filePath)
        return { ...file, filePath }
      })
      return ingestOnethingMediaFilesForIpc({
        request: { files, source: input.source, links: input.links },
        ingestFiles: value => library.ingestLocalFiles(value, requestSessionOwner(context)), logger: consoleLog,
      })
    },
    async hideAsset(request, context = DESKTOP_RPC_CONTEXT) {
      assertAsset(context, request.id, true)
      return { success: library.hideAsset(request.id) }
    },
    async rebuildLibrary(_request, context = DESKTOP_RPC_CONTEXT) {
      const ids = ports.listSessions().map(meta => meta.id)
      access.resolveAll(context, ids, 'write')
      library.listAssetAccess().forEach(asset => assertMediaAccess(access, context, asset, 'write'))
      const sessions = ids.map(id => ports.getSession(id)).filter((session): session is OnethingMediaSession => !!session)
      return { success: true, ...library.rebuildFromSessions(sessions) }
    },
    async getGallery(request, context = DESKTOP_RPC_CONTEXT) {
      assertAsset(context, request.assetId)
      return library.getGallery(request.assetId, request.query ?? {}, mediaVisible(access, context))
    },
    async saveImage(request, context = DESKTOP_RPC_CONTEXT) {
      const authorize = () => access.resolve(context, request.sessionId, 'write')
      authorize()
      return library.saveGeneratedImageAsLegacyItem(request, authorize)
    },
    async loadAll(_request, context = DESKTOP_RPC_CONTEXT) {
      return library.listLegacyImages(mediaVisible(access, context))
    },
    async delete(request, context = DESKTOP_RPC_CONTEXT) {
      assertAsset(context, request.id, true)
      return library.hideAsset(request.id)
    },
    async clearAll(_request, context = DESKTOP_RPC_CONTEXT) {
      library.listAssetAccess().forEach(asset => assertMediaAccess(access, context, asset, 'write'))
      library.hideAllAssets()
    },
    async readImageBase64(request, context = DESKTOP_RPC_CONTEXT) {
      return readOnethingImageFileDataUrlForIpc(readPath(context, request.filePath), { logger: consoleLog })
    },
    async getPreview(request, context = DESKTOP_RPC_CONTEXT) {
      // This registry is created exclusively by native desktop preview windows.
      if (!ownerMatchesContext(DEFAULT_SESSION_OWNER, context)) throw new SessionAccessError()
      const preview = ports.previews.get(request.previewId)
      if (preview.success) previewSource(context, preview.src)
      return preview
    },
  }
}

export const mediaRpcHandlers = createMediaRpcHandlers({
  library: mediaLibraryService, access: sessionAccess, listSessions: getSessionsList, getSession,
  previews: imagePreviewRegistry,
})
