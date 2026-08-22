/**
 * 媒体域「要宿主本体的三条」的渲染侧客户端 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * `saveAs` / `openPreview` / `openGallery`。十一条数据面在
 * `platform/media-client.ts`(走 `rpc:invoke`);这三条走 `shell:invoke`。
 * 入参折成信封:`mediaWindowApi.openPreview({ src, alt })`。
 */
import { mediaWindowRouter } from '@shared/ipc/media.js'
import { createShellClient } from './shell-client'

export const mediaWindowApi = createShellClient(mediaWindowRouter)
