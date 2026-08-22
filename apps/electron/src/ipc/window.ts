import { BrowserWindow, webContents } from 'electron'
import { registerWindowShellDomain } from './shell/window.js'

/**
 * Lets a renderer close its own window. The main window uses this for Cmd+W on
 * the last remaining tab: the renderer owns the tab tree, so only it knows when
 * nothing is left to fall back to.
 *
 * 结构债 P4 终态批 A1-a(2026-08-23):从 `window:close` 那条手写通道改为**宿主壳
 * 路由**上的 `windowRouter.close`。要关哪扇窗仍然是宿主自己认的 —— 从前读
 * `event.sender`,现在读 `ShellDispatchContext.callerId`(同一个
 * `event.sender.id`,由 `@main/ipc/shell-rpc.ts` 铸)。渲染层从头到尾没有机会
 * 点名去关别人的窗。
 */
export function registerWindowHandlers(): void {
  registerWindowShellDomain({
    closeCallerWindow: (callerId) => {
      if (typeof callerId !== 'number') return false
      const sender = webContents.fromId(callerId)
      if (!sender) return false
      const window = BrowserWindow.fromWebContents(sender)
      if (!window || window.isDestroyed()) return false
      window.close()
      return true
    },
  })
}
