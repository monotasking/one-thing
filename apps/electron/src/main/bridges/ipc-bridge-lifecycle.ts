import { BrowserWindow } from 'electron'
import { IPCBridge, type IPCBridgeSender } from './ipc-bridge.js'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('ipc.bridge')

let ipcBridge: IPCBridge | null = null

interface BroadcastWindowLike {
  isDestroyed?(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

/**
 * 通知类事件的真广播面。
 *
 * 设置窗、搜索窗、todo 窗都是独立 BrowserWindow;插件通知(启停、熔断、面板刷新)
 * 对它们同样有效。`getAllWindows` 可注入是为了能在没有 Electron 的测试里验行为。
 */
export function broadcastToAllWindows(
  channel: string,
  payload: unknown,
  getAllWindows: () => BroadcastWindowLike[] = () => BrowserWindow.getAllWindows() as unknown as BroadcastWindowLike[],
): void {
  for (const window of getAllWindows()) {
    if (window.isDestroyed?.()) continue
    try {
      window.webContents.send(channel, payload)
    } catch {
      // 窗口正在关闭 —— 少一个收件人不是错误。
    }
  }
}

/**
 * Initialize the IPCBridge for a BrowserWindow.
 * Called after createWindow() in app.on('ready') and app.on('activate').
 */
export function initializeIPCBridge(sender: IPCBridgeSender): void {
  if (!ipcBridge) {
    ipcBridge = new IPCBridge({
      broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
    })
  }
  ipcBridge.bind(sender)
  log.info('IPC bridge initialized')
}

/**
 * Get the singleton IPCBridge instance.
 */
export function getIPCBridge(): IPCBridge | null {
  return ipcBridge
}

/**
 * Shut down the IPCBridge. Called when the BrowserWindow closes.
 */
export function shutdownIPCBridge(): void {
  if (ipcBridge) {
    ipcBridge.unbind()
    ipcBridge = null
  }
  log.info('IPC bridge shut down')
}
