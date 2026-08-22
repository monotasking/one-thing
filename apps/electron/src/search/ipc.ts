/**
 * Search Everywhere - Electron IPC host facade.
 *
 * 结构债 P4 终态批 A1-a(2026-08-23):四条**动窗口**的(toggle / close /
 * set-anchor / execute-action)从手写通道改为**宿主壳路由**上的一份处理者表
 * (`searchWindowRouter` → `@onething/electron-host/ipc/shell/search-window`)。
 * 「从哪扇窗按的」不再读 `event.sender`,而读宿主盖的 `ShellDispatchContext.callerId`
 * —— 同一个 webContents id,只是不再穿过四条专用通道。
 *
 * `search:query` **没有跟着走**,是刻意的:它一行 electron 都不碰(桌面是
 * `wiring/search/providers` 的 `executeSearch`),按「处理者 import 了 electron/窗口
 * = 壳,否则 = 数据面」的判据它是**数据面**,该去的是 `rpc:invoke` 的 backend 域;
 * 而 server 那侧是 per-owner 沙箱内的同一件事,要按 `context.transport` 分叉 ——
 * 那是 files / tools 那种域的做法,单独一批。所以这条通道与它的手写 handler 原样留着。
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type {
  SearchRequest,
  SearchResponse,
  SearchWindowOpenOptions,
  SearchWindowSetAnchorRequest,
} from '@shared/ipc/search.js'
import {
  closeOnethingSearchWindowForIpc,
  executeOnethingSearchForIpc,
} from '@onething/runtime/search'
import { executeSearch } from '@onething/backend/wiring/search/providers.js'
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

  // 数据面的最后一条:只查不动窗,所以它还没有跟着搬(见文件头的判定)。
  ipcMain.handle(IPC_CHANNELS.SEARCH_QUERY, (_event, request: unknown): Promise<SearchResponse> =>
    executeOnethingSearchForIpc({
      request: request as SearchRequest,
      executeSearch,
    }),
  )

  log.info('handlers registered')
}
