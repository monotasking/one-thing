import path from 'path'
import { fileURLToPath } from 'url'
import {
  getOnethingWindowStatePath,
  readJsonFile,
  writeJsonFile,
} from '@onething/runtime/storage'
import { getSettings } from '@onething/app/stores/settings.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { TodoPlanWindowActionRequest } from '@shared/ipc.js'
import { DEFAULT_GENERAL_SETTINGS } from '@shared/defaults/settings.js'
import {
  getThemeBackgroundColor,
  initializeThemes,
  resolveOnethingWindowThemeSelection,
  type OnethingWindowThemeSelection,
} from '@onething/runtime/themes'
import { shouldHideMainWindowForVoice } from '@onething/electron-host/voice/tray'
import { createElectronMainWindowActivationController } from '@onething/electron-host/window/activation'
import {
  configureNonActivatingPanel,
  hideNonActivatingPanel,
  isNonActivatingPanelFrontmost,
  setNonActivatingPanelPinned,
  showNonActivatingPanel,
} from '@onething/electron-host/window/macos-panel'
import { setupElectronApplicationMenu } from '@onething/electron-host/menu/application-menu'
import { peekBrowserViewService } from '@onething/electron-host/browser/service'
import {
  WEB_PREVIEW_URL,
  isWebPreviewAvailable,
  isWebPreviewRunning,
  openWebPreview,
  toggleWebPreview,
} from '@onething/electron-host/web-preview/web-preview'
import {
  registerElectronContentSecurityPolicy,
  registerElectronMediaPermissions,
} from '@onething/electron-host/window/session-security'
import { setupElectronExternalLinkHandling } from '@onething/electron-host/window/external-links'
import {
  attachElectronMainWindowRecovery,
  recoverElectronMainWindowAfterSystemResume,
} from '@onething/electron-host/window/main-window-recovery'
import {
  getElectronRendererDevUrl,
  isElectronAppWebContents,
  isElectronMainAppWindowUrl as isMainAppWindowUrl,
  isElectronRendererIndexFileUrl,
  isElectronRendererWindowUrl,
  loadElectronMainWindowContent,
} from '@onething/electron-host/window/renderer-targets'
import {
  createElectronMainWindow,
} from '@onething/electron-host/window/main-window'
import type { ElectronBrowserWindow } from '@onething/electron-host/window/types'
import { openElectronSettingsWindow } from '@onething/electron-host/window/settings-window'
import { openElectronImagePreviewWindow } from '@onething/electron-host/window/image-preview-window'
import { createElectronTodoPlanWindow } from '@onething/electron-host/window/todo-plan-window'
import { getElectronShouldUseDarkColors } from '@onething/electron-host/settings/ipc-host'
import {
  readElectronTodoPlanWindowState,
  readElectronWindowState,
  saveElectronMainWindowState,
  saveElectronTodoPlanWindowState,
  type ElectronWindowState,
  type ElectronWindowStateOptions,
} from '@onething/electron-host/window/window-state'
import {
  captureElectronMainWindowVisibility,
  restoreElectronHiddenMainWindows,
  type ElectronMainWindowVisibilitySnapshot,
} from '@onething/electron-host/window/window-visibility'
import {
  isElectronTodoPlanWindowFrontmost,
  normalizeElectronTodoPlanWindowActionOptions,
  prepareElectronTodoPlanWindowAction,
  presentElectronTodoPlanWindow,
  resolveElectronTodoPlanDragPosition,
  type ElectronTodoPlanDragOrigin,
  type ElectronTodoPlanDragRequest,
  type NormalizedElectronTodoPlanWindowActionOptions,
} from '@onething/electron-host/window/todo-plan-presentation'
import { getLogger } from '@onething/app/logging/index.js'

const log = getLogger('window')
export { MAIN_WINDOW_RESUME_HEALTH_CHECK_DELAY_MS } from '@onething/electron-host/window/main-window-recovery'

