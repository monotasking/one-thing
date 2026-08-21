/**
 * media(媒体库)域的渲染侧客户端 —— 结构债 P4c 第三批。
 *
 * 形状照 `skills-client.ts` / `spaces-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动;**不包一层旧签名** —— 被删掉的十一个壳
 * 方法多是位置参数的(`getMediaGallery(assetId, query)`、`readImageBase64(filePath)`),
 * 这里一律是信封:`mediaApi.getGallery({ assetId, query })`、
 * `mediaApi.readImageBase64({ filePath })`。
 *
 * 无参的三条(`rebuildLibrary` / `loadAll` / `clearAll`)按本仓惯例递 `{}`。
 *
 * 没搬过来的三条仍在 `platformApi` 上:`saveMediaAs` / `openImagePreview` /
 * `openImageGallery` —— 它们要的是宿主本体(保存对话框、两个 BrowserWindow),
 * 不是数据。
 */
import { mediaRouter } from '@shared/ipc/media.js'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

export const mediaApi = createRouterClient(mediaRouter, request =>
  platformApi.rpcInvoke(request),
)
