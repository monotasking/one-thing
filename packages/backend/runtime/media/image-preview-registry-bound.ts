/**
 * 单图预览登记簿的**进程内那一本**(结构债 P4c 第三批)。
 *
 * 为什么要有「绑定好的一本」:预览这件事天生被劈成两半 —— 开窗那半要宿主
 * (`BrowserWindow`,留在桌面宿主的手写通道上),
 * 取内容那半是纯数据(`media.getPreview`,已迁到通用 RPC 通道)。两半必须读写
 * **同一本簿子**,而它们从此住在不同的包里,所以簿子得有一个共同的家。
 *
 * 放在产品层而不是装配层:登记簿本身零依赖、零 Electron —— `image-preview-registry.ts`
 * 就在隔壁,这里只是把 `createId` 接上 `node:crypto`(从前是 `@main` 那侧的 `uuid`,
 * 同样是一串 v4 UUID,对调用方是不透明字符串)。与 `library-service-bound.ts`
 * 同型:同目录里「纯类 + 绑好的单例」这一对。
 */
import { randomUUID } from 'node:crypto'
import { OnethingImagePreviewRegistry } from './image-preview-registry.js'

/** 一个进程一本。TTL / 容量沿用登记簿自己的默认(10 分钟 / 20 条)。 */
export const imagePreviewRegistry = new OnethingImagePreviewRegistry({
  createId: () => randomUUID(),
})
