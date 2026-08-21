/**
 * Search Everywhere - onething Electron window lifecycle.
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_GENERAL_SETTINGS } from '@shared/defaults/settings.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { SearchWindowAnchor, SearchWindowGuideState } from '@shared/ipc/search.js'
import {
  getOnethingWindowStatePath,
  readJsonFile,
  writeJsonFile,
} from '@onething/runtime/storage'
import { getSettings } from '@onething/app/stores/settings.js'
import {
  getThemeBackgroundColor,
  resolveOnethingWindowThemeSelection,
} from '@onething/runtime/themes'
import {
  createElectronSearchWindowController,
  getElectronSystemShouldUseDarkColors,
} from '@onething/electron-host/window/search-window'
import { getElectronRendererDevUrl } from '@onething/electron-host/window/renderer-targets'
import {
  ELECTRON_SEARCH_WINDOW_MIN_HEIGHT,
  ELECTRON_SEARCH_WINDOW_MIN_WIDTH,
  applyElectronSearchWindowAnchor,
  getElectronDefaultSearchWindowBounds,
  getElectronSearchWindowGuideState,
  getElectronSearchWindowSizeConstraints,
} from '@onething/electron-host/window/search-window-layout'
import {
  readElectronSearchWindowSize,
  saveElectronSearchWindowSize,
  type ElectronWindowStateOptions,
} from '@onething/electron-host/window/window-state'
import type { ElectronBrowserWindow } from '@onething/electron-host/window/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const HIDDEN_GUIDES: SearchWindowGuideState = {
  visible: false,
  centerX: false,
  defaultTop: false,
  defaultHeight: false,
  defaultBounds: false,
}

function getRendererIndexPath(): string {
  return path.join(__dirname, '../renderer/index.html')
}

function getWindowStateOptions(): ElectronWindowStateOptions {
  return {
    path: getOnethingWindowStatePath(),
    readJsonFile,
    writeJsonFile,
  }
}

// Content-area rect reported by the main window renderer; the search window
// centers on it instead of the full window width (sidebar excluded).
let searchWindowAnchor: SearchWindowAnchor | null = null

export function setSearchWindowAnchor(anchor: SearchWindowAnchor | null): void {
  if (
    anchor &&
    [anchor.x, anchor.y, anchor.width, anchor.height].every(value => Number.isFinite(value)) &&
    anchor.width > 0
  ) {
    searchWindowAnchor = anchor
  } else {
    searchWindowAnchor = null
  }
}

function getSearchWindowVisualOptions() {
  const settings = getSettings()
  const selection = resolveOnethingWindowThemeSelection({
    theme: settings.theme,
    general: settings.general,
    defaults: DEFAULT_GENERAL_SETTINGS,
    systemShouldUseDarkColors: getElectronSystemShouldUseDarkColors(),
  })

  return {
    isDevelopment: process.env.NODE_ENV === 'development',
    isMac: process.platform === 'darwin',
    backgroundColor: getThemeBackgroundColor(selection.themeId, selection.mode),
    routeHash: `/search?theme=${selection.mode}&colorTheme=${selection.colorTheme}`,
    rendererDevUrl: getElectronRendererDevUrl(),
    rendererIndexPath: getRendererIndexPath(),
    preloadPath: path.join(__dirname, '../preload/index.js'),
  }
}

const searchWindowController = createElectronSearchWindowController({
  shownChannel: IPC_CHANNELS.SEARCH_WINDOW_SHOWN,
  guidesChannel: IPC_CHANNELS.SEARCH_WINDOW_GUIDES,
  hiddenGuides: HIDDEN_GUIDES,
  layout: {
    minWidth: ELECTRON_SEARCH_WINDOW_MIN_WIDTH,
    minHeight: ELECTRON_SEARCH_WINDOW_MIN_HEIGHT,
    getSizeConstraints: getElectronSearchWindowSizeConstraints,
    getDefaultBounds: parentBounds =>
      applyElectronSearchWindowAnchor(
        getElectronDefaultSearchWindowBounds(parentBounds),
        parentBounds,
        searchWindowAnchor,
      ),
    getGuideState: getElectronSearchWindowGuideState,
  },
  getVisualOptions: getSearchWindowVisualOptions,
  getPreferredSize: () => readElectronSearchWindowSize(getWindowStateOptions()),
  savePreferredSize: size => saveElectronSearchWindowSize(getWindowStateOptions(), size),
})

export function openSearchWindow(
  parentWindow: ElectronBrowserWindow,
  shownPayload?: unknown,
): ElectronBrowserWindow {
  return searchWindowController.open(parentWindow, shownPayload)
}

export function warmSearchWindow(parentWindow: ElectronBrowserWindow): ElectronBrowserWindow {
  return searchWindowController.warm(parentWindow)
}

export function closeSearchWindow(): void {
  searchWindowController.close()
}

export function toggleSearchWindow(parentWindow: ElectronBrowserWindow, shownPayload?: unknown): void {
  searchWindowController.toggle(parentWindow, shownPayload)
}

export function getSearchWindow(): ElectronBrowserWindow | null {
  return searchWindowController.getWindow()
}
