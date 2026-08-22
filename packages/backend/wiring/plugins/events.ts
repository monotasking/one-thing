/**
 * plugins 的**推送端口** —— 结构债 P4 终态批 C2。
 *
 * 十九条数据面已经迁到通用 RPC 通道,而 router 今天只有请求/响应面。
 * `PLUGINS_REQUEST_PROGRESS`(统一请求通道的中间态)因此留在原地,按
 * settings / practice / scratchpad / oauth 判例改成**注入端口**:谁在跑就由谁
 * 决定往哪儿发。
 *
 *  - 桌面(`apps/electron/src/main/ipc/plugins.ts`)注入按 `callerId` 定向回送;
 *  - server 不注入 —— 旧 server 本来就没有这条推送
 *    (`platform/web.ts` 的 `onPluginRequestProgress` 是个 noop 退订),
 *    所以没人注入时它就是安静的 no-op。
 *
 * **定向回送这件事一字未丢**。迁移前进度直接发给 `event.sender`;发射点搬到域
 * 处理者之后,「谁在问」这一格由宿主铸进 dispatch context
 * (`RpcDispatchContext.callerId`,`@main/ipc/rpc.ts` 从 `event.sender.id` 取),
 * 域再原样递到这里。**不能退化成全窗广播**:设置窗是独立 BrowserWindow,而它
 * 恰好是 R3 插件设置 UI 的宿主 —— 广播出去等于让每扇窗都收一份别人的进度。
 *
 * 另一条推送 `PLUGINS_NOTIFICATION` **不在这里**:它是总线上的一条全局事件
 * (`plugin:notification`),由 IPCBridge 扇给所有窗,从头到尾不经过请求面。
 */
import type { PluginRequestProgressPayload } from '@shared/ipc/plugins.js'

export type PluginRequestProgressBroadcaster = (
  progress: PluginRequestProgressPayload,
  callerId: string | number | undefined,
) => void

let broadcaster: PluginRequestProgressBroadcaster | null = null

export function configurePluginRequestProgressBroadcaster(
  next: PluginRequestProgressBroadcaster | null,
): void {
  broadcaster = next
}

/** 当前注入的广播器 —— 单槽端口串联用,理由同 `getSettingsEventBroadcaster`。 */
export function getPluginRequestProgressBroadcaster(): PluginRequestProgressBroadcaster | null {
  return broadcaster
}

export function broadcastPluginRequestProgress(
  progress: PluginRequestProgressPayload,
  callerId: string | number | undefined,
): void {
  broadcaster?.(progress, callerId)
}
