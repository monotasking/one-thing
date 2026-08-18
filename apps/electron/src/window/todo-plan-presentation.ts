import { BrowserWindow } from 'electron'
import type { ElectronMainWindowVisibilitySnapshot } from './window-visibility.js'

export type ElectronTodoPlanActivationMode = 'preserve-current-app' | 'focus-if-app-active'

export interface ElectronTodoPlanWindowActionOptions {
  activation?: ElectronTodoPlanActivationMode
  preserveMainWindowVisibility?: boolean
  mainWindowVisibilitySnapshot?: ElectronMainWindowVisibilitySnapshot[]
}

export interface NormalizedElectronTodoPlanWindowActionOptions {
  activation: ElectronTodoPlanActivationMode
  preserveMainWindowVisibility: boolean
  mainWindowVisibilitySnapshot?: ElectronMainWindowVisibilitySnapshot[]
}

export interface PreparedElectronTodoPlanWindowAction {
  options: NormalizedElectronTodoPlanWindowActionOptions
  mainWindowVisibilitySnapshot: ElectronMainWindowVisibilitySnapshot[]
}

export interface ElectronTodoPlanPresentationEnvironment {
  platform?: () => NodeJS.Platform
  getFocusedWindow?: () => BrowserWindow | null
}

export interface PrepareElectronTodoPlanWindowActionOptions extends ElectronTodoPlanPresentationEnvironment {
  suppressMainWindowActivation(): void
  captureMainWindowVisibility(): ElectronMainWindowVisibilitySnapshot[]
}

export interface PresentElectronTodoPlanWindowOptions extends ElectronTodoPlanPresentationEnvironment {
  showNonActivatingPanel(window: BrowserWindow): boolean
}

export interface ElectronTodoPlanFrontmostOptions {
  platform?: () => NodeJS.Platform
  isNonActivatingPanelFrontmost(window: BrowserWindow): boolean
}

function currentPlatform(options: Pick<ElectronTodoPlanPresentationEnvironment, 'platform'>): NodeJS.Platform {
  return options.platform?.() ?? process.platform
}

function focusedWindow(options: Pick<ElectronTodoPlanPresentationEnvironment, 'getFocusedWindow'>): BrowserWindow | null {
  return options.getFocusedWindow?.() ?? BrowserWindow.getFocusedWindow()
}

export function normalizeElectronTodoPlanWindowActionOptions(
  options: ElectronTodoPlanWindowActionOptions = {},
): NormalizedElectronTodoPlanWindowActionOptions {
  return {
    activation: options.activation || 'preserve-current-app',
    preserveMainWindowVisibility: options.preserveMainWindowVisibility !== false,
    mainWindowVisibilitySnapshot: options.mainWindowVisibilitySnapshot,
  }
}

export function shouldPreserveElectronCurrentMacApp(
  options: NormalizedElectronTodoPlanWindowActionOptions,
  environment: ElectronTodoPlanPresentationEnvironment = {},
): boolean {
  if (currentPlatform(environment) !== 'darwin') return false
  if (options.activation === 'preserve-current-app') return true
  return !focusedWindow(environment)
}

export function prepareElectronTodoPlanWindowAction(
  options: ElectronTodoPlanWindowActionOptions = {},
  environment: PrepareElectronTodoPlanWindowActionOptions,
): PreparedElectronTodoPlanWindowAction {
  const normalized = normalizeElectronTodoPlanWindowActionOptions(options)
  if (shouldPreserveElectronCurrentMacApp(normalized, environment)) {
    environment.suppressMainWindowActivation()
  }

  return {
    options: normalized,
    mainWindowVisibilitySnapshot: normalized.preserveMainWindowVisibility
      ? normalized.mainWindowVisibilitySnapshot || environment.captureMainWindowVisibility()
      : [],
  }
}

export function presentElectronTodoPlanWindow(
  window: BrowserWindow,
  options: NormalizedElectronTodoPlanWindowActionOptions,
  environment: PresentElectronTodoPlanWindowOptions,
): void {
  if (shouldPreserveElectronCurrentMacApp(options, environment)) {
    const shownNatively = environment.showNonActivatingPanel(window)
    if (!shownNatively) {
      window.showInactive()
      window.moveTop()
    }
    return
  }

  window.show()
  window.focus()
}

/** 手动拖窗:拖起那一刻的窗位。`null` = 现在没有在拖。 */
export interface ElectronTodoPlanDragOrigin {
  x: number
  y: number
}

export interface ElectronTodoPlanDragRequest {
  phase: 'start' | 'move' | 'end'
  dx?: number
  dy?: number
}

/**
 * 由「拖起点窗位 + 累计位移」算出这一帧应该把窗挪到哪儿。**纯函数**,窗口对象一律
 * 不进来 —— 这一段是拖拽里唯一会算错的地方(漂移都出在这儿),值得单独测。
 *
 * 返回 `null` 表示这一帧不该动窗:没记过拖起点(start 丢了),或位移不是有限数
 * (渲染层给了 NaN)。多显示器下屏幕坐标可能是负的,这里只做加法,不夹取 —— 夹取
 * 是 `clampElectronWindowStateToDisplays` 在落盘时的事。
 */
export function resolveElectronTodoPlanDragPosition(
  origin: ElectronTodoPlanDragOrigin | null,
  request: ElectronTodoPlanDragRequest,
): ElectronTodoPlanDragOrigin | null {
  if (request.phase !== 'move') return null
  if (!origin) return null
  const dx = request.dx
  const dy = request.dy
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
  return {
    x: Math.round(origin.x + (dx as number)),
    y: Math.round(origin.y + (dy as number)),
  }
}

export function isElectronTodoPlanWindowFrontmost(
  window: BrowserWindow,
  options: ElectronTodoPlanFrontmostOptions,
): boolean {
  if (currentPlatform(options) === 'darwin') {
    return options.isNonActivatingPanelFrontmost(window) || window.isFocused()
  }
  return window.isFocused()
}