function getWindowThemeSelection(): OnethingWindowThemeSelection {
  const settings = getSettings()
  const systemShouldUseDarkColors = getElectronShouldUseDarkColors()
  const selection = resolveOnethingWindowThemeSelection({
    theme: settings.theme,
    general: settings.general,
    defaults: DEFAULT_GENERAL_SETTINGS,
    systemShouldUseDarkColors,
  })

  log.debug('window theme resolved', {
    settingsTheme: settings.theme,
    nativeIsDark: systemShouldUseDarkColors,
    effectiveTheme: selection.mode,
    themeId: selection.themeId,
    colorTheme: selection.colorTheme,
  })

  return selection
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function getRendererIndexPath(): string {
  return path.join(__dirname, '../renderer/index.html')
}

function loadMainWindowContent(mainWindow: ElectronBrowserWindow, reason = 'initial'): void {
  const { mode } = getWindowThemeSelection()
  loadElectronMainWindowContent({
    mainWindow,
    reason,
    isDevelopment: process.env.NODE_ENV === 'development',
    rendererDevUrl: getElectronRendererDevUrl(),
    rendererIndexPath: getRendererIndexPath(),
    themeMode: mode,
  })
}

export async function recoverMainWindowAfterSystemResume(
  mainWindow: ElectronBrowserWindow,
  source: 'resume' | 'unlock-screen' = 'resume'
): Promise<void> {
  await recoverElectronMainWindowAfterSystemResume({
    mainWindow,
    source,
    loadMainWindowContent,
  })
}

interface TodoPlanWindowActionOptions extends TodoPlanWindowActionRequest {
  mainWindowVisibilitySnapshot?: ElectronMainWindowVisibilitySnapshot[]
}

function getWindowStateOptions(): ElectronWindowStateOptions {
  return {
    path: getOnethingWindowStatePath(),
    readJsonFile,
    writeJsonFile,
  }
}

function getWindowState() {
  return readElectronWindowState(getWindowStateOptions())
}

function getTodoPlanWindowState() {
  return readElectronTodoPlanWindowState(getWindowStateOptions())
}

function saveWindowState(window: ElectronBrowserWindow): void {
  saveElectronMainWindowState(window, getWindowStateOptions())
}

function saveTodoPlanWindowState(window: ElectronBrowserWindow | null, stableBounds?: ElectronWindowState): void {
  cancelScheduledTodoPlanWindowStateSave()
  saveElectronTodoPlanWindowState(window, getWindowStateOptions(), stableBounds)
}

// Persisting on every resize/move tick reads+writes the state JSON per event
// and makes dragging stutter; batch to one write after the gesture settles.
let todoPlanStateSaveTimer: ReturnType<typeof setTimeout> | null = null

function cancelScheduledTodoPlanWindowStateSave(): void {
  if (!todoPlanStateSaveTimer) return
  clearTimeout(todoPlanStateSaveTimer)
  todoPlanStateSaveTimer = null
}

function scheduleTodoPlanWindowStateSave(window: ElectronBrowserWindow): void {
  if (todoPlanStateSaveTimer) clearTimeout(todoPlanStateSaveTimer)
  todoPlanStateSaveTimer = setTimeout(() => {
    todoPlanStateSaveTimer = null
    if (window.isDestroyed() || isHidingTodoPlanWindow || isSyncingTodoPlanNativeFrame) return
    saveTodoPlanWindowState(window)
  }, 250)
}

// Keep track of the settings window
let settingsWindow: ElectronBrowserWindow | null = null
let todoPlanWindow: ElectronBrowserWindow | null = null
let todoPlanPinned = true
let isHidingTodoPlanWindow = false
let isSyncingTodoPlanNativeFrame = false
let todoPlanNativeFrameGuardToken = 0
/** 手动拖窗时,拖起那一刻的窗位。`null` = 现在没有在拖。 */
let todoPlanDragOrigin: ElectronTodoPlanDragOrigin | null = null
const mainWindowActivation = createElectronMainWindowActivationController({
  platform: () => process.platform,
})

function captureMainWindowVisibility(): ElectronMainWindowVisibilitySnapshot[] {
  return captureElectronMainWindowVisibility({
    isMainWindowUrl: isMainAppWindowUrl,
  })
}

function restoreHiddenMainWindows(snapshot: ElectronMainWindowVisibilitySnapshot[]): void {
  restoreElectronHiddenMainWindows(snapshot)
}

function normalizeTodoPlanWindowActionOptions(
  options: TodoPlanWindowActionOptions = {},
): NormalizedElectronTodoPlanWindowActionOptions {
  return normalizeElectronTodoPlanWindowActionOptions(options)
}

function prepareTodoPlanWindowAction(options: TodoPlanWindowActionOptions = {}): {
  options: NormalizedElectronTodoPlanWindowActionOptions
  mainWindowVisibilitySnapshot: ElectronMainWindowVisibilitySnapshot[]
} {
  return prepareElectronTodoPlanWindowAction(options, {
    platform: () => process.platform,
    suppressMainWindowActivation: suppressMainWindowActivationFromTodoPanel,
    captureMainWindowVisibility,
  })
}

function suppressMainWindowActivationFromTodoPanel(): void {
  mainWindowActivation.suppressFromAuxiliaryWindow()
}

function runWithTodoPlanNativeFrameGuard<T>(action: () => T): T {
  const token = ++todoPlanNativeFrameGuardToken
  isSyncingTodoPlanNativeFrame = true
  try {
    return action()
  } finally {
    setTimeout(() => {
      if (token === todoPlanNativeFrameGuardToken) {
        isSyncingTodoPlanNativeFrame = false
      }
    }, 80)
  }
}

function configureTodoPlanNativePanel(window: ElectronBrowserWindow): boolean {
  if (process.platform !== 'darwin') return false
  return runWithTodoPlanNativeFrameGuard(() => configureNonActivatingPanel(window))
}

function presentTodoPlanWindow(
  window: ElectronBrowserWindow,
  options: NormalizedElectronTodoPlanWindowActionOptions,
): void {
  presentElectronTodoPlanWindow(window, options, {
    platform: () => process.platform,
    showNonActivatingPanel: targetWindow => runWithTodoPlanNativeFrameGuard(() => showNonActivatingPanel(targetWindow)),
  })
}

function isTodoPlanWindowFrontmost(window: ElectronBrowserWindow): boolean {
  return isElectronTodoPlanWindowFrontmost(window, {
    platform: () => process.platform,
    isNonActivatingPanelFrontmost,
  })
}

export function shouldSuppressMainWindowActivation(): boolean {
  return mainWindowActivation.shouldSuppressActivation()
}

export function isTodoPlanBrowserWindow(window: ElectronBrowserWindow | null | undefined): boolean {
  return Boolean(window && !window.isDestroyed() && window === todoPlanWindow)
}

export function activateMainWindow(mainWindow: ElectronBrowserWindow | null | undefined): boolean {
  return mainWindowActivation.activateMainWindow(mainWindow)
}

function hideTodoPlanWindowPreservingBounds(): boolean {
  if (!todoPlanWindow || todoPlanWindow.isDestroyed() || !todoPlanWindow.isVisible()) {
    return false
  }

  const stableBounds = todoPlanWindow.getBounds()
  isHidingTodoPlanWindow = true
  try {
    saveTodoPlanWindowState(todoPlanWindow, stableBounds)
    const hiddenNatively = hideNonActivatingPanel(todoPlanWindow)
    if (!hiddenNatively) {
      todoPlanWindow.hide()
    }
  } finally {
    isHidingTodoPlanWindow = false
  }
  return true
}

function createTodoPlanBrowserWindow(
  prepared: {
    options: NormalizedElectronTodoPlanWindowActionOptions
    mainWindowVisibilitySnapshot: ElectronMainWindowVisibilitySnapshot[]
  },
  presentWhenReady: boolean,
): ElectronBrowserWindow {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const isMac = process.platform === 'darwin'
  const { mode, themeId, colorTheme } = getWindowThemeSelection()
  const backgroundColor = getThemeBackgroundColor(themeId, mode)
  const windowState = getTodoPlanWindowState()

  const themeParams = new URLSearchParams({
    theme: mode,
    colorTheme,
  }).toString()

  todoPlanWindow = createElectronTodoPlanWindow({
    windowState,
    isDevelopment,
    isMac,
    backgroundColor,
    routeHash: `/todo-plan?${themeParams}`,
    rendererDevUrl: getElectronRendererDevUrl(),
    rendererIndexPath: getRendererIndexPath(),
    preloadPath: path.join(__dirname, '../preload/index.js'),
    onCreated: window => {
      todoPlanWindow = window
      if (isMac) configureTodoPlanNativePanel(window)
      setTodoPlanWindowPinned(true)
      if (presentWhenReady) {
        restoreHiddenMainWindows(prepared.mainWindowVisibilitySnapshot)
      }
    },
    onReadyToShow: window => {
      if (!window.isDestroyed()) {
        if (isMac) configureTodoPlanNativePanel(window)
        if (presentWhenReady) {
          presentTodoPlanWindow(window, prepared.options)
        }
      }
      if (presentWhenReady) {
        restoreHiddenMainWindows(prepared.mainWindowVisibilitySnapshot)
      }
    },
    onResize: window => {
      if (!isHidingTodoPlanWindow && !isSyncingTodoPlanNativeFrame) scheduleTodoPlanWindowStateSave(window)
    },
    onMove: window => {
      if (!isHidingTodoPlanWindow && !isSyncingTodoPlanNativeFrame) scheduleTodoPlanWindowStateSave(window)
    },
    onClose: window => {
      saveTodoPlanWindowState(window)
      if (process.platform === 'darwin') {
        suppressMainWindowActivationFromTodoPanel()
      }
    },
    onClosed: () => {
      todoPlanWindow = null
    },
  })
  return todoPlanWindow
}

/**
 * Create or focus the settings window
 */
export function openSettingsWindow(_parentWindow?: ElectronBrowserWindow, initialTab?: string) {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const isMac = process.platform === 'darwin'
  const { mode, themeId, colorTheme } = getWindowThemeSelection()
  const backgroundColor = getThemeBackgroundColor(themeId, mode)

  return openElectronSettingsWindow({
    currentWindow: settingsWindow,
    setCurrentWindow: window => {
      settingsWindow = window
    },
    isDevelopment,
    isMac,
    backgroundColor,
    effectiveTheme: mode,
    colorTheme,
    initialTab,
    navigateChannel: IPC_CHANNELS.SETTINGS_NAVIGATE,
    rendererDevUrl: getElectronRendererDevUrl(),
    rendererIndexPath: getRendererIndexPath(),
    preloadPath: path.join(__dirname, '../preload/index.js'),
  })
}

export function openTodoPlanWindow(options: TodoPlanWindowActionOptions = {}) {
  const prepared = prepareTodoPlanWindowAction(options)
  const { mainWindowVisibilitySnapshot } = prepared

  if (todoPlanWindow && !todoPlanWindow.isDestroyed()) {
    if (todoPlanWindow.isMinimized()) todoPlanWindow.restore()
    presentTodoPlanWindow(todoPlanWindow, prepared.options)
    restoreHiddenMainWindows(mainWindowVisibilitySnapshot)
    return todoPlanWindow
  }

  return createTodoPlanBrowserWindow(prepared, true)
}

export function warmTodoPlanWindow(options: TodoPlanWindowActionOptions = {}) {
  if (todoPlanWindow && !todoPlanWindow.isDestroyed()) {
    return todoPlanWindow
  }

  return createTodoPlanBrowserWindow({
    options: normalizeTodoPlanWindowActionOptions(options),
    mainWindowVisibilitySnapshot: [],
  }, false)
}

/**
 * 启动/激活时的"预热"策略:把窗口建出来但不抢前台、也不动主窗可见性。
 *
 * 这条策略属于待办窗自己(只有它知道 present / hide / 可见性快照的语义),
 * 不属于引导文件 —— 主窗绑定那条路(`app/activate.ts` 的 options)因此只递
 * 一个函数引用,boot 文件里不再出现窗口动作的参数。
 */
export function warmTodoPlanWindowForStartup() {
  return warmTodoPlanWindow({
    activation: 'preserve-current-app',
    preserveMainWindowVisibility: true,
  })
}

export function hideTodoPlanWindow(options: TodoPlanWindowActionOptions = {}): boolean {
  if (!todoPlanWindow || todoPlanWindow.isDestroyed() || !todoPlanWindow.isVisible()) {
    return false
  }

  const { mainWindowVisibilitySnapshot } = prepareTodoPlanWindowAction(options)
  const hidden = hideTodoPlanWindowPreservingBounds()
  restoreHiddenMainWindows(mainWindowVisibilitySnapshot)
  return hidden
}

export function toggleTodoPlanWindow(options: TodoPlanWindowActionOptions = {}) {
  if (todoPlanWindow && !todoPlanWindow.isDestroyed() && todoPlanWindow.isVisible()) {
    if (isTodoPlanWindowFrontmost(todoPlanWindow)) {
      hideTodoPlanWindow(options)
      return null
    }
    return openTodoPlanWindow(options)
  }
  return openTodoPlanWindow(options)
}

/**
 * 自绘红绿灯的黄点。系统按钮已被隐藏(见 `todo-plan-window.ts`),所以最小化必须
 * 显式走这里。窗不在 / 已销毁时静默返回 false —— 渲染层不该为此报错。
 */
export function minimizeTodoPlanWindow(): boolean {
  if (!todoPlanWindow || todoPlanWindow.isDestroyed()) return false
  todoPlanWindow.minimize()
  return todoPlanWindow.isMinimized()
}

/** 自绿点:mac 惯例的 zoom = 在「贴满工作区」与「原尺寸」之间切。 */
export function zoomTodoPlanWindow(): boolean {
  if (!todoPlanWindow || todoPlanWindow.isDestroyed()) return false
  if (todoPlanWindow.isMaximized()) {
    todoPlanWindow.unmaximize()
  } else {
    todoPlanWindow.maximize()
  }
  return todoPlanWindow.isMaximized()
}

/**
 * 手动拖窗。这扇窗是 non-activating NSPanel,`-webkit-app-region: drag` 在它身上
 * 不生效(见 TodoPlanPanel.vue 里那段注释),所以位移由渲染层每帧发过来。
 *
 * 拖起点的窗位记在**主进程**:渲染层只知道自己量到的累计位移,窗在哪儿由这里说了
 * 算 —— 于是每一帧都是「起点 + 累计」的绝对定位,丢一帧也不会攒出漂移。
 */
export function dragTodoPlanWindow(request?: ElectronTodoPlanDragRequest): boolean {
  if (!request) return false
  if (!todoPlanWindow || todoPlanWindow.isDestroyed()) {
    todoPlanDragOrigin = null
    return false
  }

  if (request.phase === 'start') {
    const [x, y] = todoPlanWindow.getPosition()
    todoPlanDragOrigin = { x, y }
    return true
  }

  if (request.phase === 'end') {
    todoPlanDragOrigin = null
    return true
  }

  const next = resolveElectronTodoPlanDragPosition(todoPlanDragOrigin, request)
  if (!next) return false
  todoPlanWindow.setPosition(next.x, next.y)
  return true
}

export function setTodoPlanWindowPinned(pinned: boolean): boolean {
  todoPlanPinned = pinned
  if (!todoPlanWindow || todoPlanWindow.isDestroyed()) return todoPlanPinned
  const pinnedNatively = runWithTodoPlanNativeFrameGuard(() => {
    return setNonActivatingPanelPinned(todoPlanWindow!, pinned)
  })
  if (!pinnedNatively) {
    todoPlanWindow.setAlwaysOnTop(pinned, pinned ? 'floating' : 'normal')
    return todoPlanWindow.isAlwaysOnTop()
  }
  if (pinned && todoPlanWindow.isVisible()) {
    presentTodoPlanWindow(todoPlanWindow, normalizeTodoPlanWindowActionOptions())
  }
  return todoPlanPinned
}

export function createWindow() {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const rendererDevUrl = getElectronRendererDevUrl()
  const rendererIndexPath = getRendererIndexPath()

  // Setup Content Security Policy before creating window
  registerElectronContentSecurityPolicy()
  registerElectronMediaPermissions({
    isAppWebContents: webContents => isElectronAppWebContents(webContents, {
      isDevelopment,
      rendererDevUrl,
      rendererIndexPath,
    }),
  })

  // Initialize themes before getting background color
  initializeThemes()

  const isMac = process.platform === 'darwin'
  const windowState = getWindowState()

  const { mode, themeId } = getWindowThemeSelection()
  const backgroundColor = getThemeBackgroundColor(themeId, mode)

  log.info('creating main window', { themeId, effectiveTheme: mode, backgroundColor })

  const mainWindow = createElectronMainWindow({
    windowState,
    isDevelopment,
    isMac,
    backgroundColor,
    iconPath: path.join(__dirname, '../../resources/onething.png'),
    preloadPath: path.join(__dirname, '../preload/index.js'),
    shouldSuppressActivation: shouldSuppressMainWindowActivation,
    shouldHideForVoice: shouldHideMainWindowForVoice,
    saveWindowState,
  })

  setupElectronExternalLinkHandling({
    webContents: mainWindow.webContents,
    isAppUrl: url => isElectronRendererWindowUrl(url, { rendererDevUrl }),
    isAppFileUrl: url => isElectronRendererIndexFileUrl(url, rendererIndexPath),
  })

  attachElectronMainWindowRecovery({ mainWindow, loadMainWindowContent })
  loadMainWindowContent(mainWindow)

  // Setup application menu with keyboard shortcuts.
  // 测试用 Web 预览开关(仅开发态);toggle 后重建菜单以刷新勾选状态。
  const buildApplicationMenu = () => {
    setupElectronApplicationMenu({
      mainWindow,
      openSettingsWindow,
      // ⌘T/⌘W routing, consulted at click time. peek, not get: a keypress must
      // not be what *creates* the browser subsystem (its constructor wakes
      // Widevine). No instance → no browser → the key isn't the browser's.
      browser: {
        hasFocus: () => peekBrowserViewService()?.hasFocus() ?? false,
        createTab: () => {
          peekBrowserViewService()?.createTab()
        },
        closeActiveTab: () => peekBrowserViewService()?.closeActiveTab(),
      },
      webPreview: {
        available: isWebPreviewAvailable(),
        url: WEB_PREVIEW_URL,
        isRunning: isWebPreviewRunning,
        open: openWebPreview,
        toggle: () => {
          toggleWebPreview()
          buildApplicationMenu()
        },
      },
    })
  }
  buildApplicationMenu()

  return mainWindow
}

// Keep track of the image preview window
let imagePreviewWindow: ElectronBrowserWindow | null = null

// Types for image preview
type ImagePreviewData =
  | { mode: 'single'; previewId?: string; src?: string; alt?: string }
  | { mode: 'gallery'; mediaId: string }

/**
 * Open or update the image preview window
 * - Single mode: for non-media images (attachments), previewId passed in URL and data loaded via IPC pull
 * - Gallery mode: for media images, mediaId passed in URL, component loads data itself
 */
export function openImagePreviewWindow(data: ImagePreviewData) {
  log.debug('image preview window requested', data.mode === 'single'
    ? {
        mode: data.mode,
        previewId: data.previewId,
        alt: data.alt,
        hasInlineSrc: Boolean(data.src),
        inlineSrcLength: data.src?.length,
      }
    : { ...data })

  const isDevelopment = process.env.NODE_ENV === 'development'
  const isMac = process.platform === 'darwin'

  // Build URL params based on mode
  const { mode, themeId } = getWindowThemeSelection()
  let urlParams = `theme=${mode}&mode=${data.mode}`
  if (data.mode === 'gallery') {
    urlParams += `&mediaId=${data.mediaId}`
  } else if (data.previewId) {
    urlParams += `&previewId=${encodeURIComponent(data.previewId)}`
  }

  const backgroundColor = getThemeBackgroundColor(themeId, mode)

  return openElectronImagePreviewWindow({
    currentWindow: imagePreviewWindow,
    setCurrentWindow: window => {
      imagePreviewWindow = window
    },
    payload: data,
    mode: data.mode,
    routeHash: `/image-preview?${urlParams}`,
    updateChannel: IPC_CHANNELS.IMAGE_PREVIEW_UPDATE,
    isDevelopment,
    isMac,
    backgroundColor,
    rendererDevUrl: getElectronRendererDevUrl(),
    rendererIndexPath: getRendererIndexPath(),
    preloadPath: path.join(__dirname, '../preload/index.js'),
  })
}
