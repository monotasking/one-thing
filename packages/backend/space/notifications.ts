/**
 * 「这个空间的盘上数据变了」—— 订阅点(批 B9-0)。
 *
 * ## 为什么需要它
 *
 * 用户 08-17 真机复现:在空间 2 的**设置窗**里给 DeepSeek 配了 key、登录了
 * Kimi Code,**主窗**的模型选择器里两个 provider 都不出现;切走再切回空间就好了。
 *
 * 根因是**跨窗口缓存过期**,不是权限也不是加密:设置窗与主窗是两个独立
 * BrowserWindow、两份 Pinia。写盘走 IPC 没问题,但写完之后只有**发起写的那个
 * 窗口**把新摘要收进了自己的 `spaceProviders` store;主窗那份早就
 * `loadedSpaceId === spaceId`,`ensureLoaded` 直接返回,于是它手里还是「这个
 * 空间一把钥匙都没有」——`isConfigured` 全 false,ModelSelector 第三道闸把
 * provider 藏了。切空间会触发 `watch(spaceId) → refresh`,所以「切走再切回就好」
 * 正是缓存过期的指纹。
 *
 * ## 为什么订阅点在产品层
 *
 * 产品层禁 electron 与 shared 的 IPC 契约(边界检查器强制),所以它只能提供一个
 * 「谁想知道就来订」的口子;**广播由 Electron 宿主接**(`spaces:changed` →
 * `broadcastToAllWindows`)。与 `ProjectsStore.subscribe` 同一手法。
 *
 * ## 触发点只有两个
 *
 * `writeSpaceCredentials`(凭证池的唯一落盘入口,OAuth 登录写 token 也经
 * `upsertSpaceProviderOAuthToken` 走到它)与 `writeSpaceOverlay`(overlay 的
 * 唯一落盘入口)。在**写盘之后**通知 —— 通知先于落盘发出去的那一刻,收到的人
 * 会读到旧文件。
 */

/**
 * overlay / credentials / providers 是三份文件、三条缓存,通知里分得清才不会
 * 互相牵动。`providers` 是 C2 加的那一格(`workspaces/<id>/providers.json`)。
 */
import { getLogger } from '../logging/index.js'

const log = getLogger('spaces')

export type SpaceDataKind = 'credentials' | 'overlay' | 'providers'

export interface SpaceDataChangedEvent {
  spaceId: string
  kind: SpaceDataKind
}

type SpaceDataChangedListener = (event: SpaceDataChangedEvent) => void

const listeners = new Set<SpaceDataChangedListener>()

/** 订阅空间数据变更。返回退订函数(与 `ProjectsStore.subscribe` 同形)。 */
export function subscribeSpaceDataChanged(listener: SpaceDataChangedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 落盘之后叫一次。**一个监听器抛错不能拖垮其他监听器**,更不能拖垮那次写入 ——
 * 写已经成功了,通知失败只是少刷一次界面。
 */
export function notifySpaceDataChanged(event: SpaceDataChangedEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (err) {
      log.warn('space-data-changed listener failed', undefined, err)
    }
  }
}

export function resetSpaceDataListenersForTests(): void {
  listeners.clear()
}
