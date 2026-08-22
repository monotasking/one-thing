/**
 * 本文件只剩**两件要 Electron 本体的事**加**一条推送的注入**:
 *
 *  - 开设置窗(`BrowserWindow`)—— 结构债 P4 终态批 A1-a(2026-08-23)起走**宿主
 *    壳路由** `settingsWindowRouter.open`,不再是 `settings:open-window` 那条手写通道;
 *  - 原生文件对话框 —— 同批起走 `dialogRouter.showOpen`(渲染侧调用点全仓最多的一条,
 *    形状一个字没动)。
 *
 * 四条数据面(`settings:get` / `settings:save` / `settings:get-system-theme` /
 * `network:test-proxy`)已整只迁到通用 RPC 通道(`@shared/ipc/settings.ts` 的
 * `settingsRouter` + `packages/backend/rpc/domains/settings.ts`),桌面和 web 走同一条
 * dispatch、同一本 `<store>/settings.json`。
 *
 * 两条推送留在这里(router 没有推送面):
 *  - `SETTINGS_CHANGED` 现在是**注入端口**(`configureSettingsEventBroadcaster`,
 *    同 practice / scratchpad / oauth / evals 判例)。**排除发起窗一字未丢**:
 *    「谁在问」由 `@main/ipc/rpc.ts` 从 `event.sender.id` 铸进
 *    `RpcDispatchContext.callerId`,域处理者原样递回来,这里按 webContents id 排除
 *    —— 回灌整份 settings 会冲掉那扇窗正在编辑的草稿,靠「幂等」兜不住。
 *  - `SYSTEM_THEME_CHANGED` 连端口都不用:它的事件源是系统主题的 updated 事件,
 *    从头到尾只住在宿主里。
 *
 * 三件宿主能力(套代理 / 重注册全局快捷键 / 系统深浅色)的注入不在这里,而在
 * `app/main-process.ts` 的 `configureSettingsHost` —— 与其余 configure*Host 同处。
 */
import {
  broadcastElectronSettingsChanged,
  registerElectronSystemThemeChangedBroadcast,
  showElectronOpenDialog,
} from '@onething/electron-host/settings/ipc-host'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { OpenSettingsWindowRequest, ShowOpenDialogRequest } from '@shared/ipc.js'
import { registerSettingsWindowShellDomain } from '@onething/electron-host/ipc/shell/settings-window'
import { registerDialogShellDomain } from '@onething/electron-host/ipc/shell/dialog'
import { openSettingsWindow } from '@onething/electron-host/window'
import { configureSettingsEventBroadcaster } from '@onething/backend/wiring/settings/events.js'

export function registerSettingsHandlers() {
  registerElectronSystemThemeChangedBroadcast({
    channel: IPC_CHANNELS.SYSTEM_THEME_CHANGED,
  })

  configureSettingsEventBroadcaster(event => {
    broadcastElectronSettingsChanged({
      channel: IPC_CHANNELS.SETTINGS_CHANGED,
      settings: event.settings,
      exceptWebContentsId:
        typeof event.excludeCallerId === 'number' ? event.excludeCallerId : undefined,
    })
  })

  registerSettingsWindowShellDomain({
    open: (request: OpenSettingsWindowRequest) => {
      openSettingsWindow(undefined, typeof request?.tab === 'string' ? request.tab : undefined)
      return { success: true }
    },
  })

  registerDialogShellDomain({
    showOpen: (request: ShowOpenDialogRequest) => showElectronOpenDialog(request),
  })
}
