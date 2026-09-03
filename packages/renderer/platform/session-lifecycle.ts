/**
 * 会话生命周期的全局订阅口 —— **折叠器已搬进 `@onething/client`**(C2,
 * `docs/design/client-sdk-2026-09.md` §5.2)。
 *
 * 剩下的只有 Vue 这一侧的**接线**:包里的 `onSessionLifecycle(hub, cb)` 吃一个
 * 事件枢纽,这里把渲染层自己那份客户端的枢纽喂进去,于是既有调用点的签名
 * (`onSessionLifecycle(cb)`)一个字没变。纯函数 `foldSessionLifecycleEvent`
 * 与三个类型原样再导出 —— 不留两份实现。
 *
 * 与从前那版逐字相同的一条纪律:**在调用时**才取当前宿主的枢纽,不提前快照
 * (宿主是运行时才定下来的,见 `platform/client.ts` 文件头)。
 */
import {
  foldSessionLifecycleEvent,
  onSessionLifecycle as onClientSessionLifecycle,
  type SessionLifecycleEvent,
} from '@onething/client'
import { currentClient } from './client'

export { foldSessionLifecycleEvent }
export type {
  SessionCreatedLifecycleEvent,
  SessionDeletedLifecycleEvent,
  SessionLifecycleEvent,
} from '@onething/client'

/** 订阅"会话被建 / 被删",跨全部会话。返回退订函数。 */
export function onSessionLifecycle(
  callback: (event: SessionLifecycleEvent) => void,
): () => void {
  return onClientSessionLifecycle(currentClient().events, callback)
}
