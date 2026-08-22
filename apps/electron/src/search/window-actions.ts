import { BrowserWindow, webContents, type WebContents } from 'electron'

export interface ElectronSearchActionWindow {
  isDestroyed(): boolean
  focus(): void
  getParentWindow(): ElectronSearchActionWindow | null
  webContents: {
    getURL(): string
    send(channel: string, payload: unknown): void
  }
}

export interface FindElectronMainSearchWindowOptions {
  isMainWindowUrl(url: string): boolean
  getFocusedWindow?: () => ElectronSearchActionWindow | null
  getAllWindows?: () => ElectronSearchActionWindow[]
}

export interface ToggleElectronSearchWindowFromOptions extends FindElectronMainSearchWindowOptions {
  sourceWindow?: ElectronSearchActionWindow | null
  openOptions?: unknown
  toggleSearchWindow(parentWindow: ElectronSearchActionWindow, openOptions?: unknown): void
}

export interface ExecuteElectronSearchActionFromOptions extends FindElectronMainSearchWindowOptions {
  sourceWindow?: ElectronSearchActionWindow | null
  actionId: string
  actionChannel: string
  closeSearchWindow(): void
  resolveActionId(actionId: string): Promise<string>
  logger?: Pick<Console, 'warn'>
}

export function getElectronSearchWindowFromWebContents(
  sender: WebContents,
): ElectronSearchActionWindow | null {
  return BrowserWindow.fromWebContents(sender)
}

/**
 * 「从哪扇窗按的」—— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 从前是从 IPC event 上取 `sender`;搬到宿主壳路由之后,身份是宿主在
 * `@main/ipc/shell-rpc.ts` 里盖的章(`ShellDispatchContext.callerId` =
 * `event.sender.id`),这里只负责把它翻回一扇窗。来源是同一个 webContents,
 * 渲染层从头到尾没有机会自称是别人。
 */
export function getElectronSearchWindowFromCallerId(
  callerId: number | undefined,
): ElectronSearchActionWindow | null {
  if (typeof callerId !== 'number') return null
  const sender = webContents.fromId(callerId)
  return sender ? getElectronSearchWindowFromWebContents(sender) : null
}

export function isElectronMainSearchWindow(
  window: ElectronSearchActionWindow | null | undefined,
  options: Pick<FindElectronMainSearchWindowOptions, 'isMainWindowUrl'>,
): window is ElectronSearchActionWindow {
  return Boolean(window && !window.isDestroyed() && options.isMainWindowUrl(window.webContents.getURL()))
}

export function findElectronMainSearchWindow(
  sourceWindow: ElectronSearchActionWindow | null | undefined,
  options: FindElectronMainSearchWindowOptions,
): ElectronSearchActionWindow | null {
  const source = sourceWindow && !sourceWindow.isDestroyed() ? sourceWindow : null
  if (source && options.isMainWindowUrl(source.webContents.getURL())) return source

  const parentWindow = source?.getParentWindow()
  if (isElectronMainSearchWindow(parentWindow, options)) return parentWindow

  const getFocusedWindow = options.getFocusedWindow ?? (() => BrowserWindow.getFocusedWindow())
  const focusedWindow = getFocusedWindow()
  if (isElectronMainSearchWindow(focusedWindow, options)) return focusedWindow

  const getAllWindows = options.getAllWindows ?? (() => BrowserWindow.getAllWindows())
  return getAllWindows().find(window => isElectronMainSearchWindow(window, options)) ?? null
}

export function toggleElectronSearchWindowFrom(options: ToggleElectronSearchWindowFromOptions): { success: boolean } {
  const parentWindow = findElectronMainSearchWindow(options.sourceWindow, options)
  if (!parentWindow) return { success: false }

  options.toggleSearchWindow(parentWindow, options.openOptions)
  return { success: true }
}

export async function executeElectronSearchActionFrom(
  options: ExecuteElectronSearchActionFromOptions,
): Promise<{ success: boolean }> {
  options.closeSearchWindow()
  const resolvedActionId = await options.resolveActionId(options.actionId)
  const mainWindow = findElectronMainSearchWindow(options.sourceWindow, options)

  if (!mainWindow) {
    const logger = options.logger ?? console
    logger.warn('[Search] No main app window found for action:', resolvedActionId)
    return { success: false }
  }

  mainWindow.webContents.send(options.actionChannel, resolvedActionId)
  mainWindow.focus()
  return { success: true }
}
