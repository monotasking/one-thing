import { registerSpacesHandlers as registerHostSpacesHandlers } from '@onething/electron-host/ipc/spaces'
import { subscribeSpaceDataChanged } from '@onething/runtime/spaces/notifications'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { broadcastToAllWindows } from '../bridges/ipc-bridge-lifecycle.js'

/** 退订句柄:`initializeIPC()` 在测试里可能被叫多次,重复订阅会让广播翻倍。 */
let unsubscribeSpaceData: (() => void) | null = null

/**
 * 空间数据变更 → 所有窗口(批 B9-0)。
 *
 * 病根见 `spaces/notifications.ts` 的头注:设置窗与主窗是两个独立 BrowserWindow、
 * 两份 Pinia,在设置窗里配好的 key 主窗那份缓存永远不知道。
 *
 * **不排除发送者**:重复刷一次是无害的(store 那边只是再拉一次同样的摘要),而
 * 「谁发起的写」在 OAuth 登录这类由主进程自己触发的路径上根本没有 sender ——
 * 排除它反而要在两种来源之间分岔。settings 那条广播排除发送者是因为它回灌的是
 * 整份 settings(会打断正在编辑的草稿),这里回灌的只是一句「去重拉」。
 */
function registerSpacesChangedBroadcast(): void {
  unsubscribeSpaceData?.()
  unsubscribeSpaceData = subscribeSpaceDataChanged(event => {
    broadcastToAllWindows(IPC_CHANNELS.SPACES_CHANGED, event)
  })
}

export function registerSpacesHandlers(): void {
  registerHostSpacesHandlers()
  registerSpacesChangedBroadcast()
}
