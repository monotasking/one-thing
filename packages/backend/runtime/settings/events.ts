/**
 * 设置面的**推送端口** —— 结构债 P4c 第十一批。
 *
 * settings 的四条数据面已经迁到通用 RPC 通道,而 router 今天只有请求/响应面。
 * `SETTINGS_CHANGED`(保存成功后广播归一化后的设置)因此留在原地,按
 * practice / scratchpad / oauth / evals 判例改成**注入端口**:谁在跑就由谁
 * 决定往哪儿广播。
 *
 *  - 桌面(`apps/electron/src/main/ipc/settings.ts`)注入按 webContents 扇出的广播;
 *  - server 不注入 —— 旧 server 本来就没有这条推送
 *    (`platform/web.ts` 的 `onSettingsChanged` 是个 noop 退订),
 *    所以没人注入时它就是安静的 no-op。
 *
 * **排除发起窗这件事一字未丢**。迁移前广播带 `exceptWebContentsId =
 * event.sender?.id`;发射点搬到域处理者之后,「谁在问」这一格由**宿主铸进
 * dispatch context**(`RpcDispatchContext.callerId`,`@main/ipc/rpc.ts` 从
 * `event.sender.id` 取),域再原样递到这里。**不能退化成全窗广播**:回灌整份
 * settings 会把那扇窗正在编辑的草稿冲掉 —— 这不是「幂等」兜得住的事。
 * 未注入 / 无 callerId(http、进程内调用)时就是全窗,与它们本来没有窗可排除一致。
 *
 * `SYSTEM_THEME_CHANGED` **不在这里**:它的事件源是 `nativeTheme.on('updated')`,
 * 从头到尾只住在宿主里(`registerElectronSystemThemeChangedBroadcast`),
 * 装配层从来不是它的发射点。
 */
import type { AppSettings } from '@shared/ipc/settings.js'

export interface SettingsEvent {
  type: 'settings:changed'
  settings: AppSettings
  /**
   * 不要发给这个调用者(桌面上 = 它的 `webContents.id`)。缺席 = 全窗。
   * 值的来源是 `RpcDispatchContext.callerId` —— 宿主铸的,不从信封里读。
   */
  excludeCallerId?: string | number
}

export type SettingsEventBroadcaster = (event: SettingsEvent) => void

let broadcaster: SettingsEventBroadcaster | null = null

export function configureSettingsEventBroadcaster(
  next: SettingsEventBroadcaster | null,
): void {
  broadcaster = next
}

/** 当前注入的广播器 —— 单槽端口串联用,理由同 `getOAuthEventBroadcaster`。 */
export function getSettingsEventBroadcaster(): SettingsEventBroadcaster | null {
  return broadcaster
}

export function broadcastSettingsChanged(
  settings: AppSettings,
  options: { excludeCallerId?: string | number } = {},
): void {
  broadcaster?.({
    type: 'settings:changed',
    settings,
    excludeCallerId: options.excludeCallerId,
  })
}
