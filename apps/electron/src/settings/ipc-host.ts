import { BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronSettingsMessageWebContents {
  id?: number
  send(channel: string, payload: unknown): void
}

export interface ElectronSettingsMessageWindow {
  isDestroyed?(): boolean
  webContents: ElectronSettingsMessageWebContents
}

/**
 * P4c 第十一批:发射点从这只文件的 IPC handler 搬到了装配层的域处理者,但
 * `exceptWebContentsId` **一字未丢** —— 发起保存的那扇窗仍然不收自己的回声
 * (回灌整份 settings 会冲掉它正在编辑的草稿)。「谁在问」现在由
 * `@main/ipc/rpc.ts` 从 `event.sender.id` 铸进 `RpcDispatchContext.callerId`,
 * 经域处理者原样递回这里。
 */
export interface BroadcastElectronSettingsChangedOptions {
  channel: string
  settings: unknown
  exceptWebContentsId?: number
  getAllWindows?: () => ElectronSettingsMessageWindow[]
}

export interface RegisterElectronSystemThemeBroadcastOptions {
  channel: string
  getAllWindows?: () => ElectronSettingsMessageWindow[]
  getShouldUseDarkColors?: () => boolean
  onUpdated?: (handler: () => void) => void
}

export interface ShowElectronOpenDialogOptions {
  getFocusedWindow?: () => BrowserWindow | null
  showOpenDialog?: typeof dialog.showOpenDialog
}

/**
 * P4c 第十一批:四条数据面(`settings:get` / `settings:save` /
 * `settings:get-system-theme` / `network:test-proxy`)已迁到通用 RPC 通道
 * (`settingsRouter`)。这只工厂只剩**两件要 Electron 本体的事**:开设置窗与
 * 原生文件对话框。
 */
export interface ElectronSettingsIpcChannels {
  openWindow: string
  showOpenDialog: string
}

export interface RegisterElectronSettingsIpcHandlersOptions {
  channels: ElectronSettingsIpcChannels
  openSettingsWindow(request?: unknown): unknown
  showOpenDialog(options: OpenDialogOptions): unknown
  ipcMain?: ElectronIpcMainLike
}

function getLiveWindows(getAllWindows?: () => ElectronSettingsMessageWindow[]): ElectronSettingsMessageWindow[] {
  const windows = getAllWindows?.() ?? BrowserWindow.getAllWindows()
  return windows.filter(window => !window.isDestroyed?.())
}

export function getElectronShouldUseDarkColors(): boolean {
  return nativeTheme.shouldUseDarkColors
}

export function broadcastElectronSystemThemeChanged(
  options: Omit<RegisterElectronSystemThemeBroadcastOptions, 'onUpdated'>,
): void {
  const shouldUseDarkColors = options.getShouldUseDarkColors?.() ?? nativeTheme.shouldUseDarkColors
  const theme = shouldUseDarkColors ? 'dark' : 'light'
  for (const window of getLiveWindows(options.getAllWindows)) {
    window.webContents.send(options.channel, theme)
  }
}

export function registerElectronSystemThemeChangedBroadcast(
  options: RegisterElectronSystemThemeBroadcastOptions,
): void {
  const onUpdated = options.onUpdated ?? (handler => nativeTheme.on('updated', handler))
  onUpdated(() => broadcastElectronSystemThemeChanged(options))
}

export function broadcastElectronSettingsChanged(
  options: BroadcastElectronSettingsChangedOptions,
): void {
  for (const window of getLiveWindows(options.getAllWindows)) {
    if (window.webContents.id === options.exceptWebContentsId) continue
    window.webContents.send(options.channel, options.settings)
  }
}

export async function showElectronOpenDialog(
  options: OpenDialogOptions,
  host: ShowElectronOpenDialogOptions = {},
): Promise<OpenDialogReturnValue> {
  const showOpenDialog = host.showOpenDialog ?? dialog.showOpenDialog
  const focusedWindow = host.getFocusedWindow?.() ?? BrowserWindow.getFocusedWindow()
  if (focusedWindow) {
    return showOpenDialog(focusedWindow, options)
  }
  return showOpenDialog(options)
}

export function registerElectronSettingsIpcHandlers(
  options: RegisterElectronSettingsIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.openWindow, (_event, request: unknown) => {
    return options.openSettingsWindow(request)
  })

  host.handle(options.channels.showOpenDialog, (_event, dialogOptions: OpenDialogOptions) => {
    return options.showOpenDialog(dialogOptions)
  })
}
