/**
 * Search Everywhere - Electron IPC host facade.
 *
 * 结构债 P4 终态批 A1-a(2026-08-23):四条**动窗口**的(toggle / close /
 * set-anchor / execute-action)从手写通道改为**宿主壳路由**上的一份处理者表
 * (`searchWindowRouter` → `@onething/electron-host/ipc/shell/search-window`)。
 * 「从哪扇窗按的」不再读 `event.sender`,而读宿主盖的 `ShellDispatchContext.callerId`
 * —— 同一个 webContents id,只是不再穿过四条专用通道。
 *
 * A1-b 兑现了 A1-a 留下的那条判定:`search:query` 一行 electron 都不碰,按
 * 「处理者 import 了 electron/窗口 = 壳,否则 = 数据面」的判据它是**数据面**,
 * 已整只迁进 `rpc:invoke` 的 backend `search` 域(`backend/rpc/domains/search.ts`,
 * 按 `context.transport` 分叉:ipc 走这台机器的 `executeSearch`,http 走
 * per-owner 沙箱里的同一件事)。所以这只文件从此**只剩窗口活** ——
 * `IPC_CHANNELS.SEARCH_QUERY` 那条常量与它的手写 handler 一起没了。
 */

import type {
  SearchWindowOpenOptions,
  SearchWindowSetAnchorRequest,
} from '@shared/ipc/search.js'
import { closeOnethingSearchWindowForIpc } from '@onething/runtime/search'
import { closeSearchWindow, setSearchWindowAnchor } from './window.js'
import {
  getElectronSearchWindowFromCallerId,
  type ElectronSearchActionWindow,
} from './window-actions.js'
import { registerSearchWindowShellDomain } from '@onething/electron-host/ipc/shell/search-window'
import { executeSearchActionFrom, toggleSearchWindowFrom } from './window-controller.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('search')

export function registerSearchHandlers(): void {
  registerSearchWindowShellDomain<ElectronSearchActionWindow>({
    resolveWindow: context => getElectronSearchWindowFromCallerId(context.callerId),
    toggle: (sourceWindow, openOptions?: SearchWindowOpenOptions) =>
      toggleSearchWindowFrom(sourceWindow, openOptions),
    close: () => closeOnethingSearchWindowForIpc({ closeSearchWindow }),
    setAnchor: (request: SearchWindowSetAnchorRequest) => {
      setSearchWindowAnchor(request?.anchor ?? null)
      return { success: true }
    },
    executeAction: (sourceWindow, actionId) => executeSearchActionFrom(sourceWindow, actionId),
  })

  log.info('handlers registered')
}
